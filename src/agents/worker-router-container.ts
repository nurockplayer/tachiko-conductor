/**
 * Container-owned execution boundary for `WorkerRouterAdapter` (issue #74).
 *
 * This module contains the *only* path by which the worker-router executor is
 * spawned. The untrusted worker runs inside a container whose lifecycle is
 * driven exclusively by the exact 64-hex container ID captured from
 * `docker create`; there is no host-execution fallback, no replay, and no
 * `ps`/PGID/orphan/name-based discovery.
 *
 * The proven boundary from #73 is reused unchanged:
 *   create -> start -> wait -> inspect -> stop|kill -> rm -f (by exact ID)
 *
 * The container gets only the narrow commit-only Git mounts reused from #73
 * (linked worktree, per-worktree gitdir, `objects`, `refs`, read-only
 * `config`). The bare remote is intentionally *not* mounted: the worker
 * commits only and Tachiko publishes the exact HEAD from the host. Plain
 * `.git/` repositories are rejected so the writable worktree mount cannot
 * expose an entire common Git tree.
 *
 * Failure/cancel/timeout cleanup must prove the exact container is absent or
 * terminal before returning; when that proof is unavailable the boundary fails
 * closed with a containment error instead of the ordinary worker failure.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { NodeProcessRunner, type ProcessRunner } from '../github/transport.js';

export const WORKER_ROUTER_IMAGE_ENV = 'TACHIKO_WORKER_ROUTER_IMAGE';
export const WORKER_ROUTER_NETWORK_ENV = 'TACHIKO_WORKER_ROUTER_NETWORK';
/** In-image HOME for the container worker. Host home directories are never mounted. */
export const WORKER_ROUTER_CONTAINER_HOME = '/root';
/**
 * The only host variables forwarded into the container, by exact name. These
 * are the worker's own provider/routing inputs -- never a broad credential set.
 */
export const WORKER_ROUTER_CONTAINER_ENV_ALLOWLIST = ['DEEPSEEK_API_KEY', 'WORKER_FORCE'] as const;

/** `name@sha256:<64hex>` or a bare immutable `sha256:<64hex>` image digest. */
const DIGEST_PINNED_IMAGE = /^(?:[A-Za-z0-9][A-Za-z0-9._:/@-]*@)?sha256:[0-9a-f]{64}$/;
const EXACT_CONTAINER_ID = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set(['exited', 'dead']);
const REDACTED = '[redacted]';

export const WORKER_ROUTER_CONTAINER_ERROR_CODE = {
  IMAGE_REQUIRED: 'WORKER_ROUTER_IMAGE_REQUIRED',
  IMAGE_UNPINNED: 'WORKER_ROUTER_IMAGE_UNPINNED',
  MOUNTS_INVALID: 'WORKER_ROUTER_MOUNTS_INVALID',
  CREATE_FAILED: 'WORKER_ROUTER_CONTAINER_CREATE_FAILED',
  ID_INVALID: 'WORKER_ROUTER_CONTAINER_ID_INVALID',
  TERMINAL_UNPROVEN: 'WORKER_ROUTER_CONTAINER_TERMINAL_UNPROVEN',
  RUNTIME_NOT_FOUND: 'WORKER_ROUTER_CONTAINER_RUNTIME_NOT_FOUND',
  TIMEOUT: 'WORKER_ROUTER_CONTAINER_TIMEOUT',
  CANCELLED: 'WORKER_ROUTER_CONTAINER_CANCELLED',
} as const;

export type WorkerRouterContainerErrorCode =
  (typeof WORKER_ROUTER_CONTAINER_ERROR_CODE)[keyof typeof WORKER_ROUTER_CONTAINER_ERROR_CODE];

export class WorkerRouterContainerError extends Error {
  readonly code: WorkerRouterContainerErrorCode;
  constructor(code: WorkerRouterContainerErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkerRouterContainerError';
    this.code = code;
  }
}

export function isWorkerRouterContainerError(error: unknown): error is WorkerRouterContainerError {
  return error instanceof WorkerRouterContainerError;
}

export type WorkerNetworkMode = 'none' | 'bridge';

export interface ContainerMount {
  readonly host: string;
  readonly container: string;
  readonly mode: 'ro' | 'rw';
}

