import { nativeLeadReentry, unresolvedNativeLead } from '../oracle/native-lead.js';
import { nativeMergeReentry } from '../workflow/merge.js';
import { randomUUID } from 'node:crypto';

import type { GitHubAdapter } from '../adapters/github.js';
import type { Run, WorkflowState } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import type { MissionAdmissionRegistry } from '../mission-admission/registry.js';
import { nativeReviewReentry, unresolvedNativeReview } from '../oracle/native-reviewer.js';
import {
  DispatchProtocolError,
  claimDispatchEntry,
  hasValidDispatchAuthority,
  parseDispatchQueue,
  parseDispatchRuntime,
  renderDispatchRuntime,
  sameDispatchRuntimeClaim,
  selectDispatchRuntime,
  type DispatchClaimApi,
  type DispatchQueueEntry,
  type DispatchRuntimeClaim,
  type DispatchRuntimeComment,
} from './queue.js';

export interface DispatchRuntimeApi extends DispatchClaimApi {
  updateRuntimeComment(id: string, body: string): Promise<DispatchRuntimeComment>;
}

export interface DispatchExecution {
  readonly runId: string;
  readonly state: WorkflowState;
  readonly waitForPoll?: boolean;
}

/** Bounded control-plane evidence; contains no generation token or filesystem path. */
export interface DispatchAdmissionObservation {
  readonly schemaVersion: 1;
  /** Current read-only snapshot revision. */
  readonly revision: number;
  /** Revision at which this request was parked or found a conflict. */
  readonly decisionRevision: number;
  readonly missionId: string;
  readonly laneId: string;
  readonly runId: string;
  readonly claimId?: string;
  readonly repository: string;
  readonly issue?: number;
  readonly pullRequest?: number;
  readonly workspace?: string;
  readonly role: 'production_captain';
  readonly counts: { readonly captains: number; readonly writers: number; readonly highAutonomy: number; readonly parked: number };
  readonly limits: { readonly maxCaptains: number; readonly maxWriters: number; readonly maxHighAutonomy: number; readonly maxPerRepository?: number };
  readonly result: 'parked' | 'duplicate';
  readonly reason: string;
  readonly lastTransition: { readonly kind: string; readonly laneId?: string; readonly at: string } | null;
}

/** Nonterminal typed hold returned when a durable dispatch Run lacks admission. */
export class DispatchAdmissionWaitError extends Error {
  constructor(readonly runId: string, readonly laneId: string, readonly waitKind: 'capacity' | 'owner', message: string, readonly admission?: DispatchAdmissionObservation) {
    super(message);
    this.name = 'DispatchAdmissionWaitError';
  }
}

export interface DispatchOnceOptions {
  readonly queueBody: string;
  readonly maintenanceHold?: boolean;
  readonly issuedMergeRecoveryOnly?: boolean;
  readonly issuedLeadRecoveryOnly?: boolean;
  readonly owner: string;
  readonly repo: string;
  readonly github: GitHubAdapter;
  readonly store: RunStore;
  readonly runtime: DispatchRuntimeApi;
  readonly leaseDurationMs: number;
  readonly now: () => string;
  readonly execute: (entry: DispatchQueueEntry, existing: Run | null, claim: DispatchRuntimeClaim) => Promise<DispatchExecution>;
  /** Trusted composition boundary: exact live proof, CAS, and admission/receipt settlement.
   * null means the exact PR is still open. Called while the prepare lock is held. */
  readonly reconcileMergedRun?: (run: Run) => Promise<Run | null>;
  /** Trusted exact released owner proof; grants no delivery or repair authority. */
  readonly isRunOwnerRetired?: (run: Run) => boolean;
  /** Fresh model-free integration proof is required in addition to released ownership for every native successor shortcut. */
  readonly qualifyNativeProgression?: (run: Run) => Promise<boolean>;
  readonly createClaimId?: () => string;
  readonly withAdmissionLock?: <T>(operation: () => Promise<T> | T) => Promise<T>;
  readonly releaseAdmissionLock?: () => void;
  readonly admission?: MissionAdmissionRegistry;
}

