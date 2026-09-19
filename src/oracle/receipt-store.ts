import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OracleReceipt, OracleReceiptStore } from './types.js';

function valid(value: unknown): value is OracleReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = new Set(['id', 'target', 'requestedHeadSha', 'observedHeadSha', 'outcome', 'reviewedAt', 'blockingFindingCount', 'nonBlockingFindingCount', 'failureCode']);
  return Object.keys(v).every((key) => keys.has(key)) && /^[A-Za-z0-9._-]+$/.test(String(v.id)) &&
    typeof v.target === 'object' && v.target !== null && typeof (v.target as Record<string, unknown>).owner === 'string' && typeof (v.target as Record<string, unknown>).repo === 'string' &&
    typeof v.requestedHeadSha === 'string' && (typeof v.observedHeadSha === 'string' || v.observedHeadSha === null) &&
    typeof v.reviewedAt === 'string' && ['approved', 'request_changes', 'failed', 'stale_head'].includes(String(v.outcome)) &&
    Number.isSafeInteger(v.blockingFindingCount) && Number.isSafeInteger(v.nonBlockingFindingCount) &&
    (v.failureCode === undefined || ['unavailable', 'unauthorized', 'timeout', 'transport_failed', 'invalid_response', 'stale_head'].includes(String(v.failureCode)));
}

export class JsonFileOracleReceiptStore implements OracleReceiptStore {
  private readonly dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); mkdirSync(this.dir, { recursive: true }); }
  record(receipt: OracleReceipt): void {
    if (!valid(receipt)) throw new Error('Invalid Oracle receipt.');
    const file = path.join(this.dir, `${receipt.id}.json`);
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  }
  list(): readonly OracleReceipt[] {
    return readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const value: unknown = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8'));
      if (!valid(value)) throw new Error(`Invalid Oracle receipt in ${name}.`);
      return value;
    });
  }
}
