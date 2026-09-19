import { createHash } from 'node:crypto';

/**
 * Provider-neutral wait/observation contract for issue #47.
 *
 * Runtime observation is deliberately separate from model-wake eligibility:
 * observing (or failing to observe) must never start a model turn by itself.
 * A wake event is only ever a *signal to reconcile* against authoritative
 * state (live GitHub plus the durable Run); it is never workflow authority.
 */

export const WAIT_OBSERVATION_REVISION = 'wait-observation-v1' as const;
export const WAIT_WAKE_POLICY_REVISION = 'wait-wake-policy-v1' as const;

const WAIT_SUBJECT_STATUSES: readonly WaitSubjectStatus[] = ['idle', 'active', 'completed', 'failed', 'blocked', 'unknown', 'unavailable'];
const WAIT_OBSERVATION_SOURCES: readonly WaitObservationSource[] = ['native', 'runtime', 'subprocess', 'github'];
const WAIT_CHANGE_KINDS: readonly WaitChangeKind[] = ['none', 'progress', 'completion', 'failure', 'blocked'];
const WAIT_WAKE_REASONS: readonly WaitWakeReason[] = ['completion', 'failure', 'blocked', 'terminal', 'timeout-policy'];

/** The provider family that produced one observation. Never a model identity. */
export type WaitObservationSource = 'native' | 'runtime' | 'subprocess' | 'github';

/** Normalized lifecycle of the observed subject, independent of any provider vocabulary. */
export type WaitSubjectStatus = 'idle' | 'active' | 'completed' | 'failed' | 'blocked' | 'unknown' | 'unavailable';

/**
 * Bounded evidence categories. Only categorical/progress information crosses
 * this boundary: raw transcripts, prose, and tool output are never persisted.
 */
export type WaitEvidenceKind =
  | 'turn-started'
  | 'turn-completed'
  | 'item-completed'
  | 'head-changed'
  | 'status-changed'
  | 'progress'
  | 'failure'
  | 'blocked'
  | 'unavailable';

export interface WaitEvidence {
  readonly kind: WaitEvidenceKind;
  readonly detail: string;
}

/** One provider-neutral observation of a worker/subprocess/runtime subject. */
export interface WaitObservation {
  readonly revision: typeof WAIT_OBSERVATION_REVISION;
  readonly source: WaitObservationSource;
  /** Stable subject identity (native thread id, run id, process/command identity). */
  readonly subjectId: string;
  readonly status: WaitSubjectStatus;
  /** Active work item identity when the provider reports one. */
  readonly activeItemId?: string;
  /** Monotonic progress counters only; never provider prose. */
  readonly progress: {
    readonly items: number;
    readonly turns: number;
  };
  /** Most recent completed native turn identity, when the provider reports one. */
  readonly lastCompletedTurnId?: string;
  readonly headSha: string | null;
  /** Bounded, normalized evidence. Never raw output. */
  readonly evidence: readonly WaitEvidence[];
  readonly observedAt: string;
}

export interface WaitObservationState {
  readonly source: WaitObservationSource;
  readonly subjectId: string;
  readonly status: WaitSubjectStatus;
  readonly activeItemId: string | null;
  readonly items: number;
  readonly turns: number;
  /**
   * Identity of the most recent completed native turn. Monotonic and uncapped,
   * so two distinct turn completions can never normalize to one digest once a
   * provider's bounded history has saturated.
   */
  readonly lastCompletedTurnId: string | null;
  readonly headSha: string | null;
}

/**
 * Outcome of comparing one observation with the previous normalized state.
 * `none` means the observation carried no meaningful change and MUST NOT wake.
 */
export type WaitChangeKind = 'none' | 'progress' | 'completion' | 'failure' | 'blocked';

export interface WaitChange {
  readonly kind: WaitChangeKind;
  readonly meaningful: boolean;
  readonly evidence: readonly WaitEvidence[];
}

/** What the model wake is for. Progress-only change never appears here. */
export type WaitWakeReason = 'completion' | 'failure' | 'blocked' | 'terminal' | 'timeout-policy';

export interface WaitWakeDecision {
  readonly shouldWake: boolean;
  readonly reason: WaitWakeReason | null;
  readonly evidence: readonly WaitEvidence[];
}

export interface WaitWakePolicy {
  readonly revision: typeof WAIT_WAKE_POLICY_REVISION;
  /** Bounded wait before the runtime surfaces a timeout decision. */
  readonly timeoutMs: number;
  /**
   * Resolve what a timeout means. `continue` keeps waiting model-free; any
   * policy/recovery reason wakes the orchestrator exactly once with the
   * timeout as evidence.
   */
  readonly onTimeout: 'continue' | 'policy-action';
}

