import assert from 'node:assert/strict';
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertSafeAccountOwnedPath } from '../src/account-home.js';

function fixture(): { readonly root: string; readonly home: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-account-home-'));
  const home = path.join(root, 'account');
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const conductor = path.join(home, '.tachiko-conductor');
  mkdirSync(conductor, { mode: 0o755 });
  chmodSync(conductor, 0o755);
  for (const [name, mode] of [['runs', 0o755], ['dispatch', 0o755], ['mission-admission', 0o700]] as const) {
    mkdirSync(path.join(conductor, name), { mode });
    chmodSync(path.join(conductor, name), mode);
  }
  mkdirSync(path.join(conductor, 'mission-admission', 'heartbeat-receipts'), { mode: 0o700 });
  chmodSync(path.join(conductor, 'mission-admission', 'heartbeat-receipts'), 0o700);
  writeFileSync(path.join(conductor, 'runs', 'run.json'), '{}\n', { mode: 0o644 });
  writeFileSync(path.join(conductor, 'runs', 'run.lock.history.json'), '{}\n', { mode: 0o644 });
  writeFileSync(path.join(conductor, 'mission-admission', 'registry.json'), '{}\n', { mode: 0o600 });
  writeFileSync(path.join(conductor, 'dispatch', 'once.lock'), '{}\n', { mode: 0o600 });
  return { root, home };
}

function withForeignLstatUid<T>(targetPath: string, operation: () => T): T {
  const mutableFs = fs as { lstatSync: typeof fs.lstatSync };
  const original = mutableFs.lstatSync;
  const physicalTarget = realpathSync.native(targetPath);
  mutableFs.lstatSync = ((filePath: Parameters<typeof fs.lstatSync>[0]) => {
    const stats = original(filePath);
    if (path.resolve(String(filePath)) === physicalTarget) {
      Object.defineProperty(stats, 'uid', { configurable: true, value: stats.uid + 100_000 });
    }
    return stats;
  }) as typeof fs.lstatSync;
  syncBuiltinESMExports();
  try { return operation(); } finally {
    mutableFs.lstatSync = original;
    syncBuiltinESMExports();
  }
}

describe('account-owned path permissions', () => {
  it('accepts root-owned sticky temp ancestors, safe 0755 run ancestry, 0644 Run JSON, and private authorities', () => {
    const f = fixture();
    try {
      assertSafeAccountOwnedPath(f.home, path.join(f.home, '.tachiko-conductor', 'runs'), 'directory');
      assertSafeAccountOwnedPath(f.home, path.join(f.home, '.tachiko-conductor', 'runs', 'run.json'), 'file');
      assertSafeAccountOwnedPath(f.home, path.join(f.home, '.tachiko-conductor', 'runs', 'run.lock.history.json'), 'file');
      assertSafeAccountOwnedPath(f.home, path.join(f.home, '.tachiko-conductor', 'mission-admission', 'registry.json'), 'file');
      assertSafeAccountOwnedPath(f.home, path.join(f.home, '.tachiko-conductor', 'dispatch', 'once.lock'), 'file');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects writable physical home and conductor ancestors without changing them', () => {
    const f = fixture();
    try {
      const home = path.join(f.home, '.tachiko-conductor');
      chmodSync(f.root, 0o777);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(home, 'runs'), 'directory'), /Unsafe/);
      assert.equal(statSync(f.root).mode & 0o777, 0o777, 'unsafe ancestor is rejected without repair');
      chmodSync(f.root, 0o1777);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(home, 'runs'), 'directory'), /Unsafe/,
        'a sticky writable ancestor is permitted only when root-owned');
      chmodSync(f.root, 0o700);
      chmodSync(home, 0o775);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(home, 'runs'), 'directory'), /Unsafe/);
      chmodSync(home, 0o755);
      chmodSync(f.home, 0o777);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(home, 'runs'), 'directory'), /Unsafe/);
      assert.equal(statSync(f.home).mode & 0o777, 0o777);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects writable run directories, non-private receipt directories, and exposed authority files', () => {
    const f = fixture();
    try {
      const conductor = path.join(f.home, '.tachiko-conductor');
      chmodSync(path.join(conductor, 'runs'), 0o777);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(conductor, 'runs'), 'directory'), /Unsafe/);
      chmodSync(path.join(conductor, 'runs'), 0o755);
      const exposedReceipts = path.join(conductor, 'mission-admission', 'heartbeat-receipts');
      chmodSync(exposedReceipts, 0o755);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, exposedReceipts, 'directory'), /Unsafe/);
      chmodSync(exposedReceipts, 0o700);
      chmodSync(path.join(conductor, 'mission-admission'), 0o755);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(conductor, 'mission-admission', 'registry.json'), 'file'), /Unsafe/);
      chmodSync(path.join(conductor, 'mission-admission'), 0o700);
      chmodSync(path.join(conductor, 'mission-admission', 'registry.json'), 0o644);
      assert.throws(() => assertSafeAccountOwnedPath(f.home, path.join(conductor, 'mission-admission', 'registry.json'), 'file'), /Unsafe/);
      const mutationLock = path.join(conductor, 'runs', 'run.json.mutation.lock');
      writeFileSync(mutationLock, '{}\n', { mode: 0o644 });
      assert.throws(() => assertSafeAccountOwnedPath(f.home, mutationLock, 'file'), /Unsafe/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  it('rejects foreign-owned conductor intermediates and authority endpoints without repairing them', () => {
    const cases = [
      { relative: '.tachiko-conductor', endpoint: 'directory' as const },
      { relative: '.tachiko-conductor/mission-admission/registry.json', endpoint: 'file' as const },
      { relative: '.tachiko-conductor/runs/run.json', endpoint: 'file' as const },
      { relative: '.tachiko-conductor/dispatch/once.lock', endpoint: 'file' as const },
    ];
    for (const { relative, endpoint } of cases) {
      const f = fixture();
      try {
        const target = path.join(f.home, relative);
        const beforeBytes = endpoint === 'file' ? readFileSync(target) : null;
        const before = statSync(target);
        assert.throws(() => withForeignLstatUid(target, () => assertSafeAccountOwnedPath(f.home, target, endpoint)), /Unsafe/);
        assert.equal(statSync(target).mode & 0o7777, before.mode & 0o7777, relative);
        assert.equal(statSync(target).mtimeMs, before.mtimeMs, relative);
        if (beforeBytes !== null) assert.deepEqual(readFileSync(target), beforeBytes, relative);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    }
  });
});
