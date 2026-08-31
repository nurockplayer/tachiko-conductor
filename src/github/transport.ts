import { execFile, type ExecFileException } from 'node:child_process';

import { GitHubLiveStateError } from './errors.js';

export interface GitHubApiTransport {
  get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown>;
  getPaginated(path: string, query?: Readonly<Record<string, string>>): Promise<readonly unknown[]>;
  /** Read a non-JSON GitHub media representation, such as a complete PR diff. */
  getRaw?(path: string, accept: string): Promise<string>;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult>;
}

interface ProcessError extends ExecFileException {
  readonly killed?: boolean;
}

/** Production process boundary. Commands are always an executable plus args. */
export class NodeProcessRunner implements ProcessRunner {
  async run(file: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve, reject) => {
      execFile(
        file,
        [...args],
        { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error: ProcessError | null, stdout: string, stderr: string) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          if (error.killed) {
            reject(Object.assign(new Error(`Command ${file} timed out after ${timeoutMs}ms.`), { code: 'ETIMEDOUT' }));
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ stdout, stderr, exitCode: error.code });
            return;
          }
          reject(error);
        },
      );
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
      result = await this.runner.run('gh', args, this.timeoutMs);
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

  async getRaw(path: string, accept: string): Promise<string> {
    return await this.execute(path, this.args(path, {}, accept));
  }
}