export type DispatchOnceResult =
  /** A typed admission fence: no queue, GitHub, workflow, or model work ran. */
  | { readonly outcome: 'maintenance_hold'; readonly reason: string }
  | { readonly outcome: 'no_eligible_work'; readonly reasons: readonly string[] }
  | { readonly outcome: 'existing_claim'; readonly claim: DispatchRuntimeClaim }
  | { readonly outcome: 'owner_reconciliation_hold'; readonly entry: DispatchQueueEntry; readonly claim: DispatchRuntimeClaim; readonly reason: string }
  | { readonly outcome: 'admission_wait'; readonly waitKind: 'capacity' | 'owner'; readonly entry: DispatchQueueEntry; readonly runId: string; readonly claim: DispatchRuntimeClaim; readonly reason: string; readonly admission?: DispatchAdmissionObservation }
  | { readonly outcome: 'dispatched'; readonly entry: DispatchQueueEntry; readonly claim: DispatchRuntimeClaim; readonly execution: DispatchExecution };

function target(entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>) {
  return { kind: 'issue' as const, owner: options.owner.toLowerCase(), repo: options.repo.toLowerCase(), issueNumber: entry.issue };
}

function isTarget(run: Run, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): boolean {
  const wanted = target(entry, options);
  return run.target.kind === 'issue' && run.target.owner.toLowerCase() === wanted.owner && run.target.repo.toLowerCase() === wanted.repo && run.target.issueNumber === wanted.issueNumber;
}

async function retiredForProgression(run: Run, options: DispatchOnceOptions): Promise<boolean> {
  if (options.isRunOwnerRetired?.(run) !== true) return false;
  // For a non-MERGED Run, this exact owner proof means an explicit existing
  // retirement/cancellation disposition, not delivery. Preserve that authority
  // without requiring retired unissued work to merge or reopening its wait.
  if (run.state !== 'MERGED') {
    if (unresolvedNativeReview(run) || unresolvedNativeLead(run) || run.mergeAttempt?.submissionPossible === true) throw new DispatchProtocolError('Non-delivery retirement conflicts with unresolved or possibly issued external work.');
    return true;
  }
  return run.nativeReview === undefined && run.nativeLead === undefined && run.mergeAttempt === undefined ||
    options.qualifyNativeProgression !== undefined && await options.qualifyNativeProgression(run);
}

async function activeRun(store: RunStore, entry: DispatchQueueEntry, options: DispatchOnceOptions): Promise<Run | null> {
  for (const run of store.list()) if (isTarget(run, entry, options) && isActiveRun(run) && !await retiredForProgression(run, options)) return run;
  return null;
}

export function claimedRun(store: RunStore, claim: DispatchRuntimeClaim, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): Run | null {
  if (claim.runId !== null) {
    const run = store.read(claim.runId);
    if (run === null || !isTarget(run, entry, options) || run.dispatchClaimId !== claim.claimId) {
      throw new DispatchProtocolError('Dispatch runtime claim names a missing, differently targeted, or differently claimed durable run; refusing recovery.');
    }
    return run;
  }

  // A process can die after runIssue durably creates a Run but before the
  // runtime comment is updated with its id. Time is not proof of ownership:
  // only the immutable claim id written into the durable Run can bind that
  // crash window. Older terminal history is harmless; later unbound activity
  // is ambiguous and must not be adopted.
  const matching = store.list().filter((run) => isTarget(run, entry, options));
  const linked = matching.filter((run) => run.dispatchClaimId === claim.claimId);
  if (linked.length > 1) {
    throw new DispatchProtocolError('Unbound dispatch runtime claim names multiple durable runs; refusing ambiguous recovery.');
  }
  const activeUnbound = matching.filter((run) => isActiveRun(run) && run.dispatchClaimId !== claim.claimId);
  if (activeUnbound.length > 0) {
    throw new DispatchProtocolError('Unbound dispatch runtime claim found an unrelated active durable run; refusing ambiguous recovery.');
  }
  const laterUnbound = matching.filter((run) => run.createdAt >= claim.claimedAt && run.dispatchClaimId !== claim.claimId);
  if (laterUnbound.length > 0) {
    throw new DispatchProtocolError('Unbound dispatch runtime claim cannot prove ownership of a later durable run; refusing ambiguous recovery.');
  }
  if (linked.length === 1) return linked[0]!;
  return null;
}

