import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import {
  appendRunTelemetryEvents,
  createCompletionInputFromResult,
  evaluateEfficiencySignals,
  projectRunEfficiency,
  recordCompletionTelemetry,
  recordSpawnTelemetry,
  withRunTelemetryThresholds,
  type RunTelemetryEvent,
} from '../src/domain/telemetry.js';
import { EXECUTION_CONFIGURATION_ERROR_CODE } from '../src/execution-profiles.js';
import type { Run } from '../src/domain/types.js';
import { T0, TARGET } from './helpers.js';

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);

function spawnAndComplete(run: ReturnType<typeof createRun>, headSha: string, inputTokens: number, cachedInputTokens: number, outputTokens: number) {
  const spawn = recordSpawnTelemetry(run, {
    role: 'worker',
    attemptKind: run.telemetry?.events.some((event) => event.kind === 'spawn') === true ? 'repair' : 'initial',
    headSha,
    provider: 'codex-cli',
    model: 'gpt-configured',
    reasoningEffort: 'high',
    profile: 'standard',
    contextMode: 'bounded',
    contextJustification: 'live-target-bounded',
  }, T0);
  return recordCompletionTelemetry(spawn.run, {
    role: 'worker',
    invocationId: spawn.invocationId,
    outcome: 'completed',
    turns: 1,
    usage: { inputTokens, cachedInputTokens, outputTokens, reasoningTokens: 10 },
    context: { initialTokens: inputTokens, peakTokens: inputTokens },
    largestToolResultBytes: 42,
  }, T0);
}

