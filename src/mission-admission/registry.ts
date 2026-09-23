import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, fsyncSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireDispatchInvocationLock, DispatchInvocationLockedError } from '../dispatch/invocation-lock.js';

export const MISSION_ADMISSION_SCHEMA_VERSION = 1 as const;
export const MISSION_ADMISSION_ROLES = ['production_captain', 'delegated_mutation_writer', 'read_only_review', 'read_only_consultation', 'isolated_experiment'] as const;
export type MissionAdmissionRole = typeof MISSION_ADMISSION_ROLES[number];
export type MissionAdmissionStatus = 'active' | 'parked' | 'released';
export type ParkedReason = 'capacity_captains' | 'capacity_writers' | 'capacity_high_autonomy' | 'capacity_repository' | 'workflow_wait' | 'workflow_settled' | 'manual_checkpoint';

export interface MissionEvidence {
  readonly repository: string;
  readonly issue?: number;
  readonly pullRequest?: number;
  readonly run?: string;
  readonly claim?: string;
  readonly workspace?: string;
  readonly stateSurface?: string;
  /** Reserves production ownership across all missions in this repository. */
  readonly repositoryScope?: true;
}

export interface AdmissionLimits {
  readonly maxCaptains: number;
  readonly maxWriters: number;
  readonly maxHighAutonomy: number;
  readonly maxPerRepository?: number;
}

export interface AdmissionConfig {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly limits: AdmissionLimits;
}

export interface AdmissionRequest {
  readonly laneId: string;
  readonly evidence: MissionEvidence;
  readonly role: MissionAdmissionRole;
  readonly highAutonomy?: boolean;
  /** Required for delegated_mutation_writer and must identify its production captain lane. */
  readonly delegatedFromLaneId?: string;
  /** Required for isolated_experiment; its mission relationship is descriptive only. */
  readonly experimentOfMissionId?: string;
}

export interface AdmissionToken {
  readonly laneId: string;
  readonly generation: number;
  readonly token: string;
}

export type AdmissionResult =
  | { readonly outcome: 'admitted'; readonly missionId: string; readonly token: AdmissionToken; readonly revision: number }
  | { readonly outcome: 'parked'; readonly missionId: string; readonly reason: ParkedReason; readonly revision: number }
  | { readonly outcome: 'duplicate'; readonly missionId: string; readonly conflictingLaneId: string; readonly revision: number };

export interface LaneRecord {
  laneId: string;
  missionId: string;
  evidence: MissionEvidence;
  role: MissionAdmissionRole;
  status: MissionAdmissionStatus;
  generation: number;
  token: string | null;
  highAutonomy: boolean;
  delegatedFromLaneId?: string;
  experimentOfMissionId?: string;
  parkedReason?: ParkedReason;
  updatedAt: string;
}

export type AdmissionLaneView = Omit<LaneRecord, 'token'>;

interface RegistryState {
  readonly schemaVersion: 1;
  revision: number;
  config: AdmissionConfig;
  lanes: LaneRecord[];
  lastTransition: { readonly kind: string; readonly laneId?: string; readonly at: string } | null;
}

export interface MissionAdmissionOptions {
  readonly filePath: string;
  readonly config: AdmissionConfig;
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
  readonly now?: () => string;
  readonly beforePublish?: () => void;
  /** Best-effort notification after a meaningful revision has been atomically published. */
  readonly onPublishedTransition?: (projection: AdmissionProjection) => void;
  /** Deterministic same-process interleaving seam for stale-lock race tests. */
  readonly beforeStaleTakeover?: () => void;
}

export class AdmissionStateError extends Error {
  override name = 'AdmissionStateError';
}

export class AdmissionLockError extends Error {
  override name = 'AdmissionLockError';
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim() !== ''; }
function safePositive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }

export function validateAdmissionConfig(value: unknown): asserts value is AdmissionConfig {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'revision', 'limits']) || value.schemaVersion !== MISSION_ADMISSION_SCHEMA_VERSION || !nonEmpty(value.revision) || !object(value.limits)) {
    throw new AdmissionStateError('Admission config has an unsupported or malformed versioned schema.');
  }
  const limits = value.limits;
  if (!Object.keys(limits).every((key) => ['maxCaptains', 'maxWriters', 'maxHighAutonomy', 'maxPerRepository'].includes(key)) ||
    !safePositive(limits.maxCaptains) || !safePositive(limits.maxWriters) || !safePositive(limits.maxHighAutonomy) ||
    (limits.maxPerRepository !== undefined && !safePositive(limits.maxPerRepository))) {
    throw new AdmissionStateError('Admission limits must be positive safe integers and contain only supported keys.');
  }
}