export interface WorkerContainerSpec {
  /** Digest-pinned image reference. */
  readonly image: string;
  /** Absolute path of the worker entrypoint *inside* the image. */
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly mounts: readonly ContainerMount[];
  readonly env: Readonly<Record<string, string>>;
  readonly network: WorkerNetworkMode;
  readonly workdir: string;
  /** Task payload forwarded to the worker on stdin. */
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface WorkerContainerInspection {
  readonly id: string;
  readonly status: string;
  readonly running: boolean;
  readonly exitCode: number;
  readonly restartPolicy: string;
}

export interface WorkerContainerLogs {
  readonly stdout: string;
  readonly stderr: string;
}

/** Lifecycle surface. Every method after `create` receives the exact ID. */
export interface WorkerContainerRuntime {
  create(spec: WorkerContainerSpec): Promise<string>;
  start(id: string, spec: WorkerContainerSpec): Promise<void>;
  wait(id: string): Promise<number>;
  inspect(id: string): Promise<WorkerContainerInspection>;
  logs(id: string): Promise<WorkerContainerLogs>;
  stop(id: string, graceSeconds: number): Promise<void>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ContainerWorkerResult {
  readonly containerId: string;
  readonly exitCode: number;
  readonly terminalState: string;
  readonly restartPolicy: string;
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable seam so adapter tests never touch a real container runtime. */
export interface ContainerWorkerExecution {
  run(spec: WorkerContainerSpec): Promise<ContainerWorkerResult>;
}

export function assertDigestPinnedImage(image: string): void {
  if (image.trim() === '') {
    throw new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_REQUIRED,
      `${WORKER_ROUTER_IMAGE_ENV} must name a container image.`,
    );
  }
  if (!DIGEST_PINNED_IMAGE.test(image.trim())) {
    throw new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_UNPINNED,
      'The worker container image must be pinned by digest (name@sha256:<64-hex> or sha256:<64-hex>); tags are not accepted.',
    );
  }
}

export function resolveWorkerNetworkMode(value: string | undefined): WorkerNetworkMode {
  if (value === undefined || value.trim() === '') return 'none';
  const mode = value.trim();
  if (mode === 'none' || mode === 'bridge') return mode;
  throw new WorkerRouterContainerError(
    WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID,
    `${WORKER_ROUTER_NETWORK_ENV} must be "none" or "bridge".`,
  );
}

/**
 * The narrow commit-only mount set reused from #73. Only the prepared linked
 * worktree shape is accepted: a `.git` *file* indirection to a per-worktree
 * gitdir registered under the common `worktrees/` directory, with the common
 * Git directory outside the worktree. Plain `.git/` repositories are rejected
 * because the writable worktree mount would otherwise expose their whole
 * common Git tree, including `hooks` and unrelated worktree state.
 *
 * No bare remote, no `packed-refs`, no hooks, no source checkout, no `$HOME`,
 * no SSH agent, no Docker socket.
 */
export function planCommitOnlyMounts(workspacePath: string): readonly ContainerMount[] {
  if (!path.isAbsolute(workspacePath)) {
    throw new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID,
      'The prepared workspace path must be absolute before container mounts can be planned.',
    );
  }
  const { gitdir, commonDir } = linkedWorktreeLayout(workspacePath);
  const mounts: ContainerMount[] = [
    { host: workspacePath, container: workspacePath, mode: 'rw' },
    { host: gitdir, container: gitdir, mode: 'rw' },
  ];
  for (const required of ['objects', 'refs'] as const) {
    const directory = path.join(commonDir, required);
    if (!existsSync(directory)) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID,
        `The prepared workspace is missing its common Git ${required} directory; refusing to mount an incomplete repository.`,
      );
    }
    mounts.push({ host: directory, container: directory, mode: 'rw' });
  }
  const config = path.join(commonDir, 'config');
  if (existsSync(config)) mounts.push({ host: config, container: config, mode: 'ro' });
  return mounts;
}

interface LinkedWorktreeLayout {
  readonly gitdir: string;
  readonly commonDir: string;
}

function invalidMounts(message: string): never {
  throw new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID, message);
}

