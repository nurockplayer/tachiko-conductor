import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import type { ExecutorIdentity } from './types.js';
import { randomUUID } from 'node:crypto';

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
  /** Exact durable start_fix event and executor state this receipt authorizes. Absent only on legacy JSON. */
  readonly attemptBinding?: RepairAttemptBinding;
}

export interface RepairAttemptBinding {
  readonly admissionIndex: number;
  readonly startFixHistoryIndex: number;
  readonly predecessorExecutor?: ExecutorIdentity;
  readonly predecessorSessionId?: string;
  /** Whether predecessor continuation is unsafe for the selected executor. */
  readonly freshExecutor: boolean;
  /** Exact Run-owned generation supplied to both preflight and invocation. */
  readonly runtimeGeneration: string;
}

export type RepairExecutorHandoff =
  | { readonly kind: 'executor'; readonly identity: ExecutorIdentity }
  | { readonly kind: 'sessionless'; readonly provider: 'worker-router' };

export interface RepairHandoffRecord {
  readonly admissionHistoryIndex: number;
  readonly startFixHistoryIndex: number;
  readonly outcome: RepairExecutorHandoff;
}

export function createRepairAttemptBinding(run: {
  readonly repairAdmissions?: readonly RepairAdmissionSnapshot[];
  readonly history: readonly unknown[];
  readonly executor?: ExecutorIdentity;
  readonly agentResult?: { readonly sessionId?: string };
}, execution: ResolvedExecutionConfiguration): RepairAttemptBinding {
  const priorProviderCompatible = run.executor?.provider === execution.executor ||
    (run.executor?.provider === 'codex-app-server' && execution.executor === 'codex-cli');
  const fresh = execution.executor === 'luna-isolated' || execution.executor === 'worker-router' ||
    (run.executor !== undefined && !priorProviderCompatible) ||
    (run.executor === undefined && run.agentResult?.sessionId !== undefined);
  const runtimeGeneration = fresh ? `repair-${randomUUID()}` : run.executor?.generation ?? `repair-${randomUUID()}`;
  return {
    admissionIndex: run.repairAdmissions?.length ?? 0,
    startFixHistoryIndex: run.history.length,
    ...(run.executor === undefined ? {} : { predecessorExecutor: { ...run.executor } }),
    ...(run.agentResult?.sessionId === undefined ? {} : { predecessorSessionId: run.agentResult.sessionId }),
    freshExecutor: fresh,
    runtimeGeneration,
  };
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
    typeof snapshot.admittedAt === 'string' &&
    (snapshot.attemptBinding === undefined || (isRepairAttemptBinding(snapshot.attemptBinding) &&
      isAttemptBindingCompatible(snapshot.execution.executor, snapshot.attemptBinding)));
}

function isAttemptBindingCompatible(selectedProvider: string, binding: RepairAttemptBinding): boolean {
  const predecessor = binding.predecessorExecutor?.provider;
  const continuationCompatible = predecessor === selectedProvider ||
    (predecessor === 'codex-app-server' && selectedProvider === 'codex-cli');
  const freshRequired = selectedProvider === 'luna-isolated' || selectedProvider === 'worker-router' ||
    (predecessor !== undefined && !continuationCompatible) ||
    (predecessor === undefined && binding.predecessorSessionId !== undefined);
  if (binding.freshExecutor !== freshRequired) return false;
  if (!binding.freshExecutor && binding.predecessorExecutor?.generation !== undefined &&
      binding.runtimeGeneration !== binding.predecessorExecutor.generation) return false;
  return !(binding.freshExecutor && binding.predecessorExecutor?.generation === binding.runtimeGeneration);
}

function isRepairAttemptBinding(value: unknown): value is RepairAttemptBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Record<string, unknown>;
  return Number.isSafeInteger(binding.admissionIndex) && (binding.admissionIndex as number) >= 0 &&
    Number.isSafeInteger(binding.startFixHistoryIndex) && (binding.startFixHistoryIndex as number) >= 0 &&
    (binding.predecessorExecutor === undefined || isRepairExecutorIdentity(binding.predecessorExecutor)) &&
    (binding.predecessorSessionId === undefined || (typeof binding.predecessorSessionId === 'string' && binding.predecessorSessionId.trim() !== '')) &&
    typeof binding.freshExecutor === 'boolean' && typeof binding.runtimeGeneration === 'string' && binding.runtimeGeneration.trim() !== '';
}

export function isRepairExecutorIdentity(value: unknown): value is ExecutorIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.provider === 'string' && identity.provider.trim() !== '' &&
    typeof identity.sessionId === 'string' && identity.sessionId.trim() !== '' &&
    (identity.generation === undefined || (typeof identity.generation === 'string' && identity.generation.trim() !== ''));
}

