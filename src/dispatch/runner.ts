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
  readonly execute: (entry: DispatchQueueEntry, existing: Run | null) => Promise<DispatchExecution>;
  readonly createClaimId?: () => string;
}

export type DispatchOnceResult =
  | { readonly outcome: 'no_eligible_work'; readonly reasons: readonly string[] }
  | { readonly outcome: 'existing_claim'; readonly claim: DispatchRuntimeClaim }
  | { readonly outcome: 'dispatched'; readonly entry: DispatchQueueEntry; readonly claim: DispatchRuntimeClaim; readonly execution: DispatchExecution };

function target(entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>) {
  return { kind: 'issue' as const, owner: options.owner, repo: options.repo, issueNumber: entry.issue };
}

function existingRun(store: RunStore, entry: DispatchQueueEntry, options: Pick<DispatchOnceOptions, 'owner' | 'repo'>): Run | null {
  const wanted = target(entry, options);
  return store.list().find((run) =>
    run.target.kind === 'issue' && run.target.owner === wanted.owner && run.target.repo === wanted.repo && run.target.issueNumber === wanted.issueNumber,
  ) ?? null;
}

/** A persisted non-terminal Run is an ownership fence even before it has a PR. */
function isActiveRun(run: Run | null): boolean {
  return run !== null && run.state !== 'MERGED' && run.state !== 'FAILED';
}

async function eligibility(entry: DispatchQueueEntry, options: DispatchOnceOptions): Promise<{ readonly run: Run | null; readonly reason: string | null }> {
  const issueTarget = target(entry, options);
  const run = existingRun(options.store, entry, options);
  if (isActiveRun(run)) return { run, reason: `#${entry.issue}: existing durable run ${run!.id} is ${run!.state}` };
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

/**
 * Perform one v0 serial dispatch attempt. A queue comment cannot by itself
 * authorize work: every candidate is checked against current Issue/PR/Run
 * identity before a machine-owned claim is written and reread.
 */
export async function dispatchOnce(options: DispatchOnceOptions): Promise<DispatchOnceResult> {
  const existing = selectDispatchRuntime(await options.runtime.listRuntimeComments());
  if (existing !== null) {
    const entry: DispatchQueueEntry = { issue: existing.claim.issue, route: 'codex', profile: existing.claim.profile };
    const run = existingRun(options.store, entry, options);
    if (existing.claim.runId !== null && (run === null || run.id !== existing.claim.runId)) {
      throw new DispatchProtocolError('Dispatch runtime claim names a missing or different durable run; refusing recovery.');
    }
    if (run === null || isActiveRun(run)) {
      const execution = await options.execute(entry, run);
      const claim = await updateClaim(options.runtime, existing.id, existing.claim, options.now(), options.leaseDurationMs, execution);
      return { outcome: 'dispatched', entry, claim, execution };
    }

    // A terminal durable Run must never be executed again. Retain its claim
    // while its queue entry is still present, but allow the same sole runtime
    // comment to be safely superseded once the Steward has removed it.
    const queue = parseDispatchQueue(options.queueBody);
    if (queue.some((queued) => queued.issue === entry.issue && queued.route === 'codex' && queued.profile === entry.profile)) {
      return { outcome: 'existing_claim', claim: existing.claim };
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
      let execution: DispatchExecution;
      try {
        execution = await options.execute(queued, checked.run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DispatchProtocolError(`Claim ${claim.claimId} was retained but execution could not start safely: ${message}`);
      }
      const updated = await updateClaim(options.runtime, existing.id, claim, options.now(), options.leaseDurationMs, execution);
      return { outcome: 'dispatched', entry: queued, claim: updated, execution };
    }
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
    let execution: DispatchExecution;
    try {
      execution = await options.execute(entry, checked.run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DispatchProtocolError(`Claim ${claimed.claim.claimId} was retained but execution could not start safely: ${message}`);
    }
    const claim = await updateClaim(options.runtime, claimed.commentId, claimed.claim, options.now(), options.leaseDurationMs, execution);
    return { outcome: 'dispatched', entry, claim, execution };
  }
  return { outcome: 'no_eligible_work', reasons };
}

/** Read a runtime comment body safely for callers that retain comment ids. */
export function runtimeClaimFromBody(body: string): DispatchRuntimeClaim | null {
  return parseDispatchRuntime(body);
}
