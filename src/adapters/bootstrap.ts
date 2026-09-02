import type { ImplementationBootstrapIdentity, IssueTarget } from '../domain/types.js';

export interface PrepareImplementationBootstrapRequest {
  readonly runId: string;
  readonly target: IssueTarget;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly existing?: ImplementationBootstrapIdentity;
}

export type PlanImplementationBootstrapRequest = Omit<PrepareImplementationBootstrapRequest, 'existing'>;

export interface VerifyDurableImplementationRequest {
  readonly identity: ImplementationBootstrapIdentity;
  readonly expectedHeadSha: string;
}

export interface DurableImplementationSnapshot {
  readonly headSha: string;
  readonly branch: string;
}

/** Provider-neutral Git/workspace mechanics used before invoking an implementation engine. */
export interface ImplementationBootstrapAdapter {
  readonly kind: 'implementation-bootstrap';
  /** Read-only collision/base checks and deterministic identity resolution. */
  plan(request: PlanImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity>;
  /** Realize or reconstruct an identity that the Run already persisted. */
  prepare(request: PrepareImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity>;
  verifyDurable(request: VerifyDurableImplementationRequest): Promise<DurableImplementationSnapshot>;
}

export const IMPLEMENTATION_BOOTSTRAP_ERROR_CODE = {
  INVALID_REQUEST: 'BOOTSTRAP_INVALID_REQUEST',
  REPOSITORY_MISMATCH: 'BOOTSTRAP_REPOSITORY_MISMATCH',
  BASE_DRIFT: 'BOOTSTRAP_BASE_DRIFT',
  COLLISION: 'BOOTSTRAP_COLLISION',
  STALE_IDENTITY: 'BOOTSTRAP_STALE_IDENTITY',
  COMMAND_FAILED: 'BOOTSTRAP_COMMAND_FAILED',
  DIRTY_WORKSPACE: 'BOOTSTRAP_DIRTY_WORKSPACE',
  UNPUSHED_HEAD: 'BOOTSTRAP_UNPUSHED_HEAD',
  HEAD_MISMATCH: 'BOOTSTRAP_HEAD_MISMATCH',
} as const;

export type ImplementationBootstrapErrorCode =
  (typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE)[keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE];

export class ImplementationBootstrapError extends Error {
  readonly code: ImplementationBootstrapErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ImplementationBootstrapErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ImplementationBootstrapError';
    this.code = code;
    this.details = details;
  }
}
