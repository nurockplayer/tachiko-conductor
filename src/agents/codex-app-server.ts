import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { assertWorkspaceGuard, type ImplementationAgent, type ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult, ExecutorIdentity } from '../domain/types.js';
import { NodeProcessRunner, type ProcessRunner } from '../github/transport.js';
import { CODEX_CLI_PROVIDER } from './codex-cli.js';

/** Provider identity is intentionally distinct from the compatible CLI fallback. */
export const CODEX_APP_SERVER_PROVIDER = 'codex-app-server';

export const CODEX_APP_SERVER_ERROR_CODE = {
  UNAVAILABLE: 'CODEX_APP_SERVER_UNAVAILABLE',
  PROTOCOL: 'CODEX_APP_SERVER_PROTOCOL',
  RECONCILIATION_BLOCKED: 'CODEX_APP_SERVER_RECONCILIATION_BLOCKED',
  OWNERSHIP_UNPROVEN: 'CODEX_APP_SERVER_OWNERSHIP_UNPROVEN',
  INVALID_EXECUTOR: 'CODEX_APP_SERVER_INVALID_EXECUTOR',
  HEAD_READ_FAILED: 'HEAD_READ_FAILED',
} as const;

export type AppServerLifecycleEvent =
  | { readonly type: 'thread_started'; readonly threadId: string }
  | { readonly type: 'turn_started'; readonly threadId: string; readonly turnId: string }
  | { readonly type: 'turn_completed'; readonly threadId: string; readonly turnId: string; readonly status: 'completed' | 'interrupted' | 'failed' }
  | { readonly type: 'item_completed'; readonly threadId: string; readonly itemId: string }
  | { readonly type: 'approval_denied'; readonly method: string };

export interface NativeThreadObservation {
  readonly threadId: string;
  readonly status: 'active' | 'idle' | 'not_loaded' | 'system_error';
  readonly activeTurnId?: string;
  /** Bounded native items for reconciliation. Raw transcripts are never persisted. */
  readonly history: readonly { readonly id: string; readonly type: string }[];
}

export interface CodexAppServerClient {
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
}

/** An unavailable binary/handshake is safe to route to the existing CLI adapter. */
export class AppServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerUnavailableError';
  }
}

export interface CodexAppServerClientFactory {
  open(): Promise<CodexAppServerClient>;
}