/** A persisted non-terminal Run is an ownership fence even before it has a PR. */
function isActiveRun(run: Run | null): boolean {
  return run !== null && run.state !== 'MERGED' && run.state !== 'FAILED';
}

function isSettledRun(run: Run): boolean {
  return run.state === 'MERGED' || run.state === 'MERGE_READY' || run.state === 'NEEDS_HUMAN' || run.state === 'WAITING_DEPENDENCY' || run.state === 'FAILED';
}

function sameAuthorityRevision(run: Run, entry: DispatchQueueEntry): boolean {
  return run.repairTaskShapeAuthority?.revision === entry.repairTaskShapeAuthority?.revision;
}

async function delivered(run: Run, entry: DispatchQueueEntry, options: DispatchOnceOptions, reissued = false): Promise<boolean> {
  if (run.dispatchClaimId === undefined || run.execution?.profile !== entry.profile ||
    run.repairTaskShapeAuthority === undefined || entry.repairTaskShapeAuthority === undefined ||
    !sameAuthorityRevision(run, entry) || run.repairTaskShapeAuthority.shape !== entry.repairTaskShapeAuthority.shape ||
    options.reconcileMergedRun === undefined) return false;
  for (const other of options.store.list()) {
    if (other.id !== run.id && isTarget(other, entry, options) && isActiveRun(other) && !await retiredForProgression(other, options)) throw new DispatchProtocolError(`Run ${run.id} has unrelated active work for #${entry.issue}; refusing delivery supersession.`);
  }
  const settled = await options.reconcileMergedRun(run);
  if (settled === null) return false;
  const durable = options.store.read(run.id);
  if (settled.state !== 'MERGED' || durable === null || JSON.stringify(durable) !== JSON.stringify(settled) ||
    settled.dispatchClaimId !== run.dispatchClaimId || settled.execution?.profile !== entry.profile ||
    settled.repairTaskShapeAuthority?.revision !== entry.repairTaskShapeAuthority.revision ||
    settled.repairTaskShapeAuthority.shape !== entry.repairTaskShapeAuthority.shape || !isTarget(settled, entry, options) ||
    JSON.stringify(settled.execution) !== JSON.stringify(run.execution) ||
    JSON.stringify(settled.bootstrap) !== JSON.stringify(run.bootstrap) ||
    JSON.stringify(settled.pullRequest) !== JSON.stringify(run.pullRequest) || settled.headSha !== run.headSha) {
    throw new DispatchProtocolError(`Run ${run.id} lacks exact durable dispatch delivery settlement.`);
  }
  if (options.admission !== undefined && options.admission.readLane(`run:${run.id}`)?.status !== 'released') {
    throw new DispatchProtocolError(`Run ${run.id} lacks released admission delivery settlement.`);
  }
  return (await options.github.readIssue(target(entry, options))).state === 'closed' || reissued;
}

