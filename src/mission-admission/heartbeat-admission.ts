import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createHostAdmissionRegistry, resolveHeartbeatOwnerReceiptPath, type HostAdmissionResolverOptions } from './host-registry.js';
import { canonicalizeMissionEvidence, MissionAdmissionRegistry, type AdmissionToken } from './registry.js';

export const HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES = 8_192;
export const HEARTBEAT_ADMISSION_LANE_PREFIX = 'heartbeat:';

interface ReserveRequest {
  readonly schemaVersion: 1;
  readonly action: 'reserve';
  readonly repository: string;
  readonly workspace: string;
  readonly supervisorId: string;
}

interface InspectRequest {
  readonly schemaVersion: 1;
  readonly action: 'inspect';
  readonly repository: string;
  readonly workspace: string;
}

interface SettleRequest {
  readonly schemaVersion: 1;
  readonly action: 'settle';
  readonly repository: string;
  readonly workspace: string;
  readonly supervisorId: string;
  readonly expectedGeneration: number;
  readonly receiptId: string;
  readonly stopProof: {
    readonly childrenStopped: true;
    readonly supervisorStopped: true;
    readonly observedAt: string;
  };
}

type HeartbeatAdmissionRequest = ReserveRequest | InspectRequest | SettleRequest;

export interface HeartbeatAdmissionReceipt {
  readonly schemaVersion: 1;
  readonly laneId: string;
  readonly missionId: string;
  readonly repository: string;
  readonly workspace: string;
  readonly supervisorId: string;
  readonly receiptId: string;
  readonly status: 'active' | 'settled';
  readonly token: AdmissionToken;
}

export interface HeartbeatAdmissionOptions extends HostAdmissionResolverOptions {
  readonly registry?: MissionAdmissionRegistry;
  readonly receiptPath?: (repository: string, workspace: string) => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value) && Object.keys(value).every((key) => expected.includes(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max && !value.includes('\0');
}

function parseRequest(input: unknown): HeartbeatAdmissionRequest {
  if (!isObject(input) || input.schemaVersion !== 1 || !boundedString(input.action, 16)) throw new Error('Heartbeat admission request has an unsupported version or shape.');
  if (input.action === 'reserve' && exactKeys(input, ['schemaVersion', 'action', 'repository', 'workspace', 'supervisorId']) &&
    boundedString(input.repository, 255) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(input.repository) && path.isAbsolute(String(input.workspace)) && boundedString(input.workspace, 2_048) && boundedString(input.supervisorId, 128)) {
    return input as unknown as ReserveRequest;
  }
  if (input.action === 'inspect' && exactKeys(input, ['schemaVersion', 'action', 'repository', 'workspace']) &&
    boundedString(input.repository, 255) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(input.repository) && path.isAbsolute(String(input.workspace)) && boundedString(input.workspace, 2_048)) {
    return input as unknown as InspectRequest;
  }
  if (input.action === 'settle' && exactKeys(input, ['schemaVersion', 'action', 'repository', 'workspace', 'supervisorId', 'expectedGeneration', 'receiptId', 'stopProof']) &&
    boundedString(input.repository, 255) && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(input.repository) && path.isAbsolute(String(input.workspace)) && boundedString(input.workspace, 2_048) &&
    boundedString(input.supervisorId, 128) && Number.isSafeInteger(input.expectedGeneration) && (input.expectedGeneration as number) > 0 && typeof input.receiptId === 'string' && /^[0-9a-f-]{36}$/.test(input.receiptId) && isObject(input.stopProof) &&
    exactKeys(input.stopProof, ['childrenStopped', 'supervisorStopped', 'observedAt']) && input.stopProof.childrenStopped === true && input.stopProof.supervisorStopped === true && boundedString(input.stopProof.observedAt, 64) && Number.isFinite(Date.parse(input.stopProof.observedAt))) {
    return input as unknown as SettleRequest;
  }
  throw new Error('Heartbeat admission request is malformed or contains unsupported fields.');
}

function laneForRepositoryWorkspace(repository: string, workspace: string): string {
  return `${HEARTBEAT_ADMISSION_LANE_PREFIX}${createHash('sha256').update(`${repository}\0${workspace}`).digest('hex').slice(0, 32)}`;
}

function privateReceipt(filePath: string): HeartbeatAdmissionReceipt | null {
  let stats;
  try { stats = lstatSync(filePath); } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) throw new Error('Heartbeat admission receipt is not a private owner-owned 0600 file.');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(filePath, 'utf8')); } catch { throw new Error('Heartbeat admission receipt is corrupt.'); }
  if (!isObject(parsed) || !exactKeys(parsed, ['schemaVersion', 'laneId', 'missionId', 'repository', 'workspace', 'supervisorId', 'receiptId', 'status', 'token']) || parsed.schemaVersion !== 1 ||
    !boundedString(parsed.laneId, 256) || !boundedString(parsed.missionId, 128) || !boundedString(parsed.repository, 255) || !boundedString(parsed.workspace, 2_048) || !path.isAbsolute(parsed.workspace) || !boundedString(parsed.supervisorId, 128) ||
    typeof parsed.receiptId !== 'string' || !/^[0-9a-f-]{36}$/.test(parsed.receiptId) || !['active', 'settled'].includes(String(parsed.status)) ||
    !isObject(parsed.token) || !exactKeys(parsed.token, ['laneId', 'generation', 'token']) || parsed.token.laneId !== parsed.laneId || !Number.isSafeInteger(parsed.token.generation) || (parsed.token.generation as number) <= 0 || !boundedString(parsed.token.token, 128)) {
    throw new Error('Heartbeat admission receipt has an unsupported or ambiguous schema.');
  }
  return parsed as unknown as HeartbeatAdmissionReceipt;
}

