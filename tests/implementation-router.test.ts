import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { qualifyGovernedPublicationAdapter, type ImplementationAgent, type ImplementationRequest } from '../src/adapters/agent.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';
import type { AgentResult } from '../src/domain/types.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
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
  it('preflights the exact selected adapter and pins that qualified instance through invocation', async () => {
    const worker = qualifyGovernedPublicationAdapter(new RecordingAgent(successResult('a'.repeat(40))));
    const fallback = new RecordingAgent(successResult('b'.repeat(40)));
    let workerSelections = 0;
    let fallbackSelections = 0;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'worker-router',
      providers: {
        'worker-router': () => { workerSelections += 1; return worker; },
        'codex-cli': () => { fallbackSelections += 1; return fallback; },
      },
    });
    const execution: ResolvedExecutionConfiguration = { profile: 'standard', revision: 'profiles-v1', executor: 'worker-router', timeoutMs: 10_000 };
    const request: ImplementationRequest = {
      target: TARGET, baseSha: 'base', execution,
      runtimeOwnership: { runId: 'run-governed', generation: 'run-generation' },
      governedPublication: { required: true, continuation: false },
    };

    const prepared = registry.prepareGovernedInvocation(request);
    assert.equal(prepared.status, 'qualified');
    if (prepared.status !== 'qualified') return;
    const result = await prepared.agent.run({ ...request, instructions: 'host packet' });

    assert.equal(result.exitStatus, 'success');
    assert.equal(workerSelections, 1, 'preflight selects the runtime once and invocation uses that exact adapter');
    assert.equal(fallbackSelections, 0, 'no ambient fallback is reconstructed');
    assert.equal(worker.requests.length, 1);
  });

  it('holds ambient and unknown continuation routes without silently selecting the qualified default', async () => {
    const ambient = new RecordingAgent(successResult('a'.repeat(40)));
    const qualifiedDefault = qualifyGovernedPublicationAdapter(new RecordingAgent(successResult('b'.repeat(40))));
    let ambientCalls = 0;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'worker-router',
      providers: {
        'worker-router': () => qualifiedDefault,
        'codex-cli': () => { ambientCalls += 1; return ambient; },
      },
    });
    const governed = {
      target: TARGET,
      baseSha: 'base',
      runtimeOwnership: { runId: 'run-ambient', generation: 'run-generation' },
      governedPublication: { required: true as const, continuation: false },
    };

    const ambientPreflight = registry.prepareGovernedInvocation({ ...governed, executor: { provider: 'codex-cli', sessionId: 'exact-thread' } });
    assert.equal(ambientPreflight.status, 'held');
    if (ambientPreflight.status === 'held') assert.match(ambientPreflight.reason, /publication boundary/);
    assert.equal(ambientCalls, 1);
    assert.equal(ambient.requests.length, 0);
    assert.equal(qualifiedDefault.requests.length, 0, 'the router does not replace a durable ambient executor with the default');
    const direct = await registry.run({ ...governed, executor: { provider: 'codex-cli', sessionId: 'exact-thread' } });
    assert.equal(direct.exitStatus, 'failure');
    assert.equal(ambient.requests.length, 0, 'the registry also fences direct governed calls that skip workflow preflight');

    const unknownContinuation = registry.prepareGovernedInvocation({
      ...governed,
      governedPublication: { required: true, continuation: true },
    });
    assert.equal(unknownContinuation.status, 'held');
    if (unknownContinuation.status === 'held') assert.match(unknownContinuation.reason, /no exact execution or session identity/);

    let defaultSelections = 0;
    const unknownFresh = new ImplementationAgentRegistry({
      defaultProvider: 'worker-router',
      providers: { 'worker-router': () => { defaultSelections += 1; return qualifiedDefault; } },
    });
    const unknownInitialRequest = {
      ...governed,
      governedPublication: { required: true as const, continuation: false },
    };
    const initialPreflight = unknownFresh.prepareGovernedInvocation(unknownInitialRequest);
    assert.equal(initialPreflight.status, 'held');
    if (initialPreflight.status === 'held') assert.match(initialPreflight.reason, /no exact execution or session identity/);
    const initialDirect = await unknownFresh.run(unknownInitialRequest);
    assert.equal(initialDirect.exitStatus, 'failure');
    assert.equal(initialDirect.durationMs, 0, 'the model-free hold reports no provider duration');
    assert.match(initialDirect.summary, /No model turn or worker process was started/);
    assert.equal(defaultSelections, 0, 'unknown governed identity is rejected before selecting even the default adapter');
    assert.equal(qualifiedDefault.requests.length, 0);
  });

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

  it('constructs the selected provider with the persisted resolved execution snapshot', async () => {
    const codex = new RecordingAgent(successResult('b'.repeat(40)));
    let constructedWith: ResolvedExecutionConfiguration | undefined;
    const execution: ResolvedExecutionConfiguration = {
      profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', model: 'configured-model',
      reasoningEffort: 'medium', timeoutMs: 10_000, sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
    };
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': () => new RecordingAgent(successResult('a'.repeat(40))),
        'codex-cli': (resolved) => {
          constructedWith = resolved;
          return codex;
        },
      },
    });

    await registry.run({ target: TARGET, baseSha: 'base', execution });

    assert.deepEqual(constructedWith, execution);
    assert.deepEqual(codex.requests[0]?.execution, execution);
  });

  it('reconstructs a persisted App Server thread through the selected compatible Codex CLI profile', async () => {
    const appServer = new RecordingAgent(successResult('c'.repeat(40)));
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'claude-code',
      providers: {
        'claude-code': () => new RecordingAgent(successResult('a'.repeat(40))),
        'codex-cli': () => new RecordingAgent(successResult('b'.repeat(40))),
        'codex-app-server': () => appServer,
      },
    });
    const execution: ResolvedExecutionConfiguration = { profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 10_000 };
    const executor = { provider: 'codex-app-server', sessionId: 'thread-42', generation: 'run-42' } as const;

    await registry.run({ target: TARGET, baseSha: 'base', executor, execution });

    assert.equal(appServer.requests.length, 1);
    assert.deepEqual(appServer.requests[0]?.executor, executor);
  });
});
