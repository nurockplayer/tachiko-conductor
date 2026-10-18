import { JsonFileOracleReceiptStore } from './receipt-store.js';
import { authenticatedCompletionEvidence, hasAuthenticatedCompletion, validCompletionProof } from './completion-proof.js';
import { originalImplementationMatches } from '../domain/implementation-authority.js';
import { nativeLeadStopped } from './native-lead.js';
import { randomUUID } from 'node:crypto';
import type { NativeReviewBoundary, NativeReviewContext, ReviewerAdapter } from '../adapters/reviewer.js';
import type { ReviewResult, Run } from '../domain/types.js';
import { applyTransition } from '../domain/state-machine.js';
import { isProviderExecutionTelemetry } from '../domain/telemetry.js';
import { classifyReviewRisk, canonicalReviewTarget } from '../reviewers/risk-policy.js';
import { oracleDigest, validNativeSourceManifest } from './source-evidence.js';
import type { NativeOracleEvidence, NativeReviewIdentity, NativeReviewObservation, NativeReviewRequestState, NativeReviewerHost, OracleEffort } from './types.js';

export const NATIVE_REVIEW_OBSERVATIONS = 3;
export const NATIVE_REVIEW_BACKOFF_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._:-]{1,300}$/;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
const same = (a: unknown, b: unknown) => a === b || a !== undefined && b !== undefined && oracleDigest(a) === oracleDigest(b);

/** Match the state machine's durable review projection. Authentication and
 * receipt digests still cover the full terminal result, including telemetry. */
function durableReview(result: ReviewResult | undefined): Omit<ReviewResult, 'telemetry'> | undefined {
  if (result === undefined) return undefined;
  const { telemetry: _telemetry, ...review } = result;
  return review;
}

function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (v: unknown): void => { if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(freeze); } };
  freeze(copy);
  return copy;
}

export function validNativeIdentity(v: NativeReviewIdentity): boolean {
  return !!v && Object.keys(v).sort().join(',') === 'baseSha,bindingId,claimId,contractRevision,correlationId,diffSha256,floor,headSha,laneId,missionId,ownerGeneration,phase,policyRevision,pullRequestNumber,repository,requestId,requestedEffort,requestedModel,role,runId,scope,sourceSha256,targetKey' &&
    ID.test(v.requestId) && v.correlationId === v.requestId && [v.runId, v.claimId, v.missionId, v.laneId, v.targetKey, v.repository, v.contractRevision, v.scope, v.policyRevision, v.bindingId, v.requestedModel].every(text) &&
    v.laneId === `run:${v.runId}` && v.phase === 'review' && v.role === 'independent-reviewer' && Number.isSafeInteger(v.ownerGeneration) && v.ownerGeneration > 0 && Number.isSafeInteger(v.pullRequestNumber) && v.pullRequestNumber > 0 &&
    SHA.test(v.baseSha) && SHA.test(v.headSha) && DIGEST.test(v.sourceSha256) && DIGEST.test(v.diffSha256) && v.floor === 'R5' && v.requestedEffort === 'Extra High';
}

export function validNativeEvidence(e: NativeOracleEvidence): boolean {
  try {
    if (!e || !validNativeIdentity(e.identity)) return false;
    if (e.kind === 'request') return Object.keys(e).sort().join(',') === 'id,identity,kind,manifest' && e.id === `${e.identity.requestId}.request` && validNativeSourceManifest(e.manifest) &&
      e.manifest.headSha === e.identity.headSha && e.manifest.baseSha === e.identity.baseSha && e.manifest.sourceSha256 === e.identity.sourceSha256 && e.manifest.diffSha256 === e.identity.diffSha256;
    if (e.kind !== 'terminal' || Object.keys(e).sort().join(',') !== 'authentication,id,identity,kind,result' || e.id !== `${e.identity.requestId}.terminal`) return false;
    const r = e.result;
    const a = e.authentication;
    return !!r && Object.keys(r).every((k) => ['verdict', 'reviewerName', 'headSha', 'findings', 'telemetry'].includes(k)) && ['approve', 'request_changes'].includes(r.verdict) && text(r.reviewerName) && r.headSha === e.identity.headSha &&
      (r.telemetry === undefined || isProviderExecutionTelemetry(r.telemetry)) &&
      Array.isArray(r.findings) && r.findings.length <= 20 && r.findings.every((f) => ['blocking', 'non_blocking'].includes(f.severity) && text(f.summary) && (f.detail === undefined || typeof f.detail === 'string' && f.detail.length <= 2_000)) &&
      (r.verdict === 'approve' ? !r.findings.some((f) => f.severity === 'blocking') : r.findings.some((f) => f.severity === 'blocking')) &&
      !!a && Object.keys(a).sort().join(',') === 'actorId,effort,model,transportReceipt' && text(a.actorId) && text(a.transportReceipt) && a.model === e.identity.requestedModel && a.effort === e.identity.requestedEffort;
  } catch { return false; }
}

/** Only transport uncertainty may become a more restrictive semantic outcome.
 * Once semantic evidence exists, later transport/pending outcomes cannot erase it. */
export function semanticNativeFailure(failure: NativeReviewRequestState['failure']): boolean {
  return failure==='safety_refusal' || failure==='missing_evidence';
}
export function retainedNativeFailure(previous: NativeReviewRequestState['failure'], observed: NativeReviewRequestState['failure']): NativeReviewRequestState['failure'] {
  return semanticNativeFailure(previous) ? previous : observed ?? previous;
}
export function nativeFailureProgresses(previous: NativeReviewRequestState['failure'], next: NativeReviewRequestState['failure']): boolean {
  return retainedNativeFailure(previous,next)===next;
}

function verdictEligible(request: NativeReviewRequestState | undefined): boolean {
  return request?.status==='qualified_complete' && (request.failure===undefined || request.failure==='transport_failure');
}

