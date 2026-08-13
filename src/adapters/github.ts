import type { IssueTarget } from '../domain/types.js';

/** Live snapshot of an issue as seen by the GitHub adapter. */
export interface IssueSnapshot {
  readonly target: IssueTarget;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  /** HEAD SHA of the pull request currently implementing the issue, if any. */
  readonly headSha?: string;
  readonly pullRequestNumber?: number;
}

export interface PullRequestSnapshot {
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly state: 'open' | 'merged' | 'closed';
}

/**
 * Read-side boundary to live GitHub state. Concrete implementations (GitHub
 * CLI / REST) are added in issue #3; the core depends only on this interface,
 * never on GitHub's transport.
 */
export interface GitHubAdapter {
  readonly kind: 'github';
  readIssue(target: IssueTarget): Promise<IssueSnapshot>;
  listPullRequests(target: IssueTarget): Promise<readonly PullRequestSnapshot[]>;
}
