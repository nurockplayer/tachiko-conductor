import type { ReviewResult, Target } from '../domain/types.js';
import type { ReviewRiskDecision, ReviewRiskReason, ReviewRiskTier } from '../reviewers/risk-policy.js';

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
  readonly policy: Extract<ReviewRiskDecision, { outcome: 'review' }>;
  readonly selectedSemanticTier: ReviewRiskTier;
  readonly binding: OracleReviewerBinding;
  readonly requestedEffort: OracleEffort;
  readonly requestCorrelationId: string;
  readonly pullRequest: { readonly number: number; readonly baseSha: string };
}

export type OracleEffort = 'Medium' | 'High' | 'Extra High';
export interface OracleReviewerBinding {
  readonly bindingId: string;
  readonly model: string;
  readonly supportedEfforts: readonly OracleEffort[];
  readonly independentReadOnly: true;
  readonly available: true;
}

/** Separate transport observation. It must be produced by a qualified transport, never parsed from model output. */
export interface OracleTransportObservation {
  readonly verified: true;
  readonly bindingId: string;
  readonly effectiveModel: string;
  readonly effectiveEffort: OracleEffort;
  readonly requestCorrelationId: string;
  readonly targetKey: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly coverageComplete: true;
  readonly changedPaths: readonly string[];
}

export type OracleFailureCode =
  | 'unavailable'
  | 'unauthorized'
  | 'timeout'
  | 'transport_failed'
  | 'invalid_response';

export type OracleTransportResult =
  | { readonly outcome: 'success'; readonly output: string; readonly observation: OracleTransportObservation }
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
  /** Explicitly distinguishes policy-qualified approvals from legacy receipts. */
  readonly policyQualified?: boolean;
  /** Absent on legacy receipts, which are never policy-qualified. */
  readonly policy?: {
    readonly version: 'risk-policy/v1';
    readonly floor: ReviewRiskTier;
    readonly selectedSemanticTier: ReviewRiskTier;
    readonly requestedEffort: OracleEffort;
    readonly effectiveEffort: OracleEffort | null;
    readonly reasons: readonly ReviewRiskReason[];
    readonly criticalReason: string | null;
    readonly baseSha: string;
    readonly pullRequestNumber: number | null;
    readonly changedPathCount: number;
    readonly coverageSha256: string;
    readonly requestCorrelationId: string;
    readonly requestedModel: string;
    readonly effectiveModel: string | null;
    readonly bindingId: string;
    readonly coverageComplete: boolean;
  };
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
