import { unresolvedNativeLead } from '../oracle/native-lead.js';
import { applyTransition } from '../domain/state-machine.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { Run } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import { oracleDigest } from '../oracle/source-evidence.js';

export const MERGE_OBSERVATIONS = 3;
export const MERGE_BACKOFF_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : oracleDigest(a) === oracleDigest(b);

/** Nonsecret descriptor supplied by the accepted running release, never candidate code/config. */
export interface NativeMergePolicy {
  readonly enabled: true;
  readonly revision: string;
  readonly releaseId: string;
  readonly campaign: string;
  readonly dispatchRevision: string;
  readonly owner: string;
  readonly repo: string;
  readonly controlIssue: number;
  readonly queueCommentId: number;
  readonly baseBranch: string;
  readonly method: 'squash';
  readonly integrationPolicy: 'bootstrap-base-tree-v1';
  readonly reviewPolicyRevision: string;
  readonly localValidationRevision: string;
  readonly hostedValidationRevision: string;
}
const POLICY_KEYS = 'baseBranch,campaign,controlIssue,dispatchRevision,enabled,hostedValidationRevision,integrationPolicy,localValidationRevision,method,owner,queueCommentId,releaseId,repo,reviewPolicyRevision,revision';
export function validMergePolicy(value: unknown): value is NativeMergePolicy {
  const p = value as NativeMergePolicy;
  return !!p && Object.keys(p).sort().join(',') === POLICY_KEYS && p.enabled === true && p.method === 'squash' && p.integrationPolicy === 'bootstrap-base-tree-v1' &&
    [p.revision, p.releaseId, p.campaign, p.dispatchRevision, p.owner, p.repo, p.baseBranch, p.reviewPolicyRevision, p.localValidationRevision, p.hostedValidationRevision].every(text) &&
    /^[a-z0-9_.-]+$/i.test(p.owner) && /^[a-z0-9_.-]+$/i.test(p.repo) &&
    Number.isSafeInteger(p.controlIssue) && p.controlIssue > 0 && Number.isSafeInteger(p.queueCommentId) && p.queueCommentId > 0;
}
export interface NativeMergeHost {
  readonly policy: NativeMergePolicy;
  /** Accepted host object database, outside the candidate workspace. No fetch or executable candidate config. */
  readonly candidate: (base: string, head: string) => { readonly treeSha: string; readonly baseIsAncestor: boolean };
}
export function resolveNativeMergeHost(host?: NativeMergeHost): NativeMergeHost | undefined {
  try {
    if (!host || !validMergePolicy(host.policy) || typeof host.candidate !== 'function' || Object.keys(host).sort().join(',') !== 'candidate,policy') return undefined;
    return Object.freeze({ policy: Object.freeze(structuredClone(host.policy)), candidate: host.candidate });
  } catch { return undefined; }
}
/** Concrete local-only trusted object reader; the accepted host selects repositoryRoot. */
export function readMergeCandidate(repositoryRoot: string, base: string, head: string): { treeSha: string; baseIsAncestor: boolean } {
  if (!SHA.test(base) || !SHA.test(head)) throw new Error('Merge candidate requires exact commit identities.');
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', ...args], {
    cwd: repositoryRoot, timeout: 15_000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' },
  }).trim();
  for (const sha of [base, head]) if (git('cat-file', '-t', sha) !== 'commit') throw new Error('Merge source is not a commit.');
  const treeSha = git('rev-parse', `${head}^{tree}`);
  if (!SHA.test(treeSha)) throw new Error('Merge source tree is unavailable.');
  return { treeSha, baseIsAncestor: git('merge-base', base, head) === base };
}
export interface NativeMergeIdentity {
  readonly attemptId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly missionId: string;
  readonly laneId: string;
  readonly generation: number;
  readonly pullRequestNumber: number;
  readonly sourceBranch: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly treeSha: string;
  readonly reviewDigest: string;
  readonly validationDigest: string;
  readonly policy: NativeMergePolicy;
  readonly preparedAt: string;
}
export interface NativeMergeQualification {
  readonly mergeCommitSha: string;
  readonly parentSha: string;
  readonly treeSha: string;
  readonly mainSha: string;
  readonly observedAt: string;
}
export interface NativeMergeAttempt {
  readonly identity: NativeMergeIdentity;
  readonly submissionPossible: boolean;
  /** Exact fresh owner generation recorded once at the issuance cut. */
  readonly issuanceGeneration?: number;
  readonly observations: number;
  readonly nextObservationAt: string;
  /** Direct merged readback, never a premerge synthetic SHA. */
  readonly observedMerged?: { readonly mergeCommitSha: string; readonly observedAt: string };
  readonly qualification?: NativeMergeQualification;
  readonly reason?: string;
}
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
export function nativeMergeCoherent(run: Run): boolean {
  try {
    const a = run.mergeAttempt;
    if (a === undefined) return true;
    const i = a.identity;
    return !!i && validMergePolicy(i.policy) && [i.attemptId, i.runId, i.claimId, i.missionId, i.laneId, i.sourceBranch, i.reviewDigest, i.validationDigest].every(text) &&
      i.runId === run.id && i.claimId === run.dispatchClaimId && i.laneId === `run:${run.id}` && Number.isSafeInteger(i.generation) && i.generation > 0 &&
      i.pullRequestNumber === run.pullRequest?.number && i.headSha === run.headSha && i.headSha === run.pullRequest?.headSha &&
      run.bootstrap?.baseSha === i.baseSha && run.bootstrap.baseBranch === i.policy.baseBranch && (run.bootstrap.publicationBranch ?? run.bootstrap.branch) === i.sourceBranch &&
      `${run.target.owner}/${run.target.repo}`.toLowerCase() === `${i.policy.owner}/${i.policy.repo}`.toLowerCase() &&
      [i.reviewDigest, i.validationDigest].every((s) => /^[0-9a-f]{64}$/.test(s)) && [i.headSha, i.baseSha, i.treeSha].every((s) => SHA.test(s)) && date(i.preparedAt) && typeof a.submissionPossible === 'boolean' &&
      (a.submissionPossible ? Number.isSafeInteger(a.issuanceGeneration) && a.issuanceGeneration! >= i.generation : a.issuanceGeneration === undefined) &&
      Number.isSafeInteger(a.observations) && a.observations >= 0 && a.observations <= MERGE_OBSERVATIONS && date(a.nextObservationAt) &&
      (a.reason === undefined || text(a.reason)) && (a.observedMerged === undefined || a.submissionPossible && SHA.test(a.observedMerged.mergeCommitSha) && date(a.observedMerged.observedAt)) &&
      (a.qualification === undefined || !!a.observedMerged && a.qualification.mergeCommitSha === a.observedMerged.mergeCommitSha && a.qualification.parentSha === i.baseSha && a.qualification.treeSha === i.treeSha && SHA.test(a.qualification.mainSha) && date(a.qualification.observedAt));
  } catch { return false; }
}
export function nativeMergeProgresses(previous: Run, next: Run): boolean {
  if (next.state === 'MERGED' && previous.state !== 'MERGED' && (next.nativeReview !== undefined || next.nativeLead !== undefined || next.mergeAttempt !== undefined)) {
    try { assertNativeMergeSettlement(next); } catch { return false; }
  }
  const a = previous.mergeAttempt; const b = next.mergeAttempt;
  return a === undefined || b !== undefined && same(a.identity, b.identity) && (!a.submissionPossible || b.submissionPossible) && b.observations >= a.observations && Date.parse(b.nextObservationAt) >= Date.parse(a.nextObservationAt) &&
    (a.issuanceGeneration === undefined || a.issuanceGeneration === b.issuanceGeneration) &&
    (a.observedMerged === undefined || same(a.observedMerged, b.observedMerged)) && (a.qualification === undefined || same(a.qualification, b.qualification));
}
export function unresolvedNativeMerge(run: Run): boolean { return run.mergeAttempt?.submissionPossible === true && run.mergeAttempt.qualification === undefined; }
export function nativeMergeReentry(run: Run, now: string): boolean {
  const a = run.mergeAttempt;
  return a !== undefined && a.submissionPossible && !a.qualification && a.observations < MERGE_OBSERVATIONS && Date.parse(a.nextObservationAt) <= Date.parse(now);
}

