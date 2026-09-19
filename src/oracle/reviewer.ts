import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../adapters/reviewer.js';
import type { ReviewResult, Target } from '../domain/types.js';
import {
  ORACLE_LIMITS,
  receiptFromReview,
  type OracleFailureCode,
  type OracleReceipt,
  type OracleReceiptStore,
  type OracleReviewTransport,
  type OracleTransportRequest,
  type OracleTransportResult,
} from './types.js';

export type OracleReviewerErrorCode = 'ORACLE_INVALID_OUTPUT' | 'ORACLE_STALE_HEAD' | 'ORACLE_TRANSPORT_FAILED' | 'ORACLE_GITHUB_FAILED';

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
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function targetText(target: Target): string {
  return target.kind === 'issue' ? `${target.owner}/${target.repo}#${target.issueNumber}` : `${target.owner}/${target.repo}@${target.branch}`;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function makeReceiptId(target: Target, headSha: string, now: string): string {
  return `oracle-${targetText(target).replace(/[^A-Za-z0-9._-]/g, '-')}-${headSha.slice(0, 12)}-${now.replace(/[^0-9]/g, '').slice(-14)}`;
}

function parseOutput(raw: string, headSha: string, reviewerName: string): ReviewResult {
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
  if (value.verdict === 'PASS' && blocking.length > 0) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle returned PASS with blocking findings.');
  if (value.verdict === 'REQUEST_CHANGES' && blocking.length === 0) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle requested changes without blocking findings.');
  return { verdict: value.verdict === 'PASS' ? 'approve' : 'request_changes', reviewerName, headSha, findings: [...blocking, ...suggestions] };
}

export class OracleReviewer implements ReviewerAdapter {
  readonly kind = 'reviewer' as const;
  private readonly options: OracleReviewerOptions;
  constructor(options: OracleReviewerOptions) { this.options = options; }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    if (!/^[0-9a-f]{40}$/i.test(request.headSha)) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle review requires a 40-hex HEAD SHA.');
    if (request.instructions !== undefined && request.instructions.length > ORACLE_LIMITS.instructions) throw new OracleReviewerError('ORACLE_INVALID_OUTPUT', 'Oracle instructions exceeded the bounded limit.');
    const now = this.options.now ?? (() => new Date().toISOString());
    const id = makeReceiptId(request.target, request.headSha, now());
    const before = await this.identity(request.target);
    if (before !== request.headSha) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'stale_head', now()), observedHeadSha: before });
      throw new OracleReviewerError('ORACLE_STALE_HEAD', `Live HEAD ${before ?? '(none)'} does not match requested HEAD ${request.headSha}.`, true);
    }
    const transportRequest: OracleTransportRequest = { ...request, prompt: JSON.stringify({ target: targetText(request.target), head_sha: request.headSha, instructions: request.instructions ?? '' }) };
    let response: OracleTransportResult;
    try {
      response = await this.options.transport.consult(transportRequest);
    } catch {
      this.options.receipts?.record(this.failureReceipt(id, request, 'transport_failed', now()));
      throw new OracleReviewerError('ORACLE_TRANSPORT_FAILED', 'Oracle transport threw while consulting.', true);
    }
    if (response.outcome === 'failure') {
      this.options.receipts?.record(this.failureReceipt(id, request, response.code, now()));
      throw new OracleReviewerError('ORACLE_TRANSPORT_FAILED', `Oracle transport failed: ${response.code}.`, response.retryable);
    }
    const after = await this.identity(request.target);
    if (before !== after) {
      this.options.receipts?.record({ ...this.failureReceipt(id, request, 'stale_head', now()), observedHeadSha: after });
      throw new OracleReviewerError('ORACLE_STALE_HEAD', `Live HEAD moved during Oracle review from ${before} to ${after ?? '(none)'}.`, true);
    }
    let result: ReviewResult;
    try {
      result = parseOutput(response.output, request.headSha, this.options.reviewerName ?? 'oracle');
    } catch (error) {
      const stale = error instanceof OracleReviewerError && error.code === 'ORACLE_STALE_HEAD';
      this.options.receipts?.record({
        ...this.failureReceipt(id, request, stale ? 'stale_head' : 'invalid_response', now()),
        observedHeadSha: stale ? request.headSha : null,
      });
      throw error;
    }
    this.options.receipts?.record(receiptFromReview(id, request, result, now()));
    return result;
  }

  private failureReceipt(id: string, request: ReviewRequest, code: OracleFailureCode | 'stale_head', reviewedAt: string): OracleReceipt {
    return { id, target: request.target, requestedHeadSha: request.headSha, observedHeadSha: null, outcome: code === 'stale_head' ? 'stale_head' : 'failed', reviewedAt, blockingFindingCount: 0, nonBlockingFindingCount: 0, failureCode: code };
  }

  private async identity(target: Target): Promise<string | null> {
    try {
      if (target.kind === 'issue') {
        const snapshot: GitHubLiveSnapshot = await this.options.github.readLiveSnapshot(target);
        return snapshot.pullRequest === null ? null : snapshot.headSha;
      }
      const branch = await this.options.github.readBranch(target);
      return branch.headSha;
    } catch (error) {
      if (error instanceof OracleReviewerError) throw error;
      throw new OracleReviewerError('ORACLE_GITHUB_FAILED', `GitHub identity read failed: ${errorText(error)}`, true);
    }
  }
}
