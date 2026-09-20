import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dispatchContinuously } from '../src/dispatch/continuous.js';
import type { DispatchOnceResult } from '../src/dispatch/runner.js';

const terminal: DispatchOnceResult = {
  outcome: 'dispatched',
  entry: { issue: 18, route: 'codex', profile: 'routine' },
  claim: { issue: 18, claimId: 'claim-1', runId: 'run-1', profile: 'routine', state: 'merge_ready', claimedAt: '2026-09-20T00:00:00.000Z', heartbeatAt: '2026-09-20T00:00:00.000Z', leaseUntil: '2026-09-20T00:15:00.000Z' },
  execution: { runId: 'run-1', state: 'MERGED' },
};

describe('continuous dispatch driver', () => {
  it('immediately reconciles after terminal work, then waits model-free when idle', async () => {
    const results: DispatchOnceResult[] = [terminal, { outcome: 'no_eligible_work', reasons: [] }, { outcome: 'no_eligible_work', reasons: [] }];
    const sleeps: number[] = [];
    const result = await dispatchContinuously({
      dispatchOnce: async () => results.shift()!,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      idlePollMs: 17,
      maxCycles: 3,
    });
    assert.equal(result.cycles, 3);
    assert.equal(result.idleWaits, 1);
    assert.deepEqual(sleeps, [17]);
    assert.equal(result.last?.outcome, 'no_eligible_work');
  });

  it('waits without another dispatch after non-terminal work', async () => {
    const active: DispatchOnceResult = { ...terminal, execution: { runId: 'run-1', state: 'IMPLEMENTING' } };
    const sleeps: number[] = [];
    const result = await dispatchContinuously({
      dispatchOnce: async () => active,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      idlePollMs: 23,
      maxCycles: 2,
    });
    assert.equal(result.cycles, 2);
    assert.deepEqual(sleeps, [23]);
  });

  it('fails closed for invalid bounds before dispatching', async () => {
    await assert.rejects(
      dispatchContinuously({ dispatchOnce: async () => terminal, sleep: async () => undefined, idlePollMs: 0, maxCycles: 1 }),
      /positive safe integer/,
    );
  });
});
