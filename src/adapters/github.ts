import type { IssueTarget, RepositoryTarget, Target } from '../domain/types.js';

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

/** Live snapshot of a branch for a repository-target run. */
export interface BranchSnapshot {
  readonly target: RepositoryTarget;
  readonly headSha: string;
  readonly pullRequestNumbers: readonly number[];
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
 * never on GitHub's transport. `readIssue` stays issue-specific; runs that
 * target a whole branch use `readBranch`, and PR discovery accepts either
 * target kind.
 */
export interface GitHubAdapter {
  readonly kind: 'github';
  /** Issue-scoped read; inherently issue-specific. */
  readIssue(target: IssueTarget): Promise<IssueSnapshot>;
  /** Branch-scoped read (HEAD + PRs) for repository-target runs. */
  readBranch(target: RepositoryTarget): Promise<BranchSnapshot>;
  /** Pull request discovery for either an issue or a branch. */
  listPullRequests(target: Target): Promise<readonly PullRequestSnapshot[]>;
}
