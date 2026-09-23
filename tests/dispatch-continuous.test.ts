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
  it('remains alive and model-free while a typed maintenance hold is returned', async () => {
    const held: DispatchOnceResult = { outcome: 'maintenance_hold', reason: 'Typed restart hold prevents new dispatch admission.' };
    const calls: string[] = [];
    const result = await dispatchContinuously({
      dispatchOnce: async () => { calls.push('reconcile'); return held; },
      sleep: async () => { calls.push('wait'); },
      idlePollMs: 11,
      maxCycles: 2,
    });
    assert.deepEqual(calls, ['reconcile', 'wait', 'reconcile']);
    assert.equal(result.last?.outcome, 'maintenance_hold');
  });

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

  it('treats typed admission wait as a retained nonterminal claim and polls serially', async () => {
    const waiting: DispatchOnceResult = {
      outcome: 'admission_wait', waitKind: 'capacity', entry: { issue: 18, route: 'codex', profile: 'routine' },
      runId: 'run-1', reason: 'waiting for capacity',
      claim: { issue: 18, claimId: 'claim-1', runId: 'run-1', profile: 'routine', state: 'claimed', claimedAt: '2026-09-20T00:00:00.000Z', heartbeatAt: '2026-09-20T00:00:00.000Z', leaseUntil: '2026-09-20T00:15:00.000Z' },
    };
    const calls: string[] = [];
    const result = await dispatchContinuously({
      dispatchOnce: async () => { calls.push('reconcile'); return waiting; },
      sleep: async () => { calls.push('wait'); }, idlePollMs: 13, maxCycles: 2,
    });
    assert.deepEqual(calls, ['reconcile', 'wait', 'reconcile']);
    assert.equal(result.last?.outcome, 'admission_wait');
  });

  it('fails closed for invalid bounds before dispatching', async () => {
    await assert.rejects(
      dispatchContinuously({ dispatchOnce: async () => terminal, sleep: async () => undefined, idlePollMs: 0, maxCycles: 1 }),
      /positive safe integer/,
    );
  });
});
