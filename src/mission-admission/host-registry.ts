import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { AdmissionStateError, MissionAdmissionRegistry, validateAdmissionConfig, type AdmissionConfig } from './registry.js';
import { dispatchWakePath, signalDispatchWake } from '../dispatch/wake.js';

export const DEFAULT_MISSION_ADMISSION_CONFIG: AdmissionConfig = {
  schemaVersion: 1,
  revision: 'mission-admission-v1',
  limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 },
};

export const MISSION_ADMISSION_PATH_ENV = 'TACHIKO_MISSION_ADMISSION_PATH';
export const MISSION_ADMISSION_CONFIG_ENV = 'TACHIKO_MISSION_ADMISSION_CONFIG';
export const MANUAL_OWNER_RECEIPTS_DIR_ENV = 'TACHIKO_MANUAL_OWNER_RECEIPTS_DIR';
export const HEARTBEAT_OWNER_RECEIPTS_DIR_ENV = 'TACHIKO_HEARTBEAT_ADMISSION_RECEIPTS_DIR';

export interface HostAdmissionResolverOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

function physicalPath(candidate: string): string {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new AdmissionStateError('Cannot resolve a physical host admission path.');
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(realpathSync.native(cursor), ...suffix);
}

export function resolveHostAdmissionPath({ env = process.env, homeDirectory = os.homedir() }: HostAdmissionResolverOptions = {}): string {
  const runsDirectory = physicalPath(env.TACHIKO_DATA_DIR ?? path.join(homeDirectory, '.tachiko-conductor', 'runs'));
  const canonicalPath = physicalPath(path.join(homeDirectory, '.tachiko-conductor', 'mission-admission', 'registry.json'));
  const candidate = env[MISSION_ADMISSION_PATH_ENV] ?? canonicalPath;
  if (!path.isAbsolute(candidate)) throw new AdmissionStateError(`${MISSION_ADMISSION_PATH_ENV} must be an absolute host path.`);
  const resolved = physicalPath(candidate);
  if (resolved !== canonicalPath) {
    throw new AdmissionStateError(`${MISSION_ADMISSION_PATH_ENV} must resolve to the canonical per-user host admission registry.`);
  }
  const relativeToRuns = path.relative(runsDirectory, resolved);
  if (relativeToRuns === '' || (!relativeToRuns.startsWith(`..${path.sep}`) && relativeToRuns !== '..' && !path.isAbsolute(relativeToRuns))) {
    throw new AdmissionStateError('Mission admission registry must be outside the per-Run data directory.');
  }
  return resolved;
}

export function resolveHostAdmissionConfig(env: NodeJS.ProcessEnv = process.env): AdmissionConfig {
  const raw = env[MISSION_ADMISSION_CONFIG_ENV];
  if (raw === undefined || raw.trim() === '') return structuredClone(DEFAULT_MISSION_ADMISSION_CONFIG);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AdmissionStateError(`${MISSION_ADMISSION_CONFIG_ENV} must contain versioned JSON configuration.`); }
  validateAdmissionConfig(value);
  return structuredClone(value);
}

export function createHostAdmissionRegistry(options: HostAdmissionResolverOptions = {}): MissionAdmissionRegistry {
  const env = options.env ?? process.env;
  return new MissionAdmissionRegistry({
    filePath: resolveHostAdmissionPath(options),
    config: resolveHostAdmissionConfig(env),
    onPublishedTransition: () => {
      const wakeEnv = { ...env, HOME: env.HOME ?? options.homeDirectory ?? os.homedir() };
      try { signalDispatchWake(dispatchWakePath(wakeEnv)); } catch { /* registry publication is authoritative; the safety poll recovers lost hints */ }
    },
  });
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveManualOwnerReceiptPath(repository: string, workspace: string, { env = process.env, homeDirectory = os.homedir() }: HostAdmissionResolverOptions = {}): string {
  if (!path.isAbsolute(workspace) || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new AdmissionStateError('Manual owner receipt requires canonical repository and absolute workspace identity.');
  const physicalWorkspace = physicalPath(workspace);
  const runsDirectory = physicalPath(env.TACHIKO_DATA_DIR ?? path.join(homeDirectory, '.tachiko-conductor', 'runs'));
  const configuredDirectory = env[MANUAL_OWNER_RECEIPTS_DIR_ENV] ?? path.join(homeDirectory, '.tachiko-conductor', 'mission-admission', 'manual-receipts');
  if (!path.isAbsolute(configuredDirectory)) throw new AdmissionStateError(`${MANUAL_OWNER_RECEIPTS_DIR_ENV} must be an absolute host path.`);
  const receiptDirectory = physicalPath(configuredDirectory);
  const receiptId = createHash('sha256').update(`${repository}\0${physicalWorkspace}`).digest('hex');
  const receiptPath = path.join(receiptDirectory, `${receiptId}.json`);
  if (containsPath(physicalWorkspace, receiptPath) || containsPath(runsDirectory, receiptPath)) {
    throw new AdmissionStateError('Manual owner receipt must be outside the repository workspace and per-Run data directory.');
  }
  return receiptPath;
}

export function resolveHeartbeatOwnerReceiptPath(repository: string, workspace: string, { env = process.env, homeDirectory = os.homedir() }: HostAdmissionResolverOptions = {}): string {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) || !path.isAbsolute(workspace)) throw new AdmissionStateError('Heartbeat admission receipt requires canonical repository and absolute workspace identity.');
  const physicalWorkspace = physicalPath(workspace);
  const runsDirectory = physicalPath(env.TACHIKO_DATA_DIR ?? path.join(homeDirectory, '.tachiko-conductor', 'runs'));
  const configuredDirectory = env[HEARTBEAT_OWNER_RECEIPTS_DIR_ENV] ?? path.join(homeDirectory, '.tachiko-conductor', 'mission-admission', 'heartbeat-receipts');
  if (!path.isAbsolute(configuredDirectory)) throw new AdmissionStateError(`${HEARTBEAT_OWNER_RECEIPTS_DIR_ENV} must be an absolute host path.`);
  const receiptDirectory = physicalPath(configuredDirectory);
  const receiptId = createHash('sha256').update(`${repository}\0${physicalWorkspace}`).digest('hex');
  const receiptPath = path.join(receiptDirectory, `${receiptId}.json`);
  if (containsPath(physicalWorkspace, receiptPath) || containsPath(runsDirectory, receiptPath)) {
    throw new AdmissionStateError('Heartbeat admission receipt must be outside the workspace and per-Run data directory.');
  }
  return receiptPath;
}
