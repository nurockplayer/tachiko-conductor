import { execFile, type ExecFileException } from 'node:child_process';

import type { ImplementationAgent, ImplementationRequest } from '../adapters/agent.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { AgentResult, Target } from '../domain/types.js';
import type { ProcessResult } from '../github/transport.js';

export interface ClaudeRunOptions {
  readonly timeoutMs: number;
  readonly cwd: string;
}

export interface ClaudeProcessRunner {
  run(file: string, args: readonly string[], options: ClaudeRunOptions): Promise<ProcessResult>;
}

export const CLAUDE_ERROR_CODE = {
  EXIT_FAILURE: 'CLAUDE_EXIT_FAILURE',
  ERROR: 'CLAUDE_ERROR',
  TIMEOUT: 'CLAUDE_TIMEOUT',
  NOT_FOUND: 'CLAUDE_NOT_FOUND',
  EXEC_FAILURE: 'CLAUDE_EXEC_FAILURE',
  INVALID_OUTPUT: 'CLAUDE_INVALID_OUTPUT',
  HEAD_READ_FAILED: 'HEAD_READ_FAILED',
} as const;

export type ClaudeErrorCode = (typeof CLAUDE_ERROR_CODE)[keyof typeof CLAUDE_ERROR_CODE];

export interface ClaudeCodeAdapterOptions {
  readonly runner?: ClaudeProcessRunner;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly github?: GitHubAdapter;
  readonly sessionId?: string;
}

