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
  readonly activeWriter?: { readonly issue?: number; readonly runId?: string; readonly worker?: string; readonly checkpoint: 'durable' | 'in_progress' | 'unknown' };
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
    if (v.schemaVersion !== 1 || !['running', 'stopped', 'parked'].includes(v.supervisor as string) || typeof v.stage !== 'string' || typeof v.updatedAt !== 'string' || typeof v.eventWakeEligible !== 'boolean' || typeof v.maintenanceHold !== 'object' || v.maintenanceHold === null || typeof (v.maintenanceHold as Record<string, unknown>).active !== 'boolean') return null;
    return value as OperationalRuntimeProjectionV1;
  } catch { return null; }
}

/** Idempotently persist a restart admission fence; no queue or Run state is inferred. */
export function setMaintenanceHold(runsDir: string, active: boolean, now: string, reason = 'Operator restart hold'): OperationalRuntimeProjectionV1 {
  const prior = readOperationalRuntimeProjection(runsDir);
  const next: OperationalRuntimeProjectionV1 = { schemaVersion: 1, updatedAt: now, supervisor: active ? 'parked' : (prior?.supervisor ?? 'stopped'), stage: active ? 'maintenance_hold' : (prior?.stage ?? 'idle'), eventWakeEligible: false, maintenanceHold: active ? { active: true, reason } : { active: false }, ...(prior?.nextPollAt === undefined ? {} : { nextPollAt: prior.nextPollAt }), ...(prior?.activeWriter === undefined ? {} : { activeWriter: prior.activeWriter }) };
  writeOperationalRuntimeProjection(runsDir, next);
  return next;
}
