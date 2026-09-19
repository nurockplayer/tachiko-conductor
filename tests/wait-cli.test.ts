import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildWaitCommandDependencies, main, resolveWaitLedgerDirectory, resolveWaitLedgerFile, resolveWaitLedgerPath, resolveWaitWakePolicy } from '../src/cli.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { DEFAULT_WAIT_WAKE_POLICY, createWaitLedger, markWaitWakesDelivered, pendingWaitWakes } from '../src/domain/wait.js';
import { acknowledgeWaitDelivery, waitObserveCommand } from '../src/workflow/wait-command.js';
import type { WaitLedgerStore } from '../src/workflow/wait-ledger-store.js';
import { CODEX_APP_SERVER_PROVIDER } from '../src/agents/codex-app-server.js';
import { projectRunEfficiency } from '../src/domain/telemetry.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { waitAwaitCommand } from '../src/workflow/wait-command.js';
import { WaitLedgerFileStore } from '../src/workflow/wait-ledger-store.js';
import { T0, TARGET } from './helpers.js';

function tempWorkspace(): { readonly directory: string; readonly dataDir: string; readonly env: NodeJS.ProcessEnv } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-wait-cli-'));
  const dataDir = path.join(directory, 'runs');
  return { directory, dataDir, env: { TACHIKO_DATA_DIR: dataDir, TACHIKO_WAIT_LEDGER_PATH: path.join(directory, 'wait', 'state.json') } };
}

