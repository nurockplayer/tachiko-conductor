import {
  HUMAN_TAKEOVER_DIAGNOSTIC,
  assertWorkspaceGuard,
  normalizeMcpHttpCapabilities,
  type ImplementationAgent,
  type ImplementationRequest,
  type McpHttpCapability,
} from '../adapters/agent.js';
import type { AgentResult, ExecutorIdentity, Target } from '../domain/types.js';
import type { ProviderExecutionTelemetry, ProviderTokenUsage } from '../domain/telemetry.js';
import {
  isExecutionConfigurationError,
  normalizeReasoningEffort,
  type ExecutionConfigurationError,
  type ExecutionReasoningEffort,
} from '../execution-profiles.js';
import {
  codexFallbackCapabilityCatalog,
  preflightModelEffort,
  type ModelCapabilityCatalog,
  type ModelEffortPreflightResult,
} from './model-capability.js';
import {
  capabilityTelemetry,
  maximumBytes,
  mergeTokenUsage,
  providerTelemetry,
  tokenUsageFromProviderValue,
  toolResultBytesFromItem,
} from './provider-telemetry.js';
import {
  NodeProcessRunner,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from '../github/transport.js';

export const CODEX_CLI_PROVIDER = 'codex-cli';

export const CODEX_ERROR_CODE = {
  EXIT_FAILURE: 'CODEX_EXIT_FAILURE',
  RESUME_FAILED: 'CODEX_RESUME_FAILED',
  ERROR: 'CODEX_ERROR',
  TIMEOUT: 'CODEX_TIMEOUT',
  NOT_FOUND: 'CODEX_NOT_FOUND',
  EXEC_FAILURE: 'CODEX_EXEC_FAILURE',
  CANCELLED: 'CODEX_CANCELLED',
  INVALID_OUTPUT: 'CODEX_INVALID_OUTPUT',
  RESUME_IDENTITY_INVALID: 'CODEX_RESUME_IDENTITY_INVALID',
  RESUME_IDENTITY_MISMATCH: 'CODEX_RESUME_IDENTITY_MISMATCH',
  HEAD_READ_FAILED: 'HEAD_READ_FAILED',
} as const;

export type CodexErrorCode = (typeof CODEX_ERROR_CODE)[keyof typeof CODEX_ERROR_CODE];

export interface CodexCliAdapterOptions {
  readonly runner?: ProcessRunner;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly reasoningEffort?: ExecutionReasoningEffort;
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Provider-boundary capability source; defaults to the versioned Codex fallback. */
  readonly capabilityCatalog?: ModelCapabilityCatalog;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

interface CodexOutcome {
  readonly summary: string;
  readonly executor: ExecutorIdentity;
  readonly telemetry: ProviderExecutionTelemetry;
}

type ParsedCodexOutput =
  | { readonly ok: true; readonly outcome: CodexOutcome }
  | { readonly ok: false; readonly code: CodexErrorCode; readonly detail: string; readonly telemetry?: ProviderExecutionTelemetry };

/**
 * Non-interactive Codex CLI implementation agent. Fresh runs use
 * `codex exec --json`; continuation uses the explicit persisted thread id via
 * `codex exec resume` and never falls back to a fresh executor.
 */
export class CodexCliAdapter implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly runner: ProcessRunner;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly model: string | undefined;
  private readonly reasoningEffort: CodexCliAdapterOptions['reasoningEffort'];
  private readonly sandboxMode: CodexCliAdapterOptions['sandboxMode'];
  private readonly approvalPolicy: CodexCliAdapterOptions['approvalPolicy'];
  private readonly capabilityCatalog: ModelCapabilityCatalog;

  constructor(options: CodexCliAdapterOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.sandboxMode = options.sandboxMode;
    this.approvalPolicy = options.approvalPolicy;
    this.capabilityCatalog = options.capabilityCatalog ?? codexFallbackCapabilityCatalog();
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    const executor = request.executor;
    if (executor !== undefined && !isUsableCodexExecutor(executor)) {
      return failureAgentResult(
        CODEX_ERROR_CODE.RESUME_IDENTITY_INVALID,
        'Codex continuation requires a non-empty codex-cli executor identity.',
        0,
        executor,
      );
    }
    // Normalize and validate the exact model/effort pair before any Codex
    // process exists, so an unsupported configuration starts zero model turns.
    let preflight: ModelEffortPreflightResult;
    try {
      preflight = this.preflightConfiguration();
    } catch (error) {
      if (isExecutionConfigurationError(error)) {
        return executionConfigurationFailure(error, executor);
      }
      throw error;
    }
    if (isAborted(request.signal)) return cancelledAgentResult(0, executor);
    const capability = capabilityTelemetry(preflight);

    const prompt = buildPrompt(request);
    await assertWorkspaceGuard(request.workspaceGuard);
    const cwd = request.workspacePath ?? this.cwd;
    const startedAt = Date.now();
    let result: ProcessResult;
    try {
      result = await this.runner.run(
        'codex',
        this.buildArgs(prompt, request.capabilities ?? [], executor, preflight.reasoningEffort),
        this.processOptions(request.signal, cwd),
      );
    } catch (error) {
      const durationMs = elapsedMs(startedAt);
      const code = errorCode(error);
      if (isAborted(request.signal) || code === 'ABORT_ERR') return cancelledAgentResult(durationMs, executor);
      if (code === 'ETIMEDOUT') {
        return failureAgentResult(
          CODEX_ERROR_CODE.TIMEOUT,
          `Codex CLI timed out after ${this.timeoutMs}ms.`,
          durationMs,
          executor,
        );
      }
      if (code === 'ENOENT') {
        return failureAgentResult(
          CODEX_ERROR_CODE.NOT_FOUND,
          'Codex CLI executable "codex" was not found.',
          durationMs,
          executor,
        );
      }
      return failureAgentResult(
        CODEX_ERROR_CODE.EXEC_FAILURE,
        `Failed to run Codex CLI: ${errorMessage(error)}`,
        durationMs,
        executor,
      );
    }

    const durationMs = elapsedMs(startedAt);
    if (result.exitCode !== 0) {
      const code = executor === undefined ? CODEX_ERROR_CODE.EXIT_FAILURE : CODEX_ERROR_CODE.RESUME_FAILED;
      const action = executor === undefined ? 'execution' : 'resume';
      return failureAgentResult(code, `Codex ${action} exited with status ${result.exitCode}.`, durationMs, executor);
    }

    const parsed = parseCodexJsonl(result.stdout, {
      provider: CODEX_CLI_PROVIDER,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
      ...(capability === undefined ? {} : { capability }),
    });
    if (!parsed.ok) return failureAgentResult(parsed.code, parsed.detail, durationMs, executor, parsed.telemetry);
    if (executor !== undefined && parsed.outcome.executor.sessionId !== executor.sessionId) {
      return failureAgentResult(
        CODEX_ERROR_CODE.RESUME_IDENTITY_MISMATCH,
        `Codex resume returned thread ${parsed.outcome.executor.sessionId}, expected ${executor.sessionId}.`,
        durationMs,
        executor,
      );
    }
    const takeoverReason = parseHumanTakeover(parsed.outcome.summary);
    if (takeoverReason !== undefined) {
      return {
        exitStatus: 'failure',
        summary: takeoverReason,
        diagnostics: [`${HUMAN_TAKEOVER_DIAGNOSTIC} ${takeoverReason}`],
        executor: parsed.outcome.executor,
        telemetry: parsed.outcome.telemetry,
        durationMs,
      };
    }
    if (isAborted(request.signal)) return cancelledAgentResult(durationMs, parsed.outcome.executor);

    await assertWorkspaceGuard(request.workspaceGuard, 'after-execution', parsed.outcome.executor);
    const sha = await this.readHead(request.signal, cwd);
    if (isAborted(request.signal)) return cancelledAgentResult(durationMs, parsed.outcome.executor);
    if (sha === null) {
      return failureAgentResult(
        CODEX_ERROR_CODE.HEAD_READ_FAILED,
        `Codex completed, but an exact 40-hex HEAD could not be read from ${this.cwd}.`,
        durationMs,
        parsed.outcome.executor,
        parsed.outcome.telemetry,
      );
    }
    return {
      exitStatus: 'success',
      summary: parsed.outcome.summary,
      headSha: sha,
      executor: parsed.outcome.executor,
      telemetry: parsed.outcome.telemetry,
      durationMs,
    };
  }

  private buildArgs(
    prompt: string,
    capabilities: readonly McpHttpCapability[],
    executor: ExecutorIdentity | undefined,
    reasoningEffort: ExecutionReasoningEffort | undefined,
  ): string[] {
    const args = executor === undefined ? ['exec', '--json'] : ['exec', 'resume', '--json'];
    for (const capability of normalizeMcpHttpCapabilities(capabilities)) {
      args.push('-c', codexMcpConfig(capability));
    }
    if (this.model !== undefined) args.push('--model', this.model);
    if (reasoningEffort !== undefined) {
      args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
    }
    if (this.sandboxMode !== undefined) {
      if (executor === undefined) args.push('--sandbox', this.sandboxMode);
      else args.push('-c', `sandbox_mode=${JSON.stringify(this.sandboxMode)}`);
    }
    if (this.approvalPolicy !== undefined) {
      args.push('-c', `approval_policy=${JSON.stringify(this.approvalPolicy)}`);
    }
    if (executor !== undefined) args.push(executor.sessionId);
    args.push(prompt);
    return args;
  }

  private processOptions(signal: AbortSignal | undefined, cwd = this.cwd): ProcessRunOptions {
    return signal === undefined
      ? { timeoutMs: this.timeoutMs, cwd }
      : { timeoutMs: this.timeoutMs, cwd, signal };
  }

  /**
   * Resolve the effective model/effort pair at the provider boundary. Alias
   * normalization is idempotent for already-canonical values, so this is safe
   * whether the caller supplied a raw operator spelling or a resolved snapshot.
   */
  private preflightConfiguration(): ModelEffortPreflightResult {
    const reasoningEffort = this.reasoningEffort === undefined
      ? undefined
      : normalizeReasoningEffort(this.reasoningEffort, { provider: CODEX_CLI_PROVIDER });
    return preflightModelEffort({
      provider: CODEX_CLI_PROVIDER,
      catalog: this.capabilityCatalog,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  private async readHead(signal: AbortSignal | undefined, cwd: string): Promise<string | null> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], this.processOptions(signal, cwd));
      const sha = result.stdout.trim();
      return result.exitCode === 0 && FULL_SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }
}

function buildPrompt(request: ImplementationRequest): string {
  const instructions = request.authority === 'live-target'
    ? request.supplementalInstructions
    : request.instructions;
  const lines = [
    `Implement ${formatTarget(request.target)} from base ${request.baseSha}.`,
    'Read the live target and repository-local instructions as authority.',
    'Run repository-required validation before reporting success.',
    instructions,
  ].filter((line): line is string => line !== undefined && line !== '');
  if ((request.capabilities?.length ?? 0) > 0) {
    lines.push(
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

function formatTarget(target: Target): string {
  return target.kind === 'issue'
    ? `${target.owner}/${target.repo}#${target.issueNumber}`
    : `${target.owner}/${target.repo}@${target.branch}`;
}

interface CodexParseContext {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly capability?: ReturnType<typeof capabilityTelemetry>;
}

function parseCodexJsonl(stdout: string, context: CodexParseContext): ParsedCodexOutput {
  let threadId: string | undefined;
  let summary: string | undefined;
  let completed = false;
  let turnStarts = 0;
  let turnCompletions = 0;
  let usage: ProviderTokenUsage | undefined;
  let firstInputTokens: number | undefined;
  let peakInputTokens: number | undefined;
  let largestToolResultBytes: number | undefined;
  const lines = stdout.split(/\r?\n/).filter((value) => value.trim() !== '');
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value !== 'object' || value === null) throw new Error('event is not an object');
      event = value as Record<string, unknown>;
    } catch {
      return invalidOutput('Codex CLI returned malformed JSONL output.');
    }
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || event.thread_id.trim() === '') {
        return invalidOutput('Codex CLI returned an unusable thread identity.');
      }
      if (threadId !== undefined && event.thread_id !== threadId) {
        return invalidOutput('Codex CLI returned conflicting thread identities.');
      }
      threadId = event.thread_id;
    }
    if (event.type === 'turn.started') turnStarts += 1;
    if (event.type === 'error' || event.type === 'turn.failed') {
      const turns = Math.max(turnStarts, turnCompletions);
      return {
        ok: false,
        code: CODEX_ERROR_CODE.ERROR,
        detail: 'Codex CLI reported a structured execution error.',
        telemetry: providerTelemetry({
          provider: context.provider,
          ...(context.model === undefined ? {} : { model: context.model }),
          ...(context.reasoningEffort === undefined ? {} : { reasoningEffort: context.reasoningEffort }),
          ...(turns === 0 ? {} : { turns }),
          ...(usage === undefined ? {} : { usage }),
          ...(context.capability === undefined ? {} : { capability: context.capability }),
          failure: { category: 'executed-runtime', code: CODEX_ERROR_CODE.ERROR },
        }),
      };
    }
    if (event.type === 'turn.completed') {
      completed = true;
      turnCompletions += 1;
      const turnUsage = tokenUsageFromProviderValue(event.usage);
      usage = mergeTokenUsage(usage, turnUsage);
      if (turnUsage?.inputTokens !== undefined) {
        firstInputTokens ??= turnUsage.inputTokens;
        peakInputTokens = peakInputTokens === undefined ? turnUsage.inputTokens : Math.max(peakInputTokens, turnUsage.inputTokens);
      }
    }
    if (event.type === 'item.completed' && typeof event.item === 'object' && event.item !== null) {
      const item = event.item as Record<string, unknown>;
      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text !== '') summary = item.text;
      largestToolResultBytes = maximumBytes(largestToolResultBytes, toolResultBytesFromItem(item));
    }
  }
  if (lines.length === 0 || threadId === undefined || summary === undefined || !completed) {
    return invalidOutput('Codex CLI returned incomplete structured output.');
  }
  const turns = Math.max(turnStarts, turnCompletions, 1);
  return {
    ok: true,
    outcome: {
      summary,
      executor: { provider: CODEX_CLI_PROVIDER, sessionId: threadId },
      telemetry: providerTelemetry({
        provider: context.provider,
        ...(context.model === undefined ? {} : { model: context.model }),
        ...(context.reasoningEffort === undefined ? {} : { reasoningEffort: context.reasoningEffort }),
        turns,
        ...(usage === undefined ? {} : { usage }),
        ...(context.capability === undefined ? {} : { capability: context.capability }),
        ...(firstInputTokens === undefined || peakInputTokens === undefined
          ? {}
          : { context: { initialTokens: firstInputTokens, peakTokens: peakInputTokens } }),
        largestToolResultBytes: largestToolResultBytes ?? 0,
      }),
    },
  };
}

