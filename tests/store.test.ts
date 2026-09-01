import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { T0, TARGET, newRun, successResult } from './helpers.js';

const tmpDirs: string[] = [];

function tempStore(): { store: JsonFileStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-'));
  tmpDirs.push(dir);
  return { store: new JsonFileStore({ dir }), dir };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('JsonFileStore — persistence round-trips', () => {
  it('persists a created run and reads it back intact', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    assert.deepEqual(store.read('r1'), newRun('r1'));
  });

  it('persists updates across store instances (simulated restart)', () => {
    const { dir } = tempStore();
    const first = new JsonFileStore({ dir });
    let run = newRun('r1');
    first.create(run);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('sha-1') }, T0);
    first.update(run);

    const restarted = new JsonFileStore({ dir });
    const loaded = restarted.read('r1');
    assert.equal(loaded?.state, 'VALIDATING');
    assert.equal(loaded?.headSha, 'sha-1');
    assert.equal(loaded?.history.length, 2);
  });

  it('persists provider-neutral executor continuity and bounded execution metadata across restart', () => {
    const { dir } = tempStore();
    const first = new JsonFileStore({ dir });
    let run = applyTransition(newRun('r1'), { type: 'start' }, T0);
    run = applyTransition(
      run,
      {
        type: 'agent_succeeded',
        agentResult: {
          ...successResult('sha-1'),
          sessionId: 'legacy-session-1',
          executor: { provider: 'codex-cli', sessionId: 'thread-1' },
          durationMs: 125,
        },
      },
      T0,
    );
    first.create(run);

    const loaded = new JsonFileStore({ dir }).read('r1');
    assert.equal(loaded?.agentResult?.sessionId, 'legacy-session-1');
    assert.deepEqual(loaded?.executor, { provider: 'codex-cli', sessionId: 'thread-1' });
    assert.equal(loaded?.agentResult?.durationMs, 125);
  });

  it('returns null for unknown ids', () => {
    const { store } = tempStore();
    assert.equal(store.read('nope'), null);
  });

  it('lists all persisted runs', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    store.create(newRun('r2'));
    assert.deepEqual(
      store
        .list()
        .map((r) => r.id)
        .sort(),
      ['r1', 'r2'],
    );
  });

  it('refuses to overwrite an existing run id', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    assert.throws(() => store.create(newRun('r1')), /already exists/);
  });

  it('rejects unsafe run ids', () => {
    const { store } = tempStore();
    const evil = { ...newRun(), id: '../evil' };
    assert.throws(() => store.create(evil), /Invalid run id/);
  });

  it('leaves no tmp files behind after writes', () => {
    const { store, dir } = tempStore();
    let run = newRun('r1');
    store.create(run);
    run = applyTransition(run, { type: 'start' }, T0);
    store.update(run);
    assert.deepEqual(readdirSync(dir), ['r1.json']);
  });

  it('reports corrupt run files with an actionable error', () => {
    const { store, dir } = tempStore();
    writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf8');
    assert.throws(() => store.read('bad'), /not valid JSON/);
  });

  it('rejects a persisted state outside the workflow enum on read', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'REVEIWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('bad'), /corrupt or incompatible/);
  });

  it('rejects a persisted state outside the workflow enum on list', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'REVEIWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.list(), /corrupt or incompatible/);
  });

  it('rejects a persisted interrupt state with an invalid interruptedFrom', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'NEEDS_HUMAN', interruptedFrom: 'REVEIWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('bad'), /corrupt or incompatible/);
    assert.throws(() => store.list(), /corrupt or incompatible/);
  });

  it('rejects a persisted interrupt state that cannot resume (no interruptedFrom)', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'NEEDS_HUMAN', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('bad'), /corrupt or incompatible/);
  });

  it('accepts valid NEEDS_HUMAN / WAITING_DEPENDENCY resume states and resumes them', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'n.json'),
      JSON.stringify({ id: 'n', state: 'NEEDS_HUMAN', interruptedFrom: 'REVIEWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    writeFileSync(
      path.join(dir, 'w.json'),
      JSON.stringify({ id: 'w', state: 'WAITING_DEPENDENCY', interruptedFrom: 'IMPLEMENTING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    const n = store.read('n')!;
    assert.equal(applyTransition(n, { type: 'human_resolved' }, T0).state, 'REVIEWING');
    const w = store.read('w')!;
    assert.equal(applyTransition(w, { type: 'dependency_satisfied' }, T0).state, 'IMPLEMENTING');
  });

  it('accepts a NEEDS_HUMAN interrupt with evidence and bounded choices', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'n.json'),
      JSON.stringify({
        id: 'n',
        state: 'NEEDS_HUMAN',
        interruptedFrom: 'REVIEWING',
        createdAt: T0,
        updatedAt: T0,
        target: TARGET,
        history: [],
        interrupt: { kind: 'needs_human', reason: 'ambiguous', createdAt: T0, evidence: 'two designs', choices: ['A', 'B'] },
      }),
      'utf8',
    );
    const run = store.read('n')!;
    assert.equal(run.interrupt?.evidence, 'two designs');
    assert.deepEqual(run.interrupt?.choices, ['A', 'B']);
  });

  it('rejects a persisted interrupt with malformed evidence or choices', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad-evidence.json'),
      JSON.stringify({ id: 'bad-evidence', state: 'NEEDS_HUMAN', interruptedFrom: 'REVIEWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [], interrupt: { kind: 'needs_human', reason: 'x', createdAt: T0, evidence: 42 } }),
      'utf8',
    );
    assert.throws(() => store.read('bad-evidence'), /corrupt or incompatible/);

    writeFileSync(
      path.join(dir, 'bad-choices.json'),
      JSON.stringify({ id: 'bad-choices', state: 'NEEDS_HUMAN', interruptedFrom: 'REVIEWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [], interrupt: { kind: 'needs_human', reason: 'x', createdAt: T0, choices: ['A', 42] } }),
      'utf8',
    );
    assert.throws(() => store.read('bad-choices'), /corrupt or incompatible/);
  });

  it('rejects a persisted run with a structurally invalid target', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'READY', createdAt: T0, updatedAt: T0, target: { kind: 'issue', owner: 'acme' }, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('bad'), /corrupt or incompatible/);
  });

  it('rejects a persisted run with a non-string headSha', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', state: 'READY', headSha: 123, createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('bad'), /corrupt or incompatible/);
  });

  it('rejects malformed persisted nested objects before downstream code can use them', () => {
    const invalidRuns = [
      { ...newRun('bad'), reviewResult: null },
      { ...newRun('bad'), reviewResult: { verdict: 'approve', reviewerName: 'reviewer', headSha: 'sha-1', findings: null } },
      { ...newRun('bad'), agentResult: null },
      { ...newRun('bad'), agentResult: { exitStatus: 'maybe', summary: 'unknown' } },
      { ...newRun('bad'), agentResult: { exitStatus: 'failure', summary: 'failed', sessionId: 42 } },
      { ...newRun('bad'), agentResult: { exitStatus: 'failure', summary: 'failed', sessionId: '' } },
      { ...newRun('bad'), executor: null },
      { ...newRun('bad'), executor: { provider: '', sessionId: 'thread-1' } },
      { ...newRun('bad'), executor: { provider: 'codex-cli', sessionId: '' } },
      { ...newRun('bad'), executor: { provider: '   ', sessionId: 'thread-1' } },
      { ...newRun('bad'), executor: { provider: 'codex-cli', sessionId: '   ' } },
      { ...newRun('bad'), agentResult: { exitStatus: 'failure', summary: 'failed', durationMs: -1 } },
      { ...newRun('bad'), agentResult: { exitStatus: 'failure', summary: 'failed', durationMs: 'slow' } },
      { ...newRun('bad'), interrupt: null },
      { ...newRun('bad'), interrupt: { kind: 'unknown', reason: 'pause', createdAt: T0 } },
      { ...newRun('bad'), history: [null] },
    ];

    for (const invalidRun of invalidRuns) {
      const { store, dir } = tempStore();
      writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(invalidRun), 'utf8');
      assert.throws(() => store.read('bad'), /corrupt or incompatible/);
      assert.throws(() => store.list(), /corrupt or incompatible/);
    }
  });

  it('rejects a file whose persisted id does not match its filename on read', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({ id: 'y', state: 'READY', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('x'), /does not match its file name/);
  });

  it('rejects a file whose persisted id does not match its filename on list', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({ id: 'y', state: 'READY', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.list(), /does not match its file name/);
  });

  it('cannot let a mismatched-id file overwrite the real run', () => {
    const { store, dir } = tempStore();
    store.create(newRun('y'));
    writeFileSync(
      path.join(dir, 'x.json'),
      JSON.stringify({ id: 'y', state: 'REVIEWING', createdAt: T0, updatedAt: T0, target: TARGET, history: [] }),
      'utf8',
    );
    assert.throws(() => store.read('x'), /does not match its file name/);
    assert.equal(store.read('y')?.state, 'READY');
  });

  it('deletes a run and then reports it as missing', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    store.delete('r1');
    assert.equal(store.read('r1'), null);
    assert.throws(() => store.delete('r1'), /nothing to delete/);
  });
});
