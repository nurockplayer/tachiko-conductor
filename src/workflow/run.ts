import type { ImplementationAgent } from '../adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition, isReviewFresh } from '../domain/state-machine.js';
import type { Run, Target } from '../domain/types.js';
import { runReviewLoop } from '../reviewers/loop.js';
import type { RunStore } from '../store/json-file-store.js';

export const CANCEL_RUN_DECISION = 'Cancel the run';
export const SYNC_LIVE_HEAD_DECISION = 'Sync the run to the live HEAD and continue';
export const RETRY_READINESS_DECISION = 'Retry readiness checks';

export interface WorkflowDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly reviewer: ReviewerAdapter;
}

export interface WorkflowOptions {
  /** Bounded review attempts before the loop escalates to NEEDS_HUMAN. */
  readonly maxReviewAttempts: number;
  readonly now?: () => string;
}

export type WorkflowOutcome =
  | { readonly outcome: 'merge_ready'; readonly run: Run }
  | { readonly outcome: 'merged'; readonly run: Run }
  | { readonly outcome: 'needs_human'; readonly run: Run; readonly reason: string }
  | { readonly outcome: 'failed'; readonly run: Run; readonly reason: string };

function formatTarget(target: Target): string {
  if (target.kind === 'issue') return `${target.owner}/${target.repo}#${target.issueNumber}`;
  return `${target.owner}/${target.repo}@${target.branch}`;
}

function githubFailureOutcome(run: Run, error: unknown, store: RunStore, now: () => string): WorkflowOutcome {
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `GitHub live state could not be read safely: ${detail}`;
  const parked = applyTransition(
    run,
    {
      type: 'escalate',
      reason,
      interrupt: {
        evidence: reason,
        choices: ['Retry after restoring GitHub access', CANCEL_RUN_DECISION],
      },
    },
    now(),
  );
  store.update(parked);
  return { outcome: 'needs_human', run: parked, reason };
}

/**
 * Wire the core state machine, GitHub live state, the implementation agent,
 * and the independent reviewer into one state-resume-aware workflow. Given a
 * persisted run id it picks up exactly where the run is; it stops at
 * MERGE_READY, FAILED, or NEEDS_HUMAN (with reason and, when known, bounded
 * choices). Escalation beats guessing: unsupported conditions park the run in
 * NEEDS_HUMAN instead of being coerced forward.
 */
