import {
  DEFAULT_WAIT_WAKE_POLICY,
  markWaitWakesDelivered,
  pendingWaitWakes,
  wakeReasonForChange,
  waitObservationDigest,
  type WaitLedger,
  type WaitObservation,
  type WaitRecordedWake,
  type WaitWakePolicy,
} from '../domain/wait.js';
import { recordWaitWakeTelemetry } from '../domain/telemetry.js';
import type { Run } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';
import {
  RunRuntimeObserver,
  awaitMeaningfulChange,
  createWaitLedger,
  observeWaitState,
  type NativeWaitSnapshot,
  type WaitAwaitOutcome,
  type WaitObserver,
} from './wait-observation.js';
import { waitLedgerBelongsTo, type WaitLedgerStore } from './wait-ledger-store.js';

/**
 * The `wait` command surface for issue #47: deterministic status/observation
 * that is model-free by construction.
 *
 * `observe` performs one side-effect-free read, coalesces it into the durable
 * wait ledger, and reports whether the orchestrator must reconcile. `wait`
 * deterministically waits for exactly one meaningful normalized change (or a
 * bounded timeout) without starting a model turn. Neither command invokes a
 * model; the caller decides what to do with a `wake`.
 */

export type WaitCommandMode = 'observe' | 'wait';

export interface WaitCommandDependencies {
  readonly store: RunStore;
  readonly ledgerStore: WaitLedgerStore;
  /** Clock for observation timestamps. */
  readonly now: () => string;
  /** Monotonic clock for the bounded wait budget. */
  readonly monotonicNow?: () => number;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Read-only exact-HEAD probe for the prepared workspace. */
  readonly readHead?: (run: Run) => Promise<string | null>;
  /** Optional #35-native observation seam; absent means deterministic fallback. */
  readonly nativeObserver?: { snapshot(): Promise<NativeWaitSnapshot> };
}

export interface WaitCommandOptions {
  readonly id: string;
  readonly mode: WaitCommandMode;
  readonly policy?: WaitWakePolicy;
  readonly pollIntervalMs?: number;
}

export interface WaitCommandResult {
  readonly ok: true;
  readonly mode: WaitCommandMode;
  readonly runId: string;
  readonly state: Run['state'];
  readonly source: WaitObservation['source'];
  readonly subjectId: string;
  readonly status: WaitObservation['status'];
  readonly headSha: string | null;
  readonly observationDigest: string;
  readonly change: WaitLedger['observations'][number]['change'];
  readonly wake: {
    readonly shouldWake: boolean;
    readonly reason: string | null;
    readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
  };
  /**
   * Wakes recorded by an earlier process that had not been handed to a caller
   * before it died. These are replayed so a crash cannot silently drop a wake;
   * they are marked delivered once printed.
   */
  readonly pendingWakes: readonly {
    readonly id: string;
    readonly reason: string;
    readonly subjectId: string;
    readonly status: string;
    /** Bounded evidence for this decision, so a replay never loses it. */
    readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
  }[];
  /** Every wake id this result carried, so delivery acknowledgement is exact. */
  readonly carriedWakeIds: readonly string[];
  /** Always zero: this path never starts a model turn. */
  readonly modelTurns: 0;
  readonly timedOut: boolean;
  readonly idle: boolean;
  readonly observations: number;
  readonly duplicateObservations: number;
  readonly wakeCount: number;
  readonly waitStartedAt: string | null;
  /** Ledger mutation kind for this call, so the caller can persist delivery. */
  readonly observedDigest: string;
}

export function emptyWaitLedger(run: Run): WaitLedger {
  return createWaitLedger({
    subjectId: run.id,
    ownerRunId: run.id,
    generation: run.dispatchClaimId ?? run.id,
  });
}

/**
 * Load the durable wait ledger for this exact run identity. A ledger that does
 * not belong to the run (foreign subject/owner/generation) fails closed: the
 * wait path refuses to adopt or overwrite another identity's durable
 * reconciliation state, so a second dispatcher can never become a duplicate
 * writer by clobbering it.
 */
export function loadWaitLedger(input: {
  readonly run: Run;
  readonly ledgerStore: WaitLedgerStore;
}): WaitLedger {
  const stored = input.ledgerStore.read();
  if (stored === null) return emptyWaitLedger(input.run);
  const identity = {
    subjectId: input.run.id,
    ownerRunId: input.run.id,
    generation: input.run.dispatchClaimId ?? input.run.id,
  };
  if (!waitLedgerBelongsTo(stored, identity)) {
    throw new WaitLedgerOwnershipError(input.run.id);
  }
  return stored;
}

/** Raised instead of adopting or overwriting a foreign durable wait ledger. */
export class WaitLedgerOwnershipError extends Error {
  constructor(runId: string) {
    super(`Wait ledger for run ${runId} belongs to a different subject/owner/generation; refusing to adopt or overwrite it.`);
    this.name = 'WaitLedgerOwnershipError';
  }
}

