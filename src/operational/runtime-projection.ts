import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Run } from '../domain/types.js';
import type { AdmissionProjection } from '../mission-admission/registry.js';

/** Versioned, secret-free control-plane state for Control Tower Phase 0. */
export const OPERATIONAL_RUNTIME_PROJECTION_VERSION = 1;

export interface OperationalRuntimeProjectionV1 {
  readonly schemaVersion: typeof OPERATIONAL_RUNTIME_PROJECTION_VERSION;
  readonly updatedAt: string;
  readonly supervisor: 'running' | 'stopped' | 'parked';
  readonly stage: string;
  readonly nextPollAt?: string;
  readonly eventWakeEligible: boolean;
  readonly maintenanceHold: { readonly active: boolean; readonly reason?: string };
  readonly ownership: 'none' | 'active' | 'ambiguous';
  readonly checkpoint: 'durable' | 'in_progress' | 'unknown';
  readonly activeWriter?: { readonly issue?: number; readonly runId: string; readonly worker?: string; readonly worktree: string };
  readonly manualLane?: { readonly repository: string; readonly worktree: string; readonly branch: string; readonly checkpointSha: string; readonly clean: boolean; readonly state: 'active' | 'parked'; readonly recoverable: boolean; readonly laneId?: string; readonly missionId?: string; readonly admissionRevision?: number };
}

export interface OperationalRuntimeProjectionInput {
  readonly admission: AdmissionProjection;
  readonly runs: readonly Run[];
  readonly prior: OperationalRuntimeProjectionV1 | null;
  readonly now: string;
  readonly stage: string;
  readonly supervisor: OperationalRuntimeProjectionV1['supervisor'];
  readonly eventWakeEligible: boolean;
  readonly nextPollAt?: string;
  readonly maintenanceHold?: { readonly active: boolean; readonly reason?: string };
  /** A manually owned lane only when its private receipt was validated against the same registry snapshot. */
  readonly manualLane?: NonNullable<OperationalRuntimeProjectionV1['manualLane']>;
  /** Mutation lane IDs whose durable re-entry evidence was validated by the producer. */
  readonly durableLaneIds?: ReadonlySet<string>;
  /** True only for pristine revision-zero state or fully validated current re-entry evidence. */
  readonly reentryEvidenceComplete: boolean;
}

export type OperationalRuntimeProjectionRead =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'valid'; readonly projection: OperationalRuntimeProjectionV1 };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try { return new Date(milliseconds).toISOString() === value; } catch { return false; }
}

function optionalMember(recordValue: Record<string, unknown>, key: string, valid: (value: unknown) => boolean): boolean {
  return !Object.prototype.hasOwnProperty.call(recordValue, key) || valid(recordValue[key]);
}

function adverseParkedLane(value: unknown): boolean {
  return record(value) && value.state === 'parked' && (value.clean === false || value.recoverable === false);
}

/** Validate the complete supported V1 structure and its summary consistency. */
function isOperationalRuntimeProjection(value: unknown): value is OperationalRuntimeProjectionV1 {
  if (!record(value)) return false;
  const maintenanceHold = value.maintenanceHold;
  if (value.schemaVersion !== 1 ||
    !canonicalTimestamp(value.updatedAt) || !['running', 'stopped', 'parked'].includes(value.supervisor as string) ||
    !nonblank(value.stage) || !optionalMember(value, 'nextPollAt', canonicalTimestamp) ||
    typeof value.eventWakeEligible !== 'boolean' || !record(maintenanceHold) ||
    typeof maintenanceHold.active !== 'boolean' ||
    !optionalMember(maintenanceHold, 'reason', nonblank) ||
    !['none', 'active', 'ambiguous'].includes(value.ownership as string) ||
    !['durable', 'in_progress', 'unknown'].includes(value.checkpoint as string)) return false;

  if (Object.prototype.hasOwnProperty.call(value, 'activeWriter')) {
    const writer = value.activeWriter;
    if (!record(writer) || !nonblank(writer.runId) || !nonblank(writer.worktree) ||
      !optionalMember(writer, 'worker', nonblank) ||
      !optionalMember(writer, 'issue', (issue) => Number.isSafeInteger(issue) && (issue as number) > 0)) return false;
  }

  if (Object.prototype.hasOwnProperty.call(value, 'manualLane')) {
    const lane = value.manualLane;
    if (!record(lane) || !nonblank(lane.repository) || !nonblank(lane.worktree) || !nonblank(lane.branch) ||
      typeof lane.checkpointSha !== 'string' || !/^[0-9a-f]{40}$/i.test(lane.checkpointSha) ||
      typeof lane.clean !== 'boolean' || !['active', 'parked'].includes(lane.state as string) ||
      typeof lane.recoverable !== 'boolean' || !optionalMember(lane, 'laneId', nonblank) ||
      !optionalMember(lane, 'missionId', nonblank) ||
      !optionalMember(lane, 'admissionRevision', (revision) => Number.isSafeInteger(revision) && (revision as number) >= 0)) return false;
  }

  const hasActiveOwnerDetail = (record(value.manualLane) && value.manualLane.state === 'active') || value.activeWriter !== undefined;
  if (hasActiveOwnerDetail && value.ownership !== 'active') return false;
  if (adverseParkedLane(value.manualLane) && value.ownership === 'none' && value.checkpoint === 'durable') return false;
  return true;
}

