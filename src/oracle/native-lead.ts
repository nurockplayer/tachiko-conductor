import { JsonFileOracleReceiptStore } from './receipt-store.js';
import { authenticatedCompletionEvidence, hasAuthenticatedCompletion, validCompletionProof } from './completion-proof.js';
import { originalImplementationMatches } from '../domain/implementation-authority.js';
import { activeRepairAdmission } from '../domain/repair-admission.js';
import { randomUUID } from 'node:crypto';
import type { NativeReviewContext } from '../adapters/reviewer.js';
import type { GitHubLiveSnapshot } from '../adapters/github.js';
import type { Run } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import { assertExecutionSupportedByProvider, type ResolvedExecutionConfiguration } from '../execution-profiles.js';
import { isValidationResultCoherent } from '../domain/validation.js';
import { canonicalReviewTarget } from '../reviewers/risk-policy.js';
import type { NativeOracleEvidence, NativeSourceManifest, OracleReceiptStore } from './types.js';
import { validNativeEvidence } from './native-reviewer.js';
import { oracleDigest, validNativeSourceManifest } from './source-evidence.js';
import { acceptedScopeFromHandoff } from '../agents/implementation-packet.js';
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9._-]{1,260}$/;
const SHA = /^[0-9a-f]{40}$/;
const text = (v: unknown, limit = 500): v is string => typeof v === 'string' && v.trim().length > 0 && Buffer.byteLength(v) <= limit;
const keys = (v: object, expected: string) => Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const same = (a: unknown, b: unknown) => a === b || a !== undefined && b !== undefined && oracleDigest(a) === oracleDigest(b);
export const LEAD_OBSERVATIONS = 3;
export const LEAD_BACKOFF_MS = 30000;
export const LEAD_STOP_REASONS = ['disputed_blocking_finding', 'scope_or_authority_change', 'complex_or_decision_required', 'qualified_execution_unavailable', 'cannot_safely_repair'] as const;
export interface LeadOrigin {
  readonly requestId: string;
  readonly receiptId: string;
  readonly digest: string;
}
export interface NativeLeadIdentity {
  readonly requestId: string;
  readonly correlationId: string;
  readonly incarnation: string;
  readonly runId: string;
  readonly claimId: string;
  readonly missionId: string;
  readonly laneId: string;
  readonly ownerGeneration: number;
  readonly phase: 'lead-disposition';
  readonly role: 'bounded-lead';
  readonly repository: string;
  readonly targetKey: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly origin: LeadOrigin;
  readonly authoritySha256: string;
  readonly sourceSha256: string;
  readonly diffSha256: string;
  readonly packetSha256: string;
  readonly blockingFindingIds: readonly string[];
  readonly repairOrdinal: number;
  readonly repairLimit: number;
  readonly bindingId: string;
  readonly policyRevision: string;
  readonly requestedModel: string;
  readonly requestedEffort: 'High';
}
export type NativeLeadDisposition = {
  readonly outcome: 'repair';
  readonly origin: LeadOrigin;
  readonly authoritySha256: string;
  readonly acceptedFindingIds: readonly string[];
  readonly instructions: string;
} | {
  readonly outcome: 'stop';
  readonly reason: typeof LEAD_STOP_REASONS[number];
  readonly evidence: string;
};
export interface NativeLeadAuthority {
  readonly implementationAuthoritySha256: string;
  readonly target: Run['target'];
  readonly pullRequest: NonNullable<Run['pullRequest']>;
  readonly bootstrap: NonNullable<Run['bootstrap']>;
  readonly taskShape: NonNullable<Run['repairTaskShapeAuthority']>;
  readonly originalExecution: ResolvedExecutionConfiguration;
  readonly execution: ResolvedExecutionConfiguration;
  readonly validation: NonNullable<Run['validationResult']>;
  readonly reviewIdentity: import('./types.js').NativeReviewIdentity;
  readonly scope: NonNullable<ReturnType<typeof acceptedScopeFromHandoff>>;
  readonly issue: GitHubLiveSnapshot['issue'];
  readonly maxAttempts: number;
}
export interface NativeLeadPacket {
  readonly origin: Extract<NativeOracleEvidence, {
    kind: 'terminal';
  }>;
  readonly manifest: NativeSourceManifest;
  readonly authority: NativeLeadAuthority;
  readonly blockingFindingIds: readonly string[];
  readonly remainingRepairs: number;
}
export type NativeLeadEvidence = {
  readonly id: string;
  readonly kind: 'request';
  readonly identity: NativeLeadIdentity;
  readonly packet: NativeLeadPacket;
} | {
  readonly id: string;
  readonly kind: 'completion';
  readonly identity: NativeLeadIdentity;
  readonly terminalSha256: string;
  readonly reason: 'rejected_disposition';
  readonly authentication: {
    readonly actorId: string;
    readonly model: string;
    readonly effort: 'High';
    readonly role: 'bounded-lead';
    readonly readOnly: true;
    readonly transportReceipt: string;
  };
} | {
  readonly id: string;
  readonly kind: 'terminal';
  readonly identity: NativeLeadIdentity;
  readonly disposition: NativeLeadDisposition;
  readonly authentication: {
    readonly actorId: string;
    readonly model: string;
    readonly effort: 'High';
    readonly role: 'bounded-lead';
    readonly readOnly: true;
    readonly transportReceipt: string;
  };
};
export interface NativeLeadRequest {
  readonly identity: NativeLeadIdentity;
  readonly status: 'pending' | 'qualified_complete' | 'incomplete' | 'terminal_unknown' | 'retired' | 'replaced';
  readonly submissionPossible: boolean;
  readonly observations: number;
  readonly nextObservationAt: string;
  readonly conversationUrl?: string;
  readonly failure?: 'transport_failure' | 'safety_refusal' | 'missing_evidence';
  readonly replacedBy?: string;
  readonly replacementReason?: 'irrecoverable_transport';
  readonly terminalDigest?: string;
  readonly completionProof?: import('./completion-proof.js').NativeCompletionProof;
}
export interface NativeLeadAcceptance {
  readonly requestId: string;
  readonly receiptId: string;
  readonly digest: string;
  readonly identity: NativeLeadIdentity;
  readonly disposition: NativeLeadDisposition;
}
/** Nonsecret proof captured by the canonical owner transaction BEFORE overwriting its predecessor receipt. */
export interface LeadOwnerSuccession {
  readonly missionId: string;
  readonly laneId: string;
  readonly claimId: string;
  readonly workspace: string;
  readonly fromGeneration: number;
  readonly toGeneration: number;
  readonly predecessorSha256: string;
  readonly status: 'prepared' | 'confirmed';
  readonly predecessorGeneration: number;
  readonly predecessorPhase: string;
  readonly predecessorStatus: 'parked' | 'released';
}
export interface NativeLeadLedger {
  readonly recoveryConfiguration?: import('../dispatch/config.js').DispatchConfiguration;
  readonly requests: readonly NativeLeadRequest[];
  readonly acceptances: readonly NativeLeadAcceptance[];
  readonly ownerSuccessions: readonly LeadOwnerSuccession[];
  readonly stoppedRecoveries?: readonly {
    readonly fromGeneration: number;
    readonly releasedGeneration: number;
    readonly missionId: string;
    readonly workspace: string;
    readonly receiptSha256: string;
  }[];
  readonly activeRequestId?: string;
  readonly wait?: {
    readonly kind: 'binding' | 'request' | 'qualification' | 'stop';
    readonly nextAttemptAt: string;
  };
}
export interface LeadRepairReference extends NativeLeadAcceptance {
  readonly originEvidence: Extract<NativeOracleEvidence, {
    kind: 'terminal';
  }>;
  readonly consumptionGeneration: number;
  readonly implementationAuthoritySha256: string;
  readonly instructionsSha256: string;
}
export type NativeLeadObservation = {
  readonly outcome: 'pending' | 'terminal_unknown';
  readonly conversationUrl?: string;
} | {
  readonly outcome: 'incomplete';
  readonly reason: 'transport_failure' | 'safety_refusal' | 'missing_evidence';
  readonly conversationUrl?: string;
} | {
  readonly outcome: 'complete';
  readonly evidence: Extract<NativeLeadEvidence, {
    kind: 'terminal';
  }>;
  readonly conversationUrl?: string;
};
export interface NativeLeadHost {
  readonly binding: {
    readonly bindingId: string;
    readonly policyRevision: string;
    readonly model: string;
    readonly effort: 'High';
    readonly readOnly: true;
    readonly qualified: true;
    readonly allowTransportReplacement: boolean;
  };
  readonly receipts: OracleReceiptStore;
  readonly source: (baseSha: string, headSha: string) => NativeSourceManifest;
  readonly submit: (request: Extract<NativeLeadEvidence, {
    kind: 'request';
  }>) => Promise<NativeLeadObservation>;
  readonly observe?: (identity: NativeLeadIdentity, conversationUrl?: string) => Promise<NativeLeadObservation>;
  readonly authenticate: (evidence: Extract<NativeLeadEvidence, {
    kind: 'terminal' | 'completion';
  }>) => boolean;
  readonly replacementDisposition?: (request: NativeLeadRequest) => 'irrecoverable_transport' | 'unavailable';
}
export const emptyLeadLedger = (): NativeLeadLedger => ({ requests: [], acceptances: [], ownerSuccessions: [] });
export const blockingFindingIds = (origin: Extract<NativeOracleEvidence, {
  kind: 'terminal';
}>): string[] => origin.result.findings.flatMap((f, i) => f.severity === 'blocking' ? [`${oracleDigest(origin)}:${i}`] : []);
function validOrigin(o: LeadOrigin): boolean { return !!o && keys(o, 'requestId,receiptId,digest') && ID.test(o.requestId) && o.receiptId === `${o.requestId}.terminal` && DIGEST.test(o.digest); }
export function validLeadIdentity(i: NativeLeadIdentity): boolean {
  return !!i && keys(i, 'requestId,correlationId,incarnation,runId,claimId,missionId,laneId,ownerGeneration,phase,role,repository,targetKey,pullRequestNumber,baseSha,headSha,origin,authoritySha256,sourceSha256,diffSha256,packetSha256,blockingFindingIds,repairOrdinal,repairLimit,bindingId,policyRevision,requestedModel,requestedEffort') &&
    ID.test(i.requestId) && i.correlationId === i.requestId && i.phase === 'lead-disposition' && i.role === 'bounded-lead' && i.requestedEffort === 'High' &&
    [i.runId, i.claimId, i.missionId, i.repository, i.targetKey, i.bindingId, i.policyRevision, i.requestedModel].every(v => text(v)) && i.laneId === `run:${i.runId}` &&
    Number.isSafeInteger(i.ownerGeneration) && i.ownerGeneration > 0 && Number.isSafeInteger(i.pullRequestNumber) && i.pullRequestNumber > 0 && Number.isSafeInteger(i.repairOrdinal) && i.repairOrdinal > 0 && Number.isSafeInteger(i.repairLimit) && i.repairLimit > 0 && i.repairOrdinal <= i.repairLimit &&
    Array.isArray(i.blockingFindingIds) && i.blockingFindingIds.length > 0 && i.blockingFindingIds.length <= 20 && new Set(i.blockingFindingIds).size === i.blockingFindingIds.length && i.blockingFindingIds.every(id => id.startsWith(`${i.origin.digest}:`) && /^[0-9a-f]{64}:\d{1,2}$/.test(id)) && SHA.test(i.baseSha) && SHA.test(i.headSha) && validOrigin(i.origin) && [i.incarnation, i.authoritySha256, i.sourceSha256, i.diffSha256, i.packetSha256].every(d => DIGEST.test(d));
}
export function validLeadDisposition(d: NativeLeadDisposition): boolean {
  if (!d)
    return false;
  if (d.outcome === 'stop')
    return keys(d, 'outcome,reason,evidence') && LEAD_STOP_REASONS.includes(d.reason) && text(d.evidence, 2000);
  return d.outcome === 'repair' && keys(d, 'outcome,origin,authoritySha256,acceptedFindingIds,instructions') && validOrigin(d.origin) && DIGEST.test(d.authoritySha256) && text(d.instructions, 4000) &&
    Array.isArray(d.acceptedFindingIds) && d.acceptedFindingIds.length > 0 && d.acceptedFindingIds.length <= 20 && new Set(d.acceptedFindingIds).size === d.acceptedFindingIds.length && d.acceptedFindingIds.every(id => /^[0-9a-f]{64}:\d{1,2}$/.test(id));
}
export function validLeadEvidence(e: NativeLeadEvidence): boolean {
  try {
    if (!e || !validLeadIdentity(e.identity))
      return false;
    const i = e.identity;
    if (e.kind === 'request') {
      const p = e.packet;
      return keys(e, 'id,kind,identity,packet') && e.id === `${i.requestId}.request` && !!p && keys(p, 'origin,manifest,authority,blockingFindingIds,remainingRepairs') &&
        p.origin.kind === 'terminal' && validNativeEvidence(p.origin) && p.origin.result.verdict === 'request_changes' && oracleDigest(p.origin) === i.origin.digest && p.origin.id === i.origin.receiptId && p.origin.identity.requestId === i.origin.requestId && p.origin.identity.runId === i.runId && p.origin.identity.claimId === i.claimId && p.origin.identity.missionId === i.missionId && p.origin.identity.repository === i.repository && p.origin.identity.headSha === i.headSha && p.origin.identity.baseSha === i.baseSha && p.origin.identity.pullRequestNumber === i.pullRequestNumber &&
        validNativeSourceManifest(p.manifest) && p.manifest.baseSha === i.baseSha && p.manifest.headSha === i.headSha && p.manifest.sourceSha256 === i.sourceSha256 && p.manifest.diffSha256 === i.diffSha256 &&
        validLeadAuthority(p.authority, i) && same(p.authority.reviewIdentity, p.origin.identity) && oracleDigest(p.authority) === i.authoritySha256 && oracleDigest(p) === i.packetSha256 && same(p.blockingFindingIds, blockingFindingIds(p.origin)) && same(p.blockingFindingIds, i.blockingFindingIds) && Number.isSafeInteger(p.remainingRepairs) && p.remainingRepairs === i.repairLimit - i.repairOrdinal + 1 && Buffer.byteLength(JSON.stringify(p)) <= 2 * 1024 * 1024;
    }
    if (e.kind === 'completion')
      return keys(e, 'id,kind,identity,terminalSha256,reason,authentication') && e.id === `${i.requestId}.completion` && DIGEST.test(e.terminalSha256) && e.reason === 'rejected_disposition' && validLeadAuthentication(e.authentication, i);
    const a = e.authentication;
    const d = e.disposition;
    return e.kind === 'terminal' && keys(e, 'id,kind,identity,disposition,authentication') && e.id === `${i.requestId}.terminal` && validLeadDisposition(d) &&
      (d.outcome === 'stop' || same(d.origin, i.origin) && d.authoritySha256 === i.authoritySha256 && same([...d.acceptedFindingIds].sort(), [...i.blockingFindingIds].sort())) && validLeadAuthentication(a, i);
  }
  catch {
    return false;
  }
}
function validLeadAuthority(a: NativeLeadAuthority, i: NativeLeadIdentity): boolean {
  try {
    if (!a || !keys(a, 'implementationAuthoritySha256,target,pullRequest,bootstrap,taskShape,originalExecution,execution,validation,reviewIdentity,scope,issue,maxAttempts') || !DIGEST.test(a.implementationAuthoritySha256) || canonicalReviewTarget(a.target)?.key !== i.targetKey || a.target.kind !== 'issue' || a.target.owner.toLowerCase() + '/' + a.target.repo.toLowerCase() !== i.repository || a.pullRequest?.number !== i.pullRequestNumber || a.pullRequest.headSha !== i.headSha || !a.bootstrap || a.bootstrap.bootstrapKind !== 'standalone-isolated' || a.bootstrap.owner.toLowerCase() + '/' + a.bootstrap.repo.toLowerCase() !== i.repository || a.bootstrap.issueNumber !== a.target.issueNumber || a.bootstrap.baseSha !== i.baseSha || !text(a.bootstrap.workspacePath, 4096) || !text(a.bootstrap.branch, 1024) || !a.taskShape || !keys(a.taskShape, 'revision,shape') || a.taskShape.shape !== 'bounded' || !text(a.taskShape.revision) || !same(a.originalExecution, a.execution) || a.execution.executor !== 'luna-isolated' || a.execution.profile !== 'routine' || !isValidationResultCoherent(a.validation) || a.validation.status !== 'passed' || a.validation.headSha !== i.headSha || a.validation.hosted.pullRequestNumber !== i.pullRequestNumber || (!a.reviewIdentity || a.reviewIdentity.requestId !== i.origin.requestId || a.reviewIdentity.headSha !== i.headSha || a.reviewIdentity.baseSha !== i.baseSha) || a.maxAttempts !== i.repairLimit)
      return false;
    assertExecutionSupportedByProvider(a.execution);
    const scope = a.scope, issue = a.issue;
    return !!scope && keys(scope, 'sourceId,sourceScope,sourceUpdatedAt,freshness,text') && text(scope.sourceId) && ['issue', 'pull_request'].includes(scope.sourceScope) && text(scope.sourceUpdatedAt) && scope.freshness === 'current' && text(scope.text, 32768) && !!issue && keys(issue, 'id,number,title,body,state,url,createdAt,updatedAt') && text(issue.id) && issue.number === a.target.issueNumber && text(issue.title, 1024) && text(issue.body, 32768) && issue.state === 'open' && typeof issue.url === 'string' && text(issue.createdAt) && text(issue.updatedAt);
  }
  catch {
    return false;
  }
}
function validLeadAuthentication(a: Extract<NativeLeadEvidence, {
  kind: 'terminal';
}>['authentication'], i: NativeLeadIdentity): boolean { return !!a && keys(a, 'actorId,model,effort,role,readOnly,transportReceipt') && text(a.actorId) && text(a.transportReceipt) && a.role === 'bounded-lead' && a.readOnly === true && a.model === i.requestedModel && a.effort === i.requestedEffort; }
const validUrl = (s: string) => {
  try {
    const u = new URL(s);
    return s.length <= 2000 && u.protocol === 'https:' && !u.username && !u.password;
  }
  catch {
    return false;
  }
};
export const activeNativeLead = (run: Run) => run.nativeLead?.requests.find(r => r.identity.requestId === run.nativeLead?.activeRequestId);
export const acceptedNativeLead = (run: Run) => run.nativeLead?.acceptances.find(a => a.requestId === run.nativeLead?.activeRequestId);
export const unresolvedNativeLead = (run: Run) => run.nativeLead?.requests.some(r => r.submissionPossible && !hasAuthenticatedCompletion(r.identity, r.terminalDigest, r.completionProof, 'lead')) === true;
export const nativeLeadStopped = (run: Run) => acceptedNativeLead(run)?.disposition.outcome === 'stop' || run.history.some(h => h.nativeLeadStop !== undefined);
export function leadOwnerProved(run: Run, identity: NativeLeadIdentity, owner: NativeReviewContext['owner']): boolean {
  if (!owner || owner.missionId !== identity.missionId || owner.laneId !== identity.laneId)
    return false;
  let generation = identity.ownerGeneration;
  if (generation === owner.generation)
    return true;
  for (const s of run.nativeLead?.ownerSuccessions ?? [])
    if (s.status === 'confirmed' && s.fromGeneration === generation && s.missionId === owner.missionId && s.laneId === owner.laneId && s.claimId === run.dispatchClaimId && s.workspace === run.bootstrap?.workspacePath) {
      generation = s.toGeneration;
      if (generation === owner.generation)
        return true;
    }
  return generation === owner.generation;
}
export function nativeLeadReentry(run: Run, now: string): boolean {
  if (run.state !== 'WAITING_DEPENDENCY' || run.interruptedFrom !== 'CHANGES_REQUESTED')
    return false;
  const l = run.nativeLead;
  if (!l)
    return run.nativeReview?.wait?.kind === 'lead' && Date.parse(run.nativeReview.wait.nextAttemptAt) <= Date.parse(now);
  if (l.requests.some(r => r.identity.requestId !== l.activeRequestId && r.submissionPossible && !r.terminalDigest && r.observations < LEAD_OBSERVATIONS && Date.parse(r.nextObservationAt) <= Date.parse(now)))
    return true;
  if (l.wait?.kind === 'stop' || l.wait?.kind === 'qualification' || l.wait && Date.parse(l.wait.nextAttemptAt) > Date.parse(now))
    return false;
  const active = activeNativeLead(run);
  return !active || active.status === 'qualified_complete' || active.status === 'incomplete' && active.failure === 'transport_failure' || active.observations < LEAD_OBSERVATIONS && Date.parse(active.nextObservationAt) <= Date.parse(now);
}
export function nativeLeadCoherent(run: Run, inspectOnly = false): boolean {
  try {
    const l = run.nativeLead;
    if (!l)
      return !(run.repairAdmissions ?? []).some(a => a.leadDisposition !== undefined) && !run.history.some(h => h.nativeLeadStop !== undefined);
    if (!keys(l, ['requests', 'acceptances', 'ownerSuccessions', ...(Object.hasOwn(l, 'activeRequestId') ? ['activeRequestId'] : []), ...(Object.hasOwn(l, 'wait') ? ['wait'] : []), ...(Object.hasOwn(l, 'stoppedRecoveries') ? ['stoppedRecoveries'] : []), ...(Object.hasOwn(l, 'recoveryConfiguration') ? ['recoveryConfiguration'] : [])].join(',')) || !Array.isArray(l.requests) || l.requests.length > 20 || !Array.isArray(l.acceptances) || !Array.isArray(l.ownerSuccessions) || l.ownerSuccessions.length > 200 || new Set(l.requests.map(r => r.identity.requestId)).size !== l.requests.length || new Set(l.acceptances.map(a => a.requestId)).size !== l.acceptances.length)
      return false;
    if (l.recoveryConfiguration && (!keys(l.recoveryConfiguration, 'revision,owner,repo,controlIssue,queueCommentId,leaseDurationMs') || !text(l.recoveryConfiguration.revision) || l.recoveryConfiguration.owner.toLowerCase() !== run.target.owner.toLowerCase() || l.recoveryConfiguration.repo.toLowerCase() !== run.target.repo.toLowerCase() || !Number.isSafeInteger(l.recoveryConfiguration.controlIssue) || l.recoveryConfiguration.controlIssue < 1 || !Number.isSafeInteger(l.recoveryConfiguration.queueCommentId) || l.recoveryConfiguration.queueCommentId < 1 || l.recoveryConfiguration.leaseDurationMs !== 60000))
      return false;
    if (l.stoppedRecoveries && (!Array.isArray(l.stoppedRecoveries) || l.stoppedRecoveries.length > 200 || new Set(l.stoppedRecoveries.map(s => s.releasedGeneration)).size !== l.stoppedRecoveries.length || l.stoppedRecoveries.some(s => !keys(s, 'fromGeneration,releasedGeneration,missionId,workspace,receiptSha256') || !Number.isSafeInteger(s.fromGeneration) || s.fromGeneration < 1 || !Number.isSafeInteger(s.releasedGeneration) || s.releasedGeneration <= s.fromGeneration || s.releasedGeneration > s.fromGeneration + 2 || !text(s.missionId) || !text(s.workspace, 4096) || !DIGEST.test(s.receiptSha256))))
      return false;
    if (new Set(l.ownerSuccessions.map(s => s.toGeneration)).size !== l.ownerSuccessions.length)
      return false;
    for (const s of l.ownerSuccessions)
      if (!keys(s, 'missionId,laneId,claimId,workspace,fromGeneration,toGeneration,predecessorSha256,status,predecessorGeneration,predecessorPhase,predecessorStatus') || ![s.missionId, s.claimId, s.workspace].every(v => text(v, 4096)) || s.laneId !== `run:${run.id}` || s.claimId !== run.dispatchClaimId || !Number.isSafeInteger(s.fromGeneration) || s.fromGeneration < 1 || !Number.isSafeInteger(s.toGeneration) || s.toGeneration <= s.fromGeneration || !['prepared', 'confirmed'].includes(s.status) || !['parked', 'released'].includes(s.predecessorStatus) || !['parked', 'park_transition', 'released'].includes(s.predecessorPhase) || !Number.isSafeInteger(s.predecessorGeneration) || s.toGeneration !== s.predecessorGeneration + 1 || (s.predecessorStatus === 'parked' ? s.fromGeneration !== s.predecessorGeneration - 1 : !(l.stoppedRecoveries ?? []).some(p => p.fromGeneration === s.fromGeneration && p.releasedGeneration === s.predecessorGeneration && p.missionId === s.missionId && p.workspace === s.workspace)) || !DIGEST.test(s.predecessorSha256))
        return false;
    for (const r of l.requests) {
      if (!run.nativeReview?.requests.some(n => n.identity.requestId === r.identity.origin.requestId && n.terminalDigest === r.identity.origin.digest && n.identity.headSha === r.identity.headSha && n.identity.baseSha === r.identity.baseSha) || !keys(r, ['identity', 'status', 'submissionPossible', 'observations', 'nextObservationAt', ...(r.conversationUrl === undefined ? [] : ['conversationUrl']), ...(r.failure === undefined ? [] : ['failure']), ...(r.replacedBy === undefined ? [] : ['replacedBy']), ...(r.replacementReason === undefined ? [] : ['replacementReason']), ...(r.terminalDigest === undefined ? [] : ['terminalDigest']), ...(Object.hasOwn(r, 'completionProof') ? ['completionProof'] : [])].join(',')) || !validLeadIdentity(r.identity) || r.identity.runId !== run.id || r.identity.claimId !== run.dispatchClaimId || r.identity.repository !== `${run.target.owner}/${run.target.repo}`.toLowerCase() || !['pending', 'qualified_complete', 'incomplete', 'terminal_unknown', 'retired', 'replaced'].includes(r.status) || typeof r.submissionPossible !== 'boolean' || !Number.isSafeInteger(r.observations) || r.observations < 0 || r.observations > LEAD_OBSERVATIONS || !Number.isFinite(Date.parse(r.nextObservationAt)) || r.conversationUrl !== undefined && !validUrl(r.conversationUrl) || r.terminalDigest !== undefined && (!DIGEST.test(r.terminalDigest) || r.completionProof !== undefined && (!validCompletionProof(r.completionProof) || !inspectOnly && !hasAuthenticatedCompletion(r.identity, r.terminalDigest, r.completionProof, 'lead'))) || r.completionProof !== undefined && r.terminalDigest === undefined || r.status === 'qualified_complete' && (!r.submissionPossible || !r.terminalDigest) || r.failure !== undefined && !['transport_failure', 'safety_refusal', 'missing_evidence'].includes(r.failure))
        return false;
      const group = l.requests.filter(n => n.identity.incarnation === r.identity.incarnation);
      if (group.length > 2 || group.length === 2 && (group[0]!.status !== 'replaced' || group[0]!.replacementReason !== 'irrecoverable_transport' || group[0]!.replacedBy !== group[1]!.identity.requestId))
        return false;
    }
    if (l.activeRequestId !== undefined && !l.requests.some(r => r.identity.requestId === l.activeRequestId && !['retired', 'replaced'].includes(r.status)))
      return false;
    if (l.wait && (!keys(l.wait, 'kind,nextAttemptAt') || !['binding', 'request', 'qualification', 'stop'].includes(l.wait.kind) || !Number.isFinite(Date.parse(l.wait.nextAttemptAt))))
      return false;
    for (const a of l.acceptances) {
      const r = l.requests.find(r => r.identity.requestId === a.requestId);
      if (!inspectOnly && r?.completionProof && !leadAcceptanceMatches(r, a)) return false;
      if (!r || !keys(a, 'requestId,receiptId,digest,identity,disposition') || a.receiptId !== `${a.requestId}.terminal` || r.terminalDigest !== a.digest || !same(a.identity, r.identity) || !validLeadDisposition(a.disposition) || a.disposition.outcome === 'repair' && (!same(a.disposition.origin, a.identity.origin) || a.disposition.authoritySha256 !== a.identity.authoritySha256 || !same([...a.disposition.acceptedFindingIds].sort(), [...a.identity.blockingFindingIds].sort())))
        return false;
    }
    for (const [index, a] of (run.repairAdmissions ?? []).entries()) {
      const ref = a.leadDisposition;
      if (a.finding === 'review_blocking' && run.nativeReview?.requests.some(r => r.identity.headSha === a.headSha) && !ref)
        return false;
      if (ref && (a.budgetLimit !== ref.identity.repairLimit || ref.identity.headSha !== a.headSha || ref.identity.pullRequestNumber !== a.pullRequestNumber || ref.identity.repairOrdinal !== run.history.slice(0, (a.attemptBinding?.startFixHistoryIndex ?? -1) + 1).filter(h => h.type === 'start_fix').length || a.attemptBinding?.admissionIndex !== index || !leadOwnerProved(run, ref.identity, { missionId: ref.identity.missionId, laneId: ref.identity.laneId, generation: ref.consumptionGeneration })))
        return false;
    }
    const stops = run.history.flatMap(h => h.nativeLeadStop ? [{ entry: h, ref: h.nativeLeadStop }] : []);
    if (new Set(stops.map(s => s.ref.requestId)).size !== stops.length || stops.some(({ entry, ref }) => entry.type !== 'escalate' || entry.from !== 'CHANGES_REQUESTED' || entry.to !== 'NEEDS_HUMAN' || !keys(ref, 'requestId,receiptId,digest') || !l.acceptances.some(a => a.requestId === ref.requestId && a.receiptId === ref.receiptId && a.digest === ref.digest && a.disposition.outcome === 'stop')))
      return false;
    const consumed = (run.repairAdmissions ?? []).flatMap(a => a.leadDisposition ? [a.leadDisposition] : []);
    if (new Set(consumed.map(r => r.identity.incarnation)).size !== consumed.length)
      return false;
    return consumed.every(r => l.acceptances.some(a => same(a, stripConsumption(r))) && validLeadRepairReference(r));
  }
  catch {
    return false;
  }
}
function stripConsumption(r: LeadRepairReference): NativeLeadAcceptance { const { consumptionGeneration: _g, instructionsSha256: _h, originEvidence: _origin, implementationAuthoritySha256: _authority, ...a } = r; return a; }
export function validLeadRepairReference(r: LeadRepairReference): boolean { return !!r && r.originEvidence?.kind === 'terminal' && validNativeEvidence(r.originEvidence) && r.originEvidence.result.verdict === 'request_changes' && oracleDigest(r.originEvidence) === r.identity.origin.digest && same(blockingFindingIds(r.originEvidence), r.identity.blockingFindingIds) && keys(r, 'requestId,receiptId,digest,identity,disposition,consumptionGeneration,instructionsSha256,originEvidence,implementationAuthoritySha256') && DIGEST.test(r.implementationAuthoritySha256) && validLeadIdentity(r.identity) && DIGEST.test(r.digest) && r.receiptId === `${r.requestId}.terminal` && r.requestId === r.identity.requestId && validLeadDisposition(r.disposition) && r.disposition.outcome === 'repair' && same(r.disposition.origin, r.identity.origin) && r.disposition.authoritySha256 === r.identity.authoritySha256 && same([...r.disposition.acceptedFindingIds].sort(), [...r.identity.blockingFindingIds].sort()) && Number.isSafeInteger(r.consumptionGeneration) && r.consumptionGeneration >= r.identity.ownerGeneration && r.instructionsSha256 === oracleDigest(r.disposition); }
export function nativeLeadProgresses(before: Run, after: Run): boolean {
  if (after.nativeLead?.requests.some(n => n.terminalDigest !== undefined && !before.nativeLead?.requests.some(r => r.identity.requestId === n.identity.requestId && r.terminalDigest === n.terminalDigest) && !hasAuthenticatedCompletion(n.identity, n.terminalDigest, n.completionProof, 'lead'))) return false;
  const old = before.nativeLead;
  if (!old)
    return true;
  const n = after.nativeLead;
  if (!n || old.recoveryConfiguration !== undefined && !same(old.recoveryConfiguration, n.recoveryConfiguration) || n.requests.length < old.requests.length || n.acceptances.length < old.acceptances.length || n.ownerSuccessions.length < old.ownerSuccessions.length)
    return false;
  return old.acceptances.every((a, i) => same(a, n.acceptances[i])) && old.ownerSuccessions.every((a, i) => { const b = n.ownerSuccessions[i]!; return same({ ...a, status: undefined }, { ...b, status: undefined }) && (a.status === b.status || a.status === 'prepared' && b.status === 'confirmed'); }) && (old.stoppedRecoveries ?? []).every((a, i) => same(a, n.stoppedRecoveries?.[i])) && old.requests.every((r, i) => {
    const a = n.requests[i]!;
    return same(r.identity, a.identity) && (!r.submissionPossible || a.submissionPossible) && a.observations >= r.observations && ['conversationUrl', 'terminalDigest', 'completionProof', 'failure', 'replacedBy', 'replacementReason'].every(k => r[k as keyof NativeLeadRequest] === undefined || same(r[k as keyof NativeLeadRequest], a[k as keyof NativeLeadRequest]) || k === 'failure' && a.failure === 'safety_refusal') && (r.status === a.status || r.status === 'qualified_complete' && a.status === 'retired' || r.status === 'incomplete' && a.status === 'qualified_complete' && a.completionProof !== undefined || ['pending', 'terminal_unknown'].includes(r.status) || ['retired', 'replaced'].includes(r.status) && a.status === r.status || r.status === 'incomplete' && r.failure === 'transport_failure' && a.status === 'replaced');
  });
}
function leadAcceptanceMatches(request: NativeLeadRequest, acceptance: NativeLeadAcceptance): boolean {
  const evidence = authenticatedCompletionEvidence(request.identity, request.terminalDigest, request.completionProof, 'lead');
  return !!evidence && evidence.kind === 'terminal' && 'disposition' in evidence && evidence.id === acceptance.receiptId && same(evidence.disposition, acceptance.disposition);
}
export function leadConsumptionValid(run: Run, reference: LeadRepairReference | undefined): boolean {
  const a = acceptedNativeLead(run);
  const r = reference;
  return !!r && !!activeNativeLead(run) && hasAuthenticatedCompletion(activeNativeLead(run)!.identity, activeNativeLead(run)!.terminalDigest, activeNativeLead(run)!.completionProof, 'lead') && validLeadRepairReference(r) && run.implementationAuthority !== undefined && r.implementationAuthoritySha256 === oracleDigest(run.implementationAuthority) && !!a && leadAcceptanceMatches(activeNativeLead(run)!, a) && same(a, stripConsumption(r)) && activeNativeLead(run)?.status === 'qualified_complete' && run.reviewResult?.verdict === 'request_changes' && run.nativeReview?.accepted?.digest === r.identity.origin.digest && run.headSha === r.identity.headSha && run.pullRequest?.number === r.identity.pullRequestNumber && r.identity.repairOrdinal === run.history.filter(h => h.type === 'start_fix').length + 1 && r.identity.repairOrdinal <= r.identity.repairLimit && same(r.identity.blockingFindingIds, run.reviewResult.findings.flatMap((f, i) => f.severity === 'blocking' ? [`${r.identity.origin.digest}:${i}`] : [])) && !(run.repairAdmissions ?? []).some(p => p.leadDisposition?.identity.incarnation === r.identity.incarnation) && leadOwnerProved(run, r.identity, { missionId: r.identity.missionId, laneId: r.identity.laneId, generation: r.consumptionGeneration });
}
export function leadAuthority(run: Run, snapshot: GitHubLiveSnapshot, execution: ResolvedExecutionConfiguration, maxAttempts: number): NativeLeadAuthority {
  if (!originalImplementationMatches(run, snapshot)) throw new Error('Original admitted implementation authority is missing or changed.');
  return { implementationAuthoritySha256: oracleDigest(run.implementationAuthority), target: run.target, pullRequest: run.pullRequest!, bootstrap: run.bootstrap!, taskShape: run.repairTaskShapeAuthority!, originalExecution: run.execution!, execution, validation: run.validationResult!,
    reviewIdentity: run.nativeReview!.accepted!.identity, scope: acceptedScopeFromHandoff(snapshot.handoff, snapshot.problems)!, issue: snapshot.issue, maxAttempts };
}
function usable(host: NativeLeadHost | undefined): host is NativeLeadHost {
  try {
    const b = host?.binding;
    return !!host && keys(host, ['binding', 'receipts', 'source', 'submit', 'authenticate', ...(host.observe === undefined ? [] : ['observe']), ...(host.replacementDisposition === undefined ? [] : ['replacementDisposition'])].join(',')) && !!b && keys(b, 'bindingId,policyRevision,model,effort,readOnly,qualified,allowTransportReplacement') && [b.bindingId, b.policyRevision, b.model].every(v => text(v)) && b.effort === 'High' && b.readOnly === true && b.qualified === true && typeof b.allowTransportReplacement === 'boolean' && typeof host.source === 'function' && typeof host.submit === 'function' && typeof host.authenticate === 'function' && host.receipts instanceof JsonFileOracleReceiptStore && typeof host.receipts.recordAuthenticatedCompletion === 'function' && typeof host.receipts.recordLead === 'function' && typeof host.receipts.readLead === 'function' && typeof host.receipts.readNative === 'function' && (host.observe === undefined || typeof host.observe === 'function') && (host.replacementDisposition === undefined || typeof host.replacementDisposition === 'function');
  }
  catch {
    return false;
  }
}
export interface NativeLeadContext extends NativeReviewContext {
  readonly consumed?: LeadRepairReference;
  readonly store: RunStore;
  readonly now: () => string;
  readonly execution: ResolvedExecutionConfiguration;
  readonly maxAttempts: number;
  readonly onSubmission: (run: Run) => Run;
  readonly withIssueBoundary?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly assertInitiation?: () => Promise<void>;
  readonly observationOnly?: boolean;
  readonly recoveryConfiguration?: import('../dispatch/config.js').DispatchConfiguration;
}
export interface NativeLeadBoundary {
  available(): boolean;
  observe(context: NativeReviewContext & {
    readonly store: RunStore;
    readonly now: () => string;
  }): Promise<{
    readonly run: Run;
    readonly reason: string;
  }>;
  advance(context: NativeLeadContext): Promise<{
    readonly outcome: 'wait' | 'superseded';
    readonly run: Run;
    readonly reason: string;
  } | {
    readonly outcome: 'complete';
    readonly run: Run;
    readonly acceptance: NativeLeadAcceptance;
  }>;
  validate(context: NativeLeadContext): LeadRepairReference | null;
}
const frozen = <T>(v: T): T => {
  const c = structuredClone(v);
  const visit = (x: unknown): void => {
    if (x && typeof x === 'object') {
      Object.freeze(x);
      Object.values(x).forEach(visit);
    }
  };
  visit(c);
  return c;
};
/** Explicit trusted accepted-release dependency only; no environment/candidate/provider selection. */
export function resolveNativeLead(host?: NativeLeadHost): NativeLeadBoundary {
  const validate = (c: NativeLeadContext): LeadRepairReference | null => {
    try {
      if (!usable(host) || c.observationOnly || !nativeLeadCoherent(c.run))
        return null;
      c.assertCurrent();
      const a = acceptedNativeLead(c.run);
      const owner = c.owner;
      if (!a || !activeNativeLead(c.run) || !hasAuthenticatedCompletion(activeNativeLead(c.run)!.identity, activeNativeLead(c.run)!.terminalDigest, activeNativeLead(c.run)!.completionProof, 'lead') || a.disposition.outcome !== 'repair' || !owner || !leadOwnerProved(c.run, a.identity, owner) || a.identity.bindingId !== host.binding.bindingId || a.identity.policyRevision !== host.binding.policyRevision || a.identity.requestedModel !== host.binding.model || a.identity.authoritySha256 !== oracleDigest(leadAuthority(c.run, c.snapshot, c.execution, c.maxAttempts)))
        return null;
      const t = host.receipts.readLead!(a.receiptId);
      const q = host.receipts.readLead!(`${a.requestId}.request`);
      if (!t || t.kind !== 'terminal' || !q || q.kind !== 'request' || !validLeadEvidence(t) || !validLeadEvidence(q) || !same(t.identity, a.identity) || !same(q.identity, a.identity) || oracleDigest(t) !== a.digest || !same(t.disposition, a.disposition) || !host.authenticate(frozen(t)) || !same([...a.disposition.acceptedFindingIds].sort(), [...q.packet.blockingFindingIds].sort()))
        return null;
      const m = host.source(a.identity.baseSha, a.identity.headSha);
      if (!validNativeSourceManifest(m) || m.sourceSha256 !== a.identity.sourceSha256 || m.diffSha256 !== a.identity.diffSha256)
        return null;
      const reference = { ...a, implementationAuthoritySha256: q.packet.authority.implementationAuthoritySha256, originEvidence: q.packet.origin, consumptionGeneration: c.consumed?.consumptionGeneration ?? owner.generation, instructionsSha256: oracleDigest(a.disposition) };
      if (c.consumed)
        return same(reference, c.consumed) && same(activeRepairAdmission(c.run)?.snapshot.leadDisposition, c.consumed) ? c.consumed : null;
      return leadConsumptionValid(c.run, reference) ? reference : null;
    }
    catch {
      return null;
    }
  };
  const observe: NativeLeadBoundary['observe'] = async (c) => {
    let run = c.run;
    const wait = (reason: string) => ({ run, reason });
    if (!usable(host) || !c.assertLiveClaim || !c.owner)
      return wait('Lead observation unavailable: qualified host/current owner/claim missing.');
    await c.assertLiveClaim();
    c.assertCurrent();
    const pending = run.nativeLead?.requests.find(r => r.submissionPossible && r.terminalDigest === undefined && leadOwnerProved(run, r.identity, c.owner) && r.identity.bindingId === host.binding.bindingId && r.identity.requestedModel === host.binding.model);
    if (!pending)
      return wait('No exact unresolved lead request is observable by this current owner/binding.');
    const save = (next: Run) => {
      c.assertCurrent();
      if (c.store.updateIfUnchanged?.(run, next) !== true)
        return false;
      run = next;
      return true;
    };
    let request = pending;
    const complete = (e: Extract<NativeLeadEvidence, {
      kind: 'terminal';
    }>) => {
      if (!same(e.identity, request.identity) || !validLeadAuthentication(e.authentication, request.identity) || Buffer.byteLength(JSON.stringify(e)) > 16000 || !host.authenticate(frozen(e)))
        return wait('Foreign or unauthenticated lead terminal cannot clear uncertainty.');
      if (validLeadEvidence(e)) {
        host.receipts.recordLead!(e);
        const acceptance: NativeLeadAcceptance = { requestId: request.identity.requestId, receiptId: e.id, digest: oracleDigest(e), identity: request.identity, disposition: e.disposition };
        const active = run.nativeLead!.activeRequestId === request.identity.requestId && request.failure !== 'safety_refusal';
        const existing = run.nativeLead!.acceptances.find(a => a.requestId === acceptance.requestId);
        if (existing && !same(existing, acceptance))
          return wait('Conflicting terminal rejected.');
        const next = { ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? { ...r, terminalDigest: acceptance.digest, completionProof: host.receipts.recordAuthenticatedCompletion!('lead', e, x => host.authenticate(x as Exclude<NativeLeadEvidence,{kind:'request'}>)), ...(active ? { status: 'qualified_complete' as const } : {}) } : r), acceptances: existing ? run.nativeLead!.acceptances : [...run.nativeLead!.acceptances, acceptance] } };
        if (!save(next))
          return wait('Lead terminal evidence retained after lost Run CAS.');
        return wait('Authenticated lead terminal retained as evidence only; no repair initiated.');
      }
      const completion: Extract<NativeLeadEvidence, {
        kind: 'completion';
      }> = { id: `${request.identity.requestId}.completion`, kind: 'completion', identity: request.identity, terminalSha256: leadPayloadDigest(e), reason: 'rejected_disposition', authentication: e.authentication };
      if (!host.authenticate(frozen(completion)))
        return wait('External completion proof cannot be authenticated independently after restart.');
      host.receipts.recordLead!(completion);
      if (!save({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? { ...r, terminalDigest: oracleDigest(completion), completionProof: host.receipts.recordAuthenticatedCompletion!('lead', completion, x => host.authenticate(x as Exclude<NativeLeadEvidence,{kind:'request'}>)), ...(r.status === 'retired' || r.status === 'replaced' ? {} : { status: 'incomplete' as const, failure: 'missing_evidence' as const }) } : r) } }))
        return wait('Completion proof retained after lost Run CAS.');
      return wait('Authenticated external completion retained; rejected semantic disposition cannot authorize repair.');
    };
    const persisted = host.receipts.readLead!(`${request.identity.requestId}.terminal`);
    if (persisted?.kind === 'terminal')
      return complete(persisted);
    const rejected = host.receipts.readLead!(`${request.identity.requestId}.completion`);
    if (rejected?.kind === 'completion' && same(rejected.identity, request.identity) && host.authenticate(frozen(rejected))) {
      save({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? { ...r, terminalDigest: oracleDigest(rejected), completionProof: host.receipts.recordAuthenticatedCompletion!('lead', rejected, x => host.authenticate(x as Exclude<NativeLeadEvidence,{kind:'request'}>)), ...(r.status === 'retired' || r.status === 'replaced' ? {} : { status: 'incomplete' as const, failure: 'missing_evidence' as const }) } : r) } });
      return wait('Immutable rejected-terminal completion reconciled without a service read.');
    }
    if (!host.observe || request.observations >= LEAD_OBSERVATIONS || Date.parse(request.nextObservationAt) > Date.parse(c.now()))
      return wait('Lead finite observation unavailable or not due; ownership retained.');
    request = { ...request, observations: request.observations + 1, nextObservationAt: new Date(Date.parse(c.now()) + LEAD_BACKOFF_MS).toISOString() };
    if (!save({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? request : r) } }))
      return wait('Lead observation Run CAS lost.');
    let response: NativeLeadObservation;
    try {
      response = await host.observe(frozen(request.identity), request.conversationUrl);
    }
    catch {
      return wait('Lead observation failed; external state remains unknown.');
    }
    c.assertCurrent();
    await c.assertLiveClaim();
    if (response.conversationUrl !== undefined) {
      if (!validUrl(response.conversationUrl) || request.conversationUrl !== undefined && request.conversationUrl !== response.conversationUrl)
        return wait('Lead returned URL conflict preserves uncertainty.');
      request = { ...request, conversationUrl: response.conversationUrl };
      if (!save({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? request : r) } }))
        return wait('Lead URL CAS lost.');
    }
    if (response.outcome === 'complete')
      return complete(response.evidence);
    // HOLD observations retain lifecycle evidence without gaining issuance authority.
    const inactive = ['retired', 'replaced'].includes(request.status);
    const status = request.status === 'incomplete' ? 'incomplete' as const : response.outcome === 'incomplete' ? 'incomplete' as const : response.outcome;
    const failure = request.failure === 'safety_refusal' ? request.failure : response.outcome === 'incomplete' ? response.reason : request.failure;
    const updated = { ...request, ...(inactive ? {} : { status }), ...(failure === undefined ? {} : { failure }) };
    if (!save({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(r => r.identity.requestId === request.identity.requestId ? updated : r) } }))
      return wait('Lead observation status CAS lost.');
    return wait('Original lead request observed; uncertainty/finite budget retained.');
  };
  return { available: () => usable(host), validate, observe, async advance(c) {
      let run = c.run;
      const wait = (reason: string) => ({ outcome: 'wait' as const, run, reason });
      const stale = () => ({ outcome: 'superseded' as const, run: c.store.read(run.id) ?? run, reason: 'Lead Run or owner changed; immutable evidence retained.' });
      const save = (next: Run) => {
        c.assertCurrent();
        if (c.store.updateIfUnchanged?.(run, next) !== true)
          return false;
        run = next;
        return true;
      };
      if (!usable(host))
        return wait('Native lead unavailable: no accepted qualified read-only host binding.');
      if (!c.owner || !c.assertLiveClaim || !run.dispatchClaimId || !run.nativeReview?.accepted)
        return wait('Native lead unavailable: current owner/claim/origin proof missing.');
      await c.assertLiveClaim();
      c.assertCurrent();
      const origin = host.receipts.readNative!(run.nativeReview.accepted.receiptId);
      if (!origin || origin.kind !== 'terminal' || !validNativeEvidence(origin) || origin.result.verdict !== 'request_changes' || oracleDigest(origin) !== run.nativeReview.accepted.digest || !same(origin.identity, run.nativeReview.accepted.identity))
        return wait('Native lead origin is not the exact qualified changes-required receipt.');
      const base = c.snapshot.pullRequest?.baseSha;
      const scope = acceptedScopeFromHandoff(c.snapshot.handoff, c.snapshot.problems);
      if (!originalImplementationMatches(run, c.snapshot) || !base || c.snapshot.headSha !== run.headSha || base !== origin.identity.baseSha || run.headSha !== origin.identity.headSha || !scope || run.repairTaskShapeAuthority?.shape !== 'bounded' || c.execution.executor !== 'luna-isolated' || c.execution.profile !== 'routine' || !same(c.execution, run.execution) || run.history.filter(h => h.type === 'start_fix').length >= c.maxAttempts)
        return wait('Native lead cannot authorize changed authority, non-bounded work, unavailable isolated execution or exhausted repair budget.');
      let manifest: NativeSourceManifest;
      try {
        manifest = host.source(base, run.headSha);
      }
      catch {
        return wait('Native lead complete immutable source evidence unavailable.');
      }
      const packet: NativeLeadPacket = { origin, manifest, authority: leadAuthority(run, c.snapshot, c.execution, c.maxAttempts), blockingFindingIds: blockingFindingIds(origin), remainingRepairs: c.maxAttempts - run.history.filter(h => h.type === 'start_fix').length };
      const authoritySha256 = oracleDigest(packet.authority);
      const packetSha256 = oracleDigest(packet);
      const incarnation = oracleDigest({ runId: run.id, claimId: run.dispatchClaimId, missionId: c.owner.missionId, origin: run.nativeReview.accepted, packetSha256, blockingFindingIds: packet.blockingFindingIds, repairOrdinal: run.history.filter(h => h.type === 'start_fix').length + 1 });
      let active = activeNativeLead(run);
      if (active && active.identity.incarnation !== incarnation && active.terminalDigest && active.identity.origin.requestId !== origin.identity.requestId && active.identity.headSha !== run.headSha && !c.observationOnly) {
        const old = active;
        const l = run.nativeLead!;
        if (!save({ ...run, nativeLead: { ...l, activeRequestId: undefined, wait: undefined, requests: l.requests.map(r => r.identity.requestId === old.identity.requestId ? { ...r, status: 'retired' as const } : r) } }))
          return stale();
        active = undefined;
      }
      if (active && (!leadOwnerProved(run, active.identity, c.owner) || active.identity.incarnation !== incarnation || active.identity.bindingId !== host.binding.bindingId || active.identity.policyRevision !== host.binding.policyRevision || active.identity.requestedModel !== host.binding.model)) {
        const observed = await observe({ ...c, run });
        run = observed.run;
        return wait(`Native lead authority drift; evidence only. ${observed.reason}`);
      }
      const update = (r: NativeLeadRequest) => ({ ...run, nativeLead: { ...run.nativeLead!, requests: run.nativeLead!.requests.map(p => p.identity.requestId === r.identity.requestId ? r : p) } });
      const accept = (e: Extract<NativeLeadEvidence, {
        kind: 'terminal';
      }>, request: NativeLeadRequest) => {
        const q = host.receipts.readLead!(`${request.identity.requestId}.request`);
        if (!request.submissionPossible || !validLeadEvidence(e) || !same(e.identity, request.identity) || !q || q.kind !== 'request' || !validLeadEvidence(q) || !host.authenticate(frozen(e)) || e.disposition.outcome === 'repair' && !same([...e.disposition.acceptedFindingIds].sort(), [...q.packet.blockingFindingIds].sort()))
          return wait('Native lead rejected: malformed, foreign, unauthenticated or incomplete blocking finding coverage.');
        const digest = oracleDigest(e);
        const acceptance: NativeLeadAcceptance = { requestId: request.identity.requestId, receiptId: e.id, digest, identity: request.identity, disposition: e.disposition };
        const existing = run.nativeLead!.acceptances.find(a => a.requestId === acceptance.requestId);
        if (existing && !same(existing, acceptance))
          return wait('Native lead conflicting terminal rejected.');
        const isActive = request.identity.requestId === run.nativeLead!.activeRequestId && request.failure !== 'safety_refusal';
        const completed = { ...request, terminalDigest: digest, completionProof: host.receipts.recordAuthenticatedCompletion!('lead', e, x => host.authenticate(x as Exclude<NativeLeadEvidence,{kind:'request'}>)), ...(isActive ? { status: 'qualified_complete' as const } : {}) };
        const next = update(completed);
        if (!save({ ...next, nativeLead: { ...next.nativeLead, acceptances: existing ? next.nativeLead.acceptances : [...next.nativeLead.acceptances, acceptance] } }))
          return stale();
        return isActive ? { outcome: 'complete' as const, run, acceptance } : wait('Inactive lead terminal reconciled as evidence only.');
      };
      // Inactive originals remain observable: eligibility retirement never erases remote uncertainty.
      const inactive = run.nativeLead?.requests.find(r => r.identity.requestId !== run.nativeLead?.activeRequestId && r.submissionPossible && !r.terminalDigest && r.observations < LEAD_OBSERVATIONS && Date.parse(r.nextObservationAt) <= Date.parse(c.now()));
      if (inactive && (host.observe || host.receipts.readLead!(`${inactive.identity.requestId}.terminal`))) {
        const result = await observe({ ...c, run });
        run = result.run;
        return wait(result.reason);
      }
      const replacement = (run.nativeLead?.requests.filter(r => r.identity.incarnation === incarnation).length ?? 0) < 2 && active && active.terminalDigest === undefined && active.failure !== 'safety_refusal' && (active.failure === 'transport_failure' || active.status === 'terminal_unknown') && host.binding.allowTransportReplacement && host.replacementDisposition?.(frozen(active)) === 'irrecoverable_transport';
      if (!active || replacement) {
        if (c.observationOnly)
          return wait('HOLD permits observation only.');
        if ((run.nativeLead?.requests.length ?? 0) >= 20 || (run.nativeLead?.requests.filter(r => r.identity.incarnation === incarnation).length ?? 0) >= 2)
          return wait('Native lead finite request/replacement allowance exhausted.');
        await c.assertInitiation?.();
        const requestId = randomUUID();
        const identity: NativeLeadIdentity = { requestId, correlationId: requestId, incarnation, runId: run.id, claimId: run.dispatchClaimId, missionId: c.owner.missionId, laneId: c.owner.laneId, ownerGeneration: c.owner.generation, phase: 'lead-disposition', role: 'bounded-lead', repository: origin.identity.repository, targetKey: origin.identity.targetKey, pullRequestNumber: origin.identity.pullRequestNumber, baseSha: base, headSha: run.headSha, origin: { requestId: origin.identity.requestId, receiptId: origin.id, digest: oracleDigest(origin) }, authoritySha256, sourceSha256: manifest.sourceSha256, diffSha256: manifest.diffSha256, packetSha256, blockingFindingIds: packet.blockingFindingIds, repairOrdinal: run.history.filter(h => h.type === 'start_fix').length + 1, repairLimit: c.maxAttempts, bindingId: host.binding.bindingId, policyRevision: host.binding.policyRevision, requestedModel: host.binding.model, requestedEffort: 'High' };
        const evidence: NativeLeadEvidence = { id: `${requestId}.request`, kind: 'request', identity, packet };
        if (!validLeadEvidence(evidence))
          return wait('Native lead packet incomplete or exceeds evidence bound.');
        const request: NativeLeadRequest = { identity, status: 'pending', submissionPossible: false, observations: 0, nextObservationAt: c.now() };
        const l = run.nativeLead ?? emptyLeadLedger();
        const requests = l.requests.map(r => replacement && r.identity.requestId === active!.identity.requestId ? { ...r, status: 'replaced' as const, replacedBy: requestId, replacementReason: 'irrecoverable_transport' as const } : r);
        if (!save({ ...run, nativeLead: { ...l, ...(l.recoveryConfiguration === undefined && c.recoveryConfiguration ? { recoveryConfiguration: c.recoveryConfiguration } : {}), requests: [...requests, request], activeRequestId: requestId } }))
          return stale();
        active = request;
      }
      const q: Extract<NativeLeadEvidence, {
        kind: 'request';
      }> = { id: `${active.identity.requestId}.request`, kind: 'request', identity: active.identity, packet };
      host.receipts.recordLead!(q);
      const terminal = host.receipts.readLead!(`${active.identity.requestId}.terminal`);
      if (terminal?.kind === 'terminal')
        return accept(terminal, active);
      const rejected = host.receipts.readLead!(`${active.identity.requestId}.completion`);
      if (rejected?.kind === 'completion') {
        const observed = await observe({ ...c, run });
        run = observed.run;
        return wait(observed.reason);
      }
      if (!['pending', 'terminal_unknown'].includes(active.status))
        return wait(`Native lead ${active.status}: attention required.`);
      let response: NativeLeadObservation;
      if (!active.submissionPossible) {
        if (c.observationOnly)
          return wait('HOLD prevents lead submission.');
        if (!c.withIssueBoundary || !c.assertInitiation)
          return wait('Native lead issuance requires the serialized current claim/owner/HOLD boundary.');
        const issue = async () => {
          await c.assertInitiation?.();
          await c.assertLiveClaim!();
          c.assertCurrent();
          const marked = { ...active!, submissionPossible: true };
          if (!save(update(marked)))
            return null;
          active = marked;
          if (!save(c.onSubmission(run)))
            return null;
          await c.assertInitiation?.();
          await c.assertLiveClaim!();
          c.assertCurrent();
          if (c.store.updateIfUnchanged?.(run, run) !== true)
            return null;
          // Initiate synchronously inside the short serialized issue boundary;
          // await its response only after that boundary has released its lock.
          let promise: Promise<NativeLeadObservation>;
          try {
            promise = host.submit(frozen(q));
          }
          catch {
            promise = Promise.resolve({ outcome: 'terminal_unknown' });
          }
          return { promise };
        };
        const issued = await (c.withIssueBoundary ? c.withIssueBoundary(issue) : issue());
        if (!issued)
          return stale();
        try {
          response = await issued.promise;
        }
        catch {
          response = { outcome: 'terminal_unknown' };
        }
      }
      else {
        if (active.observations >= LEAD_OBSERVATIONS || Date.parse(active.nextObservationAt) > Date.parse(c.now()))
          return wait('Native lead bounded observation parked.');
        if (!host.observe) {
          if (!save(update({ ...active, status: 'terminal_unknown' })))
            return stale();
          return wait('Native lead observation unsupported; external completion remains unknown.');
        }
        const observing = { ...active, observations: active.observations + 1, nextObservationAt: new Date(Date.parse(c.now()) + LEAD_BACKOFF_MS).toISOString() };
        if (!save(update(observing)))
          return stale();
        active = observing;
        try {
          response = await host.observe(frozen(active.identity), active.conversationUrl);
        }
        catch {
          response = { outcome: 'terminal_unknown' };
        }
      }
      c.assertCurrent();
      await c.assertLiveClaim();
      if (response.conversationUrl !== undefined) {
        if (!validUrl(response.conversationUrl) || active.conversationUrl !== undefined && active.conversationUrl !== response.conversationUrl)
          return wait('Native lead conflicting URL: uncertainty retained.');
        const updated = { ...active, conversationUrl: response.conversationUrl };
        if (!save(update(updated)))
          return stale();
        active = updated;
      }
      if (response.outcome === 'complete') {
        const e = frozen(response.evidence);
        if (same(e.identity, active.identity) && validLeadAuthentication(e.authentication, active.identity) && Buffer.byteLength(JSON.stringify(e)) <= 16000 && host.authenticate(e)) {
          if (validLeadEvidence(e)) {
            host.receipts.recordLead!(e);
            return accept(e, active);
          }
          const completion: Extract<NativeLeadEvidence, {
            kind: 'completion';
          }> = { id: `${active.identity.requestId}.completion`, kind: 'completion', identity: active.identity, terminalSha256: leadPayloadDigest(e), reason: 'rejected_disposition', authentication: e.authentication };
          if (!host.authenticate(frozen(completion)))
            return wait('External completion proof cannot be authenticated independently after restart.');
          host.receipts.recordLead!(completion);
          if (!save(update({ ...active, status: 'incomplete', failure: 'missing_evidence', terminalDigest: oracleDigest(completion), completionProof: host.receipts.recordAuthenticatedCompletion!('lead', completion, x => host.authenticate(x as Exclude<NativeLeadEvidence,{kind:'request'}>)) })))
            return stale();
          return wait('Authenticated external completion retained; invalid disposition rejected.');
        }
        response = { outcome: 'incomplete', reason: 'missing_evidence' };
      }
      const status = response.outcome === 'incomplete' ? 'incomplete' : response.outcome;
      if (!save(update({ ...active, status, nextObservationAt: new Date(Date.parse(c.now()) + LEAD_BACKOFF_MS).toISOString(), ...(response.outcome === 'incomplete' ? { failure: response.reason } : {}) })))
        return stale();
      return wait(`Native lead ${status}: original request retained without resend.`);
    } };
}
/** Direct store callers have the same atomic consumption obligation as the reducer. */
export function assertNativeLeadTransition(previous: Run, next: Run): void {
  const oldLength = previous.repairAdmissions?.length ?? 0;
  const added = (next.repairAdmissions ?? []).slice(oldLength);
  for (const a of added) {
    if (previous.nativeReview?.repairLimit !== undefined && (a.budgetLimit !== previous.nativeReview.repairLimit || previous.history.filter(h => h.type === 'start_fix').length >= previous.nativeReview.repairLimit))
      throw new Error('Native durable shared repair budget changed or exhausted.');
    if ((previous.nativeReview !== undefined || previous.nativeLead !== undefined) && previous.reviewResult?.verdict === 'request_changes' && !leadConsumptionValid(previous, a.leadDisposition))
      throw new Error('Native start_fix requires exact one-time qualified disposition consumption.');
    if (a.leadDisposition && (next.history[previous.history.length]?.type !== 'start_fix' || next.history[previous.history.length]?.repairAdmissionIndex !== oldLength || a.attemptBinding?.startFixHistoryIndex !== previous.history.length || added.length !== 1))
      throw new Error('Native lead consumption must be the same atomic admission/start_fix CAS.');
  }
  if (previous.nativeReview && next.history.slice(previous.history.length).some(h => h.type === 'start_fix') && added.length !== 1)
    throw new Error('Native repair cannot bypass atomic admission.');
}
export function issuedLeadRecoveryConfiguration(run: Run): import('../dispatch/config.js').DispatchConfiguration {
  const c = run.nativeLead?.recoveryConfiguration;
  if (!c || !nativeLeadCoherent(run) || !unresolvedNativeLead(run) || c.owner.toLowerCase() !== run.target.owner.toLowerCase() || c.repo.toLowerCase() !== run.target.repo.toLowerCase())
    throw new Error('Issued lead recovery lacks its immutable dispatch control location.');
  return structuredClone(c);
}
/** Digest of the exact service-authenticated payload, excluding its separate authentication envelope. */
export function leadPayloadDigest(e: Extract<NativeLeadEvidence, {
  kind: 'terminal';
}>): string { const { authentication: _authentication, ...payload } = e; return oracleDigest(payload); }
