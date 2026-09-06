/**
 * Core domain types for Tachiko Conductor.
 *
 * These types must stay free of any transport or model coupling: nothing in the
 * core knows about Claude Code, DeepSeek, GitHub's API, Linear, or a specific
 * repository. GitHub is the future engineering source of truth, but the
 * workflow core only ever sees plain data.
 */

/** The work item a run operates on. */
export type Target = IssueTarget | RepositoryTarget;

/** A run bound to a single GitHub issue (the primary target). */
export interface IssueTarget {
  readonly kind: 'issue';
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

/** A run bound to a whole repository (used for work that has no issue). */
export interface RepositoryTarget {
  readonly kind: 'repository';
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

/** Explicit workflow states (issue #2). */
export const WORKFLOW_STATES = [
  'READY',
  'IMPLEMENTING',
  'VALIDATING',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'FINAL_GATE',
  'MERGE_READY',
  'MERGED',
  'WAITING_DEPENDENCY',
  'NEEDS_HUMAN',
  'FAILED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Named events that drive the workflow forward. */
export const TRANSITION_TYPES = [
  'start',
  'bootstrap_prepared',
  'agent_succeeded',
  'agent_failed',
  'validation_passed',
  'validation_failed',
  'review_approved',
  'changes_requested',
  'start_fix',
  'revalidate',
  'gate_blocked',
  'merged',
  'wait_dependency',
  'dependency_satisfied',
  'escalate',
  'human_resolved',
  'fail',
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** Immutable local identity selected before an issue implementation begins. */
export interface ImplementationBootstrapIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly workspacePath: string;
}

/** The exact live pull request identity a prepared run has accepted. */
export interface ImplementationPullRequestIdentity {
  readonly number: number;
  readonly headSha: string;
}

/** Outcome of an implementation agent run. */
export type AgentExitStatus = 'success' | 'failure';

/** Provider-neutral durable identity for continuing one logical executor. */
export interface ExecutorIdentity {
  readonly provider: string;
  readonly sessionId: string;
}

export interface AgentResult {
  readonly exitStatus: AgentExitStatus;
  readonly summary: string;
  /** Exact commit SHA the agent's work is at, when known. */
  readonly headSha?: string;
  readonly changedFiles?: readonly string[];
  readonly diagnostics?: readonly string[];
  /** Durable identity used to reconstruct the same executor after restart. */
  readonly executor?: ExecutorIdentity;
  /** Opaque executor session token used to continue this logical run. */
  readonly sessionId?: string;
  /** Wall-clock execution duration. Raw transcripts and model usage are not retained. */
  readonly durationMs?: number;
}

export type ReviewVerdict = 'approve' | 'request_changes';

export interface ReviewFinding {
  readonly severity: 'blocking' | 'non_blocking';
  readonly summary: string;
  readonly detail?: string;
}

export interface ReviewResult {
  readonly verdict: ReviewVerdict;
  readonly reviewerName: string;
  /** Exact HEAD SHA this review was performed against. Never inferred. */
  readonly headSha: string;
  readonly findings: readonly ReviewFinding[];
}

/** A fail-closed validation outcome. `waiting` is reserved for a re-checkable external dependency. */
export type ValidationStatus = 'passed' | 'failed' | 'waiting' | 'unknown';

/** Compact, secret-free result for one explicitly configured local command. */
export interface LocalValidationCommandEvidence {
  readonly commandIndex: number;
  readonly executable: string;
  readonly outcome: 'passed' | 'failed' | 'timed_out' | 'unavailable' | 'malformed';
  readonly exitCode: number | null;
  readonly durationMs: number;
}

/** Durable provenance for deterministic local validation. It intentionally excludes command output. */
export interface LocalValidationEvidence {
  readonly status: Exclude<ValidationStatus, 'waiting'>;
  readonly configRevision: string | null;
  readonly commands: readonly LocalValidationCommandEvidence[];
}

/** Compact snapshot of hosted checks observed for the run's exact PR HEAD. */
export interface HostedValidationEvidence {
  /** `not_required` is neutral policy evidence, never a synthetic passing check. */
  readonly status: ValidationStatus | 'not_required';
  readonly observedAt: string;
  readonly pullRequestNumber: number | null;
  readonly availability: 'available' | 'unavailable';
  readonly overall: 'pending' | 'passing' | 'failing' | 'unknown' | 'unavailable';
  /** Identity of the policy which interpreted the live check list, when configured. */
  readonly policyRevision: string | null;
  readonly policyMode: 'required' | 'not_required' | 'unconfigured';
  /** Required check names from that policy, when its mode is `required`. */
  readonly requiredCheckNames: readonly string[];
  /** Names observed at the exact PR HEAD; URLs and raw command output are not persisted. */
  readonly observedCheckNames: readonly string[];
}

/** The persisted exact-HEAD validation ledger consumed by review and final readiness. */
export interface ValidationResult {
  readonly headSha: string;
  readonly status: ValidationStatus;
  readonly local: LocalValidationEvidence;
  readonly hosted: HostedValidationEvidence;
}

/** Why a run is paused waiting on a human or an external dependency. */
export type InterruptKind = 'needs_human' | 'waiting_dependency';

export interface Interrupt {
  readonly kind: InterruptKind;
  readonly reason: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  /** Structured context that a human decision should consider, when known. */
  readonly evidence?: string;
  /** Bounded choices offered to the human, when they are known. */
  readonly choices?: readonly string[];
}

/** One applied step in a run's history. */
export interface TransitionRecord {
  /** The workflow-owned final authority records this event after live reconciliation. */
  readonly type: TransitionType | 'final_gate_verified';
  readonly from: WorkflowState;
  readonly to: WorkflowState;
  readonly at: string;
  readonly reason?: string;
}

/** Payload for a single transition application. */
export interface TransitionInput {
  readonly type: TransitionType;
  readonly reason?: string;
  /** Carried into the run; required for `agent_succeeded`. */
  readonly agentResult?: AgentResult;
  /** Carried into the run; required for `review_approved` / `changes_requested`. */
  readonly reviewResult?: ReviewResult;
  /** Exact-HEAD validation evidence produced at the validation boundary. */
  readonly validationResult?: ValidationResult;
  /** Explicitly updates the run's current HEAD SHA. */
  readonly headSha?: string;
  /** Executor identity captured while an implementation is interrupted for human takeover. */
  readonly executor?: ExecutorIdentity;
  /** Durable branch/worktree identity produced before an issue starts without a PR. */
  readonly bootstrap?: ImplementationBootstrapIdentity;
  /** Live PR identity captured with a successful implementation or validation. */
  readonly pullRequest?: ImplementationPullRequestIdentity;
  /** Structured context carried onto the interrupt when entering NEEDS_HUMAN / WAITING_DEPENDENCY. */
  readonly interrupt?: {
    readonly evidence?: string;
    readonly choices?: readonly string[];
  };
}

/**
 * A persisted unit of work. Immutable by convention: transitions produce a new
 * Run value and the store persists that snapshot.
 */
export interface Run {
  readonly id: string;
  readonly target: Target;
  readonly state: WorkflowState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly history: readonly TransitionRecord[];
  /** While paused in WAITING_DEPENDENCY / NEEDS_HUMAN, the state to resume to. */
  readonly interruptedFrom?: WorkflowState;
  readonly interrupt?: Interrupt;
  readonly agentResult?: AgentResult;
  /** Durable provider/session identity for reconstructing implementation continuation. */
  readonly executor?: ExecutorIdentity;
  /** Immutable local implementation identity, once prepared. */
  readonly bootstrap?: ImplementationBootstrapIdentity;
  /** Accepted live PR identity for later recovery and exact-head review. */
  readonly pullRequest?: ImplementationPullRequestIdentity;
  /** Latest review result, bound to an exact HEAD SHA. */
  readonly reviewResult?: ReviewResult;
  /** Latest validation result, bound to an exact HEAD SHA. */
  readonly validationResult?: ValidationResult;
  /** Current HEAD SHA of the implementation, when known. */
  readonly headSha?: string;
}
