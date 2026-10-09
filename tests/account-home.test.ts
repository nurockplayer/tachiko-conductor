import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { assertSafeAccountOwnedPath, assertSafeCurrentAccountPathIfApplicable, isCurrentAccountPathApplicable } from '../src/account-home.js';

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

  it('rejects external aliases that physically resolve into canonical conductor paths', () => {
    const f = fixture();
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.home })) as typeof os.userInfo;
      const runs = path.join(f.home, '.tachiko-conductor', 'runs');
      const alias = path.join(f.root, 'external-runs-alias');
      symlinkSync(runs, alias, 'dir');
      const inHomeAlias = path.join(f.home, 'alternate-runs-name');
      symlinkSync(runs, inHomeAlias, 'dir');
      const aliasedDirectory = path.join(alias, 'nested');
      const aliasedAuthority = path.join(alias, 'run.json');

      assert.equal(isCurrentAccountPathApplicable(aliasedDirectory), true);
      assert.throws(() => assertSafeCurrentAccountPathIfApplicable(aliasedDirectory, 'directory'), /canonical account-home spelling/);
      assert.equal(isCurrentAccountPathApplicable(aliasedAuthority), true);
      assert.throws(() => assertSafeCurrentAccountPathIfApplicable(aliasedAuthority, 'file'), /canonical account-home spelling/);
      assert.equal(isCurrentAccountPathApplicable(path.join(inHomeAlias, 'run.json')), true);
      assert.throws(() => assertSafeCurrentAccountPathIfApplicable(path.join(inHomeAlias, 'run.json'), 'file'), /canonical account-home spelling/);
      assert.equal(statSync(runs).mode & 0o777, 0o755, 'canonical directory is not repaired through the alias');
      assert.equal(readFileSync(path.join(runs, 'run.json'), 'utf8'), '{}\n');
    } finally {
      os.userInfo = originalUserInfo;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('rejects aliases to a redirected canonical root and its direct physical destination', () => {
    const f = fixture();
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.home })) as typeof os.userInfo;
      const canonical = path.join(f.home, '.tachiko-conductor');
      const physicalRoot = path.join(f.root, 'physical-conductor');
      renameSync(canonical, physicalRoot);
      symlinkSync(physicalRoot, canonical, 'dir');
      const externalAlias = path.join(f.root, 'external-runs-alias');
      symlinkSync(path.join(physicalRoot, 'runs'), externalAlias, 'dir');
      const candidates = [
        path.join(physicalRoot, 'runs', 'new', 'nested'),
        path.join(externalAlias, 'new', 'nested'),
      ];
      for (const candidate of candidates) {
        assert.equal(isCurrentAccountPathApplicable(candidate), true);
        assert.throws(() => assertSafeCurrentAccountPathIfApplicable(candidate, 'directory'), /canonical account-home spelling/);
      }
      assert.throws(() => assertSafeCurrentAccountPathIfApplicable(path.join(f.home, '.tachiko-conductor', 'runs'), 'directory'), /symbolic link/);
      assert.equal(readFileSync(path.join(physicalRoot, 'runs', 'run.json'), 'utf8'), '{}\n');
      assert.equal(existsSync(path.join(physicalRoot, 'runs', 'new')), false);
      assert.equal(statSync(physicalRoot).mode & 0o777, 0o755);
    } finally {
      os.userInfo = originalUserInfo;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails closed for aliases beneath regular files and for dangling symlink ancestors', () => {
    const f = fixture();
    const originalUserInfo = os.userInfo;
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: f.home })) as typeof os.userInfo;
      const runs = path.join(f.home, '.tachiko-conductor', 'runs');
      assert.throws(() => isCurrentAccountPathApplicable(path.join(runs, 'run.json', 'child')), (error: unknown) =>
        typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOTDIR');
      const dangling = path.join(f.root, 'dangling-alias');
      symlinkSync(path.join(f.root, 'missing-target'), dangling, 'dir');
      assert.throws(() => isCurrentAccountPathApplicable(path.join(dangling, 'runs', 'child')), /ENOENT/);
    } finally {
      os.userInfo = originalUserInfo;
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
