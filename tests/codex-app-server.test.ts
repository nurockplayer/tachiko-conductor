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
  type AppServerLifecycleEvent,
  type CodexAppServerClient,
  type CodexAppServerClientFactory,
  type NativeThreadObservation,
} from '../src/agents/codex-app-server.js';
import { WorkspaceGuardFailure, type ImplementationAgent, type ImplementationRequest } from '../src/adapters/agent.js';
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
  async startThread(options: AppServerThreadOptions): Promise<string> { this.threadOptions.push(options); this.calls.push('thread/start'); return 'thread-new'; }
  async resumeThread(threadId: string, options: AppServerThreadOptions): Promise<string> { this.threadOptions.push(options); this.calls.push(`thread/resume:${threadId}`); return threadId; }
  async startTurn(threadId: string, prompt: string): Promise<string> { this.prompts.push(prompt); this.calls.push(`turn/start:${threadId}`); return 'turn-1'; }
  async steerTurn(threadId: string, turnId: string): Promise<string> { this.calls.push(`turn/steer:${threadId}:${turnId}`); return turnId; }
  async interruptTurn(threadId: string, turnId: string): Promise<void> { this.calls.push(`turn/interrupt:${threadId}:${turnId}`); }
  async waitForTurn(): Promise<{ status: 'completed'; summary: string }> { this.calls.push('wait'); return { status: 'completed', summary: 'done' }; }
  onEvent(listener: (event: AppServerLifecycleEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.calls.push('close'); }
  emitEvent(event: AppServerLifecycleEvent): void { for (const listener of this.listeners) listener(event); }
}

class Factory implements CodexAppServerClientFactory {
  opens = 0;
  constructor(readonly client: FakeClient) {}
  async open(): Promise<CodexAppServerClient> { this.opens += 1; return this.client; }
}

class HangingClient extends FakeClient {
  override async waitForTurn(): Promise<{ status: 'completed'; summary: string }> {
    this.calls.push('wait');
    return new Promise(() => {});
  }
}

class HangingStartThreadClient extends FakeClient {
  override async startThread(_options: AppServerThreadOptions): Promise<string> {
    this.calls.push('thread/start');
    return new Promise(() => {});
  }
}

class HangingStartTurnClient extends FakeClient {
  constructor(private readonly observedTurnId: string | undefined = undefined) { super(); }

  override async startTurn(threadId: string, prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    if (this.observedTurnId !== undefined) {
      this.emitEvent({ type: 'turn_started', threadId, turnId: this.observedTurnId });
    }
    return new Promise(() => {});
  }
}

class DelayedStartTurnClient extends FakeClient {
  override async startTurn(threadId: string, prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.calls.push(`turn/start:${threadId}`);
    return new Promise(() => {});
  }

  override async observeThread(threadId: string): Promise<NativeThreadObservation> {
    this.calls.push(`read:${threadId}`);
    return { threadId, status: 'active', activeTurnId: 'turn-delayed', history: [] };
  }
}

class HangingFactory implements CodexAppServerClientFactory {
  async open(): Promise<CodexAppServerClient> {
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

  it('bounds a stalled native turn by the selected execution timeout', async () => {
    const client = new HangingClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'wait', 'turn/interrupt:thread-new:turn-1', 'close']);
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

  it('bounds a stalled turn/start RPC and interrupts the exact turn observed by notification', async () => {
    const client = new HangingStartTurnClient('turn-observed');
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.deepEqual(client.calls, ['thread/start', 'turn/start:thread-new', 'turn/interrupt:thread-new:turn-observed', 'close']);
  });

  it('discovers and interrupts an exact turn when timeout wins before the turn/start notification is processed', async () => {
    const client = new DelayedStartTurnClient();
    const adapter = new CodexAppServerAdapter({ clientFactory: new Factory(client), runner: new HeadRunner(), timeoutMs: 5 });
    const result = await adapter.run(request());
    assert.equal(result.exitStatus, 'failure');
    assert.match(result.diagnostics?.join('\n') ?? '', /CODEX_APP_SERVER_TIMEOUT/);
    assert.deepEqual(client.calls, [
      'thread/start', 'turn/start:thread-new', 'read:thread-new', 'turn/interrupt:thread-new:turn-delayed', 'close',
    ]);
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

  it('opens the signed-in local App Server without starting a model turn when explicitly opted in', {
    skip: process.env.TACHIKO_CODEX_APP_SERVER_SMOKE !== '1',
  }, async () => {
    const client = await new StdioCodexAppServerClientFactory().open();
    await client.close();
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
