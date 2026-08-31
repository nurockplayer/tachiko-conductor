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

export type GitHubProblemCode =
  | 'MALFORMED_HANDOFF'
  | 'MALFORMED_HANDOFF_NEWER_THAN_SELECTED'
  | 'AMBIGUOUS_HANDOFF'
  | 'DUPLICATE_HANDOFFS'
  | 'STALE_HANDOFF'
  | 'STALE_REVIEW'
  | 'CHECKS_UNAVAILABLE'
  | 'UNKNOWN_CHECK_STATE'
  | 'CONTRADICTORY_STATE';

export interface GitHubProblem {
  readonly code: GitHubProblemCode;
  readonly message: string;
  readonly sourceId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface GitHubConversationEntry {
  readonly id: string;
  readonly scope: 'issue' | 'pull_request';
  readonly kind: 'comment' | 'review' | 'review_comment';
  readonly author: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

export interface AgentHandoffSnapshot {
  readonly sourceId: string;
  readonly sourceScope: GitHubConversationEntry['scope'];
  readonly sourceUpdatedAt: string;
  readonly sections: Readonly<Record<string, string>>;
  readonly claimedHeadSha?: string;
  readonly claimedPullRequestNumber?: number;
  readonly freshness: 'current' | 'stale' | 'unknown';
}

export interface GitHubCheckSnapshot {
  readonly id: string;
  readonly name: string;
  readonly state: 'pending' | 'passing' | 'failing' | 'unknown';
  readonly url: string | null;
  readonly updatedAt: string | null;
}

export interface GitHubCheckSummary {
  readonly availability: 'available' | 'unavailable';
  readonly overall: 'pending' | 'passing' | 'failing' | 'unknown' | 'unavailable';
  readonly checks: readonly GitHubCheckSnapshot[];
}

export interface GitHubReviewSnapshot {
  readonly id: string;
  readonly author: string | null;
  readonly state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'unknown';
  readonly commitSha: string | null;
  readonly submittedAt: string | null;
  readonly url: string;
  readonly fresh: boolean;
}

export interface GitHubReviewSummary {
  readonly decision: 'approved' | 'changes_requested' | 'review_required' | 'none';
  readonly latestByAuthor: readonly GitHubReviewSnapshot[];
  readonly unresolvedThreads: number | null;
}

export interface GitHubLivePullRequestSnapshot extends PullRequestSnapshot {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  readonly mergeable: boolean | null;
  readonly mergeStateStatus: string | null;
  readonly updatedAt: string;
}

export interface GitHubLiveSnapshot {
  readonly repository: {
    readonly owner: string;
    readonly repo: string;
    /** Populated when no associated open PR exists, so implementation has an authoritative base. */
    readonly defaultBranch: string | null;
    readonly defaultBranchHeadSha: string | null;
  };
  readonly issue: {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly state: 'open' | 'closed';
    readonly url: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly pullRequest: GitHubLivePullRequestSnapshot | null;
  readonly headSha: string | null;
  readonly checks: GitHubCheckSummary;
  readonly reviews: GitHubReviewSummary;
  readonly conversations: readonly GitHubConversationEntry[];
  readonly handoff: AgentHandoffSnapshot | null;
  readonly problems: readonly GitHubProblem[];
  readonly observedAt: string;
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
  /** Full normalized live state for an issue-target run. */
  readLiveSnapshot(target: IssueTarget): Promise<GitHubLiveSnapshot>;
}