/** Fail closed unless the workspace is the prepared linked-worktree layout. */
function linkedWorktreeLayout(workspacePath: string): LinkedWorktreeLayout {
  const dotGit = path.join(workspacePath, '.git');
  let stat;
  try {
    stat = lstatSync(dotGit);
  } catch {
    invalidMounts('The prepared workspace has no readable .git indirection; refusing to containerize it.');
  }
  if (!stat.isFile()) {
    invalidMounts('The prepared workspace must be a linked worktree with a .git file indirection; plain Git repositories are never containerized.');
  }
  let raw: string;
  try {
    raw = readFileSync(dotGit, 'utf8').trim();
  } catch {
    invalidMounts('The prepared workspace .git indirection could not be read.');
  }
  const target = /^gitdir:\s*(.+)$/.exec(raw)?.[1]?.trim();
  if (target === undefined || target === '' || !path.isAbsolute(target)) {
    invalidMounts('The prepared workspace .git indirection is not an absolute linked-worktree pointer.');
  }
  const gitdir = target;
  const commondirFile = path.join(gitdir, 'commondir');
  if (!existsSync(commondirFile)) {
    invalidMounts('The prepared workspace is not a linked worktree: its gitdir has no commondir pointer.');
  }
  let rawCommon: string;
  try {
    rawCommon = readFileSync(commondirFile, 'utf8').trim();
  } catch {
    invalidMounts('The prepared workspace commondir pointer could not be read.');
  }
  if (rawCommon === '') invalidMounts('The prepared workspace commondir pointer is empty.');
  const commonDir = path.resolve(gitdir, rawCommon);
  if (
    commonDir === workspacePath || gitdir === workspacePath ||
    isInside(workspacePath, gitdir) || isInside(workspacePath, commonDir) ||
    isInside(gitdir, workspacePath) || isInside(commonDir, workspacePath)
  ) {
    invalidMounts('The linked-worktree git directory must live outside the prepared worktree; refusing an overlapping Git layout.');
  }
  if (!isInside(path.join(commonDir, 'worktrees'), gitdir)) {
    invalidMounts('The prepared gitdir is not registered under the common Git worktrees/ directory; refusing an unproven worktree layout.');
  }
  return { gitdir, commonDir };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export interface DockerWorkerContainerRuntimeOptions {
  readonly runner?: ProcessRunner;
  readonly docker?: string;
  /** Bound for lifecycle control calls; never the worker run itself. */
  readonly controlTimeoutMs?: number;
}

/** Docker CLI implementation. Every lifecycle call carries the exact ID. */
export class DockerWorkerContainerRuntime implements WorkerContainerRuntime {
  private readonly runner: ProcessRunner;
  private readonly docker: string;
  private readonly controlTimeoutMs: number;

  constructor(options: DockerWorkerContainerRuntimeOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.docker = options.docker ?? 'docker';
    this.controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
  }

  async create(spec: WorkerContainerSpec): Promise<string> {
    const args = [
      'create',
      '--pull=never',
      '--restart=no',
      '--network',
      spec.network,
      '--interactive',
      '--workdir',
      spec.workdir,
    ];
    for (const [key, value] of Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('--env', `${key}=${value}`);
    }
    for (const mount of spec.mounts) {
      args.push('--volume', `${mount.host}:${mount.container}${mount.mode === 'ro' ? ':ro' : ''}`);
    }
    args.push(spec.image, spec.entrypoint, ...spec.args);
    const result = await this.control(args, spec.signal);
    if (result.exitCode !== 0) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.CREATE_FAILED,
        `docker create failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`,
      );
    }
    const id = result.stdout.trim();
    if (!EXACT_CONTAINER_ID.test(id)) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.ID_INVALID,
        'docker create did not return an exact 64-hex container id; refusing to own an unidentified container.',
      );
    }
    return id;
  }

  async start(id: string, spec: WorkerContainerSpec): Promise<void> {
    assertExactContainerId(id);
    // `docker start -a` mirrors the container exit code, so only the spawn
    // outcome is authoritative here; the terminal exit code comes from `wait`
    // and the transcript comes from `logs` once terminal state is proven.
    await this.execute(['start', '--attach', '--interactive', id], {
      timeoutMs: spec.timeoutMs,
      stdin: spec.stdin,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    });
  }

  async wait(id: string): Promise<number> {
    assertExactContainerId(id);
    const result = await this.control(['wait', id]);
    const exitCode = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isInteger(exitCode)) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        `docker wait did not report a terminal exit code: ${firstLine(result.stderr)}`,
      );
    }
    return exitCode;
  }

  async inspect(id: string): Promise<WorkerContainerInspection> {
    assertExactContainerId(id);
    const result = await this.control(['inspect', '--format', '{{json .}}', id]);
    if (result.exitCode !== 0) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        `docker inspect failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`,
      );
    }
    let raw: {
      Id?: unknown;
      State?: { Status?: unknown; Running?: unknown; ExitCode?: unknown };
      HostConfig?: { RestartPolicy?: { Name?: unknown } };
    };
    try {
      raw = JSON.parse(result.stdout) as typeof raw;
    } catch {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        'docker inspect returned unreadable state.',
      );
    }
    return {
      id: String(raw.Id ?? ''),
      status: String(raw.State?.Status ?? ''),
      running: raw.State?.Running === true,
      exitCode: Number(raw.State?.ExitCode ?? -1),
      restartPolicy: String(raw.HostConfig?.RestartPolicy?.Name ?? ''),
    };
  }

  async logs(id: string): Promise<WorkerContainerLogs> {
    assertExactContainerId(id);
    const result = await this.control(['logs', id]);
    if (result.exitCode !== 0) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        'docker logs could not read the terminal container transcript.',
      );
    }
    return { stdout: result.stdout, stderr: result.stderr };
  }

  async stop(id: string, graceSeconds: number): Promise<void> {
    assertExactContainerId(id);
    const result = await this.control(['stop', '--time', String(Math.max(0, Math.trunc(graceSeconds))), id]);
    if (result.exitCode !== 0 && !isBenignLifecycleFailure(result.stderr)) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        `docker stop failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`,
      );
    }
  }

  async kill(id: string): Promise<void> {
    assertExactContainerId(id);
    const result = await this.control(['kill', id]);
    if (result.exitCode !== 0 && !isBenignLifecycleFailure(result.stderr)) {
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
        `docker kill failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`,
      );
    }
  }

  /** Removal is idempotent: an already-absent container is quiescent success. */
  async remove(id: string): Promise<void> {
    assertExactContainerId(id);
    const result = await this.control(['rm', '--force', id]);
    if (result.exitCode === 0 || isBenignLifecycleFailure(result.stderr)) return;
    throw new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
      `docker rm failed (exit ${result.exitCode}): ${firstLine(result.stderr)}`,
    );
  }

  private async control(args: readonly string[], signal?: AbortSignal) {
    return await this.execute(args, { timeoutMs: this.controlTimeoutMs, ...(signal === undefined ? {} : { signal }) });
  }

  private async execute(
    args: readonly string[],
    options: { timeoutMs: number; stdin?: string; signal?: AbortSignal },
  ) {
    try {
      return await this.runner.run(this.docker, args, {
        timeoutMs: options.timeoutMs,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      const code = errorCode(error);
      if (isAborted(options.signal) || code === 'ABORT_ERR') {
        throw new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED, 'The worker container was cancelled.', error);
      }
      if (code === 'ETIMEDOUT') {
        throw new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT, 'The worker container did not finish in time.', error);
      }
      if (code === 'ENOENT') {
        throw new WorkerRouterContainerError(
          WORKER_ROUTER_CONTAINER_ERROR_CODE.RUNTIME_NOT_FOUND,
          `The container runtime executable "${this.docker}" was not found.`,
          error,
        );
      }
      throw new WorkerRouterContainerError(
        WORKER_ROUTER_CONTAINER_ERROR_CODE.CREATE_FAILED,
        `The container runtime command failed: ${firstLine(errorMessage(error))}`,
        error,
      );
    }
  }
}

