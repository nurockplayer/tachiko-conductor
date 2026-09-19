import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_WAIT_WAKE_POLICY,
  advanceWaitLedger,
  classifyWaitChange,
  createWaitLedger,
  decideWaitWake,
  normalizeWaitObservation,
  waitObservationDigest,
  type WaitEvidence,
  type WaitLedger,
  type WaitObservation,
  type WaitSubjectStatus,
  type WaitWakePolicy,
} from '../src/domain/wait.js';
import {
  NativeThreadWaitObserver,
  RunRuntimeObserver,
  awaitMeaningfulChange,
  gitHeadReader,
  observeWaitState,
  type WaitObserver,
} from '../src/workflow/wait-observation.js';
import { WaitLedgerFileStore, waitLedgerBelongsTo } from '../src/workflow/wait-ledger-store.js';
import { boundWaitLedger, migrateWaitLedger } from '../src/domain/wait.js';
import { newRun, T0 } from './helpers.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { WORKFLOW_STATES } from '../src/domain/types.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const SUBJECT = 'run-wait-1';

function normalize(status: WaitSubjectStatus, overrides: Partial<WaitObservation> = {}): WaitObservation {
  return normalizeWaitObservation({
    source: overrides.source ?? 'runtime',
    subjectId: overrides.subjectId ?? SUBJECT,
    observedAt: overrides.observedAt ?? T0,
    snapshot: {
      status,
      ...(overrides.activeItemId === undefined ? {} : { activeItemId: overrides.activeItemId }),
      items: overrides.progress?.items ?? 0,
      turns: overrides.progress?.turns ?? 0,
      ...(overrides.lastCompletedTurnId === undefined ? {} : { lastCompletedTurnId: overrides.lastCompletedTurnId }),
      ...(overrides.headSha === undefined ? {} : { headSha: overrides.headSha }),
      evidence: overrides.evidence ?? [],
    },
  });
}

function ledgerFor(subjectId = SUBJECT, generation = 'generation-1'): WaitLedger {
  return createWaitLedger({ subjectId, ownerRunId: subjectId, generation });
}

class QueueObserver implements WaitObserver {
  readonly source = 'runtime' as const;
  readonly subjectId = SUBJECT;
  reads = 0;
  constructor(private readonly queue: readonly WaitObservation[]) {}
  async observe(): Promise<WaitObservation> {
    const value = this.queue[Math.min(this.reads, this.queue.length - 1)]!;
    this.reads += 1;
    return value;
  }
}

describe('wait observation contract', () => {
  it('treats repeated unchanged state as no change and zero wakeups', () => {
    const first = normalize('active', { progress: { items: 1, turns: 0 } });
    const change = classifyWaitChange(first, normalize('active', { progress: { items: 1, turns: 0 } }));
    assert.deepEqual(change, { kind: 'none', meaningful: false, evidence: [] });
    const decision = decideWaitWake({ change, observation: first });
    assert.equal(decision.shouldWake, false);
  });

  it('treats persisted native active -> idle as completion across restart/re-entry', () => {
    const active = normalize('active', { source: 'native' });
    const idle = normalize('idle', { source: 'native' });
    const reloadedPrevious: WaitObservation = JSON.parse(JSON.stringify(active));
    const change = classifyWaitChange(reloadedPrevious, idle);
    assert.equal(change.kind, 'completion');
    assert.equal(change.meaningful, true);
    const decision = decideWaitWake({ change, observation: idle });
    assert.equal(decision.shouldWake, true);
    assert.equal(decision.reason, 'completion');
  });

  it('treats completion, failure, and blocked transitions as exactly one meaningful change', () => {
    for (const status of ['completed', 'failed', 'blocked'] as const) {
      const previous = normalize('active');
      const next = normalize(status);
      const change = classifyWaitChange(previous, next);
      assert.equal(change.meaningful, true, status);
      assert.equal(change.kind, status === 'blocked' ? 'blocked' : status === 'failed' ? 'failure' : 'completion');
      const decision = decideWaitWake({ change, observation: next });
      assert.equal(decision.shouldWake, true, status);
      // A second identical observation is not a new transition.
      assert.equal(classifyWaitChange(next, normalize(status)).meaningful, false, status);
    }
  });

  it('classifies progress and head moves as meaningful evidence but not a wake', () => {
    const progress = classifyWaitChange(normalize('active', { progress: { items: 1, turns: 0 } }), normalize('active', { progress: { items: 2, turns: 0 } }));
    assert.equal(progress.kind, 'progress');
    assert.equal(decideWaitWake({ change: progress, observation: normalize('active') }).shouldWake, false);

    const headMoved = classifyWaitChange(normalize('active', { headSha: HEAD }), normalize('active', { headSha: HEAD2 }));
    assert.equal(headMoved.kind, 'progress');
    assert.equal(headMoved.evidence[0]?.kind, 'head-changed');
    assert.equal(decideWaitWake({ change: headMoved, observation: normalize('active') }).shouldWake, false);
  });

  it('never reconciles a different subject as progress on this one', () => {
    const change = classifyWaitChange(normalize('active'), normalize('completed', { subjectId: 'other-run' }));
    assert.deepEqual(change, { kind: 'none', meaningful: false, evidence: [] });
  });

  it('keeps a timeout model-free with onTimeout=continue but wakes on policy-action', () => {
    const active = normalize('active');
    const none = { kind: 'none' as const, meaningful: false, evidence: [] as readonly WaitEvidence[] };
    const continuing: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, onTimeout: 'continue' };
    assert.equal(decideWaitWake({ change: none, observation: active, timedOut: true, policy: continuing }).shouldWake, false);

    const escalating: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, onTimeout: 'policy-action' };
    const decision = decideWaitWake({ change: none, observation: active, timedOut: true, policy: escalating });
    assert.equal(decision.shouldWake, true);
    assert.equal(decision.reason, 'timeout-policy');
    assert.ok(decision.evidence.length > 0);
  });
});