export interface CodexAppServerAdapterOptions {
  readonly clientFactory?: CodexAppServerClientFactory;
  readonly fallback?: ImplementationAgent;
  readonly runner?: ProcessRunner;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly model?: string;
  readonly reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy?: 'untrusted' | 'on-request' | 'never';
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

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? new StdioCodexAppServerClientFactory();
    this.fallback = options.fallback;
    this.runner = options.runner ?? new NodeProcessRunner();
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
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
    await assertWorkspaceGuard(request.workspaceGuard);
    let client: CodexAppServerClient;
    try {
      client = await this.clientFactory.open();
    } catch (error) {
      if (error instanceof AppServerUnavailableError) return this.runFallback(request);
      return failure(CODEX_APP_SERVER_ERROR_CODE.UNAVAILABLE, message(error), request.executor);
    }
    const startedAt = Date.now();
    const workspacePath = request.workspacePath ?? this.cwd;
    const options = { ...this.options, cwd: workspacePath };
    try {
      const prompt = buildPrompt(request);
      let threadId: string;
      if (request.executor === undefined) {
        threadId = await client.startThread(options);
      } else {
        const observation = await client.observeThread(request.executor.sessionId);
        if (observation.threadId !== request.executor.sessionId || observation.status === 'active' || observation.activeTurnId !== undefined) {
          return failure(
            CODEX_APP_SERVER_ERROR_CODE.RECONCILIATION_BLOCKED,
            'Native thread has an active or ambiguous writer; Tachiko observed it but will not resume, steer, or interrupt it.',
            request.executor,
          );
        }
        threadId = await client.resumeThread(request.executor.sessionId, options);
        if (threadId !== request.executor.sessionId) {
          return failure(CODEX_APP_SERVER_ERROR_CODE.RECONCILIATION_BLOCKED, 'Native resume returned a different thread identity.', request.executor);
        }
      }
      await assertWorkspaceGuard(request.workspaceGuard);
      const turnId = await client.startTurn(threadId, prompt);
      const terminal = await client.waitForTurn(threadId, turnId);
      const executor: ExecutorIdentity = {
        provider: CODEX_APP_SERVER_PROVIDER,
        sessionId: threadId,
        generation: request.runtimeOwnership.generation,
      };
      if (terminal.status !== 'completed') {
        return failure(CODEX_APP_SERVER_ERROR_CODE.PROTOCOL, `Codex App Server turn ${turnId} ended ${terminal.status}.`, executor);
      }
      await assertWorkspaceGuard(request.workspaceGuard, 'after-execution', executor);
      const headSha = await this.readHead(request.signal, workspacePath);
      if (headSha === null) return failure(CODEX_APP_SERVER_ERROR_CODE.HEAD_READ_FAILED, `Codex completed, but an exact 40-hex HEAD could not be read from ${workspacePath}.`, executor);
      return { exitStatus: 'success', summary: terminal.summary ?? 'Codex App Server turn completed.', headSha, executor, durationMs: Date.now() - startedAt };
    } catch (error) {
      return failure(CODEX_APP_SERVER_ERROR_CODE.PROTOCOL, message(error), request.executor);
    } finally {
      await client.close();
    }
  }

  /** Side-effect-free native observation; it never starts or resumes a turn. */
  async observeRuntime(executor: ExecutorIdentity): Promise<NativeThreadObservation> {
    if (!isAppServerExecutor(executor)) throw new Error('Native observation requires a Codex App Server executor identity.');
    const client = await this.clientFactory.open();
    try { return await client.observeThread(executor.sessionId); } finally { await client.close(); }
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
    const client = await this.clientFactory.open();
    try {
      const observation = await client.observeThread(request.executor.sessionId);
      if (observation.status !== 'active' || observation.activeTurnId !== turnId) {
        throw new Error('Native active-turn control refused: the observed active turn does not match the expected turn.');
      }
      return await action(client, request.executor);
    } finally { await client.close(); }
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

function failure(code: string, detail: string, executor?: ExecutorIdentity): AgentResult {
  return { exitStatus: 'failure', summary: detail, diagnostics: [`${code}: ${detail}`], ...(executor === undefined ? {} : { executor }) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildPrompt(request: ImplementationRequest): string {
  const instructions = request.authority === 'live-target' ? request.supplementalInstructions : request.instructions;
  return [
    `Implement ${request.target.kind === 'issue' ? `${request.target.owner}/${request.target.repo}#${request.target.issueNumber}` : `${request.target.owner}/${request.target.repo}@${request.target.branch}`} from base ${request.baseSha}.`,
    'Read the live target and repository-local instructions as authority.',
    'Run repository-required validation before reporting success.',
    instructions,
  ].filter((line): line is string => line !== undefined && line !== '').join('\n');
}

/** Actual local-only JSON-RPC App Server client. No TCP listener is created. */
export class StdioCodexAppServerClientFactory implements CodexAppServerClientFactory {
  async open(): Promise<CodexAppServerClient> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('codex', ['app-server', '--stdio'], { stdio: 'pipe' });
    } catch (error) {
      throw new AppServerUnavailableError(message(error));
    }
    const client = new StdioCodexAppServerClient(child);
    try {
      await client.initialize();
      return client;
    } catch (error) {
      await client.close();
      throw new AppServerUnavailableError(message(error));
    }
  }
}

class StdioCodexAppServerClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: AppServerLifecycleEvent) => void>();
  private readonly completedTurns = new Map<string, { status: 'completed' | 'interrupted' | 'failed'; summary?: string }>();
  private readonly turnWaiters = new Map<string, { resolve(value: { status: 'completed' | 'interrupted' | 'failed'; summary?: string }): void; reject(error: Error): void }>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    child.on('error', (error) => this.rejectAll(error));
    child.on('exit', (code) => { if (!this.closed) this.rejectAll(new Error(`Codex App Server exited before completing RPC work (${code ?? 'signal'}).`)); });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'tachiko-conductor', title: 'Tachiko Conductor', version: '0.1.0' }, capabilities: null });
    this.notify('initialized');
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

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex App Server client is closed.'));
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  private receive(line: string): void {
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(line), 'JSON-RPC message'); } catch { return; }
    if (typeof value.id === 'number' && typeof value.method !== 'string') {
      const pending = this.pending.get(value.id);
      if (pending === undefined) return;
      this.pending.delete(value.id);
      if (value.error !== undefined) pending.reject(new Error(`App Server RPC error: ${JSON.stringify(value.error)}`));
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.id === 'number' && typeof value.method === 'string') {
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
      const status = rawStatus === 'completed' || rawStatus === 'interrupted' || rawStatus === 'failed' ? rawStatus : 'failed';
      const complete = { status } as { status: 'completed' | 'interrupted' | 'failed'; summary?: string };
      this.completedTurns.set(turnId, complete);
      this.turnWaiters.get(turnId)?.resolve(complete);
      this.turnWaiters.delete(turnId);
      this.emit({ type: 'turn_completed', threadId: string(params.threadId, 'thread id'), turnId, status });
    }
    if (method === 'item/completed') {
      const item = object(params.item, 'item/completed item');
      this.emit({ type: 'item_completed', threadId: string(params.threadId, 'thread id'), itemId: string(item.id, 'item id') });
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

function threadParams(options: AppServerThreadOptions): Record<string, unknown> {
  return {
    cwd: options.cwd,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { config: { model_reasoning_effort: options.reasoningEffort } }),
    ...(options.sandboxMode === undefined ? {} : { sandbox: options.sandboxMode }),
    ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
  };
}

function textInput(text: string) { return { type: 'text', text, text_elements: [] }; }
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value as Record<string, unknown>; }
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`); return value; }
function string(value: unknown, label: string): string { if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${label}.`); return value; }