/** Deterministic capability absence is known before an irreversible request.
 * Transient failures after a fully equipped issuance remain uncertainty. */
export function hasMergeIntegrationCapabilities(github: GitHubAdapter): boolean {
  return [github.readPullRequest, github.readDefaultBranch, github.readCommit, github.isAncestor].every((method) => typeof method === 'function');
}
function hasMergeIssuanceCapabilities(github: GitHubAdapter): boolean {
  return typeof github.squashPullRequest === 'function' && hasMergeIntegrationCapabilities(github);
}

/** Re-read actual immutable squash provenance and fresh default history. PR base is mutable after merge. */
export async function qualifiedMergeIntegration(run: Run, github: GitHubAdapter, now: string): Promise<NativeMergeQualification> {
  const a = run.mergeAttempt; const i = a?.identity;
  if (!a?.submissionPossible || !i || !nativeMergeCoherent(run) || !hasMergeIntegrationCapabilities(github)) throw new Error('Native merge settlement lacks complete issued-attempt provenance capabilities.');
  const p = await github.readPullRequest!(run.target.owner, run.target.repo, i.pullRequestNumber);
  if (p.state !== 'merged' || p.number !== i.pullRequestNumber || p.headSha !== i.headSha || p.headRef !== i.sourceBranch || p.baseRef !== i.policy.baseBranch ||
    p.headRepository?.owner.toLowerCase() !== i.policy.owner.toLowerCase() || p.headRepository.repo.toLowerCase() !== i.policy.repo.toLowerCase() ||
    p.baseRepository?.owner.toLowerCase() !== i.policy.owner.toLowerCase() || p.baseRepository.repo.toLowerCase() !== i.policy.repo.toLowerCase() || !SHA.test(p.mergeCommitSha ?? '') ||
    a.observedMerged !== undefined && p.mergeCommitSha !== a.observedMerged.mergeCommitSha) throw new Error('Direct merged source identity or actual merge commit is unqualified.');
  const commit = await github.readCommit!(i.policy.owner, i.policy.repo, p.mergeCommitSha!);
  if (commit.sha !== p.mergeCommitSha || commit.parents.length !== 1 || commit.parents[0] !== i.baseSha || commit.treeSha !== i.treeSha) throw new Error('Actual squash parent/tree differs from the recorded validated base/tree.');
  const main = await github.readDefaultBranch!(i.policy.owner, i.policy.repo);
  if (main.branch !== i.policy.baseBranch || !SHA.test(main.headSha) || !await github.isAncestor!(i.policy.owner, i.policy.repo, commit.sha, main.headSha)) throw new Error('Actual merge is not proven in fresh default-branch history.');
  return { mergeCommitSha: commit.sha, parentSha: i.baseSha, treeSha: commit.treeSha, mainSha: main.headSha, observedAt: now };
}
/** All native- or attempt-bearing manual, automatic and retry settlement passes this guard. */
export function assertNativeMergeSettlement(run: Run): void {
  if(unresolvedNativeLead(run))throw new Error('Native lead remote work remains unresolved; integration proof cannot release it.');
  if (run.nativeReview === undefined && run.nativeLead === undefined && run.mergeAttempt === undefined) return;
  const a = run.mergeAttempt;
  if (!a?.qualification || !nativeMergeCoherent(run) || a.identity.reviewDigest !== run.nativeReview?.accepted?.digest || a.identity.validationDigest !== oracleDigest(run.validationResult)) throw new Error('Native-bearing settlement requires qualified actual merge integration and its exact validated/reviewed attempt.');
}
/** Original immutable control location survives absent/revoked/replaced process config.
 * The fixed lease is only a bounded readback heartbeat; recovery grants no new work. */
