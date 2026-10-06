import { execFile, spawn, type ExecFileException } from 'node:child_process';

import {
  boundToolOutput,
  boundToolOutputFromCapture,
  ContainedToolOutputCaptureSession,
  DEFAULT_TOOL_OUTPUT_POLICY,
  type ToolOutputEnvelope,
  type ToolOutputPolicy,
  type ToolOutputCaptureSessionResult,
  type ToolOutputStore,
  type ToolOutputCaptureWriter,
} from '../evidence/tool-output.js';
import { StringDecoder } from 'node:string_decoder';
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
  /** Bounded, explicitly drillable evidence for the command transcript. */
  readonly output?: ToolOutputEnvelope;
  readonly captureStatus?: 'complete' | 'partial' | 'unavailable';
  readonly captureObservation?: Omit<ToolOutputCaptureSessionResult, 'capture'>;
}

export interface ProcessRunOptions {
  readonly timeoutMs: number;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  /** Optional UTF-8 payload for non-interactive commands that read stdin. */
  readonly stdin?: string;
  /** Optional per-command preview budget; exact exit semantics are unaffected. */
  readonly outputPolicy?: ToolOutputPolicy;
  /** Optional evidence store for explicit full/range drill-down. */
  readonly outputStore?: ToolOutputStore;
  /** Deliberately narrowed environment for an isolated implementation runtime. */
  readonly env?: NodeJS.ProcessEnv;
  /** Synchronous host check called immediately before child creation. */
  readonly beforeSpawn?: () => void;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

export interface NodeProcessRunnerOptions {
  readonly outputPolicy?: ToolOutputPolicy;
  /** @deprecated A store alone does not authorize capture; pass it per command. */
  readonly outputStore?: ToolOutputStore;
}

interface ProcessError extends ExecFileException {
  readonly killed?: boolean;
  readonly output?: ToolOutputEnvelope;
  readonly captureObservation?: Omit<ToolOutputCaptureSessionResult, 'capture'>;
  readonly captureStatus?: 'complete' | 'partial' | 'unavailable';
}

interface FinishedCapture {
  readonly output?: ToolOutputEnvelope;
  readonly stdout: string;
  readonly stderr: string;
  readonly captureStatus: 'complete' | 'partial' | 'unavailable';
  readonly captureObservation: Omit<ToolOutputCaptureSessionResult, 'capture'>;
}

function attachCapture(error: unknown, summary: FinishedCapture): unknown {
  const observation = summary.captureObservation;
  const fields = { captureStatus: summary.captureStatus, captureObservation: observation,
    ...(summary.output === undefined ? {} : { output: summary.output }) };
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try { Object.assign(error, fields); } catch { /* bounded metadata must never replace the original rejection */ }
  }
  return error;
}

function validateCapturedTimeout(timeoutMs: number | null | undefined): void {
  if (timeoutMs == null) return;
  if (!Number.isInteger(timeoutMs)) {
    throw Object.assign(new RangeError(`The value of "timeout" is out of range. It must be an integer. Received ${String(timeoutMs)}`), {
      code: 'ERR_OUT_OF_RANGE',
    });
  }
  if (timeoutMs < 0) {
    throw Object.assign(new RangeError(`The value of "timeout" is out of range. It must be >= 0. Received ${String(timeoutMs)}`), {
      code: 'ERR_OUT_OF_RANGE',
    });
  }
}

/** Production process boundary. Commands are always an executable plus args. */
export class NodeProcessRunner implements ProcessRunner {
  private readonly outputPolicy: ToolOutputPolicy | undefined;