/** Read compatibility never supplies missing native qualification. */
export function nativeReviewCoherent(run: Run, inspectOnly = false): boolean {
  try {
    const ledger = run.nativeReview;
    if (ledger === undefined) return true;
    if (!Object.keys(ledger).every(k => ['requests','activeRequestId','accepted','wait','repairLimit','recoveryConfiguration'].includes(k))) return false;
    if (ledger.recoveryConfiguration !== undefined && !validRecoveryConfiguration(run, ledger.recoveryConfiguration)) return false;
    if (ledger.repairLimit !== undefined && (!Number.isSafeInteger(ledger.repairLimit) || ledger.repairLimit<1)) return false;
    if (!Array.isArray(ledger.requests) || ledger.requests.length > 20 || new Set(ledger.requests.map((r) => r.identity.requestId)).size !== ledger.requests.length) return false;
    if (ledger.wait !== undefined && (!['binding', 'request', 'lead', 'qualification'].includes(ledger.wait.kind) || !Number.isFinite(Date.parse(ledger.wait.nextAttemptAt)))) return false;
    for (const r of ledger.requests) {
      if (!Object.keys(r).every(k => ['identity','status','submissionPossible','observations','nextObservationAt','conversationUrl','failure','replacedBy','terminalDigest','completionProof','terminalStatus','retirementReason'].includes(k)) || !validNativeIdentity(r.identity) || r.identity.runId !== run.id || r.identity.claimId !== run.dispatchClaimId || r.identity.targetKey !== canonicalReviewTarget(run.target)?.key || r.identity.repository !== `${run.target.owner}/${run.target.repo}`.toLowerCase() ||
        !['pending', 'qualified_complete', 'incomplete', 'terminal_unknown', 'retired', 'replaced'].includes(r.status) || typeof r.submissionPossible !== 'boolean' || !Number.isSafeInteger(r.observations) || r.observations < 0 || r.observations > NATIVE_REVIEW_OBSERVATIONS || !Number.isFinite(Date.parse(r.nextObservationAt)) ||
        (r.conversationUrl !== undefined && !validUrl(r.conversationUrl)) || (r.failure !== undefined && !['transport_failure', 'safety_refusal', 'missing_evidence'].includes(r.failure)) ||
        (r.terminalDigest !== undefined && (!DIGEST.test(r.terminalDigest) || !(['qualified_complete','retired','replaced'].includes(r.status) || r.status==='incomplete' && r.submissionPossible && r.failure!==undefined && r.failure!=='transport_failure' && r.completionProof!==undefined) || r.completionProof !== undefined && (!validCompletionProof(r.completionProof) || !inspectOnly && !hasAuthenticatedCompletion(r.identity, r.terminalDigest, r.completionProof, 'review')))) || (r.completionProof !== undefined && r.terminalDigest === undefined) || (r.status === 'qualified_complete' && (!r.submissionPossible || r.terminalDigest === undefined || !inspectOnly && r.failure!==undefined && r.failure!=='transport_failure')) ||
        (r.terminalStatus !== undefined && !['incomplete', 'terminal_unknown'].includes(r.terminalStatus)) || (r.retirementReason !== undefined && r.retirementReason !== 'irrecoverable_transport') ||
        (r.status === 'replaced' && (r.failure !== 'transport_failure' && !(semanticNativeFailure(r.failure) && r.terminalStatus==='incomplete') && !(r.terminalStatus === 'terminal_unknown' && r.retirementReason === 'irrecoverable_transport') || !ledger.requests.some((n) => n.identity.requestId === r.replacedBy && sameCandidate(r.identity, n.identity))))) return false;
      if (ledger.requests.filter((n) => sameCandidate(r.identity, n.identity)).length > 2) return false;
      const prior = ledger.requests.slice(0, ledger.requests.indexOf(r)).find((n) => sameCandidate(r.identity, n.identity));
      if (prior !== undefined && (prior.status !== 'replaced' || prior.failure !== 'transport_failure' && !(semanticNativeFailure(prior.failure) && prior.terminalStatus==='incomplete') && prior.retirementReason !== 'irrecoverable_transport' || prior.replacedBy !== r.identity.requestId || r.identity.floor !== 'R5')) return false;
    }
    const active = ledger.requests.find((r) => r.identity.requestId === ledger.activeRequestId);
    if (ledger.activeRequestId !== undefined && (active === undefined || active.status === 'retired' || active.status === 'replaced')) return false;
    const accepted = ledger.accepted;
    return accepted === undefined || Object.keys(accepted).sort().join(',') === 'digest,identity,receiptId,requestId' && !!active && active.status === 'qualified_complete' && active.identity.requestId === accepted.requestId && accepted.receiptId === `${accepted.requestId}.terminal` &&
      accepted.digest === active.terminalDigest && same(accepted.identity, active.identity);
  } catch { return false; }
}

/** Fresh transition payloads must match the complete authenticated terminal,
 * including telemetry. Cached validation separately uses the durable projection. */
export function authenticatedReviewMatches(run: Run, result: ReviewResult | undefined): boolean {
  const active = activeNativeReview(run), accepted = run.nativeReview?.accepted;
  if (!active || !accepted || !verdictEligible(active) || active.identity.requestId !== accepted.requestId) return false;
  const evidence = authenticatedCompletionEvidence(active.identity, active.terminalDigest, active.completionProof, 'review');
  return !!evidence && evidence.kind === 'terminal' && 'result' in evidence && evidence.id === accepted.receiptId && oracleDigest(evidence) === accepted.digest && validNativeEvidence({ ...evidence, result } as NativeOracleEvidence) && same(evidence.result, result);
}