function invalidOutput(detail: string): ParsedCodexOutput {
  return { ok: false, code: CODEX_ERROR_CODE.INVALID_OUTPUT, detail };
}

function codexMcpConfig(capability: McpHttpCapability): string {
  return (
    `mcp_servers.${capability.name}={` +
    `url=${JSON.stringify(capability.endpoint)},required=true,default_tools_approval_mode="approve"}`
  );
}

function parseHumanTakeover(summary: string): string | undefined {
  if (!summary.startsWith(HUMAN_TAKEOVER_DIAGNOSTIC)) return undefined;
  const reason = summary.slice(HUMAN_TAKEOVER_DIAGNOSTIC.length).trim();
  return reason === '' ? 'A human browser takeover is required.' : reason;
}

function isUsableCodexExecutor(executor: ExecutorIdentity): boolean {
  return executor.provider === CODEX_CLI_PROVIDER && executor.sessionId.trim() !== '';
}

/** Typed preflight rejection: counted apart from any executed runtime failure. */
function executionConfigurationFailure(error: ExecutionConfigurationError, executor?: ExecutorIdentity): AgentResult {
  return failureAgentResult(error.code, error.message, 0, executor, providerTelemetry({
    provider: error.evidence.provider ?? 'unknown',
    ...(error.evidence.model === undefined ? {} : { model: error.evidence.model }),
    ...(error.evidence.canonicalEffort === undefined ? {} : { reasoningEffort: error.evidence.canonicalEffort }),
    turns: 0,
    ...(error.evidence.capabilitySource === undefined ? {} : { capability: {
      source: error.evidence.capabilitySource,
      ...(error.evidence.capabilityRevision === undefined ? {} : { revision: error.evidence.capabilityRevision }),
      verified: false,
    } }),
    failure: { category: 'configuration-preflight', code: error.code },
  }));
}

function failureAgentResult(
  code: CodexErrorCode | string,
  detail: string,
  durationMs: number,
  executor?: ExecutorIdentity,
  telemetry?: ProviderExecutionTelemetry,
): AgentResult {
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${code}: ${detail}`],
    durationMs,
    ...(executor === undefined ? {} : { executor }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

function cancelledAgentResult(durationMs: number, executor?: ExecutorIdentity): AgentResult {
  return failureAgentResult(CODEX_ERROR_CODE.CANCELLED, 'Codex CLI execution was cancelled.', durationMs, executor);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
