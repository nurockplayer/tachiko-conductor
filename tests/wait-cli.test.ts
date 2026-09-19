import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { main, resolveWaitLedgerFile, resolveWaitLedgerPath, resolveWaitWakePolicy } from '../src/cli.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { createWaitLedger } from '../src/domain/wait.js';
import { projectRunEfficiency } from '../src/domain/telemetry.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
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

      // A repeated timeout wake must be idempotent for the same normalized state.
      const repeated = await runMain(env, ['wait', 'await', run.id, '--timeout-ms', '0', '--poll-interval-ms', '0', '--on-timeout', 'policy-action']);
      const repeatedParsed = JSON.parse(repeated.stdout[0]!) as { wake: { shouldWake: boolean } };
      assert.equal(repeatedParsed.wake.shouldWake, true);
      const afterRepeat = new JsonFileStore({ dir: dataDir }).read(run.id);
      assert.equal(afterRepeat?.telemetry?.events.filter((event) => event.kind === 'wait_status_wakeup').length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a foreign durable ledger instead of adopting another run writer', async () => {
    const { directory, dataDir, env } = tempWorkspace();
    try {
      const run = createRun(TARGET, T0, 'run-wait-foreign');
      seedRun(dataDir, run);
      const filePath = resolveWaitLedgerFile(run.id, env);
      mkdirSync(path.dirname(filePath), { recursive: true });
      const foreign = createWaitLedger({ subjectId: 'other-run', ownerRunId: 'other-run', generation: 'generation-x' });
      writeFileSync(filePath, `${JSON.stringify({ revision: foreign.revision, ledger: foreign }, null, 2)}\n`);

      const result = await runMain(env, ['wait', 'observe', run.id]);
      const parsed = JSON.parse(result.stdout[0]!) as { ledgerRejected: boolean; wake: { shouldWake: boolean } };
      assert.equal(parsed.ledgerRejected, true);
      // The replacement ledger is still written under this run's identity.
      const replacement = new WaitLedgerFileStore({ filePath }).read();
      assert.equal(replacement?.ownerRunId, run.id);
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