/** Enforced by the real store for every write, including non-CAS legacy callers. */
export function nativeReviewProgresses(previous: Run, next: Run): boolean {
  if (next.nativeReview?.requests.some(n => n.terminalDigest !== undefined && !previous.nativeReview?.requests.some(r => r.identity.requestId === n.identity.requestId && r.terminalDigest === n.terminalDigest) && !hasAuthenticatedCompletion(n.identity, n.terminalDigest, n.completionProof, 'review'))) return false;
  const old = previous.nativeReview;
  if (old === undefined) return true;
  const ledger = next.nativeReview;
  if (ledger === undefined || old.repairLimit!==undefined && ledger.repairLimit!==old.repairLimit || ledger.requests.length < old.requests.length || old.recoveryConfiguration === undefined && ledger.recoveryConfiguration !== undefined && old.requests.some(r => r.submissionPossible) || old.recoveryConfiguration !== undefined && !same(old.recoveryConfiguration, ledger.recoveryConfiguration)) return false;
  return old.requests.every((r, i) => {
    const n = ledger.requests[i];
    if (!n || semanticNativeFailure(n.failure) && n.status==='replaced' && r.status!=='replaced' || r.failure!==undefined && r.failure!=='transport_failure' && n.status==='qualified_complete' || r.terminalDigest===undefined && n.terminalDigest!==undefined && (n.status!=='qualified_complete' && n.status!==r.status || !hasAuthenticatedCompletion(n.identity,n.terminalDigest,n.completionProof,'review')) || !same(r.identity, n.identity) || r.submissionPossible && !n.submissionPossible || n.observations < r.observations ||
      r.conversationUrl !== undefined && n.conversationUrl !== r.conversationUrl || !nativeFailureProgresses(r.failure,n.failure) || r.terminalDigest !== undefined && (n.terminalDigest !== r.terminalDigest || r.completionProof !== undefined && !same(r.completionProof, n.completionProof) || r.completionProof === undefined && n.completionProof !== undefined && !hasAuthenticatedCompletion(n.identity, n.terminalDigest, n.completionProof, 'review')) ||
      r.replacedBy !== undefined && n.replacedBy !== r.replacedBy || r.terminalStatus !== undefined && n.terminalStatus !== r.terminalStatus || r.retirementReason !== undefined && n.retirementReason !== r.retirementReason) return false;
    return r.status === n.status || r.status === 'pending' || r.status === 'terminal_unknown' && ['pending', 'qualified_complete', 'incomplete'].includes(n.status) || r.status === 'incomplete' && r.failure === 'transport_failure' && (n.status === 'replaced' || n.status === 'qualified_complete' && hasAuthenticatedCompletion(n.identity,n.terminalDigest,n.completionProof,'review')) ||
      r.status === 'terminal_unknown' && n.status === 'replaced' && n.retirementReason === 'irrecoverable_transport' || ['qualified_complete', 'incomplete', 'terminal_unknown'].includes(r.status) && n.status === 'retired';
  });
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}
function sameCandidate(a: NativeReviewIdentity, b: NativeReviewIdentity): boolean {
  return ['runId', 'claimId', 'missionId', 'phase', 'targetKey', 'repository', 'pullRequestNumber', 'baseSha', 'headSha', 'scope', 'sourceSha256', 'diffSha256'].every((k) => a[k as keyof NativeReviewIdentity] === b[k as keyof NativeReviewIdentity]);
}
export function activeNativeReview(run: Run): NativeReviewRequestState | undefined {
  return run.nativeReview?.requests.find((r) => r.identity.requestId === run.nativeReview?.activeRequestId);
}
export function unresolvedNativeReview(run: Run): boolean {
  return run.nativeReview?.requests.some((r) => r.submissionPossible && !hasAuthenticatedCompletion(r.identity, r.terminalDigest, r.completionProof, 'review')) === true;
}
/** Exact inactive uncertainty at a historical gate is observation work even
 * when a legacy row has a digest and its bounded service reads are spent. */
export function historicalReviewUncertainty(run: Run): boolean {
  const phase=run.state==='WAITING_DEPENDENCY'?run.interruptedFrom:run.state;
  return (phase==='FINAL_GATE'||phase==='MERGE_READY') && run.mergeAttempt?.submissionPossible!==true && !nativeLeadStopped(run) &&
    run.nativeReview?.requests.some(r=>r.identity.requestId!==run.nativeReview?.activeRequestId && r.submissionPossible && !hasAuthenticatedCompletion(r.identity,r.terminalDigest,r.completionProof,'review'))===true;
}
/** Historical recovery, including explicit attention resume, is not readiness. */
export function settledHistoricalReviewGate(run: Run): boolean {
  const phase = run.state === 'WAITING_DEPENDENCY' ? run.interruptedFrom : run.state;
  return (phase === 'FINAL_GATE' || phase === 'MERGE_READY') && (run.nativeReview?.wait?.kind === 'request' || run.nativeReview?.wait?.kind === 'qualification') &&
    verdictEligible(activeNativeReview(run)) && !unresolvedNativeReview(run) && !nativeLeadStopped(run);
}
/** Automatic recovery never polls intentional attention, exhausted or future work. */
export function nativeReviewObservationDue(run: Run, now: string, binding?: {readonly bindingId: string; readonly model: string}): boolean {
  if (run.nativeReview?.wait?.kind === 'qualification' || nativeLeadStopped(run)) return false;
  if (run.nativeReview?.wait && Date.parse(run.nativeReview.wait.nextAttemptAt) > Date.parse(now)) return false;
  return run.nativeReview?.requests.some(r => r.submissionPossible &&
    !hasAuthenticatedCompletion(r.identity,r.terminalDigest,r.completionProof,'review') &&
    (!binding || r.identity.bindingId === binding.bindingId && r.identity.requestedModel === binding.model) &&
    !semanticNativeFailure(r.failure) && (r.status !== 'incomplete' || r.failure === 'transport_failure') &&
    r.observations < NATIVE_REVIEW_OBSERVATIONS && Date.parse(r.nextObservationAt) <= Date.parse(now)) === true;
}
export function nativeReviewReentry(run: Run, now = new Date().toISOString()): boolean {
  if (run.state === 'WAITING_DEPENDENCY' && run.nativeReview?.wait?.kind === 'binding') return Date.parse(run.nativeReview.wait.nextAttemptAt) <= Date.parse(now);
  if (run.nativeReview?.wait !== undefined && Date.parse(run.nativeReview.wait.nextAttemptAt) > Date.parse(now)) return false;
  if (run.nativeReview?.wait?.kind === 'qualification') return false;
  const active = activeNativeReview(run);
  // Older Runs could reach a gate while a replaced original was still
  // remotely unresolved. Its eventual completion settles evidence only;
  // the caller must revalidate before using the retained current result.
  if (run.state === 'WAITING_DEPENDENCY' && settledHistoricalReviewGate(run)) return true;
  return run.state === 'WAITING_DEPENDENCY' && run.interruptedFrom === 'REVIEWING' && active !== undefined &&
    (['pending', 'terminal_unknown'].includes(active.status) && active.observations < NATIVE_REVIEW_OBSERVATIONS || verdictEligible(active) || active.status === 'incomplete' && active.failure === 'transport_failure') &&
    Date.parse(active.nextObservationAt) <= Date.parse(now);
}

