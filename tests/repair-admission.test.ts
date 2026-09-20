import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createRepairAdmissionSnapshot,
  decideRepairAdmission,
  isRepairAdmissionSnapshot,
  parseRepairTaskShapeAuthority,
  REPAIR_FINDING_TAXONOMY_REVISION,
} from '../src/domain/repair-admission.js';
import { createRun } from '../src/domain/run.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { TARGET } from './helpers.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const authority = { revision: 'task-shape-v1', shape: 'bounded' as const };
const routineExecution = { profile: 'routine' as const, revision: 'execution-v1', executor: 'codex-cli', timeoutMs: 1_000 };

describe('revisioned repair admission authority', () => {
  it('maps only explicit bounded/interacting/decision authority and accepts no prose input', () => {
    assert.deepEqual(decideRepairAdmission(authority), { kind: 'admit', executionProfile: 'routine' });
    assert.deepEqual(decideRepairAdmission({ revision: 'task-shape-v1', shape: 'interacting' }), { kind: 'admit', executionProfile: 'complex' });
    assert.deepEqual(decideRepairAdmission({ revision: 'task-shape-v1', shape: 'decision' }), { kind: 'park', escalation: 'decision_required' });
  });

  it('creates bounded, versioned exact-HEAD/PR admission evidence', () => {
    const snapshot = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:00.000Z');
    assert.equal(snapshot.taxonomyRevision, REPAIR_FINDING_TAXONOMY_REVISION);
    assert.equal(snapshot.headSha, HEAD);
    assert.equal(snapshot.pullRequestNumber, 7);
    assert.equal(snapshot.executionRevision, 'execution-v1');
    assert.equal(snapshot.execution.revision, 'execution-v1');
    assert.equal(isRepairAdmissionSnapshot(snapshot), true);
    assert.equal(isRepairAdmissionSnapshot({ ...snapshot, headSha: '' }), false);
    assert.equal(isRepairAdmissionSnapshot({ ...snapshot, taskShape: 'interacting' }), false);
    assert.throws(
      () => createRepairAdmissionSnapshot({ revision: 'task-shape-v1', shape: 'interacting' }, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:00.000Z'),
      /does not match/,
    );
  });

  it('survives restart, participates in CAS, and cannot be retroactively removed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-admission-'));
    try {
      const store = new JsonFileStore({ dir });
      const initial = createRun(TARGET, '2026-09-20T00:00:00.000Z', 'repair-admission', undefined, undefined, authority);
      store.create(initial);
      const snapshot = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, routineExecution, '2026-09-20T00:00:01.000Z');
      const admitted = { ...initial, repairAdmissions: [snapshot] };
      assert.equal(store.updateIfUnchanged(initial, admitted), true);
      assert.deepEqual(new JsonFileStore({ dir }).read(initial.id)?.repairAdmissions, [snapshot]);
      assert.equal(store.updateIfUnchanged(initial, { ...initial, repairAdmissions: [] }), false);
      assert.throws(() => store.update({ ...admitted, repairAdmissions: [] }), /append-only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads legacy Run JSON with no task-shape authority or admission ledger', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-legacy-'));
    try {
      const store = new JsonFileStore({ dir });
      store.create(createRun(TARGET, '2026-09-20T00:00:00.000Z', 'legacy'));
      const legacy = new JsonFileStore({ dir }).read('legacy');
      assert.equal(legacy?.repairTaskShapeAuthority, undefined);
      assert.equal(legacy?.repairAdmissions, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts only strict revisioned JSON authority at the unattended boundary', () => {
    assert.deepEqual(parseRepairTaskShapeAuthority('{"revision":"task-shape-v1","shape":"bounded"}'), authority);
    assert.throws(() => parseRepairTaskShapeAuthority('{"revision":"task-shape-v1","shape":"bounded","prose":"small fix"}'), /strict JSON/);
    assert.throws(() => parseRepairTaskShapeAuthority('small fix'), /valid JSON/);
  });
});
