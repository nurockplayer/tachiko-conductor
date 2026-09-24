import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { canonicalizeMissionEvidence, MissionAdmissionRegistry, type AdmissionConfig, type AdmissionResult, type AdmissionToken, type MissionEvidence } from '../src/mission-admission/registry.js';
import { acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { createHostAdmissionRegistry, resolveHeartbeatOwnerReceiptPath, resolveHostAdmissionConfig, resolveHostAdmissionPath, resolveManualOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { dispatchWakePath } from '../src/dispatch/wake.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { createRun } from '../src/domain/run.js';
import { findRunByTarget, parseGitHubRepositoryRemote, resolveRunsDir } from '../src/cli.js';
import { readManualOwnerReceipt, writeManualOwnerReceipt, type ManualOwnerReceipt } from '../src/mission-admission/manual-owner-receipt.js';
import { handleHeartbeatAdmission } from '../src/mission-admission/heartbeat-admission.js';
import { T0, TARGET } from './helpers.js';

const config: AdmissionConfig = { schemaVersion: 1, revision: 'test-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
const ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_URL = pathToFileURL(path.join(ROOT, 'src/mission-admission/registry.ts')).href;
const CLI_FILE = path.join(ROOT, 'src/cli.ts');

function createHashForTest(repository: string, workspace: string): string {
  return createHash('sha256').update(`${repository}\0${realpathSync(workspace)}`).digest('hex');
}

function fixture(overrides: { readonly config?: AdmissionConfig; readonly beforePublish?: () => void; readonly onPublishedTransition?: (projection: import('../src/mission-admission/registry.js').AdmissionProjection) => void } = {}): { directory: string; filePath: string; registry: MissionAdmissionRegistry } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-admission-'));
  const filePath = path.join(directory, 'host', 'admission.json');
  return { directory, filePath, registry: new MissionAdmissionRegistry({ filePath, config: overrides.config ?? config, lockTimeoutMs: 10_000, ...(overrides.beforePublish ? { beforePublish: overrides.beforePublish } : {}), ...(overrides.onPublishedTransition ? { onPublishedTransition: overrides.onPublishedTransition } : {}) }) };
}

function evidence(issue: number, overrides: Partial<MissionEvidence> = {}): MissionEvidence {
  return { repository: 'Example/Widgets', issue, workspace: `/tmp/work-${issue}`, stateSurface: `/tmp/state-${issue}`, ...overrides };
}

function childAdmission(filePath: string, laneId: string, issue: number): Promise<AdmissionResult> {
  const source = `import { MissionAdmissionRegistry } from ${JSON.stringify(MODULE_URL)}; const registry = new MissionAdmissionRegistry({ filePath: ${JSON.stringify(filePath)}, config: ${JSON.stringify(config)}, lockTimeoutMs: 10000 }); const result = registry.admit({ laneId: ${JSON.stringify(laneId)}, role: 'production_captain', evidence: { repository: 'example/widgets', issue: ${issue}, workspace: ${JSON.stringify(`/tmp/work-${issue}`)}, stateSurface: ${JSON.stringify(`/tmp/state-${issue}`)} } }); console.log(JSON.stringify(result));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Admission child exited ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout.trim()) as AdmissionResult); } catch (error) { reject(error); } }
    });
  });
}

function childDelegateAdmission(filePath: string, laneId: string, parent: AdmissionToken, configInput: AdmissionConfig): Promise<{ readonly outcome?: string; readonly token?: AdmissionToken; readonly error?: string }> {
  const evidence = { repository: 'example/widgets', issue: 303, workspace: `/tmp/${laneId}` };
  const source = `import { MissionAdmissionRegistry } from ${JSON.stringify(MODULE_URL)}; const registry = new MissionAdmissionRegistry({ filePath: ${JSON.stringify(filePath)}, config: ${JSON.stringify(configInput)}, lockTimeoutMs: 10000 }); try { const result = registry.admit({ laneId: ${JSON.stringify(laneId)}, role: 'delegated_mutation_writer', delegatedFromLaneId: ${JSON.stringify(parent.laneId)}, delegatedFromToken: ${JSON.stringify(parent)}, evidence: ${JSON.stringify(evidence)} }); console.log(JSON.stringify(result)); } catch (error) { console.log(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Delegate contender exited ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout.trim()) as { outcome?: string; token?: AdmissionToken; error?: string }); } catch (error) { reject(error); } }
    });
  });
}

