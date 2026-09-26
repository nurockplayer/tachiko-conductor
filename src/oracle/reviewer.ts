import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../adapters/reviewer.js';
import type { ReviewResult, Target } from '../domain/types.js';
import { canonicalReviewTarget, classifyReviewRisk, type ReviewRiskDecision } from '../reviewers/risk-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  ORACLE_LIMITS,
  receiptFromReview,
  type OracleFailureCode,
  type OracleEffort,
  type OracleReviewerBinding,
  type OracleReceipt,
  type OracleReceiptStore,
  type OracleReviewTransport,
  type OracleTransportRequest,
  type OracleTransportResult,
} from './types.js';

export type OracleReviewerErrorCode = 'ORACLE_INVALID_OUTPUT' | 'ORACLE_STALE_HEAD' | 'ORACLE_TRANSPORT_FAILED' | 'ORACLE_GITHUB_FAILED' | 'ORACLE_POLICY_HOLD';

export class OracleReviewerError extends Error {
  readonly code: OracleReviewerErrorCode;
  readonly retryable: boolean;

  constructor(code: OracleReviewerErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'OracleReviewerError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface OracleReviewerOptions {
  readonly github: GitHubAdapter;
  readonly transport: OracleReviewTransport;
  readonly receipts?: OracleReceiptStore;
  readonly now?: () => string;
  readonly reviewerName?: string;
  /** Trusted synchronous source for complete candidate evidence, bound to the exact request. */
  readonly candidateEvidence?: (request: Readonly<ReviewRequest>) => unknown;
  /** Trusted configuration supplied by the host, not by the caller or model. */
  readonly binding?: OracleReviewerBinding;
}

interface LiveIdentity { readonly headSha: string; readonly baseSha: string; readonly pullRequestNumber: number }
function freezeCopy<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
  };
  freeze(copy);
  return copy;
}

function selectEffort(policy: Extract<ReviewRiskDecision, { outcome: 'review' }>): OracleEffort {
  return policy.floor === 'R5' ? 'Extra High' : policy.floor === 'R4' ? 'High' : 'Medium';
}
function selectSemanticTier(policy: Extract<ReviewRiskDecision, { outcome: 'review' }>): 'R3' | 'R4' | 'R5' { return policy.floor === 'R1' || policy.floor === 'R2' || policy.floor === 'R3' ? 'R3' : policy.floor; }

function validBinding(value: OracleReviewerBinding | undefined): value is OracleReviewerBinding {
  const binding = asRecord(value);
  if (binding === null || Object.keys(binding).some((key) => !['bindingId', 'model', 'supportedEfforts', 'independentReadOnly', 'available'].includes(key))) return false;
  const efforts = safeArray(binding.supportedEfforts, 3);
  return binding.available === true && binding.independentReadOnly === true && typeof binding.bindingId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(binding.bindingId) && typeof binding.model === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(binding.model) && efforts !== null && efforts.length > 0 && efforts.every((effort) => effort === 'Medium' || effort === 'High' || effort === 'Extra High') && new Set(efforts).size === efforts.length;
}

function policyReceipt(decision: Extract<ReviewRiskDecision, { outcome: 'review' }>, effort: OracleEffort, binding: OracleReviewerBinding, effectiveModel: string | null, effectiveEffort: OracleEffort | null, requestCorrelationId: string, coverageComplete: boolean, pullRequestNumber: number | null = null) {
  const coverage = createHash('sha256').update(JSON.stringify([...decision.changedPaths].sort())).digest('hex');
  return { version: decision.policyVersion, floor: decision.floor, selectedSemanticTier: selectSemanticTier(decision), requestedEffort: effort, effectiveEffort, reasons: decision.reasons, criticalReason: decision.criticalReason ?? null, baseSha: decision.baseSha, pullRequestNumber, changedPathCount: decision.changedPaths.length, coverageSha256: coverage, requestCorrelationId, requestedModel: binding.model, effectiveModel, bindingId: binding.bindingId, coverageComplete } as const;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !('value' in descriptor))) return null;
    return value as Record<string, unknown>;
  } catch { return null; }
}

function safeArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index++) if (!descriptors[String(index)] || !('value' in descriptors[String(index)]!)) return null;
    if (Object.keys(descriptors).some((key) => key !== 'length' && !/^\d+$/.test(key))) return null;
    return Array.from({ length: value.length }, (_, index) => descriptors[String(index)]!.value as unknown);
  } catch { return null; }
}

