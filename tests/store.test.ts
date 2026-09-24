import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { applyTransition } from '../src/domain/state-machine.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { ensureDurableDirectory, syncDirectory } from '../src/durable-directory.js';
import { OPERATIONAL_RUN_PROJECTION_VERSION, operationalProjectionPath, operationalRunProjection, sha256 } from '../src/operational/projection.js';
import { T0, TARGET, newRun, successResult, validationPassed } from './helpers.js';

const tmpDirs: string[] = [];
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function waitForFile(filePath: string, timeoutMs = 5_000): void {
  const deadlineAt = Date.now() + timeoutMs;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!existsSync(filePath)) {
    if (Date.now() >= deadlineAt) throw new Error(`Timed out waiting for child-process marker ${filePath}`);
    Atomics.wait(cell, 0, 0, 10);
  }
}


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
  it('normalizes a legacy persisted bootstrap to linked-worktree after restart', () => {
    const { dir } = tempStore();
    const legacy = { ...newRun('legacy-bootstrap'), bootstrap: {
      owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
      baseBranch: 'main', baseSha: 'a'.repeat(40), branch: 'legacy', workspacePath: '/tmp/legacy-workspace',
    } };
    writeFileSync(path.join(dir, 'legacy-bootstrap.json'), JSON.stringify(legacy), 'utf8');
    const restarted = new JsonFileStore({ dir }).read('legacy-bootstrap');
    assert.equal(restarted?.bootstrap?.bootstrapKind, 'linked-worktree');
  });
  it('persists a created run and reads it back intact', () => {
    const { store } = tempStore();
    store.create(newRun('r1'));
    assert.deepEqual(store.read('r1'), newRun('r1'));
  });

  it('syncs Run files before rename and reports uncertain parent-sync failures without rolling back visible bytes', () => {
    const { dir } = tempStore();
    const initial = newRun('durability-run');
    new JsonFileStore({ dir }).create(initial);
    const filePath = path.join(dir, `${initial.id}.json`);
    const originalBytes = readFileSync(filePath, 'utf8');
    const next = applyTransition(initial, { type: 'start' }, T0);

    const preRenameFailure = new JsonFileStore({ dir, syncForDurability: (_fd, target) => {
      if (target === 'file') throw new Error('injected Run file sync failure');
    } });
    assert.throws(() => preRenameFailure.update(next), /Run file sync failure/);
    assert.equal(readFileSync(filePath, 'utf8'), originalBytes, 'pre-rename failure preserves destination bytes');
    assert.equal(readdirSync(dir).some((name) => name.startsWith(`${initial.id}.json.`) && name.endsWith('.tmp')), false, 'pre-rename failure removes only the attempt temp');

    const postRenameFailure = new JsonFileStore({ dir, syncForDurability: (_fd, target) => {
      if (target === 'directory') throw new Error('injected Run parent sync failure');
    } });
    assert.throws(() => postRenameFailure.update(next), /Run parent sync failure/);
    const durableNext = new JsonFileStore({ dir }).read(initial.id);
    assert.equal(durableNext?.state, next.state, 'post-rename failure preserves the visible committed candidate');
    assert.equal(durableNext?.history.at(-1)?.type, 'start');
    const projection = JSON.parse(readFileSync(operationalProjectionPath(dir, initial.id), 'utf8')) as { sourceDigest: string };
    assert.equal(projection.sourceDigest, sha256(originalBytes), 'projection remains at the last confirmed durable Run write');

    if (durableNext === null) throw new Error('expected durable Run after rename');
    const casNext = { ...durableNext, updatedAt: '2026-09-24T00:00:01.000Z' };
    assert.throws(() => postRenameFailure.updateIfUnchanged(durableNext, casNext), /Run parent sync failure/);
    assert.equal(new JsonFileStore({ dir }).read(initial.id)?.updatedAt, casNext.updatedAt, 'CAS durability uncertainty is thrown, never reported as mismatch');
  });

  it('does not admit or project a Run when create file sync fails, and preserves unrelated temp files', () => {
    const { dir } = tempStore();
    const run = newRun('create-sync-failure');
    const unrelatedTemp = path.join(dir, `${run.id}.json.other-attempt.tmp`);
    writeFileSync(unrelatedTemp, 'preserve this unrelated temp');
    const store = new JsonFileStore({ dir, syncForDurability: (_fd, target) => {
      if (target === 'file') throw new Error('injected create file sync failure');
    } });

    assert.throws(() => store.create(run), /create file sync failure/);
    assert.equal(existsSync(path.join(dir, `${run.id}.json`)), false, 'failed pre-admission create leaves no Run destination');
    assert.equal(existsSync(operationalProjectionPath(dir, run.id)), false, 'failed pre-admission create emits no projection');
    assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith(`${run.id}.json.`) && name.endsWith('.tmp')), [path.basename(unrelatedTemp)]);
  });

  it('does not make a fresh Run store available until each visible hierarchy edge can be synced', () => {
    const { dir } = tempStore();
    const runsDir = path.join(dir, 'runs', 'nested');
    const failedParent = path.join(dir, 'runs');
    const observedParents: string[] = [];
    let fail = true;
    const syncHierarchy = (parent: string) => {
      observedParents.push(parent);
      if (fail && parent === failedParent) throw new Error('injected Run hierarchy sync failure');
      syncDirectory(parent);
    };

    assert.throws(() => new JsonFileStore({ dir: runsDir, syncDirectoryHierarchy: syncHierarchy }), /Run hierarchy sync failure/);
    assert.equal(existsSync(runsDir), true, 'created directories remain visible after uncertain parent sync');
    assert.equal(existsSync(path.join(runsDir, 'run.json')), false);
    assert.equal(observedParents.at(-1), failedParent);

    observedParents.length = 0;
    assert.throws(() => new JsonFileStore({ dir: runsDir, syncDirectoryHierarchy: syncHierarchy }), /Run hierarchy sync failure/);
    assert.equal(observedParents.at(-1), failedParent, 'retry re-syncs the parent even though the child is already visible');

    fail = false;
    const store = new JsonFileStore({ dir: runsDir, syncDirectoryHierarchy: syncHierarchy });
    store.create(newRun('durable-tree-run'));
    assert.equal(store.read('durable-tree-run')?.id, 'durable-tree-run');
  });

  it('validates store options before hierarchy creation and rejects regular-file path components before Run publication', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-hierarchy-shape-'));
    tmpDirs.push(directory);
    const invalidOptionsDir = path.join(directory, 'invalid-options', 'runs');
    let hierarchySyncs = 0;
    assert.throws(() => new JsonFileStore({
      dir: invalidOptionsDir,
      mutationLockTimeoutMs: -1,
      syncDirectoryHierarchy: () => { hierarchySyncs += 1; },
    }), /mutationLockTimeoutMs/);
    assert.equal(existsSync(path.dirname(invalidOptionsDir)), false, 'invalid options do not create a partial hierarchy');
    assert.equal(hierarchySyncs, 0, 'invalid options do not sync hierarchy edges');

    const blocker = path.join(directory, 'regular-file');
    writeFileSync(blocker, 'preserve this file');
    const blockedDir = path.join(blocker, 'nested-runs');
    const run = newRun('blocked-hierarchy-run');
    assert.throws(() => new JsonFileStore({ dir: blockedDir }));
    assert.equal(readFileSync(blocker, 'utf8'), 'preserve this file', 'the existing regular file is preserved');
    assert.equal(existsSync(path.join(blockedDir, `${run.id}.json`)), false, 'no Run destination is published');
    assert.equal(existsSync(operationalProjectionPath(blockedDir, run.id)), false, 'no operational projection is published');
  });

  it('syncs the containing parent in order for every absolute directory component', () => {
    const { dir } = tempStore();
    const target = path.join(dir, 'outer', 'middle', 'leaf');
    const parents: string[] = [];
    const root = path.parse(target).root;
    let componentPath = root;
    const expectedParents = target.slice(root.length).split(path.sep).filter(Boolean).map((component) => {
      const parent = componentPath;
      componentPath = path.join(componentPath, component);
      return parent;
    });
    ensureDurableDirectory(target, { syncDirectoryHierarchy: (parent) => { parents.push(parent); syncDirectory(parent); } });
    assert.deepEqual(parents, expectedParents);
  });

  it('writes a secret-free operational projection bound to the committed raw bytes', () => {
    const { store, dir } = tempStore();
    let run = applyTransition(newRun('projected'), { type: 'start' }, T0);
    run = applyTransition(run, {
      type: 'bootstrap_prepared',
      bootstrap: {
        bootstrapKind: 'linked-worktree',
        owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
        baseBranch: 'main', baseSha: 'base-sha', branch: 'codex/projected', workspacePath: '/tmp/projected',
      },
    }, T0);
    run = applyTransition(run, {
      type: 'agent_succeeded',
      agentResult: { ...successResult('head-sha'), executor: { provider: 'codex-cli', sessionId: 'secret-session' } },
      pullRequest: { number: 7, headSha: 'head-sha' },
    }, T0);
    store.create(run);

    const raw = readFileSync(path.join(dir, 'projected.json'), 'utf8');
    const projection = JSON.parse(readFileSync(operationalProjectionPath(dir, 'projected'), 'utf8')) as Record<string, unknown>;
    assert.equal(projection.schemaVersion, OPERATIONAL_RUN_PROJECTION_VERSION);
    assert.equal(projection.sourceDigest, sha256(raw));
    assert.equal(projection.workflowState, 'VALIDATING');
    assert.deepEqual(projection.target, { owner: 'acme', repo: 'widgets', issueNumber: 42 });
    assert.deepEqual(projection.bootstrap, { workspacePath: '/tmp/projected', branch: 'codex/projected', baseBranch: 'main', baseSha: 'base-sha' });
    assert.deepEqual(projection.executor, { provider: 'codex-cli' });
    assert.equal(JSON.stringify(projection).includes('secret-session'), false);
  });

  it('marks only an active review-repair implementation for bounded live-head correlation', () => {
    const run = {
      ...newRun('review-fix-projection'),
      state: 'IMPLEMENTING' as const,
      history: [{ type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0 }],
    };
    assert.equal(operationalRunProjection(run, '{}').reviewFixActive, true);
    assert.equal(operationalRunProjection(newRun('not-a-review-fix'), '{}').reviewFixActive, undefined);
  });

  it('projects the selected provider and profile before an agent session exists', () => {
    const run = {
      ...newRun('initial-execution-projection'),
      state: 'IMPLEMENTING' as const,
      execution: { profile: 'standard' as const, revision: 'profiles-v1', executor: 'claude-code', timeoutMs: 1_000 },
    };

    assert.deepEqual(operationalRunProjection(run, '{}').executor, { provider: 'claude-code', profile: 'standard' });
  });

  it('retains the active review-repair marker after a parked repair resumes', () => {
    const run = {
      ...newRun('resumed-review-fix-projection'),
      state: 'IMPLEMENTING' as const,
      history: [
        { type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0 },
        { type: 'escalate' as const, from: 'IMPLEMENTING' as const, to: 'NEEDS_HUMAN' as const, at: T0 },
        { type: 'human_resolved' as const, from: 'NEEDS_HUMAN' as const, to: 'IMPLEMENTING' as const, at: T0 },
      ],
    };

    assert.equal(operationalRunProjection(run, '{}').reviewFixActive, true);
  });

  it('keeps a committed raw transition successful when derived projection emission fails', () => {
    const { store, dir } = tempStore();
    let run = newRun('projection-best-effort');
    store.create(run);
    rmSync(path.join(dir, '.operational'), { recursive: true, force: true });
    writeFileSync(path.join(dir, '.operational'), 'not a directory', 'utf8');

    run = applyTransition(run, { type: 'start' }, T0);
    assert.doesNotThrow(() => store.update(run));
    assert.equal(new JsonFileStore({ dir }).read(run.id)?.state, 'IMPLEMENTING');
    assert.throws(() => readFileSync(operationalProjectionPath(dir, run.id), 'utf8'));

    rmSync(path.join(dir, '.operational'), { force: true });
    assert.equal(store.rebuildOperationalProjections(), 1);
    assert.equal(
      JSON.parse(readFileSync(operationalProjectionPath(dir, run.id), 'utf8')).workflowState,
      'IMPLEMENTING',
    );
  });

  it('rebuilds valid legacy projections and removes a projection with its run', () => {
    const { store, dir } = tempStore();
    const run = newRun('legacy-projection');
    writeFileSync(path.join(dir, 'legacy-projection.json'), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    assert.equal(store.rebuildOperationalProjections(), 1);
    assert.deepEqual(JSON.parse(readFileSync(operationalProjectionPath(dir, run.id), 'utf8')) as Record<string, unknown>, {
      schemaVersion: 1,
      runId: run.id,
      sourceUpdatedAt: T0,
      sourceDigest: sha256(readFileSync(path.join(dir, 'legacy-projection.json'), 'utf8')),
      target: { owner: 'acme', repo: 'widgets', issueNumber: 42 },
      workflowState: 'READY',
      createdAt: T0,
    });
    store.delete(run.id);
    assert.throws(() => readFileSync(operationalProjectionPath(dir, run.id), 'utf8'));
  });

  it('deletes the authoritative run when derived projection cleanup fails', () => {
    const { store, dir } = tempStore();
    const run = newRun('projection-delete-best-effort');
    store.create(run);
    rmSync(operationalProjectionPath(dir, run.id));
    mkdirSync(operationalProjectionPath(dir, run.id));

    assert.doesNotThrow(() => store.delete(run.id));
    assert.equal(store.read(run.id), null);
    assert.equal(readdirSync(operationalProjectionPath(dir, run.id)).length, 0);
  });

  it('serializes a cross-process workflow update with CAS across the compare/write window', () => {
    const { dir } = tempStore();
    const initial = newRun('cas-race');
    new JsonFileStore({ dir }).create(initial);

    const readyPath = path.join(dir, 'workflow-writer-ready');
    const donePath = path.join(dir, 'workflow-writer-done');
    const childPath = path.join(dir, 'workflow-writer.mjs');
    const storeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'json-file-store.ts')).href;
    writeFileSync(childPath, [
      `import { writeFileSync } from 'node:fs';`,
      `import { JsonFileStore } from ${JSON.stringify(storeUrl)};`,
      `const [dir, readyPath, donePath] = process.argv.slice(2);`,
      `const store = new JsonFileStore({ dir, mutationLockTimeoutMs: 5000 });`,
      `const current = store.read('cas-race');`,
      `if (current === null) throw new Error('missing run');`,
      `const at = '2026-09-19T00:00:02.000Z';`,
      `const transitioned = { ...current, state: 'IMPLEMENTING', updatedAt: at, history: [...current.history, { type: 'start', from: 'READY', to: 'IMPLEMENTING', at }] };`,
      `writeFileSync(readyPath, 'ready');`,
      `store.update(transitioned);`,
      `writeFileSync(donePath, 'done');`,
    ].join('\n'), 'utf8');

    let childStarted = false;
    const waitWriter = new JsonFileStore({
      dir,
      beforeConditionalWrite: () => {
        const child = spawn(process.execPath, [TSX_CLI, childPath, dir, readyPath, donePath], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        child.unref();
        waitForFile(readyPath);
        // The child has read the same pre-CAS snapshot and is now about to
        // enter ordinary update(). It cannot pass the shared mutation fence
        // until this compare+write critical section ends.
        childStarted = true;
        assert.equal(existsSync(donePath), false);
      },
    });

    const staleTelemetryLikeWrite = { ...initial, updatedAt: '2026-09-19T00:00:01.000Z' };
    assert.equal(waitWriter.updateIfUnchanged(initial, staleTelemetryLikeWrite), true);
    assert.equal(childStarted, true);

    // Once CAS releases the fence, the already-started workflow process writes
    // its transition. The final durable Run must retain that newer transition,
    // never the stale READY snapshot from the wait writer.
    waitForFile(donePath);
    const finalRun = new JsonFileStore({ dir }).read(initial.id);
    assert.equal(finalRun?.state, 'IMPLEMENTING');
    assert.equal(finalRun?.history.at(-1)?.type, 'start');

    // The inverse ordering is also safe: if a workflow transition lands before
    // CAS acquires the fence, the stale expected fingerprint is rejected.
    const expected = staleTelemetryLikeWrite;
    assert.equal(waitWriter.updateIfUnchanged(expected, { ...expected, headSha: 'stale-head' }), false);
    assert.equal(new JsonFileStore({ dir }).read(initial.id)?.state, 'IMPLEMENTING');
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

  it('persists the selected profile and resolved non-secret execution snapshot across restart', () => {
    const { dir } = tempStore();
    const execution = {
      profile: 'standard' as const, revision: 'profiles-v1', executor: 'codex-cli', model: 'configured-model',
      reasoningEffort: 'medium' as const, timeoutMs: 125_000, sandboxMode: 'workspace-write' as const, approvalPolicy: 'on-request' as const,
    };
    const first = new JsonFileStore({ dir });
    first.create({ ...newRun('profile-run'), execution });

    assert.deepEqual(new JsonFileStore({ dir }).read('profile-run')?.execution, execution);
  });

  it('persists a non-empty dispatch claim identity across restart', () => {
    const { dir } = tempStore();
    new JsonFileStore({ dir }).create({ ...newRun('dispatch-run'), dispatchClaimId: 'claim-1' });
    assert.equal(new JsonFileStore({ dir }).read('dispatch-run')?.dispatchClaimId, 'claim-1');
    writeFileSync(path.join(dir, 'blank-claim.json'), JSON.stringify({ ...newRun('blank-claim'), dispatchClaimId: '  ' }), 'utf8');
    assert.throws(() => new JsonFileStore({ dir }).read('blank-claim'), /corrupt or incompatible/);
  });

  it('rejects a persisted execution snapshot whose timeout exceeds the process runner limit', () => {
    const { store, dir } = tempStore();
    writeFileSync(
      path.join(dir, 'bad-timeout.json'),
      JSON.stringify({
        ...newRun('bad-timeout'),
        execution: { profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 2_147_483_648 },
      }),
      'utf8',
    );
    assert.throws(() => store.read('bad-timeout'), /corrupt or incompatible/);
  });

  it('round-trips compact exact-HEAD validation provenance through a fresh store instance', () => {
    const { dir } = tempStore();
    const first = new JsonFileStore({ dir });
    let run = applyTransition(newRun('validation-ledger'), { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('sha-validation') }, T0);
    run = applyTransition(
      run,
      { type: 'validation_passed', validationResult: validationPassed('sha-validation'), pullRequest: { number: 7, headSha: 'sha-validation' } },
      T0,
    );
    first.create(run);

    const loaded = new JsonFileStore({ dir }).read('validation-ledger');
    assert.equal(loaded?.validationResult?.headSha, 'sha-validation');
    assert.equal(loaded?.validationResult?.status, 'passed');
    assert.equal(loaded?.validationResult?.hosted.overall, 'passing');
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
    assert.deepEqual(readdirSync(dir), ['.operational', 'r1.json']);
    assert.deepEqual(readdirSync(path.join(dir, '.operational')), ['v1']);
    assert.deepEqual(readdirSync(path.join(dir, '.operational', 'v1')), ['r1.json']);
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
      { ...newRun('bad'), telemetry: null },
      { ...newRun('bad'), telemetry: { revision: 'run-efficiency-v1', thresholds: {}, events: [null] } },
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