async function eligibility(entry: DispatchQueueEntry, options: DispatchOnceOptions): Promise<{ readonly run: Run | null; readonly reason: string | null; readonly blocked?: boolean }> {
  const issueTarget = target(entry, options);
  const run = await activeRun(options.store, entry, options);
  if (run !== null) return { run, reason: `#${entry.issue}: existing durable run ${run.id} is ${run.state}`, blocked: true };
  // Run/claim/profile/revision identity survives replacement of the one runtime
  // comment. A closed issue is required so a reopened incarnation cannot reuse
  // its prior delivery; reissue requires an explicit new authority revision.
  const history = options.store.list().filter((prior) => isTarget(prior, entry, options) && prior.dispatchClaimId !== undefined);
  if (history.some((prior) => prior.state !== 'FAILED' && prior.state !== 'MERGED' && !sameAuthorityRevision(prior, entry))) {
    return { run: null, reason: `#${entry.issue}: revised reissue of released nonterminal work requires explicit terminal disposition before a replacement claim`, blocked: true };
  }
  for (const prior of history) if (prior.state !== 'MERGED' && !await retiredForProgression(prior, options)) {
    return { run: null, reason: `#${entry.issue}: prior dispatch work lacks proven delivery`, blocked: true };
  }
  // A new authority revision permits a new incarnation, but cannot hide an
  // interrupted release from an older one merely because its Run says MERGED.
  for (const prior of history.filter((candidate) => !sameAuthorityRevision(candidate, entry) && candidate.repairTaskShapeAuthority !== undefined)) {
    const priorEntry: DispatchQueueEntry = { issue: entry.issue, route: 'codex', profile: prior.execution?.profile ?? '', repairTaskShapeAuthority: prior.repairTaskShapeAuthority };
    if (!await retiredForProgression(prior, options) && !await delivered(prior, priorEntry, options, true)) {
      return { run: null, reason: `#${entry.issue}: previous authority lacks exact delivery settlement`, blocked: true };
    }
  }
  const matching = history.filter((prior) => sameAuthorityRevision(prior, entry) || prior.repairTaskShapeAuthority === undefined);
  if (matching.length > 0) {
    if (matching.length === 1 && matching[0]!.state === 'MERGED' && await delivered(matching[0]!, entry, options)) {
      return { run: null, reason: `#${entry.issue}: exact dispatch delivery is complete` };
    }
    if (matching.length === 1 && matching[0]!.state !== 'MERGED' && await retiredForProgression(matching[0]!, options) &&
      matching[0]!.execution?.profile === entry.profile && matching[0]!.repairTaskShapeAuthority?.shape === entry.repairTaskShapeAuthority?.shape) {
      return { run: null, reason: `#${entry.issue}: exact prior owner retirement prevents same-authority respawn` };
    }
    return { run: null, reason: `#${entry.issue}: historical delivery does not authorize this queue incarnation`, blocked: true };
  }
  const issue = await options.github.readIssue(issueTarget);
  if (issue.state !== 'open') return { run, reason: `#${entry.issue}: Issue is ${issue.state}` };
  const pulls = await options.github.listPullRequests(issueTarget);
  if (pulls.some((pull) => pull.state === 'open')) return { run, reason: `#${entry.issue}: an associated pull request is already open` };
  return { run, reason: null };
}

function authorityReason(entry: DispatchQueueEntry): string | null {
  return hasValidDispatchAuthority(entry)
    ? null
    : `#${entry.issue}: Codex dispatch requires explicit revisioned task-shape authority`;
}

function assertClaimAuthorityMatchesRun(claim: DispatchRuntimeClaim, run: Run): void {
  const authority = claim.repairTaskShapeAuthority;
  if (authority !== undefined && (run.repairTaskShapeAuthority?.revision !== authority.revision || run.repairTaskShapeAuthority.shape !== authority.shape)) {
    throw new DispatchProtocolError('Dispatch runtime claim task-shape authority does not match its immutable durable Run.');
  }
}

function stateForExecution(state: WorkflowState): DispatchRuntimeClaim['state'] {
  if (state === 'MERGE_READY') return 'merge_ready';
  // MERGED is terminal too. The runtime protocol intentionally has no
  // separate merged state: the durable Run remains the source of truth while
  // this claim is retained for reconciliation.
  if (state === 'MERGED') return 'merge_ready';
  if (state === 'NEEDS_HUMAN' || state === 'WAITING_DEPENDENCY') return 'needs_human';
  if (state === 'FAILED') return 'failed';
  return 'running';
}

async function supersedeTerminalClaim(
  api: DispatchRuntimeApi,
  commentId: string,
  expected: DispatchRuntimeClaim,
  entry: DispatchQueueEntry,
  options: Pick<DispatchOnceOptions, 'now' | 'leaseDurationMs' | 'createClaimId'>,
): Promise<DispatchRuntimeClaim> {
  if (!hasValidDispatchAuthority(entry)) throw new DispatchProtocolError(`Queue issue #${entry.issue} lacks explicit revisioned task-shape authority.`);
  const current = selectDispatchRuntime(await api.listRuntimeComments());
  if (current === null || current.id !== commentId || !sameDispatchRuntimeClaim(current.claim, expected)) {
    throw new DispatchProtocolError('Dispatch claim changed before terminal supersession; refusing stale overwrite.');
  }
  const now = options.now();
  const claim: DispatchRuntimeClaim = {
    issue: entry.issue,
    claimId: (options.createClaimId ?? randomUUID)(),
    runId: null,
    profile: entry.profile,
    repairTaskShapeAuthority: { revision: entry.repairTaskShapeAuthority.revision, shape: entry.repairTaskShapeAuthority.shape },
    state: 'claimed',
    claimedAt: now,
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + options.leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(claim));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || !sameDispatchRuntimeClaim(observed.claim, claim)) {
    throw new DispatchProtocolError('Superseded dispatch runtime claim did not retain the exact new claim identity.');
  }
  return observed.claim;
}