function runtimeObserver(run: Run, dependencies: WaitCommandDependencies): WaitObserver {
  return new RunRuntimeObserver(run, {
    now: dependencies.now,
    // Re-read the durable Run on every poll so a transition during the wait is
    // observed instead of serving the snapshot taken when the command started.
    readRun: () => dependencies.store.read(run.id) ?? run,
    ...(dependencies.readHead === undefined ? {} : { readHead: dependencies.readHead }),
    ...(dependencies.nativeObserver === undefined ? {} : { nativeObserver: dependencies.nativeObserver }),
  });
}

/** The durable workflow state this observation was taken in. */
function observedRunState(run: Run, observation: WaitObservation): Run['state'] {
  if (observation.status === 'completed') return 'MERGED';
  if (observation.status === 'failed') return 'FAILED';
  return run.state;
}

function pendingWakeViews(ledger: WaitLedger): readonly WaitRecordedWake[] {
  return pendingWaitWakes(ledger);
}

/** Decision boundaries outrank a timer wake when replaying several at once. */
const WAKE_REASON_PRIORITY: Readonly<Record<string, number>> = {
  failure: 0,
  blocked: 1,
  completion: 2,
  terminal: 3,
  'timeout-policy': 4,
};

function byReplayPriority(wakes: readonly WaitRecordedWake[]): readonly WaitRecordedWake[] {
  return wakes.slice().sort((left, right) =>
    (WAKE_REASON_PRIORITY[left.reason] ?? 9) - (WAKE_REASON_PRIORITY[right.reason] ?? 9));
}

function evidenceViews(evidence: readonly { readonly kind: string; readonly detail: string }[]): readonly { readonly kind: string; readonly detail: string }[] {
  return evidence.map((item) => ({ kind: item.kind, detail: item.detail }));
}

function toResult(input: {
  readonly mode: WaitCommandMode;
  readonly run: Run;
  readonly outcome: Pick<WaitAwaitOutcome, 'observation' | 'change' | 'wake' | 'ledger' | 'observationCount' | 'duplicateObservations' | 'timedOut' | 'idle'>;
}): WaitCommandResult {
  const { observation, ledger } = input.outcome;
  const pending = pendingWakeViews(ledger);
  // A recorded-but-undelivered wake is a real decision boundary: surface it so
  // a restart always hands the caller the same wake it would have before.
  const replay = !input.outcome.wake.shouldWake && pending.length > 0;
  // Replay the most significant pending decision, not merely the oldest, and
  // carry every pending wake with its own bounded evidence so nothing is lost.
  const replayWake = replay ? byReplayPriority(pending)[0]! : undefined;
  // The wake presented as `wake` is that same decision either way; it must not
  // also be listed as a separate pending wake.
  const presentedWakeId = replayWake?.id
    ?? pending.find((wake) => wake.observationDigest === ledger.lastDigest)?.id;
  return {
    ok: true,
    mode: input.mode,
    runId: input.run.id,
    // The wake is about the state actually observed, which may have changed
    // during the wait.
    state: observedRunState(input.run, observation),
    source: observation.source,
    subjectId: observation.subjectId,
    status: observation.status,
    headSha: observation.headSha,
    observationDigest: ledger.lastDigest ?? '',
    change: input.outcome.change.kind,
    wake: replayWake === undefined
      ? {
          shouldWake: input.outcome.wake.shouldWake,
          reason: input.outcome.wake.reason,
          evidence: input.outcome.wake.evidence.map((item) => ({ kind: item.kind, detail: item.detail })),
        }
      : {
          shouldWake: true,
          reason: replayWake.reason,
          evidence: evidenceViews(replayWake.evidence),
        },
    pendingWakes: pending
      .filter((wake) => wake.id !== presentedWakeId)
      .map((wake) => ({
        id: wake.id,
        reason: wake.reason,
        subjectId: wake.subjectId,
        status: wake.status,
        evidence: evidenceViews(wake.evidence),
      })),
    carriedWakeIds: pending.map((wake) => wake.id),
    modelTurns: 0,
    timedOut: input.outcome.timedOut,
    idle: input.outcome.idle,
    observations: input.outcome.observationCount,
    duplicateObservations: input.outcome.duplicateObservations,
    wakeCount: ledger.wakes.length,
    waitStartedAt: ledger.waitStartedAt,
    observedDigest: ledger.lastDigest ?? '',
  };
}

/** One model-free observation, coalesced and persisted to the durable ledger. */
export async function waitObserveCommand(
  options: WaitCommandOptions,
  dependencies: WaitCommandDependencies,
): Promise<WaitCommandResult> {
  const run = readRun(options.id, dependencies.store);
  const policy = options.policy ?? DEFAULT_WAIT_WAKE_POLICY;
  const ledger = loadWaitLedger({ run, ledgerStore: dependencies.ledgerStore });
  const { observation, advance } = await observeWaitState({
    observer: runtimeObserver(run, dependencies),
    ledger,
    at: dependencies.now(),
    policy,
    expectedOwnerRunId: run.id,
    expectedGeneration: run.dispatchClaimId ?? run.id,
  });
  dependencies.ledgerStore.write(advance.ledger);
  if (advance.wokeNow) {
    recordWake({
      run,
      observation,
      at: dependencies.now(),
      reason: wakeReasonForChange(advance.change) ?? (advance.wake.reason === 'timeout-policy' ? 'timeout-policy' : 'terminal'),
      store: dependencies.store,
    });
  }
  return toResult({
    mode: 'observe',
    run,
    outcome: {
      observation,
      change: advance.change,
      wake: advance.wake,
      ledger: advance.ledger,
      observationCount: 1,
      duplicateObservations: advance.duplicate ? 1 : 0,
      timedOut: false,
      idle: !advance.wokeNow,
    },
  });
}

