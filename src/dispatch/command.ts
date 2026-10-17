import { oracleDigest } from '../oracle/source-evidence.js';
import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import type { Run } from '../domain/types.js';
import type { RepairTaskShapeAuthority } from '../domain/repair-admission.js';
import type { WorkflowDependencies, WorkflowOutcome } from '../workflow/run.js';
import type { DispatchConfiguration } from './config.js';
import { claimedRun, dispatchOnce, type DispatchOnceResult, type DispatchRuntimeApi } from './runner.js';
import type { MissionAdmissionRegistry } from '../mission-admission/registry.js';
import { hasValidDispatchAuthority, selectDispatchRuntime } from './queue.js';

export interface DispatchCommandRuntime extends DispatchRuntimeApi {
  readQueueComment(): Promise<string>;
}

export interface DispatchCommandDependencies {
  readonly workflow: WorkflowDependencies;
  readonly runtime: DispatchCommandRuntime;
  readonly resolveExecutionProfile: (profile: string) => ResolvedExecutionConfiguration;
  readonly runIssue: (ref: string, execution: ResolvedExecutionConfiguration | undefined, dispatchClaimId: string, repairTaskShapeAuthority: RepairTaskShapeAuthority, admission?: MissionAdmissionRegistry, releaseAdmissionLock?: () => void, withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>, assertReviewClaim?: (run: Run) => Promise<void>, assertMergeInitiation?: (run: Run) => Promise<void>) => Promise<WorkflowOutcome>;
  /** Resume the Run bound by the retained runtime claim, never a target lookup. */
  readonly resumeClaimedRun: (run: Run, dispatchClaimId: string, admission?: MissionAdmissionRegistry, releaseAdmissionLock?: () => void, withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>, assertReviewClaim?: (run: Run) => Promise<void>, assertMergeInitiation?: (run: Run) => Promise<void>) => Promise<WorkflowOutcome>;
  /** Executable CLI always supplies the host-global admission registry. */
  readonly admission?: MissionAdmissionRegistry;
  /** Lock held around prepare; execution releases it immediately before model-capable workflow entry. */
  readonly releaseAdmissionLock?: () => void;
  /** Reacquire the short control-plane lock for claim heartbeat/finalization writes. */
  readonly withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>;
  /** Must settle exact live merge proof and admission under the held prepare lock. */
  readonly reconcileMergedRun?: (run: Run) => Promise<Run | null>;
  /** Exact released lane/receipt proof; retirement does not establish delivery. */
  readonly isRunOwnerRetired?: (run: Run) => boolean;
  readonly now?: () => string;
  readonly maintenanceHold?: boolean;
  readonly issuedMergeRecoveryOnly?: boolean;
}

function outcomeState(outcome: WorkflowOutcome): WorkflowOutcome['run']['state'] {
  return outcome.run.state;
}

/** Run or resume exactly one claimed queue item through the existing workflow. */
export async function dispatchOnceCommand(
  config: DispatchConfiguration,
  deps: DispatchCommandDependencies,
): Promise<DispatchOnceResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  return await dispatchOnce({
    queueBody: deps.maintenanceHold || deps.issuedMergeRecoveryOnly ? '' : await deps.runtime.readQueueComment(),
    maintenanceHold: deps.maintenanceHold,
    issuedMergeRecoveryOnly: deps.issuedMergeRecoveryOnly,
    owner: config.owner,
    repo: config.repo,
    github: deps.workflow.github,
    store: deps.workflow.store,
    runtime: deps.runtime,
    leaseDurationMs: config.leaseDurationMs,
    now,
    withAdmissionLock: deps.withAdmissionLock,
    releaseAdmissionLock: deps.releaseAdmissionLock,
    admission: deps.admission,
    reconcileMergedRun: deps.reconcileMergedRun,
    isRunOwnerRetired: deps.isRunOwnerRetired,
    async execute(entry, existing, claim) {
      const assertReviewClaim = async (run: Run) => {
        const live = selectDispatchRuntime(await deps.runtime.listRuntimeComments());
        if (live === null || live.claim.claimId !== claim.claimId || live.claim.issue !== claim.issue || live.claim.profile !== claim.profile ||
          !['running', 'claimed'].includes(live.claim.state) || JSON.stringify(live.claim.repairTaskShapeAuthority) !== JSON.stringify(claim.repairTaskShapeAuthority) ||
          claimedRun(deps.workflow.store, live.claim, entry, config)?.id !== run.id) throw new Error('Native review retained dispatch claim is missing, replaced, or differently bound.');
      };
      const assertMergeInitiation = async (run: Run) => {
        if (deps.maintenanceHold || !config.merge || !deps.workflow.nativeMergeHost || oracleDigest(config.merge) !== oracleDigest(deps.workflow.nativeMergeHost.policy) ||
          config.merge.dispatchRevision !== config.revision || config.merge.owner !== config.owner || config.merge.repo !== config.repo || config.merge.controlIssue !== config.controlIssue || config.merge.queueCommentId !== config.queueCommentId) throw new Error('Native merge lacks identical accepted-release and current dispatch scope authority.');
        await assertReviewClaim(run);
      };
      if (existing !== null) {
        if (existing.execution === undefined) {
          throw new Error(`Durable run ${existing.id} does not retain the queue-selected immutable execution profile.`);
        }
        if (existing.execution.profile !== entry.profile) {
          throw new Error(`Durable run ${existing.id} profile does not match the retained dispatch claim.`);
        }
        if (claim.repairTaskShapeAuthority !== undefined &&
          (existing.repairTaskShapeAuthority?.revision !== claim.repairTaskShapeAuthority.revision ||
            existing.repairTaskShapeAuthority.shape !== claim.repairTaskShapeAuthority.shape)) {
          throw new Error(`Durable run ${existing.id} task-shape authority does not match the retained dispatch claim.`);
        }
        const outcome = await deps.resumeClaimedRun(existing, claim.claimId, deps.admission, deps.releaseAdmissionLock, deps.withAdmissionLock, assertReviewClaim, assertMergeInitiation);
        return { runId: outcome.run.id, state: outcomeState(outcome), ...(outcome.run.state === 'MERGE_READY' && outcome.run.nativeReview !== undefined ? { waitForPoll: true } : {}) };
      }
      if (!hasValidDispatchAuthority(entry)) {
        throw new Error(`Queue issue #${entry.issue} lacks explicit revisioned task-shape authority.`);
      }
      if (claim.repairTaskShapeAuthority === undefined ||
        claim.repairTaskShapeAuthority.revision !== entry.repairTaskShapeAuthority.revision ||
        claim.repairTaskShapeAuthority.shape !== entry.repairTaskShapeAuthority.shape) {
        throw new Error(`Dispatch claim ${claim.claimId} does not retain the queue-selected task-shape authority.`);
      }
      const selected = deps.resolveExecutionProfile(entry.profile);
      const outcome = await deps.runIssue(`${config.owner}/${config.repo}#${entry.issue}`, selected, claim.claimId, entry.repairTaskShapeAuthority, deps.admission, deps.releaseAdmissionLock, deps.withAdmissionLock, assertReviewClaim, assertMergeInitiation);
      return { runId: outcome.run.id, state: outcomeState(outcome), ...(outcome.run.state === 'MERGE_READY' && outcome.run.nativeReview !== undefined ? { waitForPoll: true } : {}) };
    },
  });
}
