import { randomUUID } from 'node:crypto';

import type { GitHubAdapter } from '../adapters/github.js';
import type { Run, WorkflowState } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import {
  DispatchProtocolError,
  claimDispatchEntry,
  parseDispatchQueue,
  parseDispatchRuntime,
  renderDispatchRuntime,
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
}

export interface DispatchOnceOptions {
  readonly queueBody: string;
  readonly owner: string;
  readonly repo: string;
  readonly github: GitHubAdapter;
  readonly store: RunStore;
  readonly runtime: DispatchRuntimeApi;
  readonly leaseDurationMs: number;
  readonly now: () => string;
  readonly execute: (entry: DispatchQueueEntry, existing: Run | null, claim: DispatchRuntimeClaim) => Promise<DispatchExecution>;
  readonly createClaimId?: () => string;
}

export type DispatchOnceResult =
  | { readonly outcome: 'no_eligible_work'; readonly reasons: readonly string[] }
  | { readonly outcome: 'existing_claim'; readonly claim: DispatchRuntimeClaim }
  | { readonly outcome: 'dispatched'; readonly entry: DispatchQueueEntry; readonly claim: DispatchRuntimeClaim; readonly execution: DispatchExecution };

function target(entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>) {
  return { kind: 'issue' as const, owner: options.owner, repo: options.repo, issueNumber: entry.issue };
}

function isTarget(run: Run, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): boolean {
  const wanted = target(entry, options);
  return run.target.kind === 'issue' && run.target.owner === wanted.owner && run.target.repo === wanted.repo && run.target.issueNumber === wanted.issueNumber;
}

function activeRun(store: RunStore, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): Run | null {
  return store.list().find((run) => isTarget(run, entry, options) && isActiveRun(run)) ?? null;
}

function claimedRun(store: RunStore, claim: DispatchRuntimeClaim, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): Run | null {
  if (claim.runId !== null) {
    const run = store.read(claim.runId);
    if (run === null || !isTarget(run, entry, options)) {
      throw new DispatchProtocolError('Dispatch runtime claim names a missing or different durable run; refusing recovery.');
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
  if (linked.length === 1) return linked[0]!;
  const activeUnbound = matching.filter((run) => isActiveRun(run) && run.dispatchClaimId !== claim.claimId);
  if (activeUnbound.length > 0) {
    throw new DispatchProtocolError('Unbound dispatch runtime claim found an unrelated active durable run; refusing ambiguous recovery.');
  }
  const laterUnbound = matching.filter((run) => run.createdAt >= claim.claimedAt && run.dispatchClaimId !== claim.claimId);
  if (laterUnbound.length > 0) {
    throw new DispatchProtocolError('Unbound dispatch runtime claim cannot prove ownership of a later durable run; refusing ambiguous recovery.');
  }
  return null;
}

/** A persisted non-terminal Run is an ownership fence even before it has a PR. */
function isActiveRun(run: Run | null): boolean {
  return run !== null && run.state !== 'MERGED' && run.state !== 'FAILED';
}

function isSettledRun(run: Run): boolean {
  return run.state === 'MERGED' || run.state === 'MERGE_READY' || run.state === 'NEEDS_HUMAN' || run.state === 'WAITING_DEPENDENCY' || run.state === 'FAILED';
}

async function eligibility(entry: DispatchQueueEntry, options: DispatchOnceOptions): Promise<{ readonly run: Run | null; readonly reason: string | null }> {
  const issueTarget = target(entry, options);
  const run = activeRun(options.store, entry, options);
  if (run !== null) return { run, reason: `#${entry.issue}: existing durable run ${run.id} is ${run.state}` };
  const issue = await options.github.readIssue(issueTarget);
  if (issue.state !== 'open') return { run, reason: `#${entry.issue}: Issue is ${issue.state}` };
  const pulls = await options.github.listPullRequests(issueTarget);
  if (pulls.some((pull) => pull.state === 'open')) return { run, reason: `#${entry.issue}: an associated pull request is already open` };
  return { run, reason: null };
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
  entry: DispatchQueueEntry,
  options: Pick<DispatchOnceOptions, 'now' | 'leaseDurationMs' | 'createClaimId'>,
): Promise<DispatchRuntimeClaim> {
  const now = options.now();
  const claim: DispatchRuntimeClaim = {
    issue: entry.issue,
    claimId: (options.createClaimId ?? randomUUID)(),
    runId: null,
    profile: entry.profile,
    state: 'claimed',
    claimedAt: now,
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + options.leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(claim));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || observed.claim.claimId !== claim.claimId || observed.claim.runId !== null) {
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
  const next: DispatchRuntimeClaim = {
    ...claim,
    runId: run.runId,
    state: stateForExecution(run.state),
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(next));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || observed.claim.claimId !== claim.claimId || observed.claim.runId !== run.runId) {
    throw new DispatchProtocolError('Dispatch runtime heartbeat did not retain the exact claim/run identity.');
  }
  return observed.claim;
}

async function refreshClaim(
  api: DispatchRuntimeApi,
  commentId: string,
  claim: DispatchRuntimeClaim,
  now: string,
  leaseDurationMs: number,
): Promise<DispatchRuntimeClaim> {
  const next: DispatchRuntimeClaim = {
    ...claim,
    state: 'running',
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + leaseDurationMs).toISOString(),
  };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(next));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || observed.claim.claimId !== claim.claimId || observed.claim.runId !== claim.runId || observed.claim.state !== 'running') {
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
): Promise<{ readonly claim: DispatchRuntimeClaim; readonly execution: DispatchExecution }> {
  let activeClaim = await refreshClaim(options.runtime, commentId, claim, options.now(), options.leaseDurationMs);
  let heartbeatFailure: unknown = null;
  let heartbeat = Promise.resolve();
  const interval = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      if (heartbeatFailure !== null) return;
      activeClaim = await refreshClaim(options.runtime, commentId, activeClaim, options.now(), options.leaseDurationMs);
    }).catch((error: unknown) => { heartbeatFailure ??= error; });
  }, Math.max(1, Math.floor(options.leaseDurationMs / 2)));
  try {
    let execution: DispatchExecution;
    try {
      execution = await options.execute(entry, existing, activeClaim);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DispatchProtocolError(`Claim ${activeClaim.claimId} was retained but execution could not start safely: ${message}`);
    }
    clearInterval(interval);
    await heartbeat;
    if (heartbeatFailure !== null) {
      const message = heartbeatFailure instanceof Error ? heartbeatFailure.message : String(heartbeatFailure);
      throw new DispatchProtocolError(`Claim ${activeClaim.claimId} could not be kept alive during execution: ${message}`);
    }
    const updated = await updateClaim(options.runtime, commentId, activeClaim, options.now(), options.leaseDurationMs, execution);
    return { claim: updated, execution };
  } finally {
    clearInterval(interval);
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
  const retired: DispatchRuntimeClaim = { ...claim, state: 'retired', heartbeatAt: now, leaseUntil: now };
  await api.updateRuntimeComment(commentId, renderDispatchRuntime(retired));
  const observed = selectDispatchRuntime(await api.listRuntimeComments());
  if (observed === null || observed.id !== commentId || observed.claim.claimId !== claim.claimId || observed.claim.state !== 'retired') {
    throw new DispatchProtocolError('Retired dispatch runtime claim did not retain its exact claim identity.');
  }
  return observed.claim;
}

