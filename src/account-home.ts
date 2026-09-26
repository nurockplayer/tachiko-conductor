import os from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type AccountPathEndpoint = 'file' | 'directory';

/**
 * Fail closed if any existing component below the account-owned conductor
 * root has been replaced by a symlink or the wrong filesystem object. Missing
 * descendants are allowed so first use can create them safely.
 */
export function assertSafeAccountOwnedPath(homeDirectory: string, targetPath: string, endpoint: AccountPathEndpoint): void {
  const lexicalHome = path.resolve(homeDirectory);
  const home = path.resolve(realpathSync.native(lexicalHome));
  const requestedTarget = path.resolve(targetPath);
  let relative = path.relative(lexicalHome, requestedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    relative = path.relative(home, requestedTarget);
  }
  const target = path.resolve(home, relative);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Account-owned conductor path escapes the physical account home.');
  }
  const components = relative.split(path.sep).filter(Boolean);
  if (components[0] !== '.tachiko-conductor') return;
  let current = home;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]!);
    let stats;
    try { stats = lstatSync(current); } catch (error) {
      if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const last = index === components.length - 1;
    if (stats.isSymbolicLink() || (last ? (endpoint === 'file' ? !stats.isFile() : !stats.isDirectory()) : !stats.isDirectory())) {
      throw new Error(`Account-owned conductor path contains a symlink (symbolic link) or wrong filesystem type: ${current}`);
    }
  }
  if (components.length === 0 || current !== target) throw new Error(`Invalid account-owned conductor path: ${target}`);
}

/** Apply the account-root fence to production paths while leaving explicit, out-of-home test stores usable. */
export function assertSafeCurrentAccountPathIfApplicable(targetPath: string, endpoint: AccountPathEndpoint): void {
  const home = resolveAccountHomeDirectory();
  const target = path.resolve(targetPath);
  const root = path.join(home, '.tachiko-conductor');
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  assertSafeAccountOwnedPath(home, target, endpoint);
}

/** Resolve the physical home directory of the effective OS account.
 *
 * HOME is intentionally ignored: it is process environment, not account identity.
 * If Node's account lookup disagrees with the effective UID, fail closed rather
 * than selecting a second host-global admission domain.
 */
export function resolveAccountHomeDirectory(): string {
  try {
    const account = os.userInfo();
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : account.uid;
    const realUid = typeof process.getuid === 'function' ? process.getuid() : effectiveUid;
    if (realUid !== effectiveUid || account.uid !== effectiveUid || !account.homedir || !account.homedir.startsWith('/')) {
      throw new Error('OS account identity is inconsistent');
    }
    return realpathSync.native(account.homedir);
  } catch {
    throw new Error('Cannot resolve the physical home directory for the effective OS account.');
  }
}