function canonicalRepository(value: string): string {
  const repository = value.trim().replace(/^https?:\/\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new AdmissionStateError('Repository evidence must be a canonical owner/name pair.');
  return repository;
}

function canonicalPath(value: string): string {
  if (!path.isAbsolute(value)) throw new AdmissionStateError('Workspace and state-surface evidence must use absolute paths.');
  let result = path.resolve(value);
  if (existsSync(result)) result = realpathSync.native(result);
  else {
    const suffix: string[] = [];
    let ancestor = result;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    if (existsSync(ancestor)) result = path.join(realpathSync.native(ancestor), ...suffix);
  }
  result = path.normalize(result);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

export function canonicalizeMissionEvidence(value: MissionEvidence): MissionEvidence {
  if (!object(value) || !exactKeys(value, ['repository', ...Object.keys(value).filter((key) => key !== 'repository')]) ||
    !Object.keys(value).every((key) => ['repository', 'issue', 'pullRequest', 'run', 'claim', 'workspace', 'stateSurface', 'repositoryScope'].includes(key)) || !nonEmpty(value.repository) ||
    (value.repositoryScope !== undefined && value.repositoryScope !== true)) {
    throw new AdmissionStateError('Mission evidence requires a repository and may contain only canonical identity fields.');
  }
  if (value.issue !== undefined && !safePositive(value.issue)) throw new AdmissionStateError('Issue evidence must be a positive safe integer.');
  if (value.pullRequest !== undefined && !safePositive(value.pullRequest)) throw new AdmissionStateError('Pull request evidence must be a positive safe integer.');
  for (const key of ['run', 'claim'] as const) if (value[key] !== undefined && !nonEmpty(value[key])) throw new AdmissionStateError(`${key} evidence must be non-empty.`);
  for (const key of ['workspace', 'stateSurface'] as const) if (value[key] !== undefined && !nonEmpty(value[key])) throw new AdmissionStateError(`${key} evidence must be non-empty.`);
  const result: MissionEvidence = {
    repository: canonicalRepository(value.repository),
    ...(value.issue === undefined ? {} : { issue: value.issue }),
    ...(value.pullRequest === undefined ? {} : { pullRequest: value.pullRequest }),
    ...(value.run === undefined ? {} : { run: value.run.trim() }),
    ...(value.claim === undefined ? {} : { claim: value.claim.trim() }),
    ...(value.workspace === undefined ? {} : { workspace: canonicalPath(value.workspace) }),
    ...(value.stateSurface === undefined ? {} : { stateSurface: canonicalPath(value.stateSurface) }),
    ...(value.repositoryScope === true ? { repositoryScope: true as const } : {}),
  };
  if (result.issue === undefined && result.pullRequest === undefined && result.run === undefined && result.claim === undefined && result.workspace === undefined && result.stateSurface === undefined && result.repositoryScope !== true) {
    throw new AdmissionStateError('Mission evidence requires at least one Issue, PR, Run, claim, workspace, or state surface.');
  }
  return result;
}

function evidenceIsValid(value: unknown): value is MissionEvidence {
  if (!object(value) || !nonEmpty(value.repository)) return false;
  try {
    const canonical = canonicalizeMissionEvidence(value as unknown as MissionEvidence);
    return Object.keys(value).length === Object.keys(canonical).length && Object.entries(canonical).every(([key, item]) => value[key] === item);
  } catch { return false; }
}

function sharedPhysicalSurface(a: MissionEvidence, b: MissionEvidence): boolean {
  const left = [a.workspace, a.stateSurface].filter((value): value is string => value !== undefined);
  const right = [b.workspace, b.stateSurface].filter((value): value is string => value !== undefined);
  return left.some((value) => right.includes(value));
}

function overlaps(a: MissionEvidence, b: MissionEvidence): boolean {
  // Physical workspace/state ownership is host-wide. Compare it before
  // repository labels because linked worktrees and aliases can be presented
  // with different logical repository identities.
  if (sharedPhysicalSurface(a, b)) return true;
  if (a.repository !== b.repository) return false;
  if (a.repositoryScope === true || b.repositoryScope === true) return true;
  const fields: readonly (keyof MissionEvidence)[] = ['issue', 'pullRequest', 'run', 'claim'];
  return fields.some((field) => a[field] !== undefined && b[field] !== undefined && a[field] === b[field]);
}

function deterministicMissionId(evidence: MissionEvidence): string {
  const anchor: readonly (keyof MissionEvidence)[] = ['repositoryScope', 'issue', 'pullRequest', 'run', 'claim', 'workspace', 'stateSurface'];
  const key = anchor.find((field) => evidence[field] !== undefined);
  if (!key) throw new AdmissionStateError('Mission identity is ambiguous without canonical mission evidence.');
  const digest = createHash('sha256').update(`${evidence.repository}\0${key}\0${String(evidence[key])}`).digest('hex').slice(0, 32);
  return `mission-${digest}`;
}

function validateLane(value: unknown): value is LaneRecord {
  if (!object(value)) return false;
  const allowed = ['laneId', 'missionId', 'evidence', 'role', 'status', 'generation', 'token', 'highAutonomy', 'delegatedFromLaneId', 'experimentOfMissionId', 'parkedReason', 'updatedAt'];
  const required = ['laneId', 'missionId', 'evidence', 'role', 'status', 'generation', 'token', 'highAutonomy', 'updatedAt'];
  if (!Object.keys(value).every((key) => allowed.includes(key)) || !required.every((key) => key in value) ||
    !nonEmpty(value.laneId) || !nonEmpty(value.missionId) || !evidenceIsValid(value.evidence) ||
    !(MISSION_ADMISSION_ROLES as readonly unknown[]).includes(value.role) || !['active', 'parked', 'released'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.generation) || (value.generation as number) <= 0 ||
    !(value.token === null || nonEmpty(value.token)) || typeof value.highAutonomy !== 'boolean' || !nonEmpty(value.updatedAt)) return false;
  if (value.status === 'active' && (value.token === null || value.generation === 0)) return false;
  if (value.status !== 'active' && value.token !== null) return false;
  if (value.role === 'delegated_mutation_writer' && !nonEmpty(value.delegatedFromLaneId)) return false;
  if (value.role !== 'delegated_mutation_writer' && value.delegatedFromLaneId !== undefined) return false;
  if (value.role === 'isolated_experiment' && !nonEmpty(value.experimentOfMissionId)) return false;
  if (value.role !== 'isolated_experiment' && value.experimentOfMissionId !== undefined) return false;
  if (value.parkedReason !== undefined && !['capacity_captains', 'capacity_writers', 'capacity_high_autonomy', 'capacity_repository', 'workflow_wait', 'workflow_settled', 'manual_checkpoint'].includes(String(value.parkedReason))) return false;
  if ((value.status === 'parked') !== (value.parkedReason !== undefined)) return false;
  return true;
}

function initialState(config: AdmissionConfig): RegistryState {
  return { schemaVersion: 1, revision: 0, config: structuredClone(config), lanes: [], lastTransition: null };
}

function validateState(value: unknown): RegistryState {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'revision', 'config', 'lanes', 'lastTransition']) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.lanes)) throw new AdmissionStateError('Admission registry is corrupt or has an unsupported schema.');
  validateAdmissionConfig(value.config);
  if (!value.lanes.every(validateLane)) throw new AdmissionStateError('Admission registry contains an invalid lane record.');
  const ids = value.lanes.map((lane) => lane.laneId);
  if (new Set(ids).size !== ids.length) throw new AdmissionStateError('Admission registry contains duplicate lane identifiers.');
  for (let i = 0; i < value.lanes.length; i += 1) {
    const left = value.lanes[i]!;
    for (let j = i + 1; j < value.lanes.length; j += 1) {
      const right = value.lanes[j]!;
      if (left.status !== 'released' && right.status !== 'released' && production(left.role) && production(right.role) && overlaps(left.evidence, right.evidence) &&
        !(left.role === 'delegated_mutation_writer' && left.delegatedFromLaneId === right.laneId) &&
        !(right.role === 'delegated_mutation_writer' && right.delegatedFromLaneId === left.laneId)) {
        throw new AdmissionStateError(`Admission registry has ambiguous overlapping active lanes ${left.laneId} and ${right.laneId}.`);
      }
      if (left.status !== 'released' && right.status !== 'released' && (left.role === 'isolated_experiment' || right.role === 'isolated_experiment') &&
        sharedPhysicalSurface(left.evidence, right.evidence)) {
        throw new AdmissionStateError(`Admission registry has a non-isolated experiment surface shared by ${left.laneId} and ${right.laneId}.`);
      }
    }
  }
  if (value.lastTransition !== null && (!object(value.lastTransition) || !nonEmpty(value.lastTransition.kind) || !nonEmpty(value.lastTransition.at))) throw new AdmissionStateError('Admission registry transition metadata is corrupt.');
  if (value.lastTransition !== null && (!Object.keys(value.lastTransition).every((key) => ['kind', 'laneId', 'at'].includes(key)) ||
    ('laneId' in value.lastTransition && !nonEmpty(value.lastTransition.laneId)))) throw new AdmissionStateError('Admission registry transition metadata is corrupt.');
  const tokens = value.lanes.filter((lane) => lane.status === 'active').map((lane) => lane.token);
  if (new Set(tokens).size !== tokens.length) throw new AdmissionStateError('Admission registry contains duplicate active generation tokens.');
  const active = value.lanes.filter((lane) => lane.status === 'active');
  const writers = new Set(active.filter((lane) => mutation(lane.role)).map((lane) => lane.missionId));
  const highAutonomyMissions = new Set(active.filter((lane) => lane.highAutonomy).map((lane) => lane.missionId));
  if (value.config.limits.maxPerRepository !== undefined) {
    const captainsByRepository = new Map<string, number>();
    for (const lane of active) if (lane.role === 'production_captain') {
      const count = (captainsByRepository.get(lane.evidence.repository) ?? 0) + 1;
      captainsByRepository.set(lane.evidence.repository, count);
      if (count > value.config.limits.maxPerRepository) throw new AdmissionStateError('Admission registry exceeds configured per-repository production capacity.');
    }
  }
  if (active.filter((lane) => lane.role === 'production_captain').length > value.config.limits.maxCaptains ||
    writers.size > value.config.limits.maxWriters || highAutonomyMissions.size > value.config.limits.maxHighAutonomy) throw new AdmissionStateError('Admission registry exceeds configured active capacity.');
  for (const delegate of value.lanes.filter((lane) => lane.role === 'delegated_mutation_writer')) {
    const owner = value.lanes.find((lane) => lane.laneId === delegate.delegatedFromLaneId && lane.role === 'production_captain');
    if (!owner || (delegate.status === 'active' && owner.status !== 'active') || owner.missionId !== delegate.missionId || !overlaps(owner.evidence, delegate.evidence) || delegate.highAutonomy) {
      throw new AdmissionStateError(`Admission registry contains orphaned or mismatched delegated writer ${delegate.laneId}.`);
    }
  }
  return value as unknown as RegistryState;
}

