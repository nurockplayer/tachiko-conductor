import os from 'node:os';
import { realpathSync } from 'node:fs';

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