export function parkNativeReview(run: Run, kind: 'binding' | 'request' | 'lead' | 'qualification', reason: string, now: string): Run {
  const waiting = applyTransition(run, { type: 'wait_dependency', reason }, now);
  return { ...waiting, nativeReview: { ...run.nativeReview, requests: run.nativeReview?.requests ?? [], wait: { kind, nextAttemptAt: new Date(Date.parse(now) + NATIVE_REVIEW_BACKOFF_MS).toISOString() } } };
}

function usableHost(host: NativeReviewerHost | undefined): host is NativeReviewerHost {
  try {
    const b = host?.binding;
    return !!host && Object.keys(host).every((key) => ['binding', 'receipts', 'source', 'submit', 'observe', 'authenticate', 'replacementDisposition'].includes(key)) && !!b && Object.keys(b).sort().join(',') === 'allowTransportReplacement,authorActorIds,bindingId,contractRevision,model,policyRevision,scope,supportedEfforts' &&
      [b.bindingId, b.contractRevision, b.policyRevision, b.scope, b.model].every(text) && Array.isArray(b.supportedEfforts) && b.supportedEfforts.length > 0 && b.supportedEfforts.length <= 3 && new Set(b.supportedEfforts).size === b.supportedEfforts.length && b.supportedEfforts.every((e) => ['Medium', 'High', 'Extra High'].includes(e)) &&
      b.supportedEfforts.includes('Extra High') &&
      Array.isArray(b.authorActorIds) && b.authorActorIds.length > 0 && b.authorActorIds.every(text) && typeof b.allowTransportReplacement === 'boolean' &&
      (host.observe === undefined || typeof host.observe === 'function') && (host.replacementDisposition === undefined || typeof host.replacementDisposition === 'function') &&
      host.receipts instanceof JsonFileOracleReceiptStore && typeof host.receipts.recordAuthenticatedCompletion === 'function' && typeof host.receipts?.recordNative === 'function' && typeof host.receipts.readNative === 'function' && typeof host.source === 'function' && typeof host.submit === 'function' && typeof host.authenticate === 'function';
  } catch { return false; }
}

function validRecoveryConfiguration(run: Run, c: import('../dispatch/config.js').DispatchConfiguration): boolean {
  return !!c && Object.keys(c).sort().join(',') === 'controlIssue,leaseDurationMs,owner,queueCommentId,repo,revision' && text(c.revision) && typeof c.owner === 'string' && c.owner.toLowerCase() === run.target.owner.toLowerCase() && typeof c.repo === 'string' && c.repo.toLowerCase() === run.target.repo.toLowerCase() && Number.isSafeInteger(c.controlIssue) && c.controlIssue > 0 && Number.isSafeInteger(c.queueCommentId) && c.queueCommentId > 0 && c.leaseDurationMs === 60_000;
}
export function issuedReviewRecoveryConfiguration(run: Run): import('../dispatch/config.js').DispatchConfiguration {
  const c = run.nativeReview?.recoveryConfiguration;
  if (!c || !nativeReviewCoherent(run) || !unresolvedNativeReview(run) || !validRecoveryConfiguration(run,c)) throw new Error('Issued review recovery lacks its immutable dispatch control location.');
  return structuredClone(c);
}
/** Finite service reads end in explicit attention. Cached evidence can still be
 * reconciled by an explicit observer, never by periodic attention reentry. */
export function nativeReviewWaitKind(run: Run): 'request' | 'qualification' {
  const active = activeNativeReview(run);
  if (active?.status === 'incomplete' && active.failure !== 'transport_failure') return 'qualification';
  const unknown = run.nativeReview?.requests.filter(r => r.submissionPossible && !hasAuthenticatedCompletion(r.identity,r.terminalDigest,r.completionProof,'review')) ?? [];
  if (unknown.length && unknown.every(r => r.observations >= NATIVE_REVIEW_OBSERVATIONS)) return 'qualification';
  if (active?.status === 'incomplete' && (run.nativeReview?.requests.filter(r => sameCandidate(r.identity,active.identity)).length ?? 0) >= 2 && unknown.every(r => r.identity.requestId === active.identity.requestId || r.observations >= NATIVE_REVIEW_OBSERVATIONS)) return 'qualification';
  return 'request';
}

