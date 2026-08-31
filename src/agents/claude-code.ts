import type { ImplementationAgent, ImplementationRequest } from '../adapters/agent.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { AgentResult, Target } from '../domain/types.js';
import {
  NodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from '../github/transport.js';

export type ClaudeRunOptions = ProcessRunOptions;
export type ClaudeProcessRunner = ProcessRunner;

export const CLAUDE_ERROR_CODE = {
  EXIT_FAILURE: 'CLAUDE_EXIT_FAILURE',
  ERROR: 'CLAUDE_ERROR',
  TIMEOUT: 'CLAUDE_TIMEOUT',
  NOT_FOUND: 'CLAUDE_NOT_FOUND',
  EXEC_FAILURE: 'CLAUDE_EXEC_FAILURE',
  CANCELLED: 'CLAUDE_CANCELLED',
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

/** Backward-compatible name for the shared production process boundary. */
export class NodeClaudeProcessRunner extends NodeProcessRunner {}

type ClaudeOutcome =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly sessionId: string | undefined;
      readonly durationMs: number;
    }
  | { readonly ok: false; readonly agentResult: AgentResult };

interface ClaudeResultJson {
  readonly type: 'result';
  readonly session_id?: string;
  readonly result: string;
  readonly is_error: boolean;
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
  private readonly initialSessionId: string | undefined;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeClaudeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.model = options.model;
    this.allowedTools = options.allowedTools ?? DEFAULT_TOOLS;
    this.github = options.github;
    this.initialSessionId = options.sessionId;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    const sessionId = request.sessionId ?? this.initialSessionId;
    if (isAborted(request.signal)) {
      return cancelledAgentResult(0, sessionId);
    }
    const prompt = await this.buildPrompt(request);
    const outcome = await this.runClaude(
      this.buildArgs(prompt, sessionId),
      request.signal,
      sessionId,
    );
    if (!outcome.ok) return outcome.agentResult;

    if (isAborted(request.signal)) {
      return cancelledAgentResult(outcome.durationMs, outcome.sessionId);
    }
    const head = await this.readHead(request.signal);
    if (isAborted(request.signal)) {
      return cancelledAgentResult(outcome.durationMs, outcome.sessionId);
    }
    if (!head.ok) {
      return {
        exitStatus: 'failure',
        summary: outcome.summary,
        diagnostics: [`${CLAUDE_ERROR_CODE.HEAD_READ_FAILED}: could not read an exact 40-hex HEAD from ${this.cwd}.`],
        sessionId: outcome.sessionId,
        durationMs: outcome.durationMs,
      };
    }
    return {
      exitStatus: 'success',
      summary: outcome.summary,
      headSha: head.sha,
      sessionId: outcome.sessionId,
      durationMs: outcome.durationMs,
    };
  }

  private async buildPrompt(request: ImplementationRequest): Promise<string> {
    const lines = [
      'Implement the work described below in the current repository and report your completion.',
      'Run the repository-required validation and tests before reporting success; report a failure if validation does not pass.',
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

  private buildArgs(prompt: string, sessionId: string | undefined): string[] {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    if (this.allowedTools.length > 0) args.push('--allowedTools', ...this.allowedTools);
    if (this.model !== undefined) args.push('--model', this.model);
    if (sessionId !== undefined) args.push('--resume', sessionId);
    return args;
  }

  private async runClaude(
    args: readonly string[],
    signal: AbortSignal | undefined,
    resumeSessionId: string | undefined,
  ): Promise<ClaudeOutcome> {
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.runner.run('claude', args, processOptions(this.timeoutMs, this.cwd, signal));
    } catch (error) {
      const durationMs = elapsedMs(startedAt);
      const code = errorCode(error);
      if (signal?.aborted === true || code === 'ABORT_ERR') {
        return { ok: false, agentResult: cancelledAgentResult(durationMs, resumeSessionId) };
      }
      if (code === 'ETIMEDOUT') {
        return failureAgentResult(
          CLAUDE_ERROR_CODE.TIMEOUT,
          `Claude Code timed out after ${this.timeoutMs}ms.`,
          durationMs,
          resumeSessionId,
        );
      }
      if (code === 'ENOENT') {
        return failureAgentResult(
          CLAUDE_ERROR_CODE.NOT_FOUND,
          'Claude Code executable "claude" was not found.',
          durationMs,
          resumeSessionId,
        );
      }
      return failureAgentResult(
        CLAUDE_ERROR_CODE.EXEC_FAILURE,
        `Failed to run Claude Code: ${message(error)}`,
        durationMs,
        resumeSessionId,
      );
    }
    const durationMs = elapsedMs(startedAt);
    if (result.exitCode !== 0) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.EXIT_FAILURE,
        `Claude Code exited with status ${result.exitCode}.`,
        durationMs,
        resumeSessionId,
      );
    }
    const json = parseResultJson(result.stdout);
    if (json === null) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.INVALID_OUTPUT,
        'Claude Code returned invalid structured output.',
        durationMs,
        resumeSessionId,
      );
    }
    if (json.is_error === true) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.ERROR,
        `Claude Code reported an error: ${json.result}`,
        durationMs,
        json.session_id ?? resumeSessionId,
      );
    }
    return {
      ok: true,
      summary: typeof json.result === 'string' && json.result !== '' ? json.result : 'Done.',
      sessionId: json.session_id ?? resumeSessionId,
      durationMs,
    };
  }

  private async readHead(signal: AbortSignal | undefined): Promise<{ ok: true; sha: string } | { ok: false }> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], processOptions(this.timeoutMs, this.cwd, signal));
      const sha = result.stdout.trim();
      if (result.exitCode === 0 && FULL_SHA.test(sha)) return { ok: true, sha };
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

function failureAgentResult(
  code: ClaudeErrorCode,
  detail: string,
  durationMs: number,
  sessionId?: string,
): { ok: false; agentResult: AgentResult } {
  return {
    ok: false,
    agentResult: {
      exitStatus: 'failure',
      summary: detail,
      diagnostics: [`${code}: ${detail}`],
      durationMs,
      sessionId,
    },
  };
}

function parseResultJson(stdout: string): ClaudeResultJson | null {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const result = value as Record<string, unknown>;
    if (
      result.type !== 'result' ||
      typeof result.result !== 'string' ||
      result.result === '' ||
      typeof result.is_error !== 'boolean' ||
      (result.session_id !== undefined && (typeof result.session_id !== 'string' || result.session_id === ''))
    ) {
      return null;
    }
    return value as ClaudeResultJson;
  } catch {
    return null;
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function processOptions(timeoutMs: number, cwd: string, signal: AbortSignal | undefined): ProcessRunOptions {
  return signal === undefined ? { timeoutMs, cwd } : { timeoutMs, cwd, signal };
}

function cancelledAgentResult(durationMs: number, sessionId?: string): AgentResult {
  const detail = 'Claude Code execution was cancelled.';
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${CLAUDE_ERROR_CODE.CANCELLED}: ${detail}`],
    sessionId,
    durationMs,
  };
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