/** Compose one account-wide observation from a single validated admission snapshot. */
export function composeOperationalRuntimeProjection(input: OperationalRuntimeProjectionInput): OperationalRuntimeProjectionV1 {
  const { admission, runs } = input;
  const suppliedManualLane = input.manualLane;
  const mutationLanes = admission.lanes.filter((lane) =>
    lane.role === 'production_captain' || lane.role === 'delegated_mutation_writer');
  const activeRunIds = new Set(runs.filter((run) => !['MERGED', 'FAILED', 'MERGE_READY', 'NEEDS_HUMAN', 'WAITING_DEPENDENCY'].includes(run.state)).map((run) => run.id));
  let ownership: OperationalRuntimeProjectionV1['ownership'];
  let checkpoint: OperationalRuntimeProjectionV1['checkpoint'];
  let manualLane = input.manualLane;

  if (admission.counts.writers > 0) {
    ownership = 'active';
    checkpoint = 'in_progress';
    if (manualLane?.state !== 'active') manualLane = undefined;
  } else if (admission.lanesTruncated) {
    ownership = 'ambiguous';
    checkpoint = 'unknown';
    manualLane = undefined;
  } else {
    const liveRuns = runs.filter((run) => activeRunIds.has(run.id));
    const checkpointMutationLanes = mutationLanes.filter((lane) => lane.status === 'parked' || lane.status === 'released');
    const allMutationHistoryHasDurableEvidence = checkpointMutationLanes.every((lane) => input.durableLaneIds?.has(lane.laneId) === true);
    const allRunsHaveDurableAdmissionHistory = runs.every((run) => checkpointMutationLanes.some((lane) => lane.evidence.run === run.id && input.durableLaneIds?.has(lane.laneId) === true));
    const hasUnknownMutationLane = mutationLanes.some((lane) => lane.status === 'active');
    if (liveRuns.length > 0 || hasUnknownMutationLane || !allMutationHistoryHasDurableEvidence || !allRunsHaveDurableAdmissionHistory || !input.reentryEvidenceComplete) {
      ownership = 'ambiguous';
      checkpoint = 'unknown';
      manualLane = undefined;
    } else {
      ownership = 'none';
      checkpoint = 'durable';
      if (manualLane?.state !== 'parked') manualLane = undefined;
    }
  }

  if (admission.counts.writers === 0 && adverseParkedLane(suppliedManualLane)) {
    if (ownership === 'none' && checkpoint === 'durable') {
      ownership = 'ambiguous';
      checkpoint = 'unknown';
    }
    if (ownership !== 'active') manualLane = suppliedManualLane;
  }

  return {
    schemaVersion: 1,
    updatedAt: input.now,
    supervisor: input.supervisor,
    stage: input.stage,
    ...(input.nextPollAt === undefined ? {} : { nextPollAt: input.nextPollAt }),
    eventWakeEligible: input.eventWakeEligible,
    maintenanceHold: input.maintenanceHold ?? input.prior?.maintenanceHold ?? { active: false },
    ownership,
    checkpoint,
    ...(manualLane === undefined ? {} : { manualLane }),
  };
}

export function operationalRuntimeProjectionPath(runsDir: string): string {
  return path.join(runsDir, '.operational', `v${OPERATIONAL_RUNTIME_PROJECTION_VERSION}`, 'runtime.json');
}