/**
 * Lifecycle orchestrator. It captures the exact ID at create, awaits the exact
 * container terminal state, and cleans up by that same ID on every path.
 */
export class ContainerWorkerBoundary implements ContainerWorkerExecution {
  private readonly runtime: WorkerContainerRuntime;
  private readonly cleanupGraceSeconds: number;

  constructor(options: { readonly runtime?: WorkerContainerRuntime; readonly cleanupGraceSeconds?: number } = {}) {
    this.runtime = options.runtime ?? new DockerWorkerContainerRuntime();
    this.cleanupGraceSeconds = options.cleanupGraceSeconds ?? 5;
  }

  async run(spec: WorkerContainerSpec): Promise<ContainerWorkerResult> {
    assertDigestPinnedImage(spec.image);
    const id = await this.runtime.create(spec);
    try {
      await this.runtime.start(id, spec);
      const exitCode = await this.runtime.wait(id);
      const state = await this.runtime.inspect(id);
      if (state.running || !TERMINAL_STATES.has(state.status)) {
        throw new WorkerRouterContainerError(
          WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
          `Container ${id.slice(0, 12)} was not observed in a terminal state (status=${state.status === '' ? 'unknown' : state.status}).`,
        );
      }
      const logs = await this.readLogs(id);
      // Terminal state is already proven, so removal is opportunistic cleanup:
      // a failed rm does not leave unproven work behind.
      await this.removeQuietly(id);
      return {
        containerId: id,
        exitCode,
        terminalState: state.status,
        restartPolicy: state.restartPolicy,
        stdout: logs.stdout,
        stderr: logs.stderr,
      };
    } catch (error) {
      const cleanup = await this.proveQuiescent(id);
      if (!cleanup.quiescent) {
        // Containment takes precedence over the ordinary worker failure: never
        // return while the exact container may still be alive and mutating.
        throw new WorkerRouterContainerError(
          WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN,
          `Container ${id.slice(0, 12)} cleanup could not prove quiescence (${cleanup.detail}); refusing to report the worker failure as contained. Original failure: ${boundedMessage(error, 200)}`,
          error,
        );
      }
      if (isAborted(spec.signal)) {
        throw new WorkerRouterContainerError(WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED, 'The worker container was cancelled.', error);
      }
      throw error;
    }
  }