const DEFAULT_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'Bash'];
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Production process boundary for the Claude Code CLI and local git reads. */
export class NodeClaudeProcessRunner implements ClaudeProcessRunner {
  async run(file: string, args: readonly string[], options: ClaudeRunOptions): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve, reject) => {
      execFile(
        file,
        [...args],
        { encoding: 'utf8', timeout: options.timeoutMs, cwd: options.cwd, maxBuffer: 64 * 1024 * 1024 },
        (error: ExecFileException | null, stdout: string, stderr: string) => {
          if (error === null) {
            resolve({ stdout, stderr, exitCode: 0 });
            return;
          }
          if (error.killed) {
            reject(Object.assign(new Error(`${file} timed out after ${options.timeoutMs}ms.`), { code: 'ETIMEDOUT' }));
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

type ClaudeOutcome =
  | { readonly ok: true; readonly summary: string; readonly sessionId: string | undefined }
  | { readonly ok: false; readonly agentResult: AgentResult };

interface ClaudeResultJson {
  readonly type?: string;
  readonly session_id?: string;
  readonly result?: unknown;
  readonly is_error?: boolean;
}

/**
 * Non-interactive Claude Code implementation agent. Executes `claude -p` with
 * an argument array, converts every outcome into a typed AgentResult, and
 * never returns unstructured terminal text. GitHub live state is optional
 * context for the prompt and can never override the post-run git HEAD.
 */
export class ClaudeCodeAdapter implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly runner: ClaudeProcessRunner;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly model: string | undefined;
  private readonly allowedTools: readonly string[];
  private readonly github: GitHubAdapter | undefined;
  private sessionId: string | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeClaudeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.model = options.model;
    this.allowedTools = options.allowedTools ?? DEFAULT_TOOLS;
    this.github = options.github;
    this.sessionId = options.sessionId;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    const prompt = await this.buildPrompt(request);
    const outcome = await this.runClaude(this.buildArgs(prompt));
    if (!outcome.ok) return outcome.agentResult;

    this.sessionId = outcome.sessionId;
    const head = await this.readHead();
    if (!head.ok) {
      return {
        exitStatus: 'failure',
        summary: outcome.summary,
        diagnostics: [`${CLAUDE_ERROR_CODE.HEAD_READ_FAILED}: could not read an exact 40-hex HEAD from ${this.cwd}.`],
      };
    }
    return { exitStatus: 'success', summary: outcome.summary, headSha: head.sha };
  }

  private async buildPrompt(request: ImplementationRequest): Promise<string> {
    const lines = [
      'Implement the work described below in the current repository and report your completion.',
      '',
      `Target: ${formatTarget(request.target)}`,
      `Base SHA: ${request.baseSha}`,
    ];
    if (this.github !== undefined && request.target.kind === 'issue') {
      try {
        const snapshot = await this.github.readLiveSnapshot(request.target);
        lines.push('', 'Live GitHub state:', renderLiveState(snapshot));
      } catch {
        lines.push('', 'Live GitHub state: unavailable');
      }
    }
    if (request.instructions !== undefined && request.instructions !== '') {
      lines.push('', 'Instructions:', request.instructions);
    }
    return lines.join('\n');
  }

  private buildArgs(prompt: string): string[] {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    if (this.allowedTools.length > 0) args.push('--allowedTools', ...this.allowedTools);
    if (this.model !== undefined) args.push('--model', this.model);
    if (this.sessionId !== undefined) args.push('--resume', this.sessionId);
    return args;
  }

  private async runClaude(args: readonly string[]): Promise<ClaudeOutcome> {
    let result: ProcessResult;
    try {
      result = await this.runner.run('claude', args, { timeoutMs: this.timeoutMs, cwd: this.cwd });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ETIMEDOUT') {
        return failureAgentResult(CLAUDE_ERROR_CODE.TIMEOUT, `Claude Code timed out after ${this.timeoutMs}ms.`);
      }
      if (code === 'ENOENT') {
        return failureAgentResult(CLAUDE_ERROR_CODE.NOT_FOUND, 'Claude Code executable "claude" was not found.');
      }
      return failureAgentResult(CLAUDE_ERROR_CODE.EXEC_FAILURE, `Failed to run Claude Code: ${message(error)}`);
    }
    if (result.exitCode !== 0) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.EXIT_FAILURE,
        `Claude Code exited with ${result.exitCode}: ${`${result.stderr}\n${result.stdout}`.trim()}`,
      );
    }
    const json = parseResultJson(result.stdout);
    if (json === null) {
      return failureAgentResult(CLAUDE_ERROR_CODE.INVALID_OUTPUT, 'Claude Code returned invalid JSON output.');
    }
    if (json.is_error === true) {
      return failureAgentResult(CLAUDE_ERROR_CODE.ERROR, `Claude Code reported an error: ${String(json.result ?? '')}`);
    }
    return {
      ok: true,
      summary: typeof json.result === 'string' && json.result !== '' ? json.result : 'Done.',
      sessionId: typeof json.session_id === 'string' && json.session_id !== '' ? json.session_id : undefined,
    };
  }

  private async readHead(): Promise<{ ok: true; sha: string } | { ok: false }> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], {
        timeoutMs: this.timeoutMs,
        cwd: this.cwd,
      });
      const sha = result.stdout.trim();
      if (result.exitCode === 0 && FULL_SHA.test(sha)) return { ok: true, sha };
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

function failureAgentResult(code: ClaudeErrorCode, detail: string): { ok: false; agentResult: AgentResult } {
  return {
    ok: false,
    agentResult: {
      exitStatus: 'failure',
      summary: detail,
      diagnostics: [`${code}: ${detail}`],
    },
  };
}

function parseResultJson(stdout: string): ClaudeResultJson | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    return value as ClaudeResultJson;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTarget(target: Target): string {
  if (target.kind === 'issue') return `${target.owner}/${target.repo}#${target.issueNumber}`;
  return `${target.owner}/${target.repo}@${target.branch}`;
}

function renderLiveState(snapshot: import('../adapters/github.js').GitHubLiveSnapshot): string {
  const lines = [
    `Issue: ${snapshot.issue.number} (${snapshot.issue.state}) — ${snapshot.issue.title}`,
    `Pull request: ${snapshot.pullRequest?.number ?? 'none'} at ${snapshot.headSha ?? 'no HEAD'}`,
    `Checks: ${snapshot.checks.overall}`,
    `Review: ${snapshot.reviews.decision}`,
    `Handoff: ${snapshot.handoff?.freshness ?? 'none'}`,
  ];
  return lines.join('\n');
}
