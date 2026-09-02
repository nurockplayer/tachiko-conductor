import { CANCEL_RUN_DECISION } from '../domain/decisions.js';
import { applyTransition } from '../domain/state-machine.js';
import type { ExecutorIdentity, Run } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';

export interface ParkBootstrapFailureOptions {
  readonly prefix: string;
  readonly retryChoice: string;
  readonly executor?: ExecutorIdentity;
}

/** Persist one consistent, resumable fail-closed outcome for bootstrap mechanics. */
export function parkBootstrapFailure(
  run: Run,
  error: unknown,
  store: RunStore,
  now: () => string,
  options: ParkBootstrapFailureOptions,
): { readonly run: Run; readonly reason: string } {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? ` (${String((error as { code: string }).code)})`
    : '';
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `${options.prefix}${code}: ${detail}`;
  const parked = applyTransition(
    run,
    {
      type: 'escalate',
      reason,
      ...(options.executor === undefined ? {} : { executor: options.executor }),
      interrupt: {
        evidence: reason,
        choices: [options.retryChoice, CANCEL_RUN_DECISION],
      },
    },
    now(),
  );
  store.update(parked);
  return { run: parked, reason };
}
