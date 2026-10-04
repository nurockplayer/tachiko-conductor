import { execFile, spawn, type ExecFileException } from 'node:child_process';

import { boundToolOutputFromCapture, captureToolOutput, type ToolOutputEnvelope, type ToolOutputPolicy, type ToolOutputStore } from '../evidence/tool-output.js';
import { GitHubLiveStateError } from './errors.js';

export interface GitHubApiTransport {
  get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown>;
  getPaginated(path: string, query?: Readonly<Record<string, string>>): Promise<readonly unknown[]>;
  /** Execute a read-only GraphQL query for state not exposed by REST. */
  graphql?(query: string, variables?: Readonly<Record<string, string | number>>): Promise<unknown>;
  /** Read a non-JSON GitHub media representation, such as a complete PR diff. */
  getRaw?(path: string, accept: string): Promise<string>;
}

/** Explicit mutation surface used only by machine-owned GitHub comments. */
export interface GitHubWriteTransport extends GitHubApiTransport {
  write(path: string, method: 'POST' | 'PATCH', body: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Only explicit evidence commands return this bounded, drillable view. */
  readonly output?: ToolOutputEnvelope;
}

export interface ProcessRunOptions {
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Optional UTF-8 payload for non-interactive commands that read stdin. */
  readonly stdin?: string;
  /** Deliberately narrowed environment for an isolated implementation runtime. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Synchronous host check run immediately before child creation. Injected
   * runners must call this after their final asynchronous preparation and
   * directly before delegating to the real child-process boundary.
   */
  readonly beforeSpawn?: () => void;
  /**
   * Opt in only for command output safe to retain. This switches stdout/stderr
   * to bounded previews; machine-readable/provider transcripts must use the
   * default non-durable path. The owner retains/deletes the returned artifact.
   */
  readonly outputStore?: ToolOutputStore;
  readonly outputPolicy?: ToolOutputPolicy;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface NodeProcessRunnerOptions {
  /** Explicitly opt in to bounded evidence commands; no default durable capture. */
  readonly outputStore?: ToolOutputStore;
  readonly outputPolicy?: ToolOutputPolicy;
}

interface ProcessError extends ExecFileException {
  readonly killed?: boolean;
}

/** Production process boundary. Commands are always an executable plus args. */
export class NodeProcessRunner implements ProcessRunner {
  constructor(private readonly options: NodeProcessRunnerOptions = {}) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    const store = options.outputStore ?? this.options.outputStore;
    if (store !== undefined) return this.runCaptured(file, args, options, store);
    return await new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let stdinError: unknown;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      // Keep this callback in the child-creation turn: a rejected host check
      // must reject this promise without creating a process.
      options.beforeSpawn?.();
      const child = execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          cwd: options.cwd,
          signal: options.signal,
          ...(options.env === undefined ? {} : { env: options.env }),
          maxBuffer: 16 * 1024 * 1024,
        },
        (error: ProcessError | null, stdout: string, stderr: string) => {
          if (error === null) {
            if (stdinError !== undefined) {
              finish(() => reject(stdinError));
              return;
            }
            finish(() => resolve({ stdout, stderr, exitCode: 0 }));
            return;
          }
          if (options.signal?.aborted === true) {
            finish(() => reject(Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR' })));
            return;
          }
          if (error.killed) {
            finish(() => reject(Object.assign(new Error(`Command ${file} timed out after ${options.timeoutMs}ms.`), { code: 'ETIMEDOUT' })));
            return;
          }
          if (typeof error.code === 'number') {
            const exitCode = error.code;
            finish(() => resolve({ stdout, stderr, exitCode }));
            return;
          }
          finish(() => reject(error));
        },
      );
      // A child may close its read end before stdin is ended (for example,
      // EPIPE). Always consume the stream error so it cannot escape as an
      // unhandled process-level error.
      child.stdin?.on('error', (error) => {
        stdinError ??= error;
      });
      // Non-interactive CLIs may wait for piped stdin even when their prompt
      // and request are fully supplied as arguments.
      try {
        child.stdin?.end(options.stdin);
      } catch (error) {
        stdinError ??= error;
      }
    });
  }

  /** Stream evidence-bearing commands without execFile's buffered 16 MiB cap. */
  private async runCaptured(
    file: string, args: readonly string[], options: ProcessRunOptions, store: ToolOutputStore,
  ): Promise<ProcessResult> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a nonnegative safe integer.');
    }
    const policy = options.outputPolicy ?? this.options.outputPolicy;
    const capture = captureToolOutput(store, policy);
    const isAborted = (): boolean => options.signal?.aborted === true;
    return new Promise<ProcessResult>((resolve, reject) => {
      let stdinError: unknown;
      let processError: Error | undefined;
      let stopReason: 'timed_out' | 'cancelled' | undefined;
      let settled = false;
      let stopping = false;
      let exitObserved = false;
      let observedExitCode: number | null = null;
      let observedSignal: NodeJS.Signals | null = null;
      let incompleteCapture = false;
      let timer: NodeJS.Timeout | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let settlementTimer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (cleanupUnproven = false): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (settlementTimer !== undefined) clearTimeout(settlementTimer);
        options.signal?.removeEventListener('abort', onAbort);
        const outcome = stopReason ?? (processError !== undefined || !exitObserved || observedExitCode === null ||
          (observedExitCode === 0 && stdinError !== undefined) ? 'unknown' : observedExitCode === 0 ? 'passed' : 'failed');
        // Outcome describes cancellation/deadline; exitCode describes the
        // independently observed exit event, including a numeric TERM handler.
        const output = boundToolOutputFromCapture({ outcome, exitCode: observedExitCode,
          capture: capture.finish(), policy, captureTruncated: incompleteCapture });
        if (cleanupUnproven) {
          reject(Object.assign(new Error(`Command ${file} cleanup could not prove closed output streams and a stopped direct child.`), {
            code: 'ECHILD_CLEANUP_UNPROVEN', output, directChildExitObserved: exitObserved,
          }));
        } else if (stopReason === 'cancelled') {
          reject(Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR', output }));
        } else if (stopReason === 'timed_out') {
          reject(Object.assign(new Error(`Command ${file} timed out after ${options.timeoutMs}ms.`), { code: 'ETIMEDOUT', output }));
        } else if (processError !== undefined) {
          reject(Object.assign(processError, { output }));
        } else if (observedExitCode === 0 && stdinError !== undefined) {
          reject(Object.assign(stdinError instanceof Error ? stdinError : new Error('Command stdin failed.'), { output }));
        } else if (!exitObserved || observedExitCode === null) {
          reject(Object.assign(new Error(`Command ${file} terminated by ${observedSignal ?? 'an unknown signal'}.`), {
            code: null, signal: observedSignal, output,
          }));
        } else {
          resolve({ stdout: output.stdout.preview, stderr: output.stderr.preview, exitCode: observedExitCode, output });
        }
      };
      const requestStop = (reason: 'timed_out' | 'cancelled'): void => {
        if (settled) return;
        if (reason === 'cancelled' || stopReason === undefined) stopReason = reason;
        if (stopping) return;
        stopping = true;
        if (timer !== undefined) clearTimeout(timer);
        // Only this exact ChildProcess handle is signalled. No inferred or
        // unrelated process group is killed, and tree quiescence is not claimed.
        if (!exitObserved) { try { child?.kill('SIGTERM'); } catch { /* bounded fallback below */ } }
        forceTimer = setTimeout(() => {
          if (!exitObserved) { try { child?.kill('SIGKILL'); } catch { /* final refusal below */ } }
        }, 250);
        settlementTimer = setTimeout(() => {
          // A descendant may keep inherited pipes open after the direct child
          // exits. Close only our handles, mark evidence incomplete, and refuse
          // with an explicit unproven-cleanup error instead of hanging forever.
          incompleteCapture = true;
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          child?.stdin?.destroy();
          finish(true);
        }, 1_000);
      };
      const onAbort = (): void => { requestStop('cancelled'); };
      if (isAborted()) {
        stopReason = 'cancelled';
        finish();
        return;
      }
      try {
        // Same synchronous admission contract as the default execFile path.
        // No asynchronous work may intervene before the actual spawn.
        options.beforeSpawn?.();
        if (isAborted()) { stopReason = 'cancelled'; finish(); return; }
        child = spawn(file, [...args], {
          shell: false, stdio: ['pipe', 'pipe', 'pipe'], cwd: options.cwd,
          ...(options.env === undefined ? {} : { env: options.env }),
        });
      } catch (error) {
        capture.abort?.();
        reject(error);
        return;
      }
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (!settled) capture.write('stdout', chunk); });
      child.stderr?.on('data', (chunk: string) => { if (!settled) capture.write('stderr', chunk); });
      child.stdin?.on('error', (error) => { stdinError ??= error; });
      child.once('error', (error) => { processError = error; });
      child.once('exit', (code, signal) => {
        exitObserved = true; observedExitCode = code; observedSignal = signal;
      });
      child.once('close', () => { finish(incompleteCapture); });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      // The synchronous admission callback may have aborted the request.
      if (isAborted()) onAbort();
      else if (options.timeoutMs > 0) timer = setTimeout(() => { requestStop('timed_out'); }, options.timeoutMs);
      try { child.stdin?.end(options.stdin); } catch (error) { stdinError ??= error; }
    });
  }
}

