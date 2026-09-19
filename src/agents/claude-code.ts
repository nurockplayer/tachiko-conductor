import {
  HUMAN_TAKEOVER_DIAGNOSTIC,
  assertWorkspaceGuard,
  normalizeMcpHttpCapabilities,
  type ImplementationAgent,
  type ImplementationRequest,
  type McpHttpCapability,
} from '../adapters/agent.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { AgentResult, ExecutorIdentity, Target } from '../domain/types.js';
import type { ProviderExecutionTelemetry } from '../domain/telemetry.js';
import {
  NodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from '../github/transport.js';
import {
  attachToolOutputTelemetry,
  providerTelemetry,
  tokenUsageFromProviderValue,
  usageContextFromTokenUsage,
} from './provider-telemetry.js';

export type ClaudeRunOptions = ProcessRunOptions;
export type ClaudeProcessRunner = ProcessRunner;

export const CLAUDE_CODE_PROVIDER = 'claude-code';

export const CLAUDE_ERROR_CODE = {
  EXIT_FAILURE: 'CLAUDE_EXIT_FAILURE',
  ERROR: 'CLAUDE_ERROR',
  TIMEOUT: 'CLAUDE_TIMEOUT',
  NOT_FOUND: 'CLAUDE_NOT_FOUND',
  EXEC_FAILURE: 'CLAUDE_EXEC_FAILURE',
  CANCELLED: 'CLAUDE_CANCELLED',
  INVALID_OUTPUT: 'CLAUDE_INVALID_OUTPUT',
  RESUME_IDENTITY_INVALID: 'CLAUDE_RESUME_IDENTITY_INVALID',
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
  /** Optional larger per-execution bounded-output budget and evidence store. */
  readonly outputPolicy?: ProcessRunOptions['outputPolicy'];
  readonly outputStore?: ProcessRunOptions['outputStore'];
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
      readonly telemetry: ProviderExecutionTelemetry;
      readonly output?: ProcessResult['output'];
    }
  | { readonly ok: false; readonly agentResult: AgentResult };

interface ClaudeResultJson {
  readonly type: 'result';
  readonly session_id?: string;
  readonly result: string;
  readonly is_error: boolean;
  readonly model?: string;
  readonly usage?: unknown;
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
  private readonly outputPolicy: ProcessRunOptions['outputPolicy'];
  private readonly outputStore: ProcessRunOptions['outputStore'];

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeClaudeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.model = options.model;
    this.allowedTools = options.allowedTools ?? DEFAULT_TOOLS;
    this.github = options.github;
    this.initialSessionId = options.sessionId;
    this.outputPolicy = options.outputPolicy;
    this.outputStore = options.outputStore;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (
      request.executor !== undefined &&
      (request.executor.provider !== CLAUDE_CODE_PROVIDER || request.executor.sessionId.trim() === '')
    ) {
      const detail = 'Claude Code continuation requires a non-empty claude-code executor identity.';
      return {
        exitStatus: 'failure',
        summary: detail,
        diagnostics: [`${CLAUDE_ERROR_CODE.RESUME_IDENTITY_INVALID}: ${detail}`],
        executor: request.executor,
        durationMs: 0,
      };
    }
    const sessionId = request.executor?.sessionId ?? request.sessionId ?? this.initialSessionId;
    if (isAborted(request.signal)) {
      return cancelledAgentResult(0, sessionId);
    }
    const prompt = await this.buildPrompt(request);
    // This awaits after all prompt/live/capability work and immediately before
    // the provider spawn, closing the prepare-to-spawn identity race.
    await assertWorkspaceGuard(request.workspaceGuard);
    const cwd = request.workspacePath ?? this.cwd;
    const outcome = await this.runClaude(
      this.buildArgs(prompt, request.capabilities, sessionId),
      request.signal,
      sessionId,
      cwd,
    );
    if (!outcome.ok) return outcome.agentResult;
    const executor = executorIdentity(outcome.sessionId);

    if (isAborted(request.signal)) {
      return cancelledAgentResult(outcome.durationMs, outcome.sessionId);
    }
    const takeoverReason = parseHumanTakeover(outcome.summary);
    if (takeoverReason !== undefined) {
      return {
        exitStatus: 'failure',
        summary: takeoverReason,
        diagnostics: [`${HUMAN_TAKEOVER_DIAGNOSTIC} ${takeoverReason}`],
        sessionId: outcome.sessionId,
        ...(executor === undefined ? {} : { executor }),
        telemetry: outcome.telemetry,
        durationMs: outcome.durationMs,
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      };
    }
    await assertWorkspaceGuard(request.workspaceGuard, 'after-execution', executor);
    const head = await this.readHead(request.signal, cwd);
    if (isAborted(request.signal)) {
      return cancelledAgentResult(outcome.durationMs, outcome.sessionId);
    }
    if (!head.ok) {
      return {
        exitStatus: 'failure',
        summary: outcome.summary,
        diagnostics: [`${CLAUDE_ERROR_CODE.HEAD_READ_FAILED}: could not read an exact 40-hex HEAD from ${this.cwd}.`],
        sessionId: outcome.sessionId,
        ...(executor === undefined ? {} : { executor }),
        telemetry: outcome.telemetry,
        durationMs: outcome.durationMs,
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      };
    }
    return {
      exitStatus: 'success',
      summary: outcome.summary,
      headSha: head.sha,
      sessionId: outcome.sessionId,
      ...(executor === undefined ? {} : { executor }),
      telemetry: outcome.telemetry,
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
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
    if ((request.capabilities?.length ?? 0) > 0) {
      lines.push(
        '',
        'Browser capability policy:',
        '- Prefer a stable API, native integration, or first-party MCP over browser automation.',
        '- The provided browser is a dedicated Tachiko profile; never inspect or copy a personal browser profile.',
        '- Authentication, 2FA, or CAPTCHA challenges require human takeover; do not bypass or guess them.',
        '- Do not perform purchase, payment, billing, account deletion, credential, or security-setting changes.',
        `- If a human boundary is reached, stop and reply exactly with "${HUMAN_TAKEOVER_DIAGNOSTIC} <reason>".`,
      );
    }
    return lines.join('\n');
  }

  private buildArgs(
    prompt: string,
    capabilities: readonly McpHttpCapability[] | undefined,
    sessionId: string | undefined,
  ): string[] {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    const mcp = buildMcpInvocation(capabilities ?? []);
    const allowedTools = [...this.allowedTools, ...mcp.allowedTools];
    if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);
    if (mcp.config !== undefined) {
      args.push('--mcp-config', JSON.stringify(mcp.config), '--strict-mcp-config');
    }
    if (this.model !== undefined) args.push('--model', this.model);
    if (sessionId !== undefined) args.push('--resume', sessionId);
    return args;
  }

  private async runClaude(
    args: readonly string[],
    signal: AbortSignal | undefined,
    resumeSessionId: string | undefined,
    cwd: string,
  ): Promise<ClaudeOutcome> {
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.runner.run('claude', args, processOptions(this.timeoutMs, cwd, signal, this.outputPolicy, this.outputStore));
    } catch (error) {
      const durationMs = elapsedMs(startedAt);
      const code = errorCode(error);
      const output = processOutput(error);
      if (signal?.aborted === true || code === 'ABORT_ERR') {
        return { ok: false, agentResult: cancelledAgentResult(durationMs, resumeSessionId, output) };
      }
      if (code === 'ETIMEDOUT') {
        return failureAgentResult(
          CLAUDE_ERROR_CODE.TIMEOUT,
          `Claude Code timed out after ${this.timeoutMs}ms.`,
          durationMs,
          resumeSessionId,
          output,
        );
      }
      if (code === 'ENOENT') {
        return failureAgentResult(
          CLAUDE_ERROR_CODE.NOT_FOUND,
          'Claude Code executable "claude" was not found.',
          durationMs,
          resumeSessionId,
          output,
        );
      }
      return failureAgentResult(
        CLAUDE_ERROR_CODE.EXEC_FAILURE,
        `Failed to run Claude Code: ${message(error)}`,
        durationMs,
        resumeSessionId,
        output,
      );
    }
    const durationMs = elapsedMs(startedAt);
    if (result.exitCode !== 0) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.EXIT_FAILURE,
        `Claude Code exited with status ${result.exitCode}.`,
        durationMs,
        resumeSessionId,
        result.output,
      );
    }
    const json = parseResultJson(result.stdout);
    if (json === null) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.INVALID_OUTPUT,
        'Claude Code returned invalid structured output.',
        durationMs,
        resumeSessionId,
        result.output,
      );
    }
    if (json.is_error === true) {
      return failureAgentResult(
        CLAUDE_ERROR_CODE.ERROR,
        `Claude Code reported an error: ${json.result}`,
        durationMs,
        json.session_id ?? resumeSessionId,
        result.output,
      );
    }
    const usage = tokenUsageFromProviderValue(json.usage);
    const context = usageContextFromTokenUsage(usage);
    const telemetry = attachToolOutputTelemetry(providerTelemetry({
      provider: CLAUDE_CODE_PROVIDER,
      ...(this.model === undefined && json.model === undefined ? {} : { model: json.model ?? this.model }),
      ...(usage === undefined ? {} : { usage }),
      ...(context === undefined ? {} : { context }),
    }), result.output);
    return {
      ok: true,
      summary: typeof json.result === 'string' && json.result !== '' ? json.result : 'Done.',
      sessionId: json.session_id ?? resumeSessionId,
      telemetry,
      ...(result.output === undefined ? {} : { output: result.output }),
      durationMs,
    };
  }

  private async readHead(signal: AbortSignal | undefined, cwd: string): Promise<{ ok: true; sha: string } | { ok: false }> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], processOptions(this.timeoutMs, cwd, signal, this.outputPolicy, this.outputStore));
      const sha = result.stdout.trim();
      if (result.exitCode === 0 && FULL_SHA.test(sha)) return { ok: true, sha };
      return { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

function buildMcpInvocation(capabilities: readonly McpHttpCapability[]): {
  readonly config?: { readonly mcpServers: Readonly<Record<string, { readonly type: 'http'; readonly url: string }>> };
  readonly allowedTools: readonly string[];
} {
  if (capabilities.length === 0) return { allowedTools: [] };
  const servers: Record<string, { type: 'http'; url: string }> = {};
  const allowedTools: string[] = [];
  for (const capability of normalizeMcpHttpCapabilities(capabilities)) {
    servers[capability.name] = { type: 'http', url: capability.endpoint };
    allowedTools.push(`mcp__${capability.name}__*`);
  }
  return { config: { mcpServers: servers }, allowedTools };
}

function failureAgentResult(
  code: ClaudeErrorCode,
  detail: string,
  durationMs: number,
  sessionId?: string,
  output?: ProcessResult['output'],
): { ok: false; agentResult: AgentResult } {
  return {
    ok: false,
    agentResult: {
      exitStatus: 'failure',
      summary: detail,
      diagnostics: [`${code}: ${detail}`],
      durationMs,
      sessionId,
      ...(executorIdentity(sessionId) === undefined ? {} : { executor: executorIdentity(sessionId) }),
      ...(output === undefined ? {} : { output }),
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
      (result.session_id !== undefined && (typeof result.session_id !== 'string' || result.session_id === '')) ||
      (result.model !== undefined && (typeof result.model !== 'string' || result.model.trim() === ''))
    ) {
      return null;
    }
    return value as ClaudeResultJson;
  } catch {
    return null;
  }
}

function parseHumanTakeover(summary: string): string | undefined {
  if (!summary.startsWith(HUMAN_TAKEOVER_DIAGNOSTIC)) return undefined;
  const reason = summary.slice(HUMAN_TAKEOVER_DIAGNOSTIC.length).trim();
  return reason === '' ? 'A human browser takeover is required.' : reason;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function processOptions(
  timeoutMs: number,
  cwd: string,
  signal: AbortSignal | undefined,
  outputPolicy: ProcessRunOptions['outputPolicy'],
  outputStore: ProcessRunOptions['outputStore'],
): ProcessRunOptions {
  return {
    timeoutMs,
    cwd,
    ...(signal === undefined ? {} : { signal }),
    ...(outputPolicy === undefined ? {} : { outputPolicy }),
    ...(outputStore === undefined ? {} : { outputStore }),
  };
}

function cancelledAgentResult(durationMs: number, sessionId?: string, output?: ProcessResult['output']): AgentResult {
  const detail = 'Claude Code execution was cancelled.';
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${CLAUDE_ERROR_CODE.CANCELLED}: ${detail}`],
    sessionId,
    ...(executorIdentity(sessionId) === undefined ? {} : { executor: executorIdentity(sessionId) }),
    ...(output === undefined ? {} : { output }),
    durationMs,
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function executorIdentity(sessionId: string | undefined): ExecutorIdentity | undefined {
  return sessionId === undefined ? undefined : { provider: CLAUDE_CODE_PROVIDER, sessionId };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processOutput(error: unknown): ProcessResult['output'] {
  return typeof error === 'object' && error !== null && 'output' in error
    ? (error as { output?: ProcessResult['output'] }).output
    : undefined;
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