export const DEFAULT_WAIT_WAKE_POLICY: WaitWakePolicy = Object.freeze({
  revision: WAIT_WAKE_POLICY_REVISION,
  timeoutMs: 15 * 60_000,
  onTimeout: 'continue',
});

/** Provider-observable state that needs no model turn to detect. */
export interface WaitSubjectSnapshot {
  readonly status: WaitSubjectStatus;
  readonly activeItemId?: string;
  readonly items?: number;
  readonly turns?: number;
  readonly lastCompletedTurnId?: string;
  readonly headSha?: string | null;
  readonly evidence?: readonly WaitEvidence[];
}

export interface WaitObservationInput {
  readonly source: WaitObservationSource;
  readonly subjectId: string;
  readonly snapshot: WaitSubjectSnapshot;
  readonly observedAt: string;
}

/** Normalize an arbitrary provider report into the one provider-neutral shape. */
export function normalizeWaitObservation(input: WaitObservationInput): WaitObservation {
  return {
    revision: WAIT_OBSERVATION_REVISION,
    source: input.source,
    subjectId: input.subjectId,
    status: input.snapshot.status,
    ...(input.snapshot.activeItemId === undefined ? {} : { activeItemId: input.snapshot.activeItemId }),
    progress: { items: input.snapshot.items ?? 0, turns: input.snapshot.turns ?? 0 },
    ...(input.snapshot.lastCompletedTurnId === undefined ? {} : { lastCompletedTurnId: input.snapshot.lastCompletedTurnId }),
    headSha: input.snapshot.headSha ?? null,
    evidence: input.snapshot.evidence ?? [],
    observedAt: input.observedAt,
  };
}

export function waitObservationState(observation: WaitObservation): WaitObservationState {
  return {
    source: observation.source,
    subjectId: observation.subjectId,
    status: observation.status,
    activeItemId: observation.activeItemId ?? null,
    items: observation.progress.items,
    turns: observation.progress.turns,
    lastCompletedTurnId: observation.lastCompletedTurnId ?? null,
    headSha: observation.headSha,
  };
}

export function waitObservationDigest(observation: WaitObservation): string {
  return createHash('sha256').update(JSON.stringify(waitObservationState(observation))).digest('hex');
}