export interface GhCliTransportOptions {
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function mapThrownError(error: unknown, path: string): GitHubLiveStateError {
  const code = errorCode(error);
  if (code === 'ETIMEDOUT') {
    return new GitHubLiveStateError('GH_TIMEOUT', `GitHub CLI timed out while reading ${path}.`, {
      retryable: true,
      details: { path },
      cause: error,
    });
  }
  if (code === 'ENOENT') {
    return new GitHubLiveStateError('GH_TRANSPORT_FAILED', 'GitHub CLI executable "gh" was not found.', {
      details: { path, executable: 'gh' },
      cause: error,
    });
  }
  return new GitHubLiveStateError('GH_TRANSPORT_FAILED', `Failed to run GitHub CLI while reading ${path}.`, {
    retryable: true,
    details: { path },
    cause: error,
  });
}

function mapCommandFailure(result: ProcessResult, path: string): GitHubLiveStateError {
  const diagnostic = `${result.stderr}\n${result.stdout}`.trim();
  const lower = diagnostic.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('secondary rate')) {
    return new GitHubLiveStateError('GH_RATE_LIMITED', `GitHub rate-limited the request for ${path}.`, {
      retryable: true,
      details: { path, exitCode: result.exitCode, diagnostic },
    });
  }
  if (/\b401\b/.test(lower) || lower.includes('requires authentication') || lower.includes('authentication required')) {
    return new GitHubLiveStateError('GH_AUTH_REQUIRED', `GitHub authentication is required to read ${path}.`, {
      details: { path, exitCode: result.exitCode, diagnostic },
    });
  }
  if (/\b404\b/.test(lower) || lower.includes('not found')) {
    return new GitHubLiveStateError('GH_NOT_FOUND', `GitHub resource ${path} was not found.`, {
      details: { path, exitCode: result.exitCode, diagnostic },
    });
  }
  const transient = /(?:connection|network|reset|timed?\s*out|http\s+5\d\d)/i.test(diagnostic);
  return new GitHubLiveStateError('GH_TRANSPORT_FAILED', `GitHub CLI failed while reading ${path}.`, {
    retryable: transient,
    details: { path, exitCode: result.exitCode, diagnostic },
  });
}

