import {
  humanTakeoverReason,
  type ImplementationAgent,
  type ImplementationCapabilityResolver,
} from '../adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../adapters/bootstrap.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition } from '../domain/state-machine.js';
import type { ExecutorIdentity, ReviewResult, Run, Target } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION } from '../domain/decisions.js';
import { parkBootstrapFailure as persistBootstrapFailure } from '../workflow/bootstrap-failure.js';
import { pullRequestIdentityConflict } from '../workflow/pull-request-identity.js';

export interface ReviewLoopDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly bootstrap?: ImplementationBootstrapAdapter;
  readonly reviewer: ReviewerAdapter;
  readonly resolveImplementationCapabilities?: ImplementationCapabilityResolver;
}

export interface ReviewLoopOptions {
  /** Maximum review attempts before the loop escalates to NEEDS_HUMAN. */
  readonly maxAttempts: number;
  readonly now?: () => string;
}

export type ReviewLoopResult =
  | { readonly outcome: 'approved'; readonly run: Run }
  | { readonly outcome: 'needs_human'; readonly run: Run; readonly reason: string }
  | { readonly outcome: 'failed'; readonly run: Run; readonly reason: string };

function formatTarget(target: Target): string {
  if (target.kind === 'issue') return `${target.owner}/${target.repo}#${target.issueNumber}`;
  return `${target.owner}/${target.repo}@${target.branch}`;
}

