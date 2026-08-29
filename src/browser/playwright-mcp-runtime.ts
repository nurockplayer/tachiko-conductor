import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { McpHttpCapability } from '../adapters/agent.js';

export const BROWSER_RUNTIME_ERROR_CODE = {
  INVALID_CONFIG: 'BROWSER_INVALID_CONFIG',
  PORT_IN_USE: 'BROWSER_PORT_IN_USE',
  PROFILE_IN_USE: 'BROWSER_PROFILE_IN_USE',
  STARTUP_TIMEOUT: 'BROWSER_STARTUP_TIMEOUT',
  CHILD_EXITED: 'BROWSER_CHILD_EXITED',
  OWNER_EXITED: 'BROWSER_OWNER_EXITED',
  SPAWN_FAILED: 'BROWSER_SPAWN_FAILED',
  BOOTSTRAP_FAILED: 'BROWSER_BOOTSTRAP_FAILED',
  NOT_RUNNING: 'BROWSER_NOT_RUNNING',
  STOP_TIMEOUT: 'BROWSER_STOP_TIMEOUT',
} as const;

export type BrowserRuntimeErrorCode =
  (typeof BROWSER_RUNTIME_ERROR_CODE)[keyof typeof BROWSER_RUNTIME_ERROR_CODE];

export class BrowserRuntimeError extends Error {
  override readonly name = 'BrowserRuntimeError';

  constructor(
    readonly code: BrowserRuntimeErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export type BrowserRuntimeState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export type BrowserRuntimeHealth = 'starting' | 'ready' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';

export interface BrowserRuntimeSnapshot {
  readonly runtimeId: string;
  readonly profile: string;
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  readonly pid: number;
  /** Foreground Conductor process that owns and can safely stop the child. */
  readonly ownerPid: number;
  readonly stopTimeoutMs: number;
  readonly headless: boolean;
  readonly state: BrowserRuntimeState;
  readonly health: BrowserRuntimeHealth;
  readonly startedAt: string;
  readonly readyAt?: string;
  readonly stoppedAt?: string;
  readonly errorCode?: BrowserRuntimeErrorCode;
  readonly exitCode?: number | null;
  readonly exitSignal?: NodeJS.Signals | null;
}

export interface StartBrowserRuntimeOptions {
  readonly profile: string;
  readonly port?: number;
  readonly host?: string;
  readonly headless?: boolean;
  readonly startupTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface BrowserRuntimeHandle {
  readonly snapshot: BrowserRuntimeSnapshot;
  stop(): Promise<BrowserRuntimeSnapshot>;
  waitForExit(): Promise<BrowserRuntimeSnapshot>;
}

export interface BrowserRuntime {
  start(options: StartBrowserRuntimeOptions): Promise<BrowserRuntimeHandle>;
  status(profile: string): Promise<BrowserRuntimeSnapshot | null>;
  stop(profile: string): Promise<BrowserRuntimeSnapshot>;
}

export interface PlaywrightMcpArgumentOptions {
  readonly host: string;
  readonly port: number;
  readonly profileDir: string;
  readonly outputDir: string;
  readonly headless: boolean;
}

export function buildPlaywrightMcpArgs(options: PlaywrightMcpArgumentOptions): string[] {
  const allowedHosts = loopbackAllowedHosts(options.host, options.port);
  return [
    '--host',
    options.host,
    '--port',
    String(options.port),
    '--allowed-hosts',
    allowedHosts,
    '--user-data-dir',
    options.profileDir,
    '--output-dir',
    options.outputDir,
    '--shared-browser-context',
    ...(options.headless ? ['--headless'] : []),
  ];
}

export function browserRuntimeCapability(snapshot: BrowserRuntimeSnapshot): McpHttpCapability {
  if (snapshot.state !== 'ready' || snapshot.health !== 'ready') {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
      `Browser profile "${snapshot.profile}" is not ready.`,
      { profile: snapshot.profile, state: snapshot.state, health: snapshot.health },
    );
  }
  return { kind: 'mcp-http', name: 'tachiko_browser', endpoint: snapshot.endpoint };
}

export interface ManagedPlaywrightMcpRuntimeOptions {
  readonly profileRoot: string;
  readonly runtimeRoot: string;
  readonly repositoryRoot: string;
  readonly playwrightCliPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly readinessProbe?: (endpoint: string) => Promise<boolean>;
}

interface RuntimeLock {
  readonly version: 1;
  readonly runtimeId: string;
  readonly pid: number;
}

type ChildOutcome =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'error'; readonly error: Error };
type OwnedRuntimeWriteResult = 'written' | 'identity-changed' | 'guard-timeout';

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNTIME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const POST_KILL_EXIT_TIMEOUT_MS = 1_000;

export class ManagedPlaywrightMcpRuntime implements BrowserRuntime {
  private readonly profileRoot: string;
  private readonly runtimeRoot: string;
  private readonly repositoryRoot: string;
  private readonly playwrightCliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => string;
  private readonly readinessProbe: (endpoint: string) => Promise<boolean>;

