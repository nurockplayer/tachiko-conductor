export type GitHubLiveStateErrorCode =
  | 'GH_MERGE_BINDING_UNAVAILABLE'
  | 'GH_NOT_FOUND'
  | 'GH_AUTH_REQUIRED'
  | 'GH_RATE_LIMITED'
  | 'GH_TIMEOUT'
  | 'GH_TRANSPORT_FAILED'
  | 'GH_INVALID_RESPONSE'
  | 'GH_AMBIGUOUS_OPEN_PRS'
  | 'GH_PR_ASSOCIATION_UNKNOWN'
  | 'GH_CONTRADICTORY_STATE'
  | 'GH_SNAPSHOT_CHANGED';

/** A fatal, machine-readable failure while reading GitHub live state. */
export class GitHubLiveStateError extends Error {
  readonly code: GitHubLiveStateErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: GitHubLiveStateErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Readonly<Record<string, unknown>>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GitHubLiveStateError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}


const MERGE_BINDING_REASONS = Object.freeze({
  capture: 'supported original-namespace credential capture failed',
  'capture-output': 'credential capture returned no single usable token',
  actor: 'bound actor verification failed',
  'actor-response': 'bound actor response was malformed',
  'actor-mismatch': 'bound actor differs from the accepted numeric actor',
  authority: 'final installation or current merge authority was refused',
  'merge-request': 'bound merge request failed; submission outcome may be unknown',
  'merge-response': 'bound merge response was malformed; submission outcome may be unknown',
});
export type MergeBindingStage = keyof typeof MERGE_BINDING_REASONS;
/** Closed, nonsecret reasons only. Never retain raw capture/API errors or causes. */
export class GitHubMergeBindingError extends GitHubLiveStateError {
  readonly stage: MergeBindingStage;
  constructor(stage: MergeBindingStage) {
    const safe = Object.hasOwn(MERGE_BINDING_REASONS,stage) ? stage : 'capture';
    super('GH_MERGE_BINDING_UNAVAILABLE', `Merge actor binding unavailable: ${MERGE_BINDING_REASONS[safe]}.`, {details:{stage:safe}});
    this.stage=safe;
    Object.freeze(this);
  }
}