/** Read-only GitHub REST transport backed by the locally authenticated gh CLI. */
export class GhCliTransport implements GitHubApiTransport {
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: GhCliTransportOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private args(
    path: string,
    query: Readonly<Record<string, string>> = {},
    accept = 'application/vnd.github+json',
  ): string[] {
    const args = [
      'api',
      '--method',
      'GET',
      path,
      '-H',
      `Accept: ${accept}`,
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ];
    for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('-f', `${key}=${value}`);
    }
    return args;
  }

  private async execute(path: string, args: readonly string[]): Promise<string> {
    let result: ProcessResult;
    try {
      result = await this.runner.run('gh', args, { timeoutMs: this.timeoutMs });
    } catch (error) {
      throw mapThrownError(error, path);
    }
    if (result.exitCode !== 0) throw mapCommandFailure(result, path);
    return result.stdout;
  }

  async get(path: string, query: Readonly<Record<string, string>> = {}): Promise<unknown> {
    const raw = await this.execute(path, this.args(path, query));
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new GitHubLiveStateError('GH_INVALID_RESPONSE', `GitHub returned invalid JSON for ${path}.`, {
        details: { path },
        cause: error,
      });
    }
  }

  async getPaginated(path: string, query: Readonly<Record<string, string>> = {}): Promise<readonly unknown[]> {
    const raw = await this.execute(path, [...this.args(path, query), '--paginate', '--slurp']);
    let pages: unknown;
    try {
      pages = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new GitHubLiveStateError('GH_INVALID_RESPONSE', `GitHub returned invalid paginated JSON for ${path}.`, {
        details: { path },
        cause: error,
      });
    }
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new GitHubLiveStateError(
        'GH_INVALID_RESPONSE',
        `GitHub paginated response for ${path} was not an array of pages.`,
        { details: { path } },
      );
    }
    return pages.flat();
  }

  async graphql(
    query: string,
    variables: Readonly<Record<string, string | number>> = {},
  ): Promise<unknown> {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('-F', `${key}=${String(value)}`);
    }
    const path = 'graphql';
    const raw = await this.execute(path, args);
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new GitHubLiveStateError('GH_INVALID_RESPONSE', 'GitHub returned invalid JSON for graphql.', {
        details: { path },
        cause: error,
      });
    }
  }

  async getRaw(path: string, accept: string): Promise<string> {
    return await this.execute(path, this.args(path, {}, accept));
  }

  async write(path: string, method: 'POST' | 'PATCH', body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const args = this.args(path).map((arg) => arg === 'GET' ? method : arg);
    for (const [key, value] of Object.entries(body).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('-f', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    const raw = await this.execute(path, args);
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new GitHubLiveStateError('GH_INVALID_RESPONSE', `GitHub returned invalid JSON for ${path}.`, {
        details: { path }, cause: error,
      });
    }
  }
}