/** A stable evidence digest that ignores call-order noise from one provider. */
export function waitEvidenceDigest(evidence: readonly WaitEvidence[]): string {
  const normalized = evidence
    .map((item) => `${item.kind}\u0000${item.detail}`)
    .slice()
    .sort();
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function statusEvidence(status: WaitSubjectStatus): readonly WaitEvidence[] {
  switch (status) {
    case 'completed': return [{ kind: 'turn-completed', detail: 'subject reached completed' }];
    case 'failed': return [{ kind: 'failure', detail: 'subject reached failed' }];
    case 'blocked': return [{ kind: 'blocked', detail: 'subject reached blocked' }];
    case 'unavailable': return [{ kind: 'unavailable', detail: 'subject is unavailable' }];
    case 'active': return [{ kind: 'progress', detail: 'subject is active' }];
    default: return [];
  }
}

function transitionEvidence(previous: WaitObservation, next: WaitObservation, kind: WaitEvidenceKind, detail: string): readonly WaitEvidence[] {
  return dedupeEvidence([{ kind, detail: `${detail} (${previous.status} -> ${next.status})` }, ...reportedEvidence(next)]);
}

function terminalEvidence(observation: WaitObservation, kind: 'completion' | 'failure' | 'blocked'): readonly WaitEvidence[] {
  const evidenceKind: WaitEvidenceKind = kind === 'completion' ? 'turn-completed' : kind === 'failure' ? 'failure' : 'blocked';
  return dedupeEvidence([{ kind: evidenceKind, detail: `subject ${observation.subjectId} reported ${observation.status}` }, ...reportedEvidence(observation)]);
}

/** The wake reason a classified change implies; `none` never wakes. */
export function wakeReasonForChange(change: WaitChange): WaitWakeReason | null {
  if (change.kind === 'completion') return 'completion';
  if (change.kind === 'failure') return 'failure';
  if (change.kind === 'blocked') return 'blocked';
  return null;
}

function reportedEvidence(observation: WaitObservation): readonly WaitEvidence[] {
  return observation.evidence.length === 0 ? statusEvidence(observation.status) : observation.evidence;
}

/** Keep bounded evidence readable: one entry per kind, first (most specific) wins. */
function dedupeEvidence(evidence: readonly WaitEvidence[]): readonly WaitEvidence[] {
  const seen = new Set<WaitEvidenceKind>();
  const result: WaitEvidence[] = [];
  for (const item of evidence) {
    if (seen.has(item.kind)) continue;
    seen.add(item.kind);
    result.push(item);
  }
  return result;
}

/**
 * Classify the difference between two normalized observations.
 *
 * The contract is intentionally total and fail-safe: every unhandled case
 * resolves to `none` (no wake). A `completed` -> `completed` report is not a
 * new transition, so duplicate or coalesced provider events produce exactly
 * one meaningful change.
 */
export interface WaitNativeBoundary {
  /** Completed-turn identity from the last genuine native read. */
  readonly lastNativeIdentity: string | null;
  /** Whether the immediately preceding recorded observation was a native read. */
  readonly previousWasNative: boolean;
}

export function classifyWaitChange(
  previous: WaitObservation | null,
  next: WaitObservation,
  previousNative?: WaitObservation | null,
  previousIsNative = previous?.source === 'native',
  nativeBoundary: WaitNativeBoundary = { lastNativeIdentity: previousNative?.lastCompletedTurnId ?? null, previousWasNative: previousIsNative },
): WaitChange {
  if (previous === null) {
    // The first observation establishes a baseline. A terminal baseline is
    // still meaningful (the orchestrator must reconcile it exactly once).
    if (next.status === 'completed') return { kind: 'completion', meaningful: true, evidence: terminalEvidence(next, 'completion') };
    if (next.status === 'failed') return { kind: 'failure', meaningful: true, evidence: terminalEvidence(next, 'failure') };
    if (next.status === 'blocked') return { kind: 'blocked', meaningful: true, evidence: terminalEvidence(next, 'blocked') };
    return { kind: 'none', meaningful: false, evidence: [] };
  }
  if (previous.subjectId !== next.subjectId) {
    // A different subject is never reconciled as progress on this one.
    return { kind: 'none', meaningful: false, evidence: [] };
  }
  if (waitObservationDigest(previous) === waitObservationDigest(next)) {
    // Identical normalized state: coalesced, zero wakeups.
    return { kind: 'none', meaningful: false, evidence: [] };
  }
  // A native App Server turn is complete when the same subject genuinely moves
  // from active to idle. The boundary is anchored on the closest preceding
  // *genuine native* read, so an ambiguous read in between (a transient native
  // failure, or a not-loaded thread reported as runtime provenance) neither
  // fabricates a completion nor hides a real one.
  const nativeBefore = previousNative === undefined
    ? (previous.source === 'native' ? previous : null)
    : previousNative;
  // Compare against the durable last genuine native identity, not the
  // immediately preceding record: an ambiguous read drops the identity and
  // would otherwise look like a fresh completion, and bounded history eviction
  // must not lose the anchor either.
  const priorNativeIdentity = nativeBoundary.lastNativeIdentity;
  const nextIdentity = next.lastCompletedTurnId ?? null;
  const turnIdentityAdvanced = nextIdentity !== null && nextIdentity !== priorNativeIdentity;
  // Completion boundary 1: an observed native active phase just ended.
  if (nativeBefore !== null && next.source === 'native' && nativeBefore.status === 'active' && next.status === 'idle') {
    return {
      kind: 'completion',
      meaningful: true,
      evidence: transitionEvidence(nativeBefore, next, 'turn-completed', `subject ${next.subjectId} native turn completed${next.lastCompletedTurnId === undefined ? '' : ` (${next.lastCompletedTurnId})`}`),
    };
  }
  // Completion boundary 2: the completed-turn identity advanced after at least
  // one non-native read, while the last genuine native read was idle or absent.
  // The turn ran entirely inside ambiguous reads, so the identity advance is
  // the only completion evidence there is. Requiring an intervening ambiguous
  // read is what separates this from a plain idle -> idle advance, which is
  // progress-only. A native active anchor is excluded here because boundary 1
  // already covers it.
  if (next.source === 'native' && next.status === 'idle' && turnIdentityAdvanced && !nativeBoundary.previousWasNative) {
    return {
      kind: 'completion',
      meaningful: true,
      evidence: [{ kind: 'turn-completed', detail: `completed turn ${previous.lastCompletedTurnId ?? 'none'} -> ${next.lastCompletedTurnId ?? 'none'} (active phase unobserved)` }],
    };
  }
  if (next.status !== previous.status) {
    // Terminal statuses are authoritative no matter which source reported them.
    // A durable terminal state is always surfaced through runtime provenance,
    // so a native -> runtime-terminal boundary is exactly a workflow terminal
    // transition; `sameSource` must not suppress it. Fabricated native terminal
    // statuses are impossible by construction: an ambiguous native read
    // degrades to `unknown`/`unavailable` with runtime provenance, never to
    // `failed`/`blocked`/`completed`.
    if (next.status === 'completed') return { kind: 'completion', meaningful: true, evidence: terminalEvidence(next, 'completion') };
    if (next.status === 'failed') return { kind: 'failure', meaningful: true, evidence: terminalEvidence(next, 'failure') };
    if (next.status === 'blocked') return { kind: 'blocked', meaningful: true, evidence: terminalEvidence(next, 'blocked') };
    if (next.status === 'unavailable') return { kind: 'progress', meaningful: true, evidence: transitionEvidence(previous, next, 'unavailable', `subject ${next.subjectId} became unavailable`) };
    return { kind: 'progress', meaningful: true, evidence: transitionEvidence(previous, next, 'status-changed', `subject ${next.subjectId} changed status`) };
  }
  if (next.headSha !== previous.headSha) {
    // A head move is evidence, not a decision boundary by itself.
    return {
      kind: 'progress',
      meaningful: true,
      evidence: [{ kind: 'head-changed', detail: `head ${shortSha(previous.headSha)} -> ${shortSha(next.headSha)}` }, ...(next.evidence.length === 0 ? [] : next.evidence)],
    };
  }
  // Same status: a monotonic progress advance, a new completed-turn identity,
  // an active-item change, or newly reported evidence counts as progress, and
  // progress never wakes a model.
  if (turnIdentityAdvanced) {
    // An idle -> idle identity advance is progress-only: no boundary was
    // crossed. Any genuinely unobserved completion was already handled above.
    return {
      kind: 'progress',
      meaningful: true,
      evidence: [{ kind: 'turn-completed', detail: `completed turn ${previous.lastCompletedTurnId ?? 'none'} -> ${next.lastCompletedTurnId ?? 'none'}` }],
    };
  }
  if (next.progress.items > previous.progress.items || next.progress.turns > previous.progress.turns) {
    return {
      kind: 'progress',
      meaningful: true,
      evidence: [{ kind: 'progress', detail: `progress items ${previous.progress.items}->${next.progress.items} turns ${previous.progress.turns}->${next.progress.turns}` }],
    };
  }
  if ((previous.activeItemId ?? null) !== (next.activeItemId ?? null)) {
    return { kind: 'progress', meaningful: true, evidence: [{ kind: 'item-completed', detail: `active item ${previous.activeItemId ?? 'none'} -> ${next.activeItemId ?? 'none'}` }] };
  }
  if (waitEvidenceDigest(previous.evidence) !== waitEvidenceDigest(next.evidence)) {
    return { kind: 'progress', meaningful: true, evidence: next.evidence.length === 0 ? statusEvidence(next.status) : next.evidence };
  }
  return { kind: 'none', meaningful: false, evidence: [] };
}

function shortSha(value: string | null): string {
  if (value === null || value === '') return 'none';
  return value.length <= 12 ? value : value.slice(0, 12);
}

/** True when the subject reached a state that never needs another wake. */
export function isTerminalWaitObservation(observation: WaitObservation): boolean {
  return observation.status === 'completed' || observation.status === 'failed' || observation.status === 'blocked';
}

export interface WaitWakeInput {
  readonly change: WaitChange;
  readonly observation: WaitObservation;
  /** True once the bounded wait budget for this episode is exhausted. */
  readonly timedOut?: boolean;
  readonly policy?: WaitWakePolicy;
  /** True when this subject's terminal transition has already been surfaced. */
  readonly terminalReached?: boolean;
}

/**
 * Decide whether the orchestrator model must be woken. Progress-only change
 * and an unchanged observation never wake; terminal transitions wake once;
 * a timeout wakes only when policy/recovery reasoning is genuinely required.
 */
export function decideWaitWake(input: WaitWakeInput): WaitWakeDecision {
  const policy = input.policy ?? DEFAULT_WAIT_WAKE_POLICY;
  const terminalReached = input.terminalReached === true;
  if (input.change.meaningful && (input.change.kind === 'completion' || input.change.kind === 'failure' || input.change.kind === 'blocked')) {
    return { shouldWake: true, reason: input.change.kind, evidence: input.change.evidence };
  }
  if (input.timedOut === true && policy.onTimeout === 'policy-action' && terminalReached !== true) {
    return {
      shouldWake: true,
      reason: 'timeout-policy',
      evidence: [{ kind: 'progress', detail: `bounded wait of ${policy.timeoutMs}ms ended in status ${input.observation.status}` }],
    };
  }
  return { shouldWake: false, reason: null, evidence: [] };
}

export interface WaitRecordedObservation {
  readonly id: string;
  readonly at: string;
  readonly source: WaitObservationSource;
  readonly subjectId: string;
  readonly status: WaitSubjectStatus;
  readonly observationDigest: string;
  readonly change: WaitChangeKind;
  /** Normalized state only; bounded evidence detail is never duplicated here. */
  readonly state: WaitObservationState;
}

export interface WaitRecordedWake {
  readonly id: string;
  readonly at: string;
  readonly reason: WaitWakeReason;
  readonly source: WaitObservationSource;
  readonly subjectId: string;
  readonly status: WaitSubjectStatus;
  readonly observationDigest: string;
  readonly evidence: readonly WaitEvidence[];
}

/**
 * Durable wait state. It is reconciliation input, never workflow authority:
 * the durable Run and live GitHub remain authoritative for every decision.
 */
export interface WaitLedger {
  readonly revision: typeof WAIT_OBSERVATION_REVISION;
  readonly wakePolicyRevision: typeof WAIT_WAKE_POLICY_REVISION;
  /** Identity of the subject this ledger observes; a mismatch is never adopted. */
  readonly subjectId: string;
  readonly ownerRunId: string;
  /** Durable single-writer fence carried by the run generation. */
  readonly generation: string;
  readonly observations: readonly WaitRecordedObservation[];
  readonly wakes: readonly WaitRecordedWake[];
  /**
   * Terminal observation digests already surfaced. Kept separate from the
   * bounded wake list so evicting old warning evidence can never cause a
   * terminal transition to wake a second time. Absent on ledgers written
   * before this field existed; `migrateWaitLedger` reconstructs it.
   */
  readonly terminalDigests?: readonly string[];
  /** Last normalized observation digest, so restart can reconstruct without re-waking. */
  readonly lastDigest: string | null;
  readonly lastObservedAt: string | null;
  /** Start of the current bounded wait episode; reset by every meaningful change. */
  readonly waitStartedAt: string | null;
  /**
   * True once this subject has reached a terminal state and that transition has
   * been surfaced. Sticky for the subject's lifetime: a timeout after that is
   * never a new decision boundary, so a terminal Run can never be re-woken by
   * the timeout policy even if later observations drift or repeat.
   */
  readonly terminalReached: boolean;
  /**
   * Completed-turn identity from the most recent genuine native read. Kept on
   * the ledger (not derived from the bounded observation history) so the native
   * completion boundary cannot be lost to eviction.
   */
  readonly lastNativeIdentity: string | null;
  /** Whether the most recent recorded observation came from a genuine native read. */
  readonly previousWasNative: boolean;
  /** Bounded set of native completed-turn identities already surfaced. */
  readonly nativeIdentities: readonly string[];
  /** Monotonic observation counter, independent of the bounded history length. */
  readonly observationSequence: number;
}

export function createWaitLedger(input: {
  readonly subjectId: string;
  readonly ownerRunId: string;
  readonly generation: string;
}): WaitLedger {
  return {
    revision: WAIT_OBSERVATION_REVISION,
    wakePolicyRevision: WAIT_WAKE_POLICY_REVISION,
    subjectId: input.subjectId,
    ownerRunId: input.ownerRunId,
    generation: input.generation,
    observations: [],
    wakes: [],
    terminalDigests: [],
    lastDigest: null,
    lastObservedAt: null,
    waitStartedAt: null,
    terminalReached: false,
    lastNativeIdentity: null,
    previousWasNative: false,
    nativeIdentities: [],
    observationSequence: 0,
  };
}

export interface WaitLedgerAdvance {
  readonly ledger: WaitLedger;
  readonly change: WaitChange;
  readonly wake: WaitWakeDecision;
  /** True when this exact normalized observation was already recorded. */
  readonly duplicate: boolean;
  /** True when the advance appended a new wake record. */
  readonly wokeNow: boolean;
  /**
   * The genuine preceding native observation used for the native active -> idle
   * boundary, when the ledger retained one. Informational: the same boundary is
   * re-derived from the durable ledger, so callers may ignore it.
   */
  readonly previousNative: WaitObservation | null;
  readonly observationEventId: string;
}

/**
 * Closest preceding genuine native read for this subject. Ambiguous native
 * reads are recorded with `runtime` provenance, so they are skipped here and
 * the real native boundary survives an interleaved ambiguous read.
 */
function lastNativeObservation(ledger: WaitLedger, subjectId: string): WaitObservation | null {
  for (let index = ledger.observations.length - 1; index >= 0; index -= 1) {
    const recorded = ledger.observations[index]!;
    if (recorded.subjectId !== subjectId || recorded.source !== 'native') continue;
    return {
      revision: WAIT_OBSERVATION_REVISION,
      source: 'native',
      subjectId: recorded.subjectId,
      status: recorded.status,
      ...(recorded.state.activeItemId === null ? {} : { activeItemId: recorded.state.activeItemId }),
      progress: { items: recorded.state.items, turns: recorded.state.turns },
      ...(recorded.state.lastCompletedTurnId === null ? {} : { lastCompletedTurnId: recorded.state.lastCompletedTurnId }),
      headSha: recorded.state.headSha,
      evidence: [],
      observedAt: recorded.at,
    };
  }
  return null;
}

/**
 * Advance the durable ledger by exactly one observation.
 *
 * Event ids are content-addressed, so a runtime restart that re-observes the
 * same state appends nothing and cannot produce a second wake or a second
 * writer. `ownerRunId`/`generation` are revalidated on every advance: a foreign
 * ledger relation fails closed instead of adopting state.
 */
export function advanceWaitLedger(input: {
  readonly ledger: WaitLedger;
  readonly observation: WaitObservation;
  readonly at: string;
  readonly policy?: WaitWakePolicy;
  readonly timedOut?: boolean;
  readonly expectedOwnerRunId?: string;
  readonly expectedGeneration?: string;
}): WaitLedgerAdvance {
  const policy = input.policy ?? DEFAULT_WAIT_WAKE_POLICY;
  const { ledger, observation } = input;
  if (input.expectedOwnerRunId !== undefined && input.expectedOwnerRunId !== ledger.ownerRunId) {
    throw new Error('Wait ledger ownership does not match the durable run identity.');
  }
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== ledger.generation) {
    throw new Error('Wait ledger generation does not match the durable run generation.');
  }
  if (ledger.subjectId !== observation.subjectId) {
    throw new Error('Wait ledger subject does not match the observed subject identity.');
  }
  const digest = waitObservationDigest(observation);
  const duplicate = ledger.lastDigest === digest;
  // Reconstruct the previous normalized state from the last durable record.
  // Only state (never evidence detail) is needed to detect a real transition.
  const last = ledger.observations[ledger.observations.length - 1];
  const previous: WaitObservation | null = last === undefined || last.subjectId !== observation.subjectId
    ? null
    : {
        revision: WAIT_OBSERVATION_REVISION,
        source: last.source,
        subjectId: last.subjectId,
        status: last.status,
        ...(last.state.activeItemId === null ? {} : { activeItemId: last.state.activeItemId }),
        progress: { items: last.state.items, turns: last.state.turns },
        ...(last.state.lastCompletedTurnId === null ? {} : { lastCompletedTurnId: last.state.lastCompletedTurnId }),
        headSha: last.state.headSha,
        evidence: [],
        observedAt: last.at,
      };
  const previousNative = duplicate ? null : lastNativeObservation(ledger, observation.subjectId);
  const previousIsNative = previous !== null && previous.source === 'native';
  const nativeBoundary: WaitNativeBoundary = {
    lastNativeIdentity: ledger.lastNativeIdentity ?? null,
    previousWasNative: ledger.previousWasNative ?? previousIsNative,
  };
  const change = duplicate
    ? { kind: 'none' as const, meaningful: false, evidence: [] as readonly WaitEvidence[] }
    : classifyWaitChange(previous, observation, previousNative, previousIsNative, nativeBoundary);
  const observationSequence = ledger.observationSequence + 1;
  const observationEventId = `wait-observation:${ledger.ownerRunId}:${observation.subjectId}:${observationSequence}:${digest}`;
  const observations = duplicate
    ? ledger.observations
    : [...ledger.observations, {
        id: observationEventId,
        at: input.at,
        source: observation.source,
        subjectId: observation.subjectId,
        status: observation.status,
        observationDigest: digest,
        change: change.kind,
        state: waitObservationState(observation),
      }];
  const decision = decideWaitWake({ change, observation, ...(input.timedOut === undefined ? {} : { timedOut: input.timedOut }), policy, terminalReached: ledger.terminalReached });
  // Any wake for this exact digest and reason is recorded at most once, even if
  // a restart re-observes it before the orchestrator has reconciled and even
  // after the bounded wake list has evicted the original record. That includes
  // `timeout-policy`: an identical timeout must never become a periodic wake.
  const priorTerminalDigests = ledger.terminalDigests ?? [];
  // A subject whose terminal transition was already surfaced never wakes again:
  // later state is either a replay or post-terminal drift, neither of which is
  // a new decision boundary.
  const duplicateWake = decision.shouldWake && (ledger.terminalReached ||
    ledger.wakes.some((wake) => wake.observationDigest === digest && wake.reason === decision.reason));
  const terminalDecision = decision.shouldWake &&
    (decision.reason === 'completion' || decision.reason === 'failure' || decision.reason === 'blocked' || decision.reason === 'terminal');
  const terminalAlreadyRecorded = terminalDecision && priorTerminalDigests.includes(digest);
  const alreadyRecorded = duplicateWake || terminalAlreadyRecorded;
  const wakeId = `wait-wake:${ledger.ownerRunId}:${observation.subjectId}:${digest}:${decision.reason ?? 'none'}:${ledger.wakes.length}`;
  const wokeNow = decision.shouldWake && !alreadyRecorded;
  const wakes = wokeNow
    ? [...ledger.wakes, {
        id: wakeId,
        at: input.at,
        reason: decision.reason ?? 'terminal',
        source: observation.source,
        subjectId: observation.subjectId,
        status: observation.status,
        observationDigest: digest,
        evidence: decision.evidence,
      }]
    : ledger.wakes;
  const terminalDigests = terminalDecision && !priorTerminalDigests.includes(digest)
    ? [...priorTerminalDigests, digest]
    : priorTerminalDigests;
  const nextLedger: WaitLedger = {
    ...ledger,
    observations,
    wakes,
    terminalDigests,
    // Sticky: once surfaced, a terminal transition stays surfaced.
    terminalReached: ledger.terminalReached || (!duplicate && isTerminalWaitObservation(observation)),
    lastNativeIdentity: observation.source === 'native'
      ? observation.lastCompletedTurnId ?? ledger.lastNativeIdentity ?? null
      : ledger.lastNativeIdentity ?? null,
    previousWasNative: !duplicate && observation.source === 'native',
    nativeIdentities: observation.source === 'native' && observation.lastCompletedTurnId !== undefined && !(ledger.nativeIdentities ?? []).includes(observation.lastCompletedTurnId)
      ? [...(ledger.nativeIdentities ?? []), observation.lastCompletedTurnId].slice(-MAX_NATIVE_IDENTITIES)
      : ledger.nativeIdentities ?? [],
    observationSequence,
    lastDigest: digest,
    lastObservedAt: input.at,
    waitStartedAt: !isTerminalWaitObservation(observation) && change.kind === 'none'
      ? ledger.waitStartedAt ?? input.at
      : null,
  };
  return {
    ledger: nextLedger,
    change,
    wake: wokeNow ? decision : { shouldWake: false, reason: null, evidence: [] },
    duplicate,
    wokeNow,
    previousNative: previousNative ?? (observation.source === 'native' ? observation : null),
    observationEventId,
  };
}

