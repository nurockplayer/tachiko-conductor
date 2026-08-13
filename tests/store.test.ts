import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { T0, newRun, successResult } from './helpers.js';

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

  it('deletes a run and then reports it as missing', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    store.delete('r1');
    assert.equal(store.read('r1'), null);
    assert.throws(() => store.delete('r1'), /nothing to delete/);
  });
});
