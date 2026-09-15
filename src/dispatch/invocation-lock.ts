import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

export interface DispatchInvocationLockOptions {
  readonly lockPath: string;
  readonly nonce?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
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
    const existing = (() => {
      try { return parseLock(readFileSync(options.lockPath, 'utf8')); } catch { return null; }
    })();
    if (existing === null || alive(existing.pid)) throw new DispatchInvocationLockedError(options.lockPath);
    try { unlinkSync(options.lockPath); } catch { throw new DispatchInvocationLockedError(options.lockPath); }
    if (!acquire()) throw new DispatchInvocationLockedError(options.lockPath);
  }

  return {
    release() {
      const current = (() => {
        try { return parseLock(readFileSync(options.lockPath, 'utf8')); } catch { return null; }
      })();
      if (current?.nonce !== nonce) return;
      try { unlinkSync(options.lockPath); } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
    },
  };
}