  constructor(options: NodeProcessRunnerOptions = {}) {
    this.outputPolicy = options.outputPolicy;
  }

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    if (options.outputStore !== undefined) {
      validateCapturedTimeout(options.timeoutMs);
      return await this.runCaptured(file, args, options);
    }
    return await new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let stdinError: unknown;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };
      options.beforeSpawn?.();
      const child = execFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          cwd: options.cwd,
          ...(options.env === undefined ? {} : { env: options.env }),
          signal: options.signal,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error: ProcessError | null, stdout: string, stderr: string) => {
          if (error === null) {
            if (stdinError !== undefined) {
              finish(() => reject(stdinError));
              return;
            }
            finish(() => resolve(this.result(stdout, stderr, 0, options)));
            return;
          }
          if (options.signal?.aborted === true) {
            const output = this.output(stdout, stderr, 'cancelled', null, options);
            finish(() => reject(Object.assign(new Error(`Command ${file} was cancelled.`), {
              code: 'ABORT_ERR',
              ...(output === undefined ? {} : { output }),
            })));
            return;
          }
          if (error.killed) {
            const output = this.output(stdout, stderr, 'timed_out', null, options);
            finish(() => reject(Object.assign(new Error(`Command ${file} timed out after ${options.timeoutMs}ms.`), {
              code: 'ETIMEDOUT',
              ...(output === undefined ? {} : { output }),
            })));
            return;
          }
          if (typeof error.code === 'number') {
            const exitCode = error.code;
            finish(() => resolve(this.result(stdout, stderr, exitCode, options)));
            return;
          }
          // execFile aborts with ERR_CHILD_PROCESS_STDIO_MAXBUFFER once its
          // safety cap is reached. Preserve the partial transcript as an
          // explicit capture-truncated artifact instead of dropping the only
          // failure evidence available to the caller.
          const captureTruncated = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const output = this.output(stdout, stderr, captureTruncated ? 'failed' : 'unknown', null, options, captureTruncated);
          finish(() => reject(Object.assign(error, output === undefined ? {} : { output })));
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

  /** Explicit evidence capture uses streaming pipes; ordinary/provider runs keep execFile semantics. */
  private async runCaptured(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    const policy = options.outputPolicy ?? this.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY;
    const session = new ContainedToolOutputCaptureSession(policy);
    let writer: ToolOutputCaptureWriter | undefined;
    try { writer = options.outputStore!.startCapture(policy); } catch { writer = undefined; }
    if (options.signal?.aborted === true) {
      try { writer?.abort?.(); } catch { /* preserve the pre-aborted child truth */ }
      throw attachCapture(Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR' }), this.finishCapture(undefined, session, 'cancelled', null, policy));
    }
    // Preserve the main admission fence: capture setup is complete before this
    // synchronous callback, with no await between it and child creation.
    let child: ReturnType<typeof spawn>;
    try {
      options.beforeSpawn?.();
      child = spawn(file, [...args], {
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      try { writer?.abort?.(); } catch { /* admission/spawn refusal remains authoritative */ }
      throw attachCapture(error, this.finishCapture(undefined, session, 'unknown', null, policy));
    }
    return await new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let directExitObserved = false;
      let childSpawned = false;
      let stdoutNaturalEof = child.stdout === null;
      let stderrNaturalEof = child.stderr === null;
      let captureForcedIncomplete = false;
      let writerAborted = false;
      let stdinError: unknown;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const kill = (): boolean => {
        if (settled || !childSpawned || directExitObserved || !Number.isSafeInteger(child.pid) || child.pid! <= 0) return false;
        try { return child.kill('SIGTERM'); }
        catch (error) {
          // Match child_process.execFile's treatment of a kill failure as a
          // process error, while keeping it on the contained event path.
          queueMicrotask(() => { if (!settled) child.emit('error', error as Error); });
          return false;
        }
      };
      const abandonWriter = (): void => {
        if (captureForcedIncomplete) return;
        captureForcedIncomplete = true;
        if (!writerAborted && writer !== undefined) {
          writerAborted = true;
          try { writer.abort?.(); } catch { /* forced pipe closure cannot escape */ }
        }
      };
      const closeUnfinishedPipes = (): void => {
        if (stdoutNaturalEof && stderrNaturalEof) return;
        abandonWriter();
        if (!stdoutNaturalEof) { try { child.stdout?.destroy(); } catch { /* settlement continues */ } }
        if (!stderrNaturalEof) { try { child.stderr?.destroy(); } catch { /* settlement continues */ } }
      };
      const capture = (channel: 'stdout' | 'stderr', chunk: Buffer, decoder: StringDecoder): void => {
        const text = decoder.write(chunk);
        if (text !== '') session.write(captureForcedIncomplete ? undefined : writer, channel, text);
      };
      child.stdout?.on('data', (chunk: Buffer) => capture('stdout', chunk, stdoutDecoder));
      child.stderr?.on('data', (chunk: Buffer) => capture('stderr', chunk, stderrDecoder));
      child.stdout?.once('end', () => { stdoutNaturalEof = true; });
      child.stderr?.once('end', () => { stderrNaturalEof = true; });
      child.stdin?.on('error', (error) => { stdinError ??= error; });
      child.once('spawn', () => {
        childSpawned = true;
        if (options.signal?.aborted === true) onAbort();
      });
      child.once('exit', () => { directExitObserved = true; });
      child.once('error', (error) => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        const aborted = options.signal?.aborted === true;
        if (childSpawned) closeUnfinishedPipes();
        else { try { writer?.abort?.(); } catch { /* spawn failure remains authoritative */ } }
        const summary = this.finishCapture(childSpawned ? writer : undefined, session, aborted ? 'cancelled' : 'unknown', null, policy, captureForcedIncomplete);
        const reported = aborted ? Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR' }) : error;
        reject(attachCapture(reported, summary));
      });
      child.once('close', (rawCode, signal) => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        const stdoutFinal = stdoutDecoder.end();
        const stderrFinal = stderrDecoder.end();
        if (stdoutFinal !== '') session.write(captureForcedIncomplete ? undefined : writer, 'stdout', stdoutFinal);
        if (stderrFinal !== '') session.write(captureForcedIncomplete ? undefined : writer, 'stderr', stderrFinal);
        const exitCode = typeof rawCode === 'number' ? rawCode : null;
        const cleanZeroExit = exitCode === 0 && signal === null;
        const cancelledError = cancelled || (!cleanZeroExit && options.signal?.aborted === true);
        const timedOutError = !cleanZeroExit && timedOut;
        const outcome = cancelledError ? 'cancelled' : timedOutError ? 'timed_out' : signal !== null || exitCode === null ? 'unknown' : exitCode !== 0 || stdinError !== undefined ? 'failed' : 'passed';
        const summary = this.finishCapture(writer, session, outcome, exitCode, policy, captureForcedIncomplete);
        if (cancelledError) {
          reject(attachCapture(Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR' }), summary));
        } else if (timedOutError) {
          reject(attachCapture(Object.assign(new Error(`Command ${file} timed out after ${options.timeoutMs}ms.`), { code: 'ETIMEDOUT' }), summary));
        } else if (signal !== null) {
          reject(attachCapture(Object.assign(new Error(`Command ${file} terminated by signal ${signal}.`), { code: null, signal }), summary));
        } else if (exitCode !== null && exitCode !== 0) {
          resolve({ stdout: summary.stdout, stderr: summary.stderr, exitCode, ...(summary.output === undefined ? {} : { output: summary.output }), captureStatus: summary.captureStatus, captureObservation: summary.captureObservation });
        } else if (stdinError !== undefined) {
          reject(attachCapture(stdinError, summary));
        } else {
          if (exitCode === null) reject(attachCapture(Object.assign(new Error(`Command ${file} closed without an exit code.`), { code: null, signal }), summary));
          else resolve({ stdout: summary.stdout, stderr: summary.stderr, exitCode, ...(summary.output === undefined ? {} : { output: summary.output }), captureStatus: summary.captureStatus, captureObservation: summary.captureObservation });
        }
      });
      if (options.timeoutMs != null && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          closeUnfinishedPipes();
          kill();
        }, options.timeoutMs);
      }
      const onAbort = (): void => {
        // AbortSignal intent after direct exit does not change its child truth.
        if (directExitObserved) return;
        if (kill()) {
          cancelled = true;
          closeUnfinishedPipes();
          // execFile treats a successful abort kill as an immediate process
          // error. Do not wait for a SIGTERM handler that can keep the child
          // alive; incomplete streams have already been closed and purged.
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          const stdoutFinal = stdoutDecoder.end();
          const stderrFinal = stderrDecoder.end();
          if (stdoutFinal !== '') session.write(captureForcedIncomplete ? undefined : writer, 'stdout', stdoutFinal);
          if (stderrFinal !== '') session.write(captureForcedIncomplete ? undefined : writer, 'stderr', stderrFinal);
          const summary = this.finishCapture(writer, session, 'cancelled', null, policy, captureForcedIncomplete);
          reject(attachCapture(Object.assign(new Error(`Command ${file} was cancelled.`), { code: 'ABORT_ERR' }), summary));
        }
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();
      try { child.stdin?.end(options.stdin); } catch (error) { stdinError ??= error; }
    });
  }

  private finishCapture(
    writer: ToolOutputCaptureWriter | undefined,
    session: ContainedToolOutputCaptureSession,
    outcome: ToolOutputEnvelope['outcome'] = 'unknown',
    exitCode: number | null = null,
    policy: ToolOutputPolicy = DEFAULT_TOOL_OUTPUT_POLICY,
    forcedIncomplete = false,
  ): FinishedCapture {
    const result = session.finish(forcedIncomplete ? undefined : writer);
    const status = forcedIncomplete && writer !== undefined ? 'partial' : result.status;
    const captureObservation = { status, stdout: result.stdout, stderr: result.stderr,
      diagnostics: result.diagnostics, diagnosticsTruncated: result.diagnosticsTruncated } as const;
    if (!forcedIncomplete && result.status === 'complete' && result.capture !== undefined) {
      return {
        output: boundToolOutputFromCapture({ outcome, exitCode, capture: result.capture, policy }),
        stdout: result.stdout.preview,
        stderr: result.stderr.preview,
        captureStatus: status,
        captureObservation,
      };
    }
    return { stdout: result.stdout.preview, stderr: result.stderr.preview, captureStatus: status, captureObservation };
  }

  private result(stdout: string, stderr: string, exitCode: number, options: ProcessRunOptions): ProcessResult {
    const output = this.output(stdout, stderr, exitCode === 0 ? 'passed' : 'failed', exitCode, options);
    return {
      stdout,
      stderr,
      exitCode,
      ...(output === undefined ? {} : { output }),
    };
  }

  private output(
    stdout: string,
    stderr: string,
    outcome: ToolOutputEnvelope['outcome'],
    exitCode: number | null,
    options: ProcessRunOptions,
    captureTruncated = false,
  ): ToolOutputEnvelope | undefined {
    const store = options.outputStore;
    if (store === undefined) return undefined;
    return boundToolOutput({
      outcome,
      exitCode,
      stdout,
      stderr,
      store,
      policy: options.outputPolicy ?? this.outputPolicy ?? DEFAULT_TOOL_OUTPUT_POLICY,
      captureTruncated,
    });
  }
}

export interface GhCliTransportOptions {
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly outputPolicy?: ToolOutputPolicy;
  /** @deprecated Parser transcripts remain transient; this store is ignored. */
  readonly outputStore?: ToolOutputStore;
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
  // Classification remains based on the complete machine-readable transcript;
  // the bounded envelope is supplemental evidence, never authority.
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
  private readonly outputPolicy: ToolOutputPolicy | undefined;

  constructor(options: GhCliTransportOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.outputPolicy = options.outputPolicy;
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
      result = await this.runner.run('gh', args, {
        timeoutMs: this.timeoutMs,
        ...(this.outputPolicy === undefined ? {} : { outputPolicy: this.outputPolicy }),
      });
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