  constructor(options: ManagedPlaywrightMcpRuntimeOptions) {
    this.profileRoot = path.resolve(options.profileRoot);
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.playwrightCliPath = options.playwrightCliPath ?? resolvePlaywrightMcpCli();
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.readinessProbe = options.readinessProbe ?? probeMcpEndpoint;
  }

  async start(options: StartBrowserRuntimeOptions): Promise<BrowserRuntimeHandle> {
    this.validateRoots();
    validateProfile(options.profile);
    const host = options.host ?? '127.0.0.1';
    validateHost(host);
    const headless = options.headless ?? true;
    const startupTimeoutMs = validateTimeout(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs');
    const stopTimeoutMs = validateTimeout(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs');
    const port = options.port === undefined ? await findAvailablePort(host) : validatePort(options.port);
    await assertPortAvailable(host, port);

    const runtimeId = randomUUID();
    const profileDir = this.profileDir(options.profile);
    const outputDir = path.join(this.runtimeRoot, `${options.profile}-output`);
    mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    this.validateResolvedStorage([this.profileRoot, this.runtimeRoot]);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    this.validateResolvedStorage([profileDir, outputDir]);
    const lockPath = path.join(profileDir, '.tachiko-runtime-lock.json');
    const startupGuard = acquireLock(lockPath, { version: 1, runtimeId, pid: process.pid }, options.profile);

    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [
          this.playwrightCliPath,
          ...buildPlaywrightMcpArgs({ host, port, profileDir, outputDir, headless }),
        ],
        {
          cwd: this.runtimeRoot,
          env: this.env,
          // The pinned Playwright MCP server treats stdin EOF as a parent-death
          // signal and closes its browser before exiting. Keeping this pipe open
          // gives abrupt owner termination an identity-safe cleanup path.
          stdio: ['pipe', 'ignore', 'ignore'],
        },
      );
    } catch (error) {
      releaseOwnedLockWithGuard(lockPath, startupGuard, runtimeId);
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED,
        `Could not start the Playwright MCP process for profile "${options.profile}".`,
        { profile: options.profile, cause: errorMessage(error) },
      );
    }

    const childOutcome = observeChild(child);
    if (child.pid === undefined) {
      const outcome = await childOutcome;
      releaseOwnedLockWithGuard(lockPath, startupGuard, runtimeId);
      throw childOutcomeError(options.profile, outcome);
    }
    writeJsonAtomic(lockPath, { version: 1, runtimeId, pid: child.pid } satisfies RuntimeLock);
    const metadataPath = this.metadataPath(options.profile);
    const started: BrowserRuntimeSnapshot = {
      runtimeId,
      profile: options.profile,
      endpoint: endpointFor(host, port),
      host,
      port,
      pid: child.pid,
      ownerPid: process.pid,
      stopTimeoutMs,
      headless,
      state: 'starting',
      health: 'starting',
      startedAt: this.now(),
    };
    writeJsonAtomic(metadataPath, started);
    const stopRequestPath = this.stopRequestPath(options.profile, runtimeId);