/** The producer owns the complete typed snapshot; readers never infer it from logs. */
export function writeOperationalRuntimeProjection(runsDir: string, projection: OperationalRuntimeProjectionV1): void {
  const filePath = operationalRuntimeProjectionPath(runsDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

/** Distinguish a confirmed missing file from present malformed or unreadable state. */
export function readOperationalRuntimeProjectionState(runsDir: string): OperationalRuntimeProjectionRead {
  let raw: string;
  try { raw = readFileSync(operationalRuntimeProjectionPath(runsDir), 'utf8'); }
  catch (error) {
    if (record(error) && error.code === 'ENOENT') {
      try {
        lstatSync(operationalRuntimeProjectionPath(runsDir));
        return { status: 'invalid' };
      } catch (entryError) {
        return record(entryError) && entryError.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' };
      }
    }
    return { status: 'invalid' };
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { return { status: 'invalid' }; }
  return isOperationalRuntimeProjection(value)
    ? { status: 'valid', projection: value }
    : { status: 'invalid' };
}

/** Read only a complete typed projection; malformed state is never adopted. */
export function readOperationalRuntimeProjection(runsDir: string): OperationalRuntimeProjectionV1 | null {
  const result = readOperationalRuntimeProjectionState(runsDir);
  return result.status === 'valid' ? result.projection : null;
}

/** Idempotently persist a restart admission fence; no queue or Run state is inferred. */
export function setMaintenanceHold(runsDir: string, active: boolean, now: string, reason = 'Operator restart hold'): OperationalRuntimeProjectionV1 {
  const prior = readOperationalRuntimeProjection(runsDir);
  const next: OperationalRuntimeProjectionV1 = { schemaVersion: 1, updatedAt: now, supervisor: active ? 'parked' : (prior?.supervisor ?? 'stopped'), stage: active ? 'maintenance_hold' : (prior?.stage ?? 'idle'), eventWakeEligible: false, maintenanceHold: active ? { active: true, reason } : { active: false }, ownership: prior?.ownership ?? 'ambiguous', checkpoint: prior?.checkpoint ?? 'unknown', ...(prior?.nextPollAt === undefined ? {} : { nextPollAt: prior.nextPollAt }), ...(prior?.activeWriter === undefined ? {} : { activeWriter: prior.activeWriter }), ...(prior?.manualLane === undefined ? {} : { manualLane: prior.manualLane }) };
  writeOperationalRuntimeProjection(runsDir, next);
  return next;
}

export function restartVerdict(projection: OperationalRuntimeProjectionV1 | null): { verdict: string; reason: string } {
  if (!isOperationalRuntimeProjection(projection)) return { verdict: 'UNKNOWN — CANNOT PROVE SAFE', reason: 'Typed runtime projection is missing, malformed, or internally contradictory.' };
  if (projection.ownership === 'active') return { verdict: 'WAIT FOR CURRENT CHECKPOINT', reason: 'The latest validated snapshot shows an account-wide writer; this observation is not a complete mutation freeze.' };
  if (projection.ownership !== 'none' || projection.checkpoint !== 'durable') return { verdict: 'UNKNOWN — CANNOT PROVE SAFE', reason: 'Writer ownership or durable restart checkpoint is ambiguous.' };
  if (!projection.maintenanceHold.active) return { verdict: 'SAFE NOW · WINDOW NOT GUARANTEED', reason: 'No writer is active, but new dispatch admission is not held.' };
  return { verdict: 'SAFE TO RESTART', reason: 'The latest validated snapshot shows no active writer, durable re-entry is proven, and the hold prevents dispatch admission only.' };
}

export function registerManualLane(runsDir: string, lane: NonNullable<OperationalRuntimeProjectionV1['manualLane']>, now: string): OperationalRuntimeProjectionV1 {
  const prior = readOperationalRuntimeProjection(runsDir);
  const active = lane.state === 'active';
  const next: OperationalRuntimeProjectionV1 = { schemaVersion: 1, updatedAt: now, supervisor: prior?.supervisor ?? 'parked', stage: active ? 'manual_implementation' : 'manual_parked', eventWakeEligible: false, maintenanceHold: prior?.maintenanceHold ?? { active: false }, ownership: active ? 'active' : lane.recoverable && lane.clean ? 'none' : 'ambiguous', checkpoint: lane.recoverable && lane.clean ? 'durable' : 'unknown', manualLane: lane, ...(prior?.nextPollAt === undefined ? {} : { nextPollAt: prior.nextPollAt }) };
  writeOperationalRuntimeProjection(runsDir, next); return next;
}

/** Clear a retired manual owner only after the admission registry released it. */
export function retireManualLane(runsDir: string, laneId: string, now: string): OperationalRuntimeProjectionV1 {
  const prior = readOperationalRuntimeProjection(runsDir);
  if (prior?.manualLane === undefined && prior?.ownership === 'none' && prior.checkpoint === 'durable') return prior;
  if (prior?.manualLane?.laneId !== laneId) throw new Error('Operational projection does not identify the manual lane being retired.');
  const next: OperationalRuntimeProjectionV1 = {
    ...prior,
    updatedAt: now,
    supervisor: 'parked',
    stage: 'idle',
    eventWakeEligible: false,
    ownership: 'none',
    checkpoint: 'durable',
  };
  const { manualLane: _retired, ...withoutManualLane } = next;
  writeOperationalRuntimeProjection(runsDir, withoutManualLane);
  return withoutManualLane;
}