function production(role: MissionAdmissionRole): boolean { return role === 'production_captain' || role === 'delegated_mutation_writer'; }
function mutation(role: MissionAdmissionRole): boolean { return role === 'production_captain' || role === 'delegated_mutation_writer'; }

function acquireLock(lockPath: string, timeoutMs: number, retryMs: number, beforeStaleTakeover?: () => void): () => void {
  const started = Date.now();
  for (;;) {
    try {
      const owned = acquireDispatchInvocationLock({ lockPath, ...(beforeStaleTakeover === undefined ? {} : { beforeStaleTakeover }) });
      return () => owned.release();
    } catch (error) {
      if (!(error instanceof DispatchInvocationLockedError)) throw error;
      if (Date.now() - started >= timeoutMs) throw new AdmissionLockError('Admission transaction lock is held or ambiguous; refusing to proceed.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  }
}

function writeAtomic(filePath: string, state: RegistryState): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, filePath);
  try { const directoryFd = openSync(path.dirname(filePath), 'r'); try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); } } catch { /* directory fsync is unsupported on some platforms */ }
}

function tokenRecord(lane: LaneRecord): AdmissionToken {
  if (lane.token === null) throw new AdmissionStateError('Active lane is missing its generation token.');
  return { laneId: lane.laneId, generation: lane.generation, token: lane.token };
}