describe('durable wait ledger', () => {
  it('records one wake for a meaningful transition and none for repeats', () => {
    const ledger = ledgerFor();
    const first = advanceWaitLedger({ ledger, observation: normalize('active'), at: T0 });
    assert.equal(first.wokeNow, false);
    assert.equal(first.ledger.wakes.length, 0);

    const repeat = advanceWaitLedger({ ledger: first.ledger, observation: normalize('active'), at: T0 });
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.wokeNow, false);
    assert.equal(repeat.ledger.wakes.length, 0);

    const terminal = advanceWaitLedger({ ledger: repeat.ledger, observation: normalize('completed'), at: T0 });
    assert.equal(terminal.change.kind, 'completion');
    assert.equal(terminal.wokeNow, true);
    assert.equal(terminal.ledger.wakes.length, 1);

    const terminalRepeat = advanceWaitLedger({ ledger: terminal.ledger, observation: normalize('completed'), at: T0 });
    assert.equal(terminalRepeat.wokeNow, false);
    assert.equal(terminalRepeat.ledger.wakes.length, 1);
  });

  it('coalesces duplicate equivalent events into a single durable record', () => {
    const ledger = ledgerFor();
    const active = normalize('active', { progress: { items: 3, turns: 1 } });
    let current = advanceWaitLedger({ ledger, observation: active, at: T0 }).ledger;
    const before = current.observations.length;
    for (let index = 0; index < 5; index += 1) {
      current = advanceWaitLedger({ ledger: current, observation: active, at: T0 }).ledger;
    }
    assert.equal(current.observations.length, before);
    assert.equal(current.wakes.length, 0);
  });

  it('fails closed on foreign ownership or generation instead of adopting state', () => {
    const ledger = ledgerFor();
    assert.throws(() => advanceWaitLedger({ ledger, observation: normalize('active'), at: T0, expectedOwnerRunId: 'other-run' }), /ownership/i);
    assert.throws(() => advanceWaitLedger({ ledger, observation: normalize('active'), at: T0, expectedGeneration: 'generation-2' }), /generation/i);
    assert.throws(() => advanceWaitLedger({ ledger, observation: normalize('active', { subjectId: 'other-run' }), at: T0 }), /subject/i);
  });

  it('reconstructs an unchanged re-observation after a restart without a duplicate wake', () => {
    const ledger = ledgerFor();
    const active = normalize('active');
    const first = advanceWaitLedger({ ledger, observation: active, at: T0 });
    assert.equal(first.duplicate, false);
    // A restarted runtime reparses the same durable ledger and re-observes.
    const reloaded: WaitLedger = JSON.parse(JSON.stringify(first.ledger));
    const afterRestart = advanceWaitLedger({ ledger: reloaded, observation: active, at: T0 });
    assert.equal(afterRestart.duplicate, true);
    assert.equal(afterRestart.change.kind, 'none');
    assert.equal(afterRestart.ledger.wakes.length, 0);
    // A genuine transition after the restart still wakes exactly once.
    const completed = advanceWaitLedger({ ledger: afterRestart.ledger, observation: normalize('completed'), at: T0 });
    assert.equal(completed.wokeNow, true);
    assert.equal(completed.ledger.wakes.length, 1);
  });

  it('does not re-record a terminal wake for the same digest after a restart', () => {
    const ledger = ledgerFor();
    const completed = normalize('completed', { headSha: HEAD });
    const first = advanceWaitLedger({ ledger, observation: completed, at: T0 });
    assert.equal(first.wokeNow, true);
    const reloaded: WaitLedger = JSON.parse(JSON.stringify(first.ledger));
    const second = advanceWaitLedger({ ledger: reloaded, observation: completed, at: T0 });
    assert.equal(second.duplicate, true);
    assert.equal(second.ledger.wakes.length, 1);
  });

  it('keeps the terminal dedup guarantee after bounded eviction of the wake record', () => {
    // A terminal wake must never be re-emitted even after the bounded wake list
    // has genuinely evicted the original record: the terminal-digest set is
    // what carries the guarantee.
    let ledger = ledgerFor();
    const terminal = normalize('completed');
    const first = advanceWaitLedger({ ledger, observation: terminal, at: T0 });
    assert.equal(first.wokeNow, true);
    ledger = first.ledger;
    // Push the terminal wake out of the bounded window with later, genuinely
    // distinct timeout wakes (one per distinct observed state).
    const escalating: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 0, onTimeout: 'policy-action' };
    for (let index = 0; index < 250; index += 1) {
      ledger = advanceWaitLedger({
        ledger,
        observation: normalize('active', { progress: { items: index + 1, turns: 0 } }),
        at: T0,
        timedOut: true,
        policy: escalating,
      }).ledger;
    }
    assert.equal(ledger.wakes.length > 200, true);
    const bounded = boundWaitLedger(ledger);
    assert.equal(bounded.wakes.some((wake) => wake.observationDigest === waitObservationDigest(terminal)), false, 'terminal wake must be evicted');
    assert.equal(bounded.terminalDigests?.includes(waitObservationDigest(terminal)), true);
    const replayed = advanceWaitLedger({ ledger: bounded, observation: terminal, at: T0 });
    assert.equal(replayed.wokeNow, false);
    assert.equal(replayed.ledger.wakes.length, bounded.wakes.length);
  });

  it('migrates a ledger written before terminal digests existed', () => {
    const legacy = { ...ledgerFor() } as Record<string, unknown>;
    delete legacy.terminalDigests;
    const terminal = normalize('completed');
    const advanced = advanceWaitLedger({ ledger: legacy as never, observation: terminal, at: T0 });
    const migrated = migrateWaitLedger({ ...advanced.ledger, terminalDigests: undefined });
    assert.deepEqual(migrated.terminalDigests, [waitObservationDigest(terminal)]);
    const replayed = advanceWaitLedger({ ledger: migrated, observation: terminal, at: T0 });
    assert.equal(replayed.wokeNow, false);
  });

  it('is digest-stable across evidence order and timestamps', () => {
    const left = normalize('active', { evidence: [{ kind: 'progress', detail: 'a' }, { kind: 'item-completed', detail: 'b' }], observedAt: '2026-09-19T00:00:00.000Z' });
    const right = normalize('active', { evidence: [{ kind: 'item-completed', detail: 'b' }, { kind: 'progress', detail: 'a' }], observedAt: '2026-09-19T01:00:00.000Z' });
    assert.equal(waitObservationDigest(left), waitObservationDigest(right));
    assert.equal(classifyWaitChange(left, right).kind, 'none');
  });
});

