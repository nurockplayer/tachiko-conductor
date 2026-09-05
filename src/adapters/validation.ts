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
}

/** Provider-neutral boundary for Conductor-observed local validation. */
export interface ValidationAdapter {
  readonly kind: 'validation';
  validate(request: ValidationRequest): Promise<LocalValidationEvidence>;
}
