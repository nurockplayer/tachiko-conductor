import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import {
  HUMAN_TAKEOVER_DIAGNOSTIC,
  assertWorkspaceGuard,
  normalizeMcpHttpCapabilities,
  type ImplementationAgent,
  type ImplementationRequest,
  type McpHttpCapability,
} from '../adapters/agent.js';
import type { AgentResult, ExecutorIdentity } from '../domain/types.js';
import type { ProviderExecutionTelemetry, ProviderTokenUsage } from '../domain/telemetry.js';
import { NodeProcessRunner, type ProcessRunner } from '../github/transport.js';
import { CODEX_CLI_PROVIDER } from './codex-cli.js';
import {
  isExecutionConfigurationError,
  normalizeReasoningEffort,
  type ExecutionConfigurationError,
  type ExecutionReasoningEffort,
} from '../execution-profiles.js';
import {
  codexFallbackCapabilityCatalog,
  preflightModelEffort,
  runtimeCapabilityCatalog,
  type ModelCapabilityCatalog,
} from './model-capability.js';
import {
  capabilityTelemetry,
  maximumBytes,
  mergeTokenUsage,
  providerTelemetry,
  tokenUsageFromProviderValue,
  toolResultBytesFromItem,
} from './provider-telemetry.js';

/** Provider identity is intentionally distinct from the compatible CLI fallback. */
export const CODEX_APP_SERVER_PROVIDER = 'codex-app-server';

export const CODEX_APP_SERVER_ERROR_CODE = {
  UNAVAILABLE: 'CODEX_APP_SERVER_UNAVAILABLE',
  PROTOCOL: 'CODEX_APP_SERVER_PROTOCOL',
  RECONCILIATION_BLOCKED: 'CODEX_APP_SERVER_RECONCILIATION_BLOCKED',
  OWNERSHIP_UNPROVEN: 'CODEX_APP_SERVER_OWNERSHIP_UNPROVEN',
  INVALID_EXECUTOR: 'CODEX_APP_SERVER_INVALID_EXECUTOR',
  HEAD_READ_FAILED: 'HEAD_READ_FAILED',
  TIMEOUT: 'CODEX_APP_SERVER_TIMEOUT',
  CANCELLED: 'CODEX_APP_SERVER_CANCELLED',
} as const;

export type AppServerLifecycleEvent =
  | { readonly type: 'thread_started'; readonly threadId: string }
  | { readonly type: 'turn_started'; readonly threadId: string; readonly turnId: string }
  | { readonly type: 'turn_completed'; readonly threadId: string; readonly turnId: string; readonly status: 'completed' | 'interrupted' | 'failed'; readonly usage?: ProviderTokenUsage }
  | { readonly type: 'item_completed'; readonly threadId: string; readonly itemId: string; readonly toolResultBytes?: number }
  | { readonly type: 'approval_denied'; readonly method: string };

export interface NativeThreadObservation {
  readonly threadId: string;
  readonly status: 'active' | 'idle' | 'not_loaded' | 'system_error';
  readonly activeTurnId?: string;
  /** Bounded native items for reconciliation. Raw transcripts are never persisted. */
  readonly history: readonly { readonly id: string; readonly type: string }[];
}

/** One provider-reported model descriptor; raw field values stay unpersisted. */
export interface AppServerModelDescriptor {
  readonly model: string;
  readonly supportedReasoningEfforts: readonly string[];
}

export interface CodexAppServerClient {
  /**
   * Optional authoritative capability discovery. Implementations backed by a
   * runtime without `model/list` simply omit it, and callers fall back to the
   * versioned local catalog rather than treating absence as a model failure.
   */
  listModels?(): Promise<readonly AppServerModelDescriptor[]>;
  observeThread(threadId: string): Promise<NativeThreadObservation>;
  startThread(options: AppServerThreadOptions): Promise<string>;
  resumeThread(threadId: string, options: AppServerThreadOptions): Promise<string>;
  startTurn(threadId: string, prompt: string): Promise<string>;
  steerTurn(threadId: string, turnId: string, prompt: string): Promise<string>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  waitForTurn(threadId: string, turnId: string): Promise<{ readonly status: 'completed' | 'interrupted' | 'failed'; readonly summary?: string }>;
  onEvent(listener: (event: AppServerLifecycleEvent) => void): () => void;
  close(): Promise<void>;
}

export interface AppServerThreadOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly sandboxMode?: string;
  readonly approvalPolicy?: string;
  /** Per-invocation App Server config; never persist ephemeral capabilities. */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface AppServerOpenOptions {
  readonly signal?: AbortSignal;
}

/** An unavailable binary/handshake is safe to route to the existing CLI adapter. */
export class AppServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerUnavailableError';
  }
}

