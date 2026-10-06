import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  AppServerUnavailableError,
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  StdioCodexAppServerClient,
  StdioCodexAppServerClientFactory,
  type AppServerThreadOptions,
  type AppServerMutationOptions,
  type AppServerOpenOptions,
  type AppServerModelDescriptor,
  type AppServerLifecycleEvent,
  type CodexAppServerClient,
  type CodexAppServerClientFactory,
  type NativeThreadObservation,
} from '../src/agents/codex-app-server.js';
import { ExecutionAdmissionRefusal, GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED, GOVERNED_PUBLICATION_REENTRY_ACTION, WorkspaceGuardFailure, type ImplementationAgent, type ImplementationRequest } from '../src/adapters/agent.js';
import { EXECUTION_CONFIGURATION_ERROR_CODE } from '../src/execution-profiles.js';
import type { AgentResult } from '../src/domain/types.js';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

const HEAD = 'a'.repeat(40);
const EXECUTOR = { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'thread-1', generation: 'generation-1' } as const;
const OWNERSHIP = { runId: 'run-1', generation: 'generation-1', dispatchClaimId: 'claim-1' } as const;

class HeadRunner implements ProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options: ProcessRunOptions }> = [];
  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    return { stdout: `${HEAD}\n`, stderr: '', exitCode: 0 };
  }
}

class FakeClient implements CodexAppServerClient {
  readonly calls: string[] = [];
  readonly prompts: string[] = [];
  readonly threadOptions: AppServerThreadOptions[] = [];
  private readonly listeners = new Set<(event: AppServerLifecycleEvent) => void>();
  constructor(private observation: NativeThreadObservation = { threadId: 'thread-1', status: 'idle', history: [] }) {}
  async observeThread(threadId: string): Promise<NativeThreadObservation> { this.calls.push(`read:${threadId}`); return this.observation; }
  async startThread(options: AppServerThreadOptions, hostOptions: AppServerMutationOptions = {}): Promise<string> { hostOptions.beforeExecution?.(); this.threadOptions.push(options); this.calls.push('thread/start'); return 'thread-new'; }
  async resumeThread(threadId: string, options: AppServerThreadOptions, hostOptions: AppServerMutationOptions = {}): Promise<string> { hostOptions.beforeExecution?.(); this.threadOptions.push(options); this.calls.push(`thread/resume:${threadId}`); return threadId; }
  async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> { hostOptions.beforeExecution?.(); this.prompts.push(prompt); this.calls.push(`turn/start:${threadId}`); return 'turn-1'; }
  async steerTurn(threadId: string, turnId: string, _prompt?: string, hostOptions: AppServerMutationOptions = {}): Promise<string> { hostOptions.beforeExecution?.(); this.calls.push(`turn/steer:${threadId}:${turnId}`); return turnId; }
  async interruptTurn(threadId: string, turnId: string, hostOptions: AppServerMutationOptions = {}): Promise<void> { hostOptions.beforeExecution?.(); this.calls.push(`turn/interrupt:${threadId}:${turnId}`); }
  async waitForTurn(): Promise<{ status: 'completed' | 'failed' | 'interrupted'; summary: string }> { this.calls.push('wait'); return { status: 'completed', summary: 'done' }; }
  onEvent(listener: (event: AppServerLifecycleEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.calls.push('close'); }
  emitEvent(event: AppServerLifecycleEvent): void { for (const listener of this.listeners) listener(event); }
}

class Factory implements CodexAppServerClientFactory {
  opens = 0;
  constructor(readonly client: FakeClient) {}
  async open(options: AppServerOpenOptions = {}): Promise<CodexAppServerClient> { this.opens += 1; options.beforeExecution?.(); return this.client; }
}

class DiscoveringClient extends FakeClient {
  constructor(private readonly models: readonly AppServerModelDescriptor[] | Error) { super(); }
  async listModels(): Promise<readonly AppServerModelDescriptor[]> {
    if (this.models instanceof Error) throw this.models;
    return this.models;
  }
  /** Every call that would start or resume model work. */
  get modelTurnCalls(): readonly string[] {
    return this.calls.filter((call) => call.startsWith('turn/start:') || call.startsWith('thread/resume:'));
  }
}

class UsageClient extends FakeClient {
  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    const turnId = await super.startTurn(threadId, prompt, hostOptions);
    this.emitEvent({ type: 'turn_started', threadId, turnId });
    this.emitEvent({ type: 'item_completed', threadId, itemId: 'tool-1', toolResultBytes: 321 });
    this.emitEvent({
      type: 'turn_completed', threadId, turnId, status: 'completed',
      usage: { inputTokens: 2_000, cachedInputTokens: 1_500, outputTokens: 80, reasoningTokens: 20 },
    });
    return turnId;
  }
}

class HangingClient extends FakeClient {
  override async waitForTurn(): Promise<{ status: 'completed'; summary: string }> {
    this.calls.push('wait');
    return new Promise(() => {});
  }
}

class HangingCloseClient extends FakeClient {
  override async close(): Promise<void> {
    this.calls.push('close');
    return new Promise(() => {});
  }
}

class HangingStartThreadClient extends FakeClient {
  override async startThread(_options: AppServerThreadOptions, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.calls.push('thread/start');
    return new Promise(() => {});
  }
}

class HangingStartTurnClient extends FakeClient {
  constructor(private readonly observedTurnId: string | undefined = undefined) { super(); }

  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    if (this.observedTurnId !== undefined) {
      this.emitEvent({ type: 'turn_started', threadId, turnId: this.observedTurnId });
    }
    return new Promise(() => {});
  }
}

class HangingCloseStartTurnClient extends HangingStartTurnClient {
  override async close(): Promise<void> {
    this.calls.push('close');
    return new Promise(() => {});
  }
}

class ProtocolAndCloseFailureClient extends FakeClient {
  override async waitForTurn(): Promise<{ status: 'failed'; summary: string }> {
    this.calls.push('wait');
    return { status: 'failed', summary: 'provider reported failure' };
  }
  override async close(): Promise<void> {
    this.calls.push('close');
    throw new Error('close transport failed');
  }
}

class DelayedStartTurnClient extends FakeClient {
  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    return new Promise(() => {});
  }

  override async observeThread(threadId: string): Promise<NativeThreadObservation> {
    this.calls.push(`read:${threadId}`);
    return { threadId, status: 'active', activeTurnId: 'turn-delayed', history: [] };
  }
}

