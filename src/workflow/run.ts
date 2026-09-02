import {
  humanTakeoverReason,
  type ImplementationAgent,
  type ImplementationCapabilityResolver,
  type WorkspaceGuard,
} from '../adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition, isReviewFresh } from '../domain/state-machine.js';
import type { ExecutorIdentity, Run, Target } from '../domain/types.js';
import { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION } from '../domain/decisions.js';
import { runReviewLoop } from '../reviewers/loop.js';
import type { RunStore } from '../store/json-file-store.js';
import { parkBootstrapFailure } from './bootstrap-failure.js';
import { pullRequestIdentityConflict } from './pull-request-identity.js';

export { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION as SYNC_LIVE_HEAD_DECISION } from '../domain/decisions.js';
export const RETRY_READINESS_DECISION = 'Retry readiness checks';

export interface WorkflowDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly bootstrap?: ImplementationBootstrapAdapter;
  readonly reviewer: ReviewerAdapter;
  readonly resolveImplementationCapabilities?: ImplementationCapabilityResolver;
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

function renderBlockingFindings(run: Run): string | null {
  if (run.reviewResult?.verdict !== 'request_changes') return null;
  const findings = run.reviewResult.findings
    .filter((finding) => finding.severity === 'blocking')
    .map((finding, index) => `${index + 1}. [blocking] ${finding.summary}${finding.detail === undefined ? '' : ` — ${finding.detail}`}`)
    .join('\n');
  return findings === '' ? null : findings;
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

function bootstrapFailureOutcome(
  run: Run,
  error: unknown,
  store: RunStore,
  now: () => string,
  executor?: ExecutorIdentity,
): WorkflowOutcome {
  const parked = parkBootstrapFailure(run, error, store, now, {
    prefix: 'Implementation bootstrap could not establish durable Git state',
    retryChoice: 'Resolve the bootstrap collision or Git state and retry',
    ...(executor === undefined ? {} : { executor }),
  });
  return { outcome: 'needs_human', ...parked };
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
        if (snapshot.issue.state !== 'open') {
          const reason = `Issue ${formatTarget(target)} is no longer open; refusing to start or continue implementation.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: { evidence: reason, choices: [CANCEL_RUN_DECISION] },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        const pendingReviewFix =
          run.reviewResult?.verdict === 'request_changes' && run.reviewResult.headSha === run.headSha;
        const implementationIdentityConflict = pendingReviewFix
          ? pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true })
          : null;
        if (implementationIdentityConflict !== null) {
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason: implementationIdentityConflict,
              interrupt: {
                evidence: implementationIdentityConflict,
                choices: ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason: implementationIdentityConflict };
        }
        if (pendingReviewFix && snapshot.headSha !== run.headSha) {
          const reason = `Live GitHub HEAD ${snapshot.headSha} does not match the interrupted review-fix HEAD ${run.headSha ?? '(none)'}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices: [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        let bootstrap = run.bootstrap;
        let workspaceGuard: WorkspaceGuard | undefined;
        if (!pendingReviewFix && snapshot.pullRequest === null) {
          const baseBranch = snapshot.repository.defaultBranch;
          const liveBaseSha = snapshot.repository.defaultBranchHeadSha;
          if (baseBranch === null || liveBaseSha === null || baseBranch === '' || liveBaseSha === '') {
            const reason = `No authoritative implementation base is available for ${formatTarget(target)}.`;
            run = applyTransition(
              run,
              {
                type: 'escalate',
                reason,
                interrupt: {
                  evidence: reason,
                  choices: ['Retry after restoring the repository default branch', CANCEL_RUN_DECISION],
                },
              },
              now(),
            );
            store.update(run);
            return { outcome: 'needs_human', run, reason };
          }
          if (deps.bootstrap === undefined) {
            return bootstrapFailureOutcome(
              run,
              new Error('No implementation bootstrap adapter is configured for a Ready Issue without a pull request.'),
              store,
              now,
            );
          }
          try {
            if (run.bootstrap === undefined) {
              bootstrap = await deps.bootstrap.plan({
                runId: run.id,
                target,
                baseBranch,
                baseSha: liveBaseSha,
              });
              run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap }, now());
              store.update(run);
            }
            bootstrap = await deps.bootstrap.prepare({
              runId: run.id,
              target,
              baseBranch,
              baseSha: liveBaseSha,
              existing: bootstrap,
            });
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
        } else if (bootstrap !== undefined) {
          if (deps.bootstrap === undefined) {
            return bootstrapFailureOutcome(
              run,
              new Error('The persisted implementation bootstrap cannot be reconstructed because its adapter is unavailable.'),
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
            return bootstrapFailureOutcome(run, error, store, now);
          }
        }

        if (bootstrap !== undefined) {
          if (deps.bootstrap === undefined) {
            return bootstrapFailureOutcome(
              run,
              new Error('The persisted implementation bootstrap guard is unavailable.'),
              store,
              now,
            );
          }
          try {
            workspaceGuard = deps.bootstrap.guard(bootstrap);
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
        }

        if (!pendingReviewFix && bootstrap !== undefined) {
          try {
            snapshot = await github.readLiveSnapshot(target);
          } catch (error) {
            return githubFailureOutcome(run, error, store, now);
          }
          if (snapshot.issue.state !== 'open') {
            const reason = `Issue ${formatTarget(target)} closed while implementation state was being prepared.`;
            run = applyTransition(
              run,
              { type: 'escalate', reason, interrupt: { evidence: reason, choices: [CANCEL_RUN_DECISION] } },
              now(),
            );
            store.update(run);
            return { outcome: 'needs_human', run, reason };
          }
          if (snapshot.pullRequest !== null) {
            if (deps.bootstrap === undefined || snapshot.headSha === null) {
              return bootstrapFailureOutcome(
                run,
                new Error('An associated pull request appeared without a verifiable bootstrap HEAD.'),
                store,
                now,
              );
            }
            try {
              await deps.bootstrap.verifyDurable({ identity: bootstrap, expectedHeadSha: snapshot.headSha });
            } catch (error) {
              return bootstrapFailureOutcome(run, error, store, now);
            }
            const recoveredResult = {
              exitStatus: 'success' as const,
              summary: `Recovered durable implementation from pull request #${snapshot.pullRequest.number}.`,
              headSha: snapshot.headSha,
            };
            run = applyTransition(
              run,
              { type: 'agent_succeeded', agentResult: recoveredResult, headSha: snapshot.headSha },
              now(),
            );
            store.update(run);
            break;
          }
          if (snapshot.repository.defaultBranch !== bootstrap.baseBranch ||
            snapshot.repository.defaultBranchHeadSha !== bootstrap.baseSha) {
            return bootstrapFailureOutcome(
              run,
              new Error(
                `Live default branch moved after bootstrap preparation; expected ${bootstrap.baseBranch}@${bootstrap.baseSha}.`,
              ),
              store,
              now,
            );
          }
        }

        const pendingFixInstructions = pendingReviewFix ? renderBlockingFindings(run) : null;
        const baseSha = pendingReviewFix
          ? run.headSha
          : snapshot.pullRequest?.baseSha ?? bootstrap?.baseSha ?? snapshot.repository.defaultBranchHeadSha;
        if (baseSha === null || baseSha === undefined || baseSha === '') {
          const reason = `No authoritative implementation base is available for ${formatTarget(target)}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices: ['Retry after restoring the repository default branch', CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        const instructions = pendingFixInstructions ?? (
          snapshot.pullRequest === null
            ? `${snapshot.issue.body}\n\nConductor requirement: work only in prepared branch ${bootstrap?.branch ?? '(unavailable)'} from ${snapshot.repository.defaultBranch}@${baseSha}; commit and push all meaningful changes, then create one associated open implementation pull request before reporting success. Do not create another branch or workspace.`
            : snapshot.issue.body
        );
        const supplementalInstructions = pendingFixInstructions ?? (
          snapshot.pullRequest === null
            ? `Conductor prepared branch ${bootstrap?.branch ?? '(unavailable)'} from ${snapshot.repository.defaultBranch}@${baseSha}. Commit and push all meaningful changes, then create one associated open implementation pull request. Do not create another branch or workspace.`
            : undefined
        );
        const result = await implementation.run({
          target,
          baseSha,
          ...(bootstrap === undefined ? {} : { workspacePath: bootstrap.workspacePath, branch: bootstrap.branch }),
          ...(workspaceGuard === undefined ? {} : { workspaceGuard }),
          authority: 'live-target',
          instructions,
          ...(supplementalInstructions === undefined ? {} : { supplementalInstructions }),
          capabilities: await deps.resolveImplementationCapabilities?.(),
          ...(run.agentResult?.sessionId === undefined ? {} : { sessionId: run.agentResult.sessionId }),
          ...(run.executor === undefined ? {} : { executor: run.executor }),
        });
        if (result.exitStatus === 'failure') {
          const takeoverReason = humanTakeoverReason(result);
          if (takeoverReason !== undefined) {
            run = applyTransition(
              run,
              {
                type: 'escalate',
                reason: takeoverReason,
                ...(result.executor === undefined ? {} : { executor: result.executor }),
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
          run = applyTransition(run, { type: 'agent_failed', agentResult: result, headSha: result.headSha }, now());
          store.update(run);
          return { outcome: 'failed', run, reason: `Implementation failed: ${result.summary}` };
        }
        if (bootstrap !== undefined) {
          if (deps.bootstrap === undefined) {
            return bootstrapFailureOutcome(
              run,
              new Error('The implementation completed but durable bootstrap verification is unavailable.'),
              store,
              now,
            );
          }
          try {
            await deps.bootstrap.verifyDurable({ identity: bootstrap, expectedHeadSha: result.headSha ?? '' });
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now, result.executor);
          }
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
        const identityConflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
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
        const livePullRequest = snapshot.pullRequest;
        if (livePullRequest === null || livePullRequest.state !== 'open' ||
          snapshot.headSha === null || snapshot.headSha !== run.headSha || livePullRequest.headSha !== run.headSha) {
          const reason =
            livePullRequest === null || livePullRequest.state !== 'open' || snapshot.headSha === null
              ? `Implementation completed, but ${formatTarget(target)} still has no associated open pull request.`
              : `Live pull request #${livePullRequest.number} HEAD ${livePullRequest.headSha} does not match the implementation HEAD ${run.headSha ?? '(none)'}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices:
                  livePullRequest === null || livePullRequest.state !== 'open' || snapshot.headSha === null
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
            pullRequest: { number: livePullRequest.number, headSha: livePullRequest.headSha },
          },
          now(),
        );
        store.update(run);
        break;
      }

      case 'REVIEWING':
      case 'CHANGES_REQUESTED': {
        const loop = await runReviewLoop(
          {
            store,
            github,
            implementation,
            reviewer,
            bootstrap: deps.bootstrap,
            resolveImplementationCapabilities: deps.resolveImplementationCapabilities,
          },
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
        const identityConflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
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
        if (snapshot.headSha !== run.headSha) {
          const reason = `Final gate observed live GitHub HEAD ${snapshot.headSha ?? '(none)'} but the approved run HEAD is ${run.headSha ?? '(none)'}.`;
          run = applyTransition(
            run,
            {
              type: 'escalate',
              reason,
              interrupt: {
                evidence: reason,
                choices: snapshot.headSha === null ? [CANCEL_RUN_DECISION] : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
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
          snapshot.reviews.unresolvedThreads === null
            ? 'review thread state is unavailable'
            : snapshot.reviews.unresolvedThreads > 0
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
