export type GitHubLiveStateErrorCode =
  | 'GH_NOT_FOUND'
  | 'GH_AUTH_REQUIRED'
  | 'GH_RATE_LIMITED'
  | 'GH_TIMEOUT'
  | 'GH_TRANSPORT_FAILED'
  | 'GH_INVALID_RESPONSE'
  | 'GH_AMBIGUOUS_OPEN_PRS'
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

