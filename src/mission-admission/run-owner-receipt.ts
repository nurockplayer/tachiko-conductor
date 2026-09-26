import { closeSync, chmodSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafeCurrentAccountPathIfApplicable } from '../account-home.js';
import { ensureDurableDirectory, type SyncDirectoryHierarchy } from '../durable-directory.js';

import type { AdmissionToken } from './registry.js';

export type RunOwnerReceiptPhase = 'pre_execution' | 'execution_possible' | 'park_transition' | 'release_transition' | 'parked_release_transition' | 'parked' | 'released';

export interface RunOwnerReceipt {
  readonly schemaVersion: 1;
  readonly laneId: string;
  readonly missionId: string;
  readonly repository: string;
  readonly runId: string;
  readonly issue?: number;
  readonly claimId?: string;
  readonly workspace?: string;
  /** Token is retained in all prepublication transition receipts. */
  readonly token?: AdmissionToken;
  readonly generation: number;
  readonly phase: RunOwnerReceiptPhase;
  /** Durable proof that a merge release began from workflow_settled parking. */
  readonly settlementReason?: 'workflow_settled';
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }

export function validateRunOwnerReceipt(value: unknown): value is RunOwnerReceipt {
  if (!object(value)) return false;
  const allowed = ['schemaVersion', 'laneId', 'missionId', 'repository', 'runId', 'issue', 'claimId', 'workspace', 'token', 'generation', 'phase', 'settlementReason'];
  const required = ['schemaVersion', 'laneId', 'missionId', 'repository', 'runId', 'generation', 'phase'];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !required.every((key) => key in value) ||
    value.schemaVersion !== 1 || !nonEmpty(value.laneId) || !nonEmpty(value.missionId) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(String(value.repository)) ||
    !nonEmpty(value.runId) || (value.issue !== undefined && (!Number.isSafeInteger(value.issue) || (value.issue as number) < 1)) ||
    (value.claimId !== undefined && !nonEmpty(value.claimId)) || (value.workspace !== undefined && (!nonEmpty(value.workspace) || !path.isAbsolute(value.workspace))) ||
    !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
    !['pre_execution', 'execution_possible', 'park_transition', 'release_transition', 'parked_release_transition', 'parked', 'released'].includes(String(value.phase)) ||
    (value.settlementReason !== undefined && (value.settlementReason !== 'workflow_settled' || (value.phase !== 'parked_release_transition' && value.phase !== 'released')))) return false;
  if ((value.phase === 'pre_execution' || value.phase === 'execution_possible' || value.phase === 'park_transition' || value.phase === 'release_transition') !== (value.token !== undefined)) return false;
  if (value.token !== undefined && (!object(value.token) || Object.keys(value.token).sort().join(',') !== 'generation,laneId,token' ||
    value.token.laneId !== value.laneId || value.token.generation !== value.generation || !nonEmpty(value.token.token))) return false;
  if ((value.phase === 'parked' || value.phase === 'released') && value.token !== undefined) return false;
  return true;
}

function assertPrivateReceipt(filePath: string): void {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
    throw new Error(`Run owner receipt ${filePath} is not a private owner-owned 0600 regular file.`);
  }
}

export function readRunOwnerReceipt(filePath: string): RunOwnerReceipt | null {
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  try { lstatSync(filePath); } catch (error) {
    if (object(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  assertPrivateReceipt(filePath);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); } catch { throw new Error(`Run owner receipt ${filePath} is corrupt; refusing ownership recovery.`); }
  if (!validateRunOwnerReceipt(parsed)) throw new Error(`Run owner receipt ${filePath} has an unsupported or ambiguous schema; refusing recovery.`);
  return parsed;
}

export function writeRunOwnerReceipt(filePath: string, receipt: RunOwnerReceipt, options: { readonly syncDirectoryHierarchy?: SyncDirectoryHierarchy } = {}): void {
  if (!path.isAbsolute(filePath) || !validateRunOwnerReceipt(receipt)) throw new Error('Run owner receipt path or contents are invalid.');
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  const directory = path.dirname(filePath);
  ensureDurableDirectory(directory, { mode: 0o700, syncDirectoryHierarchy: options.syncDirectoryHierarchy });
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  const dirStats = lstatSync(directory);
  if (!dirStats.isDirectory() || dirStats.isSymbolicLink() || (typeof process.getuid === 'function' && dirStats.uid !== process.getuid())) throw new Error('Run owner receipt directory must be a real owner-owned directory.');
  chmodSync(directory, 0o700);
  if ((lstatSync(directory).mode & 0o777) !== 0o700) throw new Error('Run owner receipt directory must have mode 0700.');
  try { lstatSync(filePath); assertPrivateReceipt(filePath); } catch (error) {
    if (!(object(error) && error.code === 'ENOENT')) throw error;
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dirFd = openSync(directory, 'r');
  try {
    renameSync(temporary, filePath);
    fsyncSync(dirFd);
  } finally { closeSync(dirFd); }
}
