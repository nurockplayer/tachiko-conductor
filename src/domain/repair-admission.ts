import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';

/**
 * Explicit, provider-neutral authority for a repair.  This is deliberately a
 * small closed vocabulary: callers must supply it and it is never derived from
 * an Issue, a review finding, or any other prose.
 */
export const TASK_SHAPES = ['bounded', 'interacting', 'decision'] as const;
export type TaskShape = (typeof TASK_SHAPES)[number];

export interface RepairTaskShapeAuthority {
  readonly revision: string;
  readonly shape: TaskShape;
}

/** The interpretation vocabulary is versioned independently of reviewer text. */
export const REPAIR_FINDING_TAXONOMY_REVISION = 'repair-finding-taxonomy-v1';
export const REPAIR_FINDING_KINDS = ['review_blocking', 'validation_failed'] as const;
export type RepairFindingKind = (typeof REPAIR_FINDING_KINDS)[number];
export const REPAIR_ESCALATION_KINDS = ['decision_required', 'complex_unavailable', 'admission_stale'] as const;
export type RepairEscalationKind = (typeof REPAIR_ESCALATION_KINDS)[number];

export interface RepairAdmissionSnapshot {
  readonly authorityRevision: string;
  readonly taskShape: TaskShape;
  readonly taxonomyRevision: typeof REPAIR_FINDING_TAXONOMY_REVISION;
  readonly finding: RepairFindingKind;
  readonly headSha: string;
  readonly pullRequestNumber: number;
  /** The provider-neutral execution-profile selected by the explicit shape. */
  readonly executionProfile: 'routine' | 'complex';
  /** Revision of the execution-profile authority selected at admission. */
  readonly executionRevision: string;
  /** Immutable execution selection used for this exact repair admission. */
  readonly execution: ResolvedExecutionConfiguration;
  readonly admittedAt: string;
}

export type RepairAdmissionDecision =
  | { readonly kind: 'admit'; readonly executionProfile: 'routine' | 'complex' }
  | { readonly kind: 'park'; readonly escalation: Exclude<RepairEscalationKind, 'admission_stale'> };

export function isRepairTaskShapeAuthority(value: unknown): value is RepairTaskShapeAuthority {
  if (typeof value !== 'object' || value === null) return false;
  const authority = value as Record<string, unknown>;
  return typeof authority.revision === 'string' && authority.revision.trim() !== '' &&
    typeof authority.shape === 'string' && (TASK_SHAPES as readonly string[]).includes(authority.shape);
}

export function isRepairAdmissionSnapshot(value: unknown): value is RepairAdmissionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.authorityRevision === 'string' && snapshot.authorityRevision.trim() !== '' &&
    typeof snapshot.taskShape === 'string' && (TASK_SHAPES as readonly string[]).includes(snapshot.taskShape) &&
    snapshot.taxonomyRevision === REPAIR_FINDING_TAXONOMY_REVISION &&
    typeof snapshot.finding === 'string' && (REPAIR_FINDING_KINDS as readonly string[]).includes(snapshot.finding) &&
    typeof snapshot.headSha === 'string' && snapshot.headSha.trim() !== '' &&
    Number.isSafeInteger(snapshot.pullRequestNumber) && (snapshot.pullRequestNumber as number) > 0 &&
    (snapshot.executionProfile === 'routine' || snapshot.executionProfile === 'complex') &&
    snapshotProfileMatchesTaskShape(snapshot.taskShape as TaskShape, snapshot.executionProfile as 'routine' | 'complex') &&
    typeof snapshot.executionRevision === 'string' && snapshot.executionRevision.trim() !== '' &&
    isResolvedExecution(snapshot.execution) && snapshot.execution.profile === snapshot.executionProfile &&
    snapshot.execution.revision === snapshot.executionRevision &&
    typeof snapshot.admittedAt === 'string';
}

function isResolvedExecution(value: unknown): value is ResolvedExecutionConfiguration {
  if (typeof value !== 'object' || value === null) return false;
  const execution = value as Record<string, unknown>;
  return (execution.profile === 'routine' || execution.profile === 'standard' || execution.profile === 'complex' || execution.profile === 'critical') &&
    typeof execution.revision === 'string' && execution.revision.trim() !== '' &&
    typeof execution.executor === 'string' && execution.executor.trim() !== '' &&
    Number.isSafeInteger(execution.timeoutMs) && (execution.timeoutMs as number) > 0;
}

/** Pure mapping. In particular, `finding` is not inspected to classify work. */
export function decideRepairAdmission(authority: RepairTaskShapeAuthority): RepairAdmissionDecision {
  switch (authority.shape) {
    case 'bounded': return { kind: 'admit', executionProfile: 'routine' };
    case 'interacting': return { kind: 'admit', executionProfile: 'complex' };
    case 'decision': return { kind: 'park', escalation: 'decision_required' };
  }
}

export function createRepairAdmissionSnapshot(
  authority: RepairTaskShapeAuthority,
  finding: RepairFindingKind,
  headSha: string,
  pullRequestNumber: number,
  execution: ResolvedExecutionConfiguration,
  admittedAt: string,
): RepairAdmissionSnapshot {
  if (!isRepairTaskShapeAuthority(authority)) throw new Error('Repair task-shape authority is invalid.');
  if (headSha.trim() === '' || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error('Repair admission requires an exact non-empty HEAD and pull request number.');
  }
  if ((execution.profile !== 'routine' && execution.profile !== 'complex') || !isResolvedExecution(execution)) {
    throw new Error('Repair admission requires a resolved routine or complex execution profile.');
  }
  if (!snapshotProfileMatchesTaskShape(authority.shape, execution.profile)) {
    throw new Error('Repair admission execution profile does not match the explicit task-shape authority.');
  }
  return { authorityRevision: authority.revision, taskShape: authority.shape, taxonomyRevision: REPAIR_FINDING_TAXONOMY_REVISION,
    finding, headSha, pullRequestNumber, executionProfile: execution.profile, executionRevision: execution.revision, execution, admittedAt };
}

/** Receipts must replay the same closed mapping used at admission. */
function snapshotProfileMatchesTaskShape(shape: TaskShape, profile: 'routine' | 'complex'): boolean {
  return (shape === 'bounded' && profile === 'routine') ||
    (shape === 'interacting' && profile === 'complex');
}

/** Strict JSON boundary for unattended CLI creation; prose is never classified. */
export function parseRepairTaskShapeAuthority(raw: string): RepairTaskShapeAuthority {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Repair task-shape authority must be valid JSON.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'revision' && key !== 'shape') || !isRepairTaskShapeAuthority(value)) {
    throw new Error('Repair task-shape authority must be strict JSON with non-empty revision and shape (bounded, interacting, or decision).');
  }
  return value;
}