export interface WaitLedgerFile {
  readonly revision: typeof WAIT_OBSERVATION_REVISION;
  readonly ledger: WaitLedger;
}

const MAX_WAIT_OBSERVATIONS = 200;
const MAX_WAIT_WAKES = 200;
const MAX_TERMINAL_DIGESTS = 50;
const MAX_NATIVE_IDENTITIES = 50;

/**
 * Keep the durable ledger bounded; the latest records are the reconciliation
 * input. Terminal digests are kept separately so bounded warning evidence can
 * never resurrect a terminal wake.
 */
export function boundWaitLedger(ledger: WaitLedger): WaitLedger {
  return {
    ...ledger,
    observations: ledger.observations.slice(-MAX_WAIT_OBSERVATIONS),
    wakes: ledger.wakes.slice(-MAX_WAIT_WAKES),
    terminalDigests: (ledger.terminalDigests ?? []).slice(-MAX_TERMINAL_DIGESTS),
    nativeIdentities: (ledger.nativeIdentities ?? []).slice(-MAX_NATIVE_IDENTITIES),
  };
}

/** Wakes that still require an orchestrator reconciliation pass. */
export function pendingWaitWakes(ledger: WaitLedger): readonly WaitRecordedWake[] {
  return ledger.wakes;
}

export function isWaitLedger(value: unknown): value is WaitLedger {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.revision === WAIT_OBSERVATION_REVISION &&
    record.wakePolicyRevision === WAIT_WAKE_POLICY_REVISION &&
    typeof record.subjectId === 'string' && record.subjectId !== '' &&
    typeof record.ownerRunId === 'string' && record.ownerRunId !== '' &&
    typeof record.generation === 'string' && record.generation !== '' &&
    Array.isArray(record.observations) && record.observations.every(isWaitRecordedObservation) &&
    Array.isArray(record.wakes) && record.wakes.every(isWaitRecordedWake) &&
    (record.terminalDigests === undefined ||
      (Array.isArray(record.terminalDigests) && record.terminalDigests.every((item) => typeof item === 'string'))) &&
    (record.lastDigest === null || typeof record.lastDigest === 'string') &&
    (record.lastObservedAt === null || typeof record.lastObservedAt === 'string') &&
    (record.waitStartedAt === null || typeof record.waitStartedAt === 'string') &&
    (record.terminalReached === undefined || typeof record.terminalReached === 'boolean') &&
    (record.observationSequence === undefined || (Number.isSafeInteger(record.observationSequence) && (record.observationSequence as number) >= 0));
}

