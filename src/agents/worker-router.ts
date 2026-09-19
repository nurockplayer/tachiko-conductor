import path from 'node:path';

import { assertWorkspaceGuard, type ImplementationAgent, type ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';
import { NodeProcessRunner, type ProcessRunner, type ProcessRunOptions } from '../github/transport.js';
import {
  ContainerWorkerBoundary,
  WORKER_ROUTER_CONTAINER_ENV_ALLOWLIST,
  WORKER_ROUTER_CONTAINER_ERROR_CODE,
  WORKER_ROUTER_CONTAINER_HOME,
  WORKER_ROUTER_IMAGE_ENV,
  WORKER_ROUTER_NETWORK_ENV,
  assertDigestPinnedImage,
  boundedMessage,
  isWorkerRouterContainerError,
  planCommitOnlyMounts,
  redactWorkerEnvValues,
  resolveWorkerNetworkMode,
  type ContainerWorkerExecution,
  type ContainerWorkerResult,
  type WorkerContainerSpec,
  type WorkerNetworkMode,
  type WorkerRouterContainerErrorCode,
} from './worker-router-container.js';

export const WORKER_ROUTER_PROVIDER = 'worker-router';
/**
 * Absolute *in-container* entrypoint. The host worker path is never executed;
 * the digest-pinned image owns the worker runtime.
 */
export const WORKER_ROUTER_DEFAULT_EXECUTABLE = `${WORKER_ROUTER_CONTAINER_HOME}/.local/bin/worker-router`;
export const WORKER_ROUTER_EXECUTABLE_ENV = 'TACHIKO_WORKER_ROUTER_PATH';

export const WORKER_ROUTER_ERROR_CODE = {
  EXIT_FAILURE: 'WORKER_ROUTER_EXIT_FAILURE',
  TIMEOUT: 'WORKER_ROUTER_TIMEOUT',
  NOT_FOUND: 'WORKER_ROUTER_NOT_FOUND',
  EXEC_FAILURE: 'WORKER_ROUTER_EXEC_FAILURE',
  CANCELLED: 'WORKER_ROUTER_CANCELLED',
  WORKSPACE_REQUIRED: 'WORKER_ROUTER_WORKSPACE_REQUIRED',
  CAPABILITIES_UNSUPPORTED: 'WORKER_ROUTER_CAPABILITIES_UNSUPPORTED',
  HEAD_READ_FAILED: 'WORKER_ROUTER_HEAD_READ_FAILED',
  BASE_ANCESTRY_FAILED: 'WORKER_ROUTER_BASE_ANCESTRY_FAILED',
  PUBLISH_FAILED: 'WORKER_ROUTER_PUBLISH_FAILED',
  IMAGE_REQUIRED: WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_REQUIRED,
  IMAGE_UNPINNED: WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_UNPINNED,
  MOUNTS_INVALID: WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID,
  CONTAINER_FAILURE: 'WORKER_ROUTER_CONTAINER_FAILURE',
  CONTAINMENT_UNPROVEN: 'WORKER_ROUTER_CONTAINMENT_UNPROVEN',
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;

export interface WorkerRouterAdapterOptions {
  /** Host process runner for Conductor-owned Git authority operations only. */
  readonly runner?: ProcessRunner;
  /** Absolute in-container worker entrypoint (defaults to the image's worker-router). */
  readonly executable?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Digest-pinned container image. */
  readonly image?: string;
  readonly network?: WorkerNetworkMode;
  /** Exact host environment variable names forwarded into the container. */
  readonly containerEnv?: readonly string[];
  /** Injectable container boundary; production always uses the real runtime. */
  readonly container?: ContainerWorkerExecution;
}

/** Stateless implementation adapter for the container-owned worker-router path. */
export class WorkerRouterAdapter implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly runner: ProcessRunner;
  private readonly executable: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly container: ContainerWorkerExecution;
  private readonly image: string | undefined;
  private readonly network: WorkerNetworkMode;
  private readonly containerEnvKeys: readonly string[];

  constructor(options: WorkerRouterAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    const env = options.env ?? process.env;
    this.hostEnv = env;
    const executable = options.executable ?? env[WORKER_ROUTER_EXECUTABLE_ENV] ?? WORKER_ROUTER_DEFAULT_EXECUTABLE;
    if (executable.trim() === '' || !path.isAbsolute(executable)) {
      throw new Error(`${WORKER_ROUTER_EXECUTABLE_ENV} / worker-router executable must be an absolute non-empty path.`);
    }
    this.executable = executable;
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const image = options.image ?? env[WORKER_ROUTER_IMAGE_ENV];
    if (image !== undefined && image.trim() !== '') assertDigestPinnedImage(image);
    this.image = image === undefined || image.trim() === '' ? undefined : image;
    this.network = resolveWorkerNetworkMode(options.network ?? env[WORKER_ROUTER_NETWORK_ENV]);
    this.containerEnvKeys = options.containerEnv ?? WORKER_ROUTER_CONTAINER_ENV_ALLOWLIST;
    // The real boundary is the only production path; there is no host fallback.
    this.container = options.container ?? new ContainerWorkerBoundary();
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', 0);
    if (request.workspacePath === undefined || request.workspacePath.trim() === '' || request.branch === undefined || request.branch.trim() === '') {
      return failure(
        WORKER_ROUTER_ERROR_CODE.WORKSPACE_REQUIRED,
        `Worker router requires an explicit prepared workspacePath and branch; ambient cwd ${this.cwd} is never used for implementation.`,
        0,
      );
    }
    if ((request.capabilities?.length ?? 0) > 0) {
      return failure(
        WORKER_ROUTER_ERROR_CODE.CAPABILITIES_UNSUPPORTED,
        'Worker router does not support per-run MCP capabilities; refusing to drop requested capabilities.',
        0,
      );
    }
    const cwd = request.workspacePath;
    const branch = request.branch;
    const task = buildTask(request);
    await assertWorkspaceGuard(request.workspaceGuard);
    const startedAt = Date.now();
    if (this.image === undefined) {
      return failure(
        WORKER_ROUTER_ERROR_CODE.IMAGE_REQUIRED,
        `Worker router requires a digest-pinned container image via ${WORKER_ROUTER_IMAGE_ENV}; host execution is not a fallback.`,
        elapsed(startedAt),
      );
    }
    let spec: WorkerContainerSpec;
    try {
      spec = this.containerSpec(this.image, cwd, task, request.signal);
    } catch (error) {
      return failure(
        WORKER_ROUTER_ERROR_CODE.MOUNTS_INVALID,
        `Worker router could not plan its commit-only container mounts: ${boundedMessage(error)}`,
        elapsed(startedAt),
      );
    }
    let result: ContainerWorkerResult;
    try {
      result = await this.container.run(spec);
    } catch (error) {
      return this.containerFailure(error, request.signal, startedAt, spec.env);
    }
    const provenance = workerProvenance(result.stderr);
    const diagnostics = boundedDiagnostics(result.stderr, result.stdout, provenance);
    if (result.exitCode !== 0) {
      const durationMs = elapsed(startedAt);
      return { ...failure(WORKER_ROUTER_ERROR_CODE.EXIT_FAILURE, `Worker router exited with status ${result.exitCode}.`, durationMs), diagnostics: [`${WORKER_ROUTER_ERROR_CODE.EXIT_FAILURE}: Worker router exited with status ${result.exitCode}.`, ...diagnostics] };
    }
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', elapsed(startedAt));
    // The exact container is terminal before this point; only now may the
    // Tachiko-owned workspace guard, HEAD read, ancestry proof, and publication run.
    await assertWorkspaceGuard(request.workspaceGuard, 'after-execution');
    const head = await this.readHead(request.signal, cwd);
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', elapsed(startedAt));
    if (head === null) {
      const durationMs = elapsed(startedAt);
      return { ...failure(WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED, `Worker router completed, but an exact 40-hex HEAD could not be read from ${cwd}.`, durationMs), diagnostics: [`${WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED}: could not read an exact 40-hex HEAD from ${cwd}.`, ...diagnostics] };
    }
    const ancestry = await this.verifyBaseAncestry(request.signal, cwd, request.baseSha, head);
    if (!ancestry.ok) {
      const durationMs = elapsed(startedAt);
      if (ancestry.cancelled) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router ancestry verification was cancelled.', durationMs);
      return {
        ...failure(WORKER_ROUTER_ERROR_CODE.BASE_ANCESTRY_FAILED, `Worker router HEAD ${head} does not prove descent from the authorized base.`, durationMs),
        diagnostics: [`${WORKER_ROUTER_ERROR_CODE.BASE_ANCESTRY_FAILED}: ${ancestry.detail}`, ...diagnostics, ...ancestry.diagnostics],
      };
    }
    const published = await this.publishHead(request.signal, cwd, head, branch);
    if (!published.ok) {
      const durationMs = elapsed(startedAt);
      if (published.cancelled) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router publication was cancelled.', durationMs);
      return {
        ...failure(WORKER_ROUTER_ERROR_CODE.PUBLISH_FAILED, `Worker router committed ${head}, but Conductor could not publish it to origin/${branch}.`, durationMs),
        diagnostics: [`${WORKER_ROUTER_ERROR_CODE.PUBLISH_FAILED}: ${published.detail}`, ...diagnostics, ...published.diagnostics],
      };
    }
    return { exitStatus: 'success', summary: 'Worker router completed implementation inside the container boundary and Conductor published the exact committed HEAD.', headSha: head, ...(diagnostics.length === 0 ? {} : { diagnostics }), durationMs: elapsed(startedAt) };
  }

  private containerSpec(image: string, cwd: string, task: string, signal: AbortSignal | undefined): WorkerContainerSpec {
    return {
      image,
      entrypoint: this.executable,
      args: [],
      mounts: planCommitOnlyMounts(cwd),
      env: this.containerEnvironment(),
      network: this.network,
      workdir: cwd,
      stdin: task,
      timeoutMs: this.timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /** Forward only the named worker inputs; never a broad host environment. */
  private containerEnvironment(): Readonly<Record<string, string>> {
    const forwarded: Record<string, string> = { HOME: WORKER_ROUTER_CONTAINER_HOME };
    for (const key of this.containerEnvKeys) {
      const value = this.hostEnv[key];
      if (typeof value === 'string' && value !== '') forwarded[key] = value;
    }
    return forwarded;
  }

  private containerFailure(error: unknown, signal: AbortSignal | undefined, startedAt: number, env: Readonly<Record<string, string>>): AgentResult {
    const durationMs = elapsed(startedAt);
    const containerCode = isWorkerRouterContainerError(error) ? error.code : undefined;
    if (isAborted(signal) || containerCode === WORKER_ROUTER_CONTAINER_ERROR_CODE.CANCELLED) {
      return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', durationMs);
    }
    if (containerCode === WORKER_ROUTER_CONTAINER_ERROR_CODE.TIMEOUT) {
      return failure(WORKER_ROUTER_ERROR_CODE.TIMEOUT, `Worker router container timed out after ${this.timeoutMs}ms.`, durationMs);
    }
    const message = redactWorkerEnvValues(boundedMessage(error), env);
    return failure(adapterCodeFor(containerCode), `Worker router container failed closed: ${message}`, durationMs);
  }

  private async verifyBaseAncestry(
    signal: AbortSignal | undefined,
    cwd: string,
    baseSha: string,
    head: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly cancelled: boolean; readonly detail: string; readonly diagnostics: string[] }> {
    if (!FULL_SHA.test(baseSha)) {
      return { ok: false, cancelled: false, detail: 'The authorized base is not an exact 40-hex SHA.', diagnostics: [] };
    }
    try {
      const result = await this.runner.run('git', ['merge-base', '--is-ancestor', baseSha, head], this.options(signal, cwd, ''));
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        cancelled: false,
        detail: `git merge-base --is-ancestor exited with status ${result.exitCode}; refusing to publish without a proven ancestry chain.`,
        diagnostics: boundedDiagnostics(result.stderr, result.stdout, undefined),
      };
    } catch (error) {
      const code = errorCode(error);
      if (isAborted(signal) || code === 'ABORT_ERR') {
        return { ok: false, cancelled: true, detail: 'Ancestry verification was cancelled.', diagnostics: [] };
      }
      return { ok: false, cancelled: false, detail: `Ancestry verification failed: ${errorMessage(error)}`, diagnostics: [] };
    }
  }

  private options(signal: AbortSignal | undefined, cwd: string, stdin: string): ProcessRunOptions {
    return { timeoutMs: this.timeoutMs, cwd, stdin, ...(signal === undefined ? {} : { signal }) };
  }

  private async readHead(signal: AbortSignal | undefined, cwd: string): Promise<string | null> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], this.options(signal, cwd, ''));
      const sha = result.stdout.trim();
      return result.exitCode === 0 && FULL_SHA.test(sha) ? sha : null;
    } catch { return null; }
  }

  private async publishHead(
    signal: AbortSignal | undefined,
    cwd: string,
    head: string,
    branch: string,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly cancelled: boolean; readonly detail: string; readonly diagnostics: string[] }> {
    try {
      const result = await this.runner.run(
        'git',
        ['push', '--porcelain', 'origin', `${head}:refs/heads/${branch}`],
        this.options(signal, cwd, ''),
      );
      if (result.exitCode === 0) return { ok: true };
      return {
        ok: false,
        cancelled: false,
        detail: `git push exited with status ${result.exitCode}.`,
        diagnostics: boundedDiagnostics(result.stderr, result.stdout, undefined),
      };
    } catch (error) {
      const code = errorCode(error);
      if (isAborted(signal) || code === 'ABORT_ERR') {
        return { ok: false, cancelled: true, detail: 'git push was cancelled.', diagnostics: [] };
      }
      return {
        ok: false,
        cancelled: false,
        detail: `git push failed: ${errorMessage(error)}`,
        diagnostics: [],
      };
    }
  }
}