async function runMain(env: NodeJS.ProcessEnv, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string[] }> {
  const saved = { ...process.env };
  const printed: string[] = [];
  const original = console.log;
  Object.assign(process.env, env);
  console.log = (value?: unknown) => { printed.push(String(value)); };
  try {
    return { code: await main([...args]), stdout: printed };
  } finally {
    console.log = original;
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

function seedRun(dataDir: string, run: ReturnType<typeof createRun>): void {
  new JsonFileStore({ dir: dataDir }).create(run);
}

describe('wait CLI', () => {
  it('resolves an explicit ledger override and a revisioned default policy', () => {
    assert.equal(resolveWaitLedgerPath({ TACHIKO_WAIT_LEDGER_PATH: '/tmp/custom/state.json' }), '/tmp/custom/state.json');
    const fallback = resolveWaitLedgerPath({ TACHIKO_DATA_DIR: '/tmp/data/runs' });
    assert.equal(fallback, path.join('/tmp/data', 'wait', 'state.json'));
    assert.equal(resolveWaitLedgerFile('run-1', { TACHIKO_DATA_DIR: '/tmp/data/runs' }), path.join('/tmp/data', 'wait', 'run-1.wait.json'));

    const policy = resolveWaitWakePolicy({ 'timeout-ms': '250', 'on-timeout': 'policy-action' });
    assert.equal(policy.timeoutMs, 250);
    assert.equal(policy.onTimeout, 'policy-action');
    assert.throws(() => resolveWaitWakePolicy({ 'timeout-ms': '-1' }), /non-negative/);
    assert.throws(() => resolveWaitWakePolicy({ 'on-timeout': 'sometimes' }), /continue or policy-action/);
  });

  it('resolves one per-run ledger under an explicit wait ledger directory', () => {
    const directory = path.join(os.tmpdir(), 'tachiko-wait-dir');
    assert.equal(resolveWaitLedgerDirectory({ TACHIKO_WAIT_LEDGER_DIR: directory }), directory);
    assert.equal(resolveWaitLedgerFile('run-9', { TACHIKO_WAIT_LEDGER_DIR: directory }), path.join(directory, 'run-9.wait.json'));
    // A path-style override still selects the containing directory.
    assert.equal(
      resolveWaitLedgerDirectory({ TACHIKO_WAIT_LEDGER_DIR: '', TACHIKO_WAIT_LEDGER_PATH: '/tmp/other/state.json' }),
      '/tmp/other',
    );
  });

  it('observes a waiting run without a model turn and coalesces a repeat', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-cli'), { type: 'wait_dependency' }, T0);
      seedRun(dataDir, run);

      const first = await runMain(env, ['wait', 'observe', run.id]);
      assert.equal(first.code, 0);
      const firstResult = JSON.parse(first.stdout[0]!) as { modelTurns: number; wake: { shouldWake: boolean }; change: string };
      assert.equal(firstResult.modelTurns, 0);
      // First observation of a paused run establishes the blocked baseline.
      assert.equal(firstResult.change, 'blocked');
      assert.equal(firstResult.wake.shouldWake, true);

      const second = await runMain(env, ['wait', 'observe', run.id]);
      const secondResult = JSON.parse(second.stdout[0]!) as { modelTurns: number; wake: { shouldWake: boolean }; change: string; duplicateObservations: number };
      assert.equal(secondResult.modelTurns, 0);
      assert.equal(secondResult.change, 'none');
      assert.equal(secondResult.wake.shouldWake, false);
      assert.equal(secondResult.duplicateObservations, 1);

      const ledger = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.notEqual(ledger, null);
      assert.equal(ledger?.wakes.length, 1);
      assert.equal(ledger?.observations.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wakes exactly once on native active -> idle through the production dependency wrapper', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = {
        ...createRun(TARGET, T0, 'run-wait-native-wiring'),
        executor: { provider: 'codex-app-server', sessionId: 'thread-native-1', generation: 'generation-native-1' },
      };
      const store = new JsonFileStore({ dir: dataDir });
      store.create(run);
      const startup = await waitAwaitCommand(
        { id: run.id, mode: 'wait', policy: { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 0, onTimeout: 'continue' }, pollIntervalMs: 0 },
        {
          ...buildWaitCommandDependencies({
            store,
            run,
            env,
            now: () => T0,
            appServerAdapter: {
              observeRuntime: async () => ({ threadId: 'thread-native-1', status: 'active' as const, activeTurnId: 'turn-1', history: [] }),
            },
          }),
          monotonicNow: () => 0,
          sleep: async () => undefined,
        },
      );
      assert.equal(startup.source, 'native');
      assert.equal(startup.status, 'active');
      assert.equal(startup.wake.shouldWake, false);

      // A brand-new dependency wrapper (as a separate CLI invocation creates)
      // now sees the same native thread idle. The completion boundary must come
      // from the durable previous observation, not observer memory.
      let reads = 0;
      const finished = await waitAwaitCommand(
        { id: run.id, mode: 'wait', policy: { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 10, onTimeout: 'continue' }, pollIntervalMs: 1 },
        {
          ...buildWaitCommandDependencies({
            store,
            run,
            env,
            now: () => T0,
            appServerAdapter: {
              observeRuntime: async () => {
                reads += 1;
                return { threadId: 'thread-native-1', status: 'idle' as const, history: [] };
              },
            },
          }),
          monotonicNow: () => 0,
          sleep: async () => undefined,
        },
      );

      assert.equal(reads >= 1, true);
      assert.equal(finished.source, 'native');
      assert.equal(finished.change, 'completion');
      assert.equal(finished.wake.shouldWake, true);
      assert.equal(finished.wake.reason, 'completion');
      assert.equal(finished.wakeCount, 1);
      assert.equal(finished.modelTurns, 0);

      const ledger = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.equal(ledger?.wakes.length, 1);
      assert.equal(ledger?.wakes[0]?.reason, 'completion');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains one native observer for the dependency lifetime and wakes once on active -> idle', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = {
        ...createRun(TARGET, T0, 'run-wait-native-lifetime'),
        executor: { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'thread-lifetime', generation: 'generation-1' },
      };
      const store = new JsonFileStore({ dir: dataDir });
      store.create(run);
      const observedStatuses: string[] = [];
      // The provider reports active once and then idle.
      const dependencies = buildWaitCommandDependencies({
        store,
        run,
        env,
        now: () => T0,
        appServerAdapter: {
          observeRuntime: async () => {
            const status = observedStatuses.length === 0 ? 'active' as const : 'idle' as const;
            observedStatuses.push(status);
            return {
              threadId: 'thread-lifetime',
              status,
              ...(status === 'active' ? { activeTurnId: 'turn-1' } : {}),
              history: [],
            };
          },
        },
      });
      // One dependency object must expose exactly one retained observer.
      const observer = dependencies.nativeObserver;
      assert.notEqual(observer, undefined);
      assert.equal(dependencies.nativeObserver, observer);
      let clock = 0;
      const result = await waitAwaitCommand(
        { id: run.id, mode: 'wait', policy: { ...DEFAULT_WAIT_WAKE_POLICY, timeoutMs: 10, onTimeout: 'continue' }, pollIntervalMs: 1 },
        { ...dependencies, monotonicNow: () => clock, sleep: async (milliseconds) => { clock += milliseconds; } },
      );
      assert.deepEqual(observedStatuses.slice(0, 2), ['active', 'idle']);
      assert.equal(result.source, 'native');
      assert.equal(result.change, 'completion');
      assert.equal(result.wake.shouldWake, true);
      assert.equal(result.wake.reason, 'completion');
      assert.equal(result.wakeCount, 1);
      assert.equal(result.modelTurns, 0);
      const ledger = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.equal(ledger?.wakes.length, 1);
      assert.equal(ledger?.wakes[0]?.reason, 'completion');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps an idle bounded wait model-free and records no run telemetry wake', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-idle');
      seedRun(dataDir, run);

      const result = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'continue']);
      assert.equal(result.code, 0);
      const parsed = JSON.parse(result.stdout[0]!) as { idle: boolean; timedOut: boolean; wake: { shouldWake: boolean }; modelTurns: number };
      assert.equal(parsed.modelTurns, 0);
      assert.equal(parsed.timedOut, true);
      assert.equal(parsed.wake.shouldWake, false);
      assert.equal(parsed.idle, true);
      assert.equal(result.stdout.includes('TACHIKO_WAIT_IDLE_V1'), true);

      const stored = new JsonFileStore({ dir: dataDir }).read(run.id);
      assert.equal(stored?.telemetry?.events.some((event) => event.kind === 'wait_status_wakeup') ?? false, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wakes once and records bounded run telemetry when the wait policy requires recovery', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-policy');
      seedRun(dataDir, run);

      const result = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      const parsed = JSON.parse(result.stdout[0]!) as { wake: { shouldWake: boolean; reason: string } };
      assert.equal(parsed.wake.shouldWake, true);
      assert.equal(parsed.wake.reason, 'timeout-policy');
      assert.equal(result.stdout.includes('TACHIKO_WAIT_WAKE_V1'), true);

      const stored = new JsonFileStore({ dir: dataDir }).read(run.id);
      assert.equal(stored?.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup').length, 1);
      const projection = projectRunEfficiency(stored!);
      assert.deepEqual(projection.metrics.waitStatusWakeups, { status: 'observed', value: 1 });

      // An identical timeout for unchanged state must not become a periodic
      // model wake: the second and third invocations stay model-free.
      let wakeMarkers = 1;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const repeated = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
        const repeatedParsed = JSON.parse(repeated.stdout[0]!) as { wake: { shouldWake: boolean }; wakeCount: number };
        assert.equal(repeatedParsed.wake.shouldWake, false);
        assert.equal(repeatedParsed.wakeCount, 1);
        assert.equal(repeated.stdout.includes('TACHIKO_WAIT_WAKE_V1'), false);
        assert.equal(repeated.stdout.includes('TACHIKO_WAIT_IDLE_V1'), true);
        wakeMarkers += repeated.stdout.includes('TACHIKO_WAIT_WAKE_V1') ? 1 : 0;
      }
      assert.equal(wakeMarkers, 1);
      const afterRepeat = new JsonFileStore({ dir: dataDir }).read(run.id);
      assert.equal(afterRepeat?.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup').length, 1);
      const ledgerAfterRepeat = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.equal(ledgerAfterRepeat?.wakes.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a distinct timeout wake after the observed state actually changes', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-timeout-change');
      seedRun(dataDir, run);
      const first = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      assert.equal((JSON.parse(first.stdout[0]!) as { wake: { shouldWake: boolean } }).wake.shouldWake, true);
      // A real state change (HEAD moves) re-arms the bounded wait episode.
      const moved = { ...run, headSha: 'a'.repeat(40) };
      new JsonFileStore({ dir: dataDir }).update(moved);
      const second = await runMain(env, ['wait', 'observe', run.id]);
      const parsed = JSON.parse(second.stdout[0]!) as { change: string; wake: { shouldWake: boolean }; wakeCount: number };
      assert.equal(parsed.change, 'progress');
      assert.equal(parsed.wake.shouldWake, false);
      assert.equal(parsed.wakeCount, 1);
      const third = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      const thirdParsed = JSON.parse(third.stdout[0]!) as { wake: { shouldWake: boolean; reason: string }; wakeCount: number };
      assert.equal(thirdParsed.wake.shouldWake, true);
      assert.equal(thirdParsed.wake.reason, 'timeout-policy');
      assert.equal(thirdParsed.wakeCount, 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on a foreign durable ledger without overwriting another writer', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-foreign');
      seedRun(dataDir, run);
      const filePath = resolveWaitLedgerFile(run.id, env);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const foreign = createWaitLedger({ subjectId: 'other-run', ownerRunId: 'other-run', generation: 'generation-x' });
      writeFileSync(filePath, `${JSON.stringify({ revision: foreign.revision, ledger: foreign }, null, 2)}\n`);

      await assert.rejects(() => runMain(env, ['wait', 'observe', run.id]), /different subject\/owner\/generation/);
      // The foreign ledger is left byte-for-byte intact: no adoption, no clobber.
      const untouched = new WaitLedgerFileStore({ filePath }).read();
      assert.equal(untouched?.ownerRunId, 'other-run');
      assert.equal(untouched?.subjectId, 'other-run');
      assert.equal(untouched?.observations.length, 0);
      assert.equal(untouched?.wakes.length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records a wake without ever overwriting a concurrent durable transition', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-concurrent'), { type: 'start' }, T0);
      const store = new JsonFileStore({ dir: dataDir });
      store.create(run);
      const filePath = resolveWaitLedgerFile(run.id, env);
      const ledgerStore = new WaitLedgerFileStore({ filePath });
      // A concurrent writer reaches a human decision boundary while the wait
      // path is between its read and its telemetry write.
      const concurrent: WaitLedgerStore = {
        read: () => ledgerStore.read(),
        write: (ledger) => {
          ledgerStore.write(ledger);
          store.update(applyTransition(store.read(run.id)!, { type: 'wait_dependency' }, T0));
        },
      };
      const result = await waitObserveCommand(
        { id: run.id, mode: 'observe' },
        { store, ledgerStore: concurrent, now: () => T0 },
      );
      assert.equal(result.status, 'active');
      // The wait path must not write back its stale IMPLEMENTING snapshot.
      const after = store.read(run.id);
      assert.equal(after?.state, 'WAITING_DEPENDENCY');
      assert.equal(after?.history.length, 2);
      // No #47 wake evidence: the wait path captured nothing from its stale read.
      assert.equal(after?.telemetry?.events.filter((event) => event.id.startsWith('wait-wake:')).length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a wake that was recorded before the runtime restarted', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-restart');
      seedRun(dataDir, run);
      const first = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      assert.equal((JSON.parse(first.stdout[0]!) as { wakeCount: number }).wakeCount, 1);
      // A brand-new process reads the same durable ledger and must not re-wake.
      const second = await runMain(env, ['wait', 'observe', run.id]);
      const parsed = JSON.parse(second.stdout[0]!) as { wake: { shouldWake: boolean }; wakeCount: number; duplicateObservations: number };
      assert.equal(parsed.wake.shouldWake, false);
      assert.equal(parsed.wakeCount, 1);
      assert.equal(parsed.duplicateObservations, 1);
      const third = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      assert.equal((JSON.parse(third.stdout[0]!) as { wake: { shouldWake: boolean } }).wake.shouldWake, false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('wakes on a native active-to-idle completion through the production dependency wrapper', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = {
        ...applyTransition(createRun(TARGET, T0, 'run-wait-native'), { type: 'start' }, T0),
        executor: { provider: CODEX_APP_SERVER_PROVIDER, sessionId: 'thread-1', generation: 'generation-1' },
      };
      const store = new JsonFileStore({ dir: dataDir });
      store.create(run);
      let threadStatus: 'active' | 'idle' = 'active';
      // The wrapper creates a fresh observer for every snapshot, so this proves
      // the completion boundary comes from durable state, not observer memory.
      const dependencies = buildWaitCommandDependencies({
        store,
        run,
        env,
        now: () => T0,
        appServerAdapter: {
          observeRuntime: async () => ({
            threadId: 'thread-1',
            status: threadStatus,
            ...(threadStatus === 'active' ? { activeTurnId: 'turn-1' } : {}),
            history: [],
          }),
        },
      });
      const started = await waitObserveCommand({ id: run.id, mode: 'observe' }, dependencies);
      assert.equal(started.status, 'active');
      assert.equal(started.wake.shouldWake, false);

      threadStatus = 'idle';
      const finished = await waitObserveCommand({ id: run.id, mode: 'observe' }, dependencies);
      assert.equal(finished.change, 'completion');
      assert.equal(finished.wake.shouldWake, true);
      assert.equal(finished.wake.reason, 'completion');
      assert.equal(finished.modelTurns, 0);
      const stored = store.read(run.id);
      assert.equal(stored?.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup').length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never re-wakes a terminal run through the timeout path', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-terminal-timeout'), { type: 'fail' }, T0);
      const store = new JsonFileStore({ dir: dataDir });
      store.create(run);
      const first = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      const firstParsed = JSON.parse(first.stdout[0]!) as { change: string; wake: { shouldWake: boolean; reason: string }; wakeCount: number };
      assert.equal(firstParsed.change, 'failure');
      assert.equal(firstParsed.wake.shouldWake, true);
      assert.equal(firstParsed.wake.reason, 'failure');
      assert.equal(firstParsed.wakeCount, 1);

      // A second identical invocation must not turn the timeout policy into a
      // timer wake for an already-reconciled terminal run.
      const second = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      const secondParsed = JSON.parse(second.stdout[0]!) as { change: string; wake: { shouldWake: boolean }; wakeCount: number };
      assert.equal(secondParsed.wake.shouldWake, false);
      assert.equal(secondParsed.wakeCount, 1);
      assert.equal(second.stdout.includes('TACHIKO_WAIT_WAKE_V1'), false);
      assert.equal(second.stdout.includes('TACHIKO_WAIT_IDLE_V1'), true);
      const ledger = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.deepEqual(ledger?.wakes.map((wake) => wake.reason), ['failure']);

      // Digest drift on an already-terminal run must not convert a progress-only
      // observation into a model wake.
      for (const headSha of ['a'.repeat(40), 'b'.repeat(40)]) {
        const drifted = { ...store.read(run.id)!, headSha };
        store.update(drifted);
        const afterDrift = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
        const driftedParsed = JSON.parse(afterDrift.stdout[0]!) as { change: string; wake: { shouldWake: boolean }; wakeCount: number };
        assert.equal(driftedParsed.wake.shouldWake, false);
        assert.equal(driftedParsed.wakeCount, 1);
        assert.equal(afterDrift.stdout.includes('TACHIKO_WAIT_WAKE_V1'), false);
      }
      const finalLedger = new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }).read();
      assert.deepEqual(finalLedger?.wakes.map((wake) => wake.reason), ['failure']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replays a wake that was recorded but never delivered before a crash', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-crash-replay'), { type: 'fail' }, T0);
      seedRun(dataDir, run);
      const filePath = resolveWaitLedgerFile(run.id, env);
      const ledgerStore = new WaitLedgerFileStore({ filePath });

      const first = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      assert.equal((JSON.parse(first.stdout[0]!) as { wake: { shouldWake: boolean } }).wake.shouldWake, true);

      // Simulate a crash after the ledger write but before the wake was handed
      // to the caller: clear the delivery record.
      const recorded = ledgerStore.read()!;
      assert.equal(pendingWaitWakes(recorded).length, 0, 'a delivered wake is not pending');
      ledgerStore.write(markWaitWakesDelivered({ ...recorded, deliveredWakeIds: [] }, []));
      assert.equal(pendingWaitWakes(ledgerStore.read()!).length, 1);

      // A restarted process must replay the undelivered wake exactly once.
      const replayed = await runMain(env, ['wait', 'observe', run.id]);
      const replayedParsed = JSON.parse(replayed.stdout[0]!) as { wake: { shouldWake: boolean; reason: string }; wakeCount: number };
      assert.equal(replayedParsed.wake.shouldWake, true);
      assert.equal(replayedParsed.wake.reason, 'failure');
      assert.equal(replayedParsed.wakeCount, 1);
      assert.equal(replayed.stdout.includes('TACHIKO_WAIT_WAKE_V1'), true);

      // Once delivered, later processes stay idle.
      const settled = await runMain(env, ['wait', 'observe', run.id]);
      const settledParsed = JSON.parse(settled.stdout[0]!) as { wake: { shouldWake: boolean }; pendingWakes: readonly unknown[] };
      assert.equal(settledParsed.wake.shouldWake, false);
      assert.deepEqual(settledParsed.pendingWakes, []);
      assert.equal(settled.stdout.includes('TACHIKO_WAIT_WAKE_V1'), false);
      assert.equal(pendingWaitWakes(ledgerStore.read()!).length, 0);

      // The helper is idempotent once everything is delivered.
      const current = ledgerStore.read()!;
      acknowledgeWaitDelivery({
        ok: true, mode: 'observe', runId: run.id, state: run.state, source: 'runtime', subjectId: run.id,
        status: 'failed', headSha: null, observationDigest: '', change: 'none',
        wake: { shouldWake: false, reason: null, evidence: [] }, pendingWakes: [], modelTurns: 0,
        timedOut: false, idle: true, observations: 1, duplicateObservations: 1, wakeCount: 1,
        waitStartedAt: null, observedDigest: '',
      }, ledgerStore);
      assert.deepEqual(ledgerStore.read()?.deliveredWakeIds?.length, current.deliveredWakeIds?.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('acknowledges only the wakes the result actually carried', () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-ack-scope'), { type: 'fail' }, T0);
      seedRun(dataDir, run);
      const filePath = resolveWaitLedgerFile(run.id, env);
      const ledgerStore = new WaitLedgerFileStore({ filePath });
      const base = createWaitLedger({ subjectId: run.id, ownerRunId: run.id, generation: run.id });
      const wakeOf = (id: string, reason: 'failure' | 'completion') => ({
        id, at: T0, reason, source: 'runtime' as const, subjectId: run.id, status: 'failed' as const,
        observationDigest: id.padEnd(64, 'a'), evidence: [],
      });
      ledgerStore.write({
        ...base,
        // Two distinct recorded wakes; only the first is carried by the result.
        wakes: [wakeOf('wake-a', 'failure'), wakeOf('wake-b', 'completion')],
        terminalDigests: ['wake-a'.padEnd(64, 'a'), 'wake-b'.padEnd(64, 'a')],
        terminalReached: true,
      });
      assert.equal(pendingWaitWakes(ledgerStore.read()!).length, 2);

      acknowledgeWaitDelivery({
        ok: true, mode: 'observe', runId: run.id, state: run.state, source: 'runtime', subjectId: run.id,
        status: 'failed', headSha: null, observationDigest: '', change: 'failure',
        wake: { shouldWake: true, reason: 'failure', evidence: [] },
        pendingWakes: [{ id: 'wake-a', reason: 'failure', subjectId: run.id, status: 'failed' }],
        modelTurns: 0, timedOut: false, idle: false, observations: 1, duplicateObservations: 0,
        wakeCount: 2, waitStartedAt: null, observedDigest: '',
      }, ledgerStore);

      const after = pendingWaitWakes(ledgerStore.read()!);
      assert.deepEqual(after.map((wake) => wake.id), ['wake-b'], 'a wake the result never carried must stay pending');
      // A later process replays the wake that was never delivered.
      const replayed = ledgerStore.read()!;
      assert.equal(replayed.deliveredWakeIds?.includes('wake-a'), true);
      assert.equal(replayed.deliveredWakeIds?.includes('wake-b'), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an unknown run id and malformed schedule values', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      void dataDir;
      await assert.rejects(() => runMain(env, ['wait', 'observe', 'missing-run']), /was not found/);
      const seeded = createRun(TARGET, T0, 'run-wait-args');
      seedRun(dataDir, seeded);
      await assert.rejects(() => runMain(env, ['wait', 'observe', seeded.id, '--timeout-ms', 'soon']), /non-negative/);
      await assert.rejects(() => runMain(env, ['wait', 'observe', seeded.id, '--on-timeout', 'later']), /continue or policy-action/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prints usage for an unknown wait subcommand', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      void dataDir;
      const saved = { ...process.env };
      const errors: string[] = [];
      const original = console.error;
      Object.assign(process.env, env);
      console.error = (value?: unknown) => { errors.push(String(value)); };
      try {
        assert.equal(await main(['wait', 'poll']), 1);
      } finally {
        console.error = original;
        for (const key of Object.keys(env)) delete process.env[key];
        Object.assign(process.env, saved);
      }
      assert.ok(errors.some((line) => line.includes('Unknown command: wait poll')));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never invokes a model adapter on the wait path', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = applyTransition(createRun(TARGET, T0, 'run-wait-nomodel'), { type: 'wait_dependency' }, T0);
      seedRun(dataDir, run);
      // The evidence for "no model turn" is structural: the wait command never
      // constructs an implementation/reviewer adapter, and reports modelTurns 0.
      const source = readFileSync(new URL('../src/workflow/wait-command.ts', import.meta.url), 'utf8');
      assert.equal(source.includes('ImplementationAgent'), false);
      assert.equal(source.includes('ReviewerAdapter'), false);
      const result = await runMain(env, ['wait', 'observe', run.id]);
      assert.equal((JSON.parse(result.stdout[0]!) as { modelTurns: number }).modelTurns, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
