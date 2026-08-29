/** Exact bounded decision that authorizes adopting a changed live pull-request HEAD. */
export const LIVE_HEAD_SYNC_DECISION = 'Sync the run to the live HEAD and continue';

/** Exact bounded decision that terminates a parked run without resuming work. */
export const CANCEL_RUN_DECISION = 'Cancel the run';

const LIVE_HEAD_SYNC_INTERRUPT_STATES = new Set([
  'IMPLEMENTING',
  'REVIEWING',
  'CHANGES_REQUESTED',
]);

/** States whose drift interrupt offers the bounded live-HEAD synchronization decision. */
export function canSynchronizeInterruptedHead(state: string | undefined): boolean {
  return state !== undefined && LIVE_HEAD_SYNC_INTERRUPT_STATES.has(state);
}
