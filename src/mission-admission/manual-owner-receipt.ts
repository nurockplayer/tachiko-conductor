import { closeSync, chmodSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertSafeCurrentAccountPathIfApplicable } from '../account-home.js';
import { randomUUID } from 'node:crypto';

import type { AdmissionToken } from './registry.js';

export interface ManualOwnerReceipt {
  readonly schemaVersion: 1;
  readonly laneId: string;
  readonly missionId: string;
  readonly repository: string;
  readonly workspace: string;
  readonly branch: string;
  readonly checkpointSha: string;
  readonly status: 'active' | 'parking' | 'parked';
  readonly generation: number;
  readonly token?: AdmissionToken;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }

export function validateManualOwnerReceipt(value: unknown): value is ManualOwnerReceipt {
  if (!object(value)) return false;
  const keys = ['schemaVersion', 'laneId', 'missionId', 'repository', 'workspace', 'branch', 'checkpointSha', 'status', 'generation', ...(value.token === undefined ? [] : ['token'])];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || value.schemaVersion !== 1 ||
    !nonEmpty(value.laneId) || !nonEmpty(value.missionId) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(String(value.repository)) ||
    !path.isAbsolute(String(value.workspace)) || !nonEmpty(value.branch) || !/^[a-f0-9]{7,64}$/i.test(String(value.checkpointSha)) ||
    !['active', 'parking', 'parked'].includes(String(value.status)) || !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) return false;
  if (value.status === 'parked') return value.token === undefined;
  if (!object(value.token) || Object.keys(value.token).sort().join(',') !== 'generation,laneId,token' ||
    value.token.laneId !== value.laneId || value.token.generation !== value.generation || !nonEmpty(value.token.token)) return false;
  return true;
}

function assertPrivateFile(filePath: string): void {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
    throw new Error(`Manual owner receipt ${filePath} is not a private owner-owned 0600 regular file.`);
  }
}

export function readManualOwnerReceipt(filePath: string): ManualOwnerReceipt | null {
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  let exists = false;
  try { lstatSync(filePath); exists = true; } catch (error) {
    if (object(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!exists) return null;
  assertPrivateFile(filePath);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); } catch { throw new Error(`Manual owner receipt ${filePath} is corrupt; refusing ownership recovery.`); }
  if (!validateManualOwnerReceipt(parsed)) throw new Error(`Manual owner receipt ${filePath} has an unsupported or ambiguous schema; refusing ownership recovery.`);
  return parsed;
}

export function writeManualOwnerReceipt(filePath: string, receipt: ManualOwnerReceipt): void {
  if (!path.isAbsolute(filePath) || !validateManualOwnerReceipt(receipt)) throw new Error('Manual owner receipt path or contents are invalid.');
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeCurrentAccountPathIfApplicable(filePath, 'file');
  const directoryStats = lstatSync(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || (typeof process.getuid === 'function' && directoryStats.uid !== process.getuid())) throw new Error('Manual owner receipt directory must be a real owner-owned directory.');
  chmodSync(directory, 0o700);
  if ((lstatSync(directory).mode & 0o777) !== 0o700) throw new Error('Manual owner receipt directory must have mode 0700.');
  try { lstatSync(filePath); assertPrivateFile(filePath); } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error;
  }
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try {
    renameSync(temporaryPath, filePath);
    const directoryDescriptor = openSync(directory, 'r');
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } catch (error) {
    try { rmSync(temporaryPath); } catch { /* preserve original write failure */ }
    throw error;
  }
  assertPrivateFile(filePath);
}

export function removeManualOwnerReceipt(filePath: string, expected: ManualOwnerReceipt): void {
  const current = readManualOwnerReceipt(filePath);
  if (current === null || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Manual owner receipt changed during retirement; refusing to remove a different generation.');
  rmSync(filePath);
}