export async function runWorkflow(
  deps: WorkflowDependencies,
  runId: string,
  options: WorkflowOptions,
): Promise<WorkflowOutcome> {
  const { store, github, implementation, reviewer } = deps;
  const now = options.now ?? (() => new Date().toISOString());

  let run = store.read(runId);
  if (run === null) throw new Error(`No run with id "${runId}" found.`);
  if (run.target.kind !== 'issue') {
    throw new Error('runWorkflow currently supports issue-target runs only.');
  }
  const target = run.target;

  for (;;) {
    switch (run.state) {
      case 'READY':
        run = applyTransition(run, { type: 'start' }, now());
        store.update(run);
        break;

      case 'IMPLEMENTING': {
        let snapshot: GitHubLiveSnapshot;
        try {
          snapshot = await github.readLiveSnapshot(target);
        } catch (error) {
          return githubFailureOutcome(run, error, store, now);
        }
        const baseSha = snapshot.pullRequest?.baseSha ?? '';
        const result = await implementation.run({
          target,
          baseSha,
          instructions: snapshot.issue.body,
          ...(run.agentResult?.sessionId === undefined ? {} : { sessionId: run.agentResult.sessionId }),
        });
        if (result.exitStatus === 'failure') {
          run = applyTransition(run, { type: 'agent_failed', agentResult: result, headSha: result.headSha }, now());
          store.update(run);
          return { outcome: 'failed', run, reason: `Implementation failed: ${result.summary}` };
        }
        run = applyTransition(run, { type: 'agent_succeeded', agentResult: result, headSha: result.headSha }, now());
        store.update(run);
        break;
      }

      case 'VALIDATING': {
        let snapshot: GitHubLiveSnapshot;
        try {
          snapshot = await github.readLiveSnapshot(target);
        } catch (error) {
          return githubFailureOutcome(run, error, store, now);
        }
        if (snapshot.headSha === null || snapshot.headSha !== run.headSha) {
          const reason =
            snapshot.headSha === null
              ? `Implementation completed, but ${formatTarget(target)} still has no associated open pull request.`
              : `Live GitHub HEAD ${snapshot.headSha} does not match the implementation HEAD ${run.headSha ?? '(none)'}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices:
                  snapshot.headSha === null
                    ? ['Open the implementation pull request and retry', CANCEL_RUN_DECISION]
                    : [SYNC_LIVE_HEAD_DECISION, CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        run = applyTransition(run, { type: 'validation_passed' }, now());
        store.update(run);
        break;
      }

      case 'REVIEWING':
      case 'CHANGES_REQUESTED': {
        const loop = await runReviewLoop({ store, github, implementation, reviewer }, run.id, {
          maxAttempts: options.maxReviewAttempts,
          now,
        });
        run = loop.run;
        if (loop.outcome === 'needs_human') return { outcome: 'needs_human', run, reason: loop.reason };
        if (loop.outcome === 'failed') return { outcome: 'failed', run, reason: loop.reason };
        break;
      }

      case 'FINAL_GATE': {
        if (!isReviewFresh(run)) {
          run = applyTransition(run, { type: 'gate_blocked' }, now());
          store.update(run);
          break;
        }

        // The persisted review is necessary but not sufficient: re-read all
        // live GitHub readiness data immediately before MERGE_READY so a push,
        // draft conversion, failing check, unresolved thread, or mergeability
        // change after review can never slip through the final gate.
        let snapshot: GitHubLiveSnapshot;
        try {
          snapshot = await github.readLiveSnapshot(target);
        } catch (error) {
          return githubFailureOutcome(run, error, store, now);
        }
        if (snapshot.headSha !== run.headSha) {
          const reason = `Final gate observed live GitHub HEAD ${snapshot.headSha ?? '(none)'} but the approved run HEAD is ${run.headSha ?? '(none)'}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices: snapshot.headSha === null ? [CANCEL_RUN_DECISION] : [SYNC_LIVE_HEAD_DECISION, CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }

        const pullRequest = snapshot.pullRequest;
        const mergeState = pullRequest?.mergeStateStatus?.toUpperCase() ?? null;
        const contradictory = snapshot.problems.find((problem) => problem.code === 'CONTRADICTORY_STATE');
        const readinessProblems = [
          snapshot.issue.state !== 'open' ? 'the issue is not open' : null,
          pullRequest === null || pullRequest.state !== 'open' ? 'the pull request is not open' : null,
          pullRequest?.isDraft === true ? 'the pull request is still a draft' : null,
          pullRequest?.mergeable !== true ? 'GitHub does not report the pull request as mergeable' : null,
          mergeState !== null && mergeState !== 'CLEAN' && mergeState !== 'HAS_HOOKS'
            ? `merge state is ${mergeState}`
            : null,
          snapshot.checks.overall !== 'passing' ? `checks are ${snapshot.checks.overall}` : null,
          snapshot.reviews.unresolvedThreads !== null && snapshot.reviews.unresolvedThreads > 0
            ? `${snapshot.reviews.unresolvedThreads} review thread(s) remain unresolved`
            : null,
          contradictory?.message ?? null,
        ].filter((problem): problem is string => problem !== null);

        if (readinessProblems.length > 0) {
          const reason = `Final GitHub readiness gate is blocked: ${readinessProblems.join('; ')}.`;
          const checksPending = snapshot.checks.overall === 'pending' && readinessProblems.length === 1;
          run = applyTransition(
            run,
            {
              type: checksPending ? 'wait_dependency' : 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices: [checksPending ? RETRY_READINESS_DECISION : 'Resolve the GitHub readiness blockers and retry', CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }

        run = applyTransition(run, { type: 'gate_passed' }, now());
        store.update(run);
        break;
      }

      case 'MERGE_READY':
        return { outcome: 'merge_ready', run };

      case 'MERGED':
        return { outcome: 'merged', run };

      case 'NEEDS_HUMAN':
        return { outcome: 'needs_human', run, reason: run.interrupt?.reason ?? 'Awaiting a human decision.' };

      case 'WAITING_DEPENDENCY':
        return { outcome: 'needs_human', run, reason: run.interrupt?.reason ?? 'Awaiting an external dependency.' };

      case 'FAILED':
        return { outcome: 'failed', run, reason: run.history.at(-1)?.reason ?? 'The run failed.' };
    }
  }
}
