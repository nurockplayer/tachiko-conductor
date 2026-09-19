import {
  advanceWaitLedger,
  boundWaitLedger,
  classifyWaitChange,
  createWaitLedger,
  decideWaitWake,
  isTerminalWaitObservation,
  isWaitLedger,
  normalizeWaitObservation,
  waitObservationDigest,
  waitObservationState,
  type WaitChange,
  type WaitEvidence,
  type WaitLedger,
  type WaitLedgerAdvance,
  type WaitObservation,
  type WaitObservationSource,
  type WaitObservationState,
  type WaitSubjectSnapshot,
  type WaitSubjectStatus,
  type WaitWakeDecision,
  type WaitWakePolicy,
  type WaitWakeReason,
} from '../domain/wait.js';
import { CODEX_APP_SERVER_PROVIDER, type NativeThreadObservation } from '../agents/codex-app-server.js';
import type { Run, WorkflowState } from '../domain/types.js';

/**
 * Deterministic, provider-neutral observation runtime for issue #47.
 *
 * Everything in this module is side-effect-free with respect to models: it
 * reads native/runtime state, coalesces it into the `wait-observation-v1`
 * contract, and decides whether the orchestrator should be woken. Observation
 * never starts a model turn; only the caller may act on a wake decision, and a
 * wake is a signal to reconcile (never workflow authority itself).
 */