export function isRepairHandoffRecord(value: unknown): value is RepairHandoffRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.admissionHistoryIndex) || (record.admissionHistoryIndex as number) < 0 ||
      !Number.isSafeInteger(record.startFixHistoryIndex) || (record.startFixHistoryIndex as number) < 0 ||
      typeof record.outcome !== 'object' || record.outcome === null) return false;
  const outcome = record.outcome as Record<string, unknown>;
  return outcome.kind === 'executor' ? isRepairExecutorIdentity(outcome.identity) :
    outcome.kind === 'sessionless' && outcome.provider === 'worker-router';
}

/** Current unfinished start_fix is the only receipt that can authorize repair execution. */
export function activeRepairAdmission(run: {
  readonly state: string;
  readonly history: readonly { readonly type: string; readonly from?: string; readonly to: string; readonly repairAdmissionIndex?: number; readonly repairHandoff?: RepairHandoffRecord }[];
  readonly repairAdmissions?: readonly RepairAdmissionSnapshot[];
  readonly repairTaskShapeAuthority?: RepairTaskShapeAuthority;
  readonly executor?: ExecutorIdentity;
  readonly agentResult?: { readonly sessionId?: string; readonly executor?: ExecutorIdentity };
  readonly headSha?: string;
  readonly pullRequest?: { readonly number: number };
  readonly validationResult?: { readonly status?: string };
  readonly reviewResult?: { readonly verdict?: string };
}): { readonly snapshot: RepairAdmissionSnapshot; readonly admissionHistoryIndex: number; readonly startFixHistoryIndex: number; readonly handoff?: RepairHandoffRecord } | null {
  if (run.state !== 'IMPLEMENTING' || run.headSha === undefined || run.pullRequest === undefined || run.repairTaskShapeAuthority === undefined) return null;
  let startFixHistoryIndex = -1;
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    const event = run.history[index]!;
    if (event.type === 'start_fix' && event.from === 'CHANGES_REQUESTED' && event.to === 'IMPLEMENTING') { startFixHistoryIndex = index; break; }
  }
  if (startFixHistoryIndex < 0 || run.history.slice(startFixHistoryIndex + 1).some((event) => event.type === 'agent_succeeded' || event.type === 'agent_failed')) return null;
  const markerIndex = run.history[startFixHistoryIndex]?.repairAdmissionIndex;
  if (!Number.isSafeInteger(markerIndex) || markerIndex === undefined) return null;
  const snapshot = (run.repairAdmissions ?? []).find((candidate, index) => isRepairAdmissionSnapshot(candidate) && candidate.attemptBinding?.admissionIndex === index &&
    index === markerIndex && candidate.attemptBinding.startFixHistoryIndex === startFixHistoryIndex &&
    candidate.authorityRevision === run.repairTaskShapeAuthority!.revision && candidate.taskShape === run.repairTaskShapeAuthority!.shape &&
    candidate.headSha === run.headSha && candidate.pullRequestNumber === run.pullRequest!.number);
  const expectedFinding = run.validationResult?.status === 'failed' && run.reviewResult?.verdict !== 'request_changes'
    ? 'validation_failed'
    : 'review_blocking';
  if (snapshot === undefined || snapshot.finding !== expectedFinding) return null;
  const admissionHistoryIndex = (run.repairAdmissions ?? []).indexOf(snapshot);
  const handoffEvent = [...run.history].map((event, index) => ({ event, index })).reverse().find(({ event }) =>
    (event.type === 'repair_executor_handoff' || event.type === 'repair_executor_continued') &&
    event.repairHandoff?.admissionHistoryIndex === admissionHistoryIndex &&
    event.repairHandoff.startFixHistoryIndex === startFixHistoryIndex);
  const handoff = handoffEvent?.event.repairHandoff;
  const binding = snapshot.attemptBinding!;
  if (handoff === undefined) {
    if (!sameExecutor(run.executor, binding.predecessorExecutor) ||
        (run.agentResult?.executor !== undefined && !sameExecutor(run.agentResult.executor, binding.predecessorExecutor)) ||
        run.agentResult?.sessionId !== binding.predecessorSessionId) return null;
  } else if (handoff.outcome.kind === 'sessionless') {
    if (run.executor !== undefined || run.agentResult?.executor !== undefined || run.agentResult?.sessionId !== undefined) return null;
  } else {
    const adopted = handoff.outcome.identity;
    if (!sameExecutor(run.executor, adopted) ||
        (run.agentResult?.executor !== undefined && !sameExecutor(run.agentResult.executor, adopted)) ||
        (run.agentResult?.sessionId !== undefined && run.agentResult.sessionId !== adopted.sessionId)) return null;
  }
  return { snapshot, admissionHistoryIndex, startFixHistoryIndex, ...(handoff === undefined ? {} : { handoff }) };
}

function sameExecutor(a: ExecutorIdentity | undefined, b: ExecutorIdentity | undefined): boolean {
  return a?.provider === b?.provider && a?.sessionId === b?.sessionId && a?.generation === b?.generation &&
    (a === undefined) === (b === undefined);
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
