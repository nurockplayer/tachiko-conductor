import {
  humanTakeoverReason,
  type ImplementationAgent,
  type McpHttpCapability,
} from '../adapters/agent.js';
import type { GitHubAdapter } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition, isReviewFresh } from '../domain/state-machine.js';
import type { Run, Target } from '../domain/types.js';
import { renderReviewFindings, runReviewLoop } from '../reviewers/loop.js';
import type { RunStore } from '../store/json-file-store.js';

export interface WorkflowDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly reviewer: ReviewerAdapter;
  readonly implementationCapabilities?: readonly McpHttpCapability[];
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
        const snapshot = await github.readLiveSnapshot(target);
        if (snapshot.headSha === null) {
          const reason = `Issue ${formatTarget(target)} has no open pull request to implement against.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: { evidence: reason, choices: ['Open a PR and retry', 'Cancel the run'] },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        const pendingReviewFix =
          run.reviewResult?.verdict === 'request_changes' && run.reviewResult.headSha === run.headSha;
        if (pendingReviewFix && snapshot.headSha !== run.headSha) {
          const reason = `Live GitHub HEAD ${snapshot.headSha} does not match the interrupted review-fix HEAD ${run.headSha ?? '(none)'}.`;
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
        const baseSha = pendingReviewFix ? (run.headSha ?? '') : (snapshot.pullRequest?.baseSha ?? '');
        const result = await implementation.run({
          target,
          baseSha,
          instructions: pendingReviewFix ? renderReviewFindings(run.reviewResult!) : snapshot.issue.body,
          capabilities: deps.implementationCapabilities,
        });
        if (result.exitStatus === 'failure') {
          const takeoverReason = humanTakeoverReason(result);
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
          run = applyTransition(run, { type: 'agent_failed', agentResult: result, headSha: result.headSha }, now());
          store.update(run);
          return { outcome: 'failed', run, reason: `Implementation failed: ${result.summary}` };
        }
        run = applyTransition(run, { type: 'agent_succeeded', agentResult: result, headSha: result.headSha }, now());
        store.update(run);
        break;
      }

      case 'VALIDATING':
        run = applyTransition(run, { type: 'validation_passed' }, now());
        store.update(run);
        break;

      case 'REVIEWING':
      case 'CHANGES_REQUESTED': {
        const loop = await runReviewLoop(
          { store, github, implementation, reviewer, implementationCapabilities: deps.implementationCapabilities },
          run.id,
          {
          maxAttempts: options.maxReviewAttempts,
          now,
          },
        );
        run = loop.run;
        if (loop.outcome === 'needs_human') return { outcome: 'needs_human', run, reason: loop.reason };
        if (loop.outcome === 'failed') return { outcome: 'failed', run, reason: loop.reason };
        break;
      }

      case 'FINAL_GATE': {
        // A resume may land here after a review; pass only a fresh review.
        if (isReviewFresh(run)) {
          run = applyTransition(run, { type: 'gate_passed' }, now());
        } else {
          run = applyTransition(run, { type: 'gate_blocked' }, now());
        }
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
