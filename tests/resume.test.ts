import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { T0, TARGET, approval, successResult } from './helpers.js';

describe('resume across process restarts', () => {
  it('recovers the run state and continues from where it stopped', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-resume-'));
    try {
      // --- process 1: create + implement + review, then persist ---
      const store1 = new JsonFileStore({ dir });
      let run = createRun(TARGET, T0, 'resume-1');
      store1.create(run);

      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('sha-1') }, T0);
      run = applyTransition(run, { type: 'validation_passed' }, T0);
      store1.update(run);

      // --- process 2 (restart): pick up and push through the gate ---
      const store2 = new JsonFileStore({ dir });
      let resumed = store2.read('resume-1');
      assert.equal(resumed?.state, 'REVIEWING');
      assert.equal(resumed?.headSha, 'sha-1');

      resumed = applyTransition(resumed!, { type: 'review_approved', reviewResult: approval('reviewer-1', 'sha-1') }, T0);
      assert.equal(resumed.state, 'FINAL_GATE');
      resumed = applyTransition(resumed, { type: 'gate_passed' }, T0);
      assert.equal(resumed.state, 'MERGE_READY');
      store2.update(resumed);

      // --- process 3 (another restart): terminal state is intact ---
      const store3 = new JsonFileStore({ dir });
      const merged = applyTransition(store3.read('resume-1')!, { type: 'merged' }, T0);
      store3.update(merged);

      const final = store3.read('resume-1')!;
      assert.equal(final.state, 'MERGED');
      assert.equal(final.history.length, 6);
      assert.equal(final.history[0]?.type, 'start');
      assert.equal(final.history[5]?.type, 'merged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes an interrupted run (NEEDS_HUMAN) after a restart', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-resume-'));
    try {
      const store1 = new JsonFileStore({ dir });
      let run = createRun(TARGET, T0, 'resume-interrupt');
      store1.create(run);
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'escalate', reason: 'product decision needed' }, T0);
      store1.update(run);

      const store2 = new JsonFileStore({ dir });
      const loaded = store2.read('resume-interrupt')!;
      assert.equal(loaded.state, 'NEEDS_HUMAN');
      assert.equal(loaded.interruptedFrom, 'IMPLEMENTING');

      const resumed = applyTransition(loaded, { type: 'human_resolved', reason: 'decided' }, T0);
      assert.equal(resumed.state, 'IMPLEMENTING');
      store2.update(resumed);

      const store3 = new JsonFileStore({ dir });
      assert.equal(store3.read('resume-interrupt')?.state, 'IMPLEMENTING');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
