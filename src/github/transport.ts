import { execFile, type ExecFileException } from 'node:child_process';

import { GitHubLiveStateError, GitHubMergeBindingError, type MergeBindingStage } from './errors.js';

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
  write(path: string, method: 'POST' | 'PATCH' | 'PUT', body: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
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
  /** Short host-owned serialized child-creation boundary; never held while awaiting the child. */
  readonly withSpawnBoundary?: <T>(operation: () => T) => T;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult>;
}

interface ProcessError extends ExecFileException {
  readonly killed?: boolean;
}

/** Production process boundary. Commands are always an executable plus args. */
export class NodeProcessRunner implements ProcessRunner {
  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
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
      const createChild = () => {
      options.beforeSpawn?.();
      return execFile(
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
      };
      const child = options.withSpawnBoundary ? options.withSpawnBoundary(createChild) : createChild();
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
}

export interface GhCliTransportOptions {
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly executable?: string;
  readonly hostname?: string;
  readonly acceptedActorId?: string;
  readonly beforeMerge?: () => void;
  readonly repository?: { readonly owner: string; readonly repo: string };
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly beforeSpawn?: () => void;
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

  constructor(private readonly options: GhCliTransportOptions = {}) {
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

  private async execute(path: string, args: readonly string[], privateEnv?: NodeJS.ProcessEnv, bindingStage: MergeBindingStage = 'actor'): Promise<string> {
    let checkingAuthority=false;
    let result: ProcessResult;
    try {
      const scope = this.options.repository;
      if (scope) {
        const prefix = `repos/${scope.owner}/${scope.repo}`;
        const graphqlScope = path === 'graphql' && args.includes(`owner=${scope.owner}`) && args.includes(`repo=${scope.repo}`);
        if (path !== 'user' && path !== prefix && !path.startsWith(`${prefix}/`) && !graphqlScope) throw new Error('GitHub target is outside the accepted installation repository.');
      }
      result = await this.runner.run(this.options.executable ?? 'gh', this.options.hostname ? [args[0]!, '--hostname', this.options.hostname, ...args.slice(1)] : args, { timeoutMs: this.timeoutMs, cwd: this.options.cwd, env: privateEnv ?? this.options.env, beforeSpawn: () => { checkingAuthority=true; this.options.beforeSpawn?.(); if (privateEnv !== undefined || args.includes('PUT') && args.some(a => /\/pulls\/[0-9]+\/merge$/.test(a))) this.options.beforeMerge?.(); checkingAuthority=false; } });
    } catch (error) {
      if(privateEnv !== undefined)throw new GitHubMergeBindingError(checkingAuthority?'authority':bindingStage);
      throw mapThrownError(error, path);
    }
    if (result.exitCode !== 0) { if(privateEnv !== undefined)throw new GitHubMergeBindingError(bindingStage);throw mapCommandFailure(result, path); }
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

  /** One original-namespace selection, private to this single merge operation. */
  private async boundMerge(path: string, args: readonly string[]): Promise<unknown> {
    let token:string|undefined;let privateEnv:NodeJS.ProcessEnv|undefined;let captured:ProcessResult|undefined;
    try {
      const scope=this.options.repository;if(scope&&!path.startsWith(`repos/${scope.owner}/${scope.repo}/`))throw new GitHubMergeBindingError('authority');
      if(this.options.hostname!=='github.com'||!this.options.env?.GH_CONFIG_DIR?.startsWith('/')||(!(/^[1-9][0-9]*$/).test(this.options.acceptedActorId??'')||!Number.isSafeInteger(Number(this.options.acceptedActorId))||String(Number(this.options.acceptedActorId))!==this.options.acceptedActorId))throw new GitHubMergeBindingError('capture');
      const keys=new Set(['HOME','PATH','LANG','LC_ALL','GH_CONFIG_DIR']);
      const captureEnv=Object.freeze({...Object.fromEntries(Object.entries(this.options.env).filter(([key])=>keys.has(key))),GH_HOST:'github.com',GH_PROMPT_DISABLED:'1'});
      let checkingAuthority=false;
      try {
        captured=await this.runner.run(this.options.executable??'gh',['auth','token','--hostname','github.com'],{timeoutMs:this.timeoutMs,cwd:this.options.cwd,env:captureEnv,beforeSpawn:()=>{checkingAuthority=true;this.options.beforeSpawn?.();this.options.beforeMerge?.();checkingAuthority=false;}});
      }catch { throw new GitHubMergeBindingError(checkingAuthority?'authority':'capture'); }
      if(captured.exitCode!==0)throw new GitHubMergeBindingError('capture');
      token=typeof captured.stdout==='string'?captured.stdout.replace(/\r?\n$/,''):'';
      captured=undefined;
      if(token.length===0||token.length>8192||!(/^[A-Za-z0-9._~+/-]+=*$/).test(token))throw new GitHubMergeBindingError('capture-output');
      privateEnv=Object.freeze({...captureEnv,GH_TOKEN:token});
      const actorRaw=await this.execute('user',this.args('user'),privateEnv,'actor');
      let actor:unknown;try{actor=JSON.parse(actorRaw);}catch{throw new GitHubMergeBindingError('actor-response');}
      const id=typeof actor==='object'&&actor!==null?(actor as {id?:unknown}).id:undefined;
      if(typeof id!=='number'||!Number.isSafeInteger(id)||id<=0)throw new GitHubMergeBindingError('actor-response');
      if(String(id)!==this.options.acceptedActorId)throw new GitHubMergeBindingError('actor-mismatch');
      const response=await this.execute(path,args,privateEnv,'merge-request');
      try{return JSON.parse(response) as unknown;}catch{throw new GitHubMergeBindingError('merge-response');}
    } finally { captured=undefined;token=undefined;privateEnv=undefined; }
  }

  async write(path: string, method: 'POST' | 'PATCH' | 'PUT', body: Readonly<Record<string, unknown>>): Promise<unknown> {
    const args = this.args(path).map((arg) => arg === 'GET' ? method : arg);
    for (const [key, value] of Object.entries(body).sort(([a], [b]) => a.localeCompare(b))) {
      args.push('-f', `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
    if(method==='PUT'&&/\/pulls\/[0-9]+\/merge$/.test(path)&&this.options.acceptedActorId!==undefined)return await this.boundMerge(path,args);
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