async function updateClaim(
  api: DispatchRuntimeApi,
  commentId: string,
  claim: DispatchRuntimeClaim,
  now: string,
  leaseDurationMs: number,
  run: DispatchExecution,
): Promise<DispatchRuntimeClaim> {
  const current = selectDispatchRuntime(await api.listRuntimeComments());
  if (current === null || current.id !== commentId || !sameDispatchRuntimeClaim(current.claim, claim)) {
    throw new DispatchProtocolError('Dispatch claim changed before update; refusing stale overwrite.');
  }
  const next: DispatchRuntimeClaim = {
    ...claim,
    runId: run.runId,
    state: stateForExecution(run.state),
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(next));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || !sameDispatchRuntimeClaim(observed.claim, next)) {
    throw new DispatchProtocolError('Dispatch runtime heartbeat did not retain the exact claim/run identity.');
  }
  return observed.claim;
}

async function withExactClaimLock<T>(
  options: DispatchOnceOptions,
  commentId: string,
  expected: DispatchRuntimeClaim,
  operation: () => Promise<T>,
): Promise<T> {
  const guarded = async () => {
    const live = selectDispatchRuntime(await options.runtime.listRuntimeComments());
    if (live === null || live.id !== commentId || !sameDispatchRuntimeClaim(live.claim, expected)) {
      throw new DispatchProtocolError('Dispatch claim changed before a serialized heartbeat/finalization; refusing stale overwrite.');
    }
    return await operation();
  };
  return options.withAdmissionLock === undefined ? await guarded() : await options.withAdmissionLock(guarded);
}

async function refreshClaim(
  api: DispatchRuntimeApi,
  commentId: string,
  claim: DispatchRuntimeClaim,
  now: string,
  leaseDurationMs: number,
): Promise<DispatchRuntimeClaim> {
  const current = selectDispatchRuntime(await api.listRuntimeComments());
  if (current === null || current.id !== commentId || !sameDispatchRuntimeClaim(current.claim, claim)) {
    throw new DispatchProtocolError('Dispatch claim changed before heartbeat; refusing stale overwrite.');
  }
  const next: DispatchRuntimeClaim = {
    ...claim,
    state: 'running',
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(next));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || !sameDispatchRuntimeClaim(observed.claim, next)) {
    throw new DispatchProtocolError('Dispatch runtime heartbeat did not retain the exact active claim identity.');
  }
  return observed.claim;
}