class LateNotificationClient extends FakeClient {
  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    setImmediate(() => {
      this.emitEvent({ type: 'turn_started', threadId, turnId: 'turn-late-notification' });
      this.emitEvent({ type: 'turn_completed', threadId, turnId: 'foreign-completed-notification', status: 'completed' });
    });
    return new Promise(() => {});
  }
}

class AbortReleasedStartTurnClient extends FakeClient {
  constructor(private readonly controller: AbortController) { super(); }

  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    return await new Promise<string>((resolve) => {
      this.controller.signal.addEventListener('abort', () => {
        this.calls.push('original-response-after-cancel');
        resolve('late-original-turn');
      }, { once: true });
    });
  }
  override async waitForTurn(): Promise<{ status: 'completed'; summary: string }> {
    this.calls.push('wait');
    return new Promise(() => {});
  }
}

class ForeignTurnEvidenceClient extends FakeClient {
  override async startTurn(threadId: string, prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
    hostOptions.beforeExecution?.();
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    this.emitEvent({ type: 'turn_started', threadId, turnId: 'foreign-start' });
    const ownTurnId = 'owned-response-turn';
    setImmediate(() => this.emitEvent({ type: 'turn_completed', threadId, turnId: 'foreign-completion', status: 'completed' }));
    return ownTurnId;
  }
  override async waitForTurn(): Promise<{ status: 'completed'; summary: string }> {
    this.calls.push('wait');
    return new Promise(() => {});
  }
}

class HangingObserveClient extends FakeClient {
  override async observeThread(threadId: string): Promise<NativeThreadObservation> {
    this.calls.push(`read:${threadId}`);
    return new Promise(() => {});
  }
}

class HangingFactory implements CodexAppServerClientFactory {
  async open(_options?: AppServerOpenOptions): Promise<CodexAppServerClient> {
    return new Promise(() => {});
  }
}

class Fallback implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  calls = 0;
  async run(_request: ImplementationRequest): Promise<AgentResult> { this.calls += 1; return { exitStatus: 'success', summary: 'cli fallback', headSha: HEAD }; }
}

function request(extra: Partial<ImplementationRequest> = {}): ImplementationRequest {
  return { target: TARGET, baseSha: 'base', workspacePath: '/tmp/worktree', runtimeOwnership: OWNERSHIP, ...extra };
}