describe('model-free bounded waiting', () => {
  it('keeps waiting through repeated unchanged state and progress without any model turn', async () => {
    const policy: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 4, onTimeout: 'continue' };
    let clock = 0;
    const observer = new QueueObserver([
      normalize('active', { progress: { items: 1, turns: 0 } }),
      normalize('active', { progress: { items: 1, turns: 0 } }),
      normalize('active', { progress: { items: 2, turns: 0 } }),
      normalize('active', { progress: { items: 2, turns: 0 } }),
    ]);
    const outcome = await awaitMeaningfulChange({
      observer,
      ledger: ledgerFor(),
      policy,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      pollIntervalMs: 1,
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.idle, true);
    assert.equal(outcome.wake.shouldWake, false);
    assert.ok(outcome.observationCount >= 4);
    assert.equal(outcome.ledger.wakes.length, 0);
    assert.equal(outcome.duplicateObservations >= 2, true);
  });

  it('wakes once for a completion transition discovered while waiting', async () => {
    const policy: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 10, onTimeout: 'continue' };
    let clock = 0;
    const observer = new QueueObserver([
      normalize('active'),
      normalize('active'),
      normalize('active', { headSha: HEAD }),
      normalize('completed', { headSha: HEAD }),
    ]);
    const outcome = await awaitMeaningfulChange({
      observer,
      ledger: ledgerFor(),
      policy,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      pollIntervalMs: 1,
    });
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.change.kind, 'completion');
    assert.equal(outcome.wake.shouldWake, true);
    assert.equal(outcome.wake.reason, 'completion');
    assert.equal(outcome.ledger.wakes.length, 1);
  });

  it('wakes the orchestrator only when the timeout policy requires recovery', async () => {
    const escalating: WaitWakePolicy = { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 2, onTimeout: 'policy-action' };
    let clock = 0;
    const outcome = await awaitMeaningfulChange({
      observer: new QueueObserver([normalize('active'), normalize('active')]),
      ledger: ledgerFor(),
      policy: escalating,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      pollIntervalMs: 1,
    });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.idle, false);
    assert.equal(outcome.wake.shouldWake, true);
    assert.equal(outcome.wake.reason, 'timeout-policy');
    assert.equal(outcome.ledger.wakes.length, 1);
  });
});