async function executeWithHeartbeat(
  options: DispatchOnceOptions,
  commentId: string,
  entry: DispatchQueueEntry,
  existing: Run | null,
  claim: DispatchRuntimeClaim,
): Promise<{ readonly claim: DispatchRuntimeClaim; readonly execution: DispatchExecution } | { readonly wait: DispatchAdmissionWaitError; readonly claim: DispatchRuntimeClaim }> {
  let activeClaim = await refreshClaim(options.runtime, commentId, claim, options.now(), options.leaseDurationMs);
  let heartbeatFailure: unknown = null;
  let heartbeat = Promise.resolve();
  const interval = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (heartbeatFailure !== null) return;
      activeClaim = await withExactClaimLock(options, commentId, activeClaim, async () =>
        await refreshClaim(options.runtime, commentId, activeClaim, options.now(), options.leaseDurationMs));
    }).catch((error: unknown) => { heartbeatFailure ??= error; });
  }, Math.max(1, Math.floor(options.leaseDurationMs / 2)));
  try {
    let execution: DispatchExecution;
    try {
      execution = await options.execute(entry, existing, activeClaim);
    } catch (error) {
      if (error instanceof DispatchAdmissionWaitError) {
        if (activeClaim.runId !== null && activeClaim.runId !== error.runId) throw new DispatchProtocolError('Admission wait Run does not match the retained dispatch claim.');
        clearInterval(interval);
        options.releaseAdmissionLock?.();
        await heartbeat;
        if (heartbeatFailure !== null) {
          const message = heartbeatFailure instanceof Error ? heartbeatFailure.message : String(heartbeatFailure);
          throw new DispatchProtocolError(`Claim ${activeClaim.claimId} could not be kept alive during admission wait: ${message}`);
        }
        const waiting: DispatchRuntimeClaim = { ...activeClaim, runId: error.runId, state: 'claimed', heartbeatAt: options.now(), leaseUntil: new Date(Date.parse(options.now()) + options.leaseDurationMs).toISOString() };
        const observed = await withExactClaimLock(options, commentId, activeClaim, async () => {
          await options.runtime.updateRuntimeComment(commentId, renderDispatchRuntime(waiting));
          return selectDispatchRuntime(await options.runtime.listRuntimeComments());
        });
        if (observed === null || observed.id !== commentId || !sameDispatchRuntimeClaim(observed.claim, waiting)) {
          throw new DispatchProtocolError('Dispatch admission wait did not retain the exact claim and Run identity.');
        }
        return { wait: error, claim: observed.claim };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new DispatchProtocolError(`Claim ${activeClaim.claimId} was retained but execution could not start safely: ${message}`);
    }
    clearInterval(interval);
    await heartbeat;
    if (heartbeatFailure !== null) {
      const message = heartbeatFailure instanceof Error ? heartbeatFailure.message : String(heartbeatFailure);
      throw new DispatchProtocolError(`Claim ${activeClaim.claimId} could not be kept alive during execution: ${message}`);
    }
    const updated = await withExactClaimLock(options, commentId, activeClaim, async () =>
      await updateClaim(options.runtime, commentId, activeClaim, options.now(), options.leaseDurationMs, execution));
    return { claim: updated, execution };
  } finally {
    clearInterval(interval);
    // The prepare lock may still be held when execution fails before invoking
    // its normal release callback. Release idempotently so queued heartbeat
    // work cannot remain blocked behind a completed attempt.
    options.releaseAdmissionLock?.();
  }
}

function needsTerminalReconciliation(claim: DispatchRuntimeClaim, run: Run): boolean {
  return claim.runId !== run.id || claim.state !== stateForExecution(run.state);
}

async function retireTerminalClaim(
  api: DispatchRuntimeApi,
  commentId: string,
  claim: DispatchRuntimeClaim,
  now: string,
): Promise<DispatchRuntimeClaim> {
  const current = selectDispatchRuntime(await api.listRuntimeComments());
  if (current === null || current.id !== commentId || !sameDispatchRuntimeClaim(current.claim, claim)) {
    throw new DispatchProtocolError('Dispatch claim changed before retirement; refusing stale overwrite.');
  }
  const retired: DispatchRuntimeClaim = { ...claim, state: 'retired', heartbeatAt: now, leaseUntil: now };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(retired));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || !sameDispatchRuntimeClaim(observed.claim, retired)) {
    throw new DispatchProtocolError('Retired dispatch runtime claim did not retain its exact claim identity.');
  }
  return observed.claim;
}

/** All same-repository prior dispatch owners count, even absent/rerouted rows. */
async function historicalOwnerHold(options: DispatchOnceOptions, currentRunId?: string): Promise<string | null> {
  for (const prior of options.store.list()) {
    if (prior.id === currentRunId || prior.dispatchClaimId === undefined ||
      prior.target.owner.toLowerCase() !== options.owner.toLowerCase() || prior.target.repo.toLowerCase() !== options.repo.toLowerCase()) continue;
    if (!await retiredForProgression(prior, options)) return `Prior dispatch Run ${prior.id} retains unresolved dispatch work (${prior.state}); exact release, explicit work disposition and fresh native integration proof are required.`;
  }
  return null;
}

/**
 * Perform one v0 serial dispatch attempt. A queue comment cannot by itself
 * authorize work: every candidate is checked against current Issue/PR/Run
 * identity before a machine-owned claim is written and reread.
 */