/**
 * Perform one v0 serial dispatch attempt. A queue comment cannot by itself
 * authorize work: every candidate is checked against current Issue/PR/Run
 * identity before a machine-owned claim is written and reread.
 */
export async function dispatchOnce(options: DispatchOnceOptions): Promise<DispatchOnceResult> {
  const existing = selectDispatchRuntime(await options.runtime.listRuntimeComments());
  if (existing !== null) {
    const entry: DispatchQueueEntry = { issue: existing.claim.issue, route: 'codex', profile: existing.claim.profile };
    const queue = parseDispatchQueue(options.queueBody);
    if (existing.claim.state === 'retired') {
      const reasons: string[] = [];
      for (const queued of queue) {
        if (queued.route !== 'codex') {
          reasons.push(`#${queued.issue}: route ${queued.route} is not executable by this dispatcher`);
          continue;
        }
        const checked = await eligibility(queued, options);
        if (checked.reason !== null) {
          reasons.push(checked.reason);
          continue;
        }
        const claim = await supersedeTerminalClaim(options.runtime, existing.id, queued, options);
        const dispatched = await executeWithHeartbeat(options, existing.id, queued, checked.run, claim);
        return { outcome: 'dispatched', entry: queued, ...dispatched };
      }
      return { outcome: 'no_eligible_work', reasons };
    }
    const run = claimedRun(options.store, existing.claim, entry, options);
    if (run === null || !isSettledRun(run)) {
      const dispatched = await executeWithHeartbeat(options, existing.id, entry, run, existing.claim);
      return { outcome: 'dispatched', entry, ...dispatched };
    }

    // A terminal durable Run must never be executed again. Retain its claim
    // while its queue entry is still present, but allow the same sole runtime
    // comment to be safely superseded once the Steward has removed it.
    const reconciled = needsTerminalReconciliation(existing.claim, run)
      ? await updateClaim(options.runtime, existing.id, existing.claim, options.now(), options.leaseDurationMs, {
        runId: run.id,
        state: run.state,
      })
      : existing.claim;
    if (queue.some((queued) => queued.issue === entry.issue && queued.route === 'codex' && queued.profile === entry.profile)) {
      return { outcome: 'existing_claim', claim: reconciled };
    }
    const reasons: string[] = [];
    for (const queued of queue) {
      if (queued.route !== 'codex') {
        reasons.push(`#${queued.issue}: route ${queued.route} is not executable by this dispatcher`);
        continue;
      }
      const checked = await eligibility(queued, options);
      if (checked.reason !== null) {
        reasons.push(checked.reason);
        continue;
      }
      const claim = await supersedeTerminalClaim(options.runtime, existing.id, queued, options);
      const dispatched = await executeWithHeartbeat(options, existing.id, queued, checked.run, claim);
      return { outcome: 'dispatched', entry: queued, ...dispatched };
    }
    await retireTerminalClaim(options.runtime, existing.id, reconciled, options.now());
    return { outcome: 'no_eligible_work', reasons };
  }
  const queue = parseDispatchQueue(options.queueBody);
  const reasons: string[] = [];
  for (const entry of queue) {
    if (entry.route !== 'codex') {
      reasons.push(`#${entry.issue}: route ${entry.route} is not executable by this dispatcher`);
      continue;
    }
    const checked = await eligibility(entry, options);
    if (checked.reason !== null) {
      reasons.push(checked.reason);
      continue;
    }
    const claimed = await claimDispatchEntry(options.runtime, entry, {
      now: options.now,
      leaseDurationMs: options.leaseDurationMs,
      ...(options.createClaimId === undefined ? {} : { createClaimId: options.createClaimId }),
    });
    const dispatched = await executeWithHeartbeat(options, claimed.commentId, entry, checked.run, claimed.claim);
    return { outcome: 'dispatched', entry, ...dispatched };
  }
  return { outcome: 'no_eligible_work', reasons };
}

/** Read a runtime comment body safely for callers that retain comment ids. */
export function runtimeClaimFromBody(body: string): DispatchRuntimeClaim | null {
  return parseDispatchRuntime(body);
}
