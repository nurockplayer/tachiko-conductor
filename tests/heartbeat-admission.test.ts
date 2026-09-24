import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { handleHeartbeatAdmission, handleHeartbeatAdmissionJson, type HeartbeatAdmissionOptions } from '../src/mission-admission/heartbeat-admission.js';
import { resolveHeartbeatOwnerReceiptPath } from '../src/mission-admission/host-registry.js';

const config: AdmissionConfig = { schemaVersion: 1, revision: 'heartbeat-admission-test-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
const supervisorId = 'tachiko-heartbeat-service';
const ROOT = path.resolve(import.meta.dirname, '..');
function heartbeatLaneId(repository: string, workspace: string): string {
  return 'heartbeat:' + createHash('sha256').update(`${repository}\0${realpathSync(workspace)}`).digest('hex').slice(0, 32);
}

function setup(overrides: { readonly beforePublish?: () => void; readonly limits?: AdmissionConfig['limits'] } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-heartbeat-admission-'));
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace);
  const registryPath = path.join(directory, 'host', 'registry.json');
  const registry = new MissionAdmissionRegistry({
    filePath: registryPath,
    config: { ...config, limits: overrides.limits ?? config.limits },
    ...(overrides.beforePublish === undefined ? {} : { beforePublish: overrides.beforePublish }),
  });
  const receiptPath = path.join(directory, 'private-receipts', 'heartbeat.json');
  const options: HeartbeatAdmissionOptions = { registry, receiptPath: () => receiptPath };
  const request = (action: 'reserve' | 'inspect', repository = 'acme/widgets') => action === 'reserve'
    ? { schemaVersion: 1, action, repository, workspace, supervisorId }
    : { schemaVersion: 1, action, repository, workspace };
  const settle = (repository: string, generation: number, receiptId: string, overrides: { readonly stopped?: boolean; readonly supervisor?: string } = {}) => ({
    schemaVersion: 1,
    action: 'settle',
    repository,
    workspace,
    supervisorId: overrides.supervisor ?? supervisorId,
    expectedGeneration: generation,
    receiptId,
    stopProof: { childrenStopped: true, supervisorStopped: overrides.stopped ?? true, observedAt: '2026-09-23T00:00:00.000Z' },
  });
  const recover = (repository: string, generation: number | null, overrides: { readonly supervisor?: string } = {}) => ({
    schemaVersion: 1,
    action: 'recover',
    repository,
    workspace,
    supervisorId: overrides.supervisor ?? supervisorId,
    expectedGeneration: generation,
  });
  const discard = (repository: string, generation: number, receiptId: string, overrides: { readonly supervisor?: string } = {}) => ({
    schemaVersion: 1, action: 'discard_uncommitted', repository, workspace,
    supervisorId: overrides.supervisor ?? supervisorId, expectedGeneration: generation, receiptId,
  });
  return { directory, workspace, registry, registryPath, receiptPath, options, request, settle, recover, discard };
}

