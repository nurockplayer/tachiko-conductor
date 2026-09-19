import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  WAIT_OBSERVATION_REVISION,
  boundWaitLedger,
  isWaitLedger,
  migrateWaitLedger,
  type WaitLedger,
} from '../domain/wait.js';

/**
 * Durable wait-ledger persistence for issue #47.
 *
 * The ledger is reconciliation input, not workflow authority. It is written
 * atomically and may only be adopted when its subject/owner/generation match
 * the caller's durable identity, so a restart (or a second dispatcher) cannot
 * adopt a foreign ledger, create a duplicate writer, or re-emit a wake.
 */
export interface WaitLedgerStore {
  read(): WaitLedger | null;
  write(ledger: WaitLedger): void;
}

export interface WaitLedgerFileStoreOptions {
  /** Explicit absolute path to the ledger file; no repository defaults exist. */
  readonly filePath: string;
}

export class WaitLedgerCorruptionError extends Error {
  constructor(filePath: string) {
    super(`Wait ledger ${filePath} is not a valid ${WAIT_OBSERVATION_REVISION} record; refusing to overwrite it.`);
    this.name = 'WaitLedgerCorruptionError';
  }
}

/** True when a stored ledger may be adopted by this exact durable identity. */
export function waitLedgerBelongsTo(
  ledger: WaitLedger,
  identity: { readonly subjectId: string; readonly ownerRunId: string; readonly generation: string },
): boolean {
  return ledger.subjectId === identity.subjectId &&
    ledger.ownerRunId === identity.ownerRunId &&
    ledger.generation === identity.generation;
}

export class WaitLedgerFileStore implements WaitLedgerStore {
  private readonly filePath: string;

  constructor(options: WaitLedgerFileStoreOptions) {
    if (!path.isAbsolute(options.filePath)) throw new Error('Wait ledger path must be absolute.');
    this.filePath = options.filePath;
  }

  /**
   * Read the ledger. A missing file is `null`; a corrupt file fails closed
   * instead of silently discarding durable reconciliation state.
   */
  read(): WaitLedger | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new WaitLedgerCorruptionError(this.filePath);
    }
    const value = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).ledger
      : undefined;
    if (!isWaitLedger(value)) throw new WaitLedgerCorruptionError(this.filePath);
    return migrateWaitLedger(value);
  }

  /** Atomic replace; a crash leaves the previous ledger intact. */
  write(ledger: WaitLedger): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ revision: ledger.revision, ledger: boundWaitLedger(ledger) }, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.filePath);
  }

  exists(): boolean {
    try {
      return statSync(this.filePath).isFile();
    } catch {
      return false;
    }
  }

  /** Remove a rejected ledger; only used by explicit operator repair paths. */
  remove(): void {
    rmSync(this.filePath, { force: true });
  }
}
