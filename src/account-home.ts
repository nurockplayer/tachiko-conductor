import os from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export type AccountPathEndpoint = 'file' | 'directory';

function effectiveAccountUid(): number {
  const account = os.userInfo();
  const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : account.uid;
  const realUid = typeof process.getuid === 'function' ? process.getuid() : effectiveUid;
  if (realUid !== effectiveUid || account.uid !== effectiveUid) {
    throw new Error('OS account identity is inconsistent.');
  }
  return effectiveUid;
}

function lstatIfPresent(filePath: string) {
  try { return lstatSync(filePath); } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertPhysicalHomeAncestors(home: string, accountUid: number): void {
  const root = path.parse(home).root;
  const components = home.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  const ancestors = [root];
  for (const component of components) {
    current = path.join(current, component);
    ancestors.push(current);
  }
  for (const ancestor of ancestors) {
    const stats = lstatSync(ancestor);
    const mode = stats.mode & 0o7777;
    const stickyRootDirectory = stats.uid === 0 && stats.isDirectory() && (mode & 0o1000) !== 0;
    const ownerAllowed = stats.uid === 0 || stats.uid === accountUid;
    const writableAllowed = (mode & 0o022) === 0 || stickyRootDirectory;
    if (stats.isSymbolicLink() || !stats.isDirectory() || !ownerAllowed || !writableAllowed ||
        (!stickyRootDirectory && (mode & 0o7000) !== 0) ||
        (stickyRootDirectory && (mode & 0o6000) !== 0)) {
      throw new Error(`Unsafe filesystem ownership or permissions in account-home ancestry: ${ancestor}`);
    }
  }
  const homeStats = lstatSync(home);
  if (homeStats.uid !== accountUid || (homeStats.mode & 0o7000) !== 0 || (homeStats.mode & 0o022) !== 0 ||
      (homeStats.mode & 0o700) !== 0o700) {
    throw new Error(`Unsafe ownership or permissions for the physical account home: ${home}`);
  }
}

function isPrivateAuthorityDirectory(components: readonly string[]): boolean {
  return components.includes('mission-admission') || components.includes('receipts');
}

function isPrivateAuthorityFile(components: readonly string[], name: string): boolean {
  return components.includes('mission-admission') || components.includes('receipts') ||
    name === 'once.lock' || name === 'once.lock.admission' || name.endsWith('.lock');
}

/**
 * Fail closed if any existing component below the account-owned conductor
 * root has been replaced by a symlink or the wrong filesystem object. Missing
 * descendants are allowed so first use can create them safely.
 */
export function assertSafeAccountOwnedPath(homeDirectory: string, targetPath: string, endpoint: AccountPathEndpoint): void {
  const lexicalHome = path.resolve(homeDirectory);
  const home = path.resolve(realpathSync.native(lexicalHome));
  const accountUid = effectiveAccountUid();
  assertPhysicalHomeAncestors(home, accountUid);
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
    const stats = lstatIfPresent(current);
    if (stats === null) return;
    const last = index === components.length - 1;
    if (stats.isSymbolicLink() || (last ? (endpoint === 'file' ? !stats.isFile() : !stats.isDirectory()) : !stats.isDirectory())) {
      throw new Error(`Account-owned conductor path contains a symlink (symbolic link) or wrong filesystem type: ${current}`);
    }
    const mode = stats.mode & 0o7777;
    const privateDirectory = !last || endpoint === 'directory';
    if (stats.uid !== accountUid || (mode & 0o7000) !== 0 || (mode & 0o022) !== 0) {
      throw new Error(`Unsafe ownership or permissions for account-owned conductor path: ${current}`);
    }
    if (privateDirectory) {
      const mustBePrivate = isPrivateAuthorityDirectory(components.slice(0, index + 1));
      if ((mode & 0o700) !== 0o700 || (mustBePrivate && (mode & 0o077) !== 0)) {
        throw new Error(`Unsafe directory permissions for account-owned conductor path: ${current}`);
      }
    } else {
      const name = components[index]!;
      const mustBePrivate = isPrivateAuthorityFile(components.slice(0, index), name);
      if ((mode & 0o400) !== 0o400 || (mustBePrivate && (mode & 0o077) !== 0)) {
        throw new Error(`Unsafe file permissions for account-owned conductor path: ${current}`);
      }
    }
  }
  if (components.length === 0 || current !== target) throw new Error(`Invalid account-owned conductor path: ${target}`);
}

/** Apply the account-root fence to production paths while leaving explicit, out-of-home test stores usable. */
export function assertSafeCurrentAccountPathIfApplicable(targetPath: string, endpoint: AccountPathEndpoint): void {
  const home = applicableAccountHomeForPath(targetPath);
  if (home !== null) {
    const target = path.resolve(targetPath);
    const root = path.join(home, '.tachiko-conductor');
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Account-owned conductor paths must use their canonical account-home spelling.');
    }
    assertSafeAccountOwnedPath(home, target, endpoint);
  }
}

/** Decide whether a path is canonical or physically aliases this account's conductor tree. */
export function isCurrentAccountPathApplicable(targetPath: string): boolean {
  return applicableAccountHomeForPath(targetPath) !== null;
}

function applicableAccountHomeForPath(targetPath: string): string | null {
  const target = path.resolve(targetPath);
  const physicalHome = resolveAccountHomeDirectory();
  const homes = [...new Set([path.resolve(os.userInfo().homedir), physicalHome])];
  // Keep the lexical decision first so a canonical spelling with a replaced
  // component is still checked by assertSafeAccountOwnedPath itself.
  for (const home of homes) {
    const root = path.join(home, '.tachiko-conductor');
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    physicalizeThroughDeepestExistingAncestor(target);
    return home;
  }
  const physicalTarget = physicalizeThroughDeepestExistingAncestor(target);
  for (const home of homes) {
    let physicalHomeRoot: string;
    try { physicalHomeRoot = realpathSync.native(home); } catch { continue; }
    const canonicalRoot = physicalizeThroughDeepestExistingAncestor(path.join(physicalHomeRoot, '.tachiko-conductor'));
    const root = canonicalRoot;
    const relative = path.relative(root, physicalTarget);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    // Recognize physical aliases, including aliases beneath an in-home symlink.
    // The caller rejects these spellings instead of treating them as unrelated storage.
    return home;
  }
  return null;
}

/** Resolve missing descendants without mistaking a concurrent create for an unresolved symlink. */
export function physicalizeThroughDeepestExistingAncestor(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  const maxReobservations = 3;
  let reobservations = 0;
  for (;;) {
    try {
      return path.resolve(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') throw error;
      const stats = lstatIfPresent(current);
      if (stats !== null) {
        // A safe object may have appeared after realpath observed ENOENT.
        // Reobserve it, but never reinterpret unresolved links or other types
        // as missing descendants, and never spin under continued churn.
        if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory()) ||
            reobservations >= maxReobservations) throw error;
        reobservations += 1;
        continue;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
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
    const effectiveUid = effectiveAccountUid();
    if (!account.homedir || !account.homedir.startsWith('/')) {
      throw new Error('OS account identity is inconsistent');
    }
    const home = realpathSync.native(account.homedir);
    assertPhysicalHomeAncestors(home, effectiveUid);
    return home;
  } catch {
    throw new Error('Cannot resolve the physical home directory for the effective OS account.');
  }
}
