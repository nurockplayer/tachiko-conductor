import type { ReviewResult, Target } from '../domain/types.js';

export const ORACLE_LIMITS = {
  instructions: 4_000,
  output: 16_000,
  summary: 500,
  detail: 2_000,
  findings: 20,
} as const;

export interface OracleReviewRequest {
  readonly target: Target;
  readonly headSha: string;
  readonly instructions?: string;
}

export interface OracleTransportRequest extends OracleReviewRequest {
  /** A bounded, already-rendered review prompt. */
  readonly prompt: string;
}

export type OracleFailureCode =
  | 'unavailable'
  | 'unauthorized'
  | 'timeout'
  | 'transport_failed'
  | 'invalid_response';

export type OracleTransportResult =
  | { readonly outcome: 'success'; readonly output: string }
  | { readonly outcome: 'failure'; readonly code: OracleFailureCode; readonly retryable: boolean };

export type OracleReceipt = {
  readonly id: string;
  readonly target: Target;
  readonly requestedHeadSha: string;
  readonly observedHeadSha: string | null;
  readonly outcome: 'approved' | 'request_changes' | 'failed' | 'stale_head';
  readonly reviewedAt: string;
  readonly blockingFindingCount: number;
  readonly nonBlockingFindingCount: number;
  readonly failureCode?: OracleFailureCode | 'stale_head';
};

export interface OracleReceiptStore {
  record(receipt: OracleReceipt): void;
  list(): readonly OracleReceipt[];
}

export interface OracleReviewTransport {
  consult(request: OracleTransportRequest): Promise<OracleTransportResult>;
}

export function receiptFromReview(
  id: string,
  request: OracleReviewRequest,
  result: ReviewResult,
  reviewedAt: string,
): OracleReceipt {
  return {
    id,
    target: request.target,
    requestedHeadSha: request.headSha,
    observedHeadSha: result.headSha,
    outcome: result.verdict === 'approve' ? 'approved' : 'request_changes',
    reviewedAt,
    blockingFindingCount: result.findings.filter((finding) => finding.severity === 'blocking').length,
    nonBlockingFindingCount: result.findings.filter((finding) => finding.severity === 'non_blocking').length,
  };
}
