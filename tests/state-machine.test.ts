import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InvalidTransitionError,
  TRANSITION_TABLE,
  allowedTransitions,
  applyTransition,
  canTransition,
  isReviewFresh,
  isTerminal,
  transitionRequiresResult,
} from '../src/domain/state-machine.js';
import {
  TRANSITION_TYPES,
  WORKFLOW_STATES,
  type Run,
  type WorkflowState,
} from '../src/domain/types.js';
import { LIVE_HEAD_SYNC_DECISION } from '../src/domain/decisions.js';
import { T0, approval, changesRequested, failureResult, newRun, successResult } from './helpers.js';

/** Build a run pinned to an arbitrary state (for edge-case tests). */
function runIn(state: WorkflowState, overrides: Partial<Run> = {}): Run {
  return { ...newRun(), state, ...overrides };
}

describe('state machine — transition table integrity', () => {
  it('covers every workflow state and only uses known transitions', () => {
    assert.deepEqual(Object.keys(TRANSITION_TABLE).sort(), [...WORKFLOW_STATES].sort());
    for (const state of WORKFLOW_STATES) {
      for (const type of allowedTransitions(state)) {
        assert.ok(
          (TRANSITION_TYPES as readonly string[]).includes(type),
          `table uses unknown transition "${type}" from ${state}`,
        );
      }
    }
  });

  it('marks only MERGED and FAILED as terminal', () => {
    for (const state of WORKFLOW_STATES) {
      assert.equal(isTerminal(state), state === 'MERGED' || state === 'FAILED', `state ${state}`);
    }
  });

  it('exposes canTransition consistently with the table', () => {
    assert.equal(canTransition('READY', 'start'), true);
    assert.equal(canTransition('READY', 'merged'), false);
    assert.equal(canTransition('MERGED', 'fail'), false);
  });
});

describe('state machine — happy path', () => {
  it('walks READY → IMPLEMENTING → VALIDATING → REVIEWING → FINAL_GATE → MERGE_READY → MERGED', () => {
    let run = newRun();
    assert.equal(run.state, 'READY');

    run = applyTransition(run, { type: 'start' }, T0);
    assert.equal(run.state, 'IMPLEMENTING');

    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('sha-1') }, T0);
    assert.equal(run.state, 'VALIDATING');
    assert.equal(run.headSha, 'sha-1');
    assert.equal(run.agentResult?.exitStatus, 'success');

    run = applyTransition(run, { type: 'validation_passed' }, T0);
    assert.equal(run.state, 'REVIEWING');

    run = applyTransition(run, { type: 'review_approved', reviewResult: approval('reviewer-1', 'sha-1') }, T0);
    assert.equal(run.state, 'FINAL_GATE');

    run = applyTransition(run, { type: 'gate_passed' }, T0);
    assert.equal(run.state, 'MERGE_READY');

    run = applyTransition(run, { type: 'merged' }, T0);
    assert.equal(run.state, 'MERGED');
    assert.equal(run.history.length, 6);
    assert.equal(run.history[5]?.from, 'MERGE_READY');
    assert.equal(run.history[5]?.to, 'MERGED');
  });

  it('routes a failed implementation to the FAILED terminal state', () => {
    const run = applyTransition(
      applyTransition(newRun(), { type: 'start' }, T0),
      { type: 'agent_failed', agentResult: failureResult() },
      T0,
    );
    assert.equal(run.state, 'FAILED');
    assert.equal(isTerminal(run.state), true);
  });

  it('routes validation failure back to CHANGES_REQUESTED', () => {
    let run = newRun();
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult() }, T0);
    run = applyTransition(run, { type: 'validation_failed' }, T0);
    assert.equal(run.state, 'CHANGES_REQUESTED');
  });

  it('routes blocking review findings through the fix loop and back to IMPLEMENTING', () => {
    let run = newRun();
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('sha-1') }, T0);
    run = applyTransition(run, { type: 'validation_passed' }, T0);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'sha-1') }, T0);
    assert.equal(run.state, 'CHANGES_REQUESTED');
    assert.equal(run.reviewResult?.verdict, 'request_changes');
    assert.equal(run.reviewResult?.findings.length, 1);

    run = applyTransition(run, { type: 'start_fix' }, T0);
    assert.equal(run.state, 'IMPLEMENTING');
  });

  it('records history with from/to/at/reason', () => {
    let run = newRun();
    run = applyTransition(run, { type: 'start', reason: 'DoR ready' }, T0);
    const record = run.history[0];
    assert.equal(record?.type, 'start');
    assert.equal(record?.from, 'READY');
    assert.equal(record?.to, 'IMPLEMENTING');
    assert.equal(record?.at, T0);
    assert.equal(record?.reason, 'DoR ready');
  });
});

