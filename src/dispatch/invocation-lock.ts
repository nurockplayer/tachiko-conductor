import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';

export class DispatchInvocationLockedError extends Error {
  constructor(lockPath: string) {
    super(`A same-host dispatch invocation already owns ${lockPath}; leaving it undisturbed.`);
    this.name = 'DispatchInvocationLockedError';
  }
}

interface LegacyLockRecord {
  readonly nonce: string;
  readonly pid: number;
}

interface VersionedLockRecord extends LegacyLockRecord {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly bootId: string;
  readonly processStartId: string;
}

type LockRecord = LegacyLockRecord | VersionedLockRecord;
type TakeoverClaim = LockRecord;

export interface DispatchInvocationIdentity {
  readonly hostId: string;
  readonly bootId: string;
}

export interface DispatchInvocationLockOptions {
  readonly lockPath: string;
  readonly nonce?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test seams for deterministic identity and stale-takeover interleavings. */
  readonly hostBootIdentity?: () => DispatchInvocationIdentity;
  readonly processStartIdentity?: (pid: number) => string | null;
  readonly beforeCanonicalLink?: () => void;
  readonly syncDirectory?: (directory: string) => void;
  readonly beforeStaleTakeover?: () => void;
}

export interface DispatchInvocationLock {
  release(): void;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validLegacyRecord(value: Record<string, unknown>): value is Record<string, unknown> & LegacyLockRecord {
  return exactKeys(value, ['nonce', 'pid']) && typeof value.nonce === 'string' && value.nonce !== '' &&
    value.nonce.length <= 256 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0;
}

function validVersionedRecord(value: Record<string, unknown>): value is Record<string, unknown> & VersionedLockRecord {
  return exactKeys(value, ['schemaVersion', 'nonce', 'pid', 'hostId', 'bootId', 'processStartId']) &&
    value.schemaVersion === 1 && typeof value.nonce === 'string' && value.nonce !== '' && value.nonce.length <= 256 &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    typeof value.hostId === 'string' && /^[0-9a-f]{64}$/.test(value.hostId) &&
    typeof value.bootId === 'string' && /^[0-9a-f]{64}$/.test(value.bootId) &&
    typeof value.processStartId === 'string' && value.processStartId.length > 0 && value.processStartId.length <= 256;
}

function parseLock(raw: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (validVersionedRecord(record)) {
      return {
        schemaVersion: 1, nonce: record.nonce, pid: record.pid,
        hostId: record.hostId, bootId: record.bootId, processStartId: record.processStartId,
      };
    }
    if (validLegacyRecord(record)) return { nonce: record.nonce, pid: record.pid };
    return null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code !== 'ESRCH';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000, maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return '';
  return result.stdout.trim();
}

function currentHostBootIdentity(): DispatchInvocationIdentity {
  let hostRaw: string;
  let bootRaw: string;
  if (process.platform === 'darwin') {
    const ioreg = commandOutput('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    hostRaw = ioreg.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? '';
    bootRaw = commandOutput('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  } else if (process.platform === 'linux') {
    try {
      hostRaw = readFileSync('/etc/machine-id', 'utf8').trim();
      bootRaw = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      hostRaw = '';
      bootRaw = '';
    }
  } else {
    throw new Error('Dispatch invocation lock requires a supported host identity source.');
  }
  if (!hostRaw || !bootRaw) throw new Error('Dispatch invocation lock could not establish host and boot identity.');
  return { hostId: sha256(hostRaw), bootId: sha256(bootRaw) };
}

function currentProcessStartIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const endOfCommand = stat.lastIndexOf(')');
      if (endOfCommand < 0) return null;
      const fieldsAfterCommand = stat.slice(endOfCommand + 1).trim().split(/\s+/);
      // Linux proc stat fields after comm start at field 3; starttime is field 22.
      const startTicks = fieldsAfterCommand[19];
      return startTicks ? `linux-start-ticks:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const started = commandOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    return started ? `darwin-ps-start-utc:${started}` : null;
  }
  return null;
}

function sameLockRecord(left: LockRecord, right: LockRecord): boolean {
  if (left.nonce !== right.nonce || left.pid !== right.pid) return false;
  if (!('schemaVersion' in left) || !('schemaVersion' in right)) {
    return !('schemaVersion' in left) && !('schemaVersion' in right);
  }
  return left.schemaVersion === right.schemaVersion && left.hostId === right.hostId &&
    left.bootId === right.bootId && left.processStartId === right.processStartId;
}

function staleTakeoverPath(lockPath: string, record: LockRecord): string {
  const identity = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  return `${lockPath}.${identity}.stale-takeover`;
}

function staleTakeoverRecoveryPath(takeoverPath: string, previousClaim: TakeoverClaim): string {
  const identity = createHash('sha256').update(JSON.stringify(previousClaim)).digest('hex');
  return `${takeoverPath}.${identity}.recovery`;
}

function parseTakeoverClaim(raw: string): TakeoverClaim | null {
  return parseLock(raw);
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const stats = lstatSync(lockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return parseLock(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function readSymlinkTakeoverClaim(takeoverPath: string): TakeoverClaim | null {
  try {
    return parseTakeoverClaim(readlinkSync(takeoverPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * PR #44's first implementation used a hard link to the stale lock as its
 * takeover claim. Recognize only that exact legacy shape: the claim must still
 * alias the exact stale lock record we observed. It remains immutable and a
 * successor symlink claim owns the recovery, so a concurrent wake cannot
 * unlink a replacement claim by pathname.
 */
function readLegacyHardLinkTakeoverClaim(
  takeoverPath: string,
  lockPath: string,
  expectedLock: LockRecord,
): TakeoverClaim | null {
  try {
    const claimStats = lstatSync(takeoverPath);
    const lockStats = lstatSync(lockPath);
    if (!claimStats.isFile() || claimStats.isSymbolicLink() ||
        !lockStats.isFile() || lockStats.isSymbolicLink() ||
        claimStats.dev !== lockStats.dev || claimStats.ino !== lockStats.ino) return null;
    const claim = parseTakeoverClaim(readFileSync(takeoverPath, 'utf8'));
    return claim !== null && sameLockRecord(claim, expectedLock) ? claim : null;
  } catch {
    return null;
  }
}

function readTakeoverClaim(takeoverPath: string, lockPath: string, expectedLock: LockRecord): TakeoverClaim | null {
  try {
    return parseTakeoverClaim(readlinkSync(takeoverPath, 'utf8'));
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'EINVAL') return null;
    return readLegacyHardLinkTakeoverClaim(takeoverPath, lockPath, expectedLock);
  }
}

function sameTakeoverClaim(left: TakeoverClaim, right: TakeoverClaim): boolean {
  return sameLockRecord(left, right);
}

function createTakeoverClaim(takeoverPath: string, claim: TakeoverClaim): boolean {
  try {
    // The symlink target is immutable ownership metadata created atomically
    // with the claim pathname. It is deliberately not followed or trusted as
    // a filesystem location.
    symlinkSync(JSON.stringify(claim), takeoverPath);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') return false;
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function definitelyStale(
  record: LockRecord,
  alive: (pid: number) => boolean,
  identity: () => DispatchInvocationIdentity,
  processStart: (pid: number) => string | null,
): boolean {
  if (!('schemaVersion' in record)) return !alive(record.pid);
  try {
    const current = identity();
    if (record.hostId !== current.hostId) return false;
    if (record.bootId !== current.bootId) return true;
    const currentStart = processStart(record.pid);
    if (currentStart !== null && currentStart !== record.processStartId &&
        compatibleProcessStartSchemes(record.processStartId, currentStart)) return true;
    return !alive(record.pid);
  } catch {
    return false;
  }
}

function compatibleProcessStartSchemes(recorded: string, current: string): boolean {
  const trustedSchemes = ['linux-start-ticks:', 'darwin-ps-start-utc:'];
  const recordedScheme = trustedSchemes.find((scheme) => recorded.startsWith(scheme));
  const currentScheme = trustedSchemes.find((scheme) => current.startsWith(scheme));
  return recordedScheme !== undefined && recordedScheme === currentScheme;
}

/** Acquire the small same-host fence that complements the GitHub claim lease. */
export function acquireDispatchInvocationLock(options: DispatchInvocationLockOptions): DispatchInvocationLock {
  if (!path.isAbsolute(options.lockPath)) throw new Error('TACHIKO_DISPATCH_LOCK_PATH must be an absolute path.');
  const makeNonce = options.nonce ?? randomUUID;
  const alive = options.isProcessAlive ?? processAlive;
  const identity = options.hostBootIdentity ?? currentHostBootIdentity;
  const processStart = options.processStartIdentity ?? currentProcessStartIdentity;
  const nonce = makeNonce();
  const hostBoot = identity();
  const ownProcessStart = processStart(process.pid);
  if (!nonce || nonce.length > 256 ||
      !/^[0-9a-f]{64}$/.test(hostBoot.hostId) || !/^[0-9a-f]{64}$/.test(hostBoot.bootId) ||
      !ownProcessStart || ownProcessStart.length > 256) {
    throw new Error('Dispatch invocation lock could not establish a valid owner incarnation.');
  }
  const owner: VersionedLockRecord = {
    schemaVersion: 1, nonce, pid: process.pid,
    hostId: hostBoot.hostId, bootId: hostBoot.bootId, processStartId: ownProcessStart,
  };

  const fsyncParent = () => (options.syncDirectory ?? fsyncDirectory)(path.dirname(options.lockPath));
  const publish = (): boolean => {
    const directory = path.dirname(options.lockPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${options.lockPath}.tmp-${randomBytes(16).toString('hex')}`;
    let descriptor: number | undefined;
    let linked = false;
    let failure: unknown;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      const data = Buffer.from(JSON.stringify(owner), 'utf8');
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(descriptor, data, offset, data.length - offset, null);
        if (written <= 0) throw new Error('Dispatch invocation lock owner record write was incomplete.');
        offset += written;
      }
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      options.beforeCanonicalLink?.();
      try {
        linkSync(tempPath, options.lockPath);
        linked = true;
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') return false;
        throw error;
      }
      fsyncParent();
      return true;
    } catch (error) {
      failure = error;
      if (linked) {
        try {
          const canonicalStats = lstatSync(options.lockPath);
          const tempStats = lstatSync(tempPath);
          if (canonicalStats.isFile() && !canonicalStats.isSymbolicLink() &&
              tempStats.isFile() && !tempStats.isSymbolicLink() &&
              canonicalStats.dev === tempStats.dev && canonicalStats.ino === tempStats.ino) {
            unlinkSync(options.lockPath);
            fsyncParent();
          }
        } catch {
          // Preserve the publication error; cleanup must never remove an
          // unverified successor or turn an uncertain fsync into success.
        }
      }
      throw error;
    } finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch (error) { if (failure === undefined) throw error; }
      }
      try { unlinkSync(tempPath); } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') {
          if (failure === undefined) throw error;
        }
      }
    }
  };

  if (!publish()) {
    const existing = readLock(options.lockPath);
    if (existing === null || !definitelyStale(existing, alive, identity, processStart)) {
      throw new DispatchInvocationLockedError(options.lockPath);
    }
    options.beforeStaleTakeover?.();

    // Each claimant is a versioned, immutable symlink target. A dead claimant
    // remains in place and a successor claims its deterministic recovery path,
    // avoiding check-then-unlink of a replacement owner.
    const takeoverRootPath = staleTakeoverPath(options.lockPath, existing);
    let takeoverPath = takeoverRootPath;
    const claim = owner;
    const visitedTakeoverPaths = new Set<string>();
    while (true) {
      if (visitedTakeoverPaths.has(takeoverPath)) {
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      visitedTakeoverPaths.add(takeoverPath);
      if (!createTakeoverClaim(takeoverPath, claim)) {
        const previousClaim = readTakeoverClaim(takeoverPath, options.lockPath, existing);
        if (previousClaim === null || !definitelyStale(previousClaim, alive, identity, processStart)) {
          throw new DispatchInvocationLockedError(options.lockPath);
        }
        takeoverPath = staleTakeoverRecoveryPath(takeoverRootPath, previousClaim);
        continue;
      }
      const current = readLock(options.lockPath);
      if (current === null || !sameLockRecord(current, existing) ||
          !definitelyStale(current, alive, identity, processStart)) {
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      try {
        unlinkSync(options.lockPath);
        fsyncParent();
      } catch {
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      if (!publish()) throw new DispatchInvocationLockedError(options.lockPath);
      break;
    }
    if (!sameLockRecord(readLock(options.lockPath) ?? { nonce: '', pid: 0 }, owner)) {
      throw new DispatchInvocationLockedError(options.lockPath);
    }
  }

  return {
    release() {
      const current = readLock(options.lockPath);
      if (current === null || !sameLockRecord(current, owner)) return;
      try {
        unlinkSync(options.lockPath);
        fsyncParent();
      } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
    },
  };
}