  /**
   * Failure/cancel/timeout cleanup. It must end with proof that the exact
   * container is absent or terminal; a failed `rm` is only acceptable when a
   * final inspect proves the exact container is no longer running.
   */
  private async proveQuiescent(id: string): Promise<{ readonly quiescent: boolean; readonly detail: string }> {
    const failures: string[] = [];
    const attempt = async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        failures.push(`${label}: ${boundedMessage(error, 160)}`);
        return false;
      }
    };
    await attempt('stop', () => this.runtime.stop(id, this.cleanupGraceSeconds));
    await attempt('wait', () => this.runtime.wait(id));
    await attempt('kill', () => this.runtime.kill(id));
    await attempt('wait', () => this.runtime.wait(id));
    if (await attempt('remove', () => this.runtime.remove(id))) return { quiescent: true, detail: '' };
    try {
      const state = await this.runtime.inspect(id);
      if (!state.running && TERMINAL_STATES.has(state.status)) return { quiescent: true, detail: '' };
      return { quiescent: false, detail: `exact container is still ${state.status === '' ? 'unreadable' : state.status}` };
    } catch (error) {
      return {
        quiescent: false,
        detail: `terminal state could not be proven (${failures.join('; ')}; inspect: ${boundedMessage(error, 160)})`,
      };
    }
  }

  private async removeQuietly(id: string): Promise<void> {
    try {
      await this.runtime.remove(id);
    } catch {
      // Terminal state was already proven; a residual terminal container is
      // never unproven work. Bounded, idempotent, and not reported as success.
    }
  }

  private async readLogs(id: string): Promise<WorkerContainerLogs> {
    try {
      return await this.runtime.logs(id);
    } catch {
      return { stdout: '', stderr: '' };
    }
  }
}

export function redactWorkerEnvValues(message: string, env: Readonly<Record<string, string>>): string {
  let redacted = message;
  for (const [key, value] of Object.entries(env)) {
    if (value !== '' && (key.includes('KEY') || key.includes('TOKEN') || key.includes('SECRET') || key.includes('PASSWORD'))) {
      redacted = redacted.split(value).join(REDACTED);
    }
  }
  return redacted;
}

export function boundedMessage(value: unknown, limit = 400): string {
  const message = errorMessage(value).replace(/\s+/g, ' ').trim();
  return message.length <= limit ? message : `${message.slice(0, limit)}...`;
}

function assertExactContainerId(id: string): void {
  if (!EXACT_CONTAINER_ID.test(id)) {
    throw new WorkerRouterContainerError(
      WORKER_ROUTER_CONTAINER_ERROR_CODE.ID_INVALID,
      'Refusing a container lifecycle call without an exact 64-hex container id.',
    );
  }
}

/** Docker already-terminal/absent lifecycle outcomes are benign, not failures. */
function isBenignLifecycleFailure(stderr: string): boolean {
  return /is not running|no such container|not running|no such object/i.test(stderr);
}

function firstLine(value: string): string {
  const line = value.split('\n').map((part) => part.trim()).find((part) => part !== '');
  return line ?? 'no diagnostic';
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