function writeReceipt(filePath: string, receipt: HeartbeatAdmissionReceipt): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStats = lstatSync(directory);
  if (!dirStats.isDirectory() || dirStats.isSymbolicLink() || (typeof process.getuid === 'function' && dirStats.uid !== process.getuid())) throw new Error('Heartbeat receipt directory is not a real owner-owned directory.');
  if ((dirStats.mode & 0o777) !== 0o700) throw new Error('Heartbeat receipt directory must have mode 0700.');
  const existing = privateReceipt(filePath);
  if (existing !== null && existing.laneId !== receipt.laneId) throw new Error('Heartbeat receipt belongs to a different lane.');
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  try {
    renameSync(temporary, filePath);
    const dirDescriptor = openSync(directory, 'r');
    try { fsyncSync(dirDescriptor); } finally { closeSync(dirDescriptor); }
  } catch (error) {
    try { rmSync(temporary); } catch { /* preserve the publication error */ }
    throw error;
  }
  const written = lstatSync(filePath);
  if (!written.isFile() || written.isSymbolicLink() || (written.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && written.uid !== process.getuid())) throw new Error('Published heartbeat receipt failed owner-only permission checks.');
}

function statusProjection(registry: MissionAdmissionRegistry, laneId: string) {
  const snapshot = registry.snapshot();
  const lane = snapshot.lanes.find((record) => record.laneId === laneId);
  return {
    revision: snapshot.revision,
    limits: snapshot.limits,
    counts: snapshot.counts,
    lane: lane === undefined ? null : {
      laneId: lane.laneId, missionId: lane.missionId, role: lane.role, status: lane.status, generation: lane.generation,
      highAutonomy: lane.highAutonomy, ...(lane.parkedReason === undefined ? {} : { parkedReason: lane.parkedReason }),
      repository: lane.evidence.repository,
    },
    lastTransition: snapshot.lastTransition,
  };
}

type HeartbeatStatusProjection = ReturnType<typeof statusProjection>;
export type HeartbeatAdmissionResult =
  | ({ readonly schemaVersion: 1; readonly outcome: 'inspected' } & HeartbeatStatusProjection)
  | { readonly schemaVersion: 1; readonly outcome: 'reserved' | 'already_reserved'; readonly laneId: string; readonly missionId: string; readonly generation: number; readonly receiptId: string; readonly revision: number }
  | { readonly schemaVersion: 1; readonly outcome: 'waiting'; readonly laneId: string; readonly missionId: string; readonly reason: string; readonly revision: number }
  | { readonly schemaVersion: 1; readonly outcome: 'owned_elsewhere'; readonly laneId: string; readonly missionId: string; readonly reason: 'overlapping_production_lane'; readonly revision: number }
  | { readonly schemaVersion: 1; readonly outcome: 'settled'; readonly laneId: string; readonly generation: number; readonly receiptId: string; readonly revision: number };