function renderBlockingFindings(review: ReviewResult): string {
  return review.findings
    .filter((finding) => finding.severity === 'blocking')
    .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.summary}${finding.detail === undefined ? '' : ` — ${finding.detail}`}`)
    .join('\n');
}

function durableReviewAttempts(run: Run): number {
  let attemptWindowStart = 0;
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    if (run.history[index]?.type === 'human_resolved') {
      attemptWindowStart = index + 1;
      break;
    }
  }
  return run.history.slice(attemptWindowStart).filter(
    (entry) => entry.type === 'review_approved' || entry.type === 'changes_requested',
  ).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : null;
}

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true;
}

function renderFailure(prefix: string, error: unknown): string {
  const code = errorCode(error);
  return `${prefix}${code === null ? '' : ` (${code})`}: ${errorMessage(error)}`;
}

function parkBootstrapFailure(
  run: Run,
  error: unknown,
  store: RunStore,
  now: () => string,
  executor?: ExecutorIdentity,
): ReviewLoopResult {
  const parked = persistBootstrapFailure(run, error, store, now, {
    prefix: 'Implementation bootstrap recovery failed',
    retryChoice: 'Resolve the bootstrap Git state and retry',
    ...(executor === undefined ? {} : { executor }),
  });
  return { outcome: 'needs_human', ...parked };
}

/**
 * Drive the review → fix → re-review loop for one issue-target run through the
 * core state machine. GitHub live state wins: the loop re-reads the live PR
 * HEAD before every review and escalates instead of reviewing a stale
 * identity. `approve` advances only to persisted FINAL_GATE; the final-gate
 * workflow owns the fresh readiness re-read before MERGE_READY.
 * `request_changes` routes only the blocking
 * findings back to the implementation agent, which must land at a new exact
 * HEAD. Non-convergence escalates to NEEDS_HUMAN; an implementation failure
 * fails the run.
 */
export async function runReviewLoop(
  deps: ReviewLoopDependencies,
  runId: string,
  options: ReviewLoopOptions,
): Promise<ReviewLoopResult> {
  const { store, github, implementation, reviewer } = deps;
  const now = options.now ?? (() => new Date().toISOString());

  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error('runReviewLoop maxAttempts must be a positive integer.');
  }

  let run = store.read(runId);
  if (run === null) throw new Error(`No run with id "${runId}" found.`);
  if (run.state !== 'REVIEWING' && run.state !== 'CHANGES_REQUESTED') {
    throw new Error(`runReviewLoop requires the run in REVIEWING or CHANGES_REQUESTED; it is in ${run.state}.`);
  }
  const target = run.target;
  if (target.kind !== 'issue') {
    throw new Error('runReviewLoop currently supports issue-target runs only.');
  }

  for (;;) {
    if (run.state === 'CHANGES_REQUESTED') {
      if (durableReviewAttempts(run) >= options.maxAttempts) {
        const reason = `Review did not converge after ${options.maxAttempts} attempt(s).`;
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason,
            interrupt: {
              evidence: reason,
              choices: ['Provide more GitHub context and retry', CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      const pendingReview = run.reviewResult;
      if (pendingReview === undefined || pendingReview.verdict !== 'request_changes') {
        const reason = 'Persisted CHANGES_REQUESTED run has no actionable review result.';
        run = applyTransition(run, { type: 'fail', reason }, now());
        store.update(run);
        return { outcome: 'failed', run, reason };
      }

      let preFixSnapshot: Awaited<ReturnType<GitHubAdapter['readLiveSnapshot']>>;
      try {
        preFixSnapshot = await github.readLiveSnapshot(target);
      } catch (error) {
        const reason = renderFailure('GitHub live-state validation failed before the fix', error);
        run = applyTransition(
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
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      const preFixIdentityConflict = pullRequestIdentityConflict(run, preFixSnapshot, { allowHeadAdvance: true });
      if (preFixIdentityConflict !== null) {
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason: preFixIdentityConflict,
            interrupt: {
              evidence: preFixIdentityConflict,
              choices: ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason: preFixIdentityConflict };
      }
      if (preFixSnapshot.headSha !== run.headSha) {
        const reason = `Live GitHub HEAD ${preFixSnapshot.headSha ?? '(none)'} does not match the review-fix HEAD ${run.headSha ?? '(none)'}.`;
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason,
            interrupt: {
              evidence: reason,
              choices: preFixSnapshot.headSha === null
                ? [CANCEL_RUN_DECISION]
                : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }

      run = applyTransition(run, { type: 'start_fix' }, now());
      store.update(run);

      let bootstrap = run.bootstrap;
      if (bootstrap !== undefined) {
        if (deps.bootstrap === undefined) {
          return parkBootstrapFailure(
            run,
            new Error('The persisted implementation bootstrap adapter is unavailable.'),
            store,
            now,
          );
        }
        try {
          bootstrap = await deps.bootstrap.prepare({
            runId: run.id,
            target,
            baseBranch: bootstrap.baseBranch,
            baseSha: bootstrap.baseSha,
            existing: bootstrap,
          });
        } catch (error) {
          return parkBootstrapFailure(run, error, store, now);
        }
      }

      const blockingFindings = renderBlockingFindings(pendingReview);
      const fixResult = await implementation.run({
        target,
        baseSha: run.headSha ?? '',
        ...(bootstrap === undefined ? {} : { workspacePath: bootstrap.workspacePath, branch: bootstrap.branch }),
        authority: 'live-target',
        instructions: blockingFindings,
        supplementalInstructions: blockingFindings,
        capabilities: await deps.resolveImplementationCapabilities?.(),
        sessionId: run.agentResult?.sessionId,
        executor: run.executor,
      });
      if (fixResult.exitStatus === 'failure') {
        const takeoverReason = humanTakeoverReason(fixResult);
        if (takeoverReason !== undefined) {
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason: takeoverReason,
              ...(fixResult.executor === undefined ? {} : { executor: fixResult.executor }),
              interrupt: {
                evidence: takeoverReason,
                choices: ['Complete human bootstrap/takeover and resume', CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason: takeoverReason };
        }
        run = applyTransition(run, { type: 'agent_failed', agentResult: fixResult, headSha: fixResult.headSha }, now());
        store.update(run);
        return { outcome: 'failed', run, reason: `Implementation failed while fixing review findings: ${fixResult.summary}` };
      }
      if (fixResult.headSha === undefined || fixResult.headSha === run.headSha) {
        const reason = 'Implementation did not produce a new exact HEAD after review changes.';
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason,
            interrupt: {
              evidence: 'The implementation returned the same or no HEAD after review changes.',
              choices: ['Retry the fix after updating GitHub context', CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      if (bootstrap !== undefined) {
        if (deps.bootstrap === undefined) {
          return parkBootstrapFailure(
            run,
            new Error('Durable implementation verification is unavailable.'),
            store,
            now,
            fixResult.executor,
          );
        }
        try {
          await deps.bootstrap.verifyDurable({ identity: bootstrap, expectedHeadSha: fixResult.headSha });
        } catch (error) {
          return parkBootstrapFailure(run, error, store, now, fixResult.executor);
        }
      }

      run = applyTransition(run, { type: 'agent_succeeded', agentResult: fixResult, headSha: fixResult.headSha }, now());
      store.update(run);
      let validatedSnapshot: Awaited<ReturnType<GitHubAdapter['readLiveSnapshot']>>;
      try {
        validatedSnapshot = await github.readLiveSnapshot(target);
      } catch (error) {
        const reason = renderFailure('GitHub live-state validation failed after the fix', error);
        run = applyTransition(
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
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      const identityConflict = pullRequestIdentityConflict(run, validatedSnapshot, { allowHeadAdvance: true });
      if (identityConflict !== null) {
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason: identityConflict,
            interrupt: {
              evidence: identityConflict,
              choices: ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason: identityConflict };
      }
      const validatedPullRequest = validatedSnapshot.pullRequest;
      if (validatedPullRequest === null || validatedPullRequest.state !== 'open' ||
        validatedSnapshot.headSha !== fixResult.headSha || validatedPullRequest.headSha !== fixResult.headSha) {
        const reason = validatedPullRequest === null || validatedPullRequest.state !== 'open'
          ? `The fix completed, but ${formatTarget(target)} has no associated open pull request.`
          : `Live pull request #${validatedPullRequest.number} HEAD ${validatedPullRequest.headSha} does not match the fix HEAD ${fixResult.headSha}.`;
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason,
            interrupt: {
              evidence: reason,
              choices: validatedPullRequest === null || validatedPullRequest.state !== 'open' || validatedSnapshot.headSha === null
                ? ['Open the implementation pull request and retry', CANCEL_RUN_DECISION]
                : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      run = applyTransition(
        run,
        {
          type: 'validation_passed',
          pullRequest: {
            number: validatedPullRequest.number,
            headSha: validatedPullRequest.headSha,
          },
        },
        now(),
      );
      store.update(run);
      continue;
    }

    if (durableReviewAttempts(run) >= options.maxAttempts) {
      const reason = `Review attempt limit of ${options.maxAttempts} was already reached.`;
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason,
          interrupt: {
            evidence: reason,
            choices: ['Provide more GitHub context and retry', CANCEL_RUN_DECISION],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    let liveSnapshot: Awaited<ReturnType<GitHubAdapter['readLiveSnapshot']>>;
    try {
      liveSnapshot = await github.readLiveSnapshot(target);
    } catch (error) {
      const reason = renderFailure('GitHub live-state validation failed', error);
      const type = isRetryable(error) ? 'escalate' : 'fail';
      run = applyTransition(
        run,
        type === 'escalate'
          ? {
              type,
              reason,
              interrupt: {
                evidence: reason,
                choices: ['Retry after restoring GitHub access', CANCEL_RUN_DECISION],
              },
            }
          : { type, reason },
        now(),
      );
      store.update(run);
      return type === 'escalate'
        ? { outcome: 'needs_human', run, reason }
        : { outcome: 'failed', run, reason };
    }
    const identityConflict = pullRequestIdentityConflict(run, liveSnapshot, { allowHeadAdvance: true });
    if (identityConflict !== null) {
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason: identityConflict,
          interrupt: {
            evidence: identityConflict,
            choices: ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason: identityConflict };
    }
    const liveHead = liveSnapshot.headSha;
    if (liveHead === null || liveHead !== run.headSha) {
      const reason =
        liveHead === null
          ? `No live PR HEAD for ${formatTarget(target)}.`
          : `Live GitHub HEAD ${liveHead} does not match the run HEAD ${run.headSha ?? '(none)'}.`;
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason,
          interrupt: {
            evidence: reason,
            choices: liveHead === null
              ? ['Open the implementation pull request and retry', CANCEL_RUN_DECISION]
              : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    let reviewResult: ReviewResult;
    try {
      reviewResult = await reviewer.review({
        target,
        headSha: run.headSha,
        instructions: renderBlockingFindings(
          run.reviewResult ?? { verdict: 'request_changes', reviewerName: '', headSha: '', findings: [] },
        ),
      });
    } catch (error) {
      const reason = renderFailure('Reviewer failed', error);
      const type = isRetryable(error) ? 'escalate' : 'fail';
      run = applyTransition(
        run,
        type === 'escalate'
          ? {
              type,
              reason,
              interrupt: {
                evidence: reason,
                choices: ['Retry the independent review', CANCEL_RUN_DECISION],
              },
            }
          : { type, reason },
        now(),
      );
      store.update(run);
      return type === 'escalate'
        ? { outcome: 'needs_human', run, reason }
        : { outcome: 'failed', run, reason };
    }

    if (reviewResult.headSha !== run.headSha) {
      const reason = `Reviewer returned HEAD ${reviewResult.headSha} for run HEAD ${run.headSha ?? '(none)'}.`;
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason,
          interrupt: {
            evidence: reason,
            choices: ['Retry the independent review', CANCEL_RUN_DECISION],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    if (reviewResult.verdict === 'approve') {
      run = applyTransition(run, { type: 'review_approved', reviewResult }, now());
      store.update(run);
      return { outcome: 'approved', run };
    }

    run = applyTransition(run, { type: 'changes_requested', reviewResult }, now());
    store.update(run);
  }
}