describe('run efficiency telemetry', () => {
  it('accumulates structured metrics across multiple provider calls', () => {
    let run = createRun(TARGET, T0, 'telemetry-accumulate');
    run = spawnAndComplete(run, HEAD, 1_000, 900, 40);
    run = spawnAndComplete(run, HEAD, 500, 400, 20);

    const projection = projectRunEfficiency(run);
    assert.equal(projection.recorded, true);
    assert.deepEqual(projection.metrics.modelTurns, { status: 'observed', value: 2 });
    assert.deepEqual(projection.metrics.inputTokens, { status: 'observed', value: 1_500 });
    assert.deepEqual(projection.metrics.cachedInputTokens, { status: 'observed', value: 1_300 });
    assert.deepEqual(projection.metrics.outputTokens, { status: 'observed', value: 60 });
    assert.deepEqual(projection.metrics.workerStarts, { status: 'observed', value: 2 });
    assert.deepEqual(projection.metrics.workerRestarts, { status: 'observed', value: 1 });
    assert.equal(projection.invocations.length, 2);
    assert.equal(projection.invocations[0]?.provider, 'codex-cli');
    assert.equal(projection.invocations[0]?.reasoningEffort, 'high');
    assert.equal(projection.invocations[0]?.profile, 'standard');
    assert.equal(projection.metrics.cachedInputPercent.status, 'observed');
    if (projection.metrics.cachedInputPercent.status === 'observed') {
      assert.ok(Math.abs(projection.metrics.cachedInputPercent.value - (1_300 / 1_500) * 100) < 0.0001);
    }
  });

  it('represents unavailable provider telemetry as explicit unknown rather than zero', () => {
    const spawn = recordSpawnTelemetry(createRun(TARGET, T0, 'telemetry-unknown'), {
      role: 'worker',
      attemptKind: 'initial',
      provider: 'worker-router',
      contextMode: 'bounded',
      contextJustification: 'live-target-bounded',
    }, T0);
    const run = recordCompletionTelemetry(spawn.run, {
      role: 'worker',
      invocationId: spawn.invocationId,
      outcome: 'completed',
    }, T0);

    const projection = projectRunEfficiency(run);
    assert.equal(projection.metrics.inputTokens.status, 'unknown');
    assert.equal(projection.metrics.outputTokens.status, 'unknown');
    assert.equal(projection.metrics.modelTurns.status, 'unknown');
    assert.equal(projection.metrics.largestToolResultBytes.status, 'unknown');
  });

  it('marks cumulative metrics unknown when telemetry starts mid-run', () => {
    const fresh = createRun(TARGET, T0, 'telemetry-legacy');
    const { telemetry: _telemetry, ...legacy } = fresh;
    const spawn = recordSpawnTelemetry(legacy as Run, {
      role: 'worker', attemptKind: 'resume', provider: 'codex-cli',
      contextMode: 'bounded', contextJustification: 'live-target-bounded',
    }, T0);
    const run = recordCompletionTelemetry(spawn.run, {
      role: 'worker', invocationId: spawn.invocationId, outcome: 'completed', turns: 1,
      usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
    }, T0);

    const projection = projectRunEfficiency(run);
    assert.equal(projection.coverage, 'partial');
    assert.equal(projection.metrics.workerStarts.status, 'unknown');
    assert.equal(projection.metrics.inputTokens.status, 'unknown');
    assert.equal(projection.invocations.length, 1);
  });

  it('deduplicates persisted events on restart/re-entry', () => {
    let run = createRun(TARGET, T0, 'telemetry-dedupe');
    const spawn = recordSpawnTelemetry(run, {
      role: 'worker',
      attemptKind: 'initial',
      provider: 'codex-cli',
      contextMode: 'bounded',
      contextJustification: 'live-target-bounded',
    }, T0);
    run = spawn.run;
    run = recordCompletionTelemetry(run, {
      role: 'worker', invocationId: spawn.invocationId, outcome: 'completed', turns: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    }, T0);
    const once = run;
    run = recordCompletionTelemetry(run, {
      role: 'worker', invocationId: spawn.invocationId, outcome: 'completed', turns: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    }, T0);
    assert.deepEqual(run, once);
    const inputTokens = projectRunEfficiency(run).metrics.inputTokens;
    assert.equal(inputTokens.status, 'observed');
    if (inputTokens.status === 'observed') assert.equal(inputTokens.value, 100);
  });

  it('keeps configuration-preflight rejection separate from executed failure', () => {
    const preflight = createCompletionInputFromResult({
      exitStatus: 'failure',
      diagnostics: [`${EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT}: unsupported`],
    }, { provider: 'codex-app-server' }, 'worker', 'invocation-preflight');
    const executed = createCompletionInputFromResult({
      exitStatus: 'failure',
      diagnostics: ['CODEX_APP_SERVER_TIMEOUT: timed out'],
    }, { provider: 'codex-app-server' }, 'worker', 'invocation-executed');

    assert.equal(preflight.outcome, 'configuration_preflight_failed');
    assert.equal(preflight.turns, 0);
    assert.equal(executed.outcome, 'failed');
  });

  it('does not count a retry after configuration preflight as an executed model retry', () => {
    let run = createRun(TARGET, T0, 'telemetry-preflight-retry');
    const first = recordSpawnTelemetry(run, {
      role: 'worker', attemptKind: 'initial', headSha: HEAD, provider: 'codex-cli',
      contextMode: 'bounded', contextJustification: 'live-target-bounded',
    }, T0);
    run = recordCompletionTelemetry(first.run, {
      role: 'worker', invocationId: first.invocationId, outcome: 'configuration_preflight_failed', turns: 0,
      failureCode: EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT,
    }, T0);
    const second = recordSpawnTelemetry(run, {
      role: 'worker', attemptKind: 'resume', headSha: HEAD, provider: 'codex-cli',
      contextMode: 'bounded', contextJustification: 'live-target-bounded',
    }, T0);
    run = recordCompletionTelemetry(second.run, {
      role: 'worker', invocationId: second.invocationId, outcome: 'completed', turns: 1,
      usage: { inputTokens: 100, outputTokens: 10 },
    }, T0);

    const metrics = projectRunEfficiency(run).metrics;
    assert.deepEqual(metrics.configurationPreflightFailures, { status: 'observed', value: 1 });
    assert.deepEqual(metrics.executedModelFailures, { status: 'observed', value: 0 });
    assert.deepEqual(metrics.executedModelRetries, { status: 'observed', value: 0 });
  });

  it('projects capability provenance when the provider reports it', () => {
    let run = createRun(TARGET, T0, 'telemetry-capability');
    const spawn = recordSpawnTelemetry(run, {
      role: 'worker', attemptKind: 'initial', provider: 'codex-app-server',
      contextMode: 'bounded', contextJustification: 'live-target-bounded',
    }, T0);
    run = recordCompletionTelemetry(spawn.run, {
      role: 'worker', invocationId: spawn.invocationId, outcome: 'completed', turns: 1,
      capability: { source: 'runtime-discovery', revision: 'codex-app-server:model/list', verified: true },
    }, T0);
    const completion = run.telemetry?.events.find((event) => event.kind === 'completion');
    assert.deepEqual(completion?.capability, {
      source: 'runtime-discovery',
      revision: { status: 'observed', value: 'codex-app-server:model/list' },
      verified: true,
      unverifiedReason: null,
    });
  });

  it('records wait/status transitions as durable wakeup events', () => {
    let run = createRun(TARGET, T0, 'telemetry-wait');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'wait_dependency', reason: 'hosted checks pending' }, T0);
    const waits = run.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup') ?? [];
    assert.equal(waits.length, 1);
    assert.equal(waits[0]?.state, 'WAITING_DEPENDENCY');
    assert.equal(projectRunEfficiency(run).metrics.waitStatusWakeups.status, 'observed');
  });

  it('rejects non-integer thresholds at the writer boundary', () => {
    const run = createRun(TARGET, T0, 'telemetry-invalid-threshold');
    assert.throws(
      () => withRunTelemetryThresholds(run, { reviewerRestarts: 1.5 }),
      /positive safe-integer limits/,
    );
  });

  it('emits deterministic warnings from structured events only', () => {
    const base = createRun(TARGET, T0, 'telemetry-signals');
    const events: RunTelemetryEvent[] = [];
    for (let index = 0; index < 3; index += 1) {
      events.push({
        id: `wait-${index}`, at: T0, kind: 'wait_status_wakeup', state: 'WAITING_DEPENDENCY', headSha: HEAD,
      });
      events.push({
        id: `reviewer-${index}`, at: T0, kind: 'spawn', role: 'reviewer', invocationId: `reviewer-invocation-${index}`,
        attempt: index + 1, attemptKind: index === 0 ? 'review' : 'review_restart', headSha: HEAD,
        provider: 'reviewer', model: null, reasoningEffort: null, profile: null,
        contextMode: 'full', contextJustification: null,
      });
    }
    const telemetry = appendRunTelemetryEvents(base, events).telemetry!;
    const metrics = projectRunEfficiency({ ...base, telemetry }).metrics;
    const signals = evaluateEfficiencySignals(telemetry, metrics);
    assert.ok(signals.some((signal) => signal.code === 'repeated_unchanged_state_wakeups'));
    assert.ok(signals.some((signal) => signal.code === 'reviewer_restarted_before_head_convergence'));
    assert.ok(signals.some((signal) => signal.code === 'unjustified_full_context_spawn'));
    assert.ok(signals.some((signal) => signal.code === 'abnormal_reviewer_restart_count'));
  });

  it('does not require or retain transcript or hidden-reasoning payloads', () => {
    const secret = 'secret-transcript-value';
    let run = createRun(TARGET, T0, 'telemetry-no-transcript');
    const spawn = recordSpawnTelemetry(run, {
      role: 'worker', attemptKind: 'initial', provider: 'codex-cli',
      contextMode: 'bounded', contextJustification: 'live-target-bounded',
    }, T0);
    run = recordCompletionTelemetry(spawn.run, {
      role: 'worker', invocationId: spawn.invocationId, outcome: 'completed', turns: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
    }, T0);
    assert.equal(JSON.stringify(run).includes(secret), false);
    assert.equal(Object.hasOwn(run.telemetry?.events[0] ?? {}, 'text'), false);
  });
});