export function issuedMergeRecoveryConfiguration(run: Run): import('../dispatch/config.js').DispatchConfiguration {
  const policy = run.mergeAttempt?.identity.policy;
  if (!run.mergeAttempt?.submissionPossible || !policy || !nativeMergeCoherent(run)) throw new Error('Issued merge recovery requires a coherent durable attempt.');
  return Object.freeze({ revision: policy.dispatchRevision, owner: policy.owner, repo: policy.repo, controlIssue: policy.controlIssue, queueCommentId: policy.queueCommentId, leaseDurationMs: 60_000 });
}
export interface MergeContext {
  readonly run: Run;
  readonly store: RunStore;
  readonly github: GitHubAdapter;
  readonly now: () => string;
  readonly owner?: { readonly missionId: string; readonly laneId: string; readonly generation: number };
  readonly assertCurrent: () => void;
  readonly assertClaim?: (run: Run) => Promise<void>;
  readonly assertInitiation?: (run: Run) => Promise<void>;
  readonly withBoundary?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly onSubmission: () => void;
}
/** Already-issued recovery deliberately has no host policy or model dependency. */
export async function observeNativeMerge(context: MergeContext): Promise<Run> {
  let run = context.run; const a = run.mergeAttempt;
  if (!a?.submissionPossible || a.qualification || !nativeMergeReentry(run, context.now())) return run;
  const save = (next: Run) => {
    context.assertCurrent();
    if (context.store.updateIfUnchanged?.(run, next) !== true) throw new Error('Run changed during native merge observation.');
    run = next;
  };
  if (!context.owner || context.owner.missionId !== a.identity.missionId || context.owner.laneId !== a.identity.laneId || context.owner.generation < a.issuanceGeneration! || !context.assertClaim) throw new Error('Issued merge recovery lacks exact retained owner/claim.');
  await context.assertClaim(run); context.assertCurrent();
  save({ ...run, mergeAttempt: { ...a, observations: a.observations + 1, nextObservationAt: new Date(Date.parse(context.now()) + MERGE_BACKOFF_MS).toISOString() } });
  let qualification: NativeMergeQualification | undefined;
  let reason = 'Merge outcome unknown; original attempt retained without resubmission.';
  try {
    const p = await context.github.readPullRequest?.(run.target.owner, run.target.repo, a.identity.pullRequestNumber);
    if (p?.state === 'merged' && SHA.test(p.mergeCommitSha ?? '')) {
      if (!run.mergeAttempt!.observedMerged) save({ ...run, mergeAttempt: { ...run.mergeAttempt!, observedMerged: { mergeCommitSha: p.mergeCommitSha!, observedAt: context.now() } } });
      qualification = await qualifiedMergeIntegration(run, context.github, context.now());
    } else if (p?.state === 'closed') reason = 'PR is closed unmerged; retained attempt requires explicit disposition.';
  } catch (error) { reason = `Merge outcome remains unqualified: ${error instanceof Error ? error.message : String(error)}`; }
  await context.assertClaim(run); context.assertCurrent();
  save({ ...run, mergeAttempt: { ...run.mergeAttempt!, ...(qualification ? { qualification, reason: 'Actual squash and fresh default-branch ancestry qualified.' } : { reason }) } });
  return run;
}
/** One expected-HEAD squash. BASE uses explicitly accepted last-observed semantics, not atomic enforcement. */
export async function initiateNativeMerge(context: MergeContext, host: NativeMergeHost, snapshot: GitHubLiveSnapshot): Promise<Run> {
  if (unresolvedNativeLead(context.run)) return context.run;
  if (!context.withBoundary || !context.assertInitiation || !context.owner || !context.assertClaim || !hasMergeIssuanceCapabilities(context.github)) return context.run;
  return await context.withBoundary(async () => {
    let run = context.run;
    const p = host.policy;
    const snapshotPr = snapshot.pullRequest;
    const save = (next: Run) => { context.assertCurrent(); if (context.store.updateIfUnchanged?.(run, next) !== true) throw new Error('Run changed before native merge issuance.'); run = next; };
    await context.assertInitiation!(run); await context.assertClaim!(run); context.assertCurrent();
    if (!hasMergeIssuanceCapabilities(context.github)) return run;
    const owner = context.owner!;
    if (run.state !== 'MERGE_READY' || !run.nativeReview?.accepted || !run.bootstrap || !run.headSha || snapshot.headSha !== run.headSha || snapshotPr?.state !== 'open' || snapshotPr.number !== run.pullRequest?.number ||
      snapshotPr.baseRef !== p.baseBranch || snapshotPr.baseRepository?.owner.toLowerCase() !== p.owner.toLowerCase() || snapshotPr.baseRepository.repo.toLowerCase() !== p.repo.toLowerCase() ||
      snapshotPr.headRepository?.owner.toLowerCase() !== p.owner.toLowerCase() || snapshotPr.headRepository.repo.toLowerCase() !== p.repo.toLowerCase() || snapshotPr.headRef !== (run.bootstrap.publicationBranch ?? run.bootstrap.branch) ||
      run.nativeReview.accepted.identity.policyRevision !== p.reviewPolicyRevision || run.validationResult?.local.configRevision !== p.localValidationRevision || run.validationResult.hosted.policyRevision !== p.hostedValidationRevision) return run;
    const park = (reason: string) => { save(applyTransition(run, { type: 'wait_dependency', reason }, context.now())); return run; };
    const main = await context.github.readDefaultBranch!(p.owner, p.repo);
    if (main.branch !== p.baseBranch || main.headSha !== run.bootstrap.baseSha || snapshotPr.baseSha !== main.headSha) return park('Merge preparation observed default/PR/bootstrap base drift; explicit integration disposition and fresh validation/review are required.');
    const candidate = host.candidate(main.headSha, run.headSha);
    if (!candidate.baseIsAncestor || !SHA.test(candidate.treeSha)) return park('Merge preparation cannot prove the bootstrap base is an ancestor of the validated source tree.');
    if (!hasMergeIssuanceCapabilities(context.github)) return run;
    if (!run.mergeAttempt) {
      const identity: NativeMergeIdentity = { attemptId: randomUUID(), runId: run.id, claimId: run.dispatchClaimId!, missionId: owner.missionId, laneId: owner.laneId, generation: owner.generation,
        pullRequestNumber: snapshotPr.number, sourceBranch: snapshotPr.headRef!, headSha: run.headSha, baseSha: main.headSha, treeSha: candidate.treeSha, reviewDigest: run.nativeReview.accepted.digest,
        validationDigest: oracleDigest(run.validationResult), policy: p, preparedAt: context.now() };
      save({ ...run, mergeAttempt: { identity, submissionPossible: false, observations: 0, nextObservationAt: context.now() } });
    }
    const a = run.mergeAttempt!;
    if (a.submissionPossible || owner.generation < a.identity.generation || a.identity.missionId !== owner.missionId || !same(a.identity.policy, p) || a.identity.treeSha !== candidate.treeSha || a.identity.validationDigest !== oracleDigest(run.validationResult) || a.identity.reviewDigest !== run.nativeReview!.accepted!.digest) return run;
    if (!hasMergeIssuanceCapabilities(context.github)) return run;
    // Mark local ownership before the durable uncertainty cut. Any exception
    // after this cut conservatively retains the same owner and never resends.
    context.onSubmission();
    if (!hasMergeIssuanceCapabilities(context.github)) return run;
    save({ ...run, mergeAttempt: { ...a, submissionPossible: true, issuanceGeneration: owner.generation } });
    await context.assertInitiation!(run); await context.assertClaim!(run); context.assertCurrent();
    if (context.store.updateIfUnchanged?.(run, run) !== true) throw new Error('Run changed at merge publication fence.');
    if (!hasMergeIssuanceCapabilities(context.github)) return run;
    try { await context.github.squashPullRequest!(p.owner, p.repo, a.identity.pullRequestNumber, a.identity.headSha); } catch { /* Lost acknowledgement is uncertainty, never retry authority. */ }
    return await observeNativeMerge({ ...context, run });
  });
}