    const startupAbort = new AbortController();
    const startup = await Promise.race([
      waitForReadiness(started.endpoint, startupTimeoutMs, this.readinessProbe, startupAbort.signal).then(
        () => ({ kind: 'ready' as const }),
        (error: unknown) => ({ kind: 'startup-error' as const, error }),
      ),
      waitForStopRequest(stopRequestPath, startupAbort.signal).then(() => ({ kind: 'stop-request' as const })),
      childOutcome,
    ]);
    startupAbort.abort();
    if (startup.kind === 'stop-request') {
      const stopping: BrowserRuntimeSnapshot = { ...started, state: 'stopping', health: 'stopping' };
      writeJsonAtomic(metadataPath, stopping);
      const finalization = childOutcome.then(async (outcome) => {
        const stopped: BrowserRuntimeSnapshot = {
          ...stopping,
          state: 'stopped',
          health: 'stopped',
          stoppedAt: this.now(),
          ...(outcome.kind === 'exit' ? { exitCode: outcome.code, exitSignal: outcome.signal } : {}),
        };
        finalizeOwnedRuntimeWithGuard(metadataPath, lockPath, startupGuard, runtimeId, stopped);
        rmSync(stopRequestPath, { force: true });
        return stopped;
      });
      child.kill('SIGTERM');
      const terminated = await Promise.race([
        finalization.then(() => true),
        delay(stopTimeoutMs).then(() => false),
      ]);
      if (!terminated) {
        child.kill('SIGKILL');
        const killed = await Promise.race([
          finalization.then(() => true),
          delay(POST_KILL_EXIT_TIMEOUT_MS).then(() => false),
        ]);
        if (!killed) void finalization.catch(() => undefined);
      }
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
        `Browser profile "${options.profile}" was stopped before it became ready.`,
        { profile: options.profile, runtimeId },
      );
    }
    if (startup.kind === 'startup-error') {
      writeJsonAtomic(metadataPath, {
        ...started,
        state: 'stopping',
        health: 'stopping',
        errorCode: BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT,
      } satisfies BrowserRuntimeSnapshot);
      const finalization = childOutcome.then((outcome) => {
        const failed: BrowserRuntimeSnapshot = {
          ...started,
          state: 'failed',
          health: 'failed',
          stoppedAt: this.now(),
          errorCode: BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT,
          ...(outcome.kind === 'exit' ? { exitCode: outcome.code, exitSignal: outcome.signal } : {}),
        };
        return Promise.resolve().then(() => {
          finalizeOwnedRuntimeWithGuard(metadataPath, lockPath, startupGuard, runtimeId, failed);
          rmSync(stopRequestPath, { force: true });
          return failed;
        });
      });
      child.kill('SIGTERM');
      const terminated = await Promise.race([
        finalization.then(() => true),
        delay(stopTimeoutMs).then(() => false),
      ]);
      if (!terminated) {
        child.kill('SIGKILL');
        const killed = await Promise.race([
          finalization.then(() => true),
          delay(POST_KILL_EXIT_TIMEOUT_MS).then(() => false),
        ]);
        if (!killed) {
          // Keep finalization alive so profile ownership is released only after
          // actual exit, while returning the typed startup timeout promptly.
          void finalization.catch(() => undefined);
          throw startup.error;
        }
      }
      throw startup.error;
    }
    if (startup.kind !== 'ready') {
      const failed = failedSnapshot(started, startup, this.now());
      finalizeOwnedRuntimeWithGuard(metadataPath, lockPath, startupGuard, runtimeId, failed);
      throw childOutcomeError(options.profile, startup);
    }

    const ready: BrowserRuntimeSnapshot = {
      ...started,
      state: 'ready',
      health: 'ready',
      readyAt: this.now(),
    };
    try {
      writeJsonAtomic(metadataPath, ready);
    } finally {
      rmSync(startupGuard, { force: true });
    }

    let stopRequestTimer: NodeJS.Timeout | undefined;
    const completion = childOutcome.then(async (outcome) => {
      const current = readSnapshot(metadataPath);
      const normalStop = current?.runtimeId === runtimeId && current.state === 'stopping';
      const finalSnapshot: BrowserRuntimeSnapshot = normalStop
        ? {
            ...(current ?? ready),
            state: 'stopped',
            health: 'stopped',
            stoppedAt: this.now(),
            ...(outcome.kind === 'exit' ? { exitCode: outcome.code, exitSignal: outcome.signal } : {}),
          }
        : failedSnapshot(current?.runtimeId === runtimeId ? current : ready, outcome, this.now());
      await finalizeOwnedRuntime(metadataPath, lockPath, runtimeId, finalSnapshot);
      rmSync(stopRequestPath, { force: true });
      return finalSnapshot;
    }).finally(() => {
      if (stopRequestTimer !== undefined) clearInterval(stopRequestTimer);
    });

