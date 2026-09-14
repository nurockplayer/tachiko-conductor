/** Exact bounded decision that authorizes adopting a changed live pull-request HEAD. */
export const LIVE_HEAD_SYNC_DECISION = 'Sync the run to the live HEAD and continue';

/** Exact bounded recovery for a pre-validation legacy MERGE_READY record. */
export const REESTABLISH_READINESS_DECISION = 'Re-establish current readiness authority';

/** Exact bounded recovery for a legacy requested-change record without a persisted PR tuple. */
export const RECOVER_LEGACY_PULL_REQUEST_DECISION = 'Re-establish the accepted pull request and exact HEAD, then retry';

/** Exact bounded decision that terminates a parked run without resuming work. */
export const CANCEL_RUN_DECISION = 'Cancel the run';

const LIVE_HEAD_SYNC_INTERRUPT_STATES = new Set([
  'IMPLEMENTING',
  'VALIDATING',
  'REVIEWING',
  'CHANGES_REQUESTED',
  'FINAL_GATE',
]);

/** States whose drift interrupt offers the bounded live-HEAD synchronization decision. */
export function canSynchronizeInterruptedHead(state: string | undefined): boolean {
  return state !== undefined && LIVE_HEAD_SYNC_INTERRUPT_STATES.has(state);
}

/** Only a legacy merge-ready record may be returned to exact-HEAD validation. */
export function canReestablishInterruptedReadiness(state: string | undefined): boolean {
  return state === 'MERGE_READY';
}

/** Only a legacy requested-change record may adopt its unchanged live PR tuple. */
export function canRecoverLegacyPullRequest(state: string | undefined): boolean {
  return state === 'CHANGES_REQUESTED';
}
