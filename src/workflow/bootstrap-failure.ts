import { CANCEL_RUN_DECISION } from '../domain/decisions.js';
import { applyTransition } from '../domain/state-machine.js';
import type { ExecutorIdentity, Run } from '../domain/types.js';
import type { RunStore } from '../store/json-file-store.js';

/** Convert every workspace/bootstrap failure into one provider-neutral resumable interrupt. */
export function parkBootstrapFailure(
  run: Run,
  error: unknown,
  store: RunStore,
  now: () => string,
  executor?: ExecutorIdentity,
): { readonly run: Run; readonly reason: string } {
  const parked = createBootstrapFailureRun(run, error, now, executor);
  store.update(parked.run);
  return parked;
}

export function createBootstrapFailureRun(
  run: Run,
  error: unknown,
  now: () => string,
  executor?: ExecutorIdentity,
): { readonly run: Run; readonly reason: string } {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? ` (${String((error as { code: string }).code)})` : '';
  const detail = error instanceof Error ? error.message : String(error);
  const reason = `Implementation bootstrap failed${code}: ${detail}`;
  const parked = applyTransition(run, {
    type: 'escalate', reason, ...(executor === undefined ? {} : { executor }),
    interrupt: { evidence: reason, choices: ['Resolve the workspace identity and retry', CANCEL_RUN_DECISION] },
  }, now());
  return { run: parked, reason };
}
