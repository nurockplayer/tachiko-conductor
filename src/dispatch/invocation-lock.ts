import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class DispatchInvocationLockedError extends Error {
  constructor(lockPath: string) {
    super(`A same-host dispatch invocation already owns ${lockPath}; leaving it undisturbed.`);
    this.name = 'DispatchInvocationLockedError';
  }
}

interface LockRecord {
  readonly nonce: string;
  readonly pid: number;
}

interface TakeoverClaim {
  readonly nonce: string;
  readonly pid: number;
}

export interface DispatchInvocationLockOptions {
  readonly lockPath: string;
  readonly nonce?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test seam for deterministic stale-takeover interleavings. */
  readonly beforeStaleTakeover?: () => void;
}

export interface DispatchInvocationLock {
  release(): void;
}

function parseLock(raw: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return typeof record.nonce === 'string' && record.nonce !== '' && Number.isSafeInteger(record.pid) && (record.pid as number) > 0
      ? { nonce: record.nonce, pid: record.pid as number }
      : null;
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

function sameLockRecord(left: LockRecord, right: LockRecord): boolean {
  return left.nonce === right.nonce && left.pid === right.pid;
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
    const claimStats = statSync(takeoverPath);
    const lockStats = statSync(lockPath);
    if (!claimStats.isFile() || claimStats.dev !== lockStats.dev || claimStats.ino !== lockStats.ino) return null;
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
  return left.nonce === right.nonce && left.pid === right.pid;
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

function removeOwnedTakeoverClaim(takeoverPath: string, claim: TakeoverClaim): boolean {
  const current = readSymlinkTakeoverClaim(takeoverPath);
  if (current === null || !sameTakeoverClaim(current, claim)) return false;
  try {
    unlinkSync(takeoverPath);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the small same-host fence that complements the GitHub claim lease. */
export function acquireDispatchInvocationLock(options: DispatchInvocationLockOptions): DispatchInvocationLock {
  if (!path.isAbsolute(options.lockPath)) throw new Error('TACHIKO_DISPATCH_LOCK_PATH must be an absolute path.');
  const makeNonce = options.nonce ?? (() => crypto.randomUUID());
  const alive = options.isProcessAlive ?? processAlive;
  const nonce = makeNonce();
  const acquire = (): boolean => {
    mkdirSync(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
    let descriptor: number;
    try {
      descriptor = openSync(options.lockPath, 'wx', 0o600);
    } catch (error: unknown) {
      if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'EEXIST') throw error;
      return false;
    }
    try {
      writeFileSync(descriptor, JSON.stringify({ nonce, pid: process.pid }), { encoding: 'utf8' });
    } catch (error) {
      try { unlinkSync(options.lockPath); } catch { /* preserve the original write failure */ }
      throw error;
    } finally {
      closeSync(descriptor);
    }
    return true;
  };

  if (!acquire()) {
    const existing = readLock(options.lockPath);
    if (existing === null || alive(existing.pid)) throw new DispatchInvocationLockedError(options.lockPath);
    options.beforeStaleTakeover?.();

    // An atomically-created symlink claim serializes stale recovery. Unlike a
    // hard link to the stale lock, it records its own owner. A later wake
    // leaves a dead claim immutable and claims its deterministic successor,
    // rather than using a check-then-unlink that could delete a newly-created
    // live claim between those two operations.
    const takeoverRootPath = staleTakeoverPath(options.lockPath, existing);
    let takeoverPath = takeoverRootPath;
    const claim = { nonce, pid: process.pid };
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (!createTakeoverClaim(takeoverPath, claim)) {
        const previousClaim = readTakeoverClaim(takeoverPath, options.lockPath, existing);
        if (previousClaim === null || alive(previousClaim.pid)) {
          throw new DispatchInvocationLockedError(options.lockPath);
        }
        takeoverPath = staleTakeoverRecoveryPath(takeoverRootPath, previousClaim);
        continue;
      }
      try {
        const current = readLock(options.lockPath);
        if (current === null || !sameLockRecord(current, existing) || alive(current.pid)) {
          throw new DispatchInvocationLockedError(options.lockPath);
        }
        try {
          unlinkSync(options.lockPath);
        } catch {
          throw new DispatchInvocationLockedError(options.lockPath);
        }
        if (!acquire()) throw new DispatchInvocationLockedError(options.lockPath);
        break;
      } finally {
        removeOwnedTakeoverClaim(takeoverPath, claim);
      }
    }
    if (readLock(options.lockPath)?.nonce !== nonce) throw new DispatchInvocationLockedError(options.lockPath);
  }

  return {
    release() {
      const current = readLock(options.lockPath);
      if (current?.nonce !== nonce) return;
      try { unlinkSync(options.lockPath); } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
    },
  };
}