/** No environment lookup, fixture flag, implicit model, or production service API. */
export function resolveNativeReviewer(host?: NativeReviewerHost): ReviewerAdapter {
  const observe: NonNullable<NativeReviewBoundary['observe']> = async context => {
    let run = context.run;
    const result = (reason: string) => ({run,reason});
    if (!usableHost(host) || !context.owner || !context.assertLiveClaim) return result('Native review observation unavailable: qualified host/current owner/claim missing.');
    await context.assertLiveClaim(); context.assertCurrent();
    const owner=context.owner;
    const eligible = () => (run.nativeReview?.requests ?? []).filter(r => r.submissionPossible && !hasAuthenticatedCompletion(r.identity,r.terminalDigest,r.completionProof,'review') && r.identity.runId === run.id && r.identity.claimId === run.dispatchClaimId && r.identity.missionId === owner.missionId && r.identity.laneId === owner.laneId && owner.generation >= r.identity.ownerGeneration);
    const save = (next: Run) => { context.assertCurrent(); if(context.store.updateIfUnchanged?.(run,next)!==true)return false;run=next;return true; };
    const complete = async (request: NativeReviewRequestState, e: Extract<NativeOracleEvidence,{kind:'terminal'}>) => {
      if (!validNativeEvidence(e) || !same(e.identity,request.identity) || host.binding.authorActorIds.includes(e.authentication.actorId) || !host.authenticate(frozen(e))) return false;
      await context.assertLiveClaim!(); context.assertCurrent();
      host.receipts.recordNative!(e);
      const completionProof=host.receipts.recordAuthenticatedCompletion!('review',e,x=>x.kind==='terminal'&&host.authenticate(x as Extract<NativeOracleEvidence,{kind:'terminal'}>)&&!host.binding.authorActorIds.includes(x.authentication.actorId));
      const refused=request.status==='incomplete' && request.failure!=='transport_failure';
      const inactive=['retired','replaced'].includes(request.status) || refused;
      const attention=request.identity.requestId===run.nativeReview?.activeRequestId && refused ? {wait:{kind:'qualification' as const,nextAttemptAt:new Date(Date.parse(context.now())+NATIVE_REVIEW_BACKOFF_MS).toISOString()}} : {};
      return save({...run,nativeReview:{...run.nativeReview!,...attention,requests:run.nativeReview!.requests.map(r=>r.identity.requestId===request.identity.requestId?{...r,terminalDigest:oracleDigest(e),completionProof,...(inactive?{}:{status:'qualified_complete' as const})}:r)}});
    };
    let reconciled=false;
    for(const request of eligible()) {
      const cached=host.receipts.readNative!(`${request.identity.requestId}.terminal`);
      if(cached?.kind==='terminal') reconciled = await complete(request,cached) || reconciled;
    }
    if(reconciled)return result('Exact cached Oracle terminals reconciled as evidence only; no verdict adopted or service read.');
    if(context.cachedOnly)return result('Explicit Oracle attention recovery found no exact cached completion; no service read permitted.');
    const request=eligible().filter(r=>!semanticNativeFailure(r.failure) && (r.status!=='incomplete' || r.failure==='transport_failure') && r.identity.bindingId===host.binding.bindingId&&r.identity.requestedModel===host.binding.model&&r.observations<NATIVE_REVIEW_OBSERVATIONS&&Date.parse(r.nextObservationAt)<=Date.parse(context.now())).sort((a,b)=>a.observations-b.observations||Date.parse(a.nextObservationAt)-Date.parse(b.nextObservationAt))[0];
    if(!request||!host.observe)return result('Native review finite observation unavailable or not due; uncertainty retained.');
    let observing={...request,observations:request.observations+1,nextObservationAt:new Date(Date.parse(context.now())+NATIVE_REVIEW_BACKOFF_MS).toISOString()};
    if(!save({...run,nativeReview:{...run.nativeReview!,requests:run.nativeReview!.requests.map(r=>r.identity.requestId===request.identity.requestId?observing:r)}}))return result('Native review observation CAS lost.');
    let response:NativeReviewObservation;
    try{response=await host.observe(frozen(request.identity),request.conversationUrl);}catch{response={outcome:'terminal_unknown'};}
    await context.assertLiveClaim();context.assertCurrent();
    if(response.conversationUrl!==undefined&&(!validUrl(response.conversationUrl)||request.conversationUrl!==undefined&&request.conversationUrl!==response.conversationUrl))return result('Native review observation URL conflicts with original evidence.');
    if(response.conversationUrl!==undefined) {
      observing={...observing,conversationUrl:response.conversationUrl};
      if(!save({...run,nativeReview:{...run.nativeReview!,requests:run.nativeReview!.requests.map(r=>r.identity.requestId===request.identity.requestId?observing:r)}}))return result('Native review observation URL CAS lost.');
    }
    if(response.outcome==='complete') {
      if(await complete(observing,response.evidence))return result('Authenticated Oracle terminal reconciled as evidence only; fresh current qualification still required.');
      return result('Foreign or unauthenticated Oracle terminal cannot clear uncertainty.');
    }
    const retained=!['pending','terminal_unknown'].includes(request.status);
    const failure=retainedNativeFailure(request.failure,response.outcome==='incomplete'?response.reason:undefined);
    const updated={...observing,...(retained?{}:{status:response.outcome==='incomplete'?'incomplete' as const:response.outcome}),...(failure===undefined?{}:{failure})};
    save({...run,nativeReview:{...run.nativeReview!,requests:run.nativeReview!.requests.map(r=>r.identity.requestId===request.identity.requestId?updated:r)}});
    return result('Original Oracle request observed; finite count/backoff and inactive eligibility retained.');
  };
  const boundary: NativeReviewBoundary = {
    observe,
    available: () => usableHost(host),
    canReconcileHistorical: run => usableHost(host) && run.nativeReview?.wait?.kind!=='qualification' && (run.state==='FINAL_GATE'||run.state==='MERGE_READY') && historicalReviewUncertainty(run),
    canObserve: (run,now) => usableHost(host) && typeof host.observe === 'function' && nativeReviewObservationDue(run,now,host.binding),
    canRecover: (run,now) => {
      const active=activeNativeReview(run);
      return usableHost(host) && run.state==='WAITING_DEPENDENCY' && run.interruptedFrom==='REVIEWING' && typeof host.replacementDisposition==='function' && host.binding.allowTransportReplacement &&
        run.nativeReview?.wait?.kind!=='qualification' && !nativeLeadStopped(run) && !!active && active.submissionPossible &&
        !hasAuthenticatedCompletion(active.identity,active.terminalDigest,active.completionProof,'review') && !semanticNativeFailure(active.failure) &&
        (active.failure==='transport_failure' || active.status==='terminal_unknown') && active.identity.bindingId===host.binding.bindingId &&
        active.identity.policyRevision===host.binding.policyRevision && active.identity.requestedModel===host.binding.model &&
        run.nativeReview!.requests.filter(r=>sameCandidate(r.identity,active.identity)).length<2 && run.nativeReview!.requests.length<20 && Date.parse(active.nextObservationAt)<=Date.parse(now);
    },
    async advance(context) {
      let run = context.run;
      const wait = (reason: string) => ({ outcome: 'wait' as const, run, reason });
      const stale = () => ({ outcome: 'superseded' as const, run: context.store.read(run.id) ?? run, reason: 'Native review Run or admission changed; preserving durable evidence.' });
      const save = (next: Run): boolean => {
        context.assertCurrent();
        if (context.store.updateIfUnchanged?.(run, next) !== true) return false;
        run = next;
        return true;
      };
      if (!usableHost(host)) return wait('Native review unavailable: no accepted trusted host reviewer binding.');
      if (context.assertLiveClaim === undefined) return wait('Native review unavailable: no current retained-claim authority fence.');
      await context.assertLiveClaim();
      const owner = context.owner;
      if (run.nativeReview?.requests.some(r=>r.identity.requestId!==run.nativeReview?.activeRequestId&&r.submissionPossible&&!hasAuthenticatedCompletion(r.identity,r.terminalDigest,r.completionProof,'review'))) {
        const observed=await observe({...context,run});run=observed.run;return wait(observed.reason);
      }
      const refused=activeNativeReview(run);
      if(refused?.failure!==undefined && refused.failure!=='transport_failure')return wait('Native review refusal/incomplete evidence is not current verdict or replacement authority.');
      const snapshot = context.snapshot;
      if (!owner || !run.dispatchClaimId || !run.repairTaskShapeAuthority || !run.headSha || snapshot.headSha !== run.headSha || snapshot.pullRequest?.state !== 'open' || snapshot.pullRequest.number !== run.pullRequest?.number ||
        snapshot.pullRequest.headSha !== run.headSha || !SHA.test(snapshot.pullRequest.baseSha ?? '') || snapshot.repository.owner.toLowerCase() !== run.target.owner.toLowerCase() || snapshot.repository.repo.toLowerCase() !== run.target.repo.toLowerCase()) return wait('Native review unavailable: exact Run/claim/mission/contract/PR candidate authority is missing.');
      if (run.implementationAuthority && !originalImplementationMatches(run, snapshot)) return wait('Original admitted implementation scope/contract changed before independent review.');
      context.assertCurrent();
      const baseSha = snapshot.pullRequest.baseSha!;
      let manifest;
      try { manifest = frozen(host.source(baseSha, run.headSha)); } catch { return wait('Native review unavailable: complete immutable source/diff evidence cannot be read.'); }
      if (!validNativeSourceManifest(manifest) || manifest.baseSha !== baseSha || manifest.headSha !== run.headSha) return wait('Native review unavailable: source/diff evidence is incomplete or differently bound.');
      const policy = classifyReviewRisk({ target: run.target, headSha: run.headSha, baseSha, changedPaths: manifest.files.map((f) => f.path), manifestComplete: true,
        deterministicValidation: { passed: run.validationResult?.status === 'passed', headSha: run.validationResult?.headSha, baseSha }, riskSignals: [], riskEvidenceComplete: true });
      if (policy.outcome !== 'review') return wait('Native review unavailable: exact candidate risk/validation evidence is incomplete.');
      // The current native campaign is unpromoted: risk classification cannot
      // lower its independent latest-model / Extra High review floor.
      const floor = 'R5' as const;
      const effort: OracleEffort = 'Extra High';
      if (!host.binding.supportedEfforts.includes(effort)) return wait('Native review unavailable: trusted binding cannot meet the independent review floor.');
      let active = activeNativeReview(run);
      const matches = (i: NativeReviewIdentity) => i.runId === run.id && i.claimId === run.dispatchClaimId && i.missionId === owner.missionId && i.laneId === owner.laneId && owner.generation >= i.ownerGeneration &&
        i.repository === `${run.target.owner}/${run.target.repo}`.toLowerCase() && i.targetKey === canonicalReviewTarget(run.target)?.key && i.pullRequestNumber === snapshot.pullRequest!.number && i.headSha === run.headSha && i.baseSha === baseSha &&
        i.contractRevision === JSON.stringify([run.repairTaskShapeAuthority!.revision, host.binding.contractRevision]) && i.scope === host.binding.scope && i.policyRevision === host.binding.policyRevision && i.bindingId === host.binding.bindingId &&
        i.requestedModel === host.binding.model && i.requestedEffort === effort && i.floor === floor && i.sourceSha256 === manifest.sourceSha256 && i.diffSha256 === manifest.diffSha256;
      if (active && !matches(active.identity)) {
        const candidateMoved = active.identity.headSha !== run.headSha || active.identity.baseSha !== baseSha || active.identity.sourceSha256 !== manifest.sourceSha256 || active.identity.diffSha256 !== manifest.diffSha256;
        if (candidateMoved) {
          const retired = { ...active, status: 'retired' as const, ...(['incomplete', 'terminal_unknown'].includes(active.status) ? { terminalStatus: active.status as 'incomplete' | 'terminal_unknown' } : {}) };
          if (!save({ ...run, nativeReview: { ...(run.nativeReview?.recoveryConfiguration ? {recoveryConfiguration:run.nativeReview.recoveryConfiguration} : {}), ...(run.nativeReview?.repairLimit===undefined?{}:{repairLimit:run.nativeReview.repairLimit}), requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? retired : r) } })) return stale();
          return wait('Native review original retired from active review after candidate movement; remote cancellation is unknown and its evidence remains retained.');
        }
        return wait('Native review unavailable: active request authority changed; original identity remains fenced.');
      }
      let replacement = false;
      const disposition = active && (active.status==='terminal_unknown' || active.status==='incomplete' && active.failure==='transport_failure') ? host.replacementDisposition?.(frozen(active)) : undefined;
      const irrecoverable = active?.status === 'terminal_unknown' && disposition === 'irrecoverable_transport';
      if(active?.status==='incomplete' && active.failure==='transport_failure' && host.replacementDisposition && disposition!=='irrecoverable_transport')return wait('Native review replacement allowance requires the configured qualified transport disposition.');
      if (active?.status === 'incomplete' && active.failure === 'transport_failure' || irrecoverable) {
        if (!host.binding.allowTransportReplacement || (run.nativeReview?.requests.filter((r) => sameCandidate(r.identity, active!.identity)).length ?? 0) >= 2) return wait('Native review incomplete: durable replacement allowance unavailable or exhausted.');
        replacement = true;
      } else if (active && !['pending', 'terminal_unknown', 'qualified_complete'].includes(active.status)) return wait(`Native review ${active.status}: ${active.failure ?? 'requires attention'}.`);
      if (!active || replacement) {
        context.assertInitiationCurrent?.();
        if ((run.nativeReview?.requests.length ?? 0) >= 20) return wait('Native review request history bound exhausted.');
        const requestId = randomUUID();
        const identity: NativeReviewIdentity = { requestId, correlationId: requestId, runId: run.id, claimId: run.dispatchClaimId, missionId: owner.missionId, laneId: owner.laneId, ownerGeneration: owner.generation,
          phase: 'review', targetKey: canonicalReviewTarget(run.target)!.key, repository: `${run.target.owner}/${run.target.repo}`.toLowerCase(), pullRequestNumber: snapshot.pullRequest.number, baseSha, headSha: run.headSha,
          contractRevision: JSON.stringify([run.repairTaskShapeAuthority.revision, host.binding.contractRevision]), role: 'independent-reviewer', scope: host.binding.scope, policyRevision: host.binding.policyRevision, bindingId: host.binding.bindingId,
          requestedModel: host.binding.model, requestedEffort: effort, floor, sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256 };
        const reserved: NativeReviewRequestState = { identity, status: 'pending', submissionPossible: false, observations: 0, nextObservationAt: context.now() };
        const requests = (run.nativeReview?.requests ?? []).map((r) => replacement && r.identity.requestId === active!.identity.requestId ? { ...r, status: 'replaced' as const, terminalStatus: r.status as 'incomplete' | 'terminal_unknown', ...(irrecoverable ? { retirementReason: 'irrecoverable_transport' as const } : {}), replacedBy: requestId } : r);
        if (!save({ ...run, nativeReview: { ...(run.nativeReview?.recoveryConfiguration ? {recoveryConfiguration:run.nativeReview.recoveryConfiguration} : !run.nativeReview?.requests.length && context.recoveryConfiguration ? {recoveryConfiguration:context.recoveryConfiguration} : {}), ...(run.nativeReview?.repairLimit===undefined?{}:{repairLimit:run.nativeReview.repairLimit}), requests: [...requests, reserved], activeRequestId: requestId } })) return stale();
        active = reserved;
      }
      const requestEvidence: Extract<NativeOracleEvidence, { kind: 'request' }> = frozen({ id: `${active.identity.requestId}.request`, kind: 'request', identity: active.identity, manifest });
      host.receipts.recordNative!(requestEvidence);
      const persistedTerminal = host.receipts.readNative!(`${active.identity.requestId}.terminal`);
      const accept = (evidence: NativeOracleEvidence) => {
        if (!active!.submissionPossible || evidence.kind !== 'terminal' || !validNativeEvidence(evidence) || !same(evidence.identity, active!.identity) || host.binding.authorActorIds.includes(evidence.authentication.actorId) || !host.authenticate(frozen(evidence))) return wait('Native review incomplete: terminal evidence is unauthenticated, self-authored, or differently bound.');
        context.assertCurrent();
        const digest = oracleDigest(evidence);
        const completionProof = host.receipts.recordAuthenticatedCompletion!('review', evidence, e => e.kind === 'terminal' && host.authenticate(e as Extract<NativeOracleEvidence, {kind:'terminal'}>) && !host.binding.authorActorIds.includes(e.authentication.actorId));
        const completed = { ...active!, status: 'qualified_complete' as const, terminalDigest: digest, completionProof };
        const next = { ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? completed : r), accepted: { requestId: active!.identity.requestId, receiptId: evidence.id, digest, identity: active!.identity } } };
        if (!save(next)) return stale();
        return { outcome: 'complete' as const, run, result: evidence.result };
      };
      if (persistedTerminal !== null) return accept(persistedTerminal);
      if (active.status === 'qualified_complete') return wait('Native review incomplete: immutable accepted receipt is missing.');
      let response: NativeReviewObservation;
      if (!active.submissionPossible) {
        const issue = async () => {
          await context.assertInitiation?.();
          await context.assertLiveClaim!();
          context.assertCurrent();
          context.assertInitiationCurrent?.();
          const marked = { ...active!, submissionPossible: true };
          if (!save({ ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? marked : r) } })) return null;
          active = marked;
          await context.assertInitiation?.();
          await context.assertLiveClaim!();
          context.assertCurrent();
          context.assertInitiationCurrent?.();
          if (!save(context.onSubmission(run))) return null;
          await context.assertInitiation?.();
          await context.assertLiveClaim!();
          context.assertCurrent();
          context.assertInitiationCurrent?.();
          if (context.store.updateIfUnchanged?.(run, run) !== true) return null;
          let promise: Promise<NativeReviewObservation>;
          try { promise=host.submit(requestEvidence); } catch { promise=Promise.resolve({outcome:'terminal_unknown'}); }
          return {promise};
        };
        const issued=await (context.withIssueBoundary ? context.withIssueBoundary(issue) : issue());
        if(!issued)return stale();
        try { response=await issued.promise; } catch { response={outcome:'terminal_unknown'}; }
      } else {
        if (active.observations >= NATIVE_REVIEW_OBSERVATIONS || Date.parse(active.nextObservationAt) > Date.parse(context.now())) return wait('Native review pending: bounded observation is parked.');
        if (host.observe === undefined) {
          const unknown = { ...active, status: 'terminal_unknown' as const };
          if (!save({ ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? unknown : r) } })) return stale();
          return wait('Native review terminal unknown: transport cannot observe the original request.');
        }
        const observing = { ...active, observations: active.observations + 1, nextObservationAt: new Date(Date.parse(context.now()) + NATIVE_REVIEW_BACKOFF_MS).toISOString() };
        if (!save({ ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? observing : r) } })) return stale();
        active = observing;
        try { response = await host.observe(frozen(active.identity), active.conversationUrl); } catch { response = { outcome: 'terminal_unknown' }; }
      }
      context.assertCurrent();
      await context.assertLiveClaim();
      context.assertCurrent();
      if (context.store.updateIfUnchanged?.(run, run) !== true) return stale();
      if (response?.conversationUrl !== undefined) {
        if (!validUrl(response.conversationUrl) || active.conversationUrl !== undefined && active.conversationUrl !== response.conversationUrl) return wait('Native review terminal unknown: returned URL contradicts original evidence.');
        const withUrl = { ...active, conversationUrl: response.conversationUrl };
        if (!save({ ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? withUrl : r) } })) return stale();
        active = withUrl;
      }
      if (response?.outcome === 'complete') {
        const e = frozen(response.evidence);
        if (!validNativeEvidence(e) || e.kind !== 'terminal' || !same(e.identity, active.identity) || host.binding.authorActorIds.includes(e.authentication.actorId) || !host.authenticate(e)) response = { outcome: 'incomplete', reason: 'missing_evidence' };
        else { host.receipts.recordNative!(e); return accept(e); }
      }
      const status = response?.outcome === 'incomplete' ? 'incomplete' : response?.outcome === 'pending' ? 'pending' : 'terminal_unknown';
      const updated: NativeReviewRequestState = { ...active, status, nextObservationAt: new Date(Date.parse(context.now()) + NATIVE_REVIEW_BACKOFF_MS).toISOString(), ...(retainedNativeFailure(active.failure,response?.outcome==='incomplete'?response.reason:undefined)===undefined?{}:{failure:retainedNativeFailure(active.failure,response?.outcome==='incomplete'?response.reason:undefined)}) };
      if (!save({ ...run, nativeReview: { ...run.nativeReview!, requests: run.nativeReview!.requests.map((r) => r.identity.requestId === active!.identity.requestId ? updated : r) } })) return stale();
      return wait(`Native review ${status}: original request retained; no blind resend.`);
    },
    validate(context) {
      try {
        if (!usableHost(host) || !nativeReviewCoherent(context.run) || context.run.implementationAuthority !== undefined && !originalImplementationMatches(context.run, context.snapshot)) return false;
        context.assertCurrent();
        const run = context.run;
        const accepted = run.nativeReview?.accepted;
        const active = activeNativeReview(run);
        const owner = context.owner;
        if (!accepted || !active || !hasAuthenticatedCompletion(active.identity, active.terminalDigest, active.completionProof, 'review') || !owner || !verdictEligible(active) || active.identity.requestId !== accepted.requestId || active.identity.claimId !== run.dispatchClaimId || active.identity.missionId !== owner.missionId || active.identity.laneId !== owner.laneId || owner.generation < active.identity.ownerGeneration ||
          active.identity.headSha !== run.headSha || active.identity.headSha !== context.snapshot.headSha || active.identity.baseSha !== context.snapshot.pullRequest?.baseSha || active.identity.pullRequestNumber !== context.snapshot.pullRequest?.number ||
          active.identity.contractRevision !== JSON.stringify([run.repairTaskShapeAuthority?.revision, host.binding.contractRevision]) || active.identity.policyRevision !== host.binding.policyRevision || active.identity.scope !== host.binding.scope || active.identity.bindingId !== host.binding.bindingId || active.identity.requestedModel !== host.binding.model || !host.binding.supportedEfforts.includes(active.identity.requestedEffort)) return false;
        const request = host.receipts.readNative!(`${accepted.requestId}.request`);
        const terminal = host.receipts.readNative!(accepted.receiptId);
        if (!request || request.kind !== 'request' || !validNativeEvidence(request) || !same(request.identity, active.identity) || !terminal || terminal.kind !== 'terminal' || !validNativeEvidence(terminal) ||
          oracleDigest(terminal) !== accepted.digest || !same(terminal.identity, active.identity) || !same(durableReview(run.reviewResult), durableReview(terminal.result)) || host.binding.authorActorIds.includes(terminal.authentication.actorId) || !host.authenticate(frozen(terminal))) return false;
        const current = host.source(active.identity.baseSha, active.identity.headSha);
        context.assertCurrent();
        return validNativeSourceManifest(current) && current.sourceSha256 === active.identity.sourceSha256 && current.diffSha256 === active.identity.diffSha256;
      } catch { return false; }
    },
  };
  return { kind: 'reviewer', native: boundary, async review() { throw new Error('Native review requires Run-owned admission and persistence.'); } };
}
