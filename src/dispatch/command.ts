import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import type { WorkflowDependencies, WorkflowOutcome } from '../workflow/run.js';
import type { DispatchConfiguration } from './config.js';
import { dispatchOnce, type DispatchOnceResult, type DispatchRuntimeApi } from './runner.js';

export interface DispatchCommandRuntime extends DispatchRuntimeApi {
  readQueueComment(): Promise<string>;
}

export interface DispatchCommandDependencies {
  readonly workflow: WorkflowDependencies;
  readonly runtime: DispatchCommandRuntime;
  readonly resolveExecutionProfile: (profile: string) => ResolvedExecutionConfiguration;
  readonly runIssue: (ref: string, execution: ResolvedExecutionConfiguration | undefined) => Promise<WorkflowOutcome>;
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
    async execute(entry, existing) {
      if (existing !== null) {
        if (existing.execution === undefined) {
          throw new Error(`Durable run ${existing.id} does not retain the queue-selected immutable execution profile.`);
        }
        const outcome = await deps.runIssue(`${config.owner}/${config.repo}#${entry.issue}`, undefined);
        return { runId: outcome.run.id, state: outcomeState(outcome) };
      }
      const selected = deps.resolveExecutionProfile(entry.profile);
      const outcome = await deps.runIssue(`${config.owner}/${config.repo}#${entry.issue}`, selected);
      return { runId: outcome.run.id, state: outcomeState(outcome) };
    },
  });
}
