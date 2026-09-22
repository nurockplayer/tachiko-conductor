import type { LocalValidationEvidence } from '../domain/types.js';
import type { IssueTarget } from '../domain/types.js';
import type { HostedCheckPolicy } from '../validation/hosted-policy.js';

/** One explicitly configured executable and its bounded wall-clock limit. */
export interface LocalValidationCommandConfiguration {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

/** Repository/run-owned local validation configuration. */
export interface LocalValidationConfiguration {
  readonly revision: string;
  readonly commands: readonly LocalValidationCommandConfiguration[];
  /** Host-owned browser artifacts; never inferred from a user cache. */
  readonly playwrightBrowsersPath?: string;
  /** Absolute host-provisioned runtime used by the macOS sandboxed lane. */
  readonly nodeProgram?: string;
  /** Absolute host-provisioned pnpm executable; never resolved from PATH. */
  readonly pnpmProgram?: string;
  /** Read-only host artifact containing a lockfile-bound pnpm store. */
  readonly dependencyArtifactPath?: string;
  /**
   * Explicit clean checkout for a supported pre-existing-PR run. It is never
   * inferred from the conductor process cwd and must prove target repository
   * identity before commands execute.
   */
  readonly workspacePath?: string;
  /**
   * Host-owned clean checkout used to prove that ignored dependencies in an
   * owned worker workspace pre-date the worker.  Its ignored-state manifest
   * must exactly match before local commands may consume those bytes.
   */
  readonly trustedIgnoredBaselinePath?: string;
}

/** Explicit repository/run policy used to interpret the live hosted check list. */
export interface HostedCheckPolicyConfiguration {
  readonly revision: string;
  readonly policy: HostedCheckPolicy;
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
  /** Non-empty stable identity for the command plan whose evidence may be admitted. */
  readonly configRevision: string;
  /** This boundary refuses ambient working directories and needs the owned bootstrap workspace. */
  readonly requiresOwnedWorkspace?: boolean;
  validate(request: ValidationRequest): Promise<LocalValidationEvidence>;
}
