import {
  humanTakeoverReason,
  type ImplementationAgent,
  type McpHttpCapability,
} from '../adapters/agent.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition, isReviewFresh } from '../domain/state-machine.js';
import type { ReviewResult, Run, Target } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';

export interface ReviewLoopDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly reviewer: ReviewerAdapter;
  readonly implementationCapabilities?: readonly McpHttpCapability[];
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

function renderFindings(review: ReviewResult): string {
  if (review.findings.length === 0) return '';
  return review.findings
    .map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.summary}${finding.detail === undefined ? '' : ` — ${finding.detail}`}`)
    .join('\n');
}

/**
 * Drive the review → fix → re-review loop for one issue-target run through the
 * core state machine. GitHub live state wins: the loop re-reads the live PR
 * HEAD before every review and escalates instead of reviewing a stale
 * identity. `approve` advances to FINAL_GATE and, when the review is fresh for
 * the exact HEAD, to MERGE_READY. `request_changes` routes only the blocking
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

  let run = store.read(runId);
  if (run === null) throw new Error(`No run with id "${runId}" found.`);
  if (run.state !== 'REVIEWING' && run.state !== 'CHANGES_REQUESTED') {
    throw new Error(`runReviewLoop requires the run in REVIEWING or CHANGES_REQUESTED; it is in ${run.state}.`);
  }
  const target = run.target;
  if (target.kind !== 'issue') {
    throw new Error('runReviewLoop currently supports issue-target runs only.');
  }

  let attempts = 0;
  for (;;) {
    const snapshot = await github.readLiveSnapshot(target);
    const liveHead = snapshot.headSha;
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
            choices: ['Sync the run to the live HEAD and continue', 'Cancel the run'],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    const reviewResult = await reviewer.review({
      target,
      headSha: run.headSha,
      instructions: renderFindings(run.reviewResult ?? { verdict: 'request_changes', reviewerName: '', headSha: '', findings: [] }),
    });
    attempts += 1;

    if (reviewResult.verdict === 'approve') {
      run = applyTransition(run, { type: 'review_approved', reviewResult }, now());
      store.update(run);
      if (isReviewFresh(run)) {
        run = applyTransition(run, { type: 'gate_passed' }, now());
        store.update(run);
        return { outcome: 'approved', run };
      }
      // Fail-safe: a review bound to the current HEAD is always fresh; if the
      // core ever disagrees, route back to REVIEWING instead of guessing.
      run = applyTransition(run, { type: 'gate_blocked' }, now());
      store.update(run);
      continue;
    }

    run = applyTransition(run, { type: 'changes_requested', reviewResult }, now());
    store.update(run);
    if (attempts >= options.maxAttempts) {
      const reason = `Review did not converge after ${options.maxAttempts} attempt(s).`;
      run = applyTransition(
        run,
        {
          type: 'escalate',
          reason,
          interrupt: {
            evidence: reason,
            choices: ['Approve the current HEAD manually', 'Provide more context and retry', 'Cancel the run'],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    // Enter IMPLEMENTING first so both agent_succeeded and agent_failed are
    // valid transitions out of it.
    run = applyTransition(run, { type: 'start_fix' }, now());
    store.update(run);

    const fixResult = await implementation.run({
      target,
      baseSha: run.headSha ?? '',
      instructions: renderFindings(reviewResult),
      capabilities: deps.implementationCapabilities,
    });
    if (fixResult.exitStatus === 'failure') {
      const takeoverReason = humanTakeoverReason(fixResult);
      if (takeoverReason !== undefined) {
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason: takeoverReason,
            interrupt: {
              evidence: takeoverReason,
              choices: ['Complete human bootstrap/takeover and resume', 'Cancel the run'],
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
            choices: ['Retry the fix with more context', 'Cancel the run'],
          },
        },
        now(),
      );
      store.update(run);
      return { outcome: 'needs_human', run, reason };
    }

    run = applyTransition(run, { type: 'agent_succeeded', agentResult: fixResult, headSha: fixResult.headSha }, now());
    store.update(run);
    run = applyTransition(run, { type: 'validation_passed' }, now());
    store.update(run);
  }
}