describe('#35 native observation reuse', () => {
  const nativeHistory = [{ id: 'item-1', type: 'agentMessage' }, { id: 'item-2', type: 'reasoning' }];

  it('observes through thread/read and never starts, resumes, or steers a turn', async () => {
    const calls: string[] = [];
    const observer = new NativeThreadWaitObserver({
      client: {
        observeThread: async (threadId: string) => {
          calls.push(`read:${threadId}`);
          return { threadId, status: 'active', activeTurnId: 'turn-1', history: nativeHistory };
        },
      },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: SUBJECT,
    });
    const value = await observer.observe();
    assert.deepEqual(calls, ['read:thread-1']);
    assert.equal(value.source, 'native');
    assert.equal(value.subjectId, SUBJECT);
    assert.equal(value.status, 'active');
    assert.equal(value.progress.turns, 2);
    assert.equal(value.activeItemId, 'turn-1');
  });

  it('never lets native observation mask an authoritative terminal durable state', async () => {
    // #47 blocking-finding regression: a finished/not-loaded native thread must
    // not hide a FAILED / NEEDS_HUMAN / MERGED durable Run.
    const terminalRuns = [
      { run: applyTransition(newRun(SUBJECT), { type: 'fail' }, T0), expected: 'failed' },
      { run: applyTransition(newRun(SUBJECT), { type: 'escalate', reason: 'human' }, T0), expected: 'blocked' },
    ] as const;
    for (const { run, expected } of terminalRuns) {
      for (const nativeStatus of ['idle', 'unknown', 'active'] as const) {
        const observer = new RunRuntimeObserver(
          { ...run, executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } },
          { now: () => T0, nativeObserver: { snapshot: async () => ({ status: nativeStatus }) } },
        );
        const value = await observer.observe();
        assert.equal(value.status, expected, `${run.state}/${nativeStatus}`);
        const advance = advanceWaitLedger({ ledger: ledgerFor(), observation: value, at: T0 });
        assert.equal(advance.wokeNow, true, `${run.state}/${nativeStatus}`);
        assert.equal(advance.change.kind, expected === 'failed' ? 'failure' : 'blocked', `${run.state}/${nativeStatus}`);
      }
    }
  });

  it('wakes on a native active-to-idle turn completion across a fresh observer', async () => {
    // The completion boundary must come from the durable previous state, never
    // from in-process observer memory: a production wrapper creates a new
    // observer per snapshot, and a restart has no memory at all.
    const run = { ...applyTransition(newRun(SUBJECT), { type: 'start' }, T0), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
    let threadStatus: 'active' | 'idle' = 'active';
    const freshObserver = (): RunRuntimeObserver => new RunRuntimeObserver(run, {
      now: () => T0,
      nativeObserver: {
        snapshot: () => new NativeThreadWaitObserver({
          client: {
            observeThread: async (threadId: string) => threadStatus === 'active'
              ? { threadId, status: 'active' as const, activeTurnId: 'turn-1', history: [] }
              : { threadId, status: 'idle' as const, history: [] },
          },
          threadId: 'thread-1',
          now: () => T0,
          subjectId: SUBJECT,
        }).snapshot(),
      },
    });

    const started = await freshObserver().observe();
    assert.equal(started.status, 'active');
    let ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: started, at: T0 }).ledger;
    assert.equal(ledger.wakes.length, 0);

    threadStatus = 'idle';
    // A brand-new observer instance proves no in-process state is required.
    const finished = await freshObserver().observe();
    assert.equal(finished.status, 'idle');
    const advance = advanceWaitLedger({ ledger, observation: finished, at: T0 });
    assert.equal(advance.change.kind, 'completion');
    assert.equal(advance.wokeNow, true);
    assert.equal(advance.ledger.wakes.length, 1);

    // Replaying the same idle read after a restart does not wake again.
    const replay = advanceWaitLedger({ ledger: advance.ledger, observation: finished, at: T0 });
    assert.equal(replay.wokeNow, false);
    assert.equal(replay.ledger.wakes.length, 1);
  });

  it('does not treat an already-idle native thread as a completion', async () => {
    const native = new NativeThreadWaitObserver({
      client: { observeThread: async (threadId: string) => ({ threadId, status: 'idle' as const, history: [] }) },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: SUBJECT,
    });
    const run = applyTransition(newRun(SUBJECT), { type: 'start' }, T0);
    const observer = new RunRuntimeObserver(
      { ...run, executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } },
      { now: () => T0, nativeObserver: { snapshot: () => native.snapshot() } },
    );
    const value = await observer.observe();
    assert.equal(value.status, 'idle');
    const advance = advanceWaitLedger({ ledger: ledgerFor(), observation: value, at: T0 });
    assert.equal(advance.change.kind, 'none');
    assert.equal(advance.wokeNow, false);
  });

  it('maps native idle and system_error states onto the neutral contract', async () => {
    const idle = await new NativeThreadWaitObserver({
      client: { observeThread: async (threadId: string) => ({ threadId, status: 'idle', history: [] }) },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: SUBJECT,
    }).observe();
    assert.equal(idle.status, 'idle');

    // A native system error is ambiguous, not an authoritative failure. It must
    // never fabricate a failure wake on its own.
    const errored = await new NativeThreadWaitObserver({
      client: { observeThread: async (threadId: string) => ({ threadId, status: 'system_error', history: [] }) },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: SUBJECT,
    }).observe();
    assert.equal(errored.status, 'unavailable');
    assert.equal(classifyWaitChange(null, errored).meaningful, false);
  });

  it('distinguishes successive native turn completions after a saturated history', async () => {
    // A provider whose bounded history has saturated (100 items) must still let
    // two distinct turn completions produce two distinct, waking transitions.
    const run = { ...applyTransition(newRun(SUBJECT), { type: 'start' }, T0), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
    const saturated = Array.from({ length: 100 }, (_, index) => ({ id: `item-${index}`, type: 'agentMessage' }));
    let turnCount = 1;
    let lastCompletedTurnId = 'turn-1';
    let status: 'active' | 'idle' = 'active';
    const observer = (): RunRuntimeObserver => new RunRuntimeObserver(run, {
      now: () => T0,
      nativeObserver: {
        snapshot: async () => ({
          status,
          ...(status === 'active' ? { activeItemId: `turn-${turnCount}` } : {}),
          turns: turnCount,
          lastCompletedTurnId,
          ...({} as Record<string, never>),
          evidence: [],
        }),
      },
    });
    void saturated;

    const activeOne = await observer().observe();
    let ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: activeOne, at: T0 }).ledger;
    status = 'idle';
    const doneOne = await observer().observe();
    const first = advanceWaitLedger({ ledger, observation: doneOne, at: T0 });
    assert.equal(first.change.kind, 'completion');
    assert.equal(first.wokeNow, true);
    ledger = first.ledger;

    // Second turn: active again, then a different completed turn id.
    turnCount = 2;
    lastCompletedTurnId = 'turn-2';
    status = 'active';
    const activeTwo = await observer().observe();
    ledger = advanceWaitLedger({ ledger, observation: activeTwo, at: T0 }).ledger;
    status = 'idle';
    const doneTwo = await observer().observe();
    assert.notEqual(waitObservationDigest(doneOne), waitObservationDigest(doneTwo));
    const second = advanceWaitLedger({ ledger, observation: doneTwo, at: T0 });
    assert.equal(second.change.kind, 'completion');
    assert.equal(second.wokeNow, true);
    assert.equal(second.ledger.wakes.length, 2);
  });

  it('wakes for a real native completion even when one ambiguous read interleaves', async () => {
    // Regression: an ambiguous native read between a genuine active and idle
    // read must neither fabricate a completion nor hide the real one.
    for (const ambiguous of ['throw', 'not_loaded', 'system_error'] as const) {
      const run = { ...applyTransition(newRun(SUBJECT), { type: 'start' }, T0), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
      const modes: Array<'active' | 'ambiguous' | 'idle'> = ['active', 'ambiguous', 'idle'];
      let index = 0;
      const observer = (): RunRuntimeObserver => new RunRuntimeObserver(run, {
        now: () => T0,
        nativeObserver: {
          snapshot: async () => {
            const mode = modes[Math.min(index++, modes.length - 1)]!;
            if (mode === 'ambiguous') {
              if (ambiguous === 'throw') throw new Error('transient native read failure');
              if (ambiguous === 'not_loaded') return { status: 'unknown' };
              return { status: 'unavailable' };
            }
            return mode === 'active'
              ? { status: 'active', activeItemId: 'turn-1', turns: 1 }
              : { status: 'idle', turns: 1, lastCompletedTurnId: 'turn-1' };
          },
        },
      });

      const started = await observer().observe();
      assert.equal(started.source, 'native');
      assert.equal(started.status, 'active');
      let ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: started, at: T0 }).ledger;

      const ambiguousRead = await observer().observe();
      const afterAmbiguous = advanceWaitLedger({ ledger, observation: ambiguousRead, at: T0 });
      ledger = afterAmbiguous.ledger;
      assert.equal(afterAmbiguous.wokeNow, false, `${ambiguous}: ambiguous read must not wake`);

      const finished = await observer().observe();
      assert.equal(finished.source, 'native');
      assert.equal(finished.status, 'idle');
      const completion = advanceWaitLedger({ ledger, observation: finished, at: T0 });
      assert.equal(completion.change.kind, 'completion', `${ambiguous}: real completion must survive`);
      assert.equal(completion.wokeNow, true, `${ambiguous}: real completion must wake exactly once`);
      assert.equal(completion.ledger.wakes.length, 1, `${ambiguous}: exactly one wake`);
    }
  });

  it('wakes for a durable terminal transition that arrives after a native observation', () => {
    // Regression: a durable completed/failed/blocked state is always surfaced
    // through runtime provenance, so the boundary previous=native ->
    // next=runtime-terminal must still be a terminal wake, not progress.
    const nativeActive = normalize('active', { source: 'native' });
    for (const [status, expected] of [['failed', 'failure'], ['blocked', 'blocked'], ['completed', 'completion']] as const) {
      const terminal = normalize(status, { source: 'runtime' });
      let ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: nativeActive, at: T0 }).ledger;
      assert.equal(ledger.wakes.length, 0);
      const advance = advanceWaitLedger({ ledger, observation: terminal, at: T0 });
      assert.equal(advance.change.kind, expected, status);
      assert.equal(advance.wokeNow, true, status);
      assert.equal(advance.ledger.wakes.length, 1, status);
      // The terminal digest is now recorded, so a replay stays silent.
      const replay = advanceWaitLedger({ ledger: advance.ledger, observation: terminal, at: T0 });
      assert.equal(replay.wokeNow, false, status);
      assert.equal(replay.ledger.wakes.length, 1, status);
    }
  });

  it('wakes for a completion whose active phase was never observed', async () => {
    // Every read during the turn was ambiguous: the turn boundary is only
    // visible as a completed-turn identity advance, never as native active.
    for (const ambiguity of ['throw', 'not_loaded'] as const) {
      const run = { ...applyTransition(newRun(SUBJECT), { type: 'start' }, T0), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
      const modes: Array<'idle1' | 'ambiguous' | 'idle2'> = ['idle1', 'ambiguous', 'ambiguous', 'idle2'];
      let index = 0;
      const observer = (): RunRuntimeObserver => new RunRuntimeObserver(run, {
        now: () => T0,
        nativeObserver: {
          snapshot: async () => {
            const mode = modes[Math.min(index++, modes.length - 1)]!;
            if (mode === 'ambiguous') {
              if (ambiguity === 'throw') throw new Error('transient native read failure');
              return { status: 'unknown' };
            }
            return mode === 'idle1'
              ? { status: 'idle', turns: 1, lastCompletedTurnId: 'turn-1' }
              : { status: 'idle', turns: 2, lastCompletedTurnId: 'turn-2' };
          },
        },
      });
      let ledger = ledgerFor();
      const baseline = await observer().observe();
      ledger = advanceWaitLedger({ ledger, observation: baseline, at: T0 }).ledger;
      for (let step = 0; step < 3; step += 1) {
        const next = await observer().observe();
        const advance = advanceWaitLedger({ ledger, observation: next, at: T0 });
        ledger = advance.ledger;
        if (step < 2) assert.equal(advance.wokeNow, false, `${ambiguity}: ambiguous reads stay silent`);
      }
      assert.equal(ledger.wakes.length, 1, `${ambiguity}: the unobserved completion wakes exactly once`);
      assert.equal(ledger.wakes[0]?.reason, 'completion', ambiguity);
    }
  });

  it('stays progress-only for an idle -> idle completed-turn identity advance', () => {
    const idleOne = normalize('idle', { source: 'native', lastCompletedTurnId: 'turn-1' });
    const idleTwo = normalize('idle', { source: 'native', lastCompletedTurnId: 'turn-2' });
    let ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: idleOne, at: T0 }).ledger;
    const advance = advanceWaitLedger({ ledger, observation: idleTwo, at: T0 });
    assert.equal(advance.change.kind, 'progress');
    assert.equal(advance.wokeNow, false);
    assert.equal(advance.ledger.wakes.length, 0);
  });

  it('keeps successive completions distinct when only the completed-turn identity advances', () => {
    // turnCount held constant, so only lastCompletedTurnId can distinguish them.
    const idle = (turn: string) => normalize('idle', { lastCompletedTurnId: turn, progress: { items: 100, turns: 100 } });
    assert.notEqual(waitObservationDigest(idle('turn-1')), waitObservationDigest(idle('turn-2')));
    const transition = classifyWaitChange(idle('turn-1'), idle('turn-2'));
    assert.equal(transition.kind, 'progress');
    assert.equal(decideWaitWake({ change: transition, observation: idle('turn-2') }).shouldWake, false);
    // A genuine native boundary is still a completion.
    const boundary = classifyWaitChange(normalize('active', { source: 'native' }), normalize('idle', { source: 'native', lastCompletedTurnId: 'turn-2' }));
    assert.equal(boundary.kind, 'completion');
  });

  it('never fabricates a completion wake from an ambiguous native read', async () => {
    const run = { ...applyTransition(newRun(SUBJECT), { type: 'start' }, T0), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
    let mode: 'throw' | 'not_loaded' | 'idle' = 'throw';
    const observer = (): RunRuntimeObserver => new RunRuntimeObserver(run, {
      now: () => T0,
      nativeObserver: {
        snapshot: async () => {
          if (mode === 'throw') throw new Error('transient native read failure');
          if (mode === 'not_loaded') return { status: 'unknown' };
          return { status: 'idle' };
        },
      },
    });
    // A transient read failure degrades to the durable runtime observation.
    const degraded = await observer().observe();
    assert.equal(degraded.source, 'runtime');
    assert.equal(degraded.status, 'active');
    // Recovery to idle must be progress, not a fabricated completion.
    mode = 'idle';
    const recovered = await observer().observe();
    assert.equal(recovered.status, 'idle');
    assert.equal(classifyWaitChange(degraded, recovered).kind, 'progress');
    const advance = advanceWaitLedger({ ledger: advanceWaitLedger({ ledger: ledgerFor(), observation: degraded, at: T0 }).ledger, observation: recovered, at: T0 });
    assert.equal(advance.wokeNow, false);

    // A not-loaded thread is equally ambiguous.
    let ledger = ledgerFor();
    mode = 'not_loaded';
    const notLoaded = await observer().observe();
    assert.equal(notLoaded.source, 'runtime');
    assert.equal(notLoaded.status, 'active');
    ledger = advanceWaitLedger({ ledger, observation: notLoaded, at: T0 }).ledger;
    mode = 'idle';
    const afterLoad = await observer().observe();
    const ambiguous = advanceWaitLedger({ ledger, observation: afterLoad, at: T0 });
    assert.equal(ambiguous.change.kind, 'progress');
    assert.equal(ambiguous.wokeNow, false);
  });

  it('presents the same normalized baseline wake semantics as the fallback path', async () => {
    const nativeObserver = new NativeThreadWaitObserver({
      client: {
        observeThread: async (threadId: string) => ({ threadId, status: 'active', activeTurnId: 'turn-1', history: nativeHistory }),
      },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: SUBJECT,
    });
    const nativeLedger = advanceWaitLedger({ ledger: ledgerFor(), observation: await nativeObserver.observe(), at: T0 });
    assert.equal(nativeLedger.change.kind, 'none');
    assert.equal(nativeLedger.wokeNow, false);

    const fallback = new RunRuntimeObserver(newRun(SUBJECT), { now: () => T0 });
    const fallbackLedger = advanceWaitLedger({ ledger: ledgerFor(), observation: await fallback.observe(), at: T0 });
    assert.equal(fallbackLedger.change.kind, 'none');
    assert.equal(fallbackLedger.wokeNow, false);
  });

  it('uses the run subject for native evidence so one ledger owns one writer', async () => {
    const observer = new NativeThreadWaitObserver({
      client: { observeThread: async (threadId: string) => ({ threadId, status: 'idle', history: [] }) },
      threadId: 'thread-1',
      now: () => T0,
      subjectId: 'run-42',
    });
    const value = await observer.observe();
    assert.equal(value.subjectId, 'run-42');
    const advance = advanceWaitLedger({ ledger: ledgerFor('run-42'), observation: value, at: T0 });
    assert.equal(advance.ledger.ownerRunId, 'run-42');
  });
});

