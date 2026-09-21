import type { DispatchOnceResult } from './runner.js';

/**
 * Provider-neutral serial driver for the existing dispatch claim boundary.
 *
 * A completed workflow is reconciled immediately so a removed terminal queue
 * row can make the next eligible item available without a scheduler gap. All
 * other boundaries wait locally: sleeping and the next GitHub reconciliation
 * never start a model by themselves.
 */
export interface DispatchContinuousOptions {
  readonly dispatchOnce: () => Promise<DispatchOnceResult>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly idlePollMs: number;
  /** Test/operations bound. Omit only for the supervised long-running driver. */
  readonly maxCycles?: number;
}

export interface DispatchContinuousResult {
  readonly cycles: number;
  readonly idleWaits: number;
  readonly last: DispatchOnceResult | null;
}

export const DEFAULT_DISPATCH_IDLE_POLL_MS = 30_000;

function isTerminalDispatch(result: DispatchOnceResult): boolean {
  return result.outcome === 'dispatched' && [
    'MERGED', 'MERGE_READY', 'NEEDS_HUMAN', 'WAITING_DEPENDENCY', 'FAILED',
  ].includes(result.execution.state);
}

/** Run one serial reconciliation at a time; never overlap a claim attempt. */
export async function dispatchContinuously(options: DispatchContinuousOptions): Promise<DispatchContinuousResult> {
  if (!Number.isSafeInteger(options.idlePollMs) || options.idlePollMs < 1) {
    throw new Error('dispatch idle poll must be a positive safe integer.');
  }
  if (options.maxCycles !== undefined && (!Number.isSafeInteger(options.maxCycles) || options.maxCycles < 1)) {
    throw new Error('dispatch max cycles must be a positive safe integer.');
  }

  let cycles = 0;
  let idleWaits = 0;
  let last: DispatchOnceResult | null = null;
  while (options.maxCycles === undefined || cycles < options.maxCycles) {
    last = await options.dispatchOnce();
    cycles += 1;
    // A terminal result can release/supersede its retained claim immediately.
    // An active result must not cause a second model invocation merely because
    // the driver is alive; wait for its next deterministic reconciliation.
    if (isTerminalDispatch(last)) continue;
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) break;
    await options.sleep(options.idlePollMs);
    idleWaits += 1;
  }
  return { cycles, idleWaits, last };
}