    let stopPromise: Promise<BrowserRuntimeSnapshot> | undefined;
    const requestOwnedStop = (): Promise<BrowserRuntimeSnapshot> => {
      if (stopPromise === undefined) {
        const attempt = this.stopHandle(ready, child, completion, stopTimeoutMs);
        stopPromise = attempt.catch((error: unknown) => {
          stopPromise = undefined;
          throw error;
        });
      }
      return stopPromise;
    };
    stopRequestTimer = setInterval(() => {
      try {
        const current = readSnapshot(metadataPath);
        if (
          current?.runtimeId === runtimeId &&
          (current.state === 'stopping' || existsSync(stopRequestPath))
        ) {
          void requestOwnedStop().catch(() => undefined);
        }
      } catch {
        // A malformed metadata file is reported by status; never infer a stop
        // request from data that cannot be read safely.
      }
    }, 25);
    stopRequestTimer.unref();

    return {
      snapshot: ready,
      stop: requestOwnedStop,
      waitForExit: async () => await completion,
    };
  }

  async status(profile: string): Promise<BrowserRuntimeSnapshot | null> {
    this.validateRoots();
    validateProfile(profile);
    const metadataPath = this.metadataPath(profile);
    const snapshot = readSnapshot(metadataPath);
    if (snapshot === null) return null;
    if (snapshot.state !== 'starting' && snapshot.state !== 'ready' && snapshot.state !== 'stopping') {
      return snapshot;
    }
    const ownerAlive = processIsAlive(snapshot.ownerPid);
    if (!processIsAlive(snapshot.pid)) {
      const ownerExited = !ownerAlive || snapshot.errorCode === BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED;
      const finalSnapshot: BrowserRuntimeSnapshot =
        snapshot.state === 'stopping' && !ownerExited
          ? { ...snapshot, state: 'stopped', health: 'stopped', stoppedAt: this.now() }
          : {
              ...snapshot,
              state: 'failed',
              health: 'failed',
              stoppedAt: this.now(),
              errorCode: ownerExited
                ? BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED
                : BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED,
            };
      rmSync(this.stopRequestPath(profile, snapshot.runtimeId), { force: true });
      // Status is observational and may run in another process. Persisting or
      // releasing here could race a stale-lock reclaim and overwrite/remove a
      // replacement identity; the foreground completion or next start owns
      // those mutations.
      return finalSnapshot;
    }
    if (!ownerAlive) {
      const stopping: BrowserRuntimeSnapshot = {
        ...snapshot,
        state: 'stopping',
        health: 'stopping',
        errorCode: BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED,
      };
      return stopping;
    }
    if (snapshot.state === 'ready') {
      const healthy = await this.readinessProbe(snapshot.endpoint);
      // Health probing awaits I/O. Re-read afterward so an owner transition
      // that completed meanwhile wins, and never persist a stale ready view.
      const current = readSnapshot(metadataPath);
      if (current === null || current.runtimeId !== snapshot.runtimeId || current.state !== 'ready') {
        return current ?? snapshot;
      }
      return { ...current, health: healthy ? 'ready' : 'unhealthy' };
    }
    return snapshot;
  }

  async stop(profile: string): Promise<BrowserRuntimeSnapshot> {
    const snapshot = await this.status(profile);
    if (snapshot === null || (snapshot.state !== 'starting' && snapshot.state !== 'ready' && snapshot.state !== 'stopping')) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
        `Browser profile "${profile}" is not running.`,
        { profile, state: snapshot?.state ?? 'missing' },
      );
    }
    if (!processIsAlive(snapshot.ownerPid)) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
        `Browser profile "${profile}" has no live foreground owner; refusing an unsafe PID-only stop.`,
        { profile, pid: snapshot.pid, ownerPid: snapshot.ownerPid, runtimeId: snapshot.runtimeId },
      );
    }
    const metadataPath = this.metadataPath(profile);
    // The foreground owner observes this runtime-ID-scoped request and stops
    // its own ChildProcess handle. This process never rewrites lifecycle state
    // or signals a persisted PID, either of which could target a replacement.
    writeJsonAtomic(this.stopRequestPath(profile, snapshot.runtimeId), {
      version: 1,
      runtimeId: snapshot.runtimeId,
      requestedAt: this.now(),
    });
    const ownerStopTimeoutMs = persistedStopTimeout(snapshot.stopTimeoutMs);
    const stopped = await waitForProcessExit(snapshot.pid, ownerStopTimeoutMs + 1_250);
    if (!stopped) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.STOP_TIMEOUT,
        `Browser profile "${profile}" did not stop through its foreground owner; no persisted PID was signalled.`,
        { profile, pid: snapshot.pid, ownerPid: snapshot.ownerPid },
      );
    }
    const ownerSnapshot = await waitForTerminalSnapshot(metadataPath, snapshot.runtimeId, 500);
    if (ownerSnapshot !== null) return ownerSnapshot;
    const finalSnapshot: BrowserRuntimeSnapshot = {
      ...snapshot,
      state: 'stopped',
      health: 'stopped',
      stoppedAt: this.now(),
    };
    // Only the foreground owner (or a later status reconciliation) persists
    // terminal state and releases ownership. Returning a derived result here
    // cannot overwrite a replacement runtime in the finalization window.
    return finalSnapshot;
  }

  private async stopHandle(
    snapshot: BrowserRuntimeSnapshot,
    child: ChildProcess,
    completion: Promise<BrowserRuntimeSnapshot>,
    timeoutMs: number,
  ): Promise<BrowserRuntimeSnapshot> {
    const current = await this.status(snapshot.profile);
    if (current?.runtimeId !== snapshot.runtimeId) {
      // A retained handle belongs only to the child it was created with. It
      // must never transition or stop a replacement that reused the profile.
      return await completion;
    }
    if (current === null || (current.state !== 'starting' && current.state !== 'ready' && current.state !== 'stopping')) {
      return current ?? snapshot;
    }
    const transition = await writeOwnedRuntimeSnapshot(
      this.metadataPath(snapshot.profile),
      path.join(this.profileDir(snapshot.profile), '.tachiko-runtime-lock.json'),
      snapshot.runtimeId,
      { ...current, state: 'stopping', health: 'stopping' },
      false,
    );
    if (transition === 'identity-changed') return await completion;
    if (transition === 'guard-timeout') {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
        `Browser profile "${snapshot.profile}" ownership is busy; retry stop after the ownership update completes.`,
        { profile: snapshot.profile, runtimeId: snapshot.runtimeId },
      );
    }
    child.kill('SIGTERM');
    const result = await Promise.race([
      completion.then((value) => ({ done: true as const, value })),
      delay(timeoutMs).then(() => ({ done: false as const })),
    ]);
    if (result.done) return result.value;
    child.kill('SIGKILL');
    const killed = await Promise.race([
      completion.then((value) => ({ done: true as const, value })),
      delay(1_000).then(() => ({ done: false as const })),
    ]);
    if (killed.done) return killed.value;
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.STOP_TIMEOUT,
      `Browser profile "${snapshot.profile}" did not stop after SIGTERM and SIGKILL.`,
      { profile: snapshot.profile, pid: snapshot.pid },
    );
  }

  private validateRoots(): void {
    for (const [name, value] of [
      ['profile root', this.profileRoot],
      ['runtime root', this.runtimeRoot],
    ] as const) {
      if (isWithin(this.repositoryRoot, value)) {
        throw new BrowserRuntimeError(
          BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
          `Browser ${name} must be outside the repository.`,
          { repositoryRoot: this.repositoryRoot, configuredRoot: value },
        );
      }
    }
  }

  private validateResolvedStorage(paths: readonly string[]): void {
    const repository = realpathSync(this.repositoryRoot);
    for (const configuredPath of paths) {
      const resolvedPath = realpathSync(configuredPath);
      if (isWithin(repository, resolvedPath)) {
        throw new BrowserRuntimeError(
          BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
          'Browser profile/runtime storage resolves inside the repository; symlinked repository paths are not allowed.',
          { repositoryRoot: repository, configuredPath, resolvedPath },
        );
      }
    }
  }

  private profileDir(profile: string): string {
    return path.join(this.profileRoot, profile);
  }

  private metadataPath(profile: string): string {
    return path.join(this.runtimeRoot, `${profile}.json`);
  }

  private stopRequestPath(profile: string, runtimeId: string): string {
    validateRuntimeId(runtimeId);
    return path.join(this.runtimeRoot, `${profile}.${runtimeId}.stop.json`);
  }
}

function resolvePlaywrightMcpCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('@playwright/mcp')), 'cli.js');
}

function validateProfile(profile: string): void {
  if (!PROFILE_PATTERN.test(profile) || profile === '.' || profile === '..') {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Invalid browser profile "${profile}"; use letters, digits, dots, underscores, or hyphens without path separators.`,
      { profile },
    );
  }
}

function validateRuntimeId(runtimeId: string): void {
  if (!RUNTIME_ID_PATTERN.test(runtimeId) || runtimeId === '.' || runtimeId === '..') {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      'Browser runtime metadata contains an invalid runtime identity.',
      { runtimeId },
    );
  }
}

function validateHost(host: string): void {
  if (host.trim() === '' || /[\s/]/.test(host)) {
    throw new BrowserRuntimeError(BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG, `Invalid browser host "${host}".`, { host });
  }
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Invalid browser port "${port}"; expected an integer from 1 to 65535.`,
      { port },
    );
  }
  return port;
}

function validateTimeout(timeoutMs: number, name: string): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Invalid ${name} "${timeoutMs}"; expected a positive number of milliseconds.`,
      { [name]: timeoutMs },
    );
  }
  return timeoutMs;
}

function persistedStopTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? value
    : DEFAULT_STOP_TIMEOUT_MS;
}

function loopbackAllowedHosts(host: string, port: number): string {
  if (host === '127.0.0.1' || host === 'localhost') return `127.0.0.1:${port},localhost:${port}`;
  if (host === '::1' || host === '[::1]') return `[::1]:${port},localhost:${port}`;
  return `${host}:${port}`;
}

function endpointFor(host: string, port: number): string {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/mcp`;
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, file);
}

