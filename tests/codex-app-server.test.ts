import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AppServerUnavailableError,
  CODEX_APP_SERVER_PROVIDER,
  CodexAppServerAdapter,
  StdioCodexAppServerClientFactory,
  type AppServerLifecycleEvent,
  type CodexAppServerClient,
  type CodexAppServerClientFactory,
  type NativeThreadObservation,
} from '../src/agents/codex-app-server.js';
import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
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
  private readonly listeners = new Set<(event: AppServerLifecycleEvent) => void>();
  constructor(private observation: NativeThreadObservation = { threadId: 'thread-1', status: 'idle', history: [] }) {}
  async observeThread(threadId: string): Promise<NativeThreadObservation> { this.calls.push(`read:${threadId}`); return this.observation; }
  async startThread(): Promise<string> { this.calls.push('thread/start'); return 'thread-new'; }
  async resumeThread(threadId: string): Promise<string> { this.calls.push(`thread/resume:${threadId}`); return threadId; }
  async startTurn(threadId: string): Promise<string> { this.calls.push(`turn/start:${threadId}`); return 'turn-1'; }
  async steerTurn(threadId: string, turnId: string): Promise<string> { this.calls.push(`turn/steer:${threadId}:${turnId}`); return turnId; }
  async interruptTurn(threadId: string, turnId: string): Promise<void> { this.calls.push(`turn/interrupt:${threadId}:${turnId}`); }
  async waitForTurn(): Promise<{ status: 'completed'; summary: string }> { this.calls.push('wait'); return { status: 'completed', summary: 'done' }; }
  onEvent(listener: (event: AppServerLifecycleEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.calls.push('close'); }
}

class Factory implements CodexAppServerClientFactory {
  opens = 0;
  constructor(readonly client: FakeClient) {}
  async open(): Promise<CodexAppServerClient> { this.opens += 1; return this.client; }
}

class Fallback implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  calls = 0;
  async run(_request: ImplementationRequest): Promise<AgentResult> { this.calls += 1; return { exitStatus: 'success', summary: 'cli fallback', headSha: HEAD }; }
}

function request(extra: Partial<ImplementationRequest> = {}): ImplementationRequest {
  return { target: TARGET, baseSha: 'base', workspacePath: '/tmp/worktree', runtimeOwnership: OWNERSHIP, ...extra };
}

describe('CodexAppServerAdapter', () => {
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

  it('keeps the existing Codex CLI adapter as the only fallback for unavailable App Server startup', async () => {
    const fallback = new Fallback();
    const adapter = new CodexAppServerAdapter({ clientFactory: { open: async () => { throw new AppServerUnavailableError('not installed'); } }, fallback, runner: new HeadRunner() });
    const result = await adapter.run(request());
    assert.equal(result.summary, 'cli fallback');
    assert.equal(fallback.calls, 1);
  });

  it('opens the signed-in local App Server without starting a model turn when explicitly opted in', {
    skip: process.env.TACHIKO_CODEX_APP_SERVER_SMOKE !== '1',
  }, async () => {
    const client = await new StdioCodexAppServerClientFactory().open();
    await client.close();
  });
});
