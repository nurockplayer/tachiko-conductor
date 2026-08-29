import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

import type { McpHttpCapability } from '../adapters/agent.js';

export const BROWSER_RUNTIME_ERROR_CODE = {
  INVALID_CONFIG: 'BROWSER_INVALID_CONFIG',
  PORT_IN_USE: 'BROWSER_PORT_IN_USE',
  PROFILE_IN_USE: 'BROWSER_PROFILE_IN_USE',
  STARTUP_TIMEOUT: 'BROWSER_STARTUP_TIMEOUT',
  CHILD_EXITED: 'BROWSER_CHILD_EXITED',
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
}

interface RuntimeLock {
  readonly version: 1;
  readonly runtimeId: string;
  readonly pid: number;
}

type ChildOutcome =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: 'error'; readonly error: Error };

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export class ManagedPlaywrightMcpRuntime implements BrowserRuntime {
  private readonly profileRoot: string;
  private readonly runtimeRoot: string;
  private readonly repositoryRoot: string;
  private readonly playwrightCliPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => string;

  constructor(options: ManagedPlaywrightMcpRuntimeOptions) {
    this.profileRoot = path.resolve(options.profileRoot);
    this.runtimeRoot = path.resolve(options.runtimeRoot);
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.playwrightCliPath = options.playwrightCliPath ?? resolvePlaywrightMcpCli();
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
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
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const lockPath = path.join(profileDir, '.tachiko-runtime-lock.json');
    acquireLock(lockPath, { version: 1, runtimeId, pid: process.pid }, options.profile);

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
          stdio: 'ignore',
        },
      );
    } catch (error) {
      releaseLock(lockPath, runtimeId);
      throw new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED,
        `Could not start the Playwright MCP process for profile "${options.profile}".`,
        { profile: options.profile, cause: errorMessage(error) },
      );
    }

    const childOutcome = observeChild(child);
    if (child.pid === undefined) {
      const outcome = await childOutcome;
      releaseLock(lockPath, runtimeId);
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
      headless,
      state: 'starting',
      health: 'starting',
      startedAt: this.now(),
    };
    writeJsonAtomic(metadataPath, started);

    const startupAbort = new AbortController();
    const startup = await Promise.race([
      waitForPort(host, port, startupTimeoutMs, startupAbort.signal).then(
        () => ({ kind: 'ready' as const }),
        (error: unknown) => ({ kind: 'startup-error' as const, error }),
      ),
      childOutcome,
    ]);
    startupAbort.abort();
    if (startup.kind === 'startup-error') {
      child.kill('SIGTERM');
      await Promise.race([childOutcome, delay(1_000)]);
      if (processIsAlive(child.pid)) child.kill('SIGKILL');
      const failed: BrowserRuntimeSnapshot = {
        ...started,
        state: 'failed',
        health: 'failed',
        stoppedAt: this.now(),
        errorCode: BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT,
      };
      writeJsonAtomic(metadataPath, failed);
      releaseLock(lockPath, runtimeId);
      throw startup.error;
    }
    if (startup.kind !== 'ready') {
      const failed = failedSnapshot(started, startup, this.now());
      writeJsonAtomic(metadataPath, failed);
      releaseLock(lockPath, runtimeId);
      throw childOutcomeError(options.profile, startup);
    }

    const ready: BrowserRuntimeSnapshot = {
      ...started,
      state: 'ready',
      health: 'ready',
      readyAt: this.now(),
    };
    writeJsonAtomic(metadataPath, ready);

    const completion = childOutcome.then((outcome) => {
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
      writeJsonAtomic(metadataPath, finalSnapshot);
      releaseLock(lockPath, runtimeId);
      return finalSnapshot;
    });

    return {
      snapshot: ready,
      stop: async () => await this.stopHandle(ready, child, completion, stopTimeoutMs),
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
    if (!processIsAlive(snapshot.pid)) {
      const finalSnapshot: BrowserRuntimeSnapshot =
        snapshot.state === 'stopping'
          ? { ...snapshot, state: 'stopped', health: 'stopped', stoppedAt: this.now() }
          : {
              ...snapshot,
              state: 'failed',
              health: 'failed',
              stoppedAt: this.now(),
              errorCode: BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED,
            };
      writeJsonAtomic(metadataPath, finalSnapshot);
      releaseLock(path.join(this.profileDir(profile), '.tachiko-runtime-lock.json'), snapshot.runtimeId);
      return finalSnapshot;
    }
    if (snapshot.state === 'ready') {
      const healthy = await canConnect(snapshot.host, snapshot.port);
      const checked: BrowserRuntimeSnapshot = { ...snapshot, health: healthy ? 'ready' : 'unhealthy' };
      writeJsonAtomic(metadataPath, checked);
      return checked;
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
    const metadataPath = this.metadataPath(profile);
    const stopping: BrowserRuntimeSnapshot = { ...snapshot, state: 'stopping', health: 'stopping' };
    writeJsonAtomic(metadataPath, stopping);
    signalProcess(snapshot.pid, 'SIGTERM');
    const stopped = await waitForProcessExit(snapshot.pid, DEFAULT_STOP_TIMEOUT_MS);
    if (!stopped) {
      signalProcess(snapshot.pid, 'SIGKILL');
      if (!(await waitForProcessExit(snapshot.pid, 1_000))) {
        throw new BrowserRuntimeError(
          BROWSER_RUNTIME_ERROR_CODE.STOP_TIMEOUT,
          `Browser profile "${profile}" did not stop after SIGTERM and SIGKILL.`,
          { profile, pid: snapshot.pid },
        );
      }
    }
    const finalSnapshot: BrowserRuntimeSnapshot = {
      ...stopping,
      state: 'stopped',
      health: 'stopped',
      stoppedAt: this.now(),
    };
    writeJsonAtomic(metadataPath, finalSnapshot);
    releaseLock(path.join(this.profileDir(profile), '.tachiko-runtime-lock.json'), snapshot.runtimeId);
    return finalSnapshot;
  }

  private async stopHandle(
    snapshot: BrowserRuntimeSnapshot,
    child: ChildProcess,
    completion: Promise<BrowserRuntimeSnapshot>,
    timeoutMs: number,
  ): Promise<BrowserRuntimeSnapshot> {
    const current = await this.status(snapshot.profile);
    if (current === null || (current.state !== 'starting' && current.state !== 'ready' && current.state !== 'stopping')) {
      return current ?? snapshot;
    }
    writeJsonAtomic(this.metadataPath(snapshot.profile), { ...current, state: 'stopping', health: 'stopping' });
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

  private profileDir(profile: string): string {
    return path.join(this.profileRoot, profile);
  }

  private metadataPath(profile: string): string {
    return path.join(this.runtimeRoot, `${profile}.json`);
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

function acquireLock(file: string, lock: RuntimeLock, profile: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${JSON.stringify(lock)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const existing = readLock(file);
      if (existing !== null && processIsAlive(existing.pid)) {
        throw new BrowserRuntimeError(
          BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
          `Browser profile "${profile}" is already owned by live runtime ${existing.runtimeId} (PID ${existing.pid}).`,
          { profile, runtimeId: existing.runtimeId, pid: existing.pid },
        );
      }
      rmSync(file, { force: true });
    }
  }
  throw new BrowserRuntimeError(
    BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE,
    `Browser profile "${profile}" could not be locked.`,
    { profile },
  );
}

function releaseLock(file: string, runtimeId: string): void {
  const current = readLock(file);
  if (current?.runtimeId === runtimeId) rmSync(file, { force: true });
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

async function waitForPort(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!signal?.aborted && Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await delay(25);
  }
  if (signal?.aborted) return;
  throw new BrowserRuntimeError(
    BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT,
    `Playwright MCP did not become ready on ${host}:${port} within ${timeoutMs}ms.`,
    { host, port, timeoutMs },
  );
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
