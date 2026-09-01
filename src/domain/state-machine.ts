import { LIVE_HEAD_SYNC_DECISION, canSynchronizeInterruptedHead } from './decisions.js';
import type { ReviewResult, Run, TransitionInput, TransitionType, WorkflowState } from './types.js';

/** Why a transition was rejected. */
export type InvalidTransitionCode =
  | 'terminal-state'
  | 'unknown-transition'
  | 'missing-payload'
  | 'wrong-verdict'
  | 'contradictory-review'
  | 'wrong-exit-status'
  | 'unexpected-payload'
  | 'head-mutation-not-allowed'
  | 'missing-head-sha'
  | 'empty-head-sha'
  | 'conflicting-head-sha'
  | 'stale-review'
  | 'fresh-review'
  | 'no-interrupt-context';

/**
 * Thrown when a transition cannot be applied. The message is actionable: it
 * names the invalid transition, the current state, and what is allowed.
 */
export class InvalidTransitionError extends Error {
  readonly code: InvalidTransitionCode;
  readonly fromState: WorkflowState;
  readonly transition: TransitionType;

  constructor(
    code: InvalidTransitionCode,
    fromState: WorkflowState,
    transition: TransitionType,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidTransitionError';
    this.code = code;
    this.fromState = fromState;
    this.transition = transition;
  }
}

/** `'RESUME'` means "return to the state the run was interrupted from". */
export type TransitionTarget = WorkflowState | 'RESUME';

/**
 * The workflow transition table. Each source state lists the transitions it
 * accepts; anything not listed is rejected loudly by `applyTransition`.
 * The `Readonly<Partial<...>>` shape keeps every state covered while letting
 * each state list exactly the transitions it accepts.
 */
export const TRANSITION_TABLE: Readonly<
  Record<WorkflowState, Readonly<Partial<Record<TransitionType, TransitionTarget>>>>
