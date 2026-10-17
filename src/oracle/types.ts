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
  /** Immutable evidence only. The Run CAS remains the lifecycle authority. */
  recordNative?(evidence: NativeOracleEvidence): void;
  readNative?(id: string): NativeOracleEvidence | null;
  recordLead?(evidence: import('./native-lead.js').NativeLeadEvidence): void;
  readLead?(id: string): import('./native-lead.js').NativeLeadEvidence | null;
  /** Trusted host authentication must succeed before immutable completion publication. */
  recordAuthenticatedCompletion?(namespace: 'review' | 'lead', evidence: import('./completion-proof.js').CompletionEvidence, authenticate: (evidence: import('./completion-proof.js').CompletionEvidence) => boolean): import('./completion-proof.js').NativeCompletionProof;
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

/** Complete readable blobs and diff, obtained from host-owned immutable Git objects. */
export interface NativeSourceManifest {
  readonly baseSha: string;
  readonly headSha: string;
  readonly files: readonly {
    readonly path: string;
    readonly base: { readonly oid: string; readonly text: string; readonly sha256: string } | null;
    readonly head: { readonly oid: string; readonly text: string; readonly sha256: string } | null;
  }[];
  readonly diff: string;
  readonly sourceSha256: string;
  readonly diffSha256: string;
}

export interface NativeReviewIdentity {
  readonly requestId: string;
  readonly correlationId: string;
  readonly runId: string;
  readonly claimId: string;
  readonly missionId: string;
  readonly laneId: string;
  readonly ownerGeneration: number;
  readonly phase: 'review';
  readonly targetKey: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly baseSha: string;
  readonly headSha: string;
  readonly contractRevision: string;
  readonly role: 'independent-reviewer';
  readonly scope: string;
  readonly policyRevision: string;
  readonly bindingId: string;
  readonly requestedModel: string;
  readonly requestedEffort: OracleEffort;
  readonly floor: ReviewRiskTier;
  readonly sourceSha256: string;
  readonly diffSha256: string;
}

export interface NativeReviewRequestState {
  readonly identity: NativeReviewIdentity;
  readonly status: 'pending' | 'qualified_complete' | 'incomplete' | 'terminal_unknown' | 'retired' | 'replaced';
  readonly submissionPossible: boolean;
  readonly observations: number;
  readonly nextObservationAt: string;
  /** Only a URL actually returned by the qualified boundary is retained. */
  readonly conversationUrl?: string;
  readonly failure?: 'transport_failure' | 'safety_refusal' | 'missing_evidence';
  readonly replacedBy?: string;
  readonly terminalDigest?: string;
  readonly completionProof?: import('./completion-proof.js').NativeCompletionProof;
  readonly terminalStatus?: 'incomplete' | 'terminal_unknown';
  readonly retirementReason?: 'irrecoverable_transport';
}

export interface NativeReviewAcceptance {
  readonly requestId: string;
  readonly receiptId: string;
  readonly digest: string;
  readonly identity: NativeReviewIdentity;
}

export type NativeOracleEvidence =
  | { readonly id: string; readonly kind: 'request'; readonly identity: NativeReviewIdentity; readonly manifest: NativeSourceManifest }
  | { readonly id: string; readonly kind: 'terminal'; readonly identity: NativeReviewIdentity; readonly result: ReviewResult;
      readonly authentication: { readonly actorId: string; readonly model: string; readonly effort: OracleEffort; readonly transportReceipt: string } };

export type NativeReviewObservation =
  | { readonly outcome: 'pending'; readonly conversationUrl?: string }
  | { readonly outcome: 'terminal_unknown'; readonly conversationUrl?: string }
  | { readonly outcome: 'incomplete'; readonly reason: 'transport_failure' | 'safety_refusal' | 'missing_evidence'; readonly conversationUrl?: string }
  | { readonly outcome: 'complete'; readonly evidence: Extract<NativeOracleEvidence, { kind: 'terminal' }>; readonly conversationUrl?: string };

/** Host-injected accepted-release boundary. No production binding is supplied by default.
 * authenticate verifies service evidence independently of model-authored output. */
export interface NativeReviewerHost {
  readonly binding: {
    readonly bindingId: string;
    readonly contractRevision: string;
    readonly policyRevision: string;
    readonly scope: string;
    readonly model: string;
    readonly supportedEfforts: readonly OracleEffort[];
    readonly authorActorIds: readonly string[];
    readonly allowTransportReplacement: boolean;
  };
  readonly receipts: OracleReceiptStore;
  readonly source: (baseSha: string, headSha: string) => NativeSourceManifest;
  readonly submit: (request: Extract<NativeOracleEvidence, { kind: 'request' }>) => Promise<NativeReviewObservation>;
  readonly observe?: (identity: NativeReviewIdentity, conversationUrl?: string) => Promise<NativeReviewObservation>;
  /** Explicit trusted disposition, never inferred from timeout, empty discovery, or safety refusal. */
  readonly replacementDisposition?: (request: NativeReviewRequestState) => 'irrecoverable_transport' | 'unavailable';
  readonly authenticate: (evidence: Extract<NativeOracleEvidence, { kind: 'terminal' }>) => boolean;
}
