import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import type { Run } from '../domain/types.js';
import type { RepairTaskShapeAuthority } from '../domain/repair-admission.js';
import type { WorkflowDependencies, WorkflowOutcome } from '../workflow/run.js';
import type { DispatchConfiguration } from './config.js';
import { dispatchOnce, type DispatchOnceResult, type DispatchRuntimeApi } from './runner.js';
import type { MissionAdmissionRegistry } from '../mission-admission/registry.js';

export interface DispatchCommandRuntime extends DispatchRuntimeApi {
  readQueueComment(): Promise<string>;
}

export interface DispatchCommandDependencies {
  readonly workflow: WorkflowDependencies;
  readonly runtime: DispatchCommandRuntime;
  readonly resolveExecutionProfile: (profile: string) => ResolvedExecutionConfiguration;
  readonly runIssue: (ref: string, execution: ResolvedExecutionConfiguration | undefined, dispatchClaimId: string, repairTaskShapeAuthority: RepairTaskShapeAuthority, admission?: MissionAdmissionRegistry, releaseAdmissionLock?: () => void, withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>) => Promise<WorkflowOutcome>;
  /** Resume the Run bound by the retained runtime claim, never a target lookup. */
  readonly resumeClaimedRun: (run: Run, dispatchClaimId: string, admission?: MissionAdmissionRegistry, releaseAdmissionLock?: () => void, withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>) => Promise<WorkflowOutcome>;
  /** Executable CLI always supplies the host-global admission registry. */
  readonly admission?: MissionAdmissionRegistry;
  /** Lock held around prepare; execution releases it immediately before model-capable workflow entry. */
  readonly releaseAdmissionLock?: () => void;
  /** Reacquire the short control-plane lock for claim heartbeat/finalization writes. */
  readonly withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>;
  readonly now?: () => string;
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
    queueBody: await deps.runtime.readQueueComment(),
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
    async execute(entry, existing, claim) {
      if (existing !== null) {
        if (existing.execution === undefined) {
          throw new Error(`Durable run ${existing.id} does not retain the queue-selected immutable execution profile.`);
        }
        if (existing.execution.profile !== entry.profile) {
          throw new Error(`Durable run ${existing.id} profile does not match the retained dispatch claim.`);
        }
        const outcome = await deps.resumeClaimedRun(existing, claim.claimId, deps.admission, deps.releaseAdmissionLock, deps.withAdmissionLock);
        return { runId: outcome.run.id, state: outcomeState(outcome) };
      }
      const selected = deps.resolveExecutionProfile(entry.profile);
      if (entry.repairTaskShapeAuthority === undefined) {
        throw new Error(`Queue issue #${entry.issue} lacks explicit revisioned task-shape authority.`);
      }
      const outcome = await deps.runIssue(`${config.owner}/${config.repo}#${entry.issue}`, selected, claim.claimId, entry.repairTaskShapeAuthority, deps.admission, deps.releaseAdmissionLock, deps.withAdmissionLock);
      return { runId: outcome.run.id, state: outcomeState(outcome) };
    },
  });
}