function adapterCodeFor(code: WorkerRouterContainerErrorCode | undefined): string {
  switch (code) {
    case WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_REQUIRED: return WORKER_ROUTER_ERROR_CODE.IMAGE_REQUIRED;
    case WORKER_ROUTER_CONTAINER_ERROR_CODE.IMAGE_UNPINNED: return WORKER_ROUTER_ERROR_CODE.IMAGE_UNPINNED;
    case WORKER_ROUTER_CONTAINER_ERROR_CODE.MOUNTS_INVALID: return WORKER_ROUTER_ERROR_CODE.MOUNTS_INVALID;
    case WORKER_ROUTER_CONTAINER_ERROR_CODE.RUNTIME_NOT_FOUND: return WORKER_ROUTER_ERROR_CODE.NOT_FOUND;
    case WORKER_ROUTER_CONTAINER_ERROR_CODE.TERMINAL_UNPROVEN: return WORKER_ROUTER_ERROR_CODE.CONTAINMENT_UNPROVEN;
    default: return WORKER_ROUTER_ERROR_CODE.CONTAINER_FAILURE;
  }
}

function buildTask(request: ImplementationRequest): string {
  const target = request.target.kind === 'issue'
    ? `${request.target.owner}/${request.target.repo}#${request.target.issueNumber}`
    : `${request.target.owner}/${request.target.repo}@${request.target.branch}`;
  const authority = request.authority === 'live-target'
    ? 'Treat the live GitHub target and repository-local instructions as authority.'
    : 'Treat the supplied task instructions and repository-local instructions as authority.';
  return [
    `Implement ${target} in the prepared worktree.`,
    authority,
    'Do not expand scope.',
    'Run focused/repository-required validation.',
    'Commit all in-scope changes before reporting success.',
    'Do not push; Conductor publishes the exact committed HEAD after workspace verification.',
    'Return blockers instead of guessing.',
    request.authority === 'live-target' ? request.supplementalInstructions : request.instructions,
  ].filter((line): line is string => line !== undefined && line !== '').join('\n') + '\n';
}

function workerProvenance(stderr: string): string | undefined {
  const match = stderr.match(/^\[worker-router\] -> (luna-worker|deepseek-worker)\s*$/m);
  return match?.[0];
}

function boundedDiagnostics(stderr: string, stdout: string, provenance: string | undefined): string[] {
  // Worker output is an untrusted transcript and may contain secrets or
  // prompt material. Persist only the recognized provider marker.
  void stderr;
  void stdout;
  return provenance === undefined ? [] : [provenance];
}

function failure(code: string, summary: string, durationMs: number): AgentResult { return { exitStatus: 'failure', summary, diagnostics: [`${code}: ${summary}`], durationMs }; }
function elapsed(startedAt: number): number { return Math.max(0, Date.now() - startedAt); }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