/**
 * Adopt a persisted ledger, filling in fields added after the ledger was
 * written. Older wait ledgers predate terminal-digest tracking; the set is
 * reconstructed from terminal wakes that are still inside the bounded history,
 * which preserves the duplicate-wake guarantee for every realistic upgrade.
 *
 * Known, accepted limit: if a legacy ledger both lacks the field and has
 * already evicted the terminal wake, the evicted digest is unrecoverable, and a
 * later non-monotonic re-observation of that same terminal state can wake once
 * more. Legacy ledgers only ever existed transiently on this unmerged branch,
 * so refusing to adopt them would be the larger risk (a cold-start re-wake for
 * every in-flight wait); the extra wake is a bounded, non-safety-relevant
 * reconciliation prompt.
 */
export function migrateWaitLedger(value: WaitLedger): WaitLedger {
  const terminalDigests = value.terminalDigests ?? value.wakes
    .filter((wake) => wake.reason === 'completion' || wake.reason === 'failure' || wake.reason === 'blocked' || wake.reason === 'terminal')
    .map((wake) => wake.observationDigest);
  const nativeIdentities = value.nativeIdentities ?? value.observations
    .filter((recorded) => recorded.source === 'native' && recorded.state.lastCompletedTurnId !== null)
    .map((recorded) => recorded.state.lastCompletedTurnId as string);
  const lastNative = [...value.observations].reverse().find((recorded) => recorded.source === 'native');
  const lastObservation = value.observations[value.observations.length - 1];
  const sequence = value.observationSequence ?? value.observations.reduce((highest, recorded) => {
    const parsed = Number(recorded.id.split(':').at(-2));
    return Number.isSafeInteger(parsed) && parsed > highest ? parsed : highest;
  }, 0);
  return {
    ...value,
    terminalDigests,
    // A terminal transition is only reached through a terminal *status*, never
    // through a native completion wake whose observed status is `idle`.
    terminalReached: value.terminalReached ?? terminalDigests.length > 0,
    lastNativeIdentity: value.lastNativeIdentity ?? lastNative?.state.lastCompletedTurnId ?? null,
    previousWasNative: value.previousWasNative ?? lastObservation?.source === 'native',
    nativeIdentities: [...new Set(nativeIdentities)].slice(-MAX_NATIVE_IDENTITIES),
    observationSequence: sequence,
  };
}