describe('state machine — invalid transitions fail loudly', () => {
  it('rejects a transition not allowed from the current state with an actionable message', () => {
    const run = newRun();
    assert.throws(
      () => applyTransition(run, { type: 'agent_succeeded', agentResult: successResult() }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidTransitionError);
        assert.equal(err.code, 'unknown-transition');
        assert.equal(err.fromState, 'READY');
        assert.equal(err.transition, 'agent_succeeded');
        assert.match(err.message, /Invalid transition "agent_succeeded" from state READY/);
        assert.match(err.message, /Allowed transitions:/);
        assert.ok(err.message.includes('escalate'));
        return true;
      },
    );
  });

  it('rejects every transition from terminal states', () => {
    for (const state of ['MERGED', 'FAILED'] as const) {
      assert.throws(
        () => applyTransition(runIn(state), { type: 'start' }),
        (err: unknown) => err instanceof InvalidTransitionError && err.code === 'terminal-state',
      );
      assert.throws(
        () => applyTransition(runIn(state), { type: 'fail' }),
        (err: unknown) => err instanceof InvalidTransitionError && err.code === 'terminal-state',
      );
      assert.equal(allowedTransitions(state).length, 0);
    }
  });

  it('rejects a semantically impossible step such as merging before review', () => {
    const run = newRun();
    assert.throws(
      () => applyTransition(run, { type: 'merged' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'unknown-transition',
    );
  });

  it('requires an agentResult for agent_succeeded', () => {
    assert.throws(
      () => applyTransition(runIn('IMPLEMENTING'), { type: 'agent_succeeded' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'missing-payload',
    );
  });

  it('requires a reviewResult whose verdict matches the transition', () => {
    const reviewing = runIn('REVIEWING');
    assert.throws(
      () => applyTransition(reviewing, { type: 'review_approved' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'missing-payload',
    );
    assert.throws(
      () => applyTransition(reviewing, { type: 'review_approved', reviewResult: changesRequested() }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'wrong-verdict',
    );
    assert.throws(
      () => applyTransition(reviewing, { type: 'changes_requested', reviewResult: approval() }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'wrong-verdict',
    );
  });
});

describe('state machine — final gate review freshness', () => {
  /** A FINAL_GATE run whose work is at sha-2. */
  function gated(): Run {
    return runIn('FINAL_GATE', { headSha: 'sha-2' });
  }

  it('blocks gate_passed when the latest review is bound to an older SHA', () => {
    const run = { ...gated(), reviewResult: approval('reviewer-1', 'sha-1') };
    assert.equal(isReviewFresh(run), false);
    assert.throws(
      () => applyTransition(run, { type: 'gate_passed' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'stale-review',
    );
  });

  it('routes a stale gate back to REVIEWING via gate_blocked', () => {
    const run = { ...gated(), reviewResult: approval('reviewer-1', 'sha-1') };
    const next = applyTransition(run, { type: 'gate_blocked' }, T0);
    assert.equal(next.state, 'REVIEWING');
    assert.equal(next.interrupt, undefined);
    assert.equal(next.interruptedFrom, undefined);
  });

  it('re-enters a fresh review cycle from a blocked gate and passes', () => {
    let run = runIn('FINAL_GATE', { headSha: 'sha-2', reviewResult: approval('reviewer-1', 'sha-1') });
    assert.equal(isReviewFresh(run), false);

    run = applyTransition(run, { type: 'gate_blocked' }, T0);
    assert.equal(run.state, 'REVIEWING');

    run = applyTransition(run, { type: 'review_approved', reviewResult: approval('reviewer-1', 'sha-2') }, T0);
    assert.equal(run.state, 'FINAL_GATE');
    assert.equal(isReviewFresh(run), true);

    run = applyTransition(run, { type: 'gate_passed' }, T0);
    assert.equal(run.state, 'MERGE_READY');
  });

  it('allows gate_passed only when the review is bound to the exact current HEAD', () => {
    const run = { ...gated(), reviewResult: approval('reviewer-1', 'sha-2') };
    assert.equal(isReviewFresh(run), true);
    const next = applyTransition(run, { type: 'gate_passed' }, T0);
    assert.equal(next.state, 'MERGE_READY');
  });

  it('rejects gate_blocked while the review is already fresh', () => {
    const run = { ...gated(), reviewResult: approval('reviewer-1', 'sha-2') };
    assert.throws(
      () => applyTransition(run, { type: 'gate_blocked' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'fresh-review',
    );
  });

  it('never treats empty HEAD SHAs as fresh, so the gate cannot be bypassed', () => {
    const run = runIn('FINAL_GATE', { headSha: '', reviewResult: approval('reviewer-1', '') });
    assert.equal(isReviewFresh(run), false);
    assert.throws(
      () => applyTransition(run, { type: 'gate_passed' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'stale-review',
    );
    const next = applyTransition(run, { type: 'gate_blocked' }, T0);
    assert.equal(next.state, 'REVIEWING');
  });
});

describe('state machine — review events must be bound to the current HEAD', () => {
  it('rejects an approval that still contains a blocking finding', () => {
    const run = runIn('REVIEWING', { headSha: 'sha-2' });
    const contradictoryApproval = {
      ...approval('reviewer-1', 'sha-2'),
      findings: [{ severity: 'blocking' as const, summary: 'the diff still has a bug' }],
    };

    assert.throws(
      () => applyTransition(run, { type: 'review_approved', reviewResult: contradictoryApproval }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'contradictory-review',
    );
  });

  it('rejects a persisted contradictory approval separately from HEAD freshness at the final gate', () => {
    const run = runIn('FINAL_GATE', {
      headSha: 'sha-2',
      reviewResult: {
        ...approval('reviewer-1', 'sha-2'),
        findings: [{ severity: 'blocking', summary: 'the diff still has a bug' }],
      },
    });

    assert.equal(isReviewFresh(run), true);
    assert.throws(
      () => applyTransition(run, { type: 'gate_passed' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'contradictory-review',
    );
  });

  it('rejects a persisted matching-HEAD change request at the final gate', () => {
    const run = runIn('FINAL_GATE', {
      headSha: 'sha-2',
      reviewResult: changesRequested('reviewer-1', 'sha-2'),
    });

    assert.equal(isReviewFresh(run), true);
    assert.throws(
      () => applyTransition(run, { type: 'gate_passed' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'wrong-verdict',
    );
  });

  it('rejects a changes_requested review bound to a stale SHA', () => {
    const run = runIn('REVIEWING', { headSha: 'sha-2' });
    assert.throws(
      () => applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'sha-1') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'stale-review',
    );
  });

  it('accepts a changes_requested review bound to the current SHA', () => {
    const run = runIn('REVIEWING', { headSha: 'sha-2' });
    const next = applyTransition(
      run,
      { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'sha-2') },
      T0,
    );
    assert.equal(next.state, 'CHANGES_REQUESTED');
    assert.equal(next.reviewResult?.verdict, 'request_changes');
  });

  it('rejects a changes_requested review with an empty HEAD SHA as not fresh', () => {
    const run = runIn('REVIEWING', { headSha: 'sha-2' });
    assert.throws(
      () => applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', '') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'stale-review',
    );
  });

  it('rejects a stale review_approved before it reaches the gate', () => {
    const run = runIn('REVIEWING', { headSha: 'sha-2' });
    assert.throws(
      () => applyTransition(run, { type: 'review_approved', reviewResult: approval('reviewer-1', 'sha-1') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'stale-review',
    );
  });
});

describe('state machine — HEAD mutation is bound to implementation or explicit live sync', () => {
  it('allows only an explicitly offered human live-HEAD sync and routes it through validation', () => {
    let run = runIn('IMPLEMENTING', { headSha: 'sha-1' });
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'live HEAD changed',
        interrupt: { choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] },
      },
      T0,
    );
    const synchronized = applyTransition(
      run,
      { type: 'human_resolved', reason: LIVE_HEAD_SYNC_DECISION, headSha: ' sha-2 ' },
      T0,
    );
    assert.equal(synchronized.state, 'VALIDATING');
    assert.equal(synchronized.headSha, 'sha-2');

    assert.throws(
      () => applyTransition(run, { type: 'human_resolved', reason: 'another choice', headSha: 'sha-2' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'head-mutation-not-allowed',
    );
    assert.throws(
      () => applyTransition(run, { type: 'human_resolved', reason: LIVE_HEAD_SYNC_DECISION, headSha: ' ' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'empty-head-sha',
    );
  });

  it('authorizes the same exact live-HEAD sync emitted from review states', () => {
    for (const state of ['REVIEWING', 'CHANGES_REQUESTED'] as const) {
      let run = runIn(state, { headSha: 'sha-1' });
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason: 'live HEAD changed',
          interrupt: { choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] },
        },
        T0,
      );
      const synchronized = applyTransition(
        run,
        { type: 'human_resolved', reason: LIVE_HEAD_SYNC_DECISION, headSha: 'sha-2' },
        T0,
      );
      assert.equal(synchronized.state, 'VALIDATING');
      assert.equal(synchronized.headSha, 'sha-2');
    }
  });

  it('rejects gate_passed that attempts to swap in an unreviewed HEAD', () => {
    const run = runIn('FINAL_GATE', {
      headSha: 'sha-1',
      reviewResult: approval('reviewer-1', 'sha-1'),
    });
    assert.equal(isReviewFresh(run), true);
    assert.throws(
      () => applyTransition(run, { type: 'gate_passed', headSha: 'sha-2' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'head-mutation-not-allowed',
    );
  });

  it('gate_passed without a HEAD payload keeps the approved HEAD', () => {
    const run = runIn('FINAL_GATE', {
      headSha: 'sha-1',
      reviewResult: approval('reviewer-1', 'sha-1'),
    });
    const next = applyTransition(run, { type: 'gate_passed' }, T0);
    assert.equal(next.state, 'MERGE_READY');
    assert.equal(next.headSha, 'sha-1');
  });

  it('rejects merged that silently replaces the approved HEAD', () => {
    const run = runIn('MERGE_READY', {
      headSha: 'sha-1',
      reviewResult: approval('reviewer-1', 'sha-1'),
    });
    assert.throws(
      () => applyTransition(run, { type: 'merged', headSha: 'sha-9' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'head-mutation-not-allowed',
    );
  });

  it('merged without a HEAD payload keeps the approved HEAD', () => {
    const run = runIn('MERGE_READY', {
      headSha: 'sha-1',
      reviewResult: approval('reviewer-1', 'sha-1'),
    });
    const next = applyTransition(run, { type: 'merged' }, T0);
    assert.equal(next.state, 'MERGED');
    assert.equal(next.headSha, 'sha-1');
  });

  it('rejects agent/review payloads carried by unrelated transitions', () => {
    assert.throws(
      () => applyTransition(runIn('VALIDATING'), { type: 'validation_passed', agentResult: successResult('sha-2') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'unexpected-payload',
    );
    assert.throws(
      () =>
        applyTransition(
          runIn('REVIEWING'),
          { type: 'review_approved', headSha: 'sha-2', reviewResult: approval('reviewer-1', 'sha-1') },
          T0,
        ),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'head-mutation-not-allowed',
    );
  });
});

describe('state machine — agent result semantics match the event', () => {
  it('rejects a failure agentResult on agent_succeeded', () => {
    assert.throws(
      () => applyTransition(runIn('IMPLEMENTING'), { type: 'agent_succeeded', agentResult: failureResult() }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'wrong-exit-status',
    );
  });

  it('rejects a success agentResult on agent_failed', () => {
    assert.throws(
      () => applyTransition(runIn('IMPLEMENTING'), { type: 'agent_failed', agentResult: successResult() }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'wrong-exit-status',
    );
  });

  it('requires an agentResult for agent_failed, mirroring agent_succeeded', () => {
    assert.throws(
      () => applyTransition(runIn('IMPLEMENTING'), { type: 'agent_failed' }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'missing-payload',
    );
  });

  it('classifies which transitions require result payloads', () => {
    assert.equal(transitionRequiresResult('agent_succeeded'), 'agent');
    assert.equal(transitionRequiresResult('agent_failed'), 'agent');
    assert.equal(transitionRequiresResult('review_approved'), 'review');
    assert.equal(transitionRequiresResult('changes_requested'), 'review');
    assert.equal(transitionRequiresResult('start'), 'none');
    assert.equal(transitionRequiresResult('merged'), 'none');
    assert.equal(transitionRequiresResult('gate_passed'), 'none');
  });
});

describe('state machine — successful implementation must report an exact HEAD', () => {
  it('rejects agent_succeeded without any HEAD SHA even when an old HEAD exists', () => {
    const run = runIn('IMPLEMENTING', { headSha: 'sha-1' });
    assert.throws(
      () => applyTransition(run, { type: 'agent_succeeded', agentResult: { exitStatus: 'success', summary: 'x' } }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'missing-head-sha',
    );
  });

  it('accepts agent_succeeded when input.headSha and agentResult.headSha agree', () => {
    const run = runIn('IMPLEMENTING', { headSha: 'sha-1' });
    const next = applyTransition(
      run,
      { type: 'agent_succeeded', headSha: 'sha-2', agentResult: successResult('sha-2') },
      T0,
    );
    assert.equal(next.state, 'VALIDATING');
    assert.equal(next.headSha, 'sha-2');
  });

  it('rejects agent_succeeded when input.headSha and agentResult.headSha conflict', () => {
    const run = runIn('IMPLEMENTING');
    assert.throws(
      () => applyTransition(run, { type: 'agent_succeeded', headSha: 'sha-2', agentResult: successResult('sha-3') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'conflicting-head-sha',
    );
  });

  it('rejects an empty-string HEAD SHA from agentResult.headSha', () => {
    const run = runIn('IMPLEMENTING', { headSha: 'sha-1' });
    assert.throws(
      () => applyTransition(run, { type: 'agent_succeeded', agentResult: { exitStatus: 'success', summary: 'x', headSha: '' } }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'empty-head-sha',
    );
  });

  it('rejects a whitespace-only HEAD SHA from input.headSha', () => {
    const run = runIn('IMPLEMENTING');
    assert.throws(
      () => applyTransition(run, { type: 'agent_succeeded', headSha: '   ', agentResult: successResult('sha-1') }, T0),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'empty-head-sha',
    );
  });

  it('normalizes whitespace-padded HEAD SHAs that agree', () => {
    const run = runIn('IMPLEMENTING');
    const next = applyTransition(
      run,
      { type: 'agent_succeeded', headSha: ' sha-2 ', agentResult: successResult('sha-2') },
      T0,
    );
    assert.equal(next.state, 'VALIDATING');
    assert.equal(next.headSha, 'sha-2');
  });
});

describe('state machine — interrupts and resume', () => {
  it('escalates to NEEDS_HUMAN remembering the interrupted state, then resumes', () => {
    let run = runIn('REVIEWING');
    run = applyTransition(run, { type: 'escalate', reason: 'reviewer disputed the approach' }, T0);
    assert.equal(run.state, 'NEEDS_HUMAN');
    assert.equal(run.interruptedFrom, 'REVIEWING');
    assert.equal(run.interrupt?.kind, 'needs_human');
    assert.equal(run.interrupt?.reason, 'reviewer disputed the approach');

    run = applyTransition(run, { type: 'human_resolved', reason: 'approved after discussion' }, T0);
    assert.equal(run.state, 'REVIEWING');
    assert.equal(run.interruptedFrom, undefined);
    assert.ok(run.interrupt?.resolvedAt);
  });

  it('carries evidence and bounded choices onto a NEEDS_HUMAN interrupt', () => {
    let run = runIn('REVIEWING');
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'ambiguous architecture',
        interrupt: { evidence: 'two viable designs exist', choices: ['Option A', 'Option B'] },
      },
      T0,
    );
    assert.equal(run.state, 'NEEDS_HUMAN');
    assert.equal(run.interrupt?.evidence, 'two viable designs exist');
    assert.deepEqual(run.interrupt?.choices, ['Option A', 'Option B']);
  });

  it('omits empty choices and evidence on an interrupt', () => {
    let run = runIn('IMPLEMENTING');
    run = applyTransition(run, { type: 'escalate', reason: 'plain question', interrupt: { choices: [] } }, T0);
    assert.equal(run.interrupt?.evidence, undefined);
    assert.equal(run.interrupt?.choices, undefined);
  });

  it('records interrupt resolution when failing out of an interrupt state', () => {
    let run = runIn('IMPLEMENTING');
    run = applyTransition(run, { type: 'wait_dependency', reason: 'waiting on upstream API' }, T0);
    assert.equal(run.state, 'WAITING_DEPENDENCY');
    assert.equal(run.interruptedFrom, 'IMPLEMENTING');

    run = applyTransition(run, { type: 'dependency_satisfied' }, T0);
    assert.equal(run.state, 'IMPLEMENTING');
    assert.equal(run.interruptedFrom, undefined);
    assert.ok(run.interrupt?.resolvedAt);
  });

  it('waits on a dependency from MERGE_READY and resumes to MERGE_READY', () => {
    let run = runIn('MERGE_READY', { headSha: 'sha-1', reviewResult: approval('reviewer-1', 'sha-1') });
    run = applyTransition(run, { type: 'wait_dependency', reason: 'branch protection check pending' }, T0);
    assert.equal(run.state, 'WAITING_DEPENDENCY');
    assert.equal(run.interruptedFrom, 'MERGE_READY');
    assert.equal(run.interrupt?.kind, 'waiting_dependency');

    run = applyTransition(run, { type: 'dependency_satisfied' }, T0);
    assert.equal(run.state, 'MERGE_READY');
    assert.equal(run.interruptedFrom, undefined);
    assert.ok(run.interrupt?.resolvedAt);
  });

  it('cannot resume an interrupt without interrupt context', () => {
    const run = runIn('WAITING_DEPENDENCY'); // no interruptedFrom set
    assert.throws(
      () => applyTransition(run, { type: 'dependency_satisfied' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'no-interrupt-context',
    );
  });

  it('cannot stack a second interrupt while already interrupted', () => {
    const human = runIn('NEEDS_HUMAN', { interruptedFrom: 'IMPLEMENTING' });
    assert.throws(
      () => applyTransition(human, { type: 'wait_dependency' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'unknown-transition',
    );
    const waiting = runIn('WAITING_DEPENDENCY', { interruptedFrom: 'IMPLEMENTING' });
    assert.throws(
      () => applyTransition(waiting, { type: 'escalate' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.code === 'unknown-transition',
    );
  });

  it('records interrupt resolution when failing out of an interrupt state', () => {
    const run = applyTransition(
      runIn('WAITING_DEPENDENCY', {
        interruptedFrom: 'IMPLEMENTING',
        interrupt: { kind: 'waiting_dependency', reason: 'x', createdAt: T0 },
      }),
      { type: 'fail', reason: 'the dependency will never arrive' },
      T0,
    );
    assert.equal(run.state, 'FAILED');
    assert.equal(run.interruptedFrom, undefined);
    assert.ok(run.interrupt?.resolvedAt);
  });
});

describe('state machine — determinism and immutability', () => {
  it('does not mutate the input run', () => {
    const run = newRun();
    const before = JSON.stringify(run);
    assert.throws(() => applyTransition(run, { type: 'merged' }));
    assert.equal(JSON.stringify(run), before);
  });

  it('produces identical results for identical inputs', () => {
    const a = applyTransition(newRun(), { type: 'start' }, T0);
    const b = applyTransition(newRun(), { type: 'start' }, T0);
    assert.deepEqual(a, b);
  });
});