function childStrengthen(filePath: string, selectedConfig: AdmissionConfig, laneId: string, generation: number, token: string, repository: string, issue: number, workspace: string): Promise<{ readonly ok: boolean; readonly revision?: number; readonly error?: string }> {
  const source = `import { MissionAdmissionRegistry } from ${JSON.stringify(MODULE_URL)}; const registry = new MissionAdmissionRegistry({ filePath: ${JSON.stringify(filePath)}, config: ${JSON.stringify(selectedConfig)}, lockTimeoutMs: 10000 }); try { const revision = registry.strengthen({ laneId: ${JSON.stringify(laneId)}, generation: ${generation}, token: ${JSON.stringify(token)} }, { repository: ${JSON.stringify(repository)}, issue: ${issue}, run: ${JSON.stringify(`run-${issue}`)}, workspace: ${JSON.stringify(workspace)} }); console.log(JSON.stringify({ ok: true, revision })); } catch (error) { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`Admission strengthener exited ${code}: ${stderr}`));
      else { try { resolve(JSON.parse(stdout.trim()) as { ok: boolean; revision?: number; error?: string }); } catch (error) { reject(error); } }
    });
  });
}

function runCli(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const child = spawnSync(process.execPath, ['--import', path.join(ROOT, 'node_modules/tsx/dist/loader.mjs'), '--import', path.join(ROOT, 'tests/fixtures/account-home-preload.mjs'), CLI_FILE, ...args], { cwd, env, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function git(directory: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

describe('provider-neutral durable mission admission', () => {
  it('signals only after atomic publication of meaningful revisions and never hides an admitted token on signal failure', () => {
    let signals = 0;
    const { directory, filePath, registry } = fixture({ onPublishedTransition: (projection) => {
      signals += 1;
      const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as { revision: number };
      assert.equal(persisted.revision, projection.revision, 'wake callback must observe the published registry state');
      throw new Error('wake path temporarily unavailable');
    } });
    try {
      const first = registry.admit({ laneId: 'wake-captain', role: 'production_captain', evidence: evidence(90) });
      assert.equal(first.outcome, 'admitted', 'best-effort wake failure must not hide the generation token');
      if (first.outcome !== 'admitted') throw new Error('expected admitted lane');
      assert.equal(registry.snapshot().revision, first.revision);
      registry.renew(first.token);
      assert.equal(signals, 1, 'timestamp-only renew must not signal');
      assert.equal(registry.snapshot().revision, first.revision, 'timestamp-only renew keeps the meaningful revision');
      const parked = registry.admit({ laneId: 'waiting-captain', role: 'production_captain', evidence: evidence(91) });
      assert.equal(parked.outcome, 'parked');
      assert.equal(signals, 2, 'new parked ownership transition signals');
      const revision = registry.snapshot().revision;
      const retry = registry.admit({ laneId: 'waiting-captain', role: 'production_captain', evidence: evidence(91) });
      assert.equal(retry.outcome, 'parked');
      assert.equal(signals, 2, 'unchanged parked retry must not signal');
      assert.equal(registry.snapshot().revision, revision, 'unchanged parked retry does not publish a transition');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('serializes independent processes racing for the final captain slot', async () => {
    const { directory, filePath, registry } = fixture();
    try {
      const results = await Promise.all([childAdmission(filePath, 'captain-a', 1), childAdmission(filePath, 'captain-b', 2)]);
      assert.deepEqual(results.map((result) => result.outcome).sort(), ['admitted', 'parked']);
      const parked = results.find((result) => result.outcome === 'parked');
      assert.ok(parked && parked.outcome === 'parked');
      assert.equal(parked.reason, 'capacity_captains');
      assert.equal(registry.snapshot().counts.captains, 1);
      assert.equal(registry.snapshot().revision, 2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('serializes stale-lock takeover against a contender that acquires during recovery', () => {
    const { directory, filePath } = fixture();
    const lockPath = `${filePath}.lock`;
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ nonce: 'dead-owner', pid: 2_000_000_000 }));
    let contender: ReturnType<typeof acquireDispatchInvocationLock> | undefined;
    const registry = new MissionAdmissionRegistry({
      filePath,
      config,
      lockTimeoutMs: 20,
      lockRetryMs: 1,
      beforeStaleTakeover: () => {
        contender = acquireDispatchInvocationLock({ lockPath, nonce: () => 'live-contender' });
      },
    });
    try {
      assert.throws(() => registry.admit({ laneId: 'race', role: 'production_captain', evidence: evidence(29) }), /lock is held or ambiguous/);
      assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).nonce, 'live-contender');
      assert.equal(existsSync(filePath), false, 'the losing takeover must not publish admission state');
    } finally {
      contender?.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('canonicalizes final-component registry symlinks so state and lock remain shared', () => {
    const { directory, filePath, registry } = fixture();
    try {
      const admitted = registry.admit({ laneId: 'alias-lane', role: 'production_captain', evidence: evidence(30) });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      const alias = path.join(directory, 'host', 'alias.json');
      symlinkSync(filePath, alias);
      const aliasRegistry = new MissionAdmissionRegistry({ filePath: alias, config });
      aliasRegistry.park(admitted.token, 'workflow_wait');
      assert.equal(registry.readLane('alias-lane')?.status, 'parked');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('persists deterministic mission identity and parked revision across restart', () => {
    const { directory, filePath, registry } = fixture();
    try {
      const captain = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(8) });
      const waiting = registry.admit({ laneId: 'next', role: 'production_captain', evidence: evidence(9) });
      assert.equal(captain.outcome, 'admitted');
      assert.equal(waiting.outcome, 'parked');
      assert.equal(waiting.revision, 2);
      const restarted = new MissionAdmissionRegistry({ filePath, config });
      const snapshot = restarted.snapshot();
      assert.equal(snapshot.revision, 2);
      assert.equal(snapshot.counts.parked, 1);
      const resumed = restarted.admit({ laneId: 'next', role: 'production_captain', evidence: evidence(9) });
      assert.equal(resumed.outcome, 'parked');
      assert.equal(resumed.missionId, waiting.missionId);
      assert.equal(resumed.revision, 2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects overlapping production ownership even when provider identity is absent', () => {
    let writes = 0;
    const { directory, registry } = fixture({ beforePublish: () => { writes += 1; } });
    try {
      const first = registry.admit({ laneId: 'native', role: 'production_captain', evidence: evidence(22) });
      const second = registry.admit({ laneId: 'heartbeat', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 22, run: 'run-from-heartbeat' } });
      assert.equal(first.outcome, 'admitted');
      assert.equal(second.outcome, 'duplicate');
      if (first.outcome === 'admitted') assert.equal(first.missionId, second.missionId);
      const writesBeforeRetry = writes;
      const revision = registry.snapshot().revision;
      const duplicateRetry = registry.admit({ laneId: 'heartbeat', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 22, run: 'run-from-heartbeat' } });
      assert.equal(duplicateRetry.outcome, 'duplicate');
      assert.equal(duplicateRetry.revision, revision);
      assert.equal(registry.snapshot().revision, revision);
      assert.equal(writes, writesBeforeRetry);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('makes repository-wide production scope overlap all same-repository missions without merging issue identities', () => {
    const repoConfig: AdmissionConfig = { schemaVersion: 1, revision: 'repo-scope-v1', limits: { maxCaptains: 3, maxWriters: 2, maxHighAutonomy: 3 } };
    const { directory, registry } = fixture({ config: repoConfig });
    try {
      const issueA = registry.admit({ laneId: 'issue-a', role: 'production_captain', evidence: evidence(201) });
      const issueB = registry.admit({ laneId: 'issue-b', role: 'production_captain', evidence: evidence(202) });
      assert.equal(issueA.outcome, 'admitted');
      assert.equal(issueB.outcome, 'admitted');
      if (issueA.outcome !== 'admitted' || issueB.outcome !== 'admitted') return;
      assert.notEqual(issueA.missionId, issueB.missionId);
      const bootstrap = registry.admit({ laneId: 'bootstrap', role: 'production_captain', evidence: { repository: 'example/widgets', repositoryScope: true } });
      assert.equal(bootstrap.outcome, 'duplicate');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('atomically strengthens PR and worktree evidence without changing its generation or mission', () => {
    const { directory, filePath, registry } = fixture({ config: { schemaVersion: 1, revision: 'strengthen-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
    try {
      const admitted = registry.admit({ laneId: 'strengthen-me', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 204, run: 'run-204' } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      assert.throws(() => registry.assertCanMutate(admitted.token), /canonical workspace evidence/);
      assert.equal(registry.assertCurrentOwner(admitted.token), undefined, 'logical reservation remains valid for receipt recovery');
      const before = registry.readLane(admitted.token.laneId)!;
      const revised = registry.strengthen(admitted.token, { repository: 'example/widgets', issue: 204, run: 'run-204', pullRequest: 88, workspace: directory });
      const after = registry.readLane(admitted.token.laneId)!;
      assert.equal(after.missionId, before.missionId);
      assert.equal(after.generation, admitted.token.generation);
      assert.equal(after.evidence.pullRequest, 88);
      assert.equal(after.evidence.workspace, realpathSync(directory));
      assert.equal(registry.assertCanMutate(admitted.token), undefined);
      assert.equal(registry.strengthen(admitted.token, { repository: 'example/widgets', issue: 204, run: 'run-204', pullRequest: 88, workspace: directory }), revised, 'identical evidence does not publish another revision');

      const restarted = new MissionAdmissionRegistry({ filePath, config: { schemaVersion: 1, revision: 'strengthen-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
      assert.equal(restarted.strengthen(admitted.token, { repository: 'example/widgets', issue: 204, run: 'run-204', pullRequest: 88, workspace: directory }), revised);
      assert.equal(restarted.readLane(admitted.token.laneId)?.missionId, before.missionId);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('serializes concurrent evidence strengthening to one physical worktree across repository aliases', async () => {
    const configForRace: AdmissionConfig = { schemaVersion: 1, revision: 'strengthen-race-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
    const { directory, filePath } = fixture({ config: configForRace });
    try {
      const registry = new MissionAdmissionRegistry({ filePath, config: configForRace, lockTimeoutMs: 10_000 });
      const first = registry.admit({ laneId: 'race-a', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 205, run: 'run-205' } });
      const second = registry.admit({ laneId: 'race-b', role: 'production_captain', evidence: { repository: 'fork/widgets', issue: 206, run: 'run-206' } });
      assert.equal(first.outcome, 'admitted'); assert.equal(second.outcome, 'admitted');
      if (first.outcome !== 'admitted' || second.outcome !== 'admitted') return;
      const shared = path.join(directory, 'shared-worktree');
      mkdirSync(shared);
      const results = await Promise.all([
        childStrengthen(filePath, configForRace, first.token.laneId, first.token.generation, first.token.token, 'example/widgets', 205, shared),
        childStrengthen(filePath, configForRace, second.token.laneId, second.token.generation, second.token.token, 'fork/widgets', 206, shared),
      ]);
      assert.deepEqual(results.map((item) => item.ok).sort(), [false, true]);
      const restarted = new MissionAdmissionRegistry({ filePath, config: configForRace });
      const owners = restarted.snapshot().lanes.filter((lane) => lane.evidence.workspace === realpathSync(shared));
      assert.equal(owners.length, 1, 'only one serialized strengthener can publish the shared surface');
      assert.equal(restarted.snapshot().counts.captains, 2, 'strengthening retains both pre-existing lane generations');
      for (const admitted of [first, second]) {
        const lane = restarted.readLane(admitted.token.laneId)!;
        if (lane.evidence.workspace === undefined) assert.throws(() => restarted.assertCanMutate(admitted.token), /canonical workspace evidence/);
        else assert.equal(restarted.assertCanMutate(admitted.token), undefined);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps independent PRs and canonical workspaces admissible', () => {
    const configForParallel: AdmissionConfig = { schemaVersion: 1, revision: 'independent-workspaces-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
    const { directory, registry } = fixture({ config: configForParallel });
    try {
      const first = registry.admit({ laneId: 'independent-a', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 207, run: 'run-207' } });
      const second = registry.admit({ laneId: 'independent-b', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 208, run: 'run-208' } });
      assert.equal(first.outcome, 'admitted'); assert.equal(second.outcome, 'admitted');
      if (first.outcome !== 'admitted' || second.outcome !== 'admitted') return;
      const firstWorkspace = path.join(directory, 'independent-a');
      const secondWorkspace = path.join(directory, 'independent-b');
      mkdirSync(firstWorkspace); mkdirSync(secondWorkspace);
      registry.strengthen(first.token, { repository: 'example/widgets', issue: 207, run: 'run-207', pullRequest: 107, workspace: firstWorkspace });
      registry.strengthen(second.token, { repository: 'example/widgets', issue: 208, run: 'run-208', pullRequest: 108, workspace: secondWorkspace });
      assert.equal(registry.snapshot().counts.captains, 2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('parks manual repository ownership only with explicit clean stop and checkpoint proof', () => {
    const { directory, registry } = fixture();
    try {
      const lane = registry.admit({ laneId: 'manual:lane', role: 'production_captain', evidence: { repository: 'example/widgets', repositoryScope: true, workspace: directory } });
      assert.equal(lane.outcome, 'admitted');
      if (lane.outcome !== 'admitted') return;
      assert.throws(() => registry.parkManual(lane.token, { worktree: directory, branch: 'codex/manual', checkpointSha: 'a'.repeat(40), clean: true, stopped: false }), /explicit stopped/);
      registry.parkManual(lane.token, { worktree: directory, branch: 'codex/manual', checkpointSha: 'a'.repeat(40), clean: true, stopped: true });
      assert.equal(registry.readLane('manual:lane')?.status, 'parked');
      assert.equal('token' in registry.readLane('manual:lane')!, false);
      const duplicate = registry.admit({ laneId: 'other', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 203 } });
      assert.equal(duplicate.outcome, 'duplicate');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fences stale tokens after park and release; release needs stop evidence', () => {
    const { directory, registry } = fixture();
    try {
      const first = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(31) });
      assert.equal(first.outcome, 'admitted');
      if (first.outcome !== 'admitted') return;
      registry.park(first.token, 'capacity_captains');
      assert.throws(() => registry.renew(first.token), /stale/);
      const resumed = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(31) });
      assert.equal(resumed.outcome, 'admitted');
      if (resumed.outcome !== 'admitted') return;
      assert.notEqual(resumed.token.generation, first.token.generation);
      assert.throws(() => registry.release(resumed.token, false), /stopped/);
      registry.release(resumed.token, true);
      assert.throws(() => registry.release(resumed.token, true), /stale/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not advance the meaningful revision for timestamp-only renewal', () => {
    const { directory, registry } = fixture({});
    try {
      const admitted = registry.admit({ laneId: 'renew-lane', role: 'production_captain', evidence: evidence(32) });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      const before = registry.snapshot();
      registry.renew(admitted.token);
      const after = registry.snapshot();
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.lastTransition, before.lastTransition);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects repository changes when stronger evidence resumes the same lane', () => {
    const { directory, registry } = fixture();
    try {
      const started = registry.admit({ laneId: 'lane', role: 'production_captain', evidence: evidence(35) });
      assert.equal(started.outcome, 'admitted');
      if (started.outcome !== 'admitted') return;
      registry.release(started.token, true);
      assert.throws(() => registry.admit({ laneId: 'lane', role: 'production_captain', evidence: { repository: 'elsewhere/widgets', issue: 35, workspace: '/tmp/work-35', stateSurface: '/tmp/state-35' } }), /conflicts on repository/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed on corrupt persisted state without replacing it', () => {
    const { directory, filePath, registry } = fixture();
    try {
      registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(32) });
      writeFileSync(filePath, '{ truncated', 'utf8');
      assert.throws(() => registry.snapshot(), /corrupt/);
      assert.equal(readFileSync(filePath, 'utf8'), '{ truncated');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('enforces read-only and isolated experiment roles at mutation and publication boundaries', () => {
    const { directory, registry } = fixture();
    try {
      const captain = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(40) });
      const review = registry.admit({ laneId: 'review', role: 'read_only_review', evidence: evidence(40) });
      assert.equal(captain.outcome, 'admitted');
      assert.equal(review.outcome, 'admitted');
      if (review.outcome === 'admitted') {
        assert.throws(() => registry.assertCanMutate(review.token), /cannot mutate/);
        assert.throws(() => registry.assertCanPublish(review.token, captain.missionId), /cannot publish/);
      }
      const experiment = registry.admit({ laneId: 'experiment', role: 'isolated_experiment', experimentOfMissionId: captain.missionId, evidence: evidence(40, { workspace: '/tmp/experiment-40', stateSurface: '/tmp/experiment-state-40' }) });
      assert.equal(experiment.outcome, 'admitted');
      if (experiment.outcome === 'admitted') assert.throws(() => registry.assertCanPublish(experiment.token, captain.missionId), /cannot publish/);
      assert.throws(() => registry.admit({ laneId: 'bad-experiment', role: 'isolated_experiment', experimentOfMissionId: captain.missionId, evidence: evidence(40) }), /separate workspace and state surface/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('gives same-Issue experiments stable distinct high-autonomy capacity identities', () => {
    const limits: AdmissionConfig = { schemaVersion: 1, revision: 'experiment-capacity-v1', limits: { maxCaptains: 2, maxWriters: 3, maxHighAutonomy: 1 } };
    const { directory, filePath, registry } = fixture({ config: limits });
    try {
      const parent = registry.admit({ laneId: 'experiment-parent', role: 'production_captain', evidence: evidence(44) });
      assert.equal(parent.outcome, 'admitted');
      if (parent.outcome !== 'admitted') throw new Error('expected captain admission');
      const first = registry.admit({ laneId: 'exp-one', role: 'isolated_experiment', experimentOfMissionId: parent.missionId, highAutonomy: true,
        evidence: evidence(44, { workspace: '/tmp/exp-one-work', stateSurface: '/tmp/exp-one-state' }) });
      const second = registry.admit({ laneId: 'exp-two', role: 'isolated_experiment', experimentOfMissionId: parent.missionId, highAutonomy: true,
        evidence: evidence(44, { workspace: '/tmp/exp-two-work', stateSurface: '/tmp/exp-two-state' }) });
      assert.equal(first.outcome, 'admitted');
      assert.equal(second.outcome, 'parked');
      if (first.outcome !== 'admitted' || second.outcome !== 'parked') throw new Error('expected first experiment admitted and second parked');
      assert.notEqual(first.missionId, second.missionId);
      assert.equal(registry.snapshot().counts.writers, 1, 'experiments remain outside production writer capacity');
      assert.equal(registry.snapshot().counts.highAutonomy, 1);
      const revision = registry.snapshot().revision;
      const unchangedRetry = registry.admit({ laneId: 'exp-two', role: 'isolated_experiment', experimentOfMissionId: parent.missionId, highAutonomy: true,
        evidence: evidence(44, { workspace: '/tmp/exp-two-work', stateSurface: '/tmp/exp-two-state' }) });
      assert.deepEqual(unchangedRetry, { outcome: 'parked', missionId: second.missionId, reason: 'capacity_high_autonomy', revision });

      const restarted = new MissionAdmissionRegistry({ filePath, config: limits, lockTimeoutMs: 10_000 });
      const restartedFirst = restarted.readLane('exp-one');
      const restartedSecond = restarted.readLane('exp-two');
      assert.equal(restartedFirst?.missionId, first.missionId);
      assert.equal(restartedSecond?.missionId, second.missionId);
      assert.equal(restarted.snapshot().counts.writers, 1);
      assert.equal(restarted.snapshot().counts.highAutonomy, 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('publishes a manual owner receipt before registry state and leaves a non-authorizing stale receipt on the prepublish crash seam', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-admission-receipt-seam-'));
    const filePath = path.join(directory, 'registry.json');
    const receiptPath = path.join(directory, 'manual.json');
    const crashAfterReceipt = new MissionAdmissionRegistry({ filePath, config, beforePublish: () => { throw new Error('injected registry publication crash'); } });
    const evidenceValue = { repository: 'example/widgets', repositoryScope: true as const, workspace: path.join(directory, 'worktree') };
    mkdirSync(evidenceValue.workspace);
    const writeCandidate = (candidate: Extract<AdmissionResult, { outcome: 'admitted' }>) => {
      const receipt: ManualOwnerReceipt = { schemaVersion: 1, laneId: 'manual:seam', missionId: candidate.missionId, repository: 'example/widgets', workspace: evidenceValue.workspace,
        branch: 'main', checkpointSha: 'a'.repeat(40), status: 'active', generation: candidate.token.generation, token: candidate.token };
      writeManualOwnerReceipt(receiptPath, receipt);
    };
    try {
      assert.throws(() => crashAfterReceipt.admit({ laneId: 'manual:seam', role: 'production_captain', evidence: evidenceValue, highAutonomy: true }, { beforePublish: writeCandidate }), /injected registry publication crash/);
      const stale = readManualOwnerReceipt(receiptPath);
      assert.ok(stale?.token);
      assert.equal((statSync(receiptPath).mode & 0o777), 0o600);
      assert.deepEqual(crashAfterReceipt.snapshot().counts, { captains: 0, writers: 0, highAutonomy: 0, parked: 0 });
      assert.throws(() => crashAfterReceipt.assertCanMutate(stale!.token!), /stale|no longer/);

      const recoveredRegistry = new MissionAdmissionRegistry({ filePath, config });
      const admitted = recoveredRegistry.admit({ laneId: 'manual:seam', role: 'production_captain', evidence: evidenceValue, highAutonomy: true }, { beforePublish: writeCandidate });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') throw new Error('expected recovered admission');
      const published = readManualOwnerReceipt(receiptPath);
      assert.deepEqual(published?.token, admitted.token);
      recoveredRegistry.assertCanMutate(published!.token!);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('validates the versioned config strictly and produces a bounded model-free projection', () => {
    const { directory, filePath, registry } = fixture();
    try {
      assert.throws(() => new MissionAdmissionRegistry({ filePath, config: { ...config, provider: 'codex' } as AdmissionConfig }), /schema/);
      const parked = registry.admit({ laneId: 'captain-a', role: 'production_captain', evidence: evidence(50) });
      assert.equal(parked.outcome, 'admitted');
      const waiting = registry.admit({ laneId: 'captain-b', role: 'production_captain', highAutonomy: true, evidence: evidence(51) });
      assert.equal(waiting.outcome, 'parked');
      assert.equal(waiting.reason, 'capacity_captains');
      assert.equal(registry.snapshot().revision, 2);
      assert.equal(registry.snapshot().lanes.length, 2);
      assert.equal(JSON.stringify(registry.snapshot()).includes('model'), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps snapshots and role assertions read-only, including before the registry exists', () => {
    const { directory, filePath, registry } = fixture();
    try {
      assert.equal(registry.snapshot().revision, 0);
      assert.equal(existsSync(filePath), false);
      assert.throws(() => registry.assertCanMutate({ laneId: 'absent', generation: 1, token: 'token' }), /stale/);
      assert.throws(() => registry.assertCanPublish({ laneId: 'absent', generation: 1, token: 'token' }, 'mission-x'), /stale/);
      assert.equal(existsSync(path.dirname(filePath)), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps unchanged duplicate and capacity parked retries from advancing revision or publishing', () => {
    let writes = 0;
    const { directory, registry } = fixture({ beforePublish: () => { writes += 1; } });
    try {
      registry.admit({ laneId: 'captain-a', role: 'production_captain', evidence: evidence(60) });
      const firstWait = registry.admit({ laneId: 'captain-b', role: 'production_captain', evidence: evidence(61) });
      assert.equal(firstWait.outcome, 'parked');
      const writesAfterPark = writes;
      const retry = registry.admit({ laneId: 'captain-b', role: 'production_captain', evidence: evidence(61) });
      assert.equal(retry.outcome, 'parked');
      assert.equal(retry.revision, firstWait.revision);
      assert.equal(registry.snapshot().revision, firstWait.revision);
      assert.equal(writes, writesAfterPark);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('canonicalizes symlink aliases before overlap admission', () => {
    const { directory, registry } = fixture();
    try {
      const realWorkspace = path.join(directory, 'real-workspace');
      const aliasWorkspace = path.join(directory, 'workspace-alias');
      const realState = path.join(directory, 'real-state');
      const aliasState = path.join(directory, 'state-alias');
      mkdirSync(realWorkspace); mkdirSync(realState);
      symlinkSync(realWorkspace, aliasWorkspace, 'dir');
      symlinkSync(realState, aliasState, 'dir');
      const first = registry.admit({ laneId: 'real', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 70, workspace: realWorkspace, stateSurface: realState } });
      const second = registry.admit({ laneId: 'alias', role: 'production_captain', evidence: { repository: 'fork/widgets', issue: 71, workspace: aliasWorkspace, stateSurface: aliasState } });
      assert.equal(first.outcome, 'admitted');
      assert.equal(second.outcome, 'duplicate');
      assert.throws(() => registry.admit({ laneId: 'experiment-alias', role: 'isolated_experiment', experimentOfMissionId: 'some-mission', evidence: { repository: 'fork/widgets', workspace: aliasWorkspace, stateSurface: path.join(directory, 'isolated-state') } }), /separate workspace and state surface/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains parked ownership while releasing capacity and lets the same lane resume', () => {
    const { directory, registry } = fixture();
    try {
      const owner = registry.admit({ laneId: 'owner', role: 'production_captain', evidence: evidence(80) });
      const parked = registry.admit({ laneId: 'waiting', role: 'production_captain', evidence: evidence(81) });
      assert.equal(owner.outcome, 'admitted');
      assert.equal(parked.outcome, 'parked');
      const hijack = registry.admit({ laneId: 'fresh-overlap', role: 'production_captain', evidence: evidence(81, { run: 'extra-run' }) });
      assert.equal(hijack.outcome, 'duplicate');
      if (owner.outcome === 'admitted') registry.release(owner.token, true);
      const resumed = registry.admit({ laneId: 'waiting', role: 'production_captain', evidence: evidence(81) });
      assert.equal(resumed.outcome, 'admitted');
      assert.equal(resumed.missionId, parked.missionId);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not count a delegated writer twice against the production per-repository limit', () => {
    const delegatedConfig: AdmissionConfig = { schemaVersion: 1, revision: 'delegated-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2, maxPerRepository: 1 } };
    const { directory, registry } = fixture({ config: delegatedConfig });
    try {
      const captain = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: evidence(90) });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const writer = registry.admit({ laneId: 'writer', role: 'delegated_mutation_writer', delegatedFromLaneId: 'captain', delegatedFromToken: captain.token, evidence: evidence(90) });
      assert.equal(writer.outcome, 'admitted');
      assert.equal(registry.snapshot().counts.captains, 1);
      assert.equal(registry.snapshot().counts.writers, 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('counts the captain mission against writer capacity and applies high-autonomy limits atomically', () => {
    const writerBound: AdmissionConfig = { schemaVersion: 1, revision: 'writer-bound-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2 } };
    const firstFixture = fixture({ config: writerBound });
    try {
      const first = firstFixture.registry.admit({ laneId: 'captain-one', role: 'production_captain', evidence: evidence(91) });
      assert.equal(first.outcome, 'admitted');
      const second = firstFixture.registry.admit({ laneId: 'captain-two', role: 'production_captain', evidence: evidence(92) });
      assert.equal(second.outcome, 'parked');
      if (first.outcome === 'admitted') assert.equal(firstFixture.registry.release(first.token, true) > 0, true);
      const resumed = firstFixture.registry.admit({ laneId: 'captain-two', role: 'production_captain', evidence: evidence(92) });
      assert.equal(resumed.outcome, 'admitted');
      assert.equal(firstFixture.registry.snapshot().counts.writers, 1);
    } finally { rmSync(firstFixture.directory, { recursive: true, force: true }); }

    const autonomyBound: AdmissionConfig = { schemaVersion: 1, revision: 'autonomy-bound-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 1 } };
    const secondFixture = fixture({ config: autonomyBound });
    try {
      const first = secondFixture.registry.admit({ laneId: 'autonomous-one', role: 'production_captain', evidence: evidence(93), highAutonomy: true });
      const second = secondFixture.registry.admit({ laneId: 'autonomous-two', role: 'production_captain', evidence: evidence(94), highAutonomy: true });
      assert.equal(first.outcome, 'admitted');
      assert.equal(second.outcome, 'parked');
      if (first.outcome === 'admitted') assert.equal(secondFixture.registry.release(first.token, true) > 0, true);
      assert.equal(secondFixture.registry.admit({ laneId: 'autonomous-two', role: 'production_captain', evidence: evidence(94), highAutonomy: true }).outcome, 'admitted');
    } finally { rmSync(secondFixture.directory, { recursive: true, force: true }); }
  });

  it('keeps a captain reservation fenced while a delegated writer is active or uncertain', () => {
    const { directory, registry } = fixture();
    try {
      const captain = registry.admit({ laneId: 'captain-with-delegate', role: 'production_captain', evidence: evidence(95) });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const delegate = registry.admit({ laneId: 'active-delegate', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, delegatedFromToken: captain.token, evidence: evidence(95) });
      assert.equal(delegate.outcome, 'admitted');
      assert.throws(() => registry.assertCanMutate(captain.token), /delegated writer .* remains active or uncertain/);
      assert.throws(() => registry.assertCanPublish(captain.token, captain.missionId), /delegated writer .* remains active or uncertain/);
      assert.throws(() => registry.park(captain.token, 'workflow_wait'), /delegated writer .* remains active or uncertain/);
      assert.throws(() => registry.release(captain.token, true), /delegated writer .* remains active or uncertain/);
      assert.equal(registry.readLane(captain.token.laneId)?.status, 'active');
      if (delegate.outcome === 'admitted') registry.release(delegate.token, true);
      assert.equal(registry.assertCanMutate(captain.token), undefined);
      assert.equal(registry.assertCanPublish(captain.token, captain.missionId), undefined);
      registry.strengthen(captain.token, { repository: 'example/widgets', issue: 95, pullRequest: 995 });
      assert.equal(registry.snapshot().counts.writers, 1, 'released historical delegate does not invalidate later captain evidence strengthening');
      registry.release(captain.token, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps delegated generations active until stopped proof permits release', () => {
    const { directory, filePath, registry } = fixture();
    try {
      const captain = registry.admit({ laneId: 'captain-delegate-park', role: 'production_captain', evidence: evidence(96) });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const delegate = registry.admit({ laneId: 'delegate-no-park', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, delegatedFromToken: captain.token, evidence: evidence(96) });
      assert.equal(delegate.outcome, 'admitted');
      if (delegate.outcome !== 'admitted') return;
      assert.throws(() => registry.park(delegate.token, 'workflow_wait'), /Delegated writer cannot park/);
      assert.equal(registry.readLane(delegate.token.laneId)?.status, 'active');
      const persisted = JSON.parse(readFileSync(filePath, 'utf8')) as { lanes: Array<Record<string, unknown>> };
      const storedDelegate = persisted.lanes.find((lane) => lane.laneId === delegate.token.laneId)!;
      Object.assign(storedDelegate, { status: 'parked', token: null, generation: delegate.token.generation + 1, parkedReason: 'workflow_wait' });
      writeFileSync(filePath, JSON.stringify(persisted), 'utf8');
      assert.throws(() => registry.snapshot(), /invalid lane record/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('requires the exact parent capability and permits only one evidence-inheriting delegate per mission', () => {
    const { directory, registry } = fixture({ config: { schemaVersion: 1, revision: 'delegate-capability-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
    try {
      const captain = registry.admit({ laneId: 'delegate-parent', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 301, pullRequest: 701, run: 'run-301', claim: 'claim-301' } });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      assert.throws(() => registry.admit({ laneId: 'missing-parent-cap', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, evidence: evidence(301) }), /exact active generation token/);
      assert.throws(() => registry.admit({ laneId: 'wrong-parent-cap', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, delegatedFromToken: { ...captain.token, token: 'wrong' }, evidence: evidence(301) }), /exact active capability/);
      assert.throws(() => registry.admit({ laneId: 'stale-parent-cap', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, delegatedFromToken: { ...captain.token, generation: captain.token.generation + 1 }, evidence: evidence(301) }), /exact active capability/);

      const workspace = path.join(directory, 'delegate-workspace'); mkdirSync(workspace);
      const delegate = registry.admit({
        laneId: 'delegate-parent-child', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId,
        delegatedFromToken: captain.token,
        evidence: { repository: 'example/widgets', issue: 301, pullRequest: 701, run: 'run-301', claim: 'claim-301', workspace },
      });
      assert.equal(delegate.outcome, 'admitted');
      if (delegate.outcome !== 'admitted') return;
      const delegatedLane = registry.readLane(delegate.token.laneId)!;
      assert.equal(delegatedLane.evidence.issue, 301);
      assert.equal(delegatedLane.evidence.pullRequest, 701);
      assert.equal(delegatedLane.evidence.run, 'run-301');
      assert.equal(delegatedLane.evidence.claim, 'claim-301');
      assert.equal(delegatedLane.evidence.workspace, realpathSync(workspace), 'delegate inherits every parent field and adds its canonical workspace');
      assert.equal(delegatedLane.delegatedFromGeneration, captain.token.generation);

      assert.throws(() => registry.admit({
        laneId: 'disjoint-child', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId,
        delegatedFromToken: captain.token,
        evidence: { repository: 'example/widgets', issue: 301, workspace: path.join(directory, 'disjoint'), stateSurface: path.join(directory, 'other-state') },
      }), /already has an active delegated writer/);
      const conflictParent = registry.admit({ laneId: 'conflict-parent', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 302 } });
      assert.equal(conflictParent.outcome, 'admitted');
      if (conflictParent.outcome === 'admitted') assert.throws(() => registry.admit({ laneId: 'conflicting-child', role: 'delegated_mutation_writer', delegatedFromLaneId: conflictParent.token.laneId, delegatedFromToken: conflictParent.token, evidence: { repository: 'example/widgets', issue: 999 } }), /conflicts on issue/);
      assert.throws(() => registry.strengthen(captain.token, { repository: 'example/widgets', workspace: path.join(directory, 'new-parent-workspace') }), /delegated writer .* remains active or uncertain/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects persisted delegates with missing parent generation or duplicate active siblings', () => {
    const { directory, filePath, registry } = fixture({ config: { schemaVersion: 1, revision: 'delegate-state-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
    try {
      const captain = registry.admit({ laneId: 'state-parent', role: 'production_captain', evidence: evidence(302) });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const delegate = registry.admit({ laneId: 'state-child', role: 'delegated_mutation_writer', delegatedFromLaneId: captain.token.laneId, delegatedFromToken: captain.token, evidence: evidence(302) });
      assert.equal(delegate.outcome, 'admitted');
      if (delegate.outcome !== 'admitted') return;
      const original = readFileSync(filePath, 'utf8');
      const invalid = JSON.parse(original) as { lanes: Array<Record<string, unknown>> };
      delete invalid.lanes.find((lane) => lane.laneId === delegate.token.laneId)!.delegatedFromGeneration;
      writeFileSync(filePath, JSON.stringify(invalid));
      assert.throws(() => registry.snapshot(), /invalid lane record/);
      const duplicate = JSON.parse(original) as { lanes: Array<Record<string, unknown>>; revision: number };
      const sibling = { ...duplicate.lanes.find((lane) => lane.laneId === delegate.token.laneId)!, laneId: 'duplicate-child', token: 'different-live-token' };
      duplicate.lanes.push(sibling); duplicate.revision += 1;
      writeFileSync(filePath, JSON.stringify(duplicate));
      assert.throws(() => registry.snapshot(), /multiple active delegates/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('serializes disjoint delegate contenders so only one can own the captain mission', async () => {
    const raceConfig: AdmissionConfig = { schemaVersion: 1, revision: 'delegate-race-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
    const { directory, filePath, registry } = fixture({ config: raceConfig });
    try {
      const captain = registry.admit({ laneId: 'race-delegate-parent', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 303 } });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const results = await Promise.all([
        childDelegateAdmission(filePath, 'race-delegate-a', captain.token, raceConfig),
        childDelegateAdmission(filePath, 'race-delegate-b', captain.token, raceConfig),
      ]);
      assert.equal(results.filter((result) => result.outcome === 'admitted').length, 1);
      assert.equal(results.filter((result) => /already has an active delegated writer/.test(result.error ?? '')).length, 1);
      const restarted = new MissionAdmissionRegistry({ filePath, config: raceConfig });
      assert.equal(restarted.snapshot().lanes.filter((lane) => lane.role === 'delegated_mutation_writer' && lane.status === 'active').length, 1);
      const child = results.find((result) => result.outcome === 'admitted')!;
      restarted.release(child.token!, true);
      restarted.release(captain.token, true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('recovers only the exact heartbeat owner receipt without reserving a successor generation', () => {
    const { directory, registry } = fixture();
    const workspace = path.join(directory, 'heartbeat-workspace');
    const receiptPath = path.join(directory, 'private', 'heartbeat.json');
    mkdirSync(workspace);
    const base = { schemaVersion: 1 as const, repository: 'example/widgets', workspace };
    const run = (action: Record<string, unknown>) => handleHeartbeatAdmission(action, {
      registry, homeDirectory: directory, receiptPath: () => receiptPath,
    });
    try {
      const reserved = run({ ...base, action: 'reserve', supervisorId: 'supervisor-a' });
      assert.equal(reserved.outcome, 'reserved');
      if (reserved.outcome !== 'reserved') return;
      const beforeRecover = registry.snapshot();
      const wrongOwner = run({ ...base, action: 'recover', supervisorId: 'supervisor-b', expectedGeneration: reserved.generation });
      assert.deepEqual(wrongOwner, { schemaVersion: 1, outcome: 'not_owned', laneId: reserved.laneId });
      const exact = run({ ...base, action: 'recover', supervisorId: 'supervisor-a', expectedGeneration: reserved.generation });
      assert.deepEqual(exact, {
        schemaVersion: 1, outcome: 'recoverable', laneId: reserved.laneId,
        generation: reserved.generation, receiptId: reserved.receiptId,
      });
      assert.equal(JSON.stringify(exact).includes('token'), false);
      assert.equal(registry.snapshot().revision, beforeRecover.revision, 'recovery inspection is read-only');

      const settled = run({
        ...base, action: 'settle', supervisorId: 'supervisor-a', expectedGeneration: reserved.generation,
        receiptId: reserved.receiptId,
        stopProof: { childrenStopped: true, supervisorStopped: true, observedAt: new Date().toISOString() },
      });
      assert.equal(settled.outcome, 'settled');
      const afterRelease = registry.snapshot();
      const alreadySettled = run({ ...base, action: 'recover', supervisorId: 'supervisor-a', expectedGeneration: reserved.generation });
      assert.deepEqual(alreadySettled, {
        schemaVersion: 1, outcome: 'already_settled', laneId: reserved.laneId,
        generation: reserved.generation, receiptId: reserved.receiptId,
      });
      assert.equal(registry.snapshot().revision, afterRelease.revision, 'settled reconciliation cannot allocate a new generation');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('checks isolated experiments against parked ownership and ancestor surfaces', () => {
    const constrained: AdmissionConfig = { schemaVersion: 1, revision: 'experiment-parked-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
    const { directory, registry } = fixture({ config: constrained });
    try {
      const owner = registry.admit({ laneId: 'experiment-blocker', role: 'production_captain', evidence: evidence(97) });
      const parked = registry.admit({ laneId: 'parked-surface-owner', role: 'production_captain', evidence: { repository: 'other/repo', issue: 4, workspace: '/tmp/parked-surface', stateSurface: '/tmp/parked-state' } });
      assert.equal(owner.outcome, 'admitted');
      assert.equal(parked.outcome, 'parked');
      assert.throws(() => registry.admit({ laneId: 'experiment-on-parked', role: 'isolated_experiment', experimentOfMissionId: 'mission-any', evidence: { repository: 'third/repo', workspace: '/tmp/parked-surface/nested', stateSurface: '/tmp/other-state' } }), /separate workspace and state surface/);
      assert.equal(registry.snapshot().lanes.some((lane) => lane.laneId === 'experiment-on-parked'), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects strengthening into an experiment physical surface before publishing state', () => {
    const { directory, registry } = fixture();
    try {
      const captain = registry.admit({ laneId: 'captain-strengthen-experiment', role: 'production_captain', evidence: { repository: 'example/widgets', issue: 98 } });
      assert.equal(captain.outcome, 'admitted');
      if (captain.outcome !== 'admitted') return;
      const experiment = registry.admit({ laneId: 'experiment-strengthen-guard', role: 'isolated_experiment', experimentOfMissionId: captain.missionId, evidence: { repository: 'elsewhere/repo', workspace: '/tmp/isolated-exp', stateSurface: '/tmp/isolated-state' } });
      assert.equal(experiment.outcome, 'admitted');
      const before = registry.snapshot();
      assert.throws(() => registry.strengthen(captain.token, { repository: 'example/widgets', workspace: '/tmp/isolated-exp/nested' }), /isolated experiment lane/);
      const after = registry.snapshot();
      assert.equal(after.revision, before.revision);
      assert.deepEqual(after.lanes.find((lane) => lane.laneId === captain.token.laneId)?.evidence, before.lanes.find((lane) => lane.laneId === captain.token.laneId)?.evidence);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('treats canonical ancestor and descendant workspace/state paths as one physical production surface', () => {
    const { directory, registry } = fixture();
    try {
      const root = path.join(directory, 'shared');
      const nested = path.join(root, 'nested');
      mkdirSync(nested, { recursive: true });
      const first = registry.admit({ laneId: 'physical-parent', role: 'production_captain', evidence: { repository: 'acme/a', issue: 1, workspace: root } });
      const second = registry.admit({ laneId: 'physical-child', role: 'production_captain', evidence: { repository: 'different/b', issue: 2, stateSurface: nested } });
      assert.equal(first.outcome, 'admitted');
      assert.equal(second.outcome, 'duplicate');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects persisted noncanonical evidence and per-repository capacity overflow', () => {
    const constrained: AdmissionConfig = { schemaVersion: 1, revision: 'repo-limit-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2, maxPerRepository: 1 } };
    const { directory, filePath, registry } = fixture({ config: constrained });
    try {
      const first = registry.admit({ laneId: 'captain-a', role: 'production_captain', evidence: evidence(100) });
      assert.equal(first.outcome, 'admitted');
      const state = JSON.parse(readFileSync(filePath, 'utf8')) as { lanes: Array<Record<string, unknown>> };
      const lane = state.lanes[0]!;
      lane.evidence = { ...(lane.evidence as object), workspace: '/tmp/../tmp/work-100' };
      writeFileSync(filePath, JSON.stringify(state), 'utf8');
      assert.throws(() => registry.snapshot(), /invalid lane record/);

      const fresh = fixture({ config: constrained });
      try {
        const allowed = fresh.registry.admit({ laneId: 'captain-a', role: 'production_captain', evidence: evidence(101) });
        assert.equal(allowed.outcome, 'admitted');
        const persisted = JSON.parse(readFileSync(fresh.filePath, 'utf8')) as { lanes: Array<Record<string, unknown>> };
        const original = persisted.lanes[0]!;
        persisted.lanes.push({ ...original, laneId: 'captain-b', missionId: 'mission-other', generation: 1, token: 'other-token', evidence: canonicalizeMissionEvidence(evidence(102)) });
        writeFileSync(fresh.filePath, JSON.stringify(persisted), 'utf8');
        assert.throws(() => fresh.registry.snapshot(), /per-repository production capacity/);
      } finally { rmSync(fresh.directory, { recursive: true, force: true }); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('resolves a stable host registry outside per-Run data and accepts revisioned limits', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'admission-resolver-home-'));
    const runs = path.join(home, 'runs');
    const file = path.join(realpathSync(home), '.tachiko-conductor', 'mission-admission', 'registry.json');
    assert.equal(path.basename(resolveHostAdmissionPath({ homeDirectory: home, env: { TACHIKO_DATA_DIR: runs } })), 'registry.json');
    assert.equal(resolveHostAdmissionPath({ homeDirectory: home, env: { TACHIKO_DATA_DIR: runs } }), file);
    assert.throws(() => resolveHostAdmissionPath({ homeDirectory: home, env: { TACHIKO_DATA_DIR: runs, TACHIKO_MISSION_ADMISSION_PATH: path.join(home, 'shared', 'registry.json') } }), /canonical per-user/);
    assert.throws(() => resolveHostAdmissionPath({ homeDirectory: home, env: { TACHIKO_DATA_DIR: path.join(home, '.tachiko-conductor') } }), /outside/);
    const revisioned = { schemaVersion: 1, revision: 'operator-v2', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 1 } };
    assert.deepEqual(resolveHostAdmissionConfig({ TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify(revisioned) }), revisioned);
    assert.throws(() => resolveHostAdmissionConfig({ TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify({ ...revisioned, model: 'codex' }) }), /schema/);
    assert.notEqual(file, runs);

    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-admission-host-path-'));
    try {
      const canonical = path.join(realpathSync(directory), '.tachiko-conductor', 'mission-admission', 'registry.json');
      mkdirSync(path.dirname(canonical), { recursive: true });
      writeFileSync(canonical, '{}');
      const registryAlias = path.join(directory, 'registry-alias.json');
      symlinkSync(canonical, registryAlias);
      assert.equal(resolveHostAdmissionPath({
        homeDirectory: directory,
        env: { TACHIKO_DATA_DIR: path.join(directory, 'runs'), TACHIKO_MISSION_ADMISSION_PATH: registryAlias },
      }), canonical, 'physical alias to the canonical registry remains accepted');
      const runs = path.join(directory, 'runs');
      mkdirSync(runs);
      const runsAlias = path.join(directory, 'runs-alias');
      symlinkSync(runs, runsAlias, 'dir');
      assert.throws(() => resolveHostAdmissionPath({
        homeDirectory: directory,
        env: { TACHIKO_DATA_DIR: runs, TACHIKO_MISSION_ADMISSION_PATH: path.join(runsAlias, 'registry.json') },
      }), /canonical per-user/);
    } finally { rmSync(directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  });

  it('anchors default registry, receipt, CLI, and wake roots to the OS account despite divergent HOME values', () => {
    const accountHome = mkdtempSync(path.join(os.tmpdir(), 'admission-account-home-'));
    const alternateHomeA = mkdtempSync(path.join(os.tmpdir(), 'admission-ambient-home-a-'));
    const alternateHomeB = mkdtempSync(path.join(os.tmpdir(), 'admission-ambient-home-b-'));
    const workspace = path.join(accountHome, 'workspace');
    mkdirSync(workspace);
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: accountHome })) as typeof os.userInfo;
      const canonicalHome = realpathSync(accountHome);
      const envA = { HOME: alternateHomeA };
      const envB = { HOME: alternateHomeB };
      const expectedRegistry = path.join(canonicalHome, '.tachiko-conductor', 'mission-admission', 'registry.json');
      const expectedRuns = path.join(canonicalHome, '.tachiko-conductor', 'runs');
      assert.equal(resolveHostAdmissionPath({ env: envA }), expectedRegistry);
      assert.equal(resolveHostAdmissionPath({ env: envB }), expectedRegistry);
      assert.equal(resolveRunsDir(envA), expectedRuns);
      assert.equal(resolveRunsDir(envB), expectedRuns);
      assert.equal(resolveManualOwnerReceiptPath('acme/widgets', workspace, { env: envA }), resolveManualOwnerReceiptPath('acme/widgets', workspace, { env: envB }));
      assert.equal(resolveHeartbeatOwnerReceiptPath('acme/widgets', workspace, { env: envA }), resolveHeartbeatOwnerReceiptPath('acme/widgets', workspace, { env: envB }));
      assert.equal(dispatchWakePath(envA), path.join(canonicalHome, '.tachiko-conductor', 'dispatch', 'wake'));
      assert.equal(dispatchWakePath(envB), path.join(canonicalHome, '.tachiko-conductor', 'dispatch', 'wake'));
      assert.equal(existsSync(path.join(alternateHomeA, '.tachiko-conductor')), false);
      assert.equal(existsSync(path.join(alternateHomeB, '.tachiko-conductor')), false);
    } finally {
      os.userInfo = originalUserInfo;
      rmSync(accountHome, { recursive: true, force: true });
      rmSync(alternateHomeA, { recursive: true, force: true });
      rmSync(alternateHomeB, { recursive: true, force: true });
    }
  });

  it('exposes read-only bounded admission status with owning Run/workspace evidence and no capability tokens', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-admission-status-'));
    const workspace = path.join(directory, 'worktree');
    mkdirSync(workspace);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: directory,
      TACHIKO_DATA_DIR: path.join(directory, 'runs'),
      TACHIKO_MISSION_ADMISSION_PATH: path.join(directory, '.tachiko-conductor', 'mission-admission', 'registry.json'),
      TACHIKO_DISPATCH_WAKE_PATH: path.join(directory, 'dispatch', 'wake'),
    };
    try {
      const registry = createHostAdmissionRegistry({ env, homeDirectory: directory });
      const admitted = registry.admit({ laneId: 'status-lane', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 9000, workspace } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') throw new Error('expected status lane admission');
      const liveReview = registry.admit({ laneId: 'live-review', role: 'read_only_review', evidence: { repository: 'acme/widgets', issue: 9001 } });
      assert.equal(liveReview.outcome, 'admitted');
      const parked = registry.admit({ laneId: 'parked-production', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 9002 } });
      assert.equal(parked.outcome, 'parked');
      for (let index = 0; index < 105; index += 1) {
        const historical = registry.admit({
          laneId: `history-${index}`,
          role: 'read_only_review',
          evidence: { repository: 'acme/widgets', issue: 1_000 + index },
        });
        assert.equal(historical.outcome, 'admitted');
        if (historical.outcome === 'admitted') registry.release(historical.token, true);
      }
      const wakeBefore = readFileSync(env.TACHIKO_DISPATCH_WAKE_PATH!, 'utf8');
      const result = runCli(['dispatch', 'admission', 'status'], directory, env);
      assert.equal(result.status, 0, result.stderr);
      const projection = JSON.parse(result.stdout) as { revision: number; counts: { captains: number; parked: number }; lanes: Array<Record<string, unknown>>; omittedLaneCount: number; lanesTruncated: boolean };
      assert.ok(projection.revision > admitted.revision);
      assert.equal(projection.counts.captains, 1);
      assert.equal(projection.counts.parked, 1);
      assert.deepEqual(projection.lanes.slice(0, 3).map((lane) => [lane.laneId, lane.status]), [
        ['status-lane', 'active'], ['live-review', 'active'], ['parked-production', 'parked'],
      ], 'active production ownership, other active lanes, and parked reservations precede released history');
      assert.equal(projection.lanes.length, 100);
      assert.equal(projection.omittedLaneCount, 8);
      assert.equal(projection.lanesTruncated, true);
      assert.equal(JSON.stringify(projection).includes(admitted.token.token), false);
      const owner = projection.lanes.find((lane) => lane.laneId === 'status-lane')!;
      assert.deepEqual(owner.evidence, { repository: 'acme/widgets', issue: 9000, workspace: realpathSync.native(workspace) });
      assert.equal(owner.reason, 'active_owner');
      assert.equal(readFileSync(env.TACHIKO_DISPATCH_WAKE_PATH!, 'utf8'), wakeBefore, 'status is read-only and does not signal dispatch');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('gates direct Run and manual registration against each other before workflow or projection mutation', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-admission-cli-'));
    const runsDirectory = path.join(directory, 'runs');
    const registryPath = path.join(directory, '.tachiko-conductor', 'mission-admission', 'registry.json');
    const cliConfig: AdmissionConfig = { schemaVersion: 1, revision: 'cli-test-v1', limits: { maxCaptains: 3, maxWriters: 2, maxHighAutonomy: 3 } };
    const registry = new MissionAdmissionRegistry({ filePath: registryPath, config: cliConfig });
    const receipts = path.join(directory, 'private-receipts');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, TACHIKO_DATA_DIR: runsDirectory, TACHIKO_MANUAL_OWNER_RECEIPTS_DIR: receipts, TACHIKO_MISSION_ADMISSION_PATH: registryPath, TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify(cliConfig) };
    try {
      const store = new JsonFileStore({ dir: runsDirectory });
      store.create(createRun(TARGET, T0, 'direct-run'));
      const broad = registry.admit({ laneId: 'manual-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', repositoryScope: true } });
      assert.equal(broad.outcome, 'admitted');
      const before = readFileSync(path.join(runsDirectory, 'direct-run.json'), 'utf8');
      const direct = runCli(['run', 'acme/widgets#42'], ROOT, env);
      assert.notEqual(direct.status, 0);
      assert.match(direct.stderr, /cannot enter mission admission/);
      assert.equal(readFileSync(path.join(runsDirectory, 'direct-run.json'), 'utf8'), before);

      if (broad.outcome !== 'admitted') return;
      registry.release(broad.token, true);
      const issueOwner = registry.admit({ laneId: 'issue-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 55 } });
      assert.equal(issueOwner.outcome, 'admitted');
      const workspace = path.join(directory, 'manual-worktree');
      mkdirSync(workspace);
      git(workspace, 'init', '-q', '--initial-branch=main');
      git(workspace, 'config', 'user.email', 'captain@example.invalid');
      git(workspace, 'config', 'user.name', 'Captain Test');
      writeFileSync(path.join(workspace, 'tracked.txt'), 'checkpoint\n');
      git(workspace, 'add', 'tracked.txt');
      git(workspace, 'commit', '-q', '-m', 'checkpoint');
      git(workspace, 'remote', 'add', 'origin', 'git@github.com:Acme/Widgets.git');
      const manual = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.notEqual(manual.status, 0);
      assert.match(manual.stderr, /overlaps active or parked lane/);
      assert.equal(existsSync(path.join(runsDirectory, '.operational', 'v1', 'runtime.json')), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed when multiple active Runs match a direct target', () => {
    const { directory } = fixture();
    try {
      const store = new JsonFileStore({ dir: path.join(directory, 'runs') });
      store.create(createRun(TARGET, T0, 'ambiguous-a'));
      store.create(createRun(TARGET, T0, 'ambiguous-b'));
      assert.throws(() => findRunByTarget(store, TARGET), /Multiple active durable Runs overlap/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('normalizes only unambiguous GitHub remotes for manual ownership', () => {
    assert.equal(parseGitHubRepositoryRemote('git@github.com:Acme/Widgets.git'), 'acme/widgets');
    assert.equal(parseGitHubRepositoryRemote('https://github.com/Acme/Widgets.git/'), 'acme/widgets');
    assert.equal(parseGitHubRepositoryRemote('ssh://git@github.com/Acme/Widgets.git'), 'acme/widgets');
    assert.throws(() => parseGitHubRepositoryRemote('https://example.com/acme/widgets.git'), /GitHub HTTPS or SSH/);
    assert.throws(() => parseGitHubRepositoryRemote('https://user@github.com/acme/widgets.git'), /direct GitHub/);
  });

  it('updates manual projection only after a successful registry park with explicit stop proof', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-manual-cli-'));
    const workspace = path.join(directory, 'worktree');
    const runsDirectory = path.join(directory, 'runs');
    const registryPath = path.join(directory, '.tachiko-conductor', 'mission-admission', 'registry.json');
    const receipts = path.join(directory, 'private-receipts');
    const cliConfig: AdmissionConfig = { schemaVersion: 1, revision: 'manual-cli-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2 } };
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, TACHIKO_DATA_DIR: runsDirectory, TACHIKO_MANUAL_OWNER_RECEIPTS_DIR: receipts, TACHIKO_MISSION_ADMISSION_PATH: registryPath, TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify(cliConfig) };
    try {
      mkdirSync(workspace);
      git(workspace, 'init', '-q', '--initial-branch=main');
      git(workspace, 'config', 'user.email', 'captain@example.invalid');
      git(workspace, 'config', 'user.name', 'Captain Test');
      writeFileSync(path.join(workspace, 'tracked.txt'), 'checkpoint\n');
      git(workspace, 'add', 'tracked.txt');
      git(workspace, 'commit', '-q', '-m', 'checkpoint');
      git(workspace, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git/');

      const registered = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.equal(registered.status, 0, registered.stderr);
      const registration = JSON.parse(registered.stdout) as { ownerReceiptPath: string };
      assert.equal(registration.ownerReceiptPath, path.join(realpathSync(receipts), `${createHashForTest('acme/widgets', workspace)}.json`));
      const receipt = JSON.parse(readFileSync(registration.ownerReceiptPath, 'utf8')) as { generation: number; token: { token: string } };
      assert.equal(typeof receipt.token.token, 'string');
      assert.equal(statSync(registration.ownerReceiptPath).mode & 0o777, 0o600);
      assert.doesNotMatch(registered.stdout, new RegExp(receipt.token.token));
      const projectionPath = path.join(runsDirectory, '.operational', 'v1', 'runtime.json');
      const activeProjection = JSON.parse(readFileSync(projectionPath, 'utf8')) as { manualLane: { state: string; laneId?: string; admissionRevision?: number }; ownership: string };
      assert.equal(activeProjection.manualLane.state, 'active');
      assert.equal(activeProjection.ownership, 'active');
      assert.equal(typeof activeProjection.manualLane.laneId, 'string');
      assert.doesNotMatch(readFileSync(projectionPath, 'utf8'), new RegExp(receipt.token.token));
      const duplicateRegister = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.notEqual(duplicateRegister.status, 0);
      assert.match(duplicateRegister.stderr, /already has active ownership/);
      const parked = runCli(['dispatch', 'manual', 'park', '--stopped'], workspace, env);
      assert.equal(parked.status, 0, parked.stderr);
      const parkedProjection = JSON.parse(readFileSync(projectionPath, 'utf8')) as { manualLane: { state: string; admissionRevision?: number }; ownership: string; checkpoint: string };
      assert.equal(parkedProjection.manualLane.state, 'parked');
      assert.equal(parkedProjection.ownership, 'none');
      assert.equal(parkedProjection.checkpoint, 'durable');
      assert.ok((parkedProjection.manualLane.admissionRevision ?? 0) > (activeProjection.manualLane.admissionRevision ?? 0));
      const parkedResult = JSON.parse(parked.stdout) as { parkedGeneration: number };
      assert.equal(parkedResult.parkedGeneration, receipt.generation + 1);
      const admissionRegistry = new MissionAdmissionRegistry({ filePath: registryPath, config: cliConfig });
      const parkedReceiptBytes = readFileSync(registration.ownerReceiptPath, 'utf8');
      const beforeBlockedRegister = admissionRegistry.snapshot();
      const blockedRegister = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.notEqual(blockedRegister.status, 0);
      assert.match(blockedRegister.stderr, /retire its exact clean checkpoint/);
      assert.equal(readFileSync(registration.ownerReceiptPath, 'utf8'), parkedReceiptBytes);
      const afterBlockedRegister = admissionRegistry.snapshot();
      assert.equal(afterBlockedRegister.revision, beforeBlockedRegister.revision);
      const stillParked = afterBlockedRegister.lanes.find((lane) => lane.laneId === JSON.parse(parkedReceiptBytes).laneId);
      assert.equal(stillParked?.status, 'parked');
      assert.equal(stillParked?.generation, parkedResult.parkedGeneration);
      assert.throws(() => admissionRegistry.assertCanMutate({ laneId: JSON.parse(readFileSync(registration.ownerReceiptPath, 'utf8')).laneId, generation: receipt.generation, token: receipt.token.token }), /stale|no longer/);
      const staleRetire = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(receipt.generation)], workspace, env);
      assert.notEqual(staleRetire.status, 0);
      const parkedProjectionBytes = readFileSync(projectionPath, 'utf8');
      rmSync(projectionPath);
      mkdirSync(projectionPath);
      const projectionFailure = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(parkedResult.parkedGeneration)], workspace, env);
      assert.notEqual(projectionFailure.status, 0);
      assert.match(projectionFailure.stderr, /retired in the registry, but its parked projection could not be cleared/);
      const releasedDespiteProjectionFailure = admissionRegistry.readLane(JSON.parse(parkedReceiptBytes).laneId);
      assert.equal(releasedDespiteProjectionFailure?.status, 'released', 'registry retirement is authoritative even when projection cleanup fails');
      rmSync(projectionPath, { recursive: true, force: true });
      writeFileSync(projectionPath, parkedProjectionBytes);
      const retired = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(parkedResult.parkedGeneration)], workspace, env);
      assert.equal(retired.status, 0, retired.stderr);
      assert.equal(JSON.parse(readFileSync(projectionPath, 'utf8')).manualLane, undefined, 'exact-generation retry clears only the matching parked projection');
      assert.equal(existsSync(registration.ownerReceiptPath), true, 'retirement retains a private generation tombstone');
      const released = admissionRegistry.readLane(JSON.parse(readFileSync(path.join(registryPath), 'utf8')).lanes[0].laneId);
      assert.equal(released?.status, 'released');
      const reRegistered = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.equal(reRegistered.status, 0, reRegistered.stderr);
      const activeAgain = JSON.parse(readFileSync(projectionPath, 'utf8')) as { manualLane: { state: string; admissionRevision?: number }; ownership: string };
      assert.equal(activeAgain.manualLane.state, 'active');
      assert.equal(activeAgain.ownership, 'active');
      const staleRetireAfterSuccessor = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(parkedResult.parkedGeneration)], workspace, env);
      assert.notEqual(staleRetireAfterSuccessor.status, 0);
      const successorProjection = JSON.parse(readFileSync(projectionPath, 'utf8')) as { manualLane: { state: string }; ownership: string };
      assert.equal(successorProjection.manualLane.state, 'active');
      assert.equal(successorProjection.ownership, 'active');
      const successorPark = runCli(['dispatch', 'manual', 'park', '--stopped'], workspace, env);
      assert.equal(successorPark.status, 0, successorPark.stderr);
      const successorParkGeneration = JSON.parse(successorPark.stdout) as { parkedGeneration: number };
      const successorRetire = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(successorParkGeneration.parkedGeneration)], workspace, env);
      assert.equal(successorRetire.status, 0, successorRetire.stderr);
      const afterRetire = admissionRegistry.admit({ laneId: 'manual-retire-capacity-check', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 404 } });
      assert.equal(afterRetire.outcome, 'admitted');
      const secondOwner = admissionRegistry.admit({ laneId: 'manual-retire-capacity-check-2', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 405 } });
      assert.equal(secondOwner.outcome, 'parked', 'the retired manual mission freed exactly one writer slot');
      const capacityOverflow = admissionRegistry.admit({ laneId: 'manual-retire-capacity-check-3', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 406 } });
      assert.equal(capacityOverflow.outcome, 'parked');
      const duplicateRetire = runCli(['dispatch', 'manual', 'retire', '--stopped', '--expected-generation', String(parkedResult.parkedGeneration)], workspace, env);
      assert.notEqual(duplicateRetire.status, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains manual ownership when projection publication fails and blocks a competitor', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-manual-projection-failure-'));
    const workspace = path.join(directory, 'worktree');
    const runsPath = path.join(directory, 'runs');
    const registryPath = path.join(directory, '.tachiko-conductor', 'mission-admission', 'registry.json');
    const cliConfig: AdmissionConfig = { schemaVersion: 1, revision: 'manual-projection-failure-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2 } };
    const receipts = path.join(directory, 'private-receipts');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, TACHIKO_DATA_DIR: runsPath, TACHIKO_MANUAL_OWNER_RECEIPTS_DIR: receipts, TACHIKO_MISSION_ADMISSION_PATH: registryPath, TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify(cliConfig) };
    const registry = new MissionAdmissionRegistry({ filePath: registryPath, config: cliConfig });
    try {
      mkdirSync(runsPath);
      writeFileSync(path.join(runsPath, '.operational'), 'block projection directory creation');
      mkdirSync(workspace);
      git(workspace, 'init', '-q', '--initial-branch=main');
      git(workspace, 'config', 'user.email', 'captain@example.invalid');
      git(workspace, 'config', 'user.name', 'Captain Test');
      writeFileSync(path.join(workspace, 'tracked.txt'), 'checkpoint\n');
      git(workspace, 'add', 'tracked.txt');
      git(workspace, 'commit', '-q', '-m', 'checkpoint');
      git(workspace, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git');

      const failed = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.notEqual(failed.status, 0);
      const laneId = /Manual lane (manual:[a-f0-9]+) generation (\d+) has a private owner receipt/.exec(failed.stderr)?.[1];
      assert.ok(laneId, failed.stderr);
      assert.equal(registry.readLane(laneId!)?.status, 'active');
      assert.match(failed.stderr, /private owner receipt at .*projection publication failed/);
      const receiptPath = path.join(realpathSync(receipts), `${createHashForTest('acme/widgets', workspace)}.json`);
      assert.equal(existsSync(receiptPath), true);

      const competitor = registry.admit({ laneId: 'competitor-after-projection-failure', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 401 } });
      assert.equal(competitor.outcome, 'duplicate');
      if (competitor.outcome === 'duplicate') assert.equal(competitor.conflictingLaneId, laneId);
      rmSync(path.join(runsPath, '.operational'), { recursive: true, force: true });
      const parked = runCli(['dispatch', 'manual', 'park', '--stopped'], workspace, env);
      assert.equal(parked.status, 0, parked.stderr);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails manual admission closed when prepublication private receipt writing fails, without exposing a token', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-manual-receipt-failure-'));
    const workspace = path.join(directory, 'worktree');
    const runs = path.join(directory, 'runs');
    const receipts = path.join(directory, 'receipt-blocker');
    const registryPath = path.join(directory, '.tachiko-conductor', 'mission-admission', 'registry.json');
    const cliConfig: AdmissionConfig = { schemaVersion: 1, revision: 'manual-recovery-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 2 } };
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, TACHIKO_DATA_DIR: runs, TACHIKO_MANUAL_OWNER_RECEIPTS_DIR: receipts, TACHIKO_MISSION_ADMISSION_PATH: registryPath, TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify(cliConfig) };
    try {
      mkdirSync(workspace);
      git(workspace, 'init', '-q', '--initial-branch=main'); git(workspace, 'config', 'user.email', 'captain@example.invalid'); git(workspace, 'config', 'user.name', 'Captain Test');
      writeFileSync(path.join(workspace, 'tracked.txt'), 'checkpoint\n'); git(workspace, 'add', 'tracked.txt'); git(workspace, 'commit', '-q', '-m', 'checkpoint');
      git(workspace, 'remote', 'add', 'origin', 'https://github.com/Acme/Widgets.git');
      writeFileSync(receipts, 'block receipt directory creation');
      const failed = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.notEqual(failed.status, 0);
      assert.equal(failed.stdout, '');
      assert.match(failed.stderr, /receipt could not be durably published before admission/);
      assert.doesNotMatch(failed.stdout + failed.stderr, /"token"\s*:/);
      const registry = new MissionAdmissionRegistry({ filePath: registryPath, config: cliConfig });
      assert.equal(registry.snapshot().counts.captains, 0, 'receipt failure happens before registry publication');
      rmSync(receipts); mkdirSync(receipts);
      const retried = runCli(['dispatch', 'manual', 'register'], workspace, env);
      assert.equal(retried.status, 0, retried.stderr);
      const receiptPath = path.join(realpathSync(receipts), `${createHashForTest('acme/widgets', workspace)}.json`);
      const receipt = readManualOwnerReceipt(receiptPath);
      assert.ok(receipt?.token);
      assert.equal((statSync(receiptPath).mode & 0o777), 0o600);
      assert.equal(registry.snapshot().counts.captains, 1);
      assert.doesNotMatch(retried.stdout, new RegExp(receipt!.token!.token));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