describe('runtime fallback observation', () => {
  it('never starts a model turn and reports the durable run status', async () => {
    const run = newRun(SUBJECT);
    const observer = new RunRuntimeObserver(run, { now: () => T0 });
    const value = await observer.observe();
    assert.equal(observer.source, 'runtime');
    assert.equal(value.subjectId, run.id);
    assert.ok(WORKFLOW_STATES.includes(run.state));
    assert.equal(value.status, 'active');
  });

  it('degrades to the deterministic fallback when native observation is unavailable', async () => {
    const run = { ...newRun(SUBJECT), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
    const observer = new RunRuntimeObserver(run, {
      now: () => T0,
      nativeObserver: { snapshot: async () => { throw new Error('native runtime unavailable'); } },
    });
    const value = await observer.observe();
    assert.equal(value.source, 'runtime');
    assert.equal(value.status, 'active');
  });

  it('enriches the fallback observation from the native runtime when it is available', async () => {
    const run = { ...newRun(SUBJECT), executor: { provider: 'codex-app-server', sessionId: 'thread-1', generation: 'generation-1' } };
    const observer = new RunRuntimeObserver(run, {
      now: () => T0,
      nativeObserver: { snapshot: async () => ({ status: 'idle', turns: 7 }) },
    });
    const value = await observer.observe();
    assert.equal(value.source, 'native');
    assert.equal(value.status, 'idle');
    assert.equal(value.progress.turns, 7);
  });

  it('does not report a head move when the exact-HEAD probe fails transiently', async () => {
    const run = { ...newRun(SUBJECT), headSha: HEAD };
    const observer = new RunRuntimeObserver(run, { now: () => T0, readHead: async () => null });
    const value = await observer.observe();
    assert.equal(value.headSha, HEAD);
    assert.equal(value.evidence.some((item) => item.kind === 'head-changed'), false);
    assert.equal(classifyWaitChange(
      normalizeWaitObservation({ source: 'runtime', subjectId: SUBJECT, observedAt: T0, snapshot: { status: 'active', headSha: HEAD } }),
      value,
    ).kind, 'none');
  });

  it('reads exact HEAD read-only through the injected runner', async () => {
    const calls: string[][] = [];
    const readHead = gitHeadReader({
      run: async (_file, args) => { calls.push([...args]); return { exitCode: 0, stdout: `${HEAD}\n` }; },
    }, '/tmp/workspace');
    assert.equal(await readHead(newRun(SUBJECT)), HEAD);
    assert.deepEqual(calls, [['rev-parse', 'HEAD']]);
  });
});

describe('wait ledger persistence', () => {
  it('round-trips one ledger atomically and rejects foreign identity', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-wait-ledger-'));
    try {
      const filePath = path.join(directory, 'state.json');
      const store = new WaitLedgerFileStore({ filePath });
      assert.equal(store.read(), null);
      const ledger = advanceWaitLedger({ ledger: ledgerFor(), observation: normalize('active'), at: T0 }).ledger;
      store.write(ledger);
      const read = store.read();
      assert.notEqual(read, null);
      assert.equal(read?.ownerRunId, SUBJECT);
      assert.ok(waitLedgerBelongsTo(read!, { subjectId: SUBJECT, ownerRunId: SUBJECT, generation: 'generation-1' }));
      assert.equal(waitLedgerBelongsTo(read!, { subjectId: 'other', ownerRunId: SUBJECT, generation: 'generation-1' }), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on a corrupt ledger instead of discarding durable state', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-wait-corrupt-'));
    try {
      const filePath = path.join(directory, 'state.json');
      writeFileSync(filePath, '{not json');
      const store = new WaitLedgerFileStore({ filePath });
      assert.throws(() => store.read(), /not a valid/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('observation service wiring', () => {
  it('reports a wake exactly once through the observe path', async () => {
    const observer = new QueueObserver([normalize('completed')]);
    const { advance } = await observeWaitState({
      observer,
      ledger: null,
      at: T0,
      policy: DEFAULT_WAIT_WAKE_POLICY,
      expectedOwnerRunId: SUBJECT,
      expectedGeneration: 'generation-1',
    });
    assert.equal(advance.wokeNow, true);
    assert.equal(advance.ledger.wakes.length, 1);
  });
});