async function waitForCall(client: FakeClient, call: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (client.calls.includes(call)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for App Server call ${call}.`);
}

describe('CodexAppServerAdapter', () => {
  it('refuses governed App Server and CLI-fallback execution before opening either transport', async () => {
    const client = new FakeClient();
    const factory = new Factory(client);
    const fallback = new Fallback();
    const executor = { provider: 'codex-app-server', sessionId: 'durable-thread', generation: 'run-generation' } as const;
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner() });

    const result = await adapter.run({
      ...request({ executor, runtimeOwnership: { runId: 'run-1', generation: 'run-generation' } }),
      governedPublication: { required: true, continuation: true },
    });

    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', new RegExp(GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED));
    assert.deepEqual(result.executor, executor);
    assert.equal(factory.opens, 0);
    assert.equal(fallback.calls, 0);
    assert.deepEqual(client.calls, []);
  });

  it('uses initialize-capable native observation before terminal resume, then starts exactly one next turn', async () => {
    const client = new FakeClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const result = await adapter.run(request({ executor: EXECUTOR }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.executor, EXECUTOR);
    assert.deepEqual(client.calls, ['read:thread-1', 'thread/resume:thread-1', 'turn/start:thread-1', 'wait', 'close']);
  });

  it('observes an active native thread but refuses ambiguous restart recovery without a new turn', async () => {
    const client = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'foreign-turn', history: [] });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const result = await adapter.run(request({ executor: EXECUTOR }));
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /RECONCILIATION_BLOCKED/);
    assert.deepEqual(client.calls, ['read:thread-1', 'close']);
  });

  it('requires matching durable executor-generation ownership before opening a native runtime', async () => {
    const factory = new Factory(new FakeClient());
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, runner: new HeadRunner() });
    const result = await adapter.run(request({ executor: EXECUTOR, runtimeOwnership: { runId: 'run-1', generation: 'newer-generation' } }));
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /OWNERSHIP_UNPROVEN/);
    assert.equal(factory.opens, 0);
  });

  it('refuses governed steering before opening or observing either transport for fresh and continued requests', async () => {
    for (const continuation of [false, true]) {
      const client = new FakeClient({ threadId: 'durable-thread', status: 'active', activeTurnId: 'turn-1', history: [] });
      const factory = new Factory(client);
      const fallback = new Fallback();
      const runner = new HeadRunner();
      const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner });
      const executor = { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'durable-thread', generation: 'run-generation' } as const;
      const ownership = { runId: 'run-1', generation: 'run-generation', dispatchClaimId: 'claim-1' } as const;
      const workspaceGuard = { assertValid() { throw new Error('steering must be refused before the guard'); } };
      const steerRequest = request({ executor, sessionId: executor.sessionId, runtimeOwnership: ownership, workspaceGuard,
        governedPublication: { required: true, continuation } });

      await assert.rejects(
        () => adapter.steerActiveTurn(steerRequest, 'turn-1', 'please continue'),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, new RegExp(GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED));
          assert.ok(error.message.includes(GOVERNED_PUBLICATION_REENTRY_ACTION));
          return true;
        },
      );
      assert.equal(factory.opens, 0);
      assert.deepEqual(client.calls, []);
      assert.deepEqual(runner.calls, []);
      assert.equal(fallback.calls, 0);
      assert.deepEqual(steerRequest.executor, executor);
      assert.deepEqual(steerRequest.runtimeOwnership, ownership);
    }
  });

  it('allows exact owned active-turn steer and interrupt but rejects a foreign expected turn', async () => {
    const client = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    assert.equal(await adapter.steerActiveTurn(request({ executor: EXECUTOR }), 'turn-1', 'please stop'), 'turn-1');
    await adapter.interruptActiveTurn(request({ executor: EXECUTOR }), 'turn-1');
    await assert.rejects(() => adapter.interruptActiveTurn(request({ executor: EXECUTOR }), 'different-turn'), /does not match/);
    assert.deepEqual(client.calls, [
      'read:thread-1', 'turn/steer:thread-1:turn-1', 'close',
      'read:thread-1', 'turn/interrupt:thread-1:turn-1', 'close',
      'read:thread-1', 'close',
    ]);
  });

  it('keeps exact owned governed interrupt usable without steering, starting, or resuming a turn', async () => {
    const client = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const factory = new Factory(client);
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, runner: new HeadRunner() });
    let guardCalls = 0; let executionChecks = 0;
    const governedRequest = request({
      executor: EXECUTOR,
      governedPublication: { required: true, continuation: true },
      workspaceGuard: { assertValid() { guardCalls += 1; } },
      beforeExecution() { executionChecks += 1; },
    });

    await adapter.interruptActiveTurn(governedRequest, 'turn-1');
    assert.equal(factory.opens, 1);
    assert.equal(guardCalls, 1);
    assert.equal(executionChecks, 2, 'governed interrupt checks both component entry and the actual mutation');
    assert.deepEqual(client.calls, ['read:thread-1', 'turn/interrupt:thread-1:turn-1', 'close']);
    assert.equal(client.calls.some((call) => call.startsWith('turn/steer:') || call.startsWith('turn/start:') || call.startsWith('thread/resume:')), false);
  });

  it('keeps the tagged execution refusal primary across bounded hanging component cleanup and never falls back', async () => {
    const client = new HangingCloseClient();
    const factory = new Factory(client);
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner() });
    const refusal = new ExecutionAdmissionRefusal('the durable Run was superseded at worker entry', true);
    let checks = 0;
    const startedAt = Date.now();
    let thrown: unknown;
    try {
      await adapter.run(request({ beforeExecution() { if (++checks === 2) throw refusal; } }));
    } catch (error) { thrown = error; }
    assert.ok(thrown instanceof ExecutionAdmissionRefusal);
    assert.equal(thrown.runSuperseded, true);
    assert.equal(thrown.cause, refusal);
    assert.match(thrown.message, /cleanup remains uncertain/i);
    assert.equal(fallback.calls, 0);
    assert.ok(Date.now() - startedAt < 1_500, 'a hung close is bounded independently');
  });

  it('refuses a governed exact-owned interrupt with no host callback before opening the component', async () => {
    const client = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const factory = new Factory(client);
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, runner: new HeadRunner() });
    await assert.rejects(
      () => adapter.interruptActiveTurn(request({ executor: EXECUTOR, governedPublication: { required: true, continuation: true } }), 'turn-1'),
      /final host execution-boundary callback is missing/i,
    );
    assert.equal(factory.opens, 0);
    assert.deepEqual(client.calls, []);
  });

  it('keeps governed interrupt behind exact ownership, active-turn, and workspace checks', async () => {
    const cases = [
      { name: 'missing ownership', extra: { executor: EXECUTOR, runtimeOwnership: undefined }, observation: { threadId: 'thread-1', status: 'active' as const, activeTurnId: 'turn-1', history: [] }, expected: /ownership fence/ },
      { name: 'mismatched generation', extra: { executor: EXECUTOR, runtimeOwnership: { runId: 'run-1', generation: 'other-generation' } }, observation: { threadId: 'thread-1', status: 'active' as const, activeTurnId: 'turn-1', history: [] }, expected: /ownership fence/ },
      { name: 'wrong active turn', extra: { executor: EXECUTOR, runtimeOwnership: OWNERSHIP }, observation: { threadId: 'thread-1', status: 'active' as const, activeTurnId: 'foreign-turn', history: [] }, expected: /does not match/ },
    ];
    for (const entry of cases) {
      const client = new FakeClient(entry.observation);
      const factory = new Factory(client);
      const adapter = new CodexAppServerAdapter({ clientFactory: factory, runner: new HeadRunner() });
      await assert.rejects(
        () => adapter.interruptActiveTurn(request({ ...entry.extra, governedPublication: { required: true, continuation: true }, beforeExecution() {} }), 'turn-1'),
        entry.expected,
        entry.name,
      );
      assert.deepEqual(client.calls, entry.name === 'missing ownership' || entry.name === 'mismatched generation'
        ? []
        : ['read:thread-1', 'close']);
      assert.equal(client.calls.some((call) => call.startsWith('turn/interrupt:')), false);
    }

    const guardedClient = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const guardedAdapter = new CodexAppServerAdapter({ clientFactory: new Factory(guardedClient), runner: new HeadRunner() });
    await assert.rejects(
      () => guardedAdapter.interruptActiveTurn(request({
        executor: EXECUTOR,
        governedPublication: { required: true, continuation: true },
        beforeExecution() {},
        workspaceGuard: { assertValid() { throw new WorkspaceGuardFailure('workspace changed'); } },
      }), 'turn-1'),
      WorkspaceGuardFailure,
    );
    assert.deepEqual(guardedClient.calls, ['read:thread-1', 'close']);
  });

  it('rechecks the workspace guard after observing an active turn and before steering or interrupting it', async () => {
    const client = new FakeClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    let guardCalls = 0;
    const workspaceGuard = {
      assertValid: () => {
        guardCalls += 1;
        assert.equal(client.calls.includes('read:thread-1'), true);
        throw new Error('workspace HEAD changed');
      },
    };

    await assert.rejects(
      () => adapter.steerActiveTurn(request({ executor: EXECUTOR, workspaceGuard }), 'turn-1', 'please stop'),
      WorkspaceGuardFailure,
    );
    await assert.rejects(
      () => adapter.interruptActiveTurn(request({ executor: EXECUTOR, workspaceGuard }), 'turn-1'),
      WorkspaceGuardFailure,
    );
    assert.equal(guardCalls, 2);
    assert.deepEqual(client.calls, ['read:thread-1', 'close', 'read:thread-1', 'close']);
  });

  it('keeps the existing Codex CLI adapter as the only fallback for unavailable App Server startup', async () => {
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: { open: async () => { throw new AppServerUnavailableError('not installed'); } }, fallback, runner: new HeadRunner() });
    const result = await adapter.run(request());
    assert.equal(result.summary, 'cli fallback');
    assert.equal(fallback.calls, 1);
  });

  it('checks injected native factories after asynchronous preparation and skips child entry on revocation', async () => {
    const client = new FakeClient();
    const fallback = new Fallback();
    let opened = 0;
    let announceOpen!: () => void;
    let releasePreparation!: () => void;
    const openStarted = new Promise<void>((resolve) => { announceOpen = resolve; });
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const refusal = new ExecutionAdmissionRefusal('Run was replaced during native preparation', true);
    const factory: CodexAppServerClientFactory = {
      async open(options = {}) {
        opened += 1;
        announceOpen();
        await preparation;
        options.beforeExecution?.();
        return client;
      },
    };
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner() });
    const pending = adapter.run(request({ beforeExecution: () => { throw refusal; } }));
    await openStarted;
    releasePreparation();
    await assert.rejects(() => pending, (error: unknown) => error === refusal);
    assert.equal(opened, 1);
    assert.deepEqual(client.calls, []);
    assert.equal(fallback.calls, 0);
  });

  it('closes opening admission before timeout or request abort reaches a resumed factory', async () => {
    for (const mode of ['timeout', 'cancel'] as const) {
      let announceOpen!: () => void;
      let announceCallbackAttempt!: () => void;
      const openStarted = new Promise<void>((resolve) => { announceOpen = resolve; });
      const callbackAttempted = new Promise<void>((resolve) => { announceCallbackAttempt = resolve; });
      const client = new FakeClient();
      let spawnCount = 0;
      let callbackAttempts = 0;
      const factory: CodexAppServerClientFactory = {
        open(options = {}) {
          announceOpen();
          return new Promise<CodexAppServerClient>((resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              callbackAttempts += 1;
              announceCallbackAttempt();
              try {
                options.beforeExecution?.();
                spawnCount += 1;
                resolve(client);
              } catch (error) { reject(error); }
            }, { once: true });
          });
        },
      };
      const controller = new AbortController();
      const fallback = new Fallback();
      const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner(), timeoutMs: 25 });
      const originalNow = Date.now;
      Date.now = () => 4_000_000;
      try {
        const pending = adapter.run(request({ signal: controller.signal }));
        await openStarted;
        if (mode === 'cancel') controller.abort();
        await callbackAttempted;
        assert.equal(callbackAttempts, 1, `${mode} reaches the host callback during the factory abort event`);
        assert.equal(spawnCount, 0, `${mode} closes admission before the factory can spawn`);
        const result = await pending;
        assert.equal(result.exitStatus, 'failure');
        assert.match(result.diagnostics?.join('\n') ?? '', mode === 'timeout' ? /CODEX_APP_SERVER_TIMEOUT/ : /CODEX_APP_SERVER_CANCELLED/);
        assert.equal(fallback.calls, 0);
      } finally {
        Date.now = originalNow;
      }
    }
  });

  it('selects the synchronous tagged refusal when the host callback aborts before waiter registration', async () => {
    const controller = new AbortController();
    const client = new FakeClient();
    let opens = 0;
    let actualSpawnCount = 0;
    const refusalCause = new Error('registry proof changed during open');
    const refusal = new ExecutionAdmissionRefusal('Run was superseded during native open', false, { cause: refusalCause, authorityUnknown: true });
    const factory: CodexAppServerClientFactory = {
      async open(options = {}) {
        opens += 1;
        options.beforeExecution?.();
        actualSpawnCount += 1;
        return client;
      },
    };
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner() });
    const onUnhandled = (reason: unknown) => assert.fail(`unexpected unhandled rejection: ${String(reason)}`);
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        () => adapter.run(request({ signal: controller.signal, beforeExecution() { controller.abort(); throw refusal; } })),
        (error: unknown) => {
          assert.equal(error, refusal);
          assert.equal(error.runSuperseded, false);
          assert.equal(error.authorityUnknown, true);
          assert.equal(error.cause, refusalCause);
          return true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(opens, 1);
      assert.equal(actualSpawnCount, 0);
      assert.deepEqual(client.calls, []);
      assert.equal(fallback.calls, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('preserves an in-flight tagged control refusal when its callback synchronously aborts', async () => {
    let announcePreparation!: () => void;
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { announcePreparation = resolve; });
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const controller = new AbortController();
    const refusalCause = new Error('registry proof changed at steer write');
    const refusal = new ExecutionAdmissionRefusal('Run was superseded at native steer write', false, { cause: refusalCause, authorityUnknown: true });
    class AbortThenRefuseClient extends FakeClient {
      override async steerTurn(threadId: string, turnId: string, _prompt?: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
        announcePreparation();
        await preparation;
        hostOptions.beforeExecution?.();
        this.calls.push(`turn/steer:${threadId}:${turnId}`);
        return 'steered';
      }
    }
    const client = new AbortThenRefuseClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5_000 });
    const onUnhandled = (reason: unknown) => assert.fail(`unexpected unhandled rejection: ${String(reason)}`);
    let callbackChecks = 0;
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = adapter.steerActiveTurn(request({ executor: EXECUTOR, signal: controller.signal, beforeExecution() { if (++callbackChecks === 2) { controller.abort(); throw refusal; } } }), 'turn-1', 'stop safely');
      await preparationStarted;
      releasePreparation();
      await assert.rejects(() => pending, (error: unknown) => {
        assert.equal(error, refusal);
        assert.equal((error as ExecutionAdmissionRefusal).runSuperseded, false);
        assert.equal((error as ExecutionAdmissionRefusal).authorityUnknown, true);
        assert.equal((error as ExecutionAdmissionRefusal).cause, refusalCause);
        return true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(client.calls, ['read:thread-1', 'close'], 'the callback refusal blocks the actual control write');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('preserves tagged refusal, uncertain interrupt, and uncertain component close together', async () => {
    const client = new HangingCloseClient();
    const fallback = new Fallback();
    const refusal = new ExecutionAdmissionRefusal('authority was revoked before turn start', false, { authorityUnknown: true });
    let checks = 0;
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), fallback, runner: new HeadRunner() });
    const startedAt = Date.now();
    await assert.rejects(
      () => adapter.run(request({ beforeExecution() { if (++checks === 3) throw refusal; } })),
      (error: unknown) => {
        assert.ok(error instanceof ExecutionAdmissionRefusal);
        assert.equal(error.runSuperseded, false);
        assert.equal(error.authorityUnknown, true);
        assert.match(error.message, /Native turn cleanup is uncertain \(unknown\)/);
        assert.match(error.message, /component close did not settle/i);
        assert.ok(error.cause instanceof ExecutionAdmissionRefusal);
        assert.equal(error.cause.cause, refusal);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_500, 'interrupt and close cleanup stayed bounded');
    assert.equal(fallback.calls, 0);
    assert.deepEqual(client.calls, ['thread/start', 'close']);
  });

  it('rechecks an injected mutation after its asynchronous preparation and writes no start operation', async () => {
    let announcePreparation!: () => void;
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { announcePreparation = resolve; });
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    class PreparedMutationClient extends FakeClient {
      override async startThread(options: AppServerThreadOptions, hostOptions: AppServerMutationOptions = {}): Promise<string> {
        announcePreparation();
        await preparation;
        hostOptions.beforeExecution?.();
        this.threadOptions.push(options);
        this.calls.push('thread/start');
        return 'thread-new';
      }
    }
    const client = new PreparedMutationClient();
    const factory = new Factory(client);
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner() });
    const refusal = new ExecutionAdmissionRefusal('Run changed during native mutation preparation', true);
    let checks = 0;
    const pending = adapter.run(request({ beforeExecution() { if (++checks === 2) throw refusal; } }));
    await preparationStarted;
    releasePreparation();
    await assert.rejects(() => pending, (error: unknown) => error === refusal || (error instanceof ExecutionAdmissionRefusal && error.cause === refusal));
    assert.deepEqual(client.calls, ['close']);
    assert.equal(fallback.calls, 0);
  });

  it('bounds a stalled native turn by the selected execution timeout', async () => {
    const client = new HangingClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'wait', 'turn/interrupt:thread-new:turn-1', 'close']);
  });

  it('preserves timeout, known executor, and unknown-turn cleanup through a failed close', async () => {
    const client = new HangingCloseStartTurnClient();
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), fallback, runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.deepEqual(result.executor, { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'thread-new', generation: OWNERSHIP.generation });
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.match(result.diagnostics?.join('\n') ?? '', /identity was not correlated/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /component close did not settle/i);
    assert.equal(result.headSha, undefined);
    assert.equal(fallback.calls, 0);
  });

  it('preserves protocol failure context when component close throws', async () => {
    const client = new ProtocolAndCloseFailureClient();
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), fallback, runner: new HeadRunner() });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.deepEqual(result.executor, { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'thread-new', generation: OWNERSHIP.generation });
    assert.match(result.summary, /turn turn-1 ended failed/i);
    assert.match(result.summary, /component close did not settle/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /close transport failed/i);
    assert.equal(result.headSha, undefined);
    assert.equal(fallback.calls, 0);
  });

  it('starts no turn when cancellation or deadline wins during the awaited workspace guard', async () => {
    for (const mode of ['cancel', 'timeout'] as const) {
      const client = new FakeClient();
      const controller = new AbortController();
      let guardCalls = 0;
      let announceGuard!: () => void;
      let releaseGuard!: () => void;
      let announceGuardSettled!: () => void;
      const guardEntered = new Promise<void>((resolve) => { announceGuard = resolve; });
      const guardPending = new Promise<void>((resolve) => { releaseGuard = resolve; });
      const guardSettled = new Promise<void>((resolve) => { announceGuardSettled = resolve; });
      const workspaceGuard = {
        assertValid() {
          if (++guardCalls !== 2) return;
          announceGuard();
          return guardPending.then(() => { announceGuardSettled(); });
        },
      };
      const fallback = new Fallback();
      const adapter = new CodexAppServerAdapter({
        clientFactory: new Factory(client), fallback, runner: new HeadRunner(), timeoutMs: mode === 'timeout' ? 25 : 5,
      });
      const originalNow = Date.now;
      Date.now = () => 1_000_000;
      try {
        const pending = adapter.run(request({ signal: controller.signal, workspaceGuard }));
        await guardEntered;
        if (mode === 'cancel') controller.abort();
        const result = await pending;
        assert.equal(result.exitStatus, 'failure');
        assert.match(result.diagnostics?.join('\n') ?? '', mode === 'cancel' ? /CODEX_APP_SERVER_CANCELLED/ : /CODEX_APP_SERVER_TIMEOUT/);
        releaseGuard();
        await guardSettled;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(client.calls, ['thread/start', 'close']);
        assert.equal(result.executor?.sessionId, 'thread-new');
        assert.equal(fallback.calls, 0);
      } finally {
        Date.now = originalNow;
      }
    }
  });

  it('keeps a timed-out native start callback closed across delayed injected preparation', async () => {
    let announcePreparation!: () => void;
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { announcePreparation = resolve; });
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    class DelayedPreparedTurnClient extends FakeClient {
      override async startTurn(threadId: string, _prompt: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
        announcePreparation();
        await preparation;
        hostOptions.beforeExecution?.();
        this.calls.push(`turn/start:${threadId}`);
        return 'turn-late';
      }
    }
    const client = new DelayedPreparedTurnClient();
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), fallback, runner: new HeadRunner(), timeoutMs: 25 });
    const originalNow = Date.now;
    Date.now = () => 2_000_000;
    const onUnhandled = (reason: unknown) => assert.fail(`unexpected unhandled rejection: ${String(reason)}`);
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = adapter.run(request());
      await preparationStarted;
      const result = await pending;
      const selectedSummary = result.summary;
      const selectedDiagnostics = result.diagnostics?.join('\n');
      assert.equal(result.exitStatus, 'failure');
      assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
      assert.match(result.diagnostics?.join('\n') ?? '', /identity was not correlated/i);
      assert.deepEqual(client.calls, ['thread/start', 'close']);
      releasePreparation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(client.calls, ['thread/start', 'close'], 'late preparation cannot pass the closed host boundary');
      assert.equal(result.summary, selectedSummary, 'a late operation rejection cannot rewrite the selected timeout result');
      assert.equal(result.diagnostics?.join('\n'), selectedDiagnostics);
      assert.equal(result.executor?.sessionId, 'thread-new');
      assert.equal(fallback.calls, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      Date.now = originalNow;
    }
  });

  it('keeps an explicit control callback closed when preparation finishes after timeout cleanup', async () => {
    let announcePreparation!: () => void;
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => { announcePreparation = resolve; });
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    class DelayedPreparedControlClient extends FakeClient {
      override async steerTurn(threadId: string, turnId: string, _prompt?: string, hostOptions: AppServerMutationOptions = {}): Promise<string> {
        announcePreparation();
        await preparation;
        hostOptions.beforeExecution?.();
        this.calls.push(`turn/steer:${threadId}:${turnId}`);
        return 'steered';
      }
    }
    const client = new DelayedPreparedControlClient({ threadId: 'thread-1', status: 'active', activeTurnId: 'turn-1', history: [] });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 25 });
    const originalNow = Date.now;
    Date.now = () => 3_000_000;
    try {
      const pending = adapter.steerActiveTurn(request({ executor: EXECUTOR }), 'turn-1', 'stop safely');
      await preparationStarted;
      await assert.rejects(() => pending, /timed out/i);
      assert.deepEqual(client.calls, ['read:thread-1', 'close']);
      releasePreparation();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(client.calls, ['read:thread-1', 'close'], 'late explicit-control preparation cannot write after close');
    } finally {
      Date.now = originalNow;
    }
  });

  it('bounds a stalled thread/start RPC', async () => {
    const client = new HangingStartThreadClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.deepEqual(client.calls, ['thread/start', 'close']);
  });

  it('bounds a stalled App Server handshake by the selected execution timeout', async () => {
    const adapter = new CodexAppServerAdapter({ clientFactory: new HangingFactory(), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
  });

  it('cancels a stalled App Server handshake when the selected execution is aborted', async () => {
    const adapter = new CodexAppServerAdapter({ clientFactory: new HangingFactory(), runner: new HeadRunner() });
    const controller = new AbortController();
    const pending = adapter.run(request({ signal: controller.signal }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await pending;
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_CANCELLED/);
  });

  it('reports late-open cleanup uncertainty and disposes a client that resolves after timeout', async () => {
    const client = new HangingCloseClient();
    const fallback = new Fallback();
    let announceOpen!: () => void;
    let releaseOpen!: () => void;
    const openStarted = new Promise<void>((resolve) => { announceOpen = resolve; });
    const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const factory: CodexAppServerClientFactory = {
      async open() {
        announceOpen();
        await opening;
        return client;
      },
    };
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, fallback, runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /opening or component cleanup remains unconfirmed/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /late component may still open/i);
    assert.equal(fallback.calls, 0);
    await openStarted;
    releaseOpen();
    for (let attempt = 0; attempt < 20 && !client.calls.includes('close'); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    assert.deepEqual(client.calls, ['close'], 'late client disposal begins independently after its resolution');
  });

  it('does not treat an unknown same-thread turn-start notification as invocation ownership', async () => {
    const client = new HangingStartTurnClient('turn-observed');
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.match(result.diagnostics?.join('\n') ?? '', /identity was not correlated|uncertain/i);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'close']);
  });

  it('does not manufacture a turn owner from thread/read activeTurnId after start timeout', async () => {
    const client = new DelayedStartTurnClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.match(result.diagnostics?.join('\n') ?? '', /identity was not correlated|uncertain/i);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'close']);
  });

  it('ignores late same-thread start/completion notifications during bounded cleanup', async () => {
    const client = new LateNotificationClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.match(result.diagnostics?.join('\n') ?? '', /identity was not correlated|uncertain/i);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'close']);
  });

  it('interrupts only the correlated successful start response despite foreign same-thread events', async () => {
    const client = new ForeignTurnEvidenceClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.ok(client.calls.includes('turn/interrupt:thread-new:owned-response-turn'));
    assert.equal(client.calls.some((call) => call.includes('foreign-start') || call.includes('foreign-completion')), false);
  });

  it('accepts the original correlated start response released by cancellation during bounded cleanup', async () => {
    const controller = new AbortController();
    const client = new AbortReleasedStartTurnClient(controller);
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const pending = adapter.run(request({ signal: controller.signal }));
    await waitForCall(client, 'turn/start:thread-new');
    controller.abort();
    const result = await pending;
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_CANCELLED/);
    assert.ok(client.calls.indexOf('original-response-after-cancel') >= 0);
    assert.ok(client.calls.indexOf('original-response-after-cancel') < client.calls.indexOf('turn/interrupt:thread-new:late-original-turn'));
    assert.ok(client.calls.includes('turn/interrupt:thread-new:late-original-turn'));
    assert.equal(client.calls.some((call) => call.startsWith('read:')), false);
  });

  it('bounds native observation by the configured execution timeout', async () => {
    const client = new HangingObserveClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    await assert.rejects(() => adapter.observeRuntime(EXECUTOR), /timed out/i);
    assert.deepEqual(client.calls, ['read:thread-1', 'close']);
  });

  it('cancels an in-flight active-turn control observation and closes the component', async () => {
    const client = new HangingObserveClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const controller = new AbortController();
    const pending = adapter.steerActiveTurn(request({ executor: EXECUTOR, signal: controller.signal }), 'turn-1', 'please stop');
    await waitForCall(client, 'read:thread-1');
    controller.abort();
    await assert.rejects(() => pending, /cancelled/i);
    assert.deepEqual(client.calls, ['read:thread-1', 'close']);
  });

  it('stops waiting for a native turn when the selected execution is cancelled', async () => {
    const client = new HangingClient();
    const controller = new AbortController();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const pending = adapter.run(request({ signal: controller.signal }));
    await waitForCall(client, 'wait');
    controller.abort();
    const result = await pending;
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_CANCELLED/);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'wait', 'turn/interrupt:thread-new:turn-1', 'close']);
  });

  it('preserves ephemeral browser capabilities and their takeover policy for native turns', async () => {
    const client = new FakeClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const result = await adapter.run(request({ capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'https://browser.example/mcp' }] }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(client.threadOptions[0]?.config, {
      'mcp_servers.browser': {
        url: 'https://browser.example/mcp',
        required: true,
        default_tools_approval_mode: 'approve',
      },
    });
    assert.match(client.prompts[0] ?? '', /Browser capability policy/);
    assert.match(client.prompts[0] ?? '', /TACHIKO_NEEDS_HUMAN:/);
  });

  it('rejects invalid capabilities before opening an App Server child', async () => {
    const factory = new Factory(new FakeClient());
    const adapter = new CodexAppServerAdapter({ clientFactory: factory, runner: new HeadRunner() });
    await assert.rejects(
      () => adapter.run(request({ capabilities: [{ kind: 'mcp-http', name: 'invalid name', endpoint: 'https://browser.example/mcp' }] })),
      /Invalid MCP capability name/,
    );
    assert.equal(factory.opens, 0);
  });

  it('validates a discovered model/effort pair before creating any thread or turn', async () => {
    const client = new DiscoveringClient([{ model: 'deepseek-flash', supportedReasoningEfforts: ['low', 'high', 'max'] }]);
    const adapter = new CodexAppServerAdapter({
      clientFactory: new Factory(client), runner: new HeadRunner(),
      model: 'deepseek-flash', reasoningEffort: 'medium',
    });

    const result = await adapter.run(request());

    assert.equal(result.exitStatus, 'failure');
    assert.ok(result.diagnostics?.[0]?.startsWith(EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT));
    assert.match(result.diagnostics?.[0] ?? '', /deepseek-flash/);
    assert.ok(!client.calls.includes('thread/start'), 'preflight rejection must not create a thread');
    assert.deepEqual(client.modelTurnCalls, [], 'preflight rejection must start zero model turns');
    assert.ok(client.calls.includes('close'), 'the App Server component is still closed');
    assert.equal(result.telemetry?.turns, 0);
    assert.equal(result.telemetry?.failure?.category, 'configuration-preflight');
    assert.equal(result.telemetry?.capability?.source, 'runtime-discovery');
    assert.equal(result.telemetry?.capability?.revision, 'codex-app-server:model/list');
  });

  it('proceeds on authoritative discovery when the pair is supported', async () => {
    const client = new DiscoveringClient([{ model: 'deepseek-flash', supportedReasoningEfforts: ['low', 'high', 'max'] }]);
    const adapter = new CodexAppServerAdapter({
      clientFactory: new Factory(client), runner: new HeadRunner(),
      model: 'deepseek-flash', reasoningEffort: 'high',
    });

    const result = await adapter.run(request());

    assert.equal(result.exitStatus, 'success');
    assert.ok(client.calls.includes('thread/start'));
    assert.ok(client.modelTurnCalls.includes('turn/start:thread-new'));
    // The canonical value reaches the provider unchanged and undowngraded.
    assert.equal(client.threadOptions[0]?.reasoningEffort, 'high');
  });

  it('captures App Server usage, turn, context, and tool-result telemetry', async () => {
    const client = new UsageClient();
    const adapter = new CodexAppServerAdapter({
      clientFactory: new Factory(client), runner: new HeadRunner(),
      model: 'configured-model', reasoningEffort: 'high',
    });

    const result = await adapter.run(request());

    assert.equal(result.exitStatus, 'success');
    assert.equal(result.telemetry?.provider, 'codex-app-server');
    assert.equal(result.telemetry?.turns, 1);
    assert.deepEqual(result.telemetry?.usage, {
      inputTokens: 2_000,
      cachedInputTokens: 1_500,
      outputTokens: 80,
      reasoningTokens: 20,
    });
    assert.deepEqual(result.telemetry?.context, { initialTokens: 2_000, peakTokens: 2_000 });
    assert.equal(result.telemetry?.largestToolResultBytes, 321);
  });

  it('degrades to the versioned fallback when capability discovery is unavailable', async () => {
    const client = new DiscoveringClient(new Error('App Server RPC error: method not found'));
    const adapter = new CodexAppServerAdapter({
      clientFactory: new Factory(client), runner: new HeadRunner(),
      model: 'configured-model', reasoningEffort: 'high',
    });

    const result = await adapter.run(request());

    // Discovery absence is not a model failure: the run still proceeds.
    assert.equal(result.exitStatus, 'success');
    assert.ok(client.modelTurnCalls.includes('turn/start:thread-new'));
    assert.equal(client.threadOptions[0]?.reasoningEffort, 'high');
  });

  it('turns a native agent takeover message into the existing typed human boundary', async () => {
    const client = new FakeClient();
    client.waitForTurn = async () => ({ status: 'completed', summary: 'TACHIKO_NEEDS_HUMAN: sign-in required' });
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner() });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.deepEqual(result.diagnostics, ['TACHIKO_NEEDS_HUMAN: sign-in required']);
  });

  it('fails closed for string-id App Server approval requests', async () => {
    const child = new FakeAppServerProcess();
    const client = new StdioCodexAppServerClient(child as never);
    child.stdout.write(`${JSON.stringify({ id: 'approval-1', method: 'execCommandApproval', params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(child.writes, [{
      id: 'approval-1',
      error: { code: -32002, message: 'Tachiko has no policy authorizing this App Server request.' },
    }]);
    await client.close();
  });

  it('keeps a spawn-time refusal outside unavailable fallback conversion', async () => {
    const refusal = new ExecutionAdmissionRefusal('host denied native process entry', false);
    await assert.rejects(
      () => new StdioCodexAppServerClientFactory().open({ beforeExecution: () => { throw refusal; } }),
      (error: unknown) => error === refusal,
    );
  });

  it('does not fall back when initialization fails and bounded component close also fails', async () => {
    const child = new InitializationFailureProcess();
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({
      clientFactory: new StdioCodexAppServerClientFactory(() => child as never),
      fallback,
      runner: new HeadRunner(),
    });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /initialization failed \(App Server RPC error: .*initialize refused.*\)/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /cleanup remains uncertain/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /close refused/i);
    assert.equal(fallback.calls, 0);
    assert.equal(child.writes.length, 1);
  });

  it('treats initialization close rejection with an undefined reason as uncertain and disables fallback', async () => {
    const child = new InitializationUndefinedCloseProcess();
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({
      clientFactory: new StdioCodexAppServerClientFactory(() => child as never),
      fallback,
      runner: new HeadRunner(),
    });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /initialize refused/i);
    assert.match(result.diagnostics?.join('\n') ?? '', /cleanup remains uncertain \(undefined\)/i);
    assert.equal(fallback.calls, 0);
    assert.equal(child.writes.length, 1);
  });

  it('checks each mutating JSON-RPC write after serialization without putting host options on the wire', async () => {
    const child = new FakeAppServerProcess();
    const client = new StdioCodexAppServerClient(child as never);
    let checks = 0;
    const hostOptions = { beforeExecution: () => { checks += 1; } };
    const respond = async <T>(pending: Promise<T>, result: unknown): Promise<T> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const request = child.writes.at(-1) as { id: number; method: string } | undefined;
      assert.ok(request);
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      return await pending;
    };
    const threadStart = client.startThread({ cwd: '/tmp/worktree' }, hostOptions);
    assert.equal(checks, 1);
    assert.equal(await respond(threadStart, { thread: { id: 'thread-started' } }), 'thread-started');
    const threadResume = client.resumeThread('thread-started', { cwd: '/tmp/worktree' }, hostOptions);
    assert.equal(checks, 2);
    assert.equal(await respond(threadResume, { thread: { id: 'thread-started' } }), 'thread-started');
    const turnStart = client.startTurn('thread-started', 'task', hostOptions);
    assert.equal(checks, 3);
    assert.equal(await respond(turnStart, { turn: { id: 'turn-started' } }), 'turn-started');
    const turnSteer = client.steerTurn('thread-started', 'turn-started', 'next', hostOptions);
    assert.equal(checks, 4);
    assert.equal(await respond(turnSteer, { turnId: 'turn-started' }), 'turn-started');
    const turnInterrupt = client.interruptTurn('thread-started', 'turn-started', hostOptions);
    assert.equal(checks, 5);
    await respond(turnInterrupt, {});
    assert.deepEqual((child.writes as Array<{ method: string }>).map((wire) => wire.method), [
      'thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt',
    ]);
    assert.equal(JSON.stringify(child.writes).includes('beforeExecution'), false);
    await client.close();
  });

  it('removes pending RPC state and writes zero bytes when a mutation callback refuses', async () => {
    const child = new FakeAppServerProcess();
    const client = new StdioCodexAppServerClient(child as never);
    const refusal = new ExecutionAdmissionRefusal('Run changed before RPC write', true);
    await assert.rejects(
      () => client.startTurn('thread-1', 'task', { beforeExecution: () => { throw refusal; } }),
      (error: unknown) => error === refusal,
    );
    assert.deepEqual(child.writes, []);
    const subsequent = client.startTurn('thread-1', 'task');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rawRequest = child.writes[0];
    assert.ok(rawRequest);
    const request = rawRequest as { id: number; method: string };
    assert.equal(request.id, 2, 'the refused id was allocated but its pending entry was removed');
    assert.equal(request.method, 'turn/start');
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: 'turn-ok' } } })}\n`);
    assert.equal(await subsequent, 'turn-ok');
    await client.close();
  });

  it('reports an uncapped turn count and the newest usable completed turn', async () => {
    const child = new FakeAppServerProcess();
    const client = new StdioCodexAppServerClient(child as never);
    const turns = [
      { id: 'turn-1', status: 'completed', items: [{ id: 'i1', type: 'agentMessage' }] },
      { id: 'turn-2', status: 'interrupted', items: [] },
      { id: '', status: 'completed', items: [] },
      { id: 'turn-4', status: 'completed', items: [] },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `turn-${index + 5}`, status: 'completed', items: [] })),
      { id: 'turn-11', status: 'inProgress', items: [] },
    ];
    const pending = client.observeThread('thread-1');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({
      id: (child.writes[0] as { id: number }).id,
      result: { thread: { id: 'thread-1', status: { type: 'active' }, turns } },
    })}\n`);
    const observation = await pending;
    assert.equal(observation.status, 'active');
    assert.equal(observation.turnCount, turns.length);
    assert.equal(observation.activeTurnId, 'turn-11');
    // The blank-id completed turn is skipped in favour of an earlier usable id.
    assert.equal(observation.lastCompletedTurnId, 'turn-10');
    assert.equal(observation.history.length, 1);
    await client.close();
  });

  it('caps history independently of the uncapped turn counter', async () => {
    const child = new FakeAppServerProcess();
    const client = new StdioCodexAppServerClient(child as never);
    const turns = Array.from({ length: 8 }, (_, index) => ({
      id: `turn-${index + 1}`,
      status: 'completed',
      items: Array.from({ length: 25 }, (_, item) => ({ id: `t${index}-i${item}`, type: 'agentMessage' })),
    }));
    const pending = client.observeThread('thread-2');
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({
      id: (child.writes[0] as { id: number }).id,
      result: { thread: { id: 'thread-2', status: { type: 'idle' }, turns } },
    })}\n`);
    const observation = await pending;
    assert.equal(observation.history.length, 100);
    assert.equal(observation.turnCount, 8);
    assert.equal(observation.lastCompletedTurnId, 'turn-8');
    await client.close();
  });

  it('opens the signed-in local App Server without starting a model turn when explicitly opted in', {
    skip: process.env.TACHIKO_CODEX_APP_SERVER_SMOKE !== '1',
  }, async () => {
    const client = await new StdioCodexAppServerClientFactory().open();
    await client.close();
  });

  it('rejects a real unsupported model/effort combination before any turn when explicitly opted in', {
    skip: process.env.TACHIKO_CODEX_APP_SERVER_SMOKE !== '1',
  }, async () => {
    const probe = await new StdioCodexAppServerClientFactory().open();
    let target: { readonly model: string; readonly effort: string } | undefined;
    try {
      const models = await probe.listModels?.() ?? [];
      for (const model of models) {
        const missing = ['minimal', 'low', 'medium', 'high', 'xhigh']
          .find((effort) => !model.supportedReasoningEfforts.includes(effort));
        if (missing !== undefined) { target = { model: model.model, effort: missing }; break; }
      }
    } finally {
      await probe.close();
    }
    if (target === undefined) return; // this runtime offers every canonical level for every model

    const adapter = new CodexAppServerAdapter({
      runner: new HeadRunner(), model: target.model, reasoningEffort: target.effort as never,
    });
    const result = await adapter.run(request());

    assert.equal(result.exitStatus, 'failure');
    assert.ok(result.diagnostics?.[0]?.startsWith(EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT));
    assert.match(result.diagnostics?.[0] ?? '', new RegExp(target.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('discovers the real provider model/effort catalog without starting a model turn when explicitly opted in', {
    skip: process.env.TACHIKO_CODEX_APP_SERVER_SMOKE !== '1',
  }, async () => {
    const client = await new StdioCodexAppServerClientFactory().open();
    try {
      const models = await client.listModels?.();
      assert.ok(Array.isArray(models), 'the opted-in runtime must expose a model catalog');
      for (const model of models ?? []) {
        assert.equal(typeof model.model, 'string');
        assert.ok(model.supportedReasoningEfforts.every((effort: string) => typeof effort === 'string'));
      }
    } finally {
      await client.close();
    }
  });
});

class FakeAppServerProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: unknown[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.writes.push(JSON.parse(chunk.toString())));
  }

  kill(): boolean { this.killed = true; return true; }
}

class InitializationFailureProcess extends FakeAppServerProcess {
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString()) as { id: number; method: string };
      if (request.method === 'initialize') {
        setImmediate(() => this.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -1, message: 'initialize refused' } })}\n`));
      }
    });
  }

  override kill(): boolean { throw new Error('close refused'); }
}

class InitializationUndefinedCloseProcess extends InitializationFailureProcess {
  override kill(): boolean { throw undefined; }
}