function snapshotTransportResult(value: unknown): OracleTransportResult {
  const result = asRecord(value);
  if (result === null) throw new Error('malformed transport result');
  if (result.outcome === 'failure') {
    if (Object.keys(result).some((key) => !['outcome', 'code', 'retryable'].includes(key)) || !['unavailable', 'unauthorized', 'timeout', 'transport_failed', 'invalid_response'].includes(String(result.code)) || typeof result.retryable !== 'boolean') throw new Error('malformed transport failure');
    return Object.freeze({ outcome: 'failure', code: result.code as OracleFailureCode, retryable: result.retryable });
  }
  if (result.outcome !== 'success' || Object.keys(result).some((key) => !['outcome', 'output', 'observation'].includes(key)) || typeof result.output !== 'string' || result.output.length > ORACLE_LIMITS.output) throw new Error('malformed transport success');
  const observation = asRecord(result.observation);
  if (observation === null || Object.keys(observation).some((key) => !['verified', 'bindingId', 'effectiveModel', 'effectiveEffort', 'requestCorrelationId', 'targetKey', 'pullRequestNumber', 'headSha', 'baseSha', 'coverageComplete', 'changedPaths'].includes(key))) throw new Error('malformed transport observation');
  const paths = safeArray(observation.changedPaths, 200);
  if (observation.verified !== true || typeof observation.bindingId !== 'string' || observation.bindingId.length < 1 || observation.bindingId.length > 120 || typeof observation.effectiveModel !== 'string' || observation.effectiveModel.length < 1 || observation.effectiveModel.length > 160 || !['Medium', 'High', 'Extra High'].includes(String(observation.effectiveEffort)) || typeof observation.requestCorrelationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(observation.requestCorrelationId) || typeof observation.targetKey !== 'string' || observation.targetKey.length < 1 || observation.targetKey.length > 300 || !Number.isSafeInteger(observation.pullRequestNumber) || Number(observation.pullRequestNumber) < 1 || typeof observation.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(observation.headSha) || typeof observation.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(observation.baseSha) || observation.coverageComplete !== true || paths === null || !paths.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 240)) throw new Error('malformed transport observation');
  return freezeCopy({ outcome: 'success', output: result.output, observation: { verified: true, bindingId: observation.bindingId, effectiveModel: observation.effectiveModel, effectiveEffort: observation.effectiveEffort as OracleEffort, requestCorrelationId: observation.requestCorrelationId, targetKey: observation.targetKey, pullRequestNumber: Number(observation.pullRequestNumber), headSha: observation.headSha, baseSha: observation.baseSha, coverageComplete: true, changedPaths: paths as string[] } });
}

function targetText(target: Target): string {
  return target.kind === 'issue' ? `${target.owner}/${target.repo}#${target.issueNumber}` : `${target.owner}/${target.repo}@${target.branch}${target.publicationBranch === undefined ? '' : `#publication=${target.publicationBranch}`}`;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function makeReceiptId(targetKey: string, headSha: string, requestCorrelationId: string): string {
  const digest = createHash('sha256').update(JSON.stringify(['oracle-receipt/v1', targetKey, headSha])).digest('hex');
  return `oracle-${digest}-${requestCorrelationId}`;
}

