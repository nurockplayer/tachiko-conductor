import type { LocalValidationEvidence } from '../domain/types.js';
import type { IssueTarget } from '../domain/types.js';

/** One explicitly configured executable and its bounded wall-clock limit. */
export interface LocalValidationCommandConfiguration {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

/** Repository/run-owned local validation configuration. */
export interface LocalValidationConfiguration {
  readonly revision: string;
  readonly commands: readonly LocalValidationCommandConfiguration[];
}

/** Per-invocation context for local validation. */
export interface ValidationRequest {
  /** Issue whose implementation is being validated. */
  readonly target: IssueTarget;
  /** Exact implementation HEAD that the caller observed before validation. */
  readonly headSha: string;
  /** Owned worktree verified by the implementation bootstrap, when available. */
  readonly workspacePath?: string;
}

/** Provider-neutral boundary for Conductor-observed local validation. */
export interface ValidationAdapter {
  readonly kind: 'validation';
  /** Stable identity for the command plan whose successful evidence may be reused. */
  readonly configRevision?: string;
  /** This boundary refuses ambient working directories and needs the owned bootstrap workspace. */
  readonly requiresOwnedWorkspace?: boolean;
  validate(request: ValidationRequest): Promise<LocalValidationEvidence>;
}
