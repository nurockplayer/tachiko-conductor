import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';
import type { AgentResult } from '../src/domain/types.js';
import { TARGET, successResult } from './helpers.js';

class RecordingAgent implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  readonly requests: ImplementationRequest[] = [];

  constructor(private readonly result: AgentResult) {}

  async run(request: ImplementationRequest): Promise<AgentResult> {
    this.requests.push(request);
    return this.result;
  }
}

describe('ImplementationAgentRegistry', () => {
  it('reconstructs the persisted provider for resume even when the fresh default is different', async () => {
    const claude = new RecordingAgent(successResult('a'.repeat(40)));
    const codex = new RecordingAgent(successResult('b'.repeat(40)));
    let codexReconstructions = 0;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'claude-code',
      legacySessionProvider: 'claude-code',
      providers: {
        'claude-code': () => claude,
        'codex-cli': () => {
          codexReconstructions += 1;
          return codex;
        },
      },
    });
    const executor = { provider: 'codex-cli', sessionId: 'thread-42' } as const;

    await registry.run({ target: TARGET, baseSha: 'base', executor });

    assert.equal(codexReconstructions, 1);
    assert.equal(codex.requests.length, 1);
    assert.deepEqual(codex.requests[0]?.executor, executor);
    assert.equal(claude.requests.length, 0);
  });

  it('routes legacy session-only runs to the declared legacy provider', async () => {
    const claude = new RecordingAgent(successResult('a'.repeat(40)));
    const codex = new RecordingAgent(successResult('b'.repeat(40)));
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'codex-cli',
      legacySessionProvider: 'claude-code',
      providers: { 'claude-code': () => claude, 'codex-cli': () => codex },
    });

    await registry.run({ target: TARGET, baseSha: 'base', sessionId: 'legacy-claude-session' });

    assert.equal(claude.requests.length, 1);
    assert.equal(codex.requests.length, 0);
  });

  it('fails explicitly when the persisted provider cannot be reconstructed', async () => {
    const executor = { provider: 'missing-provider', sessionId: 'thread-42' } as const;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'codex-cli',
      providers: { 'codex-cli': () => new RecordingAgent(successResult('b'.repeat(40))) },
    });

    const result = await registry.run({ target: TARGET, baseSha: 'base', executor });

    assert.equal(result.exitStatus, 'failure');
    assert.deepEqual(result.executor, executor);
    assert.match(result.diagnostics?.join('\n') ?? '', /EXECUTOR_PROVIDER_UNAVAILABLE/);
  });
});
