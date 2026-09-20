import {
  humanTakeoverReason,
  isWorkspaceGuardFailure,
  type ImplementationAgent,
  type ImplementationCapabilityResolver,
  type WorkspaceGuard,
} from '../adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../adapters/bootstrap.js';
import { createCompletionInputFromResult, recordCompletionTelemetry, recordSpawnTelemetry } from '../domain/telemetry.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import { applyTransition, isTerminal, isValidationFresh, validationEvidenceMatchesActive, type ActiveValidationConfiguration } from '../domain/state-machine.js';
import { isValidationResultCoherent } from '../domain/validation.js';
import type { ReviewResult, Run, Target } from '../domain/types.js';
import {
  createRepairAdmissionSnapshot,
  decideRepairAdmission,
  type RepairFindingKind,
} from '../domain/repair-admission.js';
import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';
import type { RunStore } from '../store/json-file-store.js';
import { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION, RECOVER_LEGACY_PULL_REQUEST_DECISION } from '../domain/decisions.js';
import { parkBootstrapFailure } from '../workflow/bootstrap-failure.js';
import { pullRequestIdentityConflict } from '../workflow/pull-request-identity.js';

export interface ReviewLoopDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly bootstrap?: ImplementationBootstrapAdapter;
  readonly bootstrapForExecution?: (execution: ResolvedExecutionConfiguration | undefined) => ImplementationBootstrapAdapter | undefined;
  readonly reviewer: ReviewerAdapter;
  /**
   * Resolves the active validation-policy identity at each reviewer effect
   * boundary. It is required even for direct callers so no public review path
   * can treat omitted or stale policy as a wildcard.
   */
  readonly resolveValidationAuthority: () => ActiveValidationConfiguration;
  readonly resolveImplementationCapabilities?: ImplementationCapabilityResolver;
  /**
   * Resolves only the provider-neutral profile selected by explicit repair
   * authority. It is intentionally absent for legacy runs, which have no
   * retroactive task-shape classification.
   */
  readonly resolveRepairExecutionProfile?: (profile: 'routine' | 'complex') => ResolvedExecutionConfiguration | undefined;
}

export interface ReviewLoopOptions {
  /** Maximum review attempts before the loop escalates to NEEDS_HUMAN. */
  readonly maxAttempts: number;
  readonly now?: () => string;
}

export type ReviewLoopResult =
  | { readonly outcome: 'approved'; readonly run: Run }
  | { readonly outcome: 'revalidating'; readonly run: Run; readonly reason: string }
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

/**
 * One persisted repair budget covers both reviewer-directed and
 * post-implementation validation repairs. Reading history makes the limit
 * survive restart rather than resetting with a new process. An authority
 * revalidation intentionally starts a new window because it invalidates the
 * review whose historical admission would otherwise consume that window.
 */