function isWaitObservationState(value: unknown): value is WaitObservationState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.source === 'string' && (WAIT_OBSERVATION_SOURCES as readonly string[]).includes(state.source) &&
    typeof state.subjectId === 'string' && state.subjectId !== '' &&
    typeof state.status === 'string' && (WAIT_SUBJECT_STATUSES as readonly string[]).includes(state.status) &&
    (state.activeItemId === null || typeof state.activeItemId === 'string') &&
    Number.isSafeInteger(state.items) && (state.items as number) >= 0 &&
    Number.isSafeInteger(state.turns) && (state.turns as number) >= 0 &&
    (state.lastCompletedTurnId === null || state.lastCompletedTurnId === undefined || typeof state.lastCompletedTurnId === 'string') &&
    (state.headSha === null || typeof state.headSha === 'string');
}

function isWaitRecordedObservation(value: unknown): value is WaitRecordedObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id !== '' &&
    typeof record.at === 'string' &&
    typeof record.source === 'string' && (WAIT_OBSERVATION_SOURCES as readonly string[]).includes(record.source) &&
    typeof record.subjectId === 'string' && record.subjectId !== '' &&
    typeof record.status === 'string' && (WAIT_SUBJECT_STATUSES as readonly string[]).includes(record.status) &&
    typeof record.observationDigest === 'string' && record.observationDigest !== '' &&
    typeof record.change === 'string' && (WAIT_CHANGE_KINDS as readonly string[]).includes(record.change) &&
    isWaitObservationState(record.state);
}

function isWaitRecordedWake(value: unknown): value is WaitRecordedWake {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id !== '' &&
    typeof record.at === 'string' &&
    typeof record.reason === 'string' && (WAIT_WAKE_REASONS as readonly string[]).includes(record.reason) &&
    typeof record.source === 'string' && (WAIT_OBSERVATION_SOURCES as readonly string[]).includes(record.source) &&
    typeof record.subjectId === 'string' && record.subjectId !== '' &&
    typeof record.status === 'string' && (WAIT_SUBJECT_STATUSES as readonly string[]).includes(record.status) &&
    typeof record.observationDigest === 'string' && record.observationDigest !== '' &&
    Array.isArray(record.evidence) && record.evidence.every((item) => typeof item === 'object' && item !== null &&
      typeof (item as Record<string, unknown>).kind === 'string' && typeof (item as Record<string, unknown>).detail === 'string');
}

export function isWaitObservation(value: unknown): value is WaitObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.revision === WAIT_OBSERVATION_REVISION &&
    typeof record.source === 'string' &&
    typeof record.subjectId === 'string' && record.subjectId !== '' &&
    typeof record.status === 'string' &&
    Array.isArray(record.evidence) &&
    typeof record.observedAt === 'string';
}
