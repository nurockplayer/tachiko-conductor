import os from 'node:os';
import path from 'node:path';

// Test-owned account lookup shim for subprocess fixtures. Production code never
// reads this test convention; HOME variants stay isolated below each fixture.
const fixtureHome = process.env.HOME;
const mode = new URL(import.meta.url).search;
if (mode === '?isolated=kernel-ids-v1') {
  if (!fixtureHome || !path.isAbsolute(fixtureHome)) throw new Error('Isolated account fixture requires an absolute private HOME.');
  const ids = ['getuid', 'geteuid', 'getgid', 'getegid'].map((name) => {
    if (typeof process[name] !== 'function') throw new Error('Isolated account fixture requires kernel UID and GID functions.');
    const value = process[name]();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Isolated account fixture requires safe nonnegative kernel IDs.');
    return value;
  });
  const [uid, effectiveUid, gid, effectiveGid] = ids;
  if (uid !== effectiveUid || gid !== effectiveGid) throw new Error('Isolated account fixture requires matching real and effective kernel IDs.');
  // Explicit test data only: do not consult passwd or turn a lookup error into
  // success. Numeric identity comes solely from the actual kernel functions.
  os.userInfo = (options) => {
    if (options !== undefined && (options === null || typeof options !== 'object' ||
      Reflect.ownKeys(options).some((key) => key !== 'encoding') ||
      (options.encoding !== undefined && options.encoding !== 'utf8'))) {
      throw new TypeError('Isolated account fixture supports only default or utf8 userInfo options.');
    }
    return { uid, gid, username: 'tachiko-isolated-test-account', homedir: fixtureHome, shell: '/test-fixture-shell' };
  };
} else if (mode !== '') {
  throw new Error('Unsupported account fixture mode.');
} else if (fixtureHome) {
  const userInfo = os.userInfo;
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: fixtureHome });
}
