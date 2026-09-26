import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

/** Read only a complete typed projection; malformed state is never adopted. */
export function readOperationalRuntimeProjection(runsDir: string): OperationalRuntimeProjectionV1 | null {
  try {
    const value: unknown = JSON.parse(readFileSync(operationalRuntimeProjectionPath(runsDir), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v.schemaVersion !== 1 || !['running', 'stopped', 'parked'].includes(v.supervisor as string) || !['none', 'active', 'ambiguous'].includes(v.ownership as string) || !['durable', 'in_progress', 'unknown'].includes(v.checkpoint as string) || typeof v.stage !== 'string' || typeof v.updatedAt !== 'string' || typeof v.eventWakeEligible !== 'boolean' || typeof v.maintenanceHold !== 'object' || v.maintenanceHold === null || typeof (v.maintenanceHold as Record<string, unknown>).active !== 'boolean') return null;
    return value as OperationalRuntimeProjectionV1;
  } catch { return null; }
}

/** Idempotently persist a restart admission fence; no queue or Run state is inferred. */
export function setMaintenanceHold(runsDir: string, active: boolean, now: string, reason = 'Operator restart hold'): OperationalRuntimeProjectionV1 {
  const prior = readOperationalRuntimeProjection(runsDir);
  const next: OperationalRuntimeProjectionV1 = { schemaVersion: 1, updatedAt: now, supervisor: active ? 'parked' : (prior?.supervisor ?? 'stopped'), stage: active ? 'maintenance_hold' : (prior?.stage ?? 'idle'), eventWakeEligible: false, maintenanceHold: active ? { active: true, reason } : { active: false }, ownership: prior?.ownership ?? 'ambiguous', checkpoint: prior?.checkpoint ?? 'unknown', ...(prior?.nextPollAt === undefined ? {} : { nextPollAt: prior.nextPollAt }), ...(prior?.activeWriter === undefined ? {} : { activeWriter: prior.activeWriter }), ...(prior?.manualLane === undefined ? {} : { manualLane: prior.manualLane }) };
  writeOperationalRuntimeProjection(runsDir, next);
  return next;
}

export function restartVerdict(projection: OperationalRuntimeProjectionV1 | null): { verdict: string; reason: string } {
  if (projection === null) return { verdict: 'UNKNOWN — CANNOT PROVE SAFE', reason: 'Typed runtime projection is missing or malformed.' };
  if (projection.ownership === 'active') return { verdict: 'WAIT FOR CURRENT CHECKPOINT', reason: 'A typed active writer owns repository mutation.' };
  if (projection.ownership !== 'none' || projection.checkpoint !== 'durable') return { verdict: 'UNKNOWN — CANNOT PROVE SAFE', reason: 'Writer ownership or durable restart checkpoint is ambiguous.' };
  if (!projection.maintenanceHold.active) return { verdict: 'SAFE NOW · WINDOW NOT GUARANTEED', reason: 'No writer is active, but new dispatch admission is not held.' };
  return { verdict: 'SAFE TO RESTART', reason: 'No writer is active, durable re-entry is proven, and maintenance hold prevents admission.' };
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