export interface WaitSleeper {
  (milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** A deterministic observer seam. Implementations must be side-effect-free. */
export interface WaitObserver {
  readonly source: WaitObservationSource;
  /** The stable subject identity this observer reports on. */
  readonly subjectId: string;
  observe(): Promise<WaitObservation>;
}

export interface WaitAwaitOutcome {
  readonly observation: WaitObservation;
  readonly change: WaitChange;
  readonly wake: WaitWakeDecision;
  readonly ledger: WaitLedger;
  /** How many provider reads this bounded wait needed; never a model turn. */
  readonly observationCount: number;
  readonly duplicateObservations: number;
  /** True when the bounded wait budget ended the wait. */
  readonly timedOut: boolean;
  /** True when the runtime should stop waiting without a model turn. */
  readonly idle: boolean;
}

export interface WaitAwaitOptions {
  readonly observer: WaitObserver;
  readonly ledger: WaitLedger;
  readonly policy: WaitWakePolicy;
  /** Injectable clock/sleep so tests are deterministic and never really wait. */
  readonly now?: () => number;
  readonly sleep?: WaitSleeper;
  readonly signal?: AbortSignal;
  /** Minimum delay between provider reads. Never a model cadence. */
  readonly pollIntervalMs?: number;
  readonly expectedOwnerRunId?: string;
  readonly expectedGeneration?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Mirrors the domain ledger cap for the surfaced-digest set. */
const MAX_SURFACED_DIGESTS = 500;

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    if (signal?.aborted === true) { cleanup(); resolve(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Record only a wake decision (never a model turn) into the durable ledger.
 *
 * Every wake reason is deduplicated by the normalized observation digest. That
 * matters most for `timeout-policy`: an identical timeout for unchanged state
 * must not become a periodic model wake (a poll/timer by another name). A new
 * timeout can only wake again after the observed state actually changed.
 */
function recordWake(ledger: WaitLedger, observation: WaitObservation, at: string, decision: WaitWakeDecision): WaitLedgerAdvance {
  const digest = waitObservationDigest(observation);
  // A terminal observation has already been surfaced for this digest; a later
  // timeout on the same unchanged state is not a new decision boundary, it is a
  // timer. Never re-wake for it.
  const terminalDigest = (ledger.terminalDigests ?? []).includes(digest);
  const alreadyRecorded = ledger.terminalReached || terminalDigest ||
    (ledger.surfacedDigests ?? []).includes(digest) ||
    ledger.wakes.some((wake) => wake.observationDigest === digest);
  const shouldWake = decision.shouldWake && !alreadyRecorded;
  const wakeId = `wait-wake:${ledger.ownerRunId}:${observation.subjectId}:${digest}:${decision.reason ?? 'none'}:${ledger.wakes.length}`;
  const wakes = shouldWake
    ? [...ledger.wakes, {
        id: wakeId,
        at,
        reason: decision.reason ?? 'terminal',
        source: observation.source,
        subjectId: observation.subjectId,
        status: observation.status,
        observationDigest: digest,
        evidence: decision.evidence,
      }]
    : ledger.wakes;
  return {
    ledger: {
      ...ledger,
      wakes,
      surfacedDigests: shouldWake && !(ledger.surfacedDigests ?? []).includes(digest)
        ? [...(ledger.surfacedDigests ?? []), digest].slice(-MAX_SURFACED_DIGESTS)
        : ledger.surfacedDigests ?? [],
    },
    change: { kind: 'none', meaningful: false, evidence: [] },
    wake: shouldWake ? decision : { shouldWake: false, reason: null, evidence: [] },
    duplicate: false,
    wokeNow: shouldWake,
    previousNative: null,
    observationEventId: wakeId,
  };
}

/**
 * Wait for exactly one meaningful normalized state change.
 *
 * Repeated equivalent observations are coalesced into the durable ledger and
 * never wake the model. A bounded wait that expires without a decision boundary
 * returns `timedOut`; whether that wakes the orchestrator is a policy decision
 * (`onTimeout`), never an implicit model heartbeat.
 */
export async function awaitMeaningfulChange(options: WaitAwaitOptions): Promise<WaitAwaitOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const interval = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const deadlineAt = now() + Math.max(0, options.policy.timeoutMs);
  let ledger = options.ledger;
  let lastChange: WaitChange = { kind: 'none', meaningful: false, evidence: [] };
  let observationCount = 0;
  let duplicateObservations = 0;
  for (;;) {
    const observation = await options.observer.observe();
    observationCount += 1;
    const advance = advanceWaitLedger({
      ledger,
      observation,
      at: observation.observedAt,
      policy: options.policy,
      ...(options.expectedOwnerRunId === undefined ? {} : { expectedOwnerRunId: options.expectedOwnerRunId }),
      ...(options.expectedGeneration === undefined ? {} : { expectedGeneration: options.expectedGeneration }),
    });
    if (advance.duplicate) duplicateObservations += 1;
    // Bound the in-memory ledger exactly like the persisted store does, so a
    // long bounded wait cannot grow without limit.
    ledger = boundWaitLedger(advance.ledger);
    lastChange = advance.change;
    if (advance.change.kind !== 'none' && advance.change.kind !== 'progress') {
      return { observation, change: advance.change, wake: advance.wake, ledger, observationCount, duplicateObservations, timedOut: false, idle: false };
    }
    if (options.signal?.aborted === true) {
      return { observation, change: advance.change, wake: { shouldWake: false, reason: null, evidence: [] }, ledger, observationCount, duplicateObservations, timedOut: false, idle: true };
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      const decision = decideWaitWake({
        change: { kind: 'none', meaningful: false, evidence: [] },
        observation,
        timedOut: true,
        policy: options.policy,
        terminalReached: ledger.terminalReached,
      });
      const recorded = recordWake(ledger, observation, observation.observedAt, decision);
      return {
        observation,
        change: lastChange,
        wake: recorded.wake,
        ledger: recorded.ledger,
        observationCount,
        duplicateObservations,
        timedOut: true,
        idle: !recorded.wake.shouldWake,
      };
    }
    await sleep(Math.min(interval, remaining), options.signal);
    // Progress-only change continues deterministic waiting without a model turn.
  }
}

/** Provider-native snapshot used to enrich the runtime fallback observation. */
export interface NativeWaitSnapshot {
  readonly status: WaitSubjectStatus;
  readonly activeItemId?: string;
  readonly items?: number;
  readonly turns?: number;
  /** Most recent completed native turn identity, when the provider reports one. */
  readonly lastCompletedTurnId?: string;
  readonly evidence?: readonly WaitEvidence[];
}

export interface RuntimeObservationDependencies {
  readonly now: () => string;
  /** Read-only exact-HEAD probe for the prepared workspace. */
  readonly readHead?: (run: Run) => Promise<string | null>;
  /** Optional #35-native observation seam; absent means fallback-only. */
  readonly nativeObserver?: { snapshot(): Promise<NativeWaitSnapshot> };
}

/**
 * Fallback runtime observation for one durable Run. It is provider-neutral,
 * read-only, and never starts a model turn: status, HEAD, and history length
 * come from durable local state only.
 */
export class RunRuntimeObserver implements WaitObserver {
  readonly source: WaitObservationSource = 'runtime';
  readonly subjectId: string;

  constructor(private readonly run: Run, private readonly dependencies: RuntimeObservationDependencies) {
    this.subjectId = run.id;
  }

  async observe(): Promise<WaitObservation> {
    const native = await this.observeNative();
    // Provenance is explicit: a native read that did not determine the status is
    // ambiguous evidence, reported as the deterministic runtime source, so it
    // can never masquerade as a genuine native turn boundary.
    const merged = resolveRuntimeStatus(runWaitStatus(this.run.state), native);
    const usedNativeStatus = merged.source === 'native';
    const nativeField = <T>(value: T): T | undefined => usedNativeStatus ? value : undefined;
    const durableHead = this.run.headSha ?? null;
    // A failed or unavailable exact-HEAD probe must not masquerade as a head
    // move; fall back to durable state and let the next read reconcile.
    const probedHead = this.dependencies.readHead === undefined
      ? durableHead
      : await this.dependencies.readHead(this.run).catch(() => null);
    const headSha = probedHead ?? durableHead;
    const evidence: WaitEvidence[] = [];
    if (headSha !== null && headSha !== durableHead) evidence.push({ kind: 'head-changed', detail: `workspace head ${shorten(headSha)}` });
    const snapshot: WaitSubjectSnapshot = {
      status: merged.status,
      ...(nativeField(native?.activeItemId) === undefined ? {} : { activeItemId: nativeField(native?.activeItemId)! }),
      items: nativeField(native?.items) ?? this.run.history.length,
      ...(nativeField(native?.turns) === undefined ? {} : { turns: nativeField(native?.turns)! }),
      ...(nativeField(native?.lastCompletedTurnId) === undefined ? {} : { lastCompletedTurnId: nativeField(native?.lastCompletedTurnId)! }),
      ...(headSha === null ? {} : { headSha }),
      evidence: [...(usedNativeStatus ? native?.evidence ?? [] : []), ...evidence],
    };
    return normalizeWaitObservation({
      source: usedNativeStatus ? 'native' : this.source,
      subjectId: this.subjectId,
      observedAt: this.dependencies.now(),
      snapshot,
    });
  }

  /**
   * Native observation is authoritative when the durable Run carries an App
   * Server executor and a #35 observer is available. An unavailable native
   * runtime degrades to the deterministic fallback instead of failing the wait
   * path closed (mutation paths still fail closed).
   */
  private async observeNative(): Promise<NativeWaitSnapshot | undefined> {
    if (this.dependencies.nativeObserver === undefined) return undefined;
    if (this.run.executor?.provider !== CODEX_APP_SERVER_PROVIDER) return undefined;
    try {
      return await this.dependencies.nativeObserver.snapshot();
    } catch {
      return undefined;
    }
  }
}

/**
 * Combine the authoritative durable Run status with optional native evidence.
 *
 * Native observation is enrichment, never authority. A durable
 * `failed`/`blocked`/`completed` Run always wins, so a finished or not-loaded
 * native thread cannot hide a terminal or blocked wake. A genuinely active
 * native thread is real in-flight work even when the durable Run is parked, so
 * it refines a non-terminal durable state. `unknown` and `unavailable` native
 * reads never override durable state and are not reported as native provenance.
 */
export function resolveRuntimeStatus(durable: WaitSubjectStatus, native: NativeWaitSnapshot | undefined): { readonly status: WaitSubjectStatus; readonly source: 'native' | 'runtime' } {
  if (durable === 'completed' || durable === 'failed' || durable === 'blocked') return { status: durable, source: 'runtime' };
  if (native === undefined) return { status: durable, source: 'runtime' };
  if (native.status === 'completed' || native.status === 'failed' || native.status === 'blocked' || native.status === 'active' || native.status === 'idle') {
    return { status: native.status, source: 'native' };
  }
  return { status: durable, source: 'runtime' };
}

/** Status-only view of {@link resolveRuntimeStatus}. */
export function mergeRuntimeStatus(durable: WaitSubjectStatus, native: NativeWaitSnapshot | undefined): WaitSubjectStatus {
  return resolveRuntimeStatus(durable, native).status;
}

function runWaitStatus(state: WorkflowState): WaitSubjectStatus {
  if (state === 'MERGED') return 'completed';
  if (state === 'FAILED') return 'failed';
  if (state === 'MERGE_READY' || state === 'NEEDS_HUMAN' || state === 'WAITING_DEPENDENCY') return 'blocked';
  return 'active';
}

function shorten(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * Read-only exact-HEAD probe for the fallback observer. It accepts an already
 * prepared workspace and never mutates it.
 */
export function gitHeadReader(
  runner: { run(file: string, args: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<{ exitCode: number; stdout: string }> },
  cwd: string,
  timeoutMs = 30_000,
): (run: Run) => Promise<string | null> {
  return async () => {
    const result = await runner.run('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs });
    const value = result.stdout.trim();
    return result.exitCode === 0 && /^[0-9a-f]{40}$/.test(value) ? value : null;
  };
}

/**
 * #35-native observer. It reuses the existing App Server `thread/read`
 * observation and maps it onto the #47 contract. It never starts, resumes,
 * steers, or interrupts a turn.
 */
export class NativeThreadWaitObserver {
  readonly source: WaitObservationSource = 'native';
  readonly subjectId: string;

  constructor(
    private readonly options: {
      readonly client: { observeThread(threadId: string): Promise<NativeThreadObservation> };
      readonly threadId: string;
      readonly now: () => string;
      /** Report under the durable Run subject so one ledger owns one writer. */
      readonly subjectId?: string;
    },
  ) {
    this.subjectId = options.subjectId ?? options.threadId;
  }

  async observe(): Promise<WaitObservation> {
    return normalizeWaitObservation({
      source: this.source,
      subjectId: this.subjectId,
      observedAt: this.options.now(),
      snapshot: await this.snapshot(),
    });
  }

  async snapshot(): Promise<NativeWaitSnapshot> {
    const observation = await this.options.client.observeThread(this.options.threadId);
    const evidence: WaitEvidence[] = observation.history.map((item) => ({
      kind: 'item-completed' as const,
      detail: `${item.type}:${item.id}`.slice(0, 120),
    }));
    if (observation.activeTurnId !== undefined) evidence.push({ kind: 'turn-started', detail: observation.activeTurnId.slice(0, 120) });
    if (observation.lastCompletedTurnId !== undefined) {
      evidence.push({ kind: 'turn-completed', detail: `completed turn ${observation.lastCompletedTurnId}`.slice(0, 120) });
    }
    return {
      status: nativeStatus(observation.status, observation.activeTurnId),
      ...(observation.activeTurnId === undefined ? {} : { activeItemId: observation.activeTurnId }),
      // Use the uncapped runtime turn count, never the bounded item history.
      turns: observation.turnCount ?? observation.history.length,
      ...(observation.lastCompletedTurnId === undefined ? {} : { lastCompletedTurnId: observation.lastCompletedTurnId }),
      evidence,
    };
  }
}

function nativeStatus(status: NativeThreadObservation['status'], activeTurnId: string | undefined): WaitSubjectStatus {
  if (status === 'active' || activeTurnId !== undefined) return 'active';
  if (status === 'idle') return 'idle';
  // `not_loaded` and `system_error` are ambiguous/transient native states, never
  // an authoritative terminal signal. They degrade to the durable Run status
  // and are reported as `unavailable` so they cannot fabricate a wake.
  if (status === 'not_loaded') return 'unknown';
  return 'unavailable';
}

/**
 * Observe once, advance the durable ledger, and report whether the model must
 * be woken. This is the whole status/wakeup path: no model turn is started.
 */
export async function observeWaitState(input: {
  readonly observer: WaitObserver;
  readonly ledger: WaitLedger | null;
  readonly at: string;
  readonly policy: WaitWakePolicy;
  readonly timedOut?: boolean;
  readonly expectedOwnerRunId?: string;
  readonly expectedGeneration?: string;
}): Promise<{ readonly observation: WaitObservation; readonly advance: WaitLedgerAdvance }> {
  const observation = await input.observer.observe();
  const ledger = input.ledger ?? createWaitLedger({
    subjectId: observation.subjectId,
    ownerRunId: input.expectedOwnerRunId ?? observation.subjectId,
    generation: input.expectedGeneration ?? 'unspecified',
  });
  const advance = advanceWaitLedger({
    ledger,
    observation,
    at: input.at,
    policy: input.policy,
    ...(input.timedOut === undefined ? {} : { timedOut: input.timedOut }),
    ...(input.expectedOwnerRunId === undefined ? {} : { expectedOwnerRunId: input.expectedOwnerRunId }),
    ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
  });
  return { observation, advance };
}

export {
  boundWaitLedger,
  classifyWaitChange,
  createWaitLedger,
  isTerminalWaitObservation,
  isWaitLedger,
  waitObservationDigest,
  waitObservationState,
  type WaitObservationState,
  type WaitWakeReason,
};
