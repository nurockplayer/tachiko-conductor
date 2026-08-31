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
  'agent_succeeded',
  'agent_failed',
  'validation_passed',
  'validation_failed',
  'review_approved',
  'changes_requested',
  'start_fix',
  'gate_passed',
  'gate_blocked',
  'merged',
  'wait_dependency',
  'dependency_satisfied',
  'escalate',
  'human_resolved',
  'fail',
] as const;

export type TransitionType = (typeof TRANSITION_TYPES)[number];

/** Outcome of an implementation agent run. */
export type AgentExitStatus = 'success' | 'failure';

export interface AgentResult {
  readonly exitStatus: AgentExitStatus;
  readonly summary: string;
  /** Exact commit SHA the agent's work is at, when known. */
  readonly headSha?: string;
  readonly changedFiles?: readonly string[];
  readonly diagnostics?: readonly string[];
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
  readonly type: TransitionType;
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
  /** Explicitly updates the run's current HEAD SHA. */
  readonly headSha?: string;
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
  /** Latest review result, bound to an exact HEAD SHA. */
  readonly reviewResult?: ReviewResult;
  /** Current HEAD SHA of the implementation, when known. */
  readonly headSha?: string;
}
