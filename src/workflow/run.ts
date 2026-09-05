import {
  humanTakeoverReason,
  isWorkspaceGuardFailure,
  type ImplementationAgent,
  type ImplementationCapabilityResolver,
  type WorkspaceGuard,
} from '../adapters/agent.js';
import type { BootstrapRecoveryAuthority, ImplementationBootstrapAdapter } from '../adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter } from '../adapters/reviewer.js';
import type { HostedCheckPolicyConfiguration, ValidationAdapter } from '../adapters/validation.js';
import { applyTransition, isReviewFresh, isValidationFresh } from '../domain/state-machine.js';
import type { HostedValidationEvidence, LocalValidationEvidence, Run, Target, ValidationResult } from '../domain/types.js';
import { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION } from '../domain/decisions.js';
import { runReviewLoop } from '../reviewers/loop.js';
import type { RunStore } from '../store/json-file-store.js';
import { parkBootstrapFailure } from './bootstrap-failure.js';
import { pullRequestIdentityConflict } from './pull-request-identity.js';
import { evaluateHostedCheckPolicy } from '../validation/hosted-policy.js';

export { CANCEL_RUN_DECISION, LIVE_HEAD_SYNC_DECISION as SYNC_LIVE_HEAD_DECISION } from '../domain/decisions.js';
export const RETRY_READINESS_DECISION = 'Retry readiness checks';

export interface WorkflowDependencies {
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly implementation: ImplementationAgent;
  readonly bootstrap?: ImplementationBootstrapAdapter;
  readonly reviewer: ReviewerAdapter;
  /** Explicit repository/run validation adapter; absence is recorded as unknown and fails closed. */
  readonly validation?: ValidationAdapter;
  /** Explicit repository/run policy for interpreting the exact-HEAD hosted check list. */
  readonly hostedCheckPolicy?: HostedCheckPolicyConfiguration;
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
  | { readonly outcome: 'waiting_dependency'; readonly run: Run; readonly reason: string }
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

function bootstrapFailureOutcome(run: Run, error: unknown, store: RunStore, now: () => string): WorkflowOutcome {
  const executor = isWorkspaceGuardFailure(error) ? error.executor : undefined;
  const parked = parkBootstrapFailure(run, error, store, now, executor);
  return { outcome: 'needs_human', ...parked };
}

function park(run: Run, reason: string, store: RunStore, now: () => string, choices = ['Resolve the identity conflict and retry', CANCEL_RUN_DECISION]): WorkflowOutcome {
  const next = applyTransition(run, { type: 'escalate', reason, interrupt: { evidence: reason, choices } }, now());
  store.update(next);
  return { outcome: 'needs_human', run: next, reason };
}

function hostedValidation(
  snapshot: GitHubLiveSnapshot,
  configuredPolicy: HostedCheckPolicyConfiguration | undefined,
): HostedValidationEvidence {
  const observedCheckNames = snapshot.checks.checks.map((check) => check.name);
  // An unconfigured but non-empty provider response is still evidence of an
  // actual check suite.  The only ambiguous shortcut is an empty response,
  // which always remains unknown unless policy explicitly marks it neutral.
  const effectivePolicy = configuredPolicy?.policy ??
    (observedCheckNames.length > 0 ? { mode: 'required' as const } : undefined);
  const status = snapshot.checks.availability !== 'available'
    ? 'unknown'
    : evaluateHostedCheckPolicy({
      overall: snapshot.checks.overall,
      observedCheckNames,
      ...(effectivePolicy === undefined ? {} : { policy: effectivePolicy }),
    });
  return {
    status,
    observedAt: snapshot.observedAt,
    pullRequestNumber: snapshot.pullRequest?.number ?? null,
    availability: snapshot.checks.availability,
    overall: snapshot.checks.overall,
    policyRevision: configuredPolicy?.revision ?? null,
    policyMode: configuredPolicy?.policy.mode ?? 'unconfigured',
    requiredCheckNames: configuredPolicy?.policy.mode === 'required'
      ? [...(configuredPolicy.policy.requiredCheckNames ?? [])]
      : [],
    observedCheckNames,
  };
}

function unavailableLocalValidation(): LocalValidationEvidence {
  return { status: 'unknown', configRevision: null, commands: [] };
}

function combineValidation(headSha: string, local: LocalValidationEvidence, hosted: HostedValidationEvidence): ValidationResult {
  const status = local.status === 'failed' || hosted.status === 'failed'
    ? 'failed'
    : local.status === 'unknown' || hosted.status === 'unknown'
        ? 'unknown'
        : hosted.status === 'waiting'
          ? 'waiting'
          : 'passed';
  return { headSha, status, local, hosted };
}

async function validateExactHead(
  run: Run,
  target: Extract<Target, { readonly kind: 'issue' }>,
  snapshot: GitHubLiveSnapshot,
  validation: ValidationAdapter | undefined,
  hostedPolicy: HostedCheckPolicyConfiguration | undefined,
): Promise<ValidationResult> {
  if (run.headSha === undefined) throw new Error('Cannot validate a run without an exact HEAD SHA.');
  const reusable = run.validationResult;
  const local = reusable?.headSha === run.headSha && reusable.local.status === 'passed' &&
    validation?.configRevision !== undefined && reusable.local.configRevision === validation.configRevision
    ? reusable.local
    : validation === undefined
      ? unavailableLocalValidation()
      : await validation.validate({ target, headSha: run.headSha, ...(run.bootstrap === undefined ? {} : { workspacePath: run.bootstrap.workspacePath }) });
  return combineValidation(run.headSha, local, hostedValidation(snapshot, hostedPolicy));
}

function activeValidationConfiguration(deps: WorkflowDependencies) {
  return {
    ...(deps.validation?.configRevision === undefined ? {} : { localRevision: deps.validation.configRevision }),
    ...(deps.hostedCheckPolicy === undefined ? {} : { hostedPolicyRevision: deps.hostedCheckPolicy.revision }),
  };
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
          return park(run, `Issue ${formatTarget(target)} is closed; refusing implementation.`, store, now, [CANCEL_RUN_DECISION]);
        }
        const pendingReviewFix =
          run.reviewResult?.verdict === 'request_changes' && run.reviewResult.headSha === run.headSha;
        let bootstrap = run.bootstrap;
        let recoveryAuthority: BootstrapRecoveryAuthority | undefined;
        let initialRecoveryCandidate: { number: number; headSha: string } | undefined;
        let workspaceGuard: WorkspaceGuard | undefined;

