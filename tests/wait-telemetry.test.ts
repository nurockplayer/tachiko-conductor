import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import {
  evaluateEfficiencySignals,
  isRunTelemetry,
  projectRunEfficiency,
  recordWaitTelemetry,
  recordWaitWakeTelemetry,
} from '../src/domain/telemetry.js';
import { isWaitLedger } from '../src/domain/wait.js';
import { RunRuntimeObserver } from '../src/workflow/wait-observation.js';
import { createWaitLedger, advanceWaitLedger, normalizeWaitObservation } from '../src/domain/wait.js';
import { T0, TARGET } from './helpers.js';

const DIGEST = 'c'.repeat(64);

function waitingRun(id = 'run-wait-telemetry') {
  return applyTransition(createRun(TARGET, T0, id), { type: 'wait_dependency' }, T0);
}

describe('wait/status telemetry (#51 reuse)', () => {
  it('keeps the legacy wait recorder available and semantically unchanged', () => {
    const run = recordWaitTelemetry(waitingRun(), T0);
    const events = run.telemetry?.events ?? [];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'wait_status_wakeup');
    assert.equal(projectRunEfficiency(run).metrics.waitStatusWakeups.status, 'observed');
  });

  it('records bounded #47 wake evidence and stays idempotent by digest', () => {
    const run = waitingRun();
    const recorded = recordWaitWakeTelemetry(run, {
      at: T0,
      reason: 'completion',
      source: 'native',
      subjectId: run.id,
      status: 'completed',
      observationDigest: DIGEST,
    });
    const again = recordWaitWakeTelemetry(recorded, {
      at: T0,
      reason: 'completion',
      source: 'native',
      subjectId: run.id,
      status: 'completed',
      observationDigest: DIGEST,
    });
    const events = (again.telemetry?.events ?? []).filter((event) => event.id.startsWith('wait-wake:'));
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event?.kind, 'wait_status_wakeup');
    assert.equal(event?.reason, 'completion');
    assert.equal(event?.observationSource, 'native');
    assert.equal(event?.subjectId, run.id);
    assert.equal(event?.observationStatus, 'completed');
    assert.equal(event?.observationDigest, DIGEST);
    // The transition into WAITING_DEPENDENCY records the legacy wait event; the
    // #47 wake evidence is added exactly once on top of it.
    assert.deepEqual(projectRunEfficiency(again).metrics.waitStatusWakeups, { status: 'observed', value: 2 });
  });

  it('is purely digest-addressed even when run history grows between captures', () => {
    const run = waitingRun();
    const first = recordWaitWakeTelemetry(run, {
      at: T0, reason: 'blocked', source: 'runtime', subjectId: run.id, status: 'blocked', observationDigest: DIGEST,
    });
    // A later capture of the same normalized wake after unrelated history growth
    // must not mint a second event.
    const grown = { ...first, history: [...first.history, { type: 'start' as const, from: 'READY' as const, to: 'IMPLEMENTING' as const, at: T0 }] };
    const second = recordWaitWakeTelemetry(grown, {
      at: T0, reason: 'blocked', source: 'runtime', subjectId: run.id, status: 'blocked', observationDigest: DIGEST,
    });
    assert.equal(second.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup').length, 2);
    assert.equal(second.telemetry?.events.filter((event) => event.id.startsWith('wait-wake:')).length, 1);
  });

  it('keeps the persisted wait event structurally valid and secret-free', () => {
    const run = recordWaitWakeTelemetry(waitingRun(), {
      at: T0, reason: 'failure', source: 'runtime', subjectId: 'run-1', status: 'failed', observationDigest: DIGEST,
    });
    assert.equal(isRunTelemetry(run.telemetry), true);
    assert.equal(isRunTelemetry(run.telemetry), true);
    const serialized = JSON.stringify(run.telemetry);
    assert.equal(serialized.includes('summary'), false);
    assert.equal(serialized.includes('transcript'), false);
  });
});

describe('wait ledger structural validation', () => {
  it('accepts a created ledger and its persisted shape', () => {
    const ledger = createWaitLedger({ subjectId: 'run-1', ownerRunId: 'run-1', generation: 'generation-1' });
    assert.equal(isWaitLedger(ledger), true);
    const advanced = advanceWaitLedger({
      ledger,
      observation: normalizeWaitObservation({ source: 'runtime', subjectId: 'run-1', observedAt: T0, snapshot: { status: 'active' } }),
      at: T0,
    }).ledger;
    assert.equal(isWaitLedger(advanced), true);
    assert.equal(isWaitLedger({ ...advanced, generation: '' }), false);
    assert.equal(isWaitLedger(null), false);
    // Structurally malformed entries must fail closed instead of being adopted
    // and then throwing a raw TypeError deeper in the ledger logic.
    assert.equal(isWaitLedger({ ...advanced, observations: [{ subjectId: 'run-1' }] }), false);
    assert.equal(isWaitLedger({ ...advanced, wakes: [{ id: 'w1' }] }), false);
    assert.equal(isWaitLedger({ ...advanced, observations: [{ ...advanced.observations[0], state: undefined }] }), false);
    assert.equal(isWaitLedger({ ...advanced, observations: [{ ...advanced.observations[0], source: 'martian' }] }), false);
    assert.equal(isWaitLedger({ ...advanced, observations: [{ ...advanced.observations[0], status: 'NOT_A_STATUS' }] }), false);
    assert.equal(isWaitLedger({ ...advanced, wakes: [{ ...advanced.wakes[0], reason: 'nonsense' }] }), false);
    assert.equal(isWaitLedger({ ...advanced, observationSequence: -1 }), false);
    assert.equal(isWaitLedger({ ...advanced, terminalReached: 'yes' }), false);
    assert.equal(isWaitLedger({ ...advanced, lastNativeStatus: 'NOT_A_STATUS' }), false);
    assert.equal(isWaitLedger({ ...advanced, lastNativeStatus: 3 }), false);
    assert.equal(isWaitLedger({ ...advanced, lastNativeIdentity: 123 }), false);
    assert.equal(isWaitLedger({ ...advanced, lastNativeIdentity: '' }), false);
    assert.equal(isWaitLedger({ ...advanced, previousWasNative: 'yes' }), false);
    assert.equal(isWaitLedger({ ...advanced, nativeIdentities: 'nope' }), false);
    assert.equal(isWaitLedger({ ...advanced, nativeIdentities: [3] }), false);
    assert.equal(isWaitLedger({ ...advanced, deliveredWakeIds: 'nope' }), false);
    assert.equal(isWaitLedger({ ...advanced, deliveredWakeIds: [''] }), false);
    assert.equal(isWaitLedger({ ...advanced, surfacedDigests: [''] }), false);
  });
});

describe('runtime observer containment', () => {
  it('maps terminal workflow states onto terminal normalized statuses', async () => {
    const run = createRun(TARGET, T0, 'run-terminal-map');
    const failed = applyTransition(run, { type: 'fail' }, T0);
    const failedObservation = await new RunRuntimeObserver(failed, { now: () => T0 }).observe();
    assert.equal(failedObservation.status, 'failed');

    const escalated = applyTransition(run, { type: 'escalate', reason: 'needs a human' }, T0);
    const escalatedObservation = await new RunRuntimeObserver(escalated, { now: () => T0 }).observe();
    assert.equal(escalatedObservation.status, 'blocked');
  });
});
