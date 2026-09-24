import assert from 'node:assert/strict';
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
  const recover = (repository: string, generation: number, overrides: { readonly supervisor?: string } = {}) => ({
    schemaVersion: 1,
    action: 'recover',
    repository,
    workspace,
    supervisorId: overrides.supervisor ?? supervisorId,
    expectedGeneration: generation,
  });
  return { directory, workspace, registry, registryPath, receiptPath, options, request, settle, recover };
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
