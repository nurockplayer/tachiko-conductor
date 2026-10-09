import assert from 'node:assert/strict';
import { chmodSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import { applyTransition } from '../src/domain/state-machine.js';
import { isValidationResultCoherent } from '../src/domain/validation.js';
import { InMemoryToolOutputStore, TOOL_OUTPUT_POLICY_MAXIMA, boundToolOutput, isToolOutputEnvelope } from '../src/evidence/tool-output.js';
import type { Run } from '../src/domain/types.js';
import { createRepairAdmissionSnapshot, createRepairAttemptBinding } from '../src/domain/repair-admission.js';
import { isCurrentAccountPathApplicable } from '../src/account-home.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { ensureDurableDirectory, syncDirectory } from '../src/durable-directory.js';
import { OPERATIONAL_RUN_PROJECTION_VERSION, operationalProjectionPath, operationalRunProjection, sha256 } from '../src/operational/projection.js';
import { T0, TARGET, TEST_VALIDATION_AUTHORITY, changesRequested, newRun, successResult, validationFailed, validationPassed } from './helpers.js';

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

function reverseObjectKeyOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (typeof value !== 'object' || value === null) return value;
  const reversed = Object.fromEntries(Object.keys(value).sort().reverse().map((key) => [key, reverseObjectKeyOrder((value as Record<string, unknown>)[key])]));
  return reversed;
}