export interface CodexAppServerClientFactory {
  open(options?: AppServerOpenOptions): Promise<CodexAppServerClient>;
}

export interface CodexAppServerAdapterOptions {
  readonly clientFactory?: CodexAppServerClientFactory;
  readonly fallback?: ImplementationAgent;
  readonly runner?: ProcessRunner;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly reasoningEffort?: ExecutionReasoningEffort;
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy?: 'untrusted' | 'on-request' | 'never';
  /** Versioned local capability metadata used only when discovery is unavailable. */
  readonly capabilityCatalog?: ModelCapabilityCatalog;
}

/**
 * A provider-neutral implementation adapter backed by one component-local
 * stdio App Server. It observes before every known-thread mutation and relies
 * on the durable Run/dispatch fence supplied by workflow code; process ids and
 * App Server instances are deliberately never treated as writer ownership.
 */
export class CodexAppServerAdapter implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  private readonly clientFactory: CodexAppServerClientFactory;
  private readonly fallback: ImplementationAgent | undefined;
  private readonly runner: ProcessRunner;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly options: AppServerThreadOptions;
  private readonly fallbackCapabilityCatalog: ModelCapabilityCatalog;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? new StdioCodexAppServerClientFactory();
    this.fallback = options.fallback;
    this.runner = options.runner ?? new NodeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.fallbackCapabilityCatalog = options.capabilityCatalog ?? codexFallbackCapabilityCatalog();
    this.options = {
      cwd: this.cwd,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      ...(options.sandboxMode === undefined ? {} : { sandboxMode: options.sandboxMode }),
      ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
    };
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    // Existing CLI continuations stay with the CLI; changing transport must
    // never silently change a durable executor identity.
    if (request.executor?.provider === CODEX_CLI_PROVIDER) return this.runFallback(request);
    if (request.executor !== undefined && !isAppServerExecutor(request.executor)) {
      return failure(CODEX_APP_SERVER_ERROR_CODE.INVALID_EXECUTOR, 'Codex App Server continuation requires its exact durable executor identity.', request.executor);
    }
    if (!hasOwnership(request)) {
      return failure(CODEX_APP_SERVER_ERROR_CODE.OWNERSHIP_UNPROVEN, 'Native runtime mutation requires an exact durable Run and executor-generation ownership fence.', request.executor);
    }
    if (request.signal?.aborted === true) return cancelled(request.executor);
    await assertWorkspaceGuard(request.workspaceGuard);
    const workspacePath = request.workspacePath ?? this.cwd;
    // Capability normalization can reject malformed or duplicate runtime input.
    // Complete it before opening the child process so a rejected request has no
    // App Server lifecycle to clean up.
    const capabilityConfig = appServerCapabilityConfig(request.capabilities ?? []);
    const deadlineAt = Date.now() + this.timeoutMs;
    let client: CodexAppServerClient;
    try {
      client = await this.openClient(deadlineAt, request.signal);
    } catch (error) {
      if (error instanceof AppServerUnavailableError) return this.runFallback(request);
      if (error instanceof AppServerTimeoutError) {
        return failure(CODEX_APP_SERVER_ERROR_CODE.TIMEOUT, `Codex App Server execution timed out after ${this.timeoutMs}ms.`, request.executor);
      }
      if (error instanceof AppServerCancelledError) return cancelled(request.executor);
      return failure(CODEX_APP_SERVER_ERROR_CODE.UNAVAILABLE, message(error), request.executor);
    }
    const startedAt = Date.now();
    const withinBoundary = <T>(operation: () => Promise<T>): Promise<T> =>
      runWithinDeadline(operation, deadlineAt, request.signal);
    let executor: ExecutorIdentity | undefined = request.executor;
    const activeTurn: { current?: { readonly threadId: string; readonly turnId: string } } = {};
    let threadId: string | undefined;
    let turnStartAttempted = false;
    let removeTurnListener: (() => void) | undefined;
    let capabilityProvenance: ReturnType<typeof capabilityTelemetry>;
    let observedUsage: ProviderTokenUsage | undefined;
    let firstInputTokens: number | undefined;
    let peakInputTokens: number | undefined;
    let largestToolResultBytes: number | undefined;
    const observedTurnIds = new Set<string>();
    try {
      // Authoritative discovery when the runtime exposes it; otherwise a
      // versioned local catalog. Either way the requested pair is validated
      // before any thread or turn exists, so a rejection starts zero turns.
      const catalog = await this.discoverCapabilityCatalog(client, withinBoundary);
      const requestedEffort: ExecutionReasoningEffort | undefined = this.options.reasoningEffort === undefined
        ? undefined
        : normalizeReasoningEffort(this.options.reasoningEffort, { provider: CODEX_APP_SERVER_PROVIDER });
      const preflight = preflightModelEffort({
        provider: CODEX_APP_SERVER_PROVIDER,
        catalog,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(requestedEffort === undefined ? {} : { reasoningEffort: requestedEffort }),
      });
      capabilityProvenance = capabilityTelemetry(preflight);
      const threadOptions = {
        ...this.options,
        cwd: workspacePath,
        ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
        ...capabilityConfig,
      };
      const prompt = buildPrompt(request);
      if (request.executor === undefined) {
        threadId = await withinBoundary(() => client.startThread(threadOptions));
      } else {
        const observation = await withinBoundary(() => client.observeThread(request.executor!.sessionId));
        if (observation.threadId !== request.executor.sessionId || observation.status === 'active' || observation.activeTurnId !== undefined) {
          return failure(
            CODEX_APP_SERVER_ERROR_CODE.RECONCILIATION_BLOCKED,
            'Native thread has an active or ambiguous writer; Tachiko observed it but will not resume, steer, or interrupt it.',
            request.executor,
          );
        }
        threadId = await withinBoundary(() => client.resumeThread(request.executor!.sessionId, threadOptions));
        if (threadId !== request.executor.sessionId) {
          return failure(CODEX_APP_SERVER_ERROR_CODE.RECONCILIATION_BLOCKED, 'Native resume returned a different thread identity.', request.executor);
        }
      }
      await assertWorkspaceGuard(request.workspaceGuard);
      const turnThreadId = threadId;
      if (turnThreadId === undefined) throw new Error('Codex App Server thread identity was not established before turn start.');
      const completedTurnIds = new Set<string>();
      removeTurnListener = client.onEvent((event) => {
        if (event.type === 'approval_denied') return;
        if (event.threadId !== turnThreadId) return;
        if (event.type === 'turn_started') {
          observedTurnIds.add(event.turnId);
          if (!completedTurnIds.has(event.turnId)) activeTurn.current = { threadId: event.threadId, turnId: event.turnId };
          return;
        }
        if (event.type === 'turn_completed') {
          completedTurnIds.add(event.turnId);
          observedTurnIds.add(event.turnId);
          if (event.usage !== undefined) {
            observedUsage = mergeTokenUsage(observedUsage, event.usage);
            if (event.usage.inputTokens !== undefined) {
              firstInputTokens ??= event.usage.inputTokens;
              peakInputTokens = peakInputTokens === undefined
                ? event.usage.inputTokens
                : Math.max(peakInputTokens, event.usage.inputTokens);
            }
          }
          if (activeTurn.current?.threadId === event.threadId && activeTurn.current.turnId === event.turnId) activeTurn.current = undefined;
          return;
        }
        if (event.type === 'item_completed') {
          largestToolResultBytes = maximumBytes(largestToolResultBytes, event.toolResultBytes);
        }
      });
      turnStartAttempted = true;
      const turnId = await withinBoundary(() => client.startTurn(turnThreadId, prompt));
      if (!completedTurnIds.has(turnId)) activeTurn.current = { threadId: turnThreadId, turnId };
      executor = {
        provider: CODEX_APP_SERVER_PROVIDER,
        sessionId: turnThreadId,
        generation: request.runtimeOwnership.generation,
      };
      const terminal = await withinBoundary(() => client.waitForTurn(turnThreadId, turnId));
      activeTurn.current = undefined;
      if (terminal.status !== 'completed') {
        return failure(
          CODEX_APP_SERVER_ERROR_CODE.PROTOCOL,
          `Codex App Server turn ${turnId} ended ${terminal.status}.`,
          executor,
          providerTelemetry({
            provider: CODEX_APP_SERVER_PROVIDER,
            ...(this.options.model === undefined ? {} : { model: this.options.model }),
            ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
            turns: Math.max(observedTurnIds.size, 1),
            ...(observedUsage === undefined ? {} : { usage: observedUsage }),
            ...(capabilityProvenance === undefined ? {} : { capability: capabilityProvenance }),
            ...(firstInputTokens === undefined || peakInputTokens === undefined ? {} : { context: { initialTokens: firstInputTokens, peakTokens: peakInputTokens } }),
            ...(largestToolResultBytes === undefined ? {} : { largestToolResultBytes }),
            failure: { category: 'executed-runtime', code: CODEX_APP_SERVER_ERROR_CODE.PROTOCOL },
          }),
        );
      }
      const takeoverReason = parseHumanTakeover(terminal.summary);
      if (takeoverReason !== undefined) {
        return {
          exitStatus: 'failure',
          summary: takeoverReason,
          diagnostics: [`${HUMAN_TAKEOVER_DIAGNOSTIC} ${takeoverReason}`],
          executor,
          telemetry: providerTelemetry({
            provider: CODEX_APP_SERVER_PROVIDER,
            ...(this.options.model === undefined ? {} : { model: this.options.model }),
            ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
            turns: Math.max(observedTurnIds.size, 1),
            ...(observedUsage === undefined ? {} : { usage: observedUsage }),
            ...(capabilityProvenance === undefined ? {} : { capability: capabilityProvenance }),
            ...(firstInputTokens === undefined || peakInputTokens === undefined ? {} : { context: { initialTokens: firstInputTokens, peakTokens: peakInputTokens } }),
            ...(largestToolResultBytes === undefined ? {} : { largestToolResultBytes }),
          }),
          durationMs: Date.now() - startedAt,
        };
      }
      await assertWorkspaceGuard(request.workspaceGuard, 'after-execution', executor);
      const headSha = await this.readHead(request.signal, workspacePath);
      if (headSha === null) return failure(CODEX_APP_SERVER_ERROR_CODE.HEAD_READ_FAILED, `Codex completed, but an exact 40-hex HEAD could not be read from ${workspacePath}.`, executor, providerTelemetry({
        provider: CODEX_APP_SERVER_PROVIDER,
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
        ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
        turns: Math.max(observedTurnIds.size, 1),
        ...(observedUsage === undefined ? {} : { usage: observedUsage }),
        ...(capabilityProvenance === undefined ? {} : { capability: capabilityProvenance }),
        ...(firstInputTokens === undefined || peakInputTokens === undefined ? {} : { context: { initialTokens: firstInputTokens, peakTokens: peakInputTokens } }),
        ...(largestToolResultBytes === undefined ? {} : { largestToolResultBytes }),
        failure: { category: 'executed-runtime', code: CODEX_APP_SERVER_ERROR_CODE.HEAD_READ_FAILED },
      }));
      return {
        exitStatus: 'success',
        summary: terminal.summary ?? 'Codex App Server turn completed.',
        headSha,
        executor,
        telemetry: providerTelemetry({
          provider: CODEX_APP_SERVER_PROVIDER,
          ...(this.options.model === undefined ? {} : { model: this.options.model }),
          ...(preflight.reasoningEffort === undefined ? {} : { reasoningEffort: preflight.reasoningEffort }),
          turns: Math.max(observedTurnIds.size, 1),
          ...(observedUsage === undefined ? {} : { usage: observedUsage }),
          ...(capabilityProvenance === undefined ? {} : { capability: capabilityProvenance }),
          ...(firstInputTokens === undefined || peakInputTokens === undefined ? {} : { context: { initialTokens: firstInputTokens, peakTokens: peakInputTokens } }),
          ...(largestToolResultBytes === undefined ? {} : { largestToolResultBytes }),
        }),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // A configuration rejection is not a model/runtime failure and is
      // reported with its own countable code before any turn was attempted.
      if (isExecutionConfigurationError(error)) return executionConfigurationFailure(error, executor);
      if (error instanceof AppServerTimeoutError || error instanceof AppServerCancelledError) {
        await this.interruptExactTurn(client, threadId, activeTurn, turnStartAttempted);
      }
      if (error instanceof AppServerTimeoutError) {
        return failure(CODEX_APP_SERVER_ERROR_CODE.TIMEOUT, `Codex App Server execution timed out after ${this.timeoutMs}ms.`, executor);
      }
      if (error instanceof AppServerCancelledError) return cancelled(executor);
      return failure(CODEX_APP_SERVER_ERROR_CODE.PROTOCOL, message(error), executor);
    } finally {
      removeTurnListener?.();
      await client.close();
    }
  }

  /** Side-effect-free native observation; it never starts or resumes a turn. */
  async observeRuntime(executor: ExecutorIdentity): Promise<NativeThreadObservation> {
    if (!isAppServerExecutor(executor)) throw new Error('Native observation requires a Codex App Server executor identity.');
    const deadlineAt = Date.now() + this.timeoutMs;
    const client = await this.openClient(deadlineAt, undefined);
    try { return await runWithinDeadline(() => client.observeThread(executor.sessionId), deadlineAt, undefined); } finally { await client.close(); }
  }

  /** Steer only an exact observed active turn under the durable Run fence. */
  async steerActiveTurn(request: ImplementationRequest, turnId: string, prompt: string): Promise<string> {
    return this.mutateActiveTurn(request, turnId, async (client, executor) => client.steerTurn(executor.sessionId, turnId, prompt));
  }

  /** Interrupt only an exact observed active turn under the durable Run fence. */
  async interruptActiveTurn(request: ImplementationRequest, turnId: string): Promise<void> {
    await this.mutateActiveTurn(request, turnId, async (client, executor) => { await client.interruptTurn(executor.sessionId, turnId); return undefined; });
  }

  private async mutateActiveTurn<T>(request: ImplementationRequest, turnId: string, action: (client: CodexAppServerClient, executor: ExecutorIdentity) => Promise<T>): Promise<T> {
    if (request.executor === undefined || !isAppServerExecutor(request.executor) || !hasOwnership(request)) {
      throw new Error('Native active-turn control requires an exact App Server executor and durable ownership fence.');
    }
    const deadlineAt = Date.now() + this.timeoutMs;
    const client = await this.openClient(deadlineAt, request.signal);
    try {
      const observation = await runWithinDeadline(() => client.observeThread(request.executor!.sessionId), deadlineAt, request.signal);
      if (observation.status !== 'active' || observation.activeTurnId !== turnId) {
        throw new Error('Native active-turn control refused: the observed active turn does not match the expected turn.');
      }
      await assertWorkspaceGuard(request.workspaceGuard);
      return await runWithinDeadline(() => action(client, request.executor!), deadlineAt, request.signal);
    } finally { await client.close(); }
  }

  private async interruptExactTurn(
    client: CodexAppServerClient,
    threadId: string | undefined,
    activeTurn: { current?: { readonly threadId: string; readonly turnId: string } },
    turnStartAttempted: boolean,
  ): Promise<void> {
    if (!turnStartAttempted || threadId === undefined) return;
    const deadlineAt = Date.now() + APP_SERVER_INTERRUPT_GRACE_MS;
    let exactTurn = activeTurn.current;
    while (exactTurn === undefined && Date.now() < deadlineAt) {
      exactTurn = activeTurn.current;
      if (exactTurn !== undefined) break;
      try {
        const observation = await waitForNativeOperation(
          client.observeThread(threadId),
          Math.max(1, deadlineAt - Date.now()),
          undefined,
        );
        exactTurn = activeTurn.current;
        if (exactTurn === undefined && observation.status === 'active' && observation.activeTurnId !== undefined) {
          exactTurn = { threadId, turnId: observation.activeTurnId };
          activeTurn.current = exactTurn;
        }
      } catch {
        exactTurn = activeTurn.current;
        if (exactTurn === undefined) break;
      }
      if (exactTurn === undefined) await new Promise((resolve) => setTimeout(resolve, APP_SERVER_ACTIVE_TURN_POLL_MS));
    }
    exactTurn ??= activeTurn.current;
    if (exactTurn === undefined) return;
    try {
      await waitForNativeOperation(
        client.interruptTurn(exactTurn.threadId, exactTurn.turnId),
        Math.max(1, deadlineAt - Date.now()),
        undefined,
      );
    } catch {
      // Component shutdown remains the bounded last resort when native interrupt is unavailable.
    }
  }

  /**
   * Resolve the capability catalog at the provider boundary. Runtime discovery
   * wins when the installed runtime exposes it; any discovery failure degrades
   * to the versioned local fallback and is never reported as a model failure.
   */
  private async discoverCapabilityCatalog(
    client: CodexAppServerClient,
    withinBoundary: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<ModelCapabilityCatalog> {
    if (client.listModels === undefined) return this.fallbackCapabilityCatalog;
    try {
      const models = await withinBoundary(() => client.listModels!());
      return runtimeCapabilityCatalog(models, 'codex-app-server:model/list');
    } catch {
      return this.fallbackCapabilityCatalog;
    }
  }

  private async openClient(deadlineAt: number, signal: AbortSignal | undefined): Promise<CodexAppServerClient> {
    const openController = new AbortController();
    const forwardAbort = () => openController.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => openController.abort(new AppServerTimeoutError()), Math.max(0, deadlineAt - Date.now()));
    let openPromise: Promise<CodexAppServerClient> | undefined;
    try {
      return await runWithinDeadline(() => {
        openPromise = this.clientFactory.open({ signal: openController.signal });
        return openPromise;
      }, deadlineAt, signal);
    } catch (error) {
      if ((error instanceof AppServerTimeoutError || error instanceof AppServerCancelledError) && openPromise !== undefined) {
        void openPromise.then((lateClient) => lateClient.close()).catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async runFallback(request: ImplementationRequest): Promise<AgentResult> {
    if (this.fallback === undefined) return failure(CODEX_APP_SERVER_ERROR_CODE.UNAVAILABLE, 'Codex App Server is unavailable and no Codex CLI fallback was configured.', request.executor);
    return this.fallback.run(request);
  }

  private async readHead(signal: AbortSignal | undefined, cwd: string): Promise<string | null> {
    try {
      const result = await this.runner.run('git', ['rev-parse', 'HEAD'], signal === undefined ? { timeoutMs: this.timeoutMs, cwd } : { timeoutMs: this.timeoutMs, cwd, signal });
      return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }
}

function isAppServerExecutor(executor: ExecutorIdentity): boolean {
  return executor.provider === CODEX_APP_SERVER_PROVIDER && executor.sessionId.trim() !== '' && executor.generation !== undefined && executor.generation.trim() !== '';
}

function hasOwnership(request: ImplementationRequest): request is ImplementationRequest & { readonly runtimeOwnership: NonNullable<ImplementationRequest['runtimeOwnership']> } {
  return request.runtimeOwnership !== undefined && request.runtimeOwnership.runId.trim() !== '' && request.runtimeOwnership.generation.trim() !== '' &&
    (request.executor === undefined || request.executor.generation === request.runtimeOwnership.generation);
}

function failure(
  code: string,
  detail: string,
  executor?: ExecutorIdentity,
  telemetry?: ProviderExecutionTelemetry,
): AgentResult {
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${code}: ${detail}`],
    ...(executor === undefined ? {} : { executor }),
    ...(telemetry === undefined ? {} : { telemetry }),
  };
}

function cancelled(executor?: ExecutorIdentity): AgentResult {
  return failure(CODEX_APP_SERVER_ERROR_CODE.CANCELLED, 'Codex App Server execution was cancelled.', executor);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPrompt(request: ImplementationRequest): string {
  const instructions = request.authority === 'live-target' ? request.supplementalInstructions : request.instructions;
  const lines = [
    `Implement ${request.target.kind === 'issue' ? `${request.target.owner}/${request.target.repo}#${request.target.issueNumber}` : `${request.target.owner}/${request.target.repo}@${request.target.branch}`} from base ${request.baseSha}.`,
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

/** Actual local-only JSON-RPC App Server client. No TCP listener is created. */
export class StdioCodexAppServerClientFactory implements CodexAppServerClientFactory {
  async open(options: AppServerOpenOptions = {}): Promise<CodexAppServerClient> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('codex', ['app-server', '--stdio'], { stdio: 'pipe' });
    } catch (error) {
      throw new AppServerUnavailableError(message(error));
    }
    const client = new StdioCodexAppServerClient(child);
    try {
      await client.initialize(options.signal);
      return client;
    } catch (error) {
      await client.close();
      if (options.signal?.aborted === true) throw options.signal.reason ?? error;
      throw new AppServerUnavailableError(message(error));
    }
  }
}

export class StdioCodexAppServerClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: AppServerLifecycleEvent) => void>();
  private readonly completedTurns = new Map<string, { status: 'completed' | 'interrupted' | 'failed'; summary?: string }>();
  private readonly turnSummaries = new Map<string, string>();
  private readonly turnWaiters = new Map<string, { resolve(value: { status: 'completed' | 'interrupted' | 'failed'; summary?: string }): void; reject(error: Error): void }>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code) => { if (!this.closed) this.rejectAll(new Error(`Codex App Server exited before completing RPC work (${code ?? 'signal'}).`)); });
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'tachiko-conductor', title: 'Tachiko Conductor', version: '0.1.0' }, capabilities: null }, signal);
    this.notify('initialized');
  }

  /**
   * Authoritative provider capability discovery. Bounded pagination keeps this
   * strictly read-only work; a runtime without `model/list` rejects the RPC and
   * the caller degrades to the versioned fallback catalog.
   */
  async listModels(): Promise<readonly AppServerModelDescriptor[]> {
    const models: AppServerModelDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < APP_SERVER_MODEL_LIST_MAX_PAGES; page += 1) {
      const result = object(
        await this.request('model/list', cursor === undefined ? {} : { cursor }),
        'model/list response',
      );
      for (const raw of array(result.data, 'model/list data')) {
        const descriptor = object(raw, 'model/list entry');
        const model = typeof descriptor.model === 'string' && descriptor.model.trim() !== ''
          ? descriptor.model
          : typeof descriptor.id === 'string' && descriptor.id.trim() !== '' ? descriptor.id : undefined;
        if (model === undefined) continue;
        const rawEfforts = descriptor.supportedReasoningEfforts;
        // An entry without a usable effort list asserts nothing; skip it rather
        // than fabricating an empty (and therefore falsely unsupported) set.
        if (!Array.isArray(rawEfforts) || rawEfforts.length === 0) continue;
        const supportedReasoningEfforts = rawEfforts
          .map((item) => object(item, 'supportedReasoningEfforts entry').reasoningEffort)
          .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
        if (supportedReasoningEfforts.length === 0) continue;
        models.push({ model, supportedReasoningEfforts });
      }
      if (typeof result.nextCursor !== 'string' || result.nextCursor.trim() === '') break;
      cursor = result.nextCursor;
    }
    return models;
  }

  async observeThread(threadId: string): Promise<NativeThreadObservation> {
    const result = object(await this.request('thread/read', { threadId, includeTurns: true }), 'thread/read response');
    const thread = object(result.thread, 'thread/read thread');
    const status = object(thread.status, 'thread status');
    const rawStatus = string(status.type, 'thread status type');
    const turns = array(thread.turns, 'thread turns');
    const active = turns.map((turn) => object(turn, 'turn')).find((turn) => turn.status === 'inProgress');
    return {
      threadId: string(thread.id, 'thread id'),
      status: rawStatus === 'active' ? 'active' : rawStatus === 'idle' ? 'idle' : rawStatus === 'notLoaded' ? 'not_loaded' : 'system_error',
      ...(active === undefined ? {} : { activeTurnId: string(active.id, 'active turn id') }),
      history: turns.flatMap((turn) => array(object(turn, 'turn').items, 'turn items').slice(0, 20).map((item) => {
        const value = object(item, 'thread item');
        return { id: string(value.id, 'thread item id'), type: string(value.type, 'thread item type') };
      })).slice(0, 100),
    };
  }

  async startThread(options: AppServerThreadOptions): Promise<string> {
    const result = object(await this.request('thread/start', threadParams(options)), 'thread/start response');
    return string(object(result.thread, 'thread/start thread').id, 'thread id');
  }

  async resumeThread(threadId: string, options: AppServerThreadOptions): Promise<string> {
    const result = object(await this.request('thread/resume', { threadId, excludeTurns: true, ...threadParams(options) }), 'thread/resume response');
    return string(object(result.thread, 'thread/resume thread').id, 'thread id');
  }

  async startTurn(threadId: string, prompt: string): Promise<string> {
    const result = object(await this.request('turn/start', { threadId, input: [textInput(prompt)] }), 'turn/start response');
    return string(object(result.turn, 'turn/start turn').id, 'turn id');
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<string> {
    const result = object(await this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [textInput(prompt)] }), 'turn/steer response');
    return string(result.turnId, 'turn/steer turn id');
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async waitForTurn(_threadId: string, turnId: string): Promise<{ readonly status: 'completed' | 'interrupted' | 'failed'; readonly summary?: string }> {
    const completed = this.completedTurns.get(turnId);
    if (completed !== undefined) return completed;
    return new Promise((resolve, reject) => this.turnWaiters.set(turnId, { resolve, reject }));
  }

  onEvent(listener: (event: AppServerLifecycleEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(new Error('Codex App Server client closed.'));
    if (!this.child.killed) this.child.kill();
  }

  private request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex App Server client is closed.'));
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('Codex App Server request was cancelled.'));
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(signal?.reason ?? new Error('Codex App Server request was cancelled.'));
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (error) => { cleanup(); reject(error); },
      });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  private receive(line: string): void {
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(line), 'JSON-RPC message'); } catch { return; }
    if ((typeof value.id === 'number' || typeof value.id === 'string') && typeof value.method !== 'string') {
      const pending = this.pending.get(value.id);
      if (pending === undefined) return;
      this.pending.delete(value.id);
      if (value.error !== undefined) pending.reject(new Error(`App Server RPC error: ${JSON.stringify(value.error)}`));
      else pending.resolve(value.result);
      return;
    }
    if ((typeof value.id === 'number' || typeof value.id === 'string') && typeof value.method === 'string') {
      // Explicit fail-closed response: no approval, permission, network, or
      // tool authority is inferred from an App Server request.
      this.child.stdin.write(`${JSON.stringify({ id: value.id, error: { code: -32002, message: 'Tachiko has no policy authorizing this App Server request.' } })}\n`);
      this.emit({ type: 'approval_denied', method: value.method });
      return;
    }
    if (typeof value.method === 'string') this.notification(value.method, value.params);
  }

  private notification(method: string, raw: unknown): void {
    const params = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    if (method === 'thread/started') {
      const thread = object(params.thread, 'thread/started thread');
      this.emit({ type: 'thread_started', threadId: string(thread.id, 'thread id') });
    }
    if (method === 'turn/started') {
      const turn = object(params.turn, 'turn/started turn');
      this.emit({ type: 'turn_started', threadId: string(params.threadId, 'thread id'), turnId: string(turn.id, 'turn id') });
    }
    if (method === 'turn/completed') {
      const turn = object(params.turn, 'turn/completed turn');
      const turnId = string(turn.id, 'turn id');
      const rawStatus = string(turn.status, 'turn status');
      const status: 'completed' | 'interrupted' | 'failed' = rawStatus === 'completed' || rawStatus === 'interrupted' || rawStatus === 'failed' ? rawStatus : 'failed';
      const summary = latestAgentMessage(array(turn.items, 'turn items')) ?? this.turnSummaries.get(turnId);
      const usage = tokenUsageFromProviderValue(turn.usage ?? params.usage);
      const complete = { status, ...(summary === undefined ? {} : { summary }) };
      this.completedTurns.set(turnId, complete);
      this.turnWaiters.get(turnId)?.resolve(complete);
      this.turnWaiters.delete(turnId);
      this.emit({ type: 'turn_completed', threadId: string(params.threadId, 'thread id'), turnId, status, ...(usage === undefined ? {} : { usage }) });
    }
    if (method === 'item/completed') {
      const item = object(params.item, 'item/completed item');
      const summary = agentMessage(item);
      if (summary !== undefined && typeof params.turnId === 'string' && params.turnId.trim() !== '') {
        this.turnSummaries.set(params.turnId, summary);
      }
      const toolResultBytes = toolResultBytesFromItem(item);
      this.emit({ type: 'item_completed', threadId: string(params.threadId, 'thread id'), itemId: string(item.id, 'item id'), ...(toolResultBytes === undefined ? {} : { toolResultBytes }) });
    }
  }

  private emit(event: AppServerLifecycleEvent): void { for (const listener of this.listeners) listener(event); }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const pending of this.turnWaiters.values()) pending.reject(error);
    this.turnWaiters.clear();
  }
}

/** Typed preflight rejection: counted apart from any executed runtime failure. */
function executionConfigurationFailure(error: ExecutionConfigurationError, executor?: ExecutorIdentity): AgentResult {
  return failure(error.code, error.message, executor, providerTelemetry({
    provider: error.evidence.provider ?? CODEX_APP_SERVER_PROVIDER,
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

function threadParams(options: AppServerThreadOptions): Record<string, unknown> {
  const config = {
    ...(options.config ?? {}),
    ...(options.reasoningEffort === undefined ? {} : { model_reasoning_effort: options.reasoningEffort }),
  };
  return {
    cwd: options.cwd,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(Object.keys(config).length === 0 ? {} : { config }),
    ...(options.sandboxMode === undefined ? {} : { sandbox: options.sandboxMode }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  };
}

function appServerCapabilityConfig(capabilities: readonly McpHttpCapability[]): Pick<AppServerThreadOptions, 'config'> {
  if (capabilities.length === 0) return {};
  const config: Record<string, unknown> = {};
  for (const capability of normalizeMcpHttpCapabilities(capabilities)) {
    config[`mcp_servers.${capability.name}`] = {
      url: capability.endpoint,
      required: true,
      default_tools_approval_mode: 'approve',
    };
  }
  return { config };
}

function latestAgentMessage(items: readonly unknown[]): string | undefined {
  for (const item of items.slice().reverse()) {
    const summary = agentMessage(object(item, 'turn item'));
    if (summary !== undefined) return summary;
  }
  return undefined;
}

function agentMessage(item: Record<string, unknown>): string | undefined {
  const type = item.type;
  return (type === 'agentMessage' || type === 'agent_message') && typeof item.text === 'string' && item.text.trim() !== ''
    ? item.text
    : undefined;
}

function parseHumanTakeover(summary: string | undefined): string | undefined {
  if (summary === undefined || !summary.startsWith(HUMAN_TAKEOVER_DIAGNOSTIC)) return undefined;
  const reason = summary.slice(HUMAN_TAKEOVER_DIAGNOSTIC.length).trim();
  return reason === '' ? 'A human browser takeover is required.' : reason;
}

/** Capability discovery must never become unbounded work. */
const APP_SERVER_MODEL_LIST_MAX_PAGES = 5;

class AppServerTimeoutError extends Error {
  constructor() { super('Codex App Server operation timed out.'); }
}
class AppServerCancelledError extends Error {
  constructor() { super('Codex App Server operation was cancelled.'); }
}

const APP_SERVER_INTERRUPT_GRACE_MS = 1_000;
const APP_SERVER_ACTIVE_TURN_POLL_MS = 25;

function runWithinDeadline<T>(operation: () => Promise<T>, deadlineAt: number, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new AppServerCancelledError());
  const timeoutMs = deadlineAt - Date.now();
  if (timeoutMs <= 0) return Promise.reject(new AppServerTimeoutError());
  try {
    return waitForNativeOperation(operation(), timeoutMs, signal);
  } catch (error) {
    return Promise.reject(error);
  }
}

function waitForNativeOperation<T>(operation: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new AppServerCancelledError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      complete();
    };
    timeout = setTimeout(() => finish(() => reject(new AppServerTimeoutError())), timeoutMs);
    const onAbort = () => finish(() => reject(new AppServerCancelledError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

function textInput(text: string) { return { type: 'text', text, text_elements: [] }; }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${label}.`); return value; }