> = {
  READY: {
    start: 'IMPLEMENTING',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  IMPLEMENTING: {
    agent_succeeded: 'VALIDATING',
    agent_failed: 'FAILED',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  VALIDATING: {
    validation_passed: 'REVIEWING',
    validation_failed: 'CHANGES_REQUESTED',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  REVIEWING: {
    review_approved: 'FINAL_GATE',
    changes_requested: 'CHANGES_REQUESTED',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  CHANGES_REQUESTED: {
    start_fix: 'IMPLEMENTING',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  FINAL_GATE: {
    gate_passed: 'MERGE_READY',
    gate_blocked: 'REVIEWING',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  MERGE_READY: {
    merged: 'MERGED',
    wait_dependency: 'WAITING_DEPENDENCY',
    escalate: 'NEEDS_HUMAN',
    fail: 'FAILED',
  },
  MERGED: {},
  WAITING_DEPENDENCY: {
    dependency_satisfied: 'RESUME',
    fail: 'FAILED',
  },
  NEEDS_HUMAN: {
    human_resolved: 'RESUME',
    fail: 'FAILED',
  },
  FAILED: {},
};

/** Transitions that must carry an implementation agent result. */
const REQUIRES_AGENT_RESULT: ReadonlySet<TransitionType> = new Set([
  'agent_succeeded',
  'agent_failed',
]);

/** Transitions that must carry a reviewer result. */
const REQUIRES_REVIEW_RESULT: ReadonlySet<TransitionType> = new Set([
  'review_approved',
  'changes_requested',
]);

/**
 * Implementation events normally own HEAD changes. The separately validated
 * human-sync path is an explicit bounded exception for a live GitHub identity
 * the operator chose to adopt; every other transition leaves HEAD untouched.
 */
const HEAD_UPDATING_TRANSITIONS: ReadonlySet<TransitionType> = new Set([
  'agent_succeeded',
  'agent_failed',
]);

function isAuthorizedHumanHeadSync(run: Run, input: TransitionInput): boolean {
  return (
    input.type === 'human_resolved' &&
    input.reason?.trim() === LIVE_HEAD_SYNC_DECISION &&
    run.state === 'NEEDS_HUMAN' &&
    canSynchronizeInterruptedHead(run.interruptedFrom) &&
    run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION) === true
  );
}

/** Whether a transition requires a result payload, and which kind. */
export function transitionRequiresResult(type: TransitionType): 'agent' | 'review' | 'none' {
  if (REQUIRES_AGENT_RESULT.has(type)) return 'agent';
  if (REQUIRES_REVIEW_RESULT.has(type)) return 'review';
  return 'none';
}

/** Transitions allowed out of a state, sorted for stable diagnostics. */
export function allowedTransitions(state: WorkflowState): readonly TransitionType[] {
  return Object.keys(TRANSITION_TABLE[state]).sort() as TransitionType[];
}

/** A state with no outgoing transitions is terminal. */
export function isTerminal(state: WorkflowState): boolean {
  return allowedTransitions(state).length === 0;
}

export function canTransition(from: WorkflowState, type: TransitionType): boolean {
  return type in TRANSITION_TABLE[from];
}

/**
 * Whether a review result is bound to the run's current HEAD. The run's HEAD
 * must be present and non-empty, and the review must name exactly that SHA:
 * an empty or stale review identity never counts as fresh.
 */
function isReviewBoundToHead(run: Run, review: ReviewResult): boolean {
  return run.headSha !== undefined && run.headSha.trim() !== '' && review.headSha === run.headSha;
}

/** An approval cannot coexist with a finding that still blocks readiness. */
function isReviewInternallyConsistent(review: ReviewResult): boolean {
  return review.verdict !== 'approve' || review.findings.every((finding) => finding.severity !== 'blocking');
}

/**
 * Whether the run's latest stored review is bound to its current HEAD SHA.
 * Both SHAs must be present and non-empty: an empty or whitespace-only
 * identity never counts as fresh, so it can never satisfy the final gate.
 */
export function isReviewFresh(run: Run): boolean {
  return run.reviewResult !== undefined && isReviewBoundToHead(run, run.reviewResult);
}

/** A usable SHA identity: present and not empty after trimming whitespace. */
function isUsableSha(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function assertPayload(run: Run, input: TransitionInput): void {
  const from = run.state;
  if (REQUIRES_AGENT_RESULT.has(input.type) && input.agentResult === undefined) {
    throw new InvalidTransitionError(
      'missing-payload',
      from,
      input.type,
      `Transition "${input.type}" requires an agentResult; pass the implementation agent's result.`,
    );
  }
  if (REQUIRES_REVIEW_RESULT.has(input.type) && input.reviewResult === undefined) {
    throw new InvalidTransitionError(
      'missing-payload',
      from,
      input.type,
      `Transition "${input.type}" requires a reviewResult; pass the reviewer's result.`,
    );
  }
  // Payloads are bound to the transitions that produce them; carrying one on
  // an unrelated transition is rejected rather than silently ignored.
  if (!REQUIRES_AGENT_RESULT.has(input.type) && input.agentResult !== undefined) {
    throw new InvalidTransitionError(
      'unexpected-payload',
      from,
      input.type,
      `Transition "${input.type}" does not accept an agentResult; agent results are bound to agent_succeeded / agent_failed.`,
    );
  }
  if (!REQUIRES_REVIEW_RESULT.has(input.type) && input.reviewResult !== undefined) {
    throw new InvalidTransitionError(
      'unexpected-payload',
      from,
      input.type,
      `Transition "${input.type}" does not accept a reviewResult; review results are bound to review_approved / changes_requested.`,
    );
  }
  const authorizedHumanHeadSync = isAuthorizedHumanHeadSync(run, input);
  if (!HEAD_UPDATING_TRANSITIONS.has(input.type) && !authorizedHumanHeadSync && input.headSha !== undefined) {
    throw new InvalidTransitionError(
      'head-mutation-not-allowed',
      from,
      input.type,
      `Transition "${input.type}" cannot change the run's HEAD SHA without an explicitly offered live-HEAD synchronization decision.`,
    );
  }
  if (authorizedHumanHeadSync && input.headSha?.trim() === '') {
    throw new InvalidTransitionError(
      'empty-head-sha',
      from,
      input.type,
      'Live-HEAD synchronization requires a non-empty exact HEAD SHA.',
    );
  }
  if (authorizedHumanHeadSync && input.headSha === undefined) {
    throw new InvalidTransitionError(
      'missing-head-sha',
      from,
      input.type,
      'Live-HEAD synchronization requires an exact HEAD SHA.',
    );
  }
  // Event and result semantics must agree: an agent event carries a result
  // whose exit status matches it, mirroring the review-verdict checks below.
  if (input.type === 'agent_succeeded' && input.agentResult !== undefined && input.agentResult.exitStatus !== 'success') {
    throw new InvalidTransitionError(
      'wrong-exit-status',
      from,
      input.type,
      `Transition "agent_succeeded" requires an agentResult with exitStatus "success", got "${input.agentResult.exitStatus}".`,
    );
  }
  if (input.type === 'agent_failed' && input.agentResult !== undefined && input.agentResult.exitStatus !== 'failure') {
    throw new InvalidTransitionError(
      'wrong-exit-status',
      from,
      input.type,
      `Transition "agent_failed" requires an agentResult with exitStatus "failure", got "${input.agentResult.exitStatus}".`,
    );
  }
  // A successful implementation must report the exact commit it produced;
  // otherwise a stale HEAD could linger and be reviewed as if it were current.
  if (input.type === 'agent_succeeded') {
    const inputSha = input.headSha;
    const resultSha = input.agentResult?.headSha;
    if (inputSha !== undefined && inputSha.trim() === '') {
      throw new InvalidTransitionError(
        'empty-head-sha',
        from,
        input.type,
        `Transition "agent_succeeded" got an empty input.headSha; a HEAD SHA must be a non-empty identity.`,
      );
    }
    if (resultSha !== undefined && resultSha.trim() === '') {
      throw new InvalidTransitionError(
        'empty-head-sha',
        from,
        input.type,
        `Transition "agent_succeeded" got an empty agentResult.headSha; a HEAD SHA must be a non-empty identity.`,
      );
    }
    if (!isUsableSha(inputSha) && !isUsableSha(resultSha)) {
      throw new InvalidTransitionError(
        'missing-head-sha',
        from,
        input.type,
        `Transition "agent_succeeded" requires an exact HEAD SHA; provide it via input.headSha or agentResult.headSha.`,
      );
    }
    if (isUsableSha(inputSha) && isUsableSha(resultSha) && inputSha.trim() !== resultSha.trim()) {
      throw new InvalidTransitionError(
        'conflicting-head-sha',
        from,
        input.type,
        `Transition "agent_succeeded" got conflicting HEAD SHAs: input.headSha "${inputSha}" vs agentResult.headSha "${resultSha}".`,
      );
    }
  }
  if (input.type === 'human_resolved' && input.headSha !== undefined && input.headSha.trim() === '') {
    throw new InvalidTransitionError(
      'empty-head-sha',
      from,
      input.type,
      `Transition "human_resolved" got an empty input.headSha; omit it or provide the exact live GitHub HEAD.`,
    );
  }
  if (input.type === 'review_approved' && input.reviewResult !== undefined && input.reviewResult.verdict !== 'approve') {
    throw new InvalidTransitionError(
      'wrong-verdict',
      from,
      input.type,
      `Transition "review_approved" requires a reviewResult with verdict "approve", got "${input.reviewResult?.verdict ?? 'none'}".`,
    );
  }
  if (input.type === 'changes_requested' && input.reviewResult !== undefined && input.reviewResult.verdict !== 'request_changes') {
    throw new InvalidTransitionError(
      'wrong-verdict',
      from,
      input.type,
      `Transition "changes_requested" requires a reviewResult with verdict "request_changes", got "${input.reviewResult?.verdict ?? 'none'}".`,
    );
  }
  if (
    input.type === 'review_approved' &&
    input.reviewResult !== undefined &&
    !isReviewInternallyConsistent(input.reviewResult)
  ) {
    throw new InvalidTransitionError(
      'contradictory-review',
      from,
      input.type,
      `Transition "review_approved" cannot accept an approval that contains blocking findings; route those findings through "changes_requested".`,
    );
  }
  // A review event must be bound to the run's current HEAD: unlike an
  // approval (which is re-checked at FINAL_GATE), a stale change request has
  // no later freshness gate, so reject it here before it drives a fix loop.
  if (input.type === 'review_approved' || input.type === 'changes_requested') {
    const review = input.reviewResult;
    if (review !== undefined && !isReviewBoundToHead(run, review)) {
      throw new InvalidTransitionError(
        'stale-review',
        from,
        input.type,
        `Transition "${input.type}" requires a reviewResult bound to the run's current HEAD "${run.headSha ?? '(none)'}", got "${review.headSha}".`,
      );
    }
  }
}

/** The final gate must only pass on a review bound to the exact current HEAD. */
function assertGate(run: Run, input: TransitionInput): void {
  if (
    input.type === 'gate_passed' &&
    run.reviewResult !== undefined &&
    run.reviewResult.verdict !== 'approve'
  ) {
    throw new InvalidTransitionError(
      'wrong-verdict',
      run.state,
      input.type,
      `Final gate cannot pass: the latest review verdict is "${run.reviewResult.verdict}", not "approve". Route it back to reviewing and the fix loop.`,
    );
  }
  if (
    input.type === 'gate_passed' &&
    run.reviewResult !== undefined &&
    !isReviewInternallyConsistent(run.reviewResult)
  ) {
    throw new InvalidTransitionError(
      'contradictory-review',
      run.state,
      input.type,
      `Final gate cannot pass: the latest approval contains blocking findings. Route those findings through "changes_requested".`,
    );
  }
  if (input.type === 'gate_passed' && !isReviewFresh(run)) {
    throw new InvalidTransitionError(
      'stale-review',
      run.state,
      input.type,
      `Final gate cannot pass: the latest review is bound to SHA "${run.reviewResult?.headSha ?? '(none)'}" but the run is at "${run.headSha ?? '(none)'}". Review the current HEAD before advancing.`,
    );
  }
  if (
    input.type === 'gate_blocked' &&
    isReviewFresh(run) &&
    run.reviewResult !== undefined &&
    run.reviewResult.verdict === 'approve' &&
    isReviewInternallyConsistent(run.reviewResult)
  ) {
    throw new InvalidTransitionError(
      'fresh-review',
      run.state,
      input.type,
      `Final gate cannot be marked blocked: the latest review is already fresh for SHA "${run.headSha}". Use "gate_passed".`,
    );
  }
}

/**
 * Apply a transition to a run, returning the new run snapshot.
 *
 * Invalid transitions are rejected with an `InvalidTransitionError` carrying
 * an actionable message; the machine never silently coerces. `now` is
 * injectable so tests can be deterministic.
 */
export function applyTransition(
  run: Run,
  input: TransitionInput,
  now: string = new Date().toISOString(),
): Run {
  const from = run.state;
  const target = TRANSITION_TABLE[from][input.type];

  if (target === undefined) {
    const allowed = allowedTransitions(from);
    throw new InvalidTransitionError(
      isTerminal(from) ? 'terminal-state' : 'unknown-transition',
      from,
      input.type,
      isTerminal(from)
        ? `Run ${run.id} is in terminal state ${from}; no transitions are allowed.`
        : `Invalid transition "${input.type}" from state ${from}. Allowed transitions: ${allowed.join(', ')}.`,
    );
  }

  assertPayload(run, input);
  assertGate(run, input);
  const authorizedHumanHeadSync = isAuthorizedHumanHeadSync(run, input);

  let to: WorkflowState;
  if (target === 'RESUME') {
    if (run.interruptedFrom === undefined) {
      throw new InvalidTransitionError(
        'no-interrupt-context',
        from,
        input.type,
        `Transition "${input.type}" requires the run to have been interrupted from a known state, but run ${run.id} has no interruptedFrom.`,
      );
    }
    to = authorizedHumanHeadSync ? 'VALIDATING' : run.interruptedFrom;
  } else {
    to = target;
  }

  const enteringInterrupt = to === 'WAITING_DEPENDENCY' || to === 'NEEDS_HUMAN';
  const leavingInterrupt = from === 'WAITING_DEPENDENCY' || from === 'NEEDS_HUMAN';
  // HEAD changes only on implementation events or an exact, explicitly
  // offered live-HEAD synchronization decision. The value is normalized.
  const headSha = HEAD_UPDATING_TRANSITIONS.has(input.type) || authorizedHumanHeadSync
    ? (input.headSha ?? input.agentResult?.headSha)?.trim()
    : undefined;

  const next: Run = {
    ...run,
    state: to,
    updatedAt: now,
    history: [...run.history, { type: input.type, from, to, at: now, reason: input.reason }],
    ...(input.agentResult !== undefined ? { agentResult: input.agentResult } : {}),
    ...(input.reviewResult !== undefined ? { reviewResult: input.reviewResult } : {}),
    ...(headSha !== undefined && headSha !== '' ? { headSha } : {}),
    ...(enteringInterrupt
      ? {
          interruptedFrom: from,
          interrupt: {
            kind: to === 'NEEDS_HUMAN' ? 'needs_human' : 'waiting_dependency',
            reason: input.reason ?? '',
            createdAt: now,
            ...(input.interrupt?.evidence === undefined ? {} : { evidence: input.interrupt.evidence }),
            ...(input.interrupt?.choices === undefined || input.interrupt.choices.length === 0
              ? {}
              : { choices: [...input.interrupt.choices] }),
          },
        }
      : {}),
    ...(leavingInterrupt
      ? {
          interruptedFrom: undefined,
          ...(run.interrupt !== undefined ? { interrupt: { ...run.interrupt, resolvedAt: now } } : {}),
        }
      : {}),
  };

  return next;
}
