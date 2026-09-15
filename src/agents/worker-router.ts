import { homedir } from 'node:os';
import path from 'node:path';

import { assertWorkspaceGuard, type ImplementationAgent, type ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';
import { NodeProcessRunner, type ProcessRunner, type ProcessResult, type ProcessRunOptions } from '../github/transport.js';

export const WORKER_ROUTER_PROVIDER = 'worker-router';
export const WORKER_ROUTER_DEFAULT_EXECUTABLE = `${homedir()}/.local/bin/worker-router`;
export const WORKER_ROUTER_EXECUTABLE_ENV = 'TACHIKO_WORKER_ROUTER_PATH';

export const WORKER_ROUTER_ERROR_CODE = {
  EXIT_FAILURE: 'WORKER_ROUTER_EXIT_FAILURE',
  TIMEOUT: 'WORKER_ROUTER_TIMEOUT',
  NOT_FOUND: 'WORKER_ROUTER_NOT_FOUND',
  EXEC_FAILURE: 'WORKER_ROUTER_EXEC_FAILURE',
  CANCELLED: 'WORKER_ROUTER_CANCELLED',
  HEAD_READ_FAILED: 'WORKER_ROUTER_HEAD_READ_FAILED',
} as const;

const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_DIAGNOSTIC_LENGTH = 2_000;

export interface WorkerRouterAdapterOptions {
  readonly runner?: ProcessRunner;
  readonly executable?: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** Stateless implementation adapter for the local worker-router executable. */
export class WorkerRouterAdapter implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly runner: ProcessRunner;
  private readonly executable: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(options: WorkerRouterAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    const env = options.env ?? process.env;
    const executable = options.executable ?? env[WORKER_ROUTER_EXECUTABLE_ENV] ?? WORKER_ROUTER_DEFAULT_EXECUTABLE;
    if (executable.trim() === '' || !path.isAbsolute(executable)) {
      throw new Error(`${WORKER_ROUTER_EXECUTABLE_ENV} / worker-router executable must be an absolute non-empty path.`);
    }
    this.executable = executable;
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', 0);
    const cwd = request.workspacePath ?? this.cwd;
    const task = buildTask(request);
    await assertWorkspaceGuard(request.workspaceGuard);
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.runner.run(this.executable, [], this.options(request.signal, cwd, task));
    } catch (error) {
      const durationMs = elapsed(startedAt);
      const code = errorCode(error);
      if (isAborted(request.signal) || code === 'ABORT_ERR') return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', durationMs);
      if (code === 'ETIMEDOUT') return failure(WORKER_ROUTER_ERROR_CODE.TIMEOUT, `Worker router timed out after ${this.timeoutMs}ms.`, durationMs);
      if (code === 'ENOENT') return failure(WORKER_ROUTER_ERROR_CODE.NOT_FOUND, `Worker router executable "${this.executable}" was not found.`, durationMs);
      return failure(WORKER_ROUTER_ERROR_CODE.EXEC_FAILURE, `Failed to run worker router: ${errorMessage(error)}`, durationMs);
    }
    const durationMs = elapsed(startedAt);
    const provenance = workerProvenance(result.stderr);
    const diagnostics = boundedDiagnostics(result.stderr, result.stdout, provenance);
    if (result.exitCode !== 0) return { ...failure(WORKER_ROUTER_ERROR_CODE.EXIT_FAILURE, `Worker router exited with status ${result.exitCode}.`, durationMs), diagnostics: [`${WORKER_ROUTER_ERROR_CODE.EXIT_FAILURE}: Worker router exited with status ${result.exitCode}.`, ...diagnostics] };
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', durationMs);
    await assertWorkspaceGuard(request.workspaceGuard, 'after-execution');
    const head = await this.readHead(request.signal, cwd);
    if (isAborted(request.signal)) return failure(WORKER_ROUTER_ERROR_CODE.CANCELLED, 'Worker router was cancelled.', durationMs);
    if (head === null) return { ...failure(WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED, `Worker router completed, but an exact 40-hex HEAD could not be read from ${cwd}.`, durationMs), diagnostics: [`${WORKER_ROUTER_ERROR_CODE.HEAD_READ_FAILED}: could not read an exact 40-hex HEAD from ${cwd}.`, ...diagnostics] };
    return { exitStatus: 'success', summary: 'Worker router completed implementation.', headSha: head, ...(diagnostics.length === 0 ? {} : { diagnostics }), durationMs };
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
    'Commit all in-scope changes and push the current branch before reporting success; report blockers if either operation cannot be completed.',
    'Return blockers instead of guessing.',
    request.authority === 'live-target' ? request.supplementalInstructions : request.instructions,
  ].filter((line): line is string => line !== undefined && line !== '').join('\n') + '\n';
}

function workerProvenance(stderr: string): string | undefined {
  const match = stderr.match(/^\[worker-router\] -> (luna-worker|deepseek-worker)\s*$/m);
  return match?.[0];
}

function boundedDiagnostics(stderr: string, stdout: string, provenance: string | undefined): string[] {
  const details = [provenance, stderr.trim(), stdout.trim()].filter((value): value is string => value !== undefined && value !== '');
  return details.map((value) => value.length > MAX_DIAGNOSTIC_LENGTH ? `${value.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : value);
}

function failure(code: string, summary: string, durationMs: number): AgentResult { return { exitStatus: 'failure', summary, diagnostics: [`${code}: ${summary}`], durationMs }; }
function elapsed(startedAt: number): number { return Math.max(0, Date.now() - startedAt); }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }
