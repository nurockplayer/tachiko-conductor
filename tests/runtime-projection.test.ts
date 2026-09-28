import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { composeOperationalRuntimeProjection, operationalRuntimeProjectionPath, readOperationalRuntimeProjection, restartVerdict, setMaintenanceHold, writeOperationalRuntimeProjection } from '../src/operational/runtime-projection.js';
import { createRun } from '../src/domain/run.js';
import type { Run } from '../src/domain/types.js';
import { TARGET, T0 } from './helpers.js';

const dirs: string[] = []; const dir = () => { const value = mkdtempSync(path.join(os.tmpdir(), 'runtime-')); dirs.push(value); return value; };
afterEach(() => { for (const value of dirs.splice(0)) import('node:fs').then(({ rmSync }) => rmSync(value, { recursive: true, force: true })); });
const base = (overrides = {}) => ({ schemaVersion: 1 as const, updatedAt: '2026-01-01T00:00:00.000Z', supervisor: 'parked' as const, stage: 'idle', eventWakeEligible: false, maintenanceHold: { active: true }, ownership: 'none' as const, checkpoint: 'durable' as const, ...overrides });

it('derives safe restart from the observed snapshot and dispatch-only hold', () => {
  const verdict = restartVerdict(base());
  assert.equal(verdict.verdict, 'SAFE TO RESTART');
  assert.match(verdict.reason, /latest validated snapshot/);
  assert.match(verdict.reason, /dispatch admission only/);
});
it('fails closed for active or ambiguous ownership and checkpoint', () => { assert.equal(restartVerdict(base({ ownership: 'active' })).verdict, 'WAIT FOR CURRENT CHECKPOINT'); assert.equal(restartVerdict(base({ ownership: 'ambiguous' })).verdict, 'UNKNOWN — CANNOT PROVE SAFE'); assert.equal(restartVerdict(base({ checkpoint: 'unknown' })).verdict, 'UNKNOWN — CANNOT PROVE SAFE'); });
it('fails closed for missing or malformed durable projection', () => { const value = dir(); assert.equal(readOperationalRuntimeProjection(value), null); writeOperationalRuntimeProjection(value, base()); writeFileSync(operationalRuntimeProjectionPath(value), '{bad'); assert.equal(readOperationalRuntimeProjection(value), null); });
it('hold survives reload and release is idempotent without discarding a parked manual checkpoint', () => { const value = dir(); writeOperationalRuntimeProjection(value, base({ manualLane: { repository: 'repo', worktree: '/worktree', branch: 'branch', checkpointSha: 'a'.repeat(40), clean: true, state: 'parked', recoverable: true } })); setMaintenanceHold(value, true, 't'); assert.equal(readOperationalRuntimeProjection(value)?.maintenanceHold.active, true); setMaintenanceHold(value, false, 't'); setMaintenanceHold(value, false, 't'); const restored = readOperationalRuntimeProjection(value); assert.equal(restored?.maintenanceHold.active, false); assert.equal(restored?.manualLane?.checkpointSha, 'a'.repeat(40)); });
it('writes and reloads a typed projection', () => { const value = dir(); writeOperationalRuntimeProjection(value, base()); assert.equal(readOperationalRuntimeProjection(value)?.checkpoint, 'durable'); });

const admission = (overrides = {}) => ({ schemaVersion: 1 as const, revision: 1, limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 }, counts: { captains: 0, writers: 0, highAutonomy: 0, parked: 0 }, lanes: [], omittedLaneCount: 0, lanesTruncated: false, lastTransition: null, ...overrides });
const compose = (snapshot: ReturnType<typeof admission>, runs: readonly Run[] = [], reentryEvidenceComplete = true) => composeOperationalRuntimeProjection({
  admission: snapshot as never, runs: runs as never, prior: null, now: T0, stage: 'test', supervisor: 'stopped', eventWakeEligible: false, reentryEvidenceComplete,
});

it('keeps account-wide active counts without synthesizing an optional writer identity', () => {
  const cases = [
    { writers: 1, lanes: [{ laneId: 'other-repo', missionId: 'mission-other', role: 'production_captain', status: 'active', generation: 1, highAutonomy: true, evidence: { repository: 'other/repo', issue: 9 } }] },
    { writers: 2, lanes: [
      { laneId: 'lane-a', missionId: 'same-mission', role: 'production_captain', status: 'active', generation: 3, highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, claim: 'claim-a', workspace: '/work/a' } },
      { laneId: 'lane-b', missionId: 'same-mission', role: 'delegated_mutation_writer', status: 'active', generation: 7, highAutonomy: true, evidence: { repository: 'other/repo', issue: 91, claim: 'claim-b', workspace: '/work/b' } },
    ] },
  ] as const;
  for (const { lanes, writers } of cases) {
    const projection = compose(admission({ counts: { captains: writers, writers, highAutonomy: writers, parked: 0 }, lanes }));
    assert.equal(projection.ownership, 'active');
    assert.equal(projection.checkpoint, 'in_progress');
    assert.equal(projection.activeWriter, undefined, 'incomplete or multi-owner detail stays out of the optional writer field');
  }
});

it('keeps truncated snapshots conservative for both empty and active writer counts', () => {
  const empty = compose(admission({ lanesTruncated: true, omittedLaneCount: 1 }));
  assert.equal(empty.ownership, 'ambiguous');
  assert.equal(empty.checkpoint, 'unknown');
  const active = compose(admission({ counts: { captains: 2, writers: 1, highAutonomy: 1, parked: 0 }, lanesTruncated: true, omittedLaneCount: 1,
    lanes: [{ laneId: 'visible-active', missionId: 'm', role: 'production_captain', status: 'active', generation: 2, highAutonomy: true, evidence: { repository: 'acme/widgets' } }] }));
  assert.equal(active.ownership, 'active', 'account-wide active counts remain authoritative even when lane details are truncated');
  assert.equal(active.checkpoint, 'in_progress');
});

it('marks missing settled Run and receipt reconciliation ambiguous instead of treating it as durable absence', () => {
  const run = createRun(TARGET, T0, 'unmatched-settled-run');
  const settled = { ...run, state: 'MERGE_READY' as const };
  const projection = compose(admission(), [settled], false);
  assert.equal(projection.ownership, 'ambiguous');
  assert.equal(projection.checkpoint, 'unknown');
});

it('allows durable none only for a truly empty ownership and Run history', () => {
  const projection = compose(admission());
  assert.equal(projection.ownership, 'none');
  assert.equal(projection.checkpoint, 'durable');
});

it('rejects active manual details paired with an ownership-none restart verdict', () => {
  const projection = base({ manualLane: { repository: 'acme/widgets', worktree: '/tmp/work', branch: 'main', checkpointSha: 'a'.repeat(40), clean: true, state: 'active', recoverable: false } });
  assert.equal(restartVerdict(projection).verdict, 'UNKNOWN — CANNOT PROVE SAFE');
});