function parseOutput(raw: string, headSha: string, reviewerName: string): ReviewResult {
  if (typeof raw !== 'string') throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output was not text.');
  if (raw.length > ORACLE_LIMITS.output) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output exceeded the bounded review limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output was not valid JSON.'); }
  const value = asRecord(parsed);
  if (value === null) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output was not a JSON object.');
  const allowed = new Set(['verdict', 'reviewed_head_sha', 'blocking_findings', 'non_blocking_suggestions']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output contained an unknown field.');
  if (value.reviewed_head_sha !== headSha) throw new OracleReviewerError('ORACLE_STALE_HEAD', 'Oracle output was bound to a different HEAD.');
  if (value.verdict !== 'PASS' && value.verdict !== 'REQUEST_CHANGES') throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle output contained an unknown verdict.');

  const parseFindings = (input: unknown, severity: 'blocking' | 'non_blocking', name: string) => {
    if (!Array.isArray(input) || input.length > ORACLE_LIMITS.findings) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', `${name} was not a bounded array.`);
    return input.map((item) => {
      const finding = asRecord(item);
      if (finding === null || typeof finding.summary !== 'string' || finding.summary.trim() === '' || finding.summary.length > ORACLE_LIMITS.summary) {
        throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', `${name} contained an invalid summary.`);
      }
      if (finding.detail !== undefined && (typeof finding.detail !== 'string' || finding.detail.length > ORACLE_LIMITS.detail)) {
        throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', `${name} contained an invalid detail.`);
      }
      const detail = typeof finding.detail === 'string' && finding.detail.trim() !== '' ? finding.detail.trim() : undefined;
      return { severity, summary: finding.summary.trim(), ...(detail === undefined ? {} : { detail }) };
    });
  };
  const blocking = parseFindings(value.blocking_findings, 'blocking', 'blocking_findings');
  const suggestions = parseFindings(value.non_blocking_suggestions, 'non_blocking', 'non_blocking_suggestions');
  if (blocking.length + suggestions.length > ORACLE_LIMITS.findings) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle returned too many total findings.');
  if (value.verdict === 'PASS' && blocking.length > 0) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle returned PASS with blocking findings.');
  if (value.verdict === 'REQUEST_CHANGES' && blocking.length === 0) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle requested changes without blocking findings.');
  return { verdict: value.verdict === 'PASS' ? 'approve' : 'request_changes', reviewerName, headSha, findings: [...blocking, ...suggestions] };
}

export class OracleReviewer implements ReviewerAdapter {
  readonly kind = 'reviewer' as const;
  private readonly options: OracleReviewerOptions;
  constructor(options: OracleReviewerOptions) {
    const github = options.github;
    const transport = options.transport;
    const trustedGitHub = Object.freeze({
      kind: 'github' as const,
      readIssue: github.readIssue.bind(github), readBranch: github.readBranch.bind(github),
      listPullRequests: github.listPullRequests.bind(github), readLiveSnapshot: github.readLiveSnapshot.bind(github),
      ...(github.createImplementationPullRequest === undefined ? {} : { createImplementationPullRequest: github.createImplementationPullRequest.bind(github) }),
    });
    const trustedTransport = Object.freeze({ consult: transport.consult.bind(transport) });
    const trustedBinding = validBinding(options.binding) ? freezeCopy(options.binding!) : undefined;
    this.options = Object.freeze({ ...options, github: trustedGitHub, transport: trustedTransport, binding: trustedBinding });
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const input = asRecord(request);
    const requestTarget = input === null ? null : canonicalReviewTarget(input.target);
    if (input === null || Object.keys(input).some((key) => !['target', 'headSha', 'instructions'].includes(key)) || typeof input.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(input.headSha) || requestTarget === null || (input.instructions !== undefined && (typeof input.instructions !== 'string' || input.instructions.length > ORACLE_LIMITS.instructions))) throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Oracle review request identity or shape is invalid.');
    request = freezeCopy(request);
    const requestedTargetKey = requestTarget.key;
    const now = this.options.now ?? (() => new Date().toISOString());
    const requestCorrelationId = randomUUID();
    const id = makeReceiptId(requestedTargetKey, request.headSha, requestCorrelationId);
    // Resolve and freeze all trusted decision inputs synchronously before any await.
    if (this.options.candidateEvidence === undefined || this.options.binding === undefined) {
      this.options.receipts?.record(this.failureReceipt(id, request, 'invalid_response', now()));
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Trusted candidate evidence or qualified Oracle binding is unavailable.');
    }
    if (!validBinding(this.options.binding)) {
      this.options.receipts?.record(this.failureReceipt(id, request, 'invalid_response', now()));
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Trusted candidate evidence or qualified Oracle binding is unavailable.');
    }
    const binding = this.options.binding;
    let evidence: unknown;
    try { evidence = this.options.candidateEvidence(freezeCopy(request)); } catch {
      this.options.receipts?.record(this.failureReceipt(id, request, 'invalid_response', now()));
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Trusted candidate evidence could not be resolved.');
    }
    const decision = freezeCopy(classifyReviewRisk(evidence));
    if (decision.outcome !== 'review' || decision.headSha !== request.headSha || decision.targetKey !== requestedTargetKey) {
      this.options.receipts?.record(this.failureReceipt(id, request, 'invalid_response', now()));
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', `Candidate evidence did not qualify for review (${decision.outcome === 'hold' ? decision.reasons.join(', ') : 'target or HEAD mismatch'}).`);
    }
    const effort = selectEffort(decision);
    if (!binding.supportedEfforts.includes(effort)) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'invalid_response', now()), policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false) });
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', `Qualified Oracle binding does not support required ${effort} effort.`);
    }
    const before = await this.identity(request.target);
    if (before === null || before.headSha !== request.headSha || before.baseSha !== decision.baseSha) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'stale_head', now()), observedHeadSha: before?.headSha ?? null, policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false) });
      throw new OracleReviewerError('ORACLE_STALE_HEAD', 'Live HEAD/base or unique associated open PR does not match candidate evidence.', true);
    }
    const frozenTarget = freezeCopy(request.target);
    const transportRequest: OracleTransportRequest = freezeCopy({
      ...request, target: frozenTarget, prompt: JSON.stringify({ target: targetText(frozenTarget), head_sha: request.headSha, base_sha: decision.baseSha, risk_policy: decision, selected_semantic_tier: selectSemanticTier(decision), requested_model: binding.model, requested_effort: effort, pull_request_number: before.pullRequestNumber, complete_candidate_paths: decision.changedPaths, instructions: request.instructions ?? '' }),
      policy: decision, selectedSemanticTier: selectSemanticTier(decision), binding, requestedEffort: effort, requestCorrelationId,
      pullRequest: { number: before.pullRequestNumber, baseSha: before.baseSha },
    });
    let rawResponse: unknown;
    try {
      rawResponse = await this.options.transport.consult(transportRequest);
    } catch {
      const afterFailure = await this.identity(request.target);
      if (afterFailure === null || before.headSha !== afterFailure.headSha || before.baseSha !== afterFailure.baseSha || before.pullRequestNumber !== afterFailure.pullRequestNumber) {
        this.options.receipts?.record({ ...this.failureReceipt(id, request, 'stale_head', now()), observedHeadSha: afterFailure?.headSha ?? null, policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
        throw new OracleReviewerError('ORACLE_STALE_HEAD', 'Live HEAD/base or associated PR identity moved during Oracle consultation.', true);
      }
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'transport_failed', now()), policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_TRANSPORT_FAILED', 'Oracle transport threw while consulting.', true);
    }
    let response: OracleTransportResult;
    try { response = snapshotTransportResult(rawResponse); } catch {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'invalid_response', now()), policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Oracle transport returned a malformed or unbounded result.');
    }
    const responseRecord = asRecord(response);
    if (responseRecord === null || (responseRecord.outcome !== 'success' && responseRecord.outcome !== 'failure')) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'invalid_response', now()), policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Oracle transport returned a malformed result.');
    }
    const after = await this.identity(request.target);
    if (after === null || before.headSha !== after.headSha || before.baseSha !== after.baseSha || before.pullRequestNumber !== after.pullRequestNumber) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'stale_head', now()), observedHeadSha: after?.headSha ?? null, policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_STALE_HEAD', 'Live HEAD/base or associated PR identity moved during Oracle consultation.', true);
    }
    if (response.outcome === 'failure') {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, response.code, now()), policy: policyReceipt(decision, effort, binding, null, null, requestCorrelationId, false, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_TRANSPORT_FAILED', `Oracle transport failed: ${response.code}.`, response.retryable);
    }
    const observed = asRecord(response.observation);
    const coverageMatches = observed?.coverageComplete === true && Array.isArray(observed.changedPaths) && JSON.stringify(observed.changedPaths) === JSON.stringify(decision.changedPaths);
    if (observed === null || observed.verified !== true || observed.bindingId !== binding.bindingId || observed.effectiveModel !== binding.model || observed.effectiveEffort !== effort || observed.requestCorrelationId !== requestCorrelationId || observed.targetKey !== requestedTargetKey || observed.pullRequestNumber !== before.pullRequestNumber || observed.headSha !== request.headSha || observed.baseSha !== before.baseSha || !coverageMatches) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'invalid_response', now()), observedHeadSha: request.headSha, policy: policyReceipt(decision, effort, binding, typeof observed?.effectiveModel === 'string' ? observed.effectiveModel : null, observed?.effectiveEffort === 'Medium' || observed?.effectiveEffort === 'High' || observed?.effectiveEffort === 'Extra High' ? observed.effectiveEffort : null, requestCorrelationId, coverageMatches, before.pullRequestNumber) });
      throw new OracleReviewerError('ORACLE_POLICY_HOLD', 'Oracle transport observation did not verify the configured binding and complete candidate coverage.');
    }
    let result: ReviewResult;
    try {
      result = parseOutput(response.output, request.headSha, this.options.reviewerName ?? 'oracle');
    } catch (error) {
      const stale = error instanceof OracleReviewerError && error.code === 'ORACLE_STALE_HEAD';
      this.options.receipts?.record({
        ...this.failureReceipt(id, request, stale ? 'stale_head' : 'invalid_response', now()), policy: policyReceipt(decision, effort, binding, String(observed.effectiveModel), observed.effectiveEffort as OracleEffort, requestCorrelationId, true, before.pullRequestNumber),
        observedHeadSha: stale ? request.headSha : null,
      });
      throw error;
    }
    this.options.receipts?.record({ ...receiptFromReview(id, request, result, now()), policyQualified: true, policy: policyReceipt(decision, effort, binding, String(observed.effectiveModel), observed.effectiveEffort as OracleEffort, requestCorrelationId, true, before.pullRequestNumber) });
    return result;
  }

  private failureReceipt(id: string, request: ReviewRequest, code: OracleFailureCode | 'stale_head', reviewedAt: string): OracleReceipt {
    return { id, target: request.target, requestedHeadSha: request.headSha, observedHeadSha: null, outcome: code === 'stale_head' ? 'stale_head' : 'failed', reviewedAt, blockingFindingCount: 0, nonBlockingFindingCount: 0, failureCode: code, policyQualified: false };
  }

  private async identity(target: Target): Promise<LiveIdentity | null> {
    try {
      if (target.kind === 'issue') {
        const snapshot: GitHubLiveSnapshot = await this.options.github.readLiveSnapshot(target);
        if (snapshot.repository.owner !== target.owner || snapshot.repository.repo !== target.repo || snapshot.issue.number !== target.issueNumber || snapshot.issue.state !== 'open' || snapshot.problems.length > 0 || snapshot.pullRequest === null || snapshot.pullRequest.state !== 'open' || !Number.isSafeInteger(snapshot.pullRequest.number) || snapshot.pullRequest.number < 1 || snapshot.pullRequest.headSha !== snapshot.headSha || !/^[0-9a-f]{40}$/i.test(snapshot.pullRequest.baseSha)) return null;
        return { headSha: snapshot.headSha ?? '', baseSha: snapshot.pullRequest.baseSha, pullRequestNumber: snapshot.pullRequest.number };
      }
      const [branchValue, prsValue] = await Promise.all([this.options.github.readBranch(target), this.options.github.listPullRequests(target)]);
      const branch = asRecord(branchValue);
      const associatedNumbers = branch === null ? null : safeArray(branch.pullRequestNumbers, 200);
      const listedPullRequests = safeArray(prsValue, 200);
      if (branch === null || canonicalReviewTarget(branch.target)?.key !== canonicalReviewTarget(target)?.key || typeof branch.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(branch.headSha) || associatedNumbers === null || associatedNumbers.length === 0 || !associatedNumbers.every((number) => Number.isSafeInteger(number) && Number(number) > 0) || new Set(associatedNumbers).size !== associatedNumbers.length || listedPullRequests === null) return null;
      const parsedPullRequests = listedPullRequests.map((item) => {
        const pr = asRecord(item);
        if (pr === null || !Number.isSafeInteger(pr.number) || Number(pr.number) <= 0 || typeof pr.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(pr.headSha) || typeof pr.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(pr.baseSha) || !['open', 'closed', 'merged'].includes(String(pr.state))) return null;
        return { number: Number(pr.number), headSha: pr.headSha, baseSha: pr.baseSha, state: pr.state };
      });
      if (parsedPullRequests.some((pr) => pr === null) || new Set(parsedPullRequests.map((pr) => pr!.number)).size !== parsedPullRequests.length) return null;
      const open = parsedPullRequests.filter((pr) => pr!.state === 'open').map((pr) => pr!.number);
      if (open.length !== associatedNumbers.length || open.some((number) => !associatedNumbers.includes(number))) return null;
      const uniqueOpen = parsedPullRequests.filter((pr) => pr!.state === 'open');
      if (uniqueOpen.length !== 1 || uniqueOpen[0]!.headSha !== branch.headSha) return null;
      return { headSha: branch.headSha, baseSha: uniqueOpen[0]!.baseSha, pullRequestNumber: uniqueOpen[0]!.number };
    } catch (error) {
      if (error instanceof OracleReviewerError) throw error;
      throw new OracleReviewerError('ORACLE_GITHUB_FAILED', `GitHub identity read failed: ${errorText(error)}`, true);
    }
  }
}