function readSnapshot(file: string): BrowserRuntimeSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(raw) as BrowserRuntimeSnapshot;
  if (typeof value.runtimeId !== 'string') {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Browser runtime metadata at ${file} has no valid runtime identity.`,
      { metadataPath: file },
    );
  }
  validateRuntimeId(value.runtimeId);
  return value;
}

function readLock(file: string): RuntimeLock | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<RuntimeLock>;
    if (value.version !== 1 || typeof value.runtimeId !== 'string' || typeof value.pid !== 'number') return null;
    return value as RuntimeLock;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    return null;
  }
}

function acquireLock(file: string, lock: RuntimeLock, profile: string): string {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const guard = acquireLockGuard(path.dirname(file), profile);
  try {
    const existing = readLock(file);
    if (existing !== null && processIsAlive(existing.pid)) {
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
        `Browser profile "${profile}" is already owned by live runtime ${existing.runtimeId} (PID ${existing.pid}).`,
        { profile, runtimeId: existing.runtimeId, pid: existing.pid },
      );
    }
    if (existsSync(file)) rmSync(file, { force: true });
    try {
      writeFileSync(file, `${JSON.stringify(lock)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
        `Browser profile "${profile}" became owned while its lock was being acquired.`,
        { profile },
      );
    }
    return guard;
  } catch (error) {
    rmSync(guard, { force: true });
    throw error;
  }
}

function releaseOwnedLockWithGuard(lockPath: string, guard: string, runtimeId: string): void {
  try {
    const current = readLock(lockPath);
    if (current?.runtimeId === runtimeId) rmSync(lockPath, { force: true });
  } finally {
    rmSync(guard, { force: true });
  }
}