/** Execute one strict model-free heartbeat admission operation. Only `reserved` grants a new spawn opportunity; `already_reserved` is recovery status only. Ordinary results never contain the capability token. */
export function handleHeartbeatAdmission(input: unknown, options: HeartbeatAdmissionOptions = {}): HeartbeatAdmissionResult {
  const request = parseRequest(input);
  const env = options.env ?? process.env;
  const resolverOptions = { env, ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }) };
  const registry = options.registry ?? createHostAdmissionRegistry(resolverOptions);
  const evidence = canonicalizeMissionEvidence({ repository: request.repository, repositoryScope: true, workspace: request.workspace });
  const laneId = laneForRepositoryWorkspace(evidence.repository, evidence.workspace!);
  const receiptPath = options.receiptPath?.(evidence.repository, evidence.workspace!) ?? resolveHeartbeatOwnerReceiptPath(evidence.repository, evidence.workspace!, resolverOptions);

  if (request.action === 'inspect') return { schemaVersion: 1, outcome: 'inspected', ...statusProjection(registry, laneId) };

  if (request.action === 'reserve') {
    const prior = registry.readLane(laneId);
    if (prior?.status === 'active') {
      const receipt = privateReceipt(receiptPath);
      if (receipt === null || receipt.status !== 'active' || receipt.laneId !== laneId || receipt.missionId !== prior.missionId || receipt.repository !== evidence.repository || receipt.workspace !== evidence.workspace || receipt.supervisorId !== request.supervisorId || receipt.token.generation !== prior.generation) throw new Error('Active heartbeat ownership has no matching private recovery receipt; refusing takeover.');
      registry.assertCanMutate(receipt.token);
      return { schemaVersion: 1, outcome: 'already_reserved', laneId, missionId: prior.missionId, generation: prior.generation, receiptId: receipt.receiptId, revision: registry.snapshot().revision };
    }
    const result = registry.admit({ laneId, role: 'production_captain', evidence, highAutonomy: true }, {
      beforePublish: (admitted) => writeReceipt(receiptPath, {
        schemaVersion: 1,
        laneId,
        missionId: admitted.missionId,
        repository: evidence.repository,
        workspace: evidence.workspace!,
        supervisorId: request.supervisorId,
        receiptId: randomUUID(),
        status: 'active',
        token: admitted.token,
      }),
    });
    if (result.outcome === 'admitted') {
      const receipt = privateReceipt(receiptPath);
      if (receipt === null || receipt.token.token !== result.token.token) throw new Error('Heartbeat reservation receipt was not durably published.');
      return { schemaVersion: 1, outcome: 'reserved', laneId, missionId: result.missionId, generation: result.token.generation, receiptId: receipt.receiptId, revision: result.revision };
    }
    if (result.outcome === 'parked') return { schemaVersion: 1, outcome: 'waiting', laneId, missionId: result.missionId, reason: result.reason, revision: result.revision };
    return { schemaVersion: 1, outcome: 'owned_elsewhere', laneId, missionId: result.missionId, reason: 'overlapping_production_lane', revision: result.revision };
  }

  const receipt = privateReceipt(receiptPath);
  if (receipt === null || receipt.laneId !== laneId || receipt.repository !== evidence.repository || receipt.workspace !== evidence.workspace) throw new Error('Heartbeat admission receipt is missing or does not match this repository and workspace.');
  if (request.expectedGeneration !== receipt.token.generation || request.receiptId !== receipt.receiptId || request.supervisorId !== receipt.supervisorId) throw new Error('Heartbeat admission settle receipt generation or supervisor identity does not match its private receipt.');
  const lane = registry.readLane(laneId);
  if (lane?.status === 'active' && lane.generation === receipt.token.generation) {
    registry.release(receipt.token, true, () => writeReceipt(receiptPath, { ...receipt, status: 'settled' }));
  } else if (!(lane?.status === 'released' && lane.generation === receipt.token.generation + 1 && receipt.status === 'settled')) {
    throw new Error('Heartbeat admission receipt is stale or no longer owns the active lane.');
  }
  return { schemaVersion: 1, outcome: 'settled', laneId, generation: receipt.token.generation, receiptId: receipt.receiptId, revision: registry.snapshot().revision };
}

/** Bounded JSON entry point for a supervised child process. */
export function handleHeartbeatAdmissionJson(input: string, options: HeartbeatAdmissionOptions = {}): string {
  if (Buffer.byteLength(input, 'utf8') > HEARTBEAT_ADMISSION_REQUEST_MAX_BYTES) throw new Error('Heartbeat admission request exceeds the bounded input size.');
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { throw new Error('Heartbeat admission request must be one JSON object.'); }
  return JSON.stringify(handleHeartbeatAdmission(parsed, options));
}