function casFixture(id: string): Run {
  const run = {
    ...newRun(id),
    state: 'NEEDS_HUMAN' as const,
    interruptedFrom: 'REVIEWING' as const,
  };
  Object.defineProperty(run, 'futureUnknown', {
    configurable: true,
    enumerable: true,
    value: { metadata: { second: 2, first: 1 }, ordered: ['first', 'second'] },
    writable: true,
  });
  Object.defineProperty(run, '__proto__', {
    configurable: true,
    enumerable: true,
    value: { readerAcceptedFutureField: true },
    writable: true,
  });
  return run as Run;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('JsonFileStore — persistence round-trips', () => {
  it('rejects an external alias to canonical storage during store construction without creating through it', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-account-alias-'));
    tmpDirs.push(home);
    const runs = path.join(home, '.tachiko-conductor', 'runs');
    mkdirSync(runs, { recursive: true, mode: 0o755 });
    chmodSync(home, 0o700);
    chmodSync(path.join(home, '.tachiko-conductor'), 0o755);
    chmodSync(runs, 0o755);
    const alias = path.join(home, 'external-runs-alias');
    symlinkSync(runs, alias, 'dir');
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      assert.throws(() => new JsonFileStore({ dir: alias }), /canonical account-home spelling/);
      assert.equal(readdirSync(runs).length, 0, 'constructor rejection creates no files through the alias');
      assert.equal(statSync(runs).mode & 0o777, 0o755);
    } finally {
      os.userInfo = originalUserInfo;
    }
  });

  it('keeps independent temp stores usable and rejects one retargeted into canonical storage', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-retarget-home-'));
    const externalRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-independent-temp-'));
    tmpDirs.push(home, externalRoot);
    const runs = path.join(home, '.tachiko-conductor', 'runs');
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const canonical = new JsonFileStore({ dir: runs });
      const protectedRun = newRun('canonical-retarget-protected');
      canonical.create(protectedRun);
      const protectedBytes = readFileSync(path.join(runs, `${protectedRun.id}.json`), 'utf8');

      const external = path.join(externalRoot, 'runs');
      mkdirSync(external, { mode: 0o700 });
      const independent = new JsonFileStore({ dir: external });
      const independentRun = newRun('independent-temp-run');
      independent.create(independentRun);
      assert.equal(isCurrentAccountPathApplicable(external), false, 'ordinary platform temp storage remains independent');
      assert.deepEqual(independent.read(independentRun.id), independentRun);

      const preservedExternal = path.join(externalRoot, 'preserved-independent-runs');
      renameSync(external, preservedExternal);
      symlinkSync(runs, external, 'dir');
      assert.throws(() => independent.read(independentRun.id), /canonical account-home spelling/);
      assert.equal(readFileSync(path.join(runs, `${protectedRun.id}.json`), 'utf8'), protectedBytes,
        'cached external-store rejection leaves canonical Run bytes unchanged');
      assert.deepEqual(new JsonFileStore({ dir: preservedExternal }).read(independentRun.id), independentRun,
        'the original independent data remains intact at its preserved path');
    } finally {
      os.userInfo = originalUserInfo;
    }
  });

  it('rechecks canonical Run ancestry after the CAS callback and preserves committed bytes on unsafe drift', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-account-'));
    tmpDirs.push(home);
    const conductor = path.join(home, '.tachiko-conductor');
    const runs = path.join(conductor, 'runs');
    mkdirSync(runs, { recursive: true, mode: 0o755 });
    chmodSync(conductor, 0o755);
    chmodSync(runs, 0o755);
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const initial = newRun('canonical-permission-cas');
      const store = new JsonFileStore({ dir: runs });
      store.create(initial);
      const filePath = path.join(runs, `${initial.id}.json`);
      const committed = readFileSync(filePath, 'utf8');
      const candidate = { ...initial, updatedAt: '2026-09-27T00:00:01.000Z' };
      const guarded = new JsonFileStore({ dir: runs, beforeConditionalWrite: () => chmodSync(runs, 0o777) });
      assert.throws(() => guarded.updateIfUnchanged(initial, candidate), /Unsafe/);
      assert.equal(readFileSync(filePath, 'utf8'), committed);
      assert.equal(statSync(runs).mode & 0o777, 0o777);
      chmodSync(runs, 0o755);
    } finally {
      os.userInfo = originalUserInfo;
    }
  });

  it('rejects an unsafe Run before publishing or taking over its mutation lock', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-account-foreign-run-'));
    tmpDirs.push(home);
    const conductor = path.join(home, '.tachiko-conductor');
    const runs = path.join(conductor, 'runs');
    mkdirSync(runs, { recursive: true, mode: 0o755 });
    chmodSync(conductor, 0o755);
    chmodSync(runs, 0o755);
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const initial = newRun('canonical-foreign-run');
      const store = new JsonFileStore({ dir: runs });
      store.create(initial);
      const runPath = path.join(runs, `${initial.id}.json`);
      const lockPath = `${runPath}.mutation.lock`;
      const candidate = { ...initial, updatedAt: '2026-09-27T00:00:01.000Z' };
      chmodSync(runPath, 0o666);
      const runBytes = readFileSync(runPath);
      const runBefore = statSync(runPath);
      assert.throws(() => store.update(candidate), /Unsafe/);
      assert.equal(existsSync(lockPath), false, 'unsafe Run must be rejected before publishing a lock');
      assert.deepEqual(readFileSync(runPath), runBytes);
      assert.equal(statSync(runPath).mode & 0o7777, runBefore.mode & 0o7777);
      assert.equal(statSync(runPath).mtimeMs, runBefore.mtimeMs);

      const staleChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      await new Promise<void>((resolve, reject) => {
        staleChild.once('spawn', resolve);
        staleChild.once('error', reject);
      });
      const stalePid = staleChild.pid;
      assert.ok(stalePid !== undefined);
      staleChild.kill('SIGKILL');
      await new Promise<void>((resolve) => staleChild.once('close', () => resolve()));
      writeFileSync(lockPath, `${JSON.stringify({ nonce: `stale-${stalePid}`, pid: stalePid })}\n`, { mode: 0o600 });
      chmodSync(lockPath, 0o600);
      const lockBytes = readFileSync(lockPath);
      const lockBefore = statSync(lockPath);
      const entriesBefore = readdirSync(runs).sort();
      assert.throws(() => store.update(candidate), /Unsafe/);
      const lockAfter = statSync(lockPath);
      assert.deepEqual(readFileSync(lockPath), lockBytes);
      assert.equal(lockAfter.mode & 0o7777, lockBefore.mode & 0o7777);
      assert.equal(lockAfter.mtimeMs, lockBefore.mtimeMs);
      assert.deepEqual(readdirSync(runs).sort(), entriesBefore, 'unsafe Run must not create a takeover claim');
    } finally {
      os.userInfo = originalUserInfo;
    }
  });

  it('publishes canonical Run JSON with a private mode under umask 002', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-account-umask-'));
    tmpDirs.push(home);
    const conductor = path.join(home, '.tachiko-conductor');
    const runs = path.join(conductor, 'runs');
    const originalUserInfo = os.userInfo;
    const originalUmask = process.umask(0o002);
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const store = new JsonFileStore({ dir: runs });
      assert.equal(statSync(conductor).mode & 0o777, 0o700);
      assert.equal(statSync(runs).mode & 0o777, 0o700);
      const initial = newRun('canonical-umask-run');
      store.create(initial);
      const filePath = path.join(runs, `${initial.id}.json`);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      store.update(applyTransition(initial, { type: 'start' }, T0));
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      store.read(initial.id);
    } finally {
      process.umask(originalUmask);
      os.userInfo = originalUserInfo;
    }
  });

  it('keeps Run temp descriptors and final snapshots private across create, update and CAS under permissive umask', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-private-run-'));
    tmpDirs.push(home);
    const conductor = path.join(home, '.tachiko-conductor');
    const runs = path.join(conductor, 'runs');
    mkdirSync(runs, { recursive: true, mode: 0o755 });
    chmodSync(home, 0o755);
    chmodSync(conductor, 0o755);
    chmodSync(runs, 0o755);
    const originalUserInfo = os.userInfo;
    const originalUmask = process.umask(0);
    const observedTempModes: number[] = [];
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const store = new JsonFileStore({ dir: runs, syncForDurability: (fd, target) => {
        if (target !== 'file') { fsyncSync(fd); return; }
        const descriptorMode = fstatSync(fd).mode & 0o777;
        observedTempModes.push(descriptorMode);
        assert.equal(descriptorMode, 0o600, 'the descriptor remains private at the pre-rename file durability seam');
        const tempName = readdirSync(runs).find((name) => name.startsWith('private-run-writes.json.') && name.endsWith('.tmp'));
        assert.ok(tempName, 'file durability seam is observing the authoritative Run temporary');
        const tempPath = path.join(runs, tempName);
        assert.equal(statSync(tempPath).mode & 0o777, 0o600);
        const prospectiveBytes = readFileSync(tempPath, 'utf8');
        assert.ok(prospectiveBytes.includes('COMPLETE-PRIVATE-RUN-OUTPUT'));
        assert.ok(prospectiveBytes.includes('FALLBACK-PRIVATE-RUN-PREVIEW'));
        fsyncSync(fd);
      } });
      const completeOutput = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'COMPLETE-PRIVATE-RUN-OUTPUT', stderr: '', store: new InMemoryToolOutputStore() });
      const fallbackText = 'FALLBACK-PRIVATE-RUN-PREVIEW';
      const fallbackStream = { bytes: Buffer.byteLength(fallbackText), preview: fallbackText,
        previewBytes: Buffer.byteLength(fallbackText), truncated: false };
      const validation = validationPassed();
      const initial = {
        ...newRun('private-run-writes'),
        validationResult: {
          ...validation,
          local: { ...validation.local, commands: [
            { commandIndex: 0, executable: 'test', outcome: 'passed' as const, exitCode: 0, durationMs: 1,
              captureStatus: 'complete' as const, output: completeOutput },
            { commandIndex: 1, executable: 'test', outcome: 'passed' as const, exitCode: 0, durationMs: 1,
              captureStatus: 'partial' as const, capturePreview: {
                stdout: fallbackStream, stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
                diagnostics: [fallbackText], diagnosticsTruncated: false,
              } },
          ] },
        },
      };
      store.create(initial);
      const filePath = path.join(runs, `${initial.id}.json`);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      assert.ok(readFileSync(filePath, 'utf8').includes('COMPLETE-PRIVATE-RUN-OUTPUT'));
      assert.ok(readFileSync(filePath, 'utf8').includes('FALLBACK-PRIVATE-RUN-PREVIEW'));
      const updated = applyTransition(initial, { type: 'start' }, T0);
      store.update(updated);
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      assert.equal(store.updateIfUnchanged(updated, updated), true, 'successful CAS still writes through the shared private helper');
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
      assert.deepEqual(observedTempModes, [0o600, 0o600, 0o600]);
    } finally {
      process.umask(originalUmask);
      os.userInfo = originalUserInfo;
    }
  });

  it('reads legacy 0644 Runs without mutation, leaves failed CAS untouched, and hardens an ordinary update', () => {
    const { store, dir } = tempStore();
    const legacy = newRun('legacy-run-permissions');
    const filePath = path.join(dir, `${legacy.id}.json`);
    writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o644 });
    chmodSync(filePath, 0o644);
    const legacyBytes = readFileSync(filePath, 'utf8');
    assert.deepEqual(store.read(legacy.id), legacy);
    assert.equal(statSync(filePath).mode & 0o777, 0o644, 'read preserves legacy mode');
    const stale = { ...legacy, updatedAt: '2030-01-01T00:00:00.000Z' };
    assert.equal(store.updateIfUnchanged(stale, { ...stale, updatedAt: '2030-01-01T00:00:01.000Z' }), false);
    assert.equal(readFileSync(filePath, 'utf8'), legacyBytes, 'failed CAS preserves legacy bytes');
    assert.equal(statSync(filePath).mode & 0o777, 0o644, 'failed CAS preserves legacy permissions');
    store.update({ ...legacy, updatedAt: '2026-10-08T00:00:00.000Z' });
    assert.equal(statSync(filePath).mode & 0o777, 0o600, 'ordinary authorized rewrite atomically hardens only this Run');
  });

  it('rejects a cached canonical Run store after its conductor root is retargeted', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-store-account-retarget-'));
    tmpDirs.push(home);
    const conductor = path.join(home, '.tachiko-conductor');
    const runs = path.join(conductor, 'runs');
    mkdirSync(runs, { recursive: true, mode: 0o755 });
    chmodSync(conductor, 0o755);
    chmodSync(runs, 0o755);
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: home })) as typeof os.userInfo;
      const store = new JsonFileStore({ dir: runs });
      const run = newRun('cached-canonical-store');
      store.create(run);
      const committed = readFileSync(path.join(runs, `${run.id}.json`), 'utf8');
      const preserved = path.join(home, 'preserved-conductor');
      const alternate = path.join(home, 'alternate-conductor');
      mkdirSync(alternate, { mode: 0o755 });
      renameSync(conductor, preserved);
      symlinkSync(alternate, conductor, 'dir');
      assert.throws(() => store.read(run.id), /symlink.*wrong filesystem type/);
      assert.equal(readFileSync(path.join(preserved, 'runs', `${run.id}.json`), 'utf8'), committed);
      assert.equal(existsSync(path.join(alternate, 'runs')), false);
      rmSync(conductor);
      renameSync(preserved, conductor);
    } finally {
      os.userInfo = originalUserInfo;
    }
  });

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

  it('rejects rewriting an existing history record even when its length is unchanged', () => {
    const { store } = tempStore();
    const initial = newRun('history-immutable');
    store.create(initial);
    const started = applyTransition(initial, { type: 'start' }, T0);
    store.update(started);
    const rewritten = {
      ...started,
      history: started.history.map((event, index) => index === 0 ? { ...event, reason: 'forged same-length history' } : event),
    };
    assert.throws(() => store.update(rewritten), /Run history is append-only/);
    assert.equal(store.read(initial.id)?.history[0]?.reason, undefined);
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
    const completeSentinel = 'COMPLETE-RAW-OUTPUT-SENTINEL';
    const fallbackSentinel = 'FALLBACK-RAW-PREVIEW-SENTINEL';
    const completeOutput = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: completeSentinel, stderr: '', store: new InMemoryToolOutputStore() });
    const fallbackStream = { bytes: Buffer.byteLength(fallbackSentinel), preview: fallbackSentinel,
      previewBytes: Buffer.byteLength(fallbackSentinel), truncated: false };
    const validation = validationPassed('head-sha');
    run = {
      ...run,
      validationResult: {
        ...validation,
        local: {
          ...validation.local,
          commands: [
            { commandIndex: 0, executable: 'test', outcome: 'passed', exitCode: 0, durationMs: 1,
              captureStatus: 'complete' as const, output: completeOutput },
            { commandIndex: 1, executable: 'test', outcome: 'passed', exitCode: 0, durationMs: 1,
              captureStatus: 'partial' as const, capturePreview: {
                stdout: fallbackStream, stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
                diagnostics: [fallbackSentinel], diagnosticsTruncated: false,
              } },
          ],
        },
      },
    };
    store.create(run);

    const raw = readFileSync(path.join(dir, 'projected.json'), 'utf8');
    const projection = JSON.parse(readFileSync(operationalProjectionPath(dir, 'projected'), 'utf8')) as Record<string, unknown>;
    assert.equal(projection.schemaVersion, OPERATIONAL_RUN_PROJECTION_VERSION);
    assert.equal(projection.sourceDigest, sha256(raw));
    assert.equal(raw.includes(completeSentinel), true);
    assert.equal(raw.includes(fallbackSentinel), true);
    assert.equal(JSON.stringify(projection).includes(completeSentinel), false, 'derived metadata omits complete raw-output bytes');
    assert.equal(JSON.stringify(projection).includes(fallbackSentinel), false, 'derived metadata omits fallback raw-preview bytes');
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

  it('rejects orphaned or mismatched new-format repair admission markers on JSON read', () => {
    const { store, dir } = tempStore();
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 30_000 };
    const authority = { revision: 'shape-v1', shape: 'bounded' as const };
    const predecessor = {
      ...newRun('orphan-repair-marker'), state: 'IMPLEMENTING' as const, headSha: 'head-sha',
      pullRequest: { number: 7, headSha: 'head-sha' }, repairTaskShapeAuthority: authority,
      reviewResult: { verdict: 'request_changes' as const, reviewerName: 'reviewer', headSha: 'head-sha', findings: [] },
    };
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', 'head-sha', 7, execution, T0);
    const binding = createRepairAttemptBinding(predecessor, execution);
    const valid = {
      ...predecessor,
      history: [{ type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0, repairAdmissionIndex: 0 }],
      repairAdmissions: [{ ...receipt, attemptBinding: binding }],
    };
    store.create(valid);
    const file = path.join(dir, 'orphan-repair-marker.json');
    for (const damage of [
      (json: Record<string, any>) => { delete json.repairAdmissions[0].attemptBinding; },
      (json: Record<string, any>) => { json.history[0].repairAdmissionIndex = 1; },
    ]) {
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
      damage(json);
      writeFileSync(file, JSON.stringify(json), 'utf8');
      assert.throws(() => new JsonFileStore({ dir }).read(valid.id), /corrupt or incompatible/);
      writeFileSync(file, JSON.stringify(valid), 'utf8');
    }
  });

  it('replays every repair handoff against the exact previous executor identity', () => {
    const { store, dir } = tempStore();
    const authority = { revision: 'shape-v1', shape: 'bounded' as const };
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 30_000 };
    const predecessor = { provider: 'codex-app-server', sessionId: 'session-A', generation: 'run-generation' } as const;
    let run = newRun('repair-handoff-ledger-replay');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('head-sha'), headSha: 'head-sha' }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed('head-sha'), pullRequest: { number: 7, headSha: 'head-sha' } }, T0);
    run = {
      ...run, repairTaskShapeAuthority: authority,
      executor: predecessor,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
    };
    run = applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'head-sha') }, T0, TEST_VALIDATION_AUTHORITY);
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', 'head-sha', 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    assert.equal(binding.freshExecutor, false);
    run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
    const preHandoff = { ...run, id: 'generationless-appserver-active-binding' };
    store.create(preHandoff);
    const preHandoffFile = path.join(dir, `${preHandoff.id}.json`);
    const preHandoffOriginal = readFileSync(preHandoffFile, 'utf8');
    const generationlessAdmission = JSON.parse(preHandoffOriginal) as Record<string, any>;
    delete generationlessAdmission.repairAdmissions[0].attemptBinding.predecessorExecutor.generation;
    const generationlessBytes = JSON.stringify(generationlessAdmission);
    writeFileSync(preHandoffFile, generationlessBytes, 'utf8');
    assert.throws(() => new JsonFileStore({ dir }).read(preHandoff.id), /corrupt or incompatible/,
      'an active nonfresh App Server admission without a generation is invalid even before handoff');
    assert.equal(readFileSync(preHandoffFile, 'utf8'), generationlessBytes, 'rejected pre-handoff admission bytes remain unchanged');
    writeFileSync(preHandoffFile, preHandoffOriginal, 'utf8');
    const predecessorContradictions = [
      {
        label: 'Run executor session changed before first handoff',
        change: (json: Record<string, any>) => { json.executor.sessionId = 'session-B'; },
      },
      {
        label: 'coherent Run and result session changed before first handoff',
        change: (json: Record<string, any>) => {
          json.executor.sessionId = 'session-B';
          json.agentResult.executor.sessionId = 'session-B';
          json.agentResult.sessionId = 'session-B';
        },
      },
      {
        label: 'result-only executor replaced before first handoff',
        change: (json: Record<string, any>) => {
          delete json.executor;
          json.agentResult.executor.sessionId = 'session-B';
          json.agentResult.sessionId = 'session-B';
        },
      },
      {
        label: 'coherent Run and result generation changed before first handoff',
        change: (json: Record<string, any>) => {
          json.executor.generation = 'generation-B';
          json.agentResult.executor.generation = 'generation-B';
        },
      },
      {
        label: 'coherent Run and result generation removed before first handoff',
        change: (json: Record<string, any>) => {
          delete json.executor.generation;
          delete json.agentResult.executor.generation;
        },
      },
    ];
    for (const contradiction of predecessorContradictions) {
      const altered = JSON.parse(preHandoffOriginal) as Record<string, any>;
      contradiction.change(altered);
      const corruptedBytes = JSON.stringify(altered);
      writeFileSync(preHandoffFile, corruptedBytes, 'utf8');
      assert.throws(() => new JsonFileStore({ dir }).read(preHandoff.id), /corrupt or incompatible/, contradiction.label);
      assert.equal(readFileSync(preHandoffFile, 'utf8'), corruptedBytes, `${contradiction.label}: rejected bytes remain unchanged`);
    }
    writeFileSync(preHandoffFile, preHandoffOriginal, 'utf8');
    const exact = { ...successResult('fixed-sha'), executor: predecessor, sessionId: predecessor.sessionId };
    run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: exact }, T0);
    run = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: exact }, T0);
    run = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: exact }, T0);
    store.create(run);

    const restarted = new JsonFileStore({ dir });
    const replayed = restarted.read(run.id);
    assert.equal(replayed?.history.length, run.history.length, 'exact logical codex-cli/App Server identity remains valid after restart');
    assert.deepEqual(replayed?.history.map((event) => event.repairHandoff).filter(Boolean), run.history.map((event) => event.repairHandoff).filter(Boolean));
    const file = path.join(dir, `${run.id}.json`);
    const original = readFileSync(file, 'utf8');
    const corruptions = [
      {
        label: 'session-only continuation substitution followed by a return to A',
        eventType: 'repair_executor_continued',
        change: (identity: Record<string, unknown>) => { identity.sessionId = 'session-B'; },
      },
      {
        label: 'generation-only continuation change',
        eventType: 'repair_executor_continued',
        change: (identity: Record<string, unknown>) => { identity.generation = 'other-generation'; },
      },
      {
        label: 'generation-only continuation removal',
        eventType: 'repair_executor_continued',
        change: (identity: Record<string, unknown>) => { delete identity.generation; },
      },
      {
        label: 'first handoff session substitution followed by a return to A',
        eventType: 'repair_executor_handoff',
        change: (identity: Record<string, unknown>) => { identity.sessionId = 'session-B'; },
      },
      {
        label: 'first handoff identity extra on valid App Server identity',
        eventType: 'repair_executor_handoff',
        change: (identity: Record<string, unknown>) => { identity.extra = true; },
      },
      {
        label: 'continuation identity extra on valid App Server identity',
        eventType: 'repair_executor_continued',
        change: (identity: Record<string, unknown>) => { identity.extra = true; },
      },
    ];
    for (const { label, eventType, change } of corruptions) {
      const damaged = JSON.parse(original) as Record<string, any>;
      const event = damaged.history.find((candidate: { type: string }) => candidate.type === eventType);
      change(event.repairHandoff.outcome.identity);
      const corruptBytes = JSON.stringify(damaged);
      writeFileSync(file, corruptBytes, 'utf8');
      assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/, label);
      assert.equal(readFileSync(file, 'utf8'), corruptBytes, 'rejected replay leaves persisted corrupt bytes untouched');
    }
    const missingCanonicalExecutor = JSON.parse(original) as Record<string, any>;
    delete missingCanonicalExecutor.executor;
    const missingCanonicalBytes = JSON.stringify(missingCanonicalExecutor);
    writeFileSync(file, missingCanonicalBytes, 'utf8');
    assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/,
      'a post-handoff result carrier cannot substitute for the canonical Run executor');
    assert.equal(readFileSync(file, 'utf8'), missingCanonicalBytes, 'rejected post-handoff history is never rewritten');
    const generationless = JSON.parse(original) as Record<string, any>;
    delete generationless.repairAdmissions[0].attemptBinding.predecessorExecutor.generation;
    const invalidAdmissionBytes = JSON.stringify(generationless);
    writeFileSync(file, invalidAdmissionBytes, 'utf8');
    assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/, 'persisted generationless App Server binding is rejected on restart');
    assert.equal(readFileSync(file, 'utf8'), invalidAdmissionBytes, 'rejected admission bytes remain untouched');
    assert.equal(run.history.at(-1)?.repairHandoff?.outcome.kind, 'executor', 'replay rejection did not mutate the caller-owned history');
    writeFileSync(file, original, 'utf8');
  });

  it('rejects active bound repair restarts missing their required authority or finding carrier without rewriting bytes', () => {
    const { dir } = tempStore();
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 30_000 };
    const authority = { revision: 'shape-v1', shape: 'bounded' as const };
    const reviewRun = (() => {
      const predecessor = {
        ...newRun('bound-review-carrier'), state: 'IMPLEMENTING' as const, headSha: 'head-sha',
        pullRequest: { number: 7, headSha: 'head-sha' }, repairTaskShapeAuthority: authority,
        reviewResult: { verdict: 'request_changes' as const, reviewerName: 'reviewer', headSha: 'head-sha', findings: [] },
      };
      const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', 'head-sha', 7, execution, T0);
      const binding = createRepairAttemptBinding(predecessor, execution);
      return {
        ...predecessor,
        history: [{ type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0, repairAdmissionIndex: 0 }],
        repairAdmissions: [{ ...receipt, attemptBinding: binding }],
      };
    })();
    const validationRun = (() => {
      const predecessor = {
        ...newRun('bound-validation-carrier'), state: 'IMPLEMENTING' as const, headSha: 'head-sha',
        pullRequest: { number: 7, headSha: 'head-sha' }, repairTaskShapeAuthority: authority,
        validationResult: validationFailed('head-sha'),
      };
      const receipt = createRepairAdmissionSnapshot(authority, 'validation_failed', 'head-sha', 7, execution, T0);
      const binding = createRepairAttemptBinding(predecessor, execution);
      return {
        ...predecessor,
        history: [{ type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0, repairAdmissionIndex: 0 }],
        repairAdmissions: [{ ...receipt, attemptBinding: binding }],
      };
    })();
    const store = new JsonFileStore({ dir });
    for (const run of [reviewRun, validationRun]) store.create(run);
    const cases = [
      { id: reviewRun.id, label: 'task-shape authority', mutate: (json: Record<string, any>) => { delete json.repairTaskShapeAuthority; } },
      { id: reviewRun.id, label: 'review finding', mutate: (json: Record<string, any>) => { delete json.reviewResult; } },
      { id: validationRun.id, label: 'validation finding', mutate: (json: Record<string, any>) => { delete json.validationResult; } },
    ];
    for (const { id, label, mutate } of cases) {
      const file = path.join(dir, `${id}.json`);
      const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
      mutate(json);
      const bytes = JSON.stringify(json);
      writeFileSync(file, bytes, 'utf8');
      assert.throws(() => new JsonFileStore({ dir }).read(id), /corrupt or incompatible/, label);
      assert.equal(readFileSync(file, 'utf8'), bytes, `${label}: failed restart read leaves bytes untouched`);
    }
  });

  it('retains result-only predecessors, completed repair history, and legacy unbound start_fix records', () => {
    const { store, dir } = tempStore();
    const authority = { revision: 'shape-v1', shape: 'bounded' as const };
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 30_000 };
    const resultOnlyExecutor = { provider: 'codex-app-server', sessionId: 'result-only-session', generation: 'runtime-generation' } as const;

    let resultOnly = newRun('valid-result-only-predecessor');
    resultOnly = applyTransition(resultOnly, { type: 'start' }, T0);
    resultOnly = applyTransition(resultOnly, {
      type: 'agent_succeeded',
      agentResult: { ...successResult('head-sha'), executor: resultOnlyExecutor, sessionId: resultOnlyExecutor.sessionId },
      headSha: 'head-sha',
    }, T0);
    resultOnly = applyTransition(resultOnly, { type: 'validation_passed', validationResult: validationPassed('head-sha'), pullRequest: { number: 7, headSha: 'head-sha' } }, T0);
    resultOnly = { ...resultOnly, executor: undefined, repairTaskShapeAuthority: authority };
    resultOnly = applyTransition(resultOnly, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'head-sha') }, T0, TEST_VALIDATION_AUTHORITY);
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', 'head-sha', 7, execution, T0);
    const binding = createRepairAttemptBinding(resultOnly, execution);
    assert.equal(binding.predecessorExecutor?.sessionId, resultOnlyExecutor.sessionId);
    resultOnly = applyTransition(resultOnly, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
    store.create(resultOnly);
    assert.equal(JSON.stringify(new JsonFileStore({ dir }).read(resultOnly.id)), JSON.stringify(resultOnly),
      'legacy result-only identity remains a valid predecessor on restart');

    const completed = { ...applyTransition(resultOnly, {
      type: 'agent_succeeded', agentResult: successResult('fixed-head'), headSha: 'fixed-head',
      pullRequest: { number: 7, headSha: 'fixed-head' },
    }, T0), id: 'completed-historical-repair' };
    assert.equal(completed.state, 'VALIDATING');
    assert.equal(completed.reviewResult, undefined, 'completed repair clears the old finding projection');
    store.create(completed);

    let legacy = newRun('legacy-unbound-start-fix');
    legacy = applyTransition(legacy, { type: 'start' }, T0);
    legacy = applyTransition(legacy, { type: 'agent_succeeded', agentResult: successResult('legacy-head'), headSha: 'legacy-head' }, T0);
    legacy = applyTransition(legacy, { type: 'validation_passed', validationResult: validationPassed('legacy-head'), pullRequest: { number: 7, headSha: 'legacy-head' } }, T0);
    legacy = applyTransition(legacy, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'legacy-head') }, T0, TEST_VALIDATION_AUTHORITY);
    legacy = applyTransition(legacy, { type: 'start_fix' }, T0);
    store.create(legacy);

    const restarted = new JsonFileStore({ dir });
    assert.equal(JSON.stringify(restarted.read(completed.id)), JSON.stringify(completed),
      'completed history remains valid after its finding is cleared');
    assert.equal(JSON.stringify(restarted.read(legacy.id)), JSON.stringify(legacy),
      'legacy unbound attempt remains readable without manufacturing an admission');
  });

  it('replays WorkerRouter repair handoffs as sessionless and rejects executor-kind ledger history', () => {
    const { store, dir } = tempStore();
    const authority = { revision: 'shape-v1', shape: 'bounded' as const };
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'worker-router', timeoutMs: 30_000 };
    let run = newRun('worker-router-sessionless-ledger');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('head-sha'), headSha: 'head-sha' }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed('head-sha'), pullRequest: { number: 7, headSha: 'head-sha' } }, T0);
    run = { ...run, repairTaskShapeAuthority: authority };
    run = applyTransition(run, { type: 'changes_requested', reviewResult: changesRequested('reviewer-1', 'head-sha') }, T0, TEST_VALIDATION_AUTHORITY);
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', 'head-sha', 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
    run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: successResult('fixed-sha') }, T0);
    run = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: successResult('fixed-sha') }, T0);
    store.create(run);
    assert.equal(new JsonFileStore({ dir }).read(run.id)?.history.at(-1)?.repairHandoff?.outcome.kind, 'sessionless');

    const file = path.join(dir, `${run.id}.json`);
    const original = readFileSync(file, 'utf8');
    const forged = { kind: 'executor', identity: { provider: 'worker-router', sessionId: 'invented-session' } };
    const corruptions: Array<[string, (handoffs: any[]) => void]> = [
      ['first-only executor-kind WorkerRouter', (handoffs) => { handoffs[0].repairHandoff.outcome = forged; }],
      ['continuation-only executor-kind WorkerRouter', (handoffs) => { handoffs[1].repairHandoff.outcome = forged; }],
      ['first-only record extra', (handoffs) => { handoffs[0].repairHandoff.extra = true; }],
      ['continuation-only record extra', (handoffs) => { handoffs[1].repairHandoff.extra = true; }],
      ['first-only outcome extra', (handoffs) => { handoffs[0].repairHandoff.outcome.extra = true; }],
      ['continuation-only outcome extra', (handoffs) => { handoffs[1].repairHandoff.outcome.extra = true; }],
    ];
    for (const [corruption, mutate] of corruptions) {
      const damaged = JSON.parse(original) as Record<string, any>;
      const handoffs = damaged.history.filter((entry: { type: string }) => entry.type === 'repair_executor_handoff' || entry.type === 'repair_executor_continued');
      mutate(handoffs);
      if (corruption === 'continuation-only executor-kind WorkerRouter') {
        damaged.executor = forged.identity;
        damaged.agentResult.executor = forged.identity;
        damaged.agentResult.sessionId = forged.identity.sessionId;
      }
      const corruptBytes = JSON.stringify(damaged);
      writeFileSync(file, corruptBytes, 'utf8');
      assert.throws(() => new JsonFileStore({ dir }).read(run.id), /corrupt or incompatible/, `${corruption} persisted handoff is rejected`);
      assert.equal(readFileSync(file, 'utf8'), corruptBytes, `${corruption} rejected history is not rewritten`);
    }
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

  it('rejects stale JSON-file CAS for previously omitted and reader-accepted unknown persisted fields', () => {
    const cases: Array<[string, (run: Run) => Run]> = [
      ['target', (run) => ({ ...run, target: { ...run.target, repo: `${run.target.repo}-newer` } })],
      ['createdAt', (run) => ({ ...run, createdAt: '2026-09-27T00:00:01.000Z' })],
      ['dispatchClaimId', (run) => ({ ...run, dispatchClaimId: 'newer-dispatch-claim' })],
      ['execution', (run) => ({ ...run, execution: { profile: 'routine', revision: 'cas-v1', executor: 'claude-code', timeoutMs: 30_000 } })],
      ['interruptedFrom', (run) => ({ ...run, interruptedFrom: 'IMPLEMENTING' })],
      ['bootstrap', (run) => ({ ...run, bootstrap: {
        bootstrapKind: 'linked-worktree', owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
        baseBranch: 'main', baseSha: 'b'.repeat(40), branch: `tachiko/${run.id}`, workspacePath: `/tmp/${run.id}`,
      } })],
      ['reader-accepted unknown field', (run) => ({ ...run, futureUnknown: { changed: true } } as Run)],
      ['reader-accepted unknown array order', (run) => ({ ...run, futureUnknown: { ...(run as Run & { futureUnknown: { ordered: string[] } }).futureUnknown, ordered: ['second', 'first'] } } as Run)],
      ['reader-accepted own __proto__ property', (run) => {
        const changed = { ...run };
        Object.defineProperty(changed, '__proto__', {
          configurable: true,
          enumerable: true,
          value: { readerAcceptedFutureField: 'changed' },
          writable: true,
        });
        return changed as Run;
      }],
    ];

    for (const [field, mutate] of cases) {
      for (const proposal of ['expected', 'next'] as const) {
        const { store, dir } = tempStore();
        const expected = casFixture(`full-json-cas-${field.replaceAll(/[^a-z0-9]+/gi, '-')}-${proposal}`);
        store.create(expected);
        const newer = mutate(expected);
        store.update(newer);
        const readerResult = store.read(expected.id);
        assert.deepEqual(readerResult, newer, `${field} fixture is accepted by the production reader`);
        if (field === 'reader-accepted own __proto__ property') {
          assert.ok(readerResult);
          assert.equal(Object.prototype.hasOwnProperty.call(readerResult, '__proto__'), true,
            'the production reader retains __proto__ as an own persisted key');
          assert.deepEqual((readerResult as unknown as Record<string, unknown>)['__proto__'],
            { readerAcceptedFutureField: 'changed' }, 'the production reader exposes its changed persisted value');
        }

        const runPath = path.join(dir, `${expected.id}.json`);
        const projectionPath = operationalProjectionPath(dir, expected.id);
        const newerRunBytes = readFileSync(runPath, 'utf8');
        const newerProjectionBytes = readFileSync(projectionPath, 'utf8');
        const staleNext = proposal === 'expected'
          ? expected
          : { ...expected, updatedAt: '2026-09-27T00:00:02.000Z' };

        assert.equal(store.updateIfUnchanged(expected, staleNext), false,
          `${field} makes the ${proposal === 'expected' ? 'stale no-op' : 'stale transition'} CAS fail`);
        assert.equal(readFileSync(runPath, 'utf8'), newerRunBytes, `${field} newer Run bytes survive`);
        assert.equal(readFileSync(projectionPath, 'utf8'), newerProjectionBytes, `${field} newer projection bytes survive`);
      }
    }
  });

  it('uses persisted JSON semantics for unchanged, key-reordered, undefined, and legacy-normalized snapshots', () => {
    const { store, dir } = tempStore();
    const initial = casFixture('full-json-cas-json-semantics');
    store.create(initial);
    assert.equal(store.updateIfUnchanged(initial, initial), true, 'unchanged complete Run snapshots compare equal');

    const runPath = path.join(dir, `${initial.id}.json`);
    const parsed = JSON.parse(readFileSync(runPath, 'utf8')) as unknown;
    writeFileSync(runPath, `${JSON.stringify(reverseObjectKeyOrder(parsed), null, 2)}\n`, 'utf8');
    assert.equal(store.updateIfUnchanged(initial, initial), true, 'object-key order is irrelevant to the durable snapshot');

    const undefinedExpected = { ...initial, futureUndefined: undefined } as Run;
    assert.equal(store.updateIfUnchanged(undefinedExpected, initial), true, 'undefined object properties are omitted by persistence semantics');

    const legacyStore = tempStore();
    const legacyBootstrap = {
      owner: TARGET.owner,
      repo: TARGET.repo,
      issueNumber: TARGET.issueNumber,
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      branch: 'tachiko/full-json-cas-legacy-normalized',
      workspacePath: '/tmp/full-json-cas-legacy-normalized',
    } as unknown as NonNullable<Run['bootstrap']>;
    delete (legacyBootstrap as { bootstrapKind?: string }).bootstrapKind;
    const legacy = { ...initial, id: 'full-json-cas-legacy-normalized', bootstrap: legacyBootstrap } as Run;
    legacyStore.store.create(legacy);
    assert.equal(legacyStore.store.read(legacy.id)?.bootstrap?.bootstrapKind, 'linked-worktree', 'the production reader applies legacy bootstrap normalization');
    assert.equal(legacyStore.store.updateIfUnchanged(legacy, legacy), true, 'legacy expected values compare after the reader’s normalization');
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

  it('rejects raw provider output before create, update, or CAS can persist it', () => {
    const evidence = boundToolOutput({
      outcome: 'failed',
      exitCode: 7,
      stdout: 'stdout '.repeat(100),
      stderr: 'ERROR: test failed\n',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 32, diagnosticBytes: 128, maxDiagnostics: 4, readBytes: 128 },
    });
    const withRawOutput = (run: Run): Run => ({
      ...run,
      agentResult: { exitStatus: 'failure', summary: 'failed', output: evidence } as never,
    });

    const createStore = tempStore();
    const createRun = withRawOutput(newRun('raw-output-create'));
    assert.throws(() => createStore.store.create(createRun), /raw provider output artifacts/);
    assert.equal(existsSync(path.join(createStore.dir, `${createRun.id}.json`)), false);

    const updateStore = tempStore();
    const updateRun = newRun('raw-output-update');
    updateStore.store.create(updateRun);
    const updateRunPath = path.join(updateStore.dir, `${updateRun.id}.json`);
    const updateBytes = readFileSync(updateRunPath, 'utf8');
    assert.throws(() => updateStore.store.update(withRawOutput(updateRun)), /raw provider output artifacts/);
    assert.equal(readFileSync(updateRunPath, 'utf8'), updateBytes);

    const casStore = tempStore();
    const casRun = newRun('raw-output-cas');
    casStore.store.create(casRun);
    const casRunPath = path.join(casStore.dir, `${casRun.id}.json`);
    const casBytes = readFileSync(casRunPath, 'utf8');
    assert.throws(() => casStore.store.updateIfUnchanged(casRun, withRawOutput(casRun)), /raw provider output artifacts/);
    assert.equal(readFileSync(casRunPath, 'utf8'), casBytes);
  });

  it('round trips an exact joined diagnostic boundary inside local Run validation evidence', () => {
    const line = `ERROR: ${'x'.repeat(32_761)}`;
    const output = boundToolOutput({ outcome: 'failed', exitCode: 1, stderr: line, stdout: line,
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 8, diagnosticBytes: 65_536, maxDiagnostics: 2, readBytes: 8 } });
    assert.equal(Buffer.byteLength(output.diagnostics.join('\n')), 65_536);
    const validation = validationFailed('diagnostic-roundtrip');
    let run: Run = applyTransition(newRun('diagnostic-run-roundtrip'), { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult('diagnostic-roundtrip'), headSha: 'diagnostic-roundtrip' }, T0);
    run = applyTransition(run, { type: 'validation_failed', validationResult: validation,
      pullRequest: { number: 7, headSha: 'diagnostic-roundtrip' } }, T0);
    run = { ...run, validationResult: { ...validation, local: { ...validation.local, commands: [{ commandIndex: 0,
      executable: 'test', outcome: 'failed', exitCode: 1, durationMs: 1, captureStatus: 'complete', output }] } } };
    const { store, dir } = tempStore();
    store.create(run);
    const loaded = store.read(run.id);
    const persisted = loaded?.validationResult?.local.commands[0]?.output;
    assert.deepEqual(persisted?.diagnostics, output.diagnostics);
    assert.equal(Buffer.byteLength((persisted?.diagnostics ?? []).join('\n')), 65_536);
  });

  it('rejects incoherent tool-output payloads before validation admission and on persisted Run read/CAS', () => {
    const headSha = 'envelope-limits-validation-head';
    const output = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'xy', stderr: '',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 1, diagnosticBytes: 2, maxDiagnostics: 1, readBytes: 1 } });
    const invalidOutput = structuredClone(output) as any;
    invalidOutput.stdout.preview = 'xy';
    invalidOutput.stdout.previewBytes = Buffer.byteLength(invalidOutput.stdout.preview);
    invalidOutput.overflow.retainedBytes = invalidOutput.stdout.previewBytes + invalidOutput.stderr.previewBytes;
    invalidOutput.overflow.omittedBytes = Math.max(0, invalidOutput.overflow.totalBytes - invalidOutput.overflow.retainedBytes);
    const validation = validationPassed(headSha);
    const validValidation = {
      ...validation,
      local: { ...validation.local, commands: [{ commandIndex: 0, executable: 'test', outcome: 'passed' as const,
        exitCode: 0, durationMs: 1, captureStatus: 'complete' as const, output }] },
    };
    const invalidValidation = {
      ...validation,
      local: { ...validation.local, commands: [{ ...validValidation.local.commands[0]!, output: invalidOutput }] },
    };
    assert.equal(isValidationResultCoherent(validValidation), true);
    assert.equal(isValidationResultCoherent(invalidValidation), false);

    const implementing = applyTransition(newRun('envelope-limits-validation'), { type: 'start' }, T0);
    const validating = applyTransition(implementing, {
      type: 'agent_succeeded', agentResult: successResult(headSha), headSha,
    }, T0);
    assert.throws(() => applyTransition(validating, {
      type: 'validation_passed', validationResult: invalidValidation,
      pullRequest: { number: 7, headSha },
    }, T0), /coherent|conflicts/);

    const validRun = applyTransition(validating, {
      type: 'validation_passed', validationResult: validValidation,
      pullRequest: { number: 7, headSha },
    }, T0);
    const { store, dir } = tempStore();
    store.create(validRun);
    const runPath = path.join(dir, `${validRun.id}.json`);
    assert.equal(isToolOutputEnvelope(store.read(validRun.id)?.validationResult?.local.commands[0]?.output), true,
      'a legitimate bounded envelope survives Run creation and readback');

    const invalidRun = {
      ...validRun,
      validationResult: invalidValidation,
    };
    const invalidBytes = JSON.stringify(invalidRun);
    writeFileSync(runPath, invalidBytes, 'utf8');
    assert.throws(() => store.read(validRun.id), /corrupt or incompatible/);
    assert.equal(readFileSync(runPath, 'utf8'), invalidBytes, 'rejected persisted read leaves the original raw bytes untouched');
    assert.throws(() => store.updateIfUnchanged!(validRun, validRun), /corrupt or incompatible/,
      'CAS rejects a corrupt existing Run before comparing or writing');
    assert.equal(readFileSync(runPath, 'utf8'), invalidBytes, 'rejected CAS leaves the original raw bytes untouched');

    const falseTruncatedOutput = structuredClone(output) as any;
    falseTruncatedOutput.stdout.truncated = false;
    falseTruncatedOutput.overflow.stdout = false;
    falseTruncatedOutput.overflow.truncated = falseTruncatedOutput.overflow.capture || falseTruncatedOutput.overflow.summary ||
      falseTruncatedOutput.overflow.diagnostics || falseTruncatedOutput.overflow.stdout || falseTruncatedOutput.overflow.stderr;
    const falseTruncatedValidation = {
      ...validation,
      local: { ...validation.local, commands: [{ ...validValidation.local.commands[0]!, output: falseTruncatedOutput }] },
    };
    assert.equal(isToolOutputEnvelope(falseTruncatedOutput), false,
      'a complete envelope cannot report over-limit stream bytes without truncation');
    assert.equal(isValidationResultCoherent({ ...validation,
      local: { ...validation.local, commands: [{ ...validValidation.local.commands[0]!, output: falseTruncatedOutput }] } }), false);
    assert.throws(() => applyTransition(validating, {
      type: 'validation_passed', validationResult: falseTruncatedValidation,
      pullRequest: { number: 7, headSha },
    }, T0), /coherent|conflicts/);

    const falseTruncatedRun = { ...validRun, validationResult: falseTruncatedValidation };
    const falseTruncatedBytes = JSON.stringify(falseTruncatedRun);
    writeFileSync(runPath, falseTruncatedBytes, 'utf8');
    assert.throws(() => store.read(validRun.id), /corrupt or incompatible/);
    assert.equal(readFileSync(runPath, 'utf8'), falseTruncatedBytes,
      'rejected complete-envelope read preserves original raw bytes');
    assert.throws(() => store.updateIfUnchanged!(validRun, validRun), /corrupt or incompatible/);
    assert.equal(readFileSync(runPath, 'utf8'), falseTruncatedBytes,
      'rejected complete-envelope CAS preserves original raw bytes');
  });

  it('roundtrips canonical retention metadata and refuses malformed metadata on Run read and CAS', () => {
    const headSha = 'retention-metadata-validation-head';
    const output = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: '', stderr: '',
      store: new InMemoryToolOutputStore(), policy: { previewBytes: 8, diagnosticBytes: 8, maxDiagnostics: 1, readBytes: 8 } });
    const operationId = '00000000-0000-4000-8000-000000000000';
    const retainedUntil = '2000-01-01T00:00:00.000Z';
    const retainedOutput = { ...output, artifact: { ...output.artifact, operationId, retainedUntil } };
    assert.equal(isToolOutputEnvelope(retainedOutput), true, 'canonical past deadline is structurally coherent');
    const validation = {
      ...validationPassed(headSha),
      local: { ...validationPassed(headSha).local, commands: [{ commandIndex: 0, executable: 'test', outcome: 'passed' as const,
        exitCode: 0, durationMs: 1, captureStatus: 'complete' as const, output: retainedOutput }] },
    };
    const implementing = applyTransition(newRun('retention-metadata-validation'), { type: 'start' }, T0);
    const validating = applyTransition(implementing, {
      type: 'agent_succeeded', agentResult: successResult(headSha), headSha,
    }, T0);
    const validRun = applyTransition(validating, {
      type: 'validation_passed', validationResult: validation,
      pullRequest: { number: 7, headSha },
    }, T0);
    const { store, dir } = tempStore();
    store.create(validRun);
    const runPath = path.join(dir, `${validRun.id}.json`);
    const persistedOutput = store.read(validRun.id)?.validationResult?.local.commands[0]?.output;
    assert.equal(isToolOutputEnvelope(persistedOutput), true, 'valid paired authority survives store roundtrip');

    const malformedOutputs = [
      { ...retainedOutput, artifact: { ...retainedOutput.artifact, operationId: 'not-an-operation-id' } },
      { ...retainedOutput, artifact: { ...retainedOutput.artifact, retainedUntil: '2000-1-1T00:00:00.000Z' } },
      { ...output, artifact: { ...output.artifact, operationId } },
    ];
    for (const malformedOutput of malformedOutputs) {
      const malformedValidation = {
        ...validation,
        local: { ...validation.local, commands: [{ ...validation.local.commands[0]!, output: malformedOutput }] },
      };
      const corruptRun = { ...validRun, validationResult: malformedValidation };
      const originalBytes = JSON.stringify(corruptRun);
      writeFileSync(runPath, originalBytes, 'utf8');
      assert.throws(() => store.read(validRun.id), /corrupt or incompatible/);
      assert.equal(readFileSync(runPath, 'utf8'), originalBytes, 'rejected read preserves raw bytes');
      assert.throws(() => store.updateIfUnchanged!(validRun, validRun), /corrupt or incompatible/);
      assert.equal(readFileSync(runPath, 'utf8'), originalBytes, 'rejected CAS preserves raw bytes');
    }
  });

  it('bounds partial and unavailable fallback diagnostics before validation and persisted Run admission', () => {
    const headSha = 'fallback-diagnostics-validation-head';
    const base = validationPassed(headSha);
    const command = { commandIndex: 0, executable: 'test', outcome: 'passed' as const,
      exitCode: 0, durationMs: 1, captureStatus: 'partial' as const, capturePreview: {
        stdout: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
        stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
        diagnostics: [] as string[], diagnosticsTruncated: false,
      } };
    const withDiagnostics = (status: 'partial' | 'unavailable', diagnostics: string[]) => ({
      ...base,
      local: { ...base.local, commands: [{ ...command, captureStatus: status, capturePreview: {
        ...command.capturePreview, diagnostics,
      } }] },
    });
    const rejected: Array<{ name: string; diagnostics: string[] }> = [
      { name: 'line count', diagnostics: Array.from({ length: TOOL_OUTPUT_POLICY_MAXIMA.maxDiagnostics + 1 }, () => 'x') },
      { name: 'single byte total', diagnostics: ['x'.repeat(TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes + 1)] },
      { name: 'LF joined total', diagnostics: Array.from({ length: TOOL_OUTPUT_POLICY_MAXIMA.maxDiagnostics }, () => 'x'.repeat(512)) },
      { name: 'UTF-8 total', diagnostics: ['界'.repeat(Math.floor(TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes / 3)) + '界'.repeat(2)] },
    ];
    for (const status of ['partial', 'unavailable'] as const) {
      for (const candidate of rejected) {
        assert.equal(isValidationResultCoherent(withDiagnostics(status, candidate.diagnostics)), false,
          `${status} capture rejects ${candidate.name} above policy`);
      }
    }

    const exactJoined = Array.from({ length: TOOL_OUTPUT_POLICY_MAXIMA.maxDiagnostics }, (_, index) =>
      index === TOOL_OUTPUT_POLICY_MAXIMA.maxDiagnostics - 1 ? 'x'.repeat(385) : 'x'.repeat(512));
    assert.equal(exactJoined.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, -1), TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes,
      'positive joined-byte fixture includes each LF separator');
    const exactUtf8 = '😀'.repeat(16_383) + 'abcd';
    assert.equal(Buffer.byteLength(exactUtf8, 'utf8'), TOOL_OUTPUT_POLICY_MAXIMA.diagnosticBytes);
    for (const status of ['partial', 'unavailable'] as const) {
      assert.equal(isValidationResultCoherent(withDiagnostics(status, exactJoined)), true,
        `${status} capture accepts exact line-count and joined-byte boundaries`);
      assert.equal(isValidationResultCoherent(withDiagnostics(status, [exactUtf8])), true,
        `${status} capture counts UTF-8 bytes at the exact boundary`);
      assert.equal(isValidationResultCoherent(withDiagnostics(status, [])), true,
        `${status} capture accepts an empty diagnostic list`);
    }

    const invalidValidation = withDiagnostics('partial', rejected[2]!.diagnostics);
    const implementing = applyTransition(newRun('fallback-diagnostics-validation'), { type: 'start' }, T0);
    const validating = applyTransition(implementing, {
      type: 'agent_succeeded', agentResult: successResult(headSha), headSha,
    }, T0);
    assert.throws(() => applyTransition(validating, {
      type: 'validation_passed', validationResult: invalidValidation,
      pullRequest: { number: 7, headSha },
    }, T0), /coherent|conflicts/);

    const validValidation = withDiagnostics('partial', exactJoined);
    const validRun = applyTransition(validating, {
      type: 'validation_passed', validationResult: validValidation,
      pullRequest: { number: 7, headSha },
    }, T0);
    const { store, dir } = tempStore();
    store.create(validRun);
    assert.equal(isValidationResultCoherent(store.read(validRun.id)?.validationResult), true,
      'legitimate exact-boundary fallback evidence survives create/read');

    const invalidRun = { ...validRun, validationResult: invalidValidation };
    const runPath = path.join(dir, `${validRun.id}.json`);
    const invalidBytes = JSON.stringify(invalidRun);
    writeFileSync(runPath, invalidBytes, 'utf8');
    assert.throws(() => store.read(validRun.id), /corrupt or incompatible/);
    assert.equal(readFileSync(runPath, 'utf8'), invalidBytes, 'rejected persisted read preserves the malformed raw bytes');
    assert.throws(() => store.updateIfUnchanged!(validRun, validRun), /corrupt or incompatible/,
      'CAS rejects malformed persisted fallback evidence before writing');
    assert.equal(readFileSync(runPath, 'utf8'), invalidBytes, 'rejected CAS preserves the malformed raw bytes');
  });

  it('bounds partial and unavailable fallback stream previews to the shared policy before Run admission', () => {
    const headSha = 'fallback-stream-preview-validation-head';
    const base = validationPassed(headSha);
    const exactAscii = 'x'.repeat(TOOL_OUTPUT_POLICY_MAXIMA.previewBytes);
    const exactUtf8 = '界'.repeat(Math.floor(TOOL_OUTPUT_POLICY_MAXIMA.previewBytes / 3)) + 'a';
    const oversizedUtf8 = '界'.repeat(Math.floor(TOOL_OUTPUT_POLICY_MAXIMA.previewBytes / 3)) + 'ab';
    assert.equal(Buffer.byteLength(exactUtf8, 'utf8'), TOOL_OUTPUT_POLICY_MAXIMA.previewBytes);
    assert.equal(Buffer.byteLength(oversizedUtf8, 'utf8'), TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1);
    const makeValidation = (
      status: 'partial' | 'unavailable', channel: 'stdout' | 'stderr', preview: string,
      declaredBytes = Buffer.byteLength(preview, 'utf8'), rawBytes = Buffer.byteLength(preview, 'utf8'), truncated = false,
    ) => {
      const stream = { bytes: rawBytes, preview, previewBytes: declaredBytes, truncated };
      const capturePreview = {
        stdout: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
        stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
        diagnostics: [] as string[], diagnosticsTruncated: false,
      };
      capturePreview[channel] = stream;
      return {
        ...base,
        local: {
          ...base.local,
          commands: [{ ...base.local.commands[0]!, captureStatus: status, capturePreview }],
        },
      };
    };
    const validatingRun = (id: string) => {
      let run = newRun(id);
      run = applyTransition(run, { type: 'start' }, T0);
      return applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha }, T0);
    };
    let storedRun: Run | undefined;

    for (const status of ['partial', 'unavailable'] as const) {
      for (const channel of ['stdout', 'stderr'] as const) {
        for (const [label, preview] of [['empty', ''], ['exact ASCII', exactAscii], ['exact UTF-8', exactUtf8]] as const) {
          const validation = makeValidation(status, channel, preview);
          assert.equal(isValidationResultCoherent(validation), true, `${status}/${channel} accepts ${label}`);
          const next = applyTransition(validatingRun(`fallback-preview-${status}-${channel}-${label.replaceAll(' ', '-')}`), {
            type: 'validation_passed', validationResult: validation,
            pullRequest: { number: 7, headSha },
          }, T0);
          assert.equal(next.state, 'REVIEWING', `${status}/${channel} admits ${label} through the state machine`);
          if (label === 'exact ASCII' && status === 'partial' && channel === 'stdout') storedRun = next;
        }
        const truncatedPrefix = makeValidation(status, channel, 'retained-prefix', undefined, 128, true);
        assert.equal(isValidationResultCoherent(truncatedPrefix), true,
          `${status}/${channel} accepts an exact valid truncated prefix whose preview does not exceed observed bytes`);
        const truncatedRun = applyTransition(validatingRun(`fallback-truncated-${status}-${channel}`), {
          type: 'validation_passed', validationResult: truncatedPrefix,
          pullRequest: { number: 7, headSha },
        }, T0);
        assert.equal(truncatedRun.state, 'REVIEWING', `${status}/${channel} admits a valid truncated prefix`);

        const largeTruncatedPrefix = makeValidation(status, channel, 'retained-prefix', undefined,
          TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1, true);
        assert.equal(isValidationResultCoherent(largeTruncatedPrefix), true,
          `${status}/${channel} accepts a truthful truncated stream above the policy preview maximum`);
        const largeTruncatedRun = applyTransition(validatingRun(`fallback-large-truncated-${status}-${channel}`), {
          type: 'validation_passed', validationResult: largeTruncatedPrefix,
          pullRequest: { number: 7, headSha },
        }, T0);
        assert.equal(largeTruncatedRun.state, 'REVIEWING',
          `${status}/${channel} admits a truthful over-limit raw stream with a bounded retained preview`);

        const rejected: Array<{ name: string; preview: string; declared?: number; raw?: number }> = [
          { name: 'oversized ASCII', preview: 'x'.repeat(TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1) },
          { name: 'oversized UTF-8', preview: oversizedUtf8 },
          { name: '1MiB', preview: 'm'.repeat(1_048_576) },
          { name: 'negative declared count', preview: 'x', declared: -1 },
          { name: 'fractional declared count', preview: 'x', declared: 1.5 },
          { name: 'unsafe declared count', preview: 'x', declared: Number.MAX_SAFE_INTEGER + 1 },
          { name: 'mismatched declared count', preview: 'xy', declared: 1 },
          { name: 'preview count exceeds zero observed bytes', preview: 'x', raw: 0 },
          { name: 'UTF-8 preview count exceeds one observed byte', preview: '😀', raw: 1 },
          { name: 'over-policy bytes without truncation flag', preview: 'x', raw: TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1 },
        ];
        for (const candidate of rejected) {
          const validation = makeValidation(status, channel, candidate.preview, candidate.declared, candidate.raw);
          assert.equal(isValidationResultCoherent(validation), false,
            `${status}/${channel} rejects ${candidate.name}`);
          assert.throws(() => applyTransition(validatingRun(`invalid-preview-${status}-${channel}-${candidate.name.replaceAll(' ', '-')}`), {
            type: 'validation_passed', validationResult: validation,
            pullRequest: { number: 7, headSha },
          }, T0), /coherent|conflicts/, `${status}/${channel} rejects ${candidate.name} at state-machine admission`);
        }
      }
    }

    assert.ok(storedRun, 'exact-boundary fallback validation reached Run state');
    const { store, dir } = tempStore();
    store.create(storedRun);
    assert.deepEqual(store.read(storedRun.id)?.validationResult, storedRun.validationResult,
      'legitimate exact-boundary fallback evidence survives JSON create/read');

    const runPath = path.join(dir, `${storedRun.id}.json`);
    const invalidValidations = [
      makeValidation('unavailable', 'stderr', 'x'.repeat(TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1)),
      makeValidation('unavailable', 'stderr', 'corrupt-retained-prefix',
        Buffer.byteLength('corrupt-retained-prefix'), TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1, false),
    ];
    for (const [index, invalidValidation] of invalidValidations.entries()) {
      const invalidBytes: string = JSON.stringify({ ...storedRun, validationResult: invalidValidation });
      writeFileSync(runPath, invalidBytes, 'utf8');
      assert.throws(() => store.read(storedRun.id), /corrupt or incompatible/);
      assert.equal(readFileSync(runPath, 'utf8'), invalidBytes,
        `rejected persisted fallback read ${index} preserves original malformed preview bytes`);
      assert.throws(() => store.updateIfUnchanged!(storedRun, storedRun), /corrupt or incompatible/,
        `CAS rejects corrupt existing fallback evidence ${index} before writing`);
      assert.equal(readFileSync(runPath, 'utf8'), invalidBytes,
        `rejected fallback CAS ${index} preserves original malformed preview bytes`);
    }
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