function durableRepairAttempts(run: Run): number {
  let attemptWindowStart = 0;
  for (let index = run.history.length - 1; index >= 0; index -= 1) {
    if (run.history[index]?.type === 'human_resolved' || run.history[index]?.type === 'revalidate') {
      attemptWindowStart = index + 1;
      break;
    }
  }
  return run.history.slice(attemptWindowStart).filter(
    (entry) => entry.type === 'validation_failed' || entry.type === 'review_approved' || entry.type === 'changes_requested',
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

function parkBootstrap(run: Run, error: unknown, store: RunStore, now: () => string): ReviewLoopResult {
  const executor = isWorkspaceGuardFailure(error) ? error.executor ?? run.executor : run.executor;
  const parked = parkBootstrapFailure(run, error, store, now, executor);
  return { outcome: 'needs_human', ...parked };
}

type ReviewAdmission =
  | { readonly kind: 'admitted'; readonly activeValidation: ActiveValidationConfiguration }
  | { readonly kind: 'revalidate'; readonly reason: string }
  | { readonly kind: 'needs_human'; readonly reason: string };

/**
 * The sole review-admission invariant. This runs both immediately before the
 * reviewer effect and after it resolves, before any verdict is persisted.
 * Policy/evidence drift is recoverable validation work; a moved or
 * contradictory live identity remains an explicit human live-HEAD sync path.
 */
function reviewAdmission(
  run: Run,
  snapshot: GitHubLiveSnapshot,
  resolveValidationAuthority: () => ActiveValidationConfiguration,
): ReviewAdmission {
  const target = run.target;
  if (target.kind !== 'issue' ||
    snapshot.repository.owner.toLowerCase() !== target.owner.toLowerCase() ||
    snapshot.repository.repo.toLowerCase() !== target.repo.toLowerCase() ||
    snapshot.issue.number !== target.issueNumber) {
    return { kind: 'needs_human', reason: 'Live GitHub repository or Issue identity no longer matches the accepted run.' };
  }
  const acceptedPullRequest = run.pullRequest;
  if (run.headSha === undefined || run.headSha.trim() === '' || acceptedPullRequest === undefined ||
    acceptedPullRequest.headSha !== run.headSha || snapshot.pullRequest === null ||
    snapshot.pullRequest.number !== acceptedPullRequest.number ||
    snapshot.pullRequest.headSha !== run.headSha || snapshot.headSha !== run.headSha) {
    return {
      kind: 'needs_human',
      reason: `Live GitHub pull-request or exact HEAD identity no longer matches the accepted run (accepted PR #${acceptedPullRequest?.number ?? '(none)'}@${run.headSha ?? '(none)'}, live PR #${snapshot.pullRequest?.number ?? '(none)'}@${snapshot.headSha ?? '(none)'}).`,
    };
  }
  const validation = run.validationResult;
  if (!isValidationResultCoherent(validation) || validation.headSha !== run.headSha ||
    validation.hosted.pullRequestNumber !== acceptedPullRequest.number) {
    return { kind: 'revalidate', reason: 'Persisted validation evidence is not coherent with the accepted pull request and exact HEAD.' };
  }
  let active: ActiveValidationConfiguration;
  try {
    active = resolveValidationAuthority();
  } catch (error) {
    return { kind: 'revalidate', reason: `Active validation-policy identity could not be resolved: ${errorMessage(error)}` };
  }
  if (!isValidationFresh(run, active)) {
    return { kind: 'revalidate', reason: 'Persisted validation evidence does not match the freshly resolved active validation-policy identity.' };
  }
  return { kind: 'admitted', activeValidation: active };
}

function persistRevalidation(run: Run, reason: string, store: RunStore, now: () => string): ReviewLoopResult {
  const revalidating = applyTransition(run, { type: 'revalidate', reason }, now());
  store.update(revalidating);
  return { outcome: 'revalidating', run: revalidating, reason };
}

function parkAdmission(run: Run, reason: string, store: RunStore, now: () => string): ReviewLoopResult {
  const liveHeadMoved = run.headSha !== undefined && reason.includes('exact HEAD identity');
  const parked = applyTransition(run, {
    type: 'escalate',
    reason,
    interrupt: {
      evidence: reason,
      choices: liveHeadMoved ? [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION] : ['Resolve the GitHub identity conflict and retry', CANCEL_RUN_DECISION],
    },
  }, now());
  store.update(parked);
  return { outcome: 'needs_human', run: parked, reason };
}

function parkRepairAuthority(
  run: Run, reason: string, store: RunStore, now: () => string,
  choices: readonly string[] = ['Provide explicit repair authority or resolve execution availability', CANCEL_RUN_DECISION],
): ReviewLoopResult {
  const parked = applyTransition(run, {
    type: 'escalate', reason,
    interrupt: { evidence: reason, choices },
  }, now());
  store.update(parked);
  return { outcome: 'needs_human', run: parked, reason };
}

/** A failed admission CAS is itself durable safety evidence, never a silent return. */
function parkStaleRepairAdmission(runId: string, fallback: Run, store: RunStore, now: () => string): ReviewLoopResult {
  const reason = 'Repair admission parked: admission_stale.';
  let current = store.read(runId) ?? fallback;
  // A concurrent writer may win between read and escalation. Keep fencing the
  // freshest active snapshot; only an already parked or terminal snapshot is
  // preserved without an overwrite.
  for (;;) {
    if (current.state === 'NEEDS_HUMAN') return { outcome: 'needs_human', run: current, reason };
    if (isTerminal(current.state)) return { outcome: 'failed', run: current, reason };
    const parked = applyTransition(current, {
      type: 'escalate', reason,
      interrupt: { evidence: reason, choices: ['Re-admit the exact repair authority and execution profile', CANCEL_RUN_DECISION] },
    }, now());
    if (store.updateIfUnchanged === undefined) {
      store.update(parked);
    } else if (!store.updateIfUnchanged(current, parked)) {
      current = store.read(runId) ?? current;
      continue;
    }
    const persisted = store.read(runId) ?? parked;
    if (persisted.state === 'NEEDS_HUMAN') return { outcome: 'needs_human', run: persisted, reason };
    if (isTerminal(persisted.state)) return { outcome: 'failed', run: persisted, reason };
    current = persisted;
  }
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
  const { store, github, implementation, reviewer, resolveValidationAuthority } = deps;
  const now = options.now ?? (() => new Date().toISOString());

  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error('runReviewLoop maxAttempts must be a positive integer.');
  }
  if (typeof resolveValidationAuthority !== 'function') {
    throw new Error('runReviewLoop requires a current validation-authority resolver.');
  }

  const loaded = store.read(runId);
  if (loaded === null) throw new Error(`No run with id "${runId}" found.`);
  let run: Run = loaded;
  if (run.state !== 'REVIEWING' && run.state !== 'CHANGES_REQUESTED') {
    throw new Error(`runReviewLoop requires the run in REVIEWING or CHANGES_REQUESTED; it is in ${run.state}.`);
  }
  const target = run.target;
  if (target.kind !== 'issue') {
    throw new Error('runReviewLoop currently supports issue-target runs only.');
  }

  for (;;) {
    if (run.state === 'CHANGES_REQUESTED') {
      const validationFailure = run.validationResult?.status === 'failed';
      if (validationFailure) {
        let activeValidation: ActiveValidationConfiguration;
        try {
          activeValidation = resolveValidationAuthority();
        } catch (error) {
          return persistRevalidation(
            run,
            `Failed validation evidence cannot be admitted because current validation-policy authority is unavailable: ${errorMessage(error)}`,
            store,
            now,
          );
        }
        if (!isValidationResultCoherent(run.validationResult) ||
          run.validationResult.headSha !== run.headSha ||
          run.validationResult.hosted.pullRequestNumber !== run.pullRequest?.number ||
          !validationEvidenceMatchesActive(run.validationResult, activeValidation)) {
          return persistRevalidation(
            run,
            'Failed validation evidence is malformed, does not match the accepted PR/exact HEAD, or does not match the active validation-policy identity.',
            store,
            now,
          );
        }
      }
      if (durableRepairAttempts(run) >= options.maxAttempts) {
        const reason = `Review did not converge after ${options.maxAttempts} attempt(s); the shared post-implementation repair budget was exhausted.`;
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
      if ((pendingReview === undefined || pendingReview.verdict !== 'request_changes') && !validationFailure) {
        const reason = 'Persisted CHANGES_REQUESTED run has no actionable review or validation failure.';
        run = applyTransition(run, { type: 'fail', reason }, now());
        store.update(run);
        return { outcome: 'failed', run, reason };
      }

      // Failed validation is not repair authority on its own. After any stale
      // evidence is revalidated, a failure must be bound to an accepted PR and
      // exact HEAD before this loop may prepare a workspace or invoke the
      // implementation agent.
      if (run.pullRequest === undefined || run.headSha === undefined || run.pullRequest.headSha !== run.headSha) {
        const reason = 'Failed validation evidence is not bound to an accepted pull request and exact HEAD; refusing to authorize a repair.';
        run = applyTransition(
          run,
          {
            type: 'escalate', reason,
            interrupt: {
              evidence: reason,
              choices: [RECOVER_LEGACY_PULL_REQUEST_DECISION, CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }

      // A persisted review does not authorize local repair against a different
      // live PR. Re-read before preparation and again after local recovery.
      const checkOwnedFix = async (): Promise<ReviewLoopResult | null> => {
        try {
          const live = await github.readLiveSnapshot(target);
          const conflict = pullRequestIdentityConflict(run, live, { allowHeadAdvance: true });
          if (conflict === null && live.headSha === run.headSha) return null;
          const reason = conflict ?? 'Live GitHub HEAD changed before the review fix.';
          run = applyTransition(run, {
            type: 'escalate', reason,
            interrupt: { evidence: reason, choices: conflict === null
              ? [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION]
              : ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION] },
          }, now());
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        } catch (error) {
          return parkBootstrap(run, error, store, now);
        }
      };
      const preflight = await checkOwnedFix();
      if (preflight !== null) return preflight;

      // New runs may carry explicit, revisioned task-shape authority. Its
      // closed mapping is the sole authority for choosing a repair profile;
      // reviewer and Issue prose remains only worker context. Old JSON has no
      // such field and intentionally follows the pre-existing generic path.
      let repairExecution = run.execution;
      let repairStartsWithFreshExecutor = false;
      const authority = run.repairTaskShapeAuthority;
      if (authority !== undefined) {
        const decision = decideRepairAdmission(authority);
        if (decision.kind === 'park') {
          // The immutable decision-shaped authority cannot be made executable
          // by a generic resume. Do not advertise a retry that only parks it
          // again; Oracle/Steward must issue a new run/authority separately.
          return parkRepairAuthority(run, `Repair admission parked: ${decision.escalation}.`, store, now, [CANCEL_RUN_DECISION]);
        }
        if (deps.resolveRepairExecutionProfile === undefined) {
          return parkRepairAuthority(run, `Repair admission parked: ${decision.executionProfile} execution profile is unavailable.`, store, now);
        }
        try {
          repairExecution = deps.resolveRepairExecutionProfile(decision.executionProfile);
        } catch {
          repairExecution = undefined;
        }
        if (repairExecution === undefined || repairExecution.profile !== decision.executionProfile) {
          return parkRepairAuthority(run, `Repair admission parked: ${decision.executionProfile} execution profile is unavailable.`, store, now);
        }
        // A promoted repair may be assigned to another provider. Continuing a
        // prior provider's session across that boundary is not valid executor
        // continuity; intentionally start the selected profile fresh.
        repairStartsWithFreshExecutor = run.executor !== undefined && run.executor.provider !== repairExecution.executor;
        const finding: RepairFindingKind = validationFailure && (pendingReview === undefined || pendingReview.verdict !== 'request_changes')
          ? 'validation_failed'
          : 'review_blocking';
        const admission = createRepairAdmissionSnapshot(
          authority, finding, run.headSha, run.pullRequest.number, repairExecution, now(),
        );
        const admittedRun: Run = { ...run, repairAdmissions: [...(run.repairAdmissions ?? []), admission] };
        const startedFix = applyTransition(admittedRun, { type: 'start_fix' }, now());
        // An authority snapshot is useful only if it was appended against the
        // exact durable Run that was preflighted. Never invoke a worker after a
        // stale CAS, because another writer may have replaced its HEAD or PR.
        if (store.updateIfUnchanged === undefined || !store.updateIfUnchanged(run, startedFix)) {
          return parkStaleRepairAdmission(run.id, run, store, now);
        }
        run = startedFix;
        const admissionPreflight = await checkOwnedFix();
        if (admissionPreflight !== null) return admissionPreflight;
      }
      if (authority === undefined) {
        run = applyTransition(run, { type: 'start_fix' }, now());
        store.update(run);
      }

      const blockingFindings = validationFailure && (pendingReview === undefined || pendingReview.verdict !== 'request_changes')
        ? 'Exact-HEAD validation failed. Repair the implementation and its required validation before returning a new exact HEAD.'
        : renderBlockingFindings(pendingReview!);
      const progressBaseSha = run.headSha;
      // Workspace identity is durable authority across a promoted repair: a
      // Luna checkout cannot be silently reinterpreted as a linked worktree.
      const bootstrapExecution = run.bootstrap?.workspacePath.includes('/luna-') === true
        ? { ...repairExecution!, executor: 'luna-isolated' }
        : repairExecution;
      const repairBootstrap = deps.bootstrapForExecution?.(bootstrapExecution) ?? deps.bootstrap;
      const isolatedLuna = repairExecution?.executor === 'luna-isolated';
      let workspaceGuard: WorkspaceGuard | undefined;
      if (run.bootstrap !== undefined) {
        if (repairBootstrap === undefined || progressBaseSha === undefined) {
          return parkBootstrap(run, new Error('Review fix cannot prove its persisted implementation workspace.'), store, now);
        }
        try {
          await repairBootstrap.prepare({
            runId: run.id, target, baseBranch: run.bootstrap.baseBranch, baseSha: run.bootstrap.baseSha,
            existing: run.bootstrap, recoveryAuthority: { expectedHeadSha: progressBaseSha },
          });
          workspaceGuard = repairBootstrap.guard(run.bootstrap);
        } catch (error) {
          return parkBootstrap(run, error, store, now);
        }
        const recovered = await checkOwnedFix();
        if (recovered !== null) return recovered;
      }
      const workerSpawn = recordSpawnTelemetry(run, {
        role: 'worker',
        attemptKind: 'repair',
        ...(run.headSha === undefined ? {} : { headSha: run.headSha }),
        ...(repairExecution?.executor === undefined ? {} : { provider: repairExecution.executor }),
        ...(repairExecution?.model === undefined ? {} : { model: repairExecution.model }),
        ...(repairExecution?.reasoningEffort === undefined ? {} : { reasoningEffort: repairExecution.reasoningEffort }),
        ...(repairExecution?.profile === undefined ? {} : { profile: repairExecution.profile }),
        contextMode: 'bounded',
        contextJustification: 'live-target-bounded',
      }, now());
      const beforeSpawn = run;
      run = workerSpawn.run;
      // Admission's CAS also fenced IMPLEMENTING, but telemetry is another
      // durable transition before the side effect. Re-fence it so a later
      // cancellation/park cannot be overwritten or followed by a worker.
      if (authority !== undefined) {
        if (store.updateIfUnchanged === undefined || !store.updateIfUnchanged(beforeSpawn, run)) {
          return parkStaleRepairAdmission(run.id, beforeSpawn, store, now);
        }
      } else {
        store.update(run);
      }
      let fixResult;
      try {
        fixResult = await implementation.run({
          target, baseSha: progressBaseSha ?? '', authority: isolatedLuna ? 'embedded' : 'live-target', instructions: blockingFindings,
          ...(isolatedLuna ? {} : { supplementalInstructions: blockingFindings }),
          ...(run.bootstrap === undefined ? {} : { workspacePath: run.bootstrap.workspacePath, branch: run.bootstrap.branch, workspaceGuard }),
          capabilities: await deps.resolveImplementationCapabilities?.(),
          ...(repairStartsWithFreshExecutor || isolatedLuna ? {} : { sessionId: run.agentResult?.sessionId, executor: run.executor }),
          ...(repairExecution === undefined ? {} : { execution: repairExecution }),
        });
      } catch (error) {
        if (isWorkspaceGuardFailure(error)) return parkBootstrap(run, error, store, now);
        const detail = error instanceof Error ? error.message : String(error);
        run = recordCompletionTelemetry(run, createCompletionInputFromResult({
          exitStatus: 'failure',
          summary: detail,
          diagnostics: ['AGENT_RUNTIME_INVOCATION_FAILED: provider invocation threw before returning an AgentResult'],
        }, {
          ...(repairExecution?.executor === undefined ? {} : { provider: repairExecution.executor }),
          ...(repairExecution?.model === undefined ? {} : { model: repairExecution.model }),
          ...(repairExecution?.reasoningEffort === undefined ? {} : { reasoningEffort: repairExecution.reasoningEffort }),
        }, 'worker', workerSpawn.invocationId), now());
        store.update(run);
        throw error;
      }
      run = recordCompletionTelemetry(run, createCompletionInputFromResult(fixResult, {
        ...(repairExecution?.executor === undefined ? {} : { provider: repairExecution.executor }),
        ...(repairExecution?.model === undefined ? {} : { model: repairExecution.model }),
        ...(repairExecution?.reasoningEffort === undefined ? {} : { reasoningEffort: repairExecution.reasoningEffort }),
      }, 'worker', workerSpawn.invocationId), now());
      store.update(run);
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

      if (run.bootstrap !== undefined) {
        if (repairBootstrap === undefined || progressBaseSha === undefined) {
          return parkBootstrap(run, new Error('Durable review-fix verification is unavailable.'), store, now);
        }
        try {
          await repairBootstrap.verifyDurable({
            identity: run.bootstrap, expectedHeadSha: fixResult.headSha, progressBaseSha, workspaceGuard,
          });
        } catch (error) {
          return parkBootstrap(run, error, store, now);
        }
      }

      let validatedHead: string | null;
      let validatedSnapshot;
      try {
        validatedSnapshot = await github.readLiveSnapshot(target);
        validatedHead = validatedSnapshot.headSha;
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
      if (validatedHead !== fixResult.headSha) {
        const reason = `Live GitHub HEAD ${validatedHead ?? '(none)'} does not match the fix HEAD ${fixResult.headSha}.`;
        run = applyTransition(
          run,
          {
            type: 'escalate',
            reason,
            interrupt: {
              evidence: reason,
              choices: validatedHead === null
                ? ['Open the implementation pull request and retry', CANCEL_RUN_DECISION]
                : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
            },
          },
          now(),
        );
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      const conflict = pullRequestIdentityConflict(run, validatedSnapshot!, { allowHeadAdvance: true });
      if (conflict !== null || validatedSnapshot!.pullRequest === null ||
        (run.pullRequest !== undefined && validatedSnapshot!.pullRequest.number !== run.pullRequest.number)) {
        const reason = conflict ?? 'Live pull request disappeared or changed after the review fix.';
        run = applyTransition(run, { type: 'escalate', reason, interrupt: { evidence: reason, choices: ['Resolve the pull request identity conflict and retry', CANCEL_RUN_DECISION] } }, now());
        store.update(run);
        return { outcome: 'needs_human', run, reason };
      }
      run = applyTransition(run, {
        type: 'agent_succeeded', agentResult: fixResult, headSha: fixResult.headSha,
        pullRequest: { number: validatedSnapshot!.pullRequest.number, headSha: fixResult.headSha },
      }, now());
      store.update(run);
      // A new fix creates a new exact HEAD. Validation is owned by the outer
      // workflow so it must collect fresh local and hosted evidence before a
      // reviewer can see that HEAD.
      return {
        outcome: 'revalidating',
        run,
        reason: 'A repaired exact HEAD requires fresh validation before another independent review.',
      };
    }

    if (durableRepairAttempts(run) >= options.maxAttempts) {
      const reason = `Post-implementation repair budget of ${options.maxAttempts} attempt(s) was already reached.`;
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

    let liveHead: string | null;
    let liveSnapshot: GitHubLiveSnapshot;
    try {
      liveSnapshot = await github.readLiveSnapshot(target);
      liveHead = liveSnapshot.headSha;
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
    const identityConflict = pullRequestIdentityConflict(run, liveSnapshot, { allowHeadAdvance: true });
    if (identityConflict !== null) return parkBootstrap(run, new Error(identityConflict), store, now);

    const beforeReview = reviewAdmission(run, liveSnapshot, resolveValidationAuthority);
    if (beforeReview.kind === 'revalidate') return persistRevalidation(run, beforeReview.reason, store, now);
    if (beforeReview.kind === 'needs_human') return parkAdmission(run, beforeReview.reason, store, now);

    const reviewHeadSha = run.headSha;
    if (reviewHeadSha === undefined) return parkBootstrap(run, new Error('Reviewer admission requires an exact candidate HEAD.'), store, now);
    const reviewerSpawnsForHead = (run.telemetry?.events ?? []).filter(
      (event) => event.kind === 'spawn' && event.role === 'reviewer' && event.headSha === reviewHeadSha,
    ).length;
    const reviewerSpawn = recordSpawnTelemetry(run, {
      role: 'reviewer',
      attemptKind: reviewerSpawnsForHead === 0 ? 'review' : 'review_restart',
      ...(run.headSha === undefined ? {} : { headSha: run.headSha }),
      contextMode: 'bounded',
      contextJustification: 'live-target-bounded',
    }, now());
    run = reviewerSpawn.run;
    store.update(run);
    let reviewResult: ReviewResult;
    try {
      reviewResult = await reviewer.review({
        target,
        headSha: reviewHeadSha,
        instructions: renderBlockingFindings(
          run.reviewResult ?? { verdict: 'request_changes', reviewerName: '', headSha: '', findings: [] },
        ),
      });
    } catch (error) {
      const reason = renderFailure('Reviewer failed', error);
      run = recordCompletionTelemetry(run, createCompletionInputFromResult({
        exitStatus: 'failure',
        diagnostics: ['REVIEWER_INVOCATION_FAILED: reviewer adapter threw before returning a ReviewResult'],
      }, {}, 'reviewer', reviewerSpawn.invocationId), now());
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
    run = recordCompletionTelemetry(run, createCompletionInputFromResult({
      exitStatus: 'success',
      ...(reviewResult.telemetry === undefined ? {} : { telemetry: reviewResult.telemetry }),
    }, {}, 'reviewer', reviewerSpawn.invocationId), now());
    store.update(run);

    let postReviewSnapshot: GitHubLiveSnapshot;
    try {
      postReviewSnapshot = await github.readLiveSnapshot(target);
    } catch (error) {
      const reason = renderFailure('GitHub live-state validation failed after reviewer completion', error);
      return parkAdmission(run, reason, store, now);
    }
    const afterReview = reviewAdmission(run, postReviewSnapshot, resolveValidationAuthority);
    if (afterReview.kind === 'revalidate') return persistRevalidation(run, afterReview.reason, store, now);
    if (afterReview.kind === 'needs_human') return parkAdmission(run, afterReview.reason, store, now);

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
      run = applyTransition(run, { type: 'review_approved', reviewResult }, now(), afterReview.activeValidation);
      store.update(run);
      return { outcome: 'approved', run };
    }

    run = applyTransition(run, { type: 'changes_requested', reviewResult }, now(), afterReview.activeValidation);
    store.update(run);
  }
}