        if (bootstrap !== undefined && (snapshot.pullRequest !== null || run.headSha !== undefined || run.pullRequest !== undefined)) {
          const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
          if (conflict !== null) return park(run, conflict, store, now);
          if (run.headSha === undefined && run.pullRequest !== undefined) {
            return park(run, 'Initial-result recovery requires both the persisted HEAD and PR record to be absent.', store, now);
          }
          if (run.headSha !== undefined && snapshot.headSha !== run.headSha) {
            return park(run, `Live GitHub HEAD ${snapshot.headSha ?? '(none)'} does not match persisted run HEAD ${run.headSha ?? '(none)'}.`, store, now, [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION]);
          }
          // With no H/PR this is only preparation of the narrow initial result;
          // durable verification below must succeed before anything is adopted.
          recoveryAuthority = { expectedHeadSha: run.headSha ?? snapshot.headSha! };
          if (run.headSha === undefined) {
            initialRecoveryCandidate = { number: snapshot.pullRequest!.number, headSha: snapshot.headSha! };
          }
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

        if (!pendingReviewFix && snapshot.pullRequest === null && bootstrap === undefined) {
          if (deps.bootstrap === undefined || snapshot.repository.defaultBranch === null || snapshot.repository.defaultBranchHeadSha === null) {
            return bootstrapFailureOutcome(run, new Error('No verified bootstrap adapter and live default branch are available.'), store, now);
          }
          try {
            bootstrap = await deps.bootstrap.plan({ runId: run.id, target, baseBranch: snapshot.repository.defaultBranch, baseSha: snapshot.repository.defaultBranchHeadSha });
            run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap }, now());
            store.update(run);
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
        }
        if (bootstrap !== undefined) {
          if (deps.bootstrap === undefined) return bootstrapFailureOutcome(run, new Error('The persisted bootstrap adapter is unavailable.'), store, now);
          try {
            bootstrap = await deps.bootstrap.prepare({
              runId: run.id, target, baseBranch: bootstrap.baseBranch, baseSha: bootstrap.baseSha,
              existing: bootstrap, ...(recoveryAuthority === undefined ? {} : { recoveryAuthority }),
            });
            workspaceGuard = deps.bootstrap.guard(bootstrap);
            snapshot = await github.readLiveSnapshot(target);
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
          if (snapshot.issue.state !== 'open') return park(run, `Issue ${formatTarget(target)} closed during bootstrap.`, store, now, [CANCEL_RUN_DECISION]);
          if (snapshot.pullRequest !== null) {
            const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
            if (conflict !== null) return park(run, conflict, store, now);
            if (run.headSha === undefined) {
              if (initialRecoveryCandidate !== undefined &&
                  (snapshot.pullRequest.number !== initialRecoveryCandidate.number || snapshot.headSha !== initialRecoveryCandidate.headSha)) {
                return park(run, 'Initial recovery PR or HEAD changed after preparation; refusing candidate adoption.', store, now);
              }
              try {
                await deps.bootstrap.verifyDurable({ identity: bootstrap, expectedHeadSha: snapshot.headSha!, workspaceGuard });
              } catch (error) {
                return bootstrapFailureOutcome(run, error, store, now);
              }
              const recovered = { exitStatus: 'success' as const, summary: `Recovered durable implementation from pull request #${snapshot.pullRequest.number}.`, headSha: snapshot.headSha! };
              run = applyTransition(run, { type: 'agent_succeeded', agentResult: recovered, headSha: snapshot.headSha!, pullRequest: { number: snapshot.pullRequest.number, headSha: snapshot.headSha! } }, now());
              store.update(run);
              break;
            }
            if (snapshot.headSha !== run.headSha) return park(run, `Live GitHub HEAD changed during bootstrap recovery.`, store, now, [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION]);
          } else if (run.headSha !== undefined || recoveryAuthority !== undefined) {
            return park(run, 'The owned pull request disappeared during workspace recovery.', store, now);
          } else if (!pendingReviewFix && (snapshot.repository.defaultBranch !== bootstrap.baseBranch || snapshot.repository.defaultBranchHeadSha !== bootstrap.baseSha)) {
            return bootstrapFailureOutcome(run, new Error('Live default branch changed after bootstrap preparation.'), store, now);
          }
        }
        const pendingFixInstructions = pendingReviewFix ? renderBlockingFindings(run) : null;
        const baseSha = pendingReviewFix
          ? run.headSha
          : snapshot.pullRequest?.baseSha ?? snapshot.repository.defaultBranchHeadSha;
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
            ? `${snapshot.issue.body}\n\nConductor requirement: start from ${snapshot.repository.defaultBranch}@${baseSha}, then create and associate an open implementation pull request before reporting success.`
            : snapshot.issue.body
        );
        const supplementalInstructions = pendingFixInstructions ?? (
          snapshot.pullRequest === null
            ? `Conductor requirement: start from ${snapshot.repository.defaultBranch}@${baseSha}, then create and associate an open implementation pull request before reporting success.`
            : undefined
        );
        let result;
        try {
          result = await implementation.run({
            target, baseSha, authority: 'live-target', instructions,
            ...(bootstrap === undefined ? {} : { workspacePath: bootstrap.workspacePath, branch: bootstrap.branch, workspaceGuard }),
            ...(supplementalInstructions === undefined ? {} : { supplementalInstructions }),
            capabilities: await deps.resolveImplementationCapabilities?.(),
            ...(run.agentResult?.sessionId === undefined ? {} : { sessionId: run.agentResult.sessionId }),
            ...(run.executor === undefined ? {} : { executor: run.executor }),
          });
        } catch (error) {
          if (isWorkspaceGuardFailure(error)) return bootstrapFailureOutcome(run, error, store, now);
          throw error;
        }
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
          if (result.headSha === undefined || deps.bootstrap === undefined) return bootstrapFailureOutcome(run, new Error('Implementation did not report an exact durable HEAD.'), store, now);
          try {
            await deps.bootstrap.verifyDurable({ identity: bootstrap, expectedHeadSha: result.headSha, progressBaseSha: pendingReviewFix ? run.headSha : undefined, workspaceGuard });
            snapshot = await github.readLiveSnapshot(target);
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
          const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
          if (conflict !== null || snapshot.pullRequest === null || snapshot.headSha !== result.headSha) {
            return park(run, conflict ?? 'Live pull request does not prove the implementation exact HEAD.', store, now);
          }
          run = applyTransition(run, { type: 'agent_succeeded', agentResult: result, headSha: result.headSha, pullRequest: { number: snapshot.pullRequest.number, headSha: result.headSha } }, now());
        } else {
          run = applyTransition(run, { type: 'agent_succeeded', agentResult: result, headSha: result.headSha }, now());
        }
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
        const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
        if (conflict !== null) return park(run, conflict, store, now);
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
                    : [LIVE_HEAD_SYNC_DECISION, CANCEL_RUN_DECISION],
              },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        // Validation must execute against the owned checkout for this exact
        // live HEAD. An accepted H synchronization can advance GitHub before
        // the local worktree is fast-forwarded, so prepare and prove it again
        // immediately before the local process boundary.
        if (run.bootstrap !== undefined && deps.validation?.requiresOwnedWorkspace === true) {
          if (deps.bootstrap === undefined || run.headSha === undefined) {
            return bootstrapFailureOutcome(run, new Error('Exact-HEAD validation requires the owned workspace bootstrap.'), store, now);
          }
          try {
            const identity = await deps.bootstrap.prepare({
              runId, target, baseBranch: run.bootstrap.baseBranch, baseSha: run.bootstrap.baseSha,
              existing: run.bootstrap, recoveryAuthority: { expectedHeadSha: run.headSha },
            });
            await deps.bootstrap.verifyDurable({ identity, expectedHeadSha: run.headSha });
          } catch (error) {
            return bootstrapFailureOutcome(run, error, store, now);
          }
        }
        let validationResult: ValidationResult;
        try {
          validationResult = await validateExactHead(run, target, snapshot, deps.validation, deps.hostedCheckPolicy);
        } catch (error) {
          const reason = `Local validation could not be observed safely: ${error instanceof Error ? error.message : String(error)}`;
          validationResult = combineValidation(
            run.headSha ?? '', unavailableLocalValidation(), hostedValidation(snapshot, deps.hostedCheckPolicy),
          );
          run = applyTransition(
            run,
            {
              type: 'escalate', reason, validationResult,
              interrupt: { evidence: reason, choices: ['Restore the configured validation runner and retry', CANCEL_RUN_DECISION] },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        if (validationResult.status === 'failed') {
          run = applyTransition(run, { type: 'validation_failed', validationResult }, now());
          store.update(run);
          break;
        }
        if (validationResult.status === 'waiting') {
          const reason = `Validation for ${run.headSha} is waiting for required hosted checks.`;
          run = applyTransition(
            run,
            {
              type: 'wait_dependency', reason, validationResult,
              interrupt: { evidence: reason, choices: [RETRY_READINESS_DECISION, CANCEL_RUN_DECISION] },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'waiting_dependency', run, reason };
        }
        if (validationResult.status === 'unknown') {
          const reason = `Validation for ${run.headSha} lacks required local or hosted evidence.`;
          run = applyTransition(
            run,
            {
              type: 'escalate', reason, validationResult,
              interrupt: { evidence: reason, choices: ['Restore required validation evidence and retry', CANCEL_RUN_DECISION] },
            },
            now(),
          );
          store.update(run);
          return { outcome: 'needs_human', run, reason };
        }
        run = applyTransition(
          run,
          {
            type: 'validation_passed', validationResult,
            ...(snapshot.pullRequest === null ? {} : { pullRequest: { number: snapshot.pullRequest.number, headSha: run.headSha! } }),
          },
          now(),
        );
        store.update(run);
        break;
      }

      case 'REVIEWING':
      case 'CHANGES_REQUESTED': {
        const loop = await runReviewLoop(
          { store, github, implementation, reviewer, bootstrap: deps.bootstrap, resolveImplementationCapabilities: deps.resolveImplementationCapabilities },
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
        if (!isValidationFresh(run, activeValidationConfiguration(deps))) {
          const reason = `Final gate requires validation at current HEAD ${run.headSha ?? '(none)'} under the active repository/run configuration.`;
          run = applyTransition(
            run,
            {
              type: 'revalidate', reason,
            },
            now(),
          );
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
        const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
        if (conflict !== null) return park(run, conflict, store, now);
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

        const persistedValidation = run.validationResult;
        if (persistedValidation === undefined ||
          persistedValidation.hosted.pullRequestNumber !== snapshot.pullRequest?.number ||
          (deps.hostedCheckPolicy !== undefined &&
            persistedValidation.hosted.policyRevision !== deps.hostedCheckPolicy.revision)) {
          const reason = 'Final gate observed hosted validation evidence that does not match the current pull request or active policy configuration.';
          run = applyTransition(run, { type: 'revalidate', reason }, now());
          store.update(run);
          break;
        }

        const pullRequest = snapshot.pullRequest;
        const mergeState = pullRequest?.mergeStateStatus?.toUpperCase() ?? null;
        const contradictory = snapshot.problems.find((problem) => problem.code === 'CONTRADICTORY_STATE');
        const currentHosted = hostedValidation(snapshot, deps.hostedCheckPolicy);
        const readinessProblems = [
          snapshot.issue.state !== 'open' ? 'the issue is not open' : null,
          pullRequest === null || pullRequest.state !== 'open' ? 'the pull request is not open' : null,
          pullRequest?.isDraft === true ? 'the pull request is still a draft' : null,
          pullRequest?.mergeable !== true ? 'GitHub does not report the pull request as mergeable' : null,
          mergeState !== null && mergeState !== 'CLEAN' && mergeState !== 'HAS_HOOKS'
            ? `merge state is ${mergeState}`
            : null,
          currentHosted.status === 'failed' ? 'required hosted checks are failing' : null,
          currentHosted.status === 'waiting' ? 'required hosted checks are pending' : null,
          currentHosted.status === 'unknown' ? 'required hosted check evidence is unavailable or incomplete' : null,
          snapshot.reviews.unresolvedThreads === null
            ? 'review thread state is unavailable'
            : snapshot.reviews.unresolvedThreads > 0
              ? `${snapshot.reviews.unresolvedThreads} review thread(s) remain unresolved`
              : null,
          contradictory?.message ?? null,
        ].filter((problem): problem is string => problem !== null);

        if (readinessProblems.length > 0) {
          const reason = `Final GitHub readiness gate is blocked: ${readinessProblems.join('; ')}.`;
          const checksPending = currentHosted.status === 'waiting' && readinessProblems.length === 1;
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
          return checksPending
            ? { outcome: 'waiting_dependency', run, reason }
            : { outcome: 'needs_human', run, reason };
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
        return { outcome: 'waiting_dependency', run, reason: run.interrupt?.reason ?? 'Awaiting an external dependency.' };

      case 'FAILED':
        return { outcome: 'failed', run, reason: run.history.at(-1)?.reason ?? 'The run failed.' };
    }
  }
}