function finalizeOwnedRuntimeWithGuard(
  metadataPath: string,
  lockPath: string,
  guard: string,
  runtimeId: string,
  snapshot: BrowserRuntimeSnapshot,
): boolean {
  try {
    const lock = readLock(lockPath);
    const current = readSnapshot(metadataPath);
    if (lock?.runtimeId !== runtimeId || current?.runtimeId !== runtimeId) return false;
    writeJsonAtomic(metadataPath, snapshot);
    rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

async function finalizeOwnedRuntime(
  metadataPath: string,
  lockPath: string,
  runtimeId: string,
  snapshot: BrowserRuntimeSnapshot,
): Promise<OwnedRuntimeWriteResult> {
  return await writeOwnedRuntimeSnapshot(metadataPath, lockPath, runtimeId, snapshot, true);
}

async function writeOwnedRuntimeSnapshot(
  metadataPath: string,
  lockPath: string,
  runtimeId: string,
  snapshot: BrowserRuntimeSnapshot,
  release: boolean,
): Promise<OwnedRuntimeWriteResult> {
  const deadline = Date.now() + 1_000;
  let guard = tryAcquireLockGuard(path.dirname(lockPath));
  while (guard === null && Date.now() < deadline) {
    await delay(10);
    guard = tryAcquireLockGuard(path.dirname(lockPath));
  }
  if (guard === null) return 'guard-timeout';
  try {
    const lock = readLock(lockPath);
    const current = readSnapshot(metadataPath);
    if (lock?.runtimeId !== runtimeId || current?.runtimeId !== runtimeId) return 'identity-changed';
    writeJsonAtomic(metadataPath, snapshot);
    if (release) rmSync(lockPath, { force: true });
    return 'written';
  } finally {
    rmSync(guard, { force: true });
  }
}

function acquireLockGuard(profileDir: string, profile: string): string {
  const guard = path.join(profileDir, '.tachiko-runtime-lock.guard');
  try {
    writeFileSync(guard, `${JSON.stringify({ pid: process.pid })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return guard;
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const ownerPid = readGuardOwnerPid(guard);
    const ownerState = ownerPid === null ? 'unknown' : processIsAlive(ownerPid) ? 'live' : 'stale';
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
      ownerState === 'live'
        ? `Browser profile "${profile}" ownership is being updated by PID ${ownerPid}; retry shortly.`
        : `Browser profile "${profile}" has a ${ownerState} ownership guard at ${guard}; after verifying no start/stop is active, remove that guard and retry.`,
      { profile, guard, guardOwnerPid: ownerPid, guardOwnerState: ownerState },
    );
  }
}

function readGuardOwnerPid(guard: string): number | null {
  try {
    const value = JSON.parse(readFileSync(guard, 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' && Number.isInteger(value.pid) ? value.pid : null;
  } catch {
    return null;
  }
}

function tryAcquireLockGuard(profileDir: string): string | null {
  const guard = path.join(profileDir, '.tachiko-runtime-lock.guard');
  try {
    writeFileSync(guard, `${JSON.stringify({ pid: process.pid })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return guard;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  }
}

function observeChild(child: ChildProcess): Promise<ChildOutcome> {
  return new Promise<ChildOutcome>((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }));
    child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }));
  });
}

function failedSnapshot(
  snapshot: BrowserRuntimeSnapshot,
  outcome: ChildOutcome,
  stoppedAt: string,
): BrowserRuntimeSnapshot {
  return {
    ...snapshot,
    state: 'failed',
    health: 'failed',
    stoppedAt,
    errorCode:
      outcome.kind === 'error' ? BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED : BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED,
    ...(outcome.kind === 'exit' ? { exitCode: outcome.code, exitSignal: outcome.signal } : {}),
  };
}

function childOutcomeError(profile: string, outcome: ChildOutcome): BrowserRuntimeError {
  if (outcome.kind === 'error') {
    return new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED,
      `Could not start the Playwright MCP process for profile "${profile}": ${outcome.error.message}`,
      { profile },
    );
  }
  return new BrowserRuntimeError(
    BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED,
    `Playwright MCP for profile "${profile}" exited before readiness (exit code ${outcome.code ?? 'null'}, signal ${outcome.signal ?? 'none'}).`,
    { profile, exitCode: outcome.code, exitSignal: outcome.signal },
  );
}

async function findAvailablePort(host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a browser runtime port.'));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      reject(
        new BrowserRuntimeError(
          BROWSER_RUNTIME_ERROR_CODE.PORT_IN_USE,
          `Browser runtime port ${host}:${port} is unavailable.`,
          { host, port, cause: error.message },
        ),
      );
    });
    server.listen(port, host, () => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });
}

async function waitForReadiness(
  endpoint: string,
  timeoutMs: number,
  probe: (endpoint: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    if (await probe(endpoint)) return;
    await delay(25);
  }
  if (signal?.aborted) return;
  throw new BrowserRuntimeError(
    BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT,
    `Playwright MCP did not complete an MCP handshake at ${endpoint} within ${timeoutMs}ms.`,
    { endpoint, timeoutMs },
  );
}

function waitForStopRequest(file: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!existsSync(file)) return;
      clearInterval(timer);
      resolve();
    }, 25);
    timer.unref();
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  });
}

async function probeMcpEndpoint(endpoint: string): Promise<boolean> {
  const client = new Client({ name: 'tachiko-browser-health', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)), {
      timeout: 500,
      maxTotalTimeout: 500,
    });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await delay(25);
  }
  return !processIsAlive(pid);
}

async function waitForTerminalSnapshot(
  metadataPath: string,
  runtimeId: string,
  timeoutMs: number,
): Promise<BrowserRuntimeSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = readSnapshot(metadataPath);
    if (
      snapshot?.runtimeId === runtimeId &&
      (snapshot.state === 'stopped' || snapshot.state === 'failed')
    ) {
      return snapshot;
    }
    await delay(25);
  }
  return null;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
