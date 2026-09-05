import type { ImplementationBootstrapIdentity, IssueTarget } from '../domain/types.js';
import type { WorkspaceGuard } from './agent.js';

/** Ephemeral proof that recovery is bound to the persisted and live PR head. */
export interface BootstrapRecoveryAuthority {
  readonly expectedHeadSha: string;
}

export interface BootstrapPlanRequest {
  readonly runId: string;
  readonly target: IssueTarget;
  readonly baseBranch: string;
  readonly baseSha: string;
}

export interface BootstrapPrepareRequest extends BootstrapPlanRequest {
  readonly existing: ImplementationBootstrapIdentity;
  readonly recoveryAuthority?: BootstrapRecoveryAuthority;
}

export interface VerifyDurableRequest {
  readonly identity: ImplementationBootstrapIdentity;
  readonly expectedHeadSha: string;
  readonly progressBaseSha?: string;
  readonly workspaceGuard?: WorkspaceGuard;
}

export interface DurableImplementationSnapshot {
  readonly headSha: string;
  readonly branch: string;
}

/** Provider-neutral local Git boundary. Nothing here chooses or manages providers. */
export interface ImplementationBootstrapAdapter {
  readonly kind: 'implementation-bootstrap';
  plan(request: BootstrapPlanRequest): Promise<ImplementationBootstrapIdentity>;
  prepare(request: BootstrapPrepareRequest): Promise<ImplementationBootstrapIdentity>;
  /** Re-check all mutable workspace identity evidence immediately before spawn. */
  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard;
  verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot>;
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

  constructor(code: ImplementationBootstrapErrorCode, message: string) {
    super(message);
    this.name = 'ImplementationBootstrapError';
    this.code = code;
  }
}