export class MissionAdmissionRegistry {
  private readonly filePath: string;
  private readonly config: AdmissionConfig;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly now: () => string;
  private readonly beforePublish?: () => void;
  private readonly onPublishedTransition?: (projection: AdmissionProjection) => void;
  private readonly beforeStaleTakeover?: () => void;

  constructor(options: MissionAdmissionOptions) {
    validateAdmissionConfig(options.config);
    if (!path.isAbsolute(options.filePath)) throw new AdmissionStateError('Admission registry path must be absolute and host-global.');
    this.filePath = canonicalPath(options.filePath);
    this.config = structuredClone(options.config);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.now = options.now ?? (() => new Date().toISOString());
    this.beforePublish = options.beforePublish;
    this.onPublishedTransition = options.onPublishedTransition;
    this.beforeStaleTakeover = options.beforeStaleTakeover;
  }

  private transact<T>(operation: (state: RegistryState) => T, beforeStatePublish?: (result: T) => void): T {
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const unlock = acquireLock(`${this.filePath}.lock`, this.lockTimeoutMs, this.lockRetryMs, this.beforeStaleTakeover);
    try {
      let state: RegistryState;
      if (!existsSync(this.filePath)) state = initialState(this.config);
      else {
        let raw: unknown;
        try { raw = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { throw new AdmissionStateError('Admission registry is unreadable or corrupt; refusing to reset it.'); }
        state = validateState(raw);
      if (state.config.revision !== this.config.revision || state.config.limits.maxCaptains !== this.config.limits.maxCaptains || state.config.limits.maxWriters !== this.config.limits.maxWriters ||
          state.config.limits.maxHighAutonomy !== this.config.limits.maxHighAutonomy || state.config.limits.maxPerRepository !== this.config.limits.maxPerRepository) {
          throw new AdmissionStateError('Admission configuration differs from the persisted registry configuration.');
        }
      }
      const before = JSON.stringify(state);
      const beforeRevision = state.revision;
      const result = operation(state);
      if (JSON.stringify(state) !== before) {
        beforeStatePublish?.(result);
        this.beforePublish?.();
        writeAtomic(this.filePath, state);
        if (state.revision !== beforeRevision) {
          try { this.onPublishedTransition?.(project(state)); } catch { /* wake is a best-effort hint; publication remains authoritative */ }
        }
      }
      return result;
    } finally { unlock(); }
  }

  private readState(): RegistryState {
    if (!existsSync(this.filePath)) return initialState(this.config);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { throw new AdmissionStateError('Admission registry is unreadable or corrupt; refusing to reset it.'); }
    const state = validateState(raw);
    if (state.config.revision !== this.config.revision || state.config.limits.maxCaptains !== this.config.limits.maxCaptains || state.config.limits.maxWriters !== this.config.limits.maxWriters ||
      state.config.limits.maxHighAutonomy !== this.config.limits.maxHighAutonomy || state.config.limits.maxPerRepository !== this.config.limits.maxPerRepository) {
      throw new AdmissionStateError('Admission configuration differs from the persisted registry configuration.');
    }
    return state;
  }

  admit(request: AdmissionRequest, options: { readonly beforePublish?: (result: Extract<AdmissionResult, { readonly outcome: 'admitted' }>) => void } = {}): AdmissionResult {
    if (!nonEmpty(request.laneId) || !(MISSION_ADMISSION_ROLES as readonly string[]).includes(request.role)) throw new AdmissionStateError('Admission request has an invalid lane identifier or role.');
    const evidence = canonicalizeMissionEvidence(request.evidence);
    if (request.role === 'delegated_mutation_writer' && !nonEmpty(request.delegatedFromLaneId)) throw new AdmissionStateError('Delegated writers require an explicit captain lane.');
    if (request.role === 'isolated_experiment' && !nonEmpty(request.experimentOfMissionId)) throw new AdmissionStateError('Experiments require an explicit production mission relationship.');
    if (request.role === 'isolated_experiment' && (!evidence.workspace || !evidence.stateSurface)) throw new AdmissionStateError('Experiments require isolated workspace and state-surface evidence.');
    if ((request.role === 'read_only_review' || request.role === 'read_only_consultation') && (request.delegatedFromLaneId || request.highAutonomy)) throw new AdmissionStateError('Read-only lanes cannot request delegated mutation or high-autonomy authority.');
    const now = this.now();
    return this.transact((state) => {
      const prior = state.lanes.find((lane) => lane.laneId === request.laneId);
      if (prior?.status === 'active') throw new AdmissionStateError('Lane already has active ownership; reconcile its generation instead of admitting it twice.');
      if (prior?.status === 'parked' && prior.parkedReason === 'manual_checkpoint') throw new AdmissionStateError('Manual checkpoint reservations must be retired with their exact parked generation before this lane can be admitted again.');
      if (prior && prior.role !== request.role) throw new AdmissionStateError('A lane identifier cannot change roles across generations.');
      const owner = request.role === 'delegated_mutation_writer' ? state.lanes.find((lane) => lane.laneId === request.delegatedFromLaneId && lane.status === 'active' && lane.role === 'production_captain') : undefined;
      if (request.role === 'delegated_mutation_writer' && (!owner || !overlaps(owner.evidence, evidence) || (prior !== undefined && prior.missionId !== owner.missionId))) throw new AdmissionStateError('Delegated writer must overlap and share the mission of an active production captain lane.');
      if (request.role === 'delegated_mutation_writer' && request.highAutonomy === true) throw new AdmissionStateError('Delegated writers share their captain mission capacity and cannot request separate high-autonomy capacity.');
      let missionId = owner?.missionId ?? prior?.missionId ?? deterministicMissionId(evidence);
      const candidate: LaneRecord = {
        laneId: request.laneId, missionId, evidence: prior ? mergeEvidence(prior.evidence, evidence) : evidence,
        role: request.role, status: 'active', generation: (prior?.generation ?? 0) + 1, token: randomUUID(),
        highAutonomy: request.highAutonomy ?? false,
        ...(request.delegatedFromLaneId ? { delegatedFromLaneId: request.delegatedFromLaneId } : {}),
        ...(request.experimentOfMissionId ? { experimentOfMissionId: request.experimentOfMissionId } : {}), updatedAt: now,
      };
      if (request.role === 'isolated_experiment' || state.lanes.some((lane) => lane.status === 'active' && lane.role === 'isolated_experiment')) {
        const sharedSurface = state.lanes.find((lane) => lane.status === 'active' && lane.laneId !== request.laneId && (lane.role === 'isolated_experiment' || request.role === 'isolated_experiment') &&
          sharedPhysicalSurface(lane.evidence, evidence));
        if (sharedSurface) throw new AdmissionStateError(`Experiment must use a separate workspace and state surface from active lane ${sharedSurface.laneId}.`);
      }
      const conflict = state.lanes.find((lane) => lane.status !== 'released' && lane.laneId !== request.laneId && production(lane.role) && production(request.role) &&
        overlaps(lane.evidence, candidate.evidence) && !(request.role === 'delegated_mutation_writer' && request.delegatedFromLaneId === lane.laneId));
      if (conflict) {
        missionId = conflict.missionId;
        return { outcome: 'duplicate', missionId, conflictingLaneId: conflict.laneId, revision: state.revision };
      }
      if (prior?.status === 'parked' && prior.role === request.role && sameEvidence(prior.evidence, candidate.evidence) &&
        prior.highAutonomy === candidate.highAutonomy && prior.delegatedFromLaneId === candidate.delegatedFromLaneId && prior.experimentOfMissionId === candidate.experimentOfMissionId &&
        capacityReason(state, candidate) === prior.parkedReason) {
        return { outcome: 'parked', missionId: prior.missionId, reason: prior.parkedReason!, revision: state.revision };
      }
      const reason = capacityReason(state, candidate);
      if (reason) {
        const parked: LaneRecord = { ...candidate, status: 'parked', token: null, generation: candidate.generation, parkedReason: reason };
        replaceLane(state, parked); state.revision += 1; state.lastTransition = { kind: reason, laneId: request.laneId, at: now };
        return { outcome: 'parked', missionId, reason, revision: state.revision };
      }
      replaceLane(state, candidate); state.revision += 1; state.lastTransition = { kind: 'admitted', laneId: request.laneId, at: now };
      return { outcome: 'admitted', missionId, token: tokenRecord(candidate), revision: state.revision };
    }, (result) => {
      if (result.outcome === 'admitted') options.beforePublish?.(result);
    });
  }

  /**
   * Atomically add stronger canonical evidence to the same active owner.
   * The generation capability and mission identity remain unchanged; any
   * overlap with another reserved production lane rejects without publishing.
   */
  strengthen(token: AdmissionToken, evidenceInput: MissionEvidence): number {
    const evidence = canonicalizeMissionEvidence(evidenceInput);
    return this.transact((state) => {
      const lane = requireCurrentToken(state, token);
      if (lane.role !== 'production_captain') throw new AdmissionStateError(`${lane.role} cannot strengthen production ownership evidence.`);
      const strengthened = mergeEvidence(lane.evidence, evidence);
      for (const other of state.lanes) {
        if (other.laneId === lane.laneId || other.status === 'released' || !production(other.role) || !overlaps(other.evidence, strengthened)) continue;
        if (other.role === 'delegated_mutation_writer' && other.delegatedFromLaneId === lane.laneId) continue;
        throw new AdmissionStateError(`Strengthened ownership evidence overlaps reserved lane "${other.laneId}"; refusing to publish.`);
      }
      if (sameEvidence(lane.evidence, strengthened)) return state.revision;
      lane.evidence = strengthened;
      lane.updatedAt = this.now();
      state.revision += 1;
      state.lastTransition = { kind: 'evidence_strengthened', laneId: lane.laneId, at: lane.updatedAt };
      return state.revision;
    });
  }

  renew(token: AdmissionToken): AdmissionToken {
    return this.transact((state) => {
      const lane = requireCurrentToken(state, token);
      lane.updatedAt = this.now();
      return tokenRecord(lane);
    });
  }

  readLane(laneId: string): AdmissionLaneView | null {
    const lane = this.readState().lanes.find((record) => record.laneId === laneId);
    if (lane === undefined) return null;
    const { token: _secret, ...view } = lane;
    return structuredClone(view);
  }

  park(token: AdmissionToken, reason: ParkedReason): number {
    return this.transact((state) => {
      const lane = requireCurrentToken(state, token);
      assertNoActiveDelegates(state, lane);
      if (!(['capacity_captains', 'capacity_writers', 'capacity_high_autonomy', 'capacity_repository', 'workflow_wait', 'workflow_settled'].includes(reason))) throw new AdmissionStateError('Park reason is invalid.');
      lane.status = 'parked'; lane.token = null; lane.generation += 1; lane.parkedReason = reason; lane.updatedAt = this.now();
      state.revision += 1; state.lastTransition = { kind: reason, laneId: lane.laneId, at: lane.updatedAt };
      return state.revision;
    });
  }

  parkManual(token: AdmissionToken, proof: { readonly worktree: string; readonly branch: string; readonly checkpointSha: string; readonly clean: boolean; readonly stopped: boolean }): number {
    if (proof.clean !== true || proof.stopped !== true || !nonEmpty(proof.branch) || !/^[a-f0-9]{7,64}$/i.test(proof.checkpointSha)) {
      throw new AdmissionStateError('Manual park requires explicit stopped, clean, branch, and checkpoint proof.');
    }
    const worktree = canonicalPath(proof.worktree);
    return this.transact((state) => {
      const lane = requireCurrentToken(state, token);
      assertNoActiveDelegates(state, lane);
      if (lane.role !== 'production_captain' || lane.evidence.repositoryScope !== true || lane.evidence.workspace !== worktree) {
        throw new AdmissionStateError('Manual park proof does not match an active repository-wide manual lane.');
      }
      lane.status = 'parked'; lane.token = null; lane.generation += 1; lane.parkedReason = 'manual_checkpoint'; lane.updatedAt = this.now();
      state.revision += 1; state.lastTransition = { kind: 'manual_checkpoint', laneId: lane.laneId, at: lane.updatedAt };
      return state.revision;
    });
  }

  retireManual(laneId: string, expectedParkedGeneration: number, proof: { readonly worktree: string; readonly branch: string; readonly checkpointSha: string; readonly clean: boolean; readonly stopped: boolean }): number {
    if (!nonEmpty(laneId) || !Number.isSafeInteger(expectedParkedGeneration) || expectedParkedGeneration <= 0 ||
      proof.clean !== true || proof.stopped !== true || !nonEmpty(proof.branch) || !/^[a-f0-9]{7,64}$/i.test(proof.checkpointSha)) {
      throw new AdmissionStateError('Manual retirement requires an expected parked generation and explicit stopped, clean, branch, and checkpoint proof.');
    }
    const worktree = canonicalPath(proof.worktree);
    return this.transact((state) => {
      const lane = state.lanes.find((record) => record.laneId === laneId);
      if (lane?.status === 'released' && lane.generation === expectedParkedGeneration + 1) return state.revision;
      if (!lane || lane.status !== 'parked' || lane.generation !== expectedParkedGeneration || lane.parkedReason !== 'manual_checkpoint' ||
        lane.role !== 'production_captain' || lane.evidence.repositoryScope !== true || lane.evidence.workspace !== worktree) {
        throw new AdmissionStateError('Manual retirement receipt is stale or does not match the parked owner generation.');
      }
      assertNoActiveDelegates(state, lane);
      lane.status = 'released'; lane.token = null; lane.generation += 1; lane.updatedAt = this.now(); delete (lane as { parkedReason?: ParkedReason }).parkedReason;
      state.revision += 1; state.lastTransition = { kind: 'manual_retired', laneId: lane.laneId, at: lane.updatedAt };
      return state.revision;
    });
  }

  release(token: AdmissionToken, executionStopped: boolean, beforePublish?: () => void): number {
    if (executionStopped !== true) throw new AdmissionStateError('Release requires explicit evidence that execution and children have stopped.');
    return this.transact((state) => {
      const lane = requireCurrentToken(state, token);
      assertNoActiveDelegates(state, lane);
      lane.status = 'released'; lane.token = null; lane.generation += 1; lane.updatedAt = this.now(); delete (lane as { parkedReason?: ParkedReason }).parkedReason;
      state.revision += 1; state.lastTransition = { kind: 'released', laneId: lane.laneId, at: lane.updatedAt };
      return state.revision;
    }, () => beforePublish?.());
  }

  assertCanMutate(token: AdmissionToken): void {
    const lane = this.readState().lanes.find((record) => record.laneId === token.laneId);
    if (!lane || lane.status !== 'active' || lane.generation !== token.generation || lane.token !== token.token) throw new AdmissionStateError('Admission generation token is stale or does not own the active lane.');
    if (!mutation(lane.role)) throw new AdmissionStateError(`${lane.role} cannot mutate production state.`);
  }

  assertCanPublish(token: AdmissionToken, productionMissionId: string): void {
    const lane = this.readState().lanes.find((record) => record.laneId === token.laneId);
    if (!lane || lane.status !== 'active' || lane.generation !== token.generation || lane.token !== token.token) throw new AdmissionStateError('Admission generation token is stale or does not own the active lane.');
    if (lane.role !== 'production_captain' || lane.missionId !== productionMissionId) throw new AdmissionStateError(`${lane.role} cannot publish to this production mission.`);
  }

  snapshot(): AdmissionProjection {
    return project(this.readState());
  }
}

export interface AdmissionProjection {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly limits: AdmissionLimits;
  readonly counts: { readonly captains: number; readonly writers: number; readonly highAutonomy: number; readonly parked: number };
  readonly lanes: readonly Pick<LaneRecord, 'laneId' | 'missionId' | 'evidence' | 'role' | 'status' | 'generation' | 'highAutonomy' | 'parkedReason'>[];
  readonly omittedLaneCount: number;
  readonly lanesTruncated: boolean;
  readonly lastTransition: RegistryState['lastTransition'];
}

function project(state: RegistryState): AdmissionProjection {
  const active = state.lanes.filter((lane) => lane.status === 'active');
  const writers = new Set(active.filter((lane) => mutation(lane.role)).map((lane) => lane.missionId));
  const highAutonomy = new Set(active.filter((lane) => lane.highAutonomy).map((lane) => lane.missionId));
  const priority = (lane: LaneRecord): number => {
    if (lane.status === 'active' && lane.role === 'production_captain') return 0;
    if (lane.status === 'active' && lane.role === 'delegated_mutation_writer') return 1;
    if (lane.status === 'active') return 2;
    if (lane.status === 'parked') return 3;
    return 4;
  };
  const selected = state.lanes.slice().sort((left, right) =>
    priority(left) - priority(right) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.laneId.localeCompare(right.laneId) ||
    right.generation - left.generation,
  ).slice(0, 100);
  const omittedLaneCount = state.lanes.length - selected.length;
  return {
    schemaVersion: 1, revision: state.revision, limits: { ...state.config.limits },
    counts: { captains: active.filter((lane) => lane.role === 'production_captain').length, writers: writers.size, highAutonomy: highAutonomy.size, parked: state.lanes.filter((lane) => lane.status === 'parked').length },
    lanes: selected.map(({ laneId, missionId, evidence, role, status, generation, highAutonomy, parkedReason }) => ({ laneId, missionId, evidence, role, status, generation, highAutonomy, ...(parkedReason ? { parkedReason } : {}) })),
    omittedLaneCount,
    lanesTruncated: omittedLaneCount > 0,
    lastTransition: state.lastTransition,
  };
}

function capacityReason(state: RegistryState, candidate: LaneRecord): ParkedReason | null {
  const active = state.lanes.filter((lane) => lane.status === 'active');
  const limits = state.config.limits;
  if (candidate.role === 'production_captain' && active.filter((lane) => lane.role === 'production_captain').length >= limits.maxCaptains) return 'capacity_captains';
  const writerMissions = new Set(active.filter((lane) => mutation(lane.role)).map((lane) => lane.missionId));
  if (mutation(candidate.role) && !writerMissions.has(candidate.missionId) && writerMissions.size >= limits.maxWriters) return 'capacity_writers';
  const highAutonomyMissions = new Set(active.filter((lane) => lane.highAutonomy).map((lane) => lane.missionId));
  if (candidate.highAutonomy && !highAutonomyMissions.has(candidate.missionId) && highAutonomyMissions.size >= limits.maxHighAutonomy) return 'capacity_high_autonomy';
  if (candidate.role === 'production_captain' && limits.maxPerRepository !== undefined &&
    active.filter((lane) => lane.role === 'production_captain' && lane.evidence.repository === candidate.evidence.repository).length >= limits.maxPerRepository) return 'capacity_repository';
  return null;
}

function assertNoActiveDelegates(state: RegistryState, captain: LaneRecord): void {
  const delegate = state.lanes.find((lane) => lane.status === 'active' && lane.role === 'delegated_mutation_writer' && lane.delegatedFromLaneId === captain.laneId);
  if (delegate) throw new AdmissionStateError(`Captain ${captain.laneId} cannot park or release while delegated writer ${delegate.laneId} remains active or uncertain.`);
}

function requireCurrentToken(state: RegistryState, token: AdmissionToken): LaneRecord {
  const lane = state.lanes.find((record) => record.laneId === token.laneId);
  if (!lane || lane.status !== 'active' || lane.generation !== token.generation || lane.token !== token.token) throw new AdmissionStateError('Admission generation token is stale or does not own the active lane.');
  return lane;
}

function replaceLane(state: RegistryState, lane: LaneRecord): void {
  const index = state.lanes.findIndex((item) => item.laneId === lane.laneId);
  if (index < 0) state.lanes.push(lane); else state.lanes[index] = lane;
}

function mergeEvidence(oldValue: MissionEvidence, nextValue: MissionEvidence): MissionEvidence {
  if (oldValue.repository !== nextValue.repository) throw new AdmissionStateError('Mission evidence conflicts on repository; refusing to merge ownership.');
  const result: Record<string, unknown> = { ...oldValue };
  for (const key of ['issue', 'pullRequest', 'run', 'claim', 'workspace', 'stateSurface'] as const) {
    const oldItem = oldValue[key]; const nextItem = nextValue[key];
    if (oldItem !== undefined && nextItem !== undefined && oldItem !== nextItem) throw new AdmissionStateError(`Mission evidence conflicts on ${key}; refusing to merge ownership.`);
    if (nextItem !== undefined) result[key] = nextItem;
  }
  if (oldValue.repositoryScope === true && nextValue.repositoryScope !== true) result.repositoryScope = true;
  if (oldValue.repositoryScope !== undefined && nextValue.repositoryScope !== undefined && oldValue.repositoryScope !== nextValue.repositoryScope) throw new AdmissionStateError('Mission evidence conflicts on repositoryScope; refusing to merge ownership.');
  if (nextValue.repositoryScope === true) result.repositoryScope = true;
  return result as unknown as MissionEvidence;
}

function sameEvidence(left: MissionEvidence, right: MissionEvidence): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key as keyof MissionEvidence] === value);
}