/**
 * Wait deterministically for exactly one meaningful normalized change. Polling
 * is bounded and coalesced, and progress-only change keeps waiting without a
 * model turn.
 */
export async function waitAwaitCommand(
  options: WaitCommandOptions,
  dependencies: WaitCommandDependencies,
): Promise<WaitCommandResult> {
  const run = readRun(options.id, dependencies.store);
  const policy = options.policy ?? DEFAULT_WAIT_WAKE_POLICY;
  const ledger = loadWaitLedger({ run, ledgerStore: dependencies.ledgerStore });
  const outcome = await awaitMeaningfulChange({
    observer: runtimeObserver(run, dependencies),
    ledger,
    policy,
    now: dependencies.monotonicNow ?? (() => Date.now()),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    expectedOwnerRunId: run.id,
    expectedGeneration: run.dispatchClaimId ?? run.id,
    persist: (ledger) => dependencies.ledgerStore.write(ledger),
  });
  dependencies.ledgerStore.write(outcome.ledger);
  if (outcome.wake.shouldWake) {
    recordWake({
      run,
      observation: outcome.observation,
      at: dependencies.now(),
      reason: outcome.wake.reason ?? 'terminal',
      store: dependencies.store,
    });
  }
  return toResult({ mode: 'wait', run, outcome });
}

/**
 * Mark every wake this result carried (new or replayed) as delivered. Called by
 * the caller only after the result has actually been emitted, so a crash before
 * delivery leaves the wake pending for the next process to replay.
 */
export function acknowledgeWaitDelivery(result: WaitCommandResult, ledgerStore: WaitLedgerStore): void {
  const carried = result.carriedWakeIds;
  if (carried.length === 0) return;
  const ledger = ledgerStore.read();
  if (ledger === null) return;
  // Only the exact wakes this result carried may be acknowledged. Marking every
  // currently-pending id would silently suppress a wake another writer recorded
  // after this result was built but before it was emitted.
  const known = new Set(ledger.wakes.map((wake) => wake.id));
  ledgerStore.write(markWaitWakesDelivered(ledger, carried.filter((id) => known.has(id))));
}

function readRun(id: string, store: RunStore): Run {
  const run = store.read(id);
  if (run === null) throw new Error(`Run ${id} was not found.`);
  return run;
}

/**
 * Append run-level wait/status telemetry for a real wake (never for polling).
 *
 * The wait path must never become a second writer of workflow state. `run` may
 * have been read up to a full bounded wait (default 15 minutes) earlier, so the
 * append is re-based onto the *current* durable Run and skipped entirely if
 * that Run is gone or its workflow state changed while waiting. Telemetry is
 * captured; a concurrent terminal transition is never reverted, and no stale
 * snapshot is written back.
 */
function recordWake(input: {
  readonly run: Run;
  readonly observation: WaitObservation;
  readonly at: string;
  readonly reason: string;
  readonly store: RunStore;
}): void {
  // Re-base onto the *current* durable Run: a wake for a transition observed
  // during the wait legitimately belongs to that new state, so the append must
  // not be skipped just because the Run moved on from the command-start read.
  const current = input.store.read(input.run.id);
  if (current === null) return;
  const next = recordWaitWakeTelemetry(current, {
    at: input.at,
    reason: input.reason,
    source: input.observation.source,
    subjectId: input.observation.subjectId,
    status: input.observation.status,
    observationDigest: waitObservationDigest(input.observation),
  });
  if (next === current) return;
  // Never clobber a concurrent writer: prefer a compare-and-swap when the
  // store offers one, and otherwise verify the snapshot immediately before the
  // write (there is no await between the verify and the write).
  if (input.store.updateIfUnchanged !== undefined) {
    input.store.updateIfUnchanged(current, next);
    return;
  }
  const verified = input.store.read(input.run.id);
  if (verified === null) return;
  if (runSnapshotKey(verified) !== runSnapshotKey(current)) return;
  input.store.update(next);
}

/** Durable identity of a Run snapshot, for the non-CAS fallback path. */
function runSnapshotKey(run: Run): string {
  return JSON.stringify([
    run.state,
    run.updatedAt,
    run.headSha ?? null,
    run.history.length,
    run.agentResult ?? null,
    run.reviewResult ?? null,
    run.validationResult ?? null,
    run.pullRequest ?? null,
    // Include telemetry: a concurrent telemetry-only append must count as drift.
    run.telemetry ?? null,
  ]);
}