describe('model-free heartbeat mission admission helper', () => {
  it('reserves a stable high-autonomy repository captain with a private receipt and model-free status', () => {
    const f = setup();
    let modelCalls = 0;
    try {
      const output = handleHeartbeatAdmissionJson(JSON.stringify(f.request('reserve')), f.options);
      const result = JSON.parse(output) as { outcome: string; laneId: string; generation: number; receiptId: string };
      assert.equal(result.outcome, 'reserved');
      assert.match(result.laneId, /^heartbeat:[a-f0-9]{32}$/);
      assert.equal(result.generation, 1);
      assert.match(result.receiptId, /^[0-9a-f-]{36}$/);
      assert.equal(output.includes('token'), false);
      const stats = statSync(f.receiptPath);
      assert.equal(stats.mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(f.receiptPath)).mode & 0o777, 0o700);
      assert.equal(path.relative(f.workspace, f.receiptPath).startsWith('..'), true);
      const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { token: { token: string }; workspace: string };
      assert.ok(receipt.token.token.length > 0);
      assert.equal(receipt.workspace, realpathSync(f.workspace));
      const lane = f.registry.readLane(result.laneId)!;
      assert.equal(lane.highAutonomy, true);
      assert.equal(modelCalls, 0, 'the helper has no model-capable dependency or execution path');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('denies capacity without a receipt or any model-capable work', () => {
    const f = setup();
    let modelCalls = 0;
    try {
      const holder = f.registry.admit({ laneId: 'other', role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/holder', issue: 3 } });
      assert.equal(holder.outcome, 'admitted');
      const denied = handleHeartbeatAdmission(f.request('reserve', 'acme/widgets'), f.options);
      assert.equal(denied.outcome, 'waiting');
      assert.equal(denied.reason, 'capacity_captains');
      assert.equal(existsSync(f.receiptPath), false);
      assert.equal(modelCalls, 0);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('read-only recovers an exact capacity-parked lane with no receipt and reuses that lane after release', () => {
    const f = setup();
    try {
      const holder = f.registry.admit({ laneId: 'capacity-holder', role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/holder', issue: 3 } });
      assert.equal(holder.outcome, 'admitted');
      const denied = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(denied.outcome, 'waiting');
      if (denied.outcome !== 'waiting') return;
      const recovery = handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options);
      assert.deepEqual(recovery, { schemaVersion: 1, outcome: 'capacity_wait', laneId: denied.laneId });
      assert.equal(existsSync(f.receiptPath), false);
      const laneBefore = f.registry.readLane(denied.laneId)!;
      assert.equal(laneBefore.status, 'parked');
      assert.equal(laneBefore.role, 'production_captain');
      if (holder.outcome !== 'admitted') return;
      f.registry.release(holder.token, true);
      const retry = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(retry.outcome, 'reserved');
      if (retry.outcome !== 'reserved') return;
      assert.equal(retry.laneId, denied.laneId, 'capacity retry promotes its deterministic parked lane');
      assert.equal(f.registry.readLane(denied.laneId)?.status, 'active');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('recovers capacity wait with only an older matching settled receipt and rejects current or future evidence', () => {
    const f = setup();
    try {
      const first = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(first.outcome, 'reserved');
      if (first.outcome !== 'reserved') return;
      handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), f.options);
      const holder = f.registry.admit({ laneId: 'later-capacity-holder', role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/holder', issue: 4 } });
      assert.equal(holder.outcome, 'admitted');
      const denied = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(denied.outcome, 'waiting');
      if (denied.outcome !== 'waiting') return;
      const parked = f.registry.readLane(denied.laneId)!;
      assert.equal(parked.generation, 3);
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'capacity_wait');

      const settledReceipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { token: { generation: number } };
      writeFileSync(f.receiptPath, JSON.stringify({ ...JSON.parse(readFileSync(f.receiptPath, 'utf8')), status: 'active' }), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'not_owned', 'an active receipt cannot justify capacity wait');
      writeFileSync(f.receiptPath, JSON.stringify({ ...JSON.parse(readFileSync(f.receiptPath, 'utf8')), status: 'settled', token: { ...settledReceipt.token, generation: parked.generation - 1 } }), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'not_owned', 'receipt generation+1 equal to parked generation is not historical enough');
      writeFileSync(f.receiptPath, JSON.stringify({ ...JSON.parse(readFileSync(f.receiptPath, 'utf8')), workspace: '/tmp/foreign-workspace', token: { ...settledReceipt.token, generation: first.generation } }), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'not_owned', 'a settled receipt for another workspace cannot authorize capacity recovery');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('read-only recovers only an exact released predecessor after failed capacity-park publication', () => {
    const limits = { maxCaptains: 4, maxWriters: 4, maxHighAutonomy: 2 };
    const f = setup({ limits });
    try {
      const first = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(first.outcome, 'reserved');
      if (first.outcome !== 'reserved') throw new Error('expected initial reservation');
      handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), f.options);
      const oldReceipt = readFileSync(f.receiptPath, 'utf8');
      const blockers: Array<{ laneId: string; generation: number; token: string }> = [];
      for (const [index, repository] of ['acme/blocker-a', 'acme/blocker-b'].entries()) {
        const workspace = path.join(f.directory, `blocker-${index}`);
        mkdirSync(workspace);
        const result = f.registry.admit({ laneId: `run:blocker-${index}`, role: 'production_captain', highAutonomy: true,
          evidence: { repository, repositoryScope: true, workspace } });
        assert.equal(result.outcome, 'admitted');
        if (result.outcome !== 'admitted') throw new Error('expected high-autonomy capacity blocker');
        blockers.push(result.token);
      }

      const before = f.registry.snapshot();
      const failingRegistry = new MissionAdmissionRegistry({
        filePath: f.registryPath, config: { ...config, limits }, beforePublish: () => { throw new Error('injected capacity-park publication failure'); },
      });
      const failedOptions: HeartbeatAdmissionOptions = { registry: failingRegistry, receiptPath: () => f.receiptPath };
      assert.throws(() => handleHeartbeatAdmission({ ...f.request('reserve'), supervisorId: 'new-supervisor' }, failedOptions), /injected capacity-park publication failure/);
      assert.deepEqual(f.registry.snapshot(), before, 'failed park publication leaves the released predecessor unchanged');
      assert.equal(readFileSync(f.receiptPath, 'utf8'), oldReceipt, 'capacity denial does not overwrite the old settled tombstone');

      const recovered = handleHeartbeatAdmission(f.recover('acme/widgets', null, { supervisor: 'new-supervisor' }), failedOptions);
      assert.equal(recovered.outcome, 'released_predecessor');
      if (recovered.outcome !== 'released_predecessor') throw new Error('expected exact released predecessor');
      assert.equal(recovered.generation + 1, recovered.releasedGeneration);
      assert.equal(recovered.generation, first.generation);
      assert.equal(recovered.receiptId, first.receiptId);
      assert.equal(recovered.supervisorId, supervisorId, 'historical supervisor need not own the new pending intent');
      assert.deepEqual(failingRegistry.snapshot(), before, 'read-only classification leaves all lanes untouched');
      assert.equal(readFileSync(f.receiptPath, 'utf8'), oldReceipt);

      const receipt = JSON.parse(oldReceipt) as Record<string, unknown> & { token: { generation: number } };
      receipt.token = { ...receipt.token, generation: receipt.token.generation + 1 };
      writeFileSync(f.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null, { supervisor: 'new-supervisor' }), failedOptions).outcome, 'not_owned', 'incorrect tombstone generation is fenced');
      receipt.token = { ...receipt.token, generation: first.generation };
      receipt.workspace = '/tmp/foreign-heartbeat-workspace';
      writeFileSync(f.receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null, { supervisor: 'new-supervisor' }), failedOptions).outcome, 'not_owned', 'wrong workspace evidence is fenced');
      writeFileSync(f.receiptPath, oldReceipt, { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', first.generation, { supervisor: 'new-supervisor' }), failedOptions).outcome, 'not_owned', 'the predecessor result is null-generation only');

      for (const blocker of blockers) f.registry.release(blocker, true);
      const successor = handleHeartbeatAdmission({ ...f.request('reserve'), supervisorId: 'new-supervisor' }, f.options);
      assert.equal(successor.outcome, 'reserved');
      const activeRecovery = handleHeartbeatAdmission(f.recover('acme/widgets', null, { supervisor: 'new-supervisor' }), f.options);
      assert.equal(activeRecovery.outcome, 'recoverable', 'an active successor is never classified as a released predecessor');
      if (successor.outcome === 'reserved') handleHeartbeatAdmission(f.settle('acme/widgets', successor.generation, successor.receiptId, { supervisor: 'new-supervisor' }), f.options);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('reports overlapping production ownership without exposing the owner capability', () => {
    const f = setup({ limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2 } });
    try {
      const owner = f.registry.admit({ laneId: 'manual-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', repositoryScope: true, workspace: f.workspace } });
      assert.equal(owner.outcome, 'admitted');
      const result = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(result.outcome, 'owned_elsewhere');
      assert.equal(JSON.stringify(result).includes('token'), false);
      assert.equal(existsSync(f.receiptPath), false);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('recovers across process-style registry restart and settles only the exact receipt generation', () => {
    const f = setup();
    try {
      const first = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(first.outcome, 'reserved');
      if (first.outcome !== 'reserved') throw new Error('expected reservation');
      const restartedRegistry = new MissionAdmissionRegistry({ filePath: path.join(f.directory, 'host', 'registry.json'), config });
      const restartedOptions = { ...f.options, registry: restartedRegistry };
      const inspection = handleHeartbeatAdmission(f.request('inspect'), restartedOptions);
      assert.equal(inspection.outcome, 'inspected');
      assert.equal(inspection.lane?.status, 'active');
      assert.equal(inspection.lane?.highAutonomy, true);
      const resumed = handleHeartbeatAdmission(f.request('reserve'), restartedOptions);
      assert.equal(resumed.outcome, 'already_reserved');
      if (resumed.outcome !== 'already_reserved') throw new Error('expected existing reservation');
      assert.equal(resumed.receiptId, first.receiptId);
      assert.notEqual(resumed.outcome, 'reserved', 'already_reserved is reconciliation only and never grants a spawn');
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', first.generation + 1, first.receiptId), restartedOptions), /generation or supervisor/);
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId, { stopped: false }), restartedOptions), /malformed/);
      const settled = handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), restartedOptions);
      assert.equal(settled.outcome, 'settled');
      assert.equal(existsSync(f.receiptPath), true, 'settle keeps a private tombstone so stale cleanup cannot unlink a successor receipt');
      assert.equal((JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { status: string }).status, 'settled');
      const successor = handleHeartbeatAdmission(f.request('reserve'), restartedOptions);
      assert.equal(successor.outcome, 'reserved');
      if (successor.outcome !== 'reserved') throw new Error('expected successor reservation');
      assert.notEqual(successor.receiptId, first.receiptId);
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), restartedOptions), /generation or supervisor/);
      assert.equal((JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receiptId: string }).receiptId, successor.receiptId, 'stale settle cannot delete or replace successor recovery receipt');
      assert.equal(restartedRegistry.readLane(successor.laneId)?.status, 'active');
      handleHeartbeatAdmission(f.settle('acme/widgets', successor.generation, successor.receiptId), restartedOptions);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('keys heartbeat lane and receipt by canonical repository plus physical workspace and migrates cleanly', () => {
    const f = setup({ limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } });
    const workspaceB = path.join(f.directory, 'workspace-b');
    mkdirSync(workspaceB);
    const options: HeartbeatAdmissionOptions = {
      ...f.options,
      receiptPath: (_repository, workspace) => path.join(f.directory, 'private-receipts', `${path.basename(workspace)}.json`),
    };
    const requestAt = (action: 'reserve' | 'inspect', workspace: string) => action === 'reserve'
      ? { schemaVersion: 1, action, repository: 'acme/widgets', workspace, supervisorId }
      : { schemaVersion: 1, action, repository: 'acme/widgets', workspace };
    try {
      const a = handleHeartbeatAdmission(requestAt('reserve', f.workspace), options);
      assert.equal(a.outcome, 'reserved');
      if (a.outcome !== 'reserved') return;
      const blockedB = handleHeartbeatAdmission(requestAt('reserve', workspaceB), options);
      assert.equal(blockedB.outcome, 'owned_elsewhere', 'repository-wide ownership blocks a simultaneous second checkout');
      const settledA = handleHeartbeatAdmission(f.settle('acme/widgets', a.generation, a.receiptId), options);
      assert.equal(settledA.outcome, 'settled');
      const b = handleHeartbeatAdmission(requestAt('reserve', workspaceB), options);
      assert.equal(b.outcome, 'reserved', 'a cleanly settled checkout can migrate to a different physical workspace');
      if (b.outcome !== 'reserved') return;
      assert.notEqual(b.laneId, a.laneId);
      assert.notEqual(b.receiptId, a.receiptId);
      assert.equal(f.registry.readLane(a.laneId)?.status, 'released');
      assert.equal(f.registry.readLane(b.laneId)?.status, 'active');
      handleHeartbeatAdmission({
        schemaVersion: 1, action: 'settle', repository: 'acme/widgets', workspace: workspaceB,
        supervisorId, expectedGeneration: b.generation, receiptId: b.receiptId,
        stopProof: { childrenStopped: true, supervisorStopped: true, observedAt: '2026-09-23T00:00:00.000Z' },
      }, options);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('canonicalizes receipt workspace aliases and allows independent sibling workspaces', () => {
    const f = setup({ limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } });
    const sibling = path.join(f.directory, 'workspace-sibling');
    mkdirSync(sibling);
    const alias = path.join(f.directory, 'workspace-alias');
    symlinkSync(f.workspace, alias, 'dir');
    const home = path.join(f.directory, 'home');
    mkdirSync(home);
    const env = { HOME: home, TACHIKO_DATA_DIR: path.join(home, 'runs') };
    try {
      const receiptA = resolveHeartbeatOwnerReceiptPath('acme/widgets', f.workspace, { env, homeDirectory: home });
      const receiptAlias = resolveHeartbeatOwnerReceiptPath('acme/widgets', alias, { env, homeDirectory: home });
      const receiptSibling = resolveHeartbeatOwnerReceiptPath('acme/other', sibling, { env, homeDirectory: home });
      assert.equal(receiptA, receiptAlias, 'symlink aliases use one canonical receipt identity');
      assert.notEqual(receiptA, receiptSibling, 'a distinct repository and physical workspace gets an independent receipt');

      const options: HeartbeatAdmissionOptions = {
        ...f.options,
        receiptPath: (repository, workspace) => path.join(f.directory, 'private-receipts', `${repository.replace('/', '-')}-${path.basename(workspace)}.json`),
      };
      const first = handleHeartbeatAdmission(f.request('reserve', 'acme/widgets'), options);
      const second = handleHeartbeatAdmission({ schemaVersion: 1, action: 'reserve', repository: 'acme/other', workspace: sibling, supervisorId }, options);
      assert.equal(first.outcome, 'reserved');
      assert.equal(second.outcome, 'reserved', 'non-overlapping sibling workspace ownership remains independent');
      if (first.outcome === 'reserved') handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), options);
      if (second.outcome === 'reserved') handleHeartbeatAdmission({
        schemaVersion: 1, action: 'settle', repository: 'acme/other', workspace: sibling,
        supervisorId, expectedGeneration: second.generation, receiptId: second.receiptId,
        stopProof: { childrenStopped: true, supervisorStopped: true, observedAt: '2026-09-23T00:00:00.000Z' },
      }, options);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('aborts registry admission when private receipt publication fails', () => {
    const f = setup();
    const parentFile = path.join(f.directory, 'not-a-directory');
    writeFileSync(parentFile, 'x');
    const options = { registry: f.registry, receiptPath: () => path.join(parentFile, 'receipt.json') };
    try {
      assert.throws(() => handleHeartbeatAdmission(f.request('reserve'), options));
      assert.equal(f.registry.snapshot().revision, 0);
      assert.equal(f.registry.snapshot().counts.captains, 0);
      assert.equal(f.registry.readLane('heartbeat:' + '0'.repeat(32)), null);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('keeps a stale precommit receipt from releasing a successor after registry publication failure', () => {
    let failCommit = true;
    const f = setup({ beforePublish: () => { if (failCommit) throw new Error('injected registry publication failure'); } });
    try {
      assert.throws(() => handleHeartbeatAdmission(f.request('reserve'), f.options), /injected registry publication failure/);
      const stale = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { token: { generation: number }; receiptId: string };
      assert.equal(f.registry.snapshot().revision, 0);
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', stale.token.generation, stale.receiptId), f.options), /stale|active lane/);
      failCommit = false;
      const successor = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(successor.outcome, 'reserved');
      if (successor.outcome !== 'reserved') throw new Error('expected successor reservation');
      assert.equal(successor.generation, stale.token.generation, 'the registry may reuse an uncommitted numeric generation');
      assert.notEqual(successor.receiptId, stale.receiptId);
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', stale.token.generation, stale.receiptId), f.options), /generation or supervisor/);
      assert.equal(f.registry.readLane(successor.laneId)?.status, 'active');
      handleHeartbeatAdmission(f.settle('acme/widgets', successor.generation, successor.receiptId), f.options);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('recovers and durably discards only an exact unpublished first-generation receipt', () => {
    let failCommit = true;
    const f = setup({ beforePublish: () => { if (failCommit) throw new Error('injected registry publication failure'); } });
    try {
      assert.throws(() => handleHeartbeatAdmission(f.request('reserve'), f.options), /injected registry publication failure/);
      const orphan = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { generation?: number; receiptId: string; token: { generation: number } };
      const restartedOptions: HeartbeatAdmissionOptions = {
        registry: new MissionAdmissionRegistry({ filePath: f.registryPath, config }),
        receiptPath: () => f.receiptPath,
      };
      const exact = handleHeartbeatAdmission(f.recover('acme/widgets', null), restartedOptions);
      assert.equal(exact.outcome, 'uncommitted_receipt');
      if (exact.outcome !== 'uncommitted_receipt') throw new Error('expected unpublished first candidate');
      assert.deepEqual(exact, {
        schemaVersion: 1, outcome: 'uncommitted_receipt', laneId: heartbeatLaneId('acme/widgets', f.workspace),
        generation: 1, receiptId: orphan.receiptId, supervisorId,
      });
      const originalReceipt = readFileSync(f.receiptPath, 'utf8');
      const wrongMission = JSON.parse(originalReceipt) as Record<string, unknown>;
      wrongMission.missionId = 'mission-wrong';
      writeFileSync(f.receiptPath, JSON.stringify(wrongMission), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), restartedOptions).outcome, 'not_owned', 'wrong deterministic mission identity is fenced');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', 1, orphan.receiptId), restartedOptions).outcome, 'not_owned', 'locked deletion also verifies deterministic mission identity');
      assert.equal(existsSync(f.receiptPath), true);
      const settledReceipt = JSON.parse(originalReceipt) as Record<string, unknown>;
      settledReceipt.status = 'settled';
      writeFileSync(f.receiptPath, JSON.stringify(settledReceipt), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', 1, orphan.receiptId), restartedOptions).outcome, 'not_owned', 'settled receipts are not prepublication candidates');
      writeFileSync(f.receiptPath, originalReceipt, { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null, { supervisor: 'other-supervisor' }), restartedOptions).outcome, 'not_owned');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', 1, '00000000-0000-4000-8000-000000000099'), restartedOptions).outcome, 'not_owned');
      assert.equal(existsSync(f.receiptPath), true, 'wrong receipt identity cannot delete the orphan');
      assert.equal(f.registry.readLane(exact.laneId), null);
      const discarded = handleHeartbeatAdmission(f.discard('acme/widgets', exact.generation, exact.receiptId), restartedOptions);
      assert.equal(discarded.outcome, 'discarded_uncommitted');
      assert.equal(existsSync(f.receiptPath), true, 'discard leaves a durable private marker in place of the orphan');
      const marker = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as Record<string, unknown>;
      assert.equal(marker.kind, 'discarded_uncommitted');
      assert.equal('token' in marker, false, 'discard markers never retain a capability token');
      assert.equal(f.registry.readLane(exact.laneId), null, 'discard does not publish or release a lane');
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), restartedOptions).outcome, 'discarded_predecessor', 'crash after marker publication is read-only recoverable');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', exact.generation, exact.receiptId), restartedOptions).outcome, 'discarded_uncommitted', 'discard retry is idempotent for the exact marker');
      failCommit = false;
      const retried = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(retried.outcome, 'reserved');
      if (retried.outcome === 'reserved') assert.equal(retried.generation, 1, 'the unpublished candidate consumed no generation');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('discards later-generation orphan only over its exact released or capacity predecessor', () => {
    let failCommit = false;
    const f = setup({ beforePublish: () => { if (failCommit) throw new Error('injected registry publication failure'); } });
    try {
      const first = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(first.outcome, 'reserved');
      if (first.outcome !== 'reserved') throw new Error('expected initial reservation');
      handleHeartbeatAdmission(f.settle('acme/widgets', first.generation, first.receiptId), f.options);
      const released = f.registry.readLane(first.laneId)!;
      assert.equal(released.status, 'released');
      failCommit = true;
      assert.throws(() => handleHeartbeatAdmission(f.request('reserve'), f.options), /injected registry publication failure/);
      failCommit = false;
      const orphan = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receiptId: string; token: { generation: number } };
      assert.equal(orphan.token.generation, released.generation + 1);
      const recovery = handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options);
      assert.equal(recovery.outcome, 'uncommitted_receipt');
      if (recovery.outcome !== 'uncommitted_receipt') throw new Error('expected exact unpublished receipt');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', recovery.generation + 1, recovery.receiptId), f.options).outcome, 'not_owned');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', recovery.generation, recovery.receiptId, { supervisor: 'wrong' }), f.options).outcome, 'not_owned');
      assert.equal(existsSync(f.receiptPath), true);
      const successor = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(successor.outcome, 'reserved');
      if (successor.outcome !== 'reserved') throw new Error('expected successor admission');
      assert.equal(f.registry.readLane(successor.laneId)?.generation, successor.generation);
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', recovery.generation, recovery.receiptId), f.options).outcome, 'not_owned', 'a changed active lane fences stale discard');
      assert.equal(existsSync(f.receiptPath), true, 'stale discard does not unlink successor state');
      handleHeartbeatAdmission(f.settle('acme/widgets', successor.generation, successor.receiptId), f.options);

      // A capacity-parked predecessor is retained and may authorize only its next exact candidate.
      const parked = f.registry.admit({ laneId: heartbeatLaneId('acme/widgets', f.workspace), role: 'production_captain', highAutonomy: true,
        evidence: { repository: 'acme/widgets', repositoryScope: true, workspace: f.workspace } });
      assert.equal(parked.outcome, 'admitted');
      if (parked.outcome !== 'admitted') throw new Error('expected capacity predecessor setup lane');
      const token = parked.token;
      f.registry.park(token, 'capacity_high_autonomy');
      const lane = f.registry.readLane(token.laneId)!;
      const nextGeneration = lane.generation + 1;
      const mission = lane.missionId;
      mkdirSync(path.dirname(f.receiptPath), { recursive: true, mode: 0o700 });
      writeFileSync(f.receiptPath, JSON.stringify({ schemaVersion: 1, laneId: heartbeatLaneId('acme/widgets', f.workspace),
        missionId: mission, repository: 'acme/widgets', workspace: realpathSync(f.workspace), supervisorId, receiptId: '00000000-0000-4000-8000-000000000042', status: 'active',
        token: { laneId: heartbeatLaneId('acme/widgets', f.workspace), generation: nextGeneration, token: 'orphan-token' } }), { mode: 0o600 });
      const capacityRecovery = handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options);
      assert.equal(capacityRecovery.outcome, 'uncommitted_receipt');
      if (capacityRecovery.outcome !== 'uncommitted_receipt') throw new Error('expected candidate after capacity lane');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', capacityRecovery.generation, capacityRecovery.receiptId), f.options).outcome, 'discarded_uncommitted');
      assert.equal(f.registry.readLane(lane.laneId)?.status, 'parked', 'discard preserves capacity predecessor');
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'discarded_predecessor');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('recovers tokenless discard markers across later capacity denial for absent and released predecessors', () => {
    let failFirstCommit = true;
    const first = setup({ beforePublish: () => { if (failFirstCommit) throw new Error('injected registry publication failure'); } });
    try {
      assert.throws(() => handleHeartbeatAdmission(first.request('reserve'), first.options), /injected registry publication failure/);
      failFirstCommit = false;
      const orphan = JSON.parse(readFileSync(first.receiptPath, 'utf8')) as { receiptId: string; token: { generation: number } };
      assert.equal(handleHeartbeatAdmission(first.discard('acme/widgets', orphan.token.generation, orphan.receiptId), first.options).outcome, 'discarded_uncommitted');
      const holder = first.registry.admit({ laneId: 'capacity-holder', role: 'production_captain', highAutonomy: true,
        evidence: { repository: 'acme/holder', issue: 7 } });
      assert.equal(holder.outcome, 'admitted');
      const denied = handleHeartbeatAdmission({ ...first.request('reserve'), supervisorId: 'later-supervisor' }, first.options);
      assert.equal(denied.outcome, 'waiting');
      if (denied.outcome !== 'waiting') throw new Error('expected exact capacity denial');
      const revision = first.registry.snapshot().revision;
      const recovered = handleHeartbeatAdmission(first.recover('acme/widgets', null, { supervisor: 'later-supervisor' }), first.options);
      assert.equal(recovered.outcome, 'discarded_predecessor', 'absent marker baseline survives the first capacity-parked generation');
      assert.equal(first.registry.snapshot().revision, revision, 'marker recovery is read-only');
      const foreign = JSON.parse(readFileSync(first.receiptPath, 'utf8')) as Record<string, unknown>;
      foreign.missionId = 'foreign-mission';
      writeFileSync(first.receiptPath, JSON.stringify(foreign), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(first.recover('acme/widgets', null), first.options).outcome, 'not_owned', 'foreign markers cannot fall through to generic capacity recovery');
      foreign.missionId = 'mission-restored';
      foreign.kind = 'ambiguous_marker';
      writeFileSync(first.receiptPath, JSON.stringify(foreign), { mode: 0o600 });
      assert.throws(() => handleHeartbeatAdmission(first.recover('acme/widgets', null), first.options), /unsupported or ambiguous schema/);
    } finally { rmSync(first.directory, { recursive: true, force: true }); }

    let failCommit = false;
    const later = setup({ beforePublish: () => { if (failCommit) throw new Error('injected registry publication failure'); } });
    try {
      const initial = handleHeartbeatAdmission(later.request('reserve'), later.options);
      assert.equal(initial.outcome, 'reserved');
      if (initial.outcome !== 'reserved') throw new Error('expected initial reservation');
      handleHeartbeatAdmission(later.settle('acme/widgets', initial.generation, initial.receiptId), later.options);
      const released = later.registry.readLane(initial.laneId)!;
      failCommit = true;
      assert.throws(() => handleHeartbeatAdmission(later.request('reserve'), later.options), /injected registry publication failure/);
      failCommit = false;
      const candidate = JSON.parse(readFileSync(later.receiptPath, 'utf8')) as { receiptId: string; token: { generation: number } };
      assert.equal(candidate.token.generation, released.generation + 1);
      assert.equal(handleHeartbeatAdmission(later.discard('acme/widgets', candidate.token.generation, candidate.receiptId), later.options).outcome, 'discarded_uncommitted');
      const holder = later.registry.admit({ laneId: 'capacity-holder', role: 'production_captain', highAutonomy: true,
        evidence: { repository: 'acme/holder', issue: 8 } });
      assert.equal(holder.outcome, 'admitted');
      const denied = handleHeartbeatAdmission({ ...later.request('reserve'), supervisorId: 'later-supervisor' }, later.options);
      assert.equal(denied.outcome, 'waiting');
      if (denied.outcome !== 'waiting') throw new Error('expected later capacity denial');
      const recovered = handleHeartbeatAdmission(later.recover('acme/widgets', null, { supervisor: 'later-supervisor' }), later.options);
      assert.equal(recovered.outcome, 'discarded_predecessor', 'released marker baseline survives its exact later capacity lane');
      if (recovered.outcome !== 'discarded_predecessor') throw new Error('expected discarded predecessor');
      assert.equal(recovered.supervisorId, supervisorId, 'the marker may belong to an earlier supervisor');
      const nextReceipt = JSON.parse(readFileSync(later.receiptPath, 'utf8')) as Record<string, unknown>;
      nextReceipt.predecessor = { kind: 'released', generation: 999 };
      writeFileSync(later.receiptPath, JSON.stringify(nextReceipt), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(later.recover('acme/widgets', null), later.options).outcome, 'not_owned', 'incorrect predecessor generation is fenced');
    } finally { rmSync(later.directory, { recursive: true, force: true }); }
  });

  it('keeps a reused unpublished generation fenced after a tokenless marker is replaced by a successor', () => {
    let failCommit = true;
    const f = setup({ beforePublish: () => { if (failCommit) throw new Error('injected registry publication failure'); } });
    try {
      assert.throws(() => handleHeartbeatAdmission(f.request('reserve'), f.options), /injected registry publication failure/);
      failCommit = false;
      const orphan = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { receiptId: string; token: { generation: number } };
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', orphan.token.generation, orphan.receiptId), f.options).outcome, 'discarded_uncommitted');
      const successor = handleHeartbeatAdmission({ ...f.request('reserve'), supervisorId: 'new-supervisor' }, f.options);
      assert.equal(successor.outcome, 'reserved');
      if (successor.outcome !== 'reserved') throw new Error('expected successor reservation');
      assert.equal(successor.generation, orphan.token.generation, 'discard leaves the unpublished registry generation reusable');
      assert.notEqual(successor.receiptId, orphan.receiptId);
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'not_owned', 'the successor receipt is never reinterpreted as the stale marker');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', orphan.token.generation, orphan.receiptId), f.options).outcome, 'not_owned');
      assert.equal(f.registry.readLane(successor.laneId)?.status, 'active');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('preserves legacy active and settled receipt ID acceptance while requiring canonical marker UUIDs', () => {
    const f = setup();
    try {
      const reserved = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(reserved.outcome, 'reserved');
      if (reserved.outcome !== 'reserved') throw new Error('expected reservation');
      const legacyReceiptId = '-'.repeat(36);
      const legacyReceipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as Record<string, unknown>;
      legacyReceipt.receiptId = legacyReceiptId;
      writeFileSync(f.receiptPath, JSON.stringify(legacyReceipt), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', reserved.generation), f.options).outcome, 'recoverable');

      const settled = handleHeartbeatAdmission(f.settle('acme/widgets', reserved.generation, legacyReceiptId), f.options);
      assert.equal(settled.outcome, 'settled', 'the legacy active receipt remains settleable');
      const released = handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options);
      assert.equal(released.outcome, 'released_predecessor', 'legacy settled receipts retain their previous schema acceptance');

      const marker = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as Record<string, unknown>;
      marker.kind = 'discarded_uncommitted';
      marker.generation = reserved.generation + 2;
      marker.predecessor = { kind: 'released', generation: reserved.generation + 1 };
      delete marker.status;
      delete marker.token;
      writeFileSync(f.receiptPath, JSON.stringify(marker), { mode: 0o600 });
      assert.throws(() => handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options), /unsupported or ambiguous schema/,
        'new discarded markers require canonical UUIDs even though legacy receipt IDs retain their prior rule');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('does not classify or discard an orphan over a manual-checkpoint predecessor', () => {
    const f = setup();
    try {
      const reserved = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(reserved.outcome, 'reserved');
      if (reserved.outcome !== 'reserved') throw new Error('expected reservation');
      const activeReceipt = JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { token: { laneId: string; generation: number; token: string } };
      f.registry.parkManual(activeReceipt.token, {
        worktree: f.workspace, branch: 'main', checkpointSha: 'a'.repeat(40), clean: true, stopped: true,
      });
      const parked = f.registry.readLane(reserved.laneId)!;
      assert.equal(parked.parkedReason, 'manual_checkpoint');
      const generation = parked.generation + 1;
      const receiptId = '00000000-0000-4000-8000-000000000043';
      const laneId = heartbeatLaneId('acme/widgets', f.workspace);
      writeFileSync(f.receiptPath, JSON.stringify({ schemaVersion: 1, laneId, missionId: parked.missionId,
        repository: 'acme/widgets', workspace: realpathSync(f.workspace), supervisorId, receiptId, status: 'active',
        token: { laneId, generation, token: 'orphan-token' } }), { mode: 0o600 });
      assert.equal(handleHeartbeatAdmission(f.recover('acme/widgets', null), f.options).outcome, 'not_owned');
      assert.equal(handleHeartbeatAdmission(f.discard('acme/widgets', generation, receiptId), f.options).outcome, 'not_owned');
      assert.equal(existsSync(f.receiptPath), true);
      assert.equal(f.registry.readLane(reserved.laneId)?.parkedReason, 'manual_checkpoint');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('recovers an exact settle when tombstone publication succeeded but registry commit failed', () => {
    let failCommit = false;
    const f = setup({ beforePublish: () => { if (failCommit) { failCommit = false; throw new Error('injected release publication failure'); } } });
    try {
      const reserved = handleHeartbeatAdmission(f.request('reserve'), f.options);
      assert.equal(reserved.outcome, 'reserved');
      if (reserved.outcome !== 'reserved') throw new Error('expected reservation');
      failCommit = true;
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', reserved.generation, reserved.receiptId), f.options), /injected release publication failure/);
      assert.equal(f.registry.readLane(reserved.laneId)?.status, 'active');
      assert.equal((JSON.parse(readFileSync(f.receiptPath, 'utf8')) as { status: string }).status, 'settled');
      const wrongOwner = handleHeartbeatAdmission(f.recover('acme/widgets', reserved.generation, { supervisor: 'other-supervisor' }), f.options);
      assert.equal(wrongOwner.outcome, 'not_owned', 'settlement pending remains private to its exact supervisor identity');
      const pending = handleHeartbeatAdmission(f.recover('acme/widgets', reserved.generation), f.options);
      assert.equal(pending.outcome, 'settlement_pending');
      if (pending.outcome !== 'settlement_pending') throw new Error('expected exact pending settlement');
      assert.equal(pending.generation, reserved.generation);
      assert.equal(pending.receiptId, reserved.receiptId);
      const restartedOptions: HeartbeatAdmissionOptions = {
        registry: new MissionAdmissionRegistry({ filePath: f.registryPath, config }),
        receiptPath: () => f.receiptPath,
      };
      const afterRestart = handleHeartbeatAdmission(f.recover('acme/widgets', reserved.generation), restartedOptions);
      assert.equal(afterRestart.outcome, 'settlement_pending');
      const repeated = handleHeartbeatAdmission(f.settle('acme/widgets', reserved.generation, reserved.receiptId), restartedOptions);
      assert.equal(repeated.outcome, 'settled');
      assert.equal(f.registry.readLane(reserved.laneId)?.status, 'released');
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('fails closed on corrupt receipts and rejects unbounded or ambiguous JSON input', () => {
    const f = setup();
    try {
      mkdirSync(path.dirname(f.receiptPath), { recursive: true, mode: 0o700 });
      writeFileSync(f.receiptPath, '{broken');
      chmodSync(f.receiptPath, 0o600);
      assert.throws(() => handleHeartbeatAdmission(f.settle('acme/widgets', 1, '00000000-0000-0000-0000-000000000000'), f.options), /corrupt/);
      assert.throws(() => handleHeartbeatAdmissionJson(' '.repeat(8_193), f.options), /bounded input size/);
      assert.throws(() => handleHeartbeatAdmissionJson(JSON.stringify({ schemaVersion: 1, action: 'inspect', repository: 'acme/widgets', workspace: f.workspace, token: 'extra' }), f.options), /malformed/);
    } finally { rmSync(f.directory, { recursive: true, force: true }); }
  });

  it('serves one bounded JSON request through the standalone Node helper with secret-free stdout', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-heartbeat-cli-'));
    const workspace = path.join(directory, 'workspace');
    mkdirSync(workspace);
    const env = {
      ...process.env,
      HOME: directory,
      TACHIKO_DATA_DIR: path.join(directory, 'runs'),
      TACHIKO_DISPATCH_WAKE_PATH: path.join(directory, 'dispatch', 'wake'),
    };
    try {
      const child = spawnSync(process.execPath, ['--import', path.join(ROOT, 'node_modules/tsx/dist/loader.mjs'), '--import', path.join(ROOT, 'tests/fixtures/account-home-preload.mjs'), path.join(ROOT, 'src', 'mission-admission', 'heartbeat-admission-cli.ts')], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        input: `${JSON.stringify({ schemaVersion: 1, action: 'reserve', repository: 'acme/widgets', workspace, supervisorId })}\n`,
      });
      assert.equal(child.status, 0, child.stderr);
      const response = JSON.parse(child.stdout) as { outcome: string; receiptId: string };
      assert.equal(response.outcome, 'reserved');
      assert.match(response.receiptId, /^[0-9a-f-]{36}$/);
      assert.equal(child.stdout.includes('token'), false);
      const malformed = spawnSync(process.execPath, ['--import', path.join(ROOT, 'node_modules/tsx/dist/loader.mjs'), '--import', path.join(ROOT, 'tests/fixtures/account-home-preload.mjs'), path.join(ROOT, 'src', 'mission-admission', 'heartbeat-admission-cli.ts')], {
        cwd: ROOT, env, encoding: 'utf8', input: '{"schemaVersion":1,"action":"reserve","extra":true}',
      });
      assert.equal(malformed.status, 1);
      assert.deepEqual(JSON.parse(malformed.stdout), { schemaVersion: 1, outcome: 'error', code: 'admission_unavailable' });
      assert.equal(malformed.stdout.includes('token'), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
