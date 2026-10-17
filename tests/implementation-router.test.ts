import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import { hasGovernedPublicationConfinement } from '../src/adapters/agent.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';
import type { AgentResult } from '../src/domain/types.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { TARGET, successResult } from './helpers.js';
import { createGenuineLunaFixture } from './support/genuine-luna.js';

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
  it('recognizes and invokes only a genuine Luna instance with a prepared standalone guard', async () => {
    const fixture = await createGenuineLunaFixture('registry-genuine-luna');
    let selectedProviderCalls = 0;
    let fallbackCalls = 0;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'luna-isolated',
      providers: {
        'luna-isolated': () => { selectedProviderCalls += 1; return fixture.adapter; },
        'claude-code': () => { fallbackCalls += 1; return new RecordingAgent(successResult('b'.repeat(40))); },
      },
    });
    try {
      assert.equal(hasGovernedPublicationConfinement(fixture.adapter), true);
      const prepared = registry.prepareGovernedInvocation(fixture.request);
      assert.equal(prepared.status, 'qualified');
      if (prepared.status !== 'qualified') return;
      const result = await prepared.agent.run(fixture.request);
      assert.equal(result.exitStatus, 'success');
      assert.equal(fixture.executionEntries, 1, 'the governed callback crosses Luna and its nested Codex CLI exactly once');
      assert.equal(prepared.agent, fixture.adapter);
      assert.equal(selectedProviderCalls, 1, 'the registry selected the source-owned adapter exactly once');
      assert.equal(fallbackCalls, 0, 'a successful exact adapter preflight never selects fallback');
    } finally { fixture.cleanup(); }
  });

  it('keeps preparation callback-free but refuses qualified governed execution without the callback', async () => {
    const fixture = await createGenuineLunaFixture('registry-missing-execution-callback');
    const { beforeExecution: _callback, ...request } = fixture.request;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'luna-isolated',
      providers: { 'luna-isolated': () => fixture.adapter },
    });
    try {
      const prepared = registry.prepareGovernedInvocation(request);
      assert.equal(prepared.status, 'qualified', 'preflight before worker handoff does not require an execution callback');
      const result = await registry.run(request);
      assert.equal(result.exitStatus, 'failure');
      assert.match(result.diagnostics?.join('\n') ?? '', /GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED/);
      assert.equal(fixture.executionEntries, 0);
    } finally { fixture.cleanup(); }
  });

  it('delegates governed qualification to the selected source adapter and holds adapter rejection without fallback', () => {
    const request: ImplementationRequest = {
      target: TARGET, baseSha: 'base', execution: { profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 10_000 },
      runtimeOwnership: { runId: 'run-source-preflight', generation: 'generation' },
      governedPublication: { required: true, continuation: false },
    };
    let selectedRuns = 0;
    let fallbackSelections = 0;
    let preflightCalls = 0;
    const source = {
      kind: 'implementation-agent' as const,
      async run() { selectedRuns += 1; return successResult('a'.repeat(40)); },
      prepareGovernedInvocation() { preflightCalls += 1; return { status: 'held' as const, reason: 'source proof absent' }; },
    };
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'codex-cli',
      providers: { 'codex-cli': () => source, 'claude-code': () => { fallbackSelections += 1; return new RecordingAgent(successResult('b'.repeat(40))); } },
    });
    const prepared = registry.prepareGovernedInvocation(request);
    assert.equal(prepared.status, 'held');
    if (prepared.status === 'held') assert.match(prepared.reason, /source-qualified host publication boundary/);
    assert.equal(selectedRuns, 0);
    assert.equal(preflightCalls, 0, 'arbitrary adapter preflight cannot mint qualification');
    assert.equal(fallbackSelections, 0);
  });

  it('holds thrown or substituted selected-adapter preflight without invoking either adapter or fallback', () => {
    const request: ImplementationRequest = {
      target: TARGET, baseSha: 'base', execution: { profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 10_000 },
      runtimeOwnership: { runId: 'run-substituted-preflight', generation: 'generation' },
      governedPublication: { required: true, continuation: false },
    };
    for (const mode of ['throw', 'substitute'] as const) {
      let selectedRuns = 0;
      let fallbackSelections = 0;
      let substitutedRuns = 0;
      const substituted = {
        kind: 'implementation-agent' as const,
        async run() { substitutedRuns += 1; return successResult('c'.repeat(40)); },
      };
      const source = {
        kind: 'implementation-agent' as const,
        async run() { selectedRuns += 1; return successResult('a'.repeat(40)); },
        prepareGovernedInvocation() {
          if (mode === 'throw') throw new Error('preflight unavailable');
          return { status: 'qualified' as const, agent: substituted };
        },
      };
      const registry = new ImplementationAgentRegistry({
        defaultProvider: 'codex-cli',
        providers: { 'codex-cli': () => source, 'claude-code': () => { fallbackSelections += 1; return new RecordingAgent(successResult('b'.repeat(40))); } },
      });
      const prepared = registry.prepareGovernedInvocation(request);
      assert.equal(prepared.status, 'held', `${mode} preflight must hold`);
      if (prepared.status === 'held') assert.match(prepared.reason, /source-qualified host publication boundary/);
      assert.equal(selectedRuns, 0);
      assert.equal(substitutedRuns, 0);
      assert.equal(fallbackSelections, 0);
    }
  });

  it('holds ambient and unknown continuation routes without silently selecting the genuine default', async () => {
    const fixture = await createGenuineLunaFixture('registry-ambient-luna');
    const ambient = new RecordingAgent(successResult('a'.repeat(40)));
    const qualifiedDefault = fixture.adapter;
    let ambientCalls = 0;
    const registry = new ImplementationAgentRegistry({
      defaultProvider: 'luna-isolated',
      providers: {
        'luna-isolated': () => qualifiedDefault,
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
    assert.equal(qualifiedDefault, fixture.adapter, 'the router retains the exact source-qualified default instance');
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
      defaultProvider: 'luna-isolated',
      providers: { 'luna-isolated': () => { defaultSelections += 1; return qualifiedDefault; } },
    });
    const unknownInitialRequest = {
      ...governed,
      governedPublication: { required: true as const, continuation: false },
      beforeExecution: () => {},
    };
    const initialPreflight = unknownFresh.prepareGovernedInvocation(unknownInitialRequest);
    assert.equal(initialPreflight.status, 'held');
    if (initialPreflight.status === 'held') assert.match(initialPreflight.reason, /no exact execution or session identity/);
    const initialDirect = await unknownFresh.run(unknownInitialRequest);
    assert.equal(initialDirect.exitStatus, 'failure');
    assert.equal(initialDirect.durationMs, 0, 'the model-free hold reports no provider duration');
    assert.match(initialDirect.summary, /No model turn or worker process was started/);
    assert.equal(defaultSelections, 0, 'unknown governed identity is rejected before selecting even the default adapter');
    fixture.cleanup();
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