export async function dispatchOnce(options: DispatchOnceOptions): Promise<DispatchOnceResult> {
  const existing = selectDispatchRuntime(await options.runtime.listRuntimeComments());
  if (existing !== null) {
    const entry: DispatchQueueEntry = {
      issue: existing.claim.issue,
      route: 'codex',
      profile: existing.claim.profile,
      ...(existing.claim.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: existing.claim.repairTaskShapeAuthority }),
    };
    const queue = options.maintenanceHold || options.issuedMergeRecoveryOnly || options.issuedLeadRecoveryOnly ? [] : parseDispatchQueue(options.queueBody);
    let run = claimedRun(options.store, existing.claim, entry, options);
    if (run === null && (existing.claim.state === 'retired' || !hasValidDispatchAuthority(entry))) {
      return {
        outcome: 'owner_reconciliation_hold', entry, claim: existing.claim,
        reason: `Legacy dispatch claim ${existing.claim.claimId} has no retained Run or task-shape authority; owner reconciliation is required before any new Run can be created.`,
      };
    }
    if (run !== null) assertClaimAuthorityMatchesRun(existing.claim, run);
    if (options.issuedMergeRecoveryOnly && !run?.mergeAttempt?.submissionPossible) return { outcome: 'existing_claim', claim: existing.claim };
    if (options.issuedLeadRecoveryOnly && (!run || !unresolvedNativeLead(run))) return {outcome:'existing_claim',claim:existing.claim};
    if (options.maintenanceHold && !run?.mergeAttempt?.submissionPossible && (!run || !unresolvedNativeLead(run))) return { outcome: 'maintenance_hold', reason: 'Maintenance HOLD permits only observation/settlement of an already-issued merge.' };
    const historicalHold = await historicalOwnerHold(options, run?.id);
    if (historicalHold !== null) return { outcome: 'owner_reconciliation_hold', entry, claim: existing.claim, reason: historicalHold };
    const ownerRetired = run !== null && run.state !== 'MERGED' && await retiredForProgression(run, options);
    if (!ownerRetired && (run === null || !isSettledRun(run) || options.issuedLeadRecoveryOnly || nativeReviewReentry(run, options.now()) || nativeLeadReentry(run,options.now()) || run.state === 'MERGE_READY' && (run.nativeReview !== undefined || run.nativeLead !== undefined) && run.mergeAttempt?.submissionPossible !== true || nativeMergeReentry(run, options.now()))) {
      if (run !== null && options.admission?.readLane(`run:${run.id}`)?.status === 'active') {
        return {
          outcome: 'admission_wait', waitKind: 'owner', entry, runId: run.id, claim: existing.claim,
          reason: `Run "${run.id}" already has an active mission owner; dispatch will wait without starting another workflow or changing the claim.`,
        };
      }
      const dispatched = await executeWithHeartbeat(options, existing.id, entry, run, existing.claim);
      if ('wait' in dispatched) return { outcome: 'admission_wait', waitKind: dispatched.wait.waitKind, entry, runId: dispatched.wait.runId, claim: dispatched.claim, reason: dispatched.wait.message, ...(dispatched.wait.admission === undefined ? {} : { admission: dispatched.wait.admission }) };
      return { outcome: 'dispatched', entry, ...dispatched };
    }

    if (run === null) throw new DispatchProtocolError('Dispatch owner retirement requires a retained Run.');
    // Only exact delivery or explicit owner retirement can release a retained row. FAILED and human or
    // dependency holds remain ownership fences even when a queue row vanishes.
    const reissued = queue.some((queued) => queued.issue === entry.issue && queued.route === 'codex' && hasValidDispatchAuthority(queued) &&
      entry.repairTaskShapeAuthority !== undefined && queued.repairTaskShapeAuthority.revision !== entry.repairTaskShapeAuthority.revision);
    const complete = (run.state === 'MERGE_READY' || run.state === 'MERGED') && (run.mergeAttempt === undefined || run.mergeAttempt.qualification !== undefined) && await delivered(run, entry, options, reissued);
    run = options.store.read(run.id) ?? run;
    const reconciled = existing.claim.state === 'retired' && (run.state === 'MERGED' || ownerRetired)
      ? existing.claim
      : needsTerminalReconciliation(existing.claim, run)
      ? await updateClaim(options.runtime, existing.id, existing.claim, options.now(), options.leaseDurationMs, {
        runId: run.id, state: run.state,
      })
      : existing.claim;
    if (!complete && !ownerRetired) return { outcome: 'existing_claim', claim: reconciled };
    if (options.maintenanceHold) return { outcome: 'maintenance_hold', reason: 'Issued merge observation/settlement completed; maintenance HOLD retains the queue fence.' };
    if (options.issuedMergeRecoveryOnly) return { outcome: 'existing_claim', claim: reconciled };
    const reasons: string[] = [];
    for (const queued of queue) {
      if (queued.route !== 'codex') {
        reasons.push(`#${queued.issue}: route ${queued.route} is not executable by this dispatcher`);
        continue;
      }
      const authorityUnavailable = authorityReason(queued);
      if (authorityUnavailable !== null) {
        reasons.push(authorityUnavailable);
        continue;
      }
      const checked = await eligibility(queued, options);
      if (checked.reason !== null) {
        reasons.push(checked.reason);
        if (checked.blocked) return { outcome: 'no_eligible_work', reasons };
        continue;
      }
      const claim = await supersedeTerminalClaim(options.runtime, existing.id, reconciled, queued, options);
      const dispatched = await executeWithHeartbeat(options, existing.id, queued, checked.run, claim);
      if ('wait' in dispatched) return { outcome: 'admission_wait', waitKind: dispatched.wait.waitKind, entry: queued, runId: dispatched.wait.runId, claim: dispatched.claim, reason: dispatched.wait.message, ...(dispatched.wait.admission === undefined ? {} : { admission: dispatched.wait.admission }) };
      return { outcome: 'dispatched', entry: queued, ...dispatched };
    }
    if (reconciled.state !== 'retired') await retireTerminalClaim(options.runtime, existing.id, reconciled, options.now());
    return { outcome: 'no_eligible_work', reasons };
  }
  if (options.issuedMergeRecoveryOnly) return { outcome: 'no_eligible_work', reasons: ['Issued merge recovery has no exact retained runtime claim.'] };
  const historicalHold = await historicalOwnerHold(options);
  if (historicalHold !== null) return { outcome: 'no_eligible_work', reasons: [historicalHold] };
  const queue = options.maintenanceHold || options.issuedMergeRecoveryOnly || options.issuedLeadRecoveryOnly ? [] : parseDispatchQueue(options.queueBody);
  if (options.maintenanceHold) return { outcome: 'maintenance_hold', reason: 'Maintenance HOLD prevents new dispatch admission.' };
  const reasons: string[] = [];
  for (const entry of queue) {
    if (entry.route !== 'codex') {
      reasons.push(`#${entry.issue}: route ${entry.route} is not executable by this dispatcher`);
      continue;
    }
    const authorityUnavailable = authorityReason(entry);
    if (authorityUnavailable !== null) {
      reasons.push(authorityUnavailable);
      continue;
    }
    const checked = await eligibility(entry, options);
    if (checked.reason !== null) {
      reasons.push(checked.reason);
      if (checked.blocked) return { outcome: 'no_eligible_work', reasons };
      continue;
    }
    const claimed = await claimDispatchEntry(options.runtime, entry, {
      now: options.now,
      leaseDurationMs: options.leaseDurationMs,
      ...(options.createClaimId === undefined ? {} : { createClaimId: options.createClaimId }),
    });
    const dispatched = await executeWithHeartbeat(options, claimed.commentId, entry, checked.run, claimed.claim);
    if ('wait' in dispatched) return { outcome: 'admission_wait', waitKind: dispatched.wait.waitKind, entry, runId: dispatched.wait.runId, claim: dispatched.claim, reason: dispatched.wait.message, ...(dispatched.wait.admission === undefined ? {} : { admission: dispatched.wait.admission }) };
    return { outcome: 'dispatched', entry, ...dispatched };
  }
  return { outcome: 'no_eligible_work', reasons };
}

/** Read a runtime comment body safely for callers that retain comment ids. */
export function runtimeClaimFromBody(body: string): DispatchRuntimeClaim | null {
  return parseDispatchRuntime(body);
}
