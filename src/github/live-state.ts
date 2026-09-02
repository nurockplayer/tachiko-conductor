import type {
  AgentHandoffSnapshot,
  BranchSnapshot,
  GitHubAdapter,
  GitHubCheckSnapshot,
  GitHubCheckSummary,
  GitHubConversationEntry,
  GitHubLivePullRequestSnapshot,
  GitHubLiveSnapshot,
  GitHubProblem,
  GitHubReviewSnapshot,
  GitHubReviewSummary,
  IssueSnapshot,
  PullRequestSnapshot,
} from '../adapters/github.js';
import type { IssueTarget, RepositoryTarget, Target } from '../domain/types.js';
import { GitHubLiveStateError } from './errors.js';
import { parseAgentHandoffs } from './handoff.js';
import type { GitHubApiTransport } from './transport.js';

export interface LiveGitHubAdapterOptions {
  readonly transport: GitHubApiTransport;
  readonly now?: () => string;
}

const KIND_ORDER: Readonly<Record<GitHubConversationEntry['kind'], number>> = {
  comment: 0,
  review: 1,
  review_comment: 2,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(path: string, detail: string): GitHubLiveStateError {
  return new GitHubLiveStateError('GH_INVALID_RESPONSE', `GitHub returned an invalid response for ${path}: ${detail}.`, {
    details: { path },
  });
}

function requireString(record: Record<string, unknown>, field: string, path: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') throw invalid(path, `missing or empty "${field}"`);
  return value;
}

function requirePositiveInt(record: Record<string, unknown>, field: string, path: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(path, `missing or invalid "${field}"`);
  }
  return value;
}

function normalizePullState(record: Record<string, unknown>): PullRequestSnapshot['state'] {
  if (record.merged_at !== null && record.merged_at !== undefined) return 'merged';
  return record.state === 'closed' ? 'closed' : 'open';
}

function normalizeReviewState(state: string): GitHubReviewSnapshot['state'] {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return 'unknown';
  }
}

function normalizeStatusState(state: string): GitHubCheckSnapshot['state'] {
  switch (state) {
    case 'success':
      return 'passing';
    case 'failure':
    case 'error':
      return 'failing';
    case 'pending':
      return 'pending';
    default:
      return 'unknown';
  }
}

function normalizeCheckRunState(status: string, conclusion: unknown): GitHubCheckSnapshot['state'] {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'passing';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
      return 'failing';
    default:
      return 'unknown';
  }
}

function compareConversations(a: GitHubConversationEntry, b: GitHubConversationEntry): number {
  const byScope = a.scope.localeCompare(b.scope);
  if (byScope !== 0) return byScope;
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  const byTime = a.updatedAt.localeCompare(b.updatedAt);
  return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
}

function dedupeById<T extends { readonly id: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

function hasClosingReference(
  pullRequest: Record<string, unknown>,
  owner: string,
  repo: string,
  issueNumber: number,
): boolean {
  if (typeof pullRequest.body !== 'string') return false;
  const escapedRepository = `${owner}/${repo}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+(?:${escapedRepository})?#${issueNumber}\\b`,
    'i',
  );
  return pattern.test(pullRequest.body);
}

interface OpenPullRequest {
  readonly number: number;
  readonly path: string;
  readonly raw: Record<string, unknown>;
}

/** Read-only GitHub live-state adapter backed by an injected transport. */
export class LiveGitHubAdapter implements GitHubAdapter {
  readonly kind: 'github' = 'github';
  private readonly transport: GitHubApiTransport;
  private readonly now: () => string;

  constructor(options: LiveGitHubAdapterOptions) {
    this.transport = options.transport;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async readIssue(target: IssueTarget): Promise<IssueSnapshot> {
    const live = await this.readLiveSnapshot(target);
    return {
      target,
      title: live.issue.title,
      body: live.issue.body,
      state: live.issue.state,
      ...(live.pullRequest === null
        ? {}
        : { headSha: live.pullRequest.headSha, pullRequestNumber: live.pullRequest.number }),
    };
  }

  async readBranch(target: RepositoryTarget): Promise<BranchSnapshot> {
    const path = `repos/${target.owner}/${target.repo}/branches/${encodeURIComponent(target.branch)}`;
    const record = asRecord(await this.transport.get(path));
    if (record === null) throw invalid(path, 'branch is not an object');
    const commit = asRecord(record.commit);
    if (commit === null) throw invalid(path, 'branch has no commit object');
    const headSha = requireString(commit, 'sha', path);
    const pullRequests = await this.listPullRequests(target);
    return { target, headSha, pullRequestNumbers: pullRequests.map((pull) => pull.number) };
  }

  async listPullRequests(target: Target): Promise<readonly PullRequestSnapshot[]> {
    const owner = target.owner;
    const repo = target.repo;
    if (target.kind === 'repository') {
      const path = `repos/${owner}/${repo}/pulls`;
      const raw = await this.transport.getPaginated(path, { head: `${owner}:${target.branch}`, state: 'open' });
      return raw.map((item) => {
        const record = asRecord(item);
        if (record === null) throw invalid(path, 'pull request entry is not an object');
        return this.normalizePullRequest(record, path);
      });
    }
    const timeline = await this.transport.getPaginated(`repos/${owner}/${repo}/issues/${target.issueNumber}/timeline`);
    const numbers = await this.discoverPullRequestNumbers(owner, repo, target.issueNumber, timeline);
    const result: PullRequestSnapshot[] = [];
    for (const number of numbers) {
      const path = `repos/${owner}/${repo}/pulls/${number}`;
      const record = asRecord(await this.transport.get(path));
      if (record === null) throw invalid(path, 'pull request is not an object');
      result.push(this.normalizePullRequest(record, path));
    }
    return result;
  }

  async readLiveSnapshot(target: IssueTarget): Promise<GitHubLiveSnapshot> {
    const owner = target.owner;
    const repo = target.repo;
    const issueNumber = target.issueNumber;
    const observedAt = this.now();
    const issuePath = `repos/${owner}/${repo}/issues/${issueNumber}`;

    const issue = this.normalizeIssue(asRecordOrThrow(await this.transport.get(issuePath), issuePath), issuePath);

    const timeline = await this.transport.getPaginated(`${issuePath}/timeline`);
    const numbers = await this.discoverPullRequestNumbers(owner, repo, issueNumber, timeline);

    const open: OpenPullRequest[] = [];
    for (const number of numbers) {
      const path = `repos/${owner}/${repo}/pulls/${number}`;
      const raw = asRecordOrThrow(await this.transport.get(path), path);
      if (requirePositiveInt(raw, 'number', path) !== number) {
        throw invalid(path, `pull request number ${String(raw.number)} does not match the referenced ${number}`);
      }
      if (raw.state === 'open') open.push({ number, path, raw });
    }
    let associated = open;
    let authoritativeClosingMatches: number | null = null;
    if (open.length > 1 && this.transport.graphql !== undefined) {
      const closingMatches: OpenPullRequest[] = [];
      for (const candidate of open) {
        if (await this.pullRequestClosesIssue(owner, repo, candidate.number, issueNumber)) {
          closingMatches.push(candidate);
        }
      }
      authoritativeClosingMatches = closingMatches.length;
      if (closingMatches.length > 0) associated = closingMatches;
    }
    if (associated.length > 1 && (authoritativeClosingMatches === null || authoritativeClosingMatches === 0)) {
      const bodyClosingMatches = associated.filter((candidate) =>
        hasClosingReference(candidate.raw, owner, repo, issueNumber),
      );
      if (bodyClosingMatches.length === 1) associated = bodyClosingMatches;
    }
    if (associated.length > 1) {
      throw new GitHubLiveStateError(
        'GH_AMBIGUOUS_OPEN_PRS',
        `Issue ${owner}/${repo}#${issueNumber} is associated with ${associated.length} open pull requests; refusing to choose.`,
        {
          retryable: true,
          details: { owner, repo, issueNumber, pullRequestNumbers: associated.map((pull) => pull.number) },
        },
      );
    }

    const problems: GitHubProblem[] = [];
    const conversations: GitHubConversationEntry[] = [];
    const selected = associated[0] ?? null;
    let defaultBranch: string | null = null;
    let defaultBranchHeadSha: string | null = null;
    if (selected === null) {
      const repositoryPath = `repos/${owner}/${repo}`;
      const repository = asRecordOrThrow(await this.transport.get(repositoryPath), repositoryPath);
      defaultBranch = requireString(repository, 'default_branch', repositoryPath);
      const commitPath = `repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}`;
      const commit = asRecordOrThrow(await this.transport.get(commitPath), commitPath);
      defaultBranchHeadSha = requireString(commit, 'sha', commitPath);
    }
    if (issue.state === 'closed' && selected !== null) {
      problems.push({
        code: 'CONTRADICTORY_STATE',
        message: `Issue ${owner}/${repo}#${issueNumber} is closed but its pull request #${selected.number} is open.`,
        details: { owner, repo, issueNumber, pullRequestNumber: selected.number },
      });
    }

    let pullRequest: GitHubLivePullRequestSnapshot | null = null;
    let headSha: string | null = null;
    let checks: GitHubCheckSummary = { availability: 'unavailable', overall: 'unavailable', checks: [] };
    let reviews: GitHubReviewSummary = { decision: 'none', latestByAuthor: [], unresolvedThreads: null };

    const issueComments = await this.transport.getPaginated(`${issuePath}/comments`);
    conversations.push(...this.normalizeCommentEntries(issueComments, `${issuePath}/comments`, 'issue', 'comment'));

    if (selected !== null) {
      const { number, path, raw } = selected;
      const live = this.normalizeLivePullRequest(raw, path);
      pullRequest = live;
      headSha = live.headSha;

      const commentsPath = `repos/${owner}/${repo}/issues/${number}/comments`;
      const reviewsPath = `repos/${owner}/${repo}/pulls/${number}/reviews`;
      const reviewCommentsPath = `repos/${owner}/${repo}/pulls/${number}/comments`;
      const prComments = await this.transport.getPaginated(commentsPath);
      const prReviews = await this.transport.getPaginated(reviewsPath);
      const prReviewComments = await this.transport.getPaginated(reviewCommentsPath);

      conversations.push(...this.normalizeCommentEntries(prComments, commentsPath, 'pull_request', 'comment'));
      conversations.push(...this.normalizeReviewEntries(prReviews, reviewsPath));
      conversations.push(...this.normalizeCommentEntries(prReviewComments, reviewCommentsPath, 'pull_request', 'review_comment'));

      const statusPath = `repos/${owner}/${repo}/commits/${headSha}/status`;
      const checkRunsPath = `repos/${owner}/${repo}/commits/${headSha}/check-runs`;
      const status = asRecord(await this.transport.get(statusPath));
      const checkRuns = asRecord(await this.transport.get(checkRunsPath));
      checks = this.normalizeChecks(status, statusPath, checkRuns, checkRunsPath, problems);

      reviews = {
        ...this.normalizeReviews(prReviews, reviewsPath, headSha, problems),
        unresolvedThreads: await this.readUnresolvedReviewThreads(owner, repo, number),
      };

      const reread = asRecordOrThrow(await this.transport.get(path), path);
      const rereadLive = this.normalizeLivePullRequest(reread, path);
      if (
        rereadLive.number !== live.number ||
        rereadLive.state !== live.state ||
        rereadLive.headSha !== live.headSha ||
        rereadLive.headRef !== live.headRef ||
        rereadLive.headRepository?.owner !== live.headRepository?.owner ||
        rereadLive.headRepository?.repo !== live.headRepository?.repo ||
        rereadLive.baseRef !== live.baseRef
      ) {
        throw new GitHubLiveStateError(
          'GH_SNAPSHOT_CHANGED',
          `Pull request #${number} changed while the live snapshot was being read; retry to avoid a mixed-SHA snapshot.`,
          { retryable: true, details: { owner, repo, pullRequestNumber: number } },
        );
      }
    }

    conversations.sort(compareConversations);
    const uniqueConversations = dedupeById(conversations);
    const parsed = parseAgentHandoffs(uniqueConversations, {
      headSha,
      pullRequestNumber: pullRequest?.number ?? null,
    });
    problems.push(...parsed.problems);

    return {
      repository: { owner, repo, defaultBranch, defaultBranchHeadSha },
      issue,
      pullRequest,
      headSha,
      checks,
      reviews,
      conversations: uniqueConversations,
      handoff: parsed.handoff,
      problems,
      observedAt,
    };
  }

  private normalizePullRequest(record: Record<string, unknown>, path: string): PullRequestSnapshot {
    const head = asRecord(record.head);
    const base = asRecord(record.base);
    if (head === null || base === null) throw invalid(path, 'missing head/base object');
    return {
      number: requirePositiveInt(record, 'number', path),
      headSha: requireString(head, 'sha', path),
      baseSha: requireString(base, 'sha', path),
      state: normalizePullState(record),
    };
  }

  private normalizeIssue(record: Record<string, unknown>, path: string): GitHubLiveSnapshot['issue'] {
    const state = record.state;
    if (state !== 'open' && state !== 'closed') throw invalid(path, `unrecognized issue state "${String(state)}"`);
    return {
      id: requireString(record, 'node_id', path),
      number: requirePositiveInt(record, 'number', path),
      title: requireString(record, 'title', path),
      body: typeof record.body === 'string' ? record.body : '',
      state,
      url: requireString(record, 'html_url', path),
      createdAt: requireString(record, 'created_at', path),
      updatedAt: requireString(record, 'updated_at', path),
    };
  }

  private normalizeLivePullRequest(record: Record<string, unknown>, path: string): GitHubLivePullRequestSnapshot {
    const head = asRecord(record.head);
    const base = asRecord(record.base);
    if (head === null || base === null) throw invalid(path, 'missing head/base object');
    const headRepo = asRecord(head.repo);
    const headRepoOwner = asRecord(headRepo?.owner);
    if (headRepo !== null && headRepoOwner === null) throw invalid(path, 'missing head repository owner');
    const headSha = typeof head.sha === 'string' && head.sha.trim() !== '' ? head.sha : null;
    if (headSha === null) {
      throw new GitHubLiveStateError(
        'GH_CONTRADICTORY_STATE',
        `Pull request ${requirePositiveInt(record, 'number', path)} has an empty HEAD SHA.`,
        { details: { path } },
      );
    }
    return {
      id: requireString(record, 'node_id', path),
      number: requirePositiveInt(record, 'number', path),
      title: requireString(record, 'title', path),
      url: requireString(record, 'html_url', path),
      state: normalizePullState(record),
      isDraft: record.draft === true,
      mergeable: typeof record.mergeable === 'boolean' ? record.mergeable : null,
      mergeStateStatus:
        typeof record.mergeable_state === 'string'
          ? record.mergeable_state
          : typeof record.merge_state_status === 'string'
            ? record.merge_state_status
            : null,
      updatedAt: requireString(record, 'updated_at', path),
      headSha,
      baseSha: requireString(base, 'sha', path),
      headRef: requireString(head, 'ref', path),
      headRepository: headRepo === null
        ? null
        : {
            owner: requireString(headRepoOwner as Record<string, unknown>, 'login', path),
            repo: requireString(headRepo, 'name', path),
          },
      baseRef: requireString(base, 'ref', path),
    };
  }

  private async discoverPullRequestNumbers(
    owner: string,
    repo: string,
    issueNumber: number,
    timeline: readonly unknown[],
  ): Promise<number[]> {
    const numbers = new Set<number>();
    for (const item of timeline) {
      const event = asRecord(item);
      if (event === null) continue;
      const source = asRecord(event.source);
      if (source === null) continue;
      const issue = asRecord(source.issue);
      if (issue === null) continue;
      if (issue.pull_request === undefined || issue.pull_request === null) continue;
      const fromNumber =
        typeof issue.number === 'number' && Number.isSafeInteger(issue.number) && issue.number > 0
          ? issue.number
          : undefined;
      if (fromNumber !== undefined) {
        numbers.add(fromNumber);
        continue;
      }
      const url = typeof issue.pull_request === 'object' && issue.pull_request !== null
        ? (issue.pull_request as Record<string, unknown>).url
        : undefined;
      if (typeof url === 'string') {
        const match = url.match(/\/pull(?:s)?\/(\d+)/);
        if (match !== null) numbers.add(Number(match[1]));
      }
    }
    return [...numbers].sort((a, b) => a - b);
  }

  private async readUnresolvedReviewThreads(owner: string, repo: string, number: number): Promise<number | null> {
    if (this.transport.graphql === undefined) return null;
    const query = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
    let unresolved = 0;
    let after: string | null = null;
    for (;;) {
      const variables: Record<string, string | number> = { owner, repo, number };
      if (after !== null) variables.after = after;
      const path = `graphql:repos/${owner}/${repo}/pulls/${number}/reviewThreads`;
      const response = asRecordOrThrow(await this.transport.graphql(query, variables), path);
      if (Array.isArray(response.errors) && response.errors.length > 0) {
        throw invalid(path, 'GraphQL returned errors');
      }
      const data = asRecord(response.data);
      const repository = asRecord(data?.repository);
      const pullRequest = asRecord(repository?.pullRequest);
      const reviewThreads = asRecord(pullRequest?.reviewThreads);
      const nodes = reviewThreads?.nodes;
      const pageInfo = asRecord(reviewThreads?.pageInfo);
      if (!Array.isArray(nodes) || pageInfo === null || typeof pageInfo.hasNextPage !== 'boolean') {
        throw invalid(path, 'missing reviewThreads nodes/pageInfo');
      }
      for (const node of nodes) {
        const thread = asRecord(node);
        if (thread === null || typeof thread.isResolved !== 'boolean') {
          throw invalid(path, 'invalid review thread');
        }
        if (!thread.isResolved) unresolved += 1;
      }
      if (!pageInfo.hasNextPage) return unresolved;
      if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor === '') {
        throw invalid(path, 'missing endCursor for the next review-thread page');
      }
      after = pageInfo.endCursor;
    }
  }

  private async pullRequestClosesIssue(
    owner: string,
    repo: string,
    pullRequestNumber: number,
    issueNumber: number,
  ): Promise<boolean> {
    if (this.transport.graphql === undefined) return false;
    const query = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $after) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
    let after: string | null = null;
    for (;;) {
      const variables: Record<string, string | number> = { owner, repo, number: pullRequestNumber };
      if (after !== null) variables.after = after;
      const path = `graphql:repos/${owner}/${repo}/pulls/${pullRequestNumber}/closingIssuesReferences`;
      const response = asRecordOrThrow(await this.transport.graphql(query, variables), path);
      if (Array.isArray(response.errors) && response.errors.length > 0) {
        throw invalid(path, 'GraphQL returned errors');
      }
      const data = asRecord(response.data);
      const repository = asRecord(data?.repository);
      const pullRequest = asRecord(repository?.pullRequest);
      const references = asRecord(pullRequest?.closingIssuesReferences);
      const nodes = references?.nodes;
      const pageInfo = asRecord(references?.pageInfo);
      if (!Array.isArray(nodes) || pageInfo === null || typeof pageInfo.hasNextPage !== 'boolean') {
        throw invalid(path, 'missing closingIssuesReferences nodes/pageInfo');
      }
      for (const node of nodes) {
        const issue = asRecord(node);
        const issueRepository = asRecord(issue?.repository);
        if (
          issue?.number === issueNumber &&
          issueRepository?.nameWithOwner === `${owner}/${repo}`
        ) {
          return true;
        }
      }
      if (!pageInfo.hasNextPage) return false;
      if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor === '') {
        throw invalid(path, 'missing endCursor for the next closing-issue page');
      }
      after = pageInfo.endCursor;
    }
  }

  private normalizeCommentEntries(
    raw: readonly unknown[],
    path: string,
    scope: GitHubConversationEntry['scope'],
    kind: GitHubConversationEntry['kind'],
  ): GitHubConversationEntry[] {
    const entries: GitHubConversationEntry[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (record === null) throw invalid(path, 'comment entry is not an object');
      entries.push({
        id: requireString(record, 'node_id', path),
        scope,
        kind,
        author: this.authorLogin(record, path),
        body: typeof record.body === 'string' ? record.body : '',
        createdAt: requireString(record, 'created_at', path),
        updatedAt: requireString(record, 'updated_at', path),
        url: requireString(record, 'html_url', path),
      });
    }
    return entries;
  }

  private normalizeReviewEntries(raw: readonly unknown[], path: string): GitHubConversationEntry[] {
    const entries: GitHubConversationEntry[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (record === null) throw invalid(path, 'review entry is not an object');
      const submittedAt = typeof record.submitted_at === 'string' ? record.submitted_at : '';
      if (submittedAt === '' || record.state === 'PENDING') continue;
      entries.push({
        id: requireString(record, 'node_id', path),
        scope: 'pull_request',
        kind: 'review',
        author: this.authorLogin(record, path),
        body: typeof record.body === 'string' ? record.body : '',
        createdAt: submittedAt,
        updatedAt: submittedAt,
        url: requireString(record, 'html_url', path),
      });
    }
    return entries;
  }

  private authorLogin(record: Record<string, unknown>, path: string): string | null {
    const user = asRecord(record.user);
    if (user === null) return null;
    const login = user.login;
    return typeof login === 'string' && login !== '' ? login : null;
  }

  private normalizeChecks(
    status: Record<string, unknown> | null,
    statusPath: string,
    checkRuns: Record<string, unknown> | null,
    checkRunsPath: string,
    problems: GitHubProblem[],
  ): GitHubCheckSummary {
    const checks: GitHubCheckSnapshot[] = [];
    let available = false;

    if (status !== null) {
      const statuses = status.statuses;
      if (Array.isArray(statuses)) {
        available = true;
        for (const item of statuses) {
          const record = asRecord(item);
          if (record === null) throw invalid(statusPath, 'status entry is not an object');
          checks.push({
            id: String(record.id ?? ''),
            name: requireString(record, 'context', statusPath),
            state: normalizeStatusState(String(record.state ?? '')),
            url: typeof record.target_url === 'string' ? record.target_url : null,
            updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
          });
        }
      }
    }

    if (checkRuns !== null) {
      const runs = checkRuns.check_runs;
      if (Array.isArray(runs)) {
        available = true;
        for (const item of runs) {
          const record = asRecord(item);
          if (record === null) throw invalid(checkRunsPath, 'check run entry is not an object');
          const state = normalizeCheckRunState(String(record.status ?? ''), record.conclusion);
          const id = requireString(record, 'name', checkRunsPath);
          if (state === 'unknown') {
            problems.push({
              code: 'UNKNOWN_CHECK_STATE',
              message: `Check run "${id}" has an unrecognized status/conclusion.`,
              sourceId: String(record.id ?? ''),
              details: { name: id, status: record.status, conclusion: record.conclusion },
            });
          }
          checks.push({
            id: String(record.id ?? ''),
            name: id,
            state,
            url: typeof record.html_url === 'string' ? record.html_url : null,
            updatedAt: typeof record.completed_at === 'string' ? record.completed_at : null,
          });
        }
      }
    }

    if (checks.length === 0) {
      return available
        ? { availability: 'available', overall: 'passing', checks: [] }
        : { availability: 'unavailable', overall: 'unavailable', checks: [] };
    }
    const states = new Set(checks.map((check) => check.state));
    const overall: GitHubCheckSummary['overall'] = states.has('failing')
      ? 'failing'
      : states.has('pending')
        ? 'pending'
        : states.has('unknown')
          ? 'unknown'
          : 'passing';
    return { availability: 'available', overall, checks };
  }

  private normalizeReviews(
    raw: readonly unknown[],
    path: string,
    headSha: string,
    problems: GitHubProblem[],
  ): GitHubReviewSummary {
    const reviews: GitHubReviewSnapshot[] = [];
    for (const item of raw) {
      const record = asRecord(item);
      if (record === null) throw invalid(path, 'review entry is not an object');
      if (record.state === 'PENDING') continue;
      const submittedAt = typeof record.submitted_at === 'string' ? record.submitted_at : '';
      if (submittedAt === '') continue;
      const commitSha = typeof record.commit_id === 'string' && record.commit_id !== '' ? record.commit_id : null;
      const review: GitHubReviewSnapshot = {
        id: requireString(record, 'node_id', path),
        author: this.authorLogin(record, path),
        state: normalizeReviewState(String(record.state ?? '')),
        commitSha,
        submittedAt,
        url: requireString(record, 'html_url', path),
        fresh: commitSha !== null && commitSha === headSha,
      };
      if (commitSha !== null && commitSha !== headSha) {
        problems.push({
          code: 'STALE_REVIEW',
          message: `Review ${review.id} is bound to commit ${commitSha}, not the live HEAD ${headSha}.`,
          sourceId: review.id,
          details: { reviewCommitSha: commitSha, liveHeadSha: headSha },
        });
      }
      reviews.push(review);
    }

    const latestByAuthor = new Map<string, GitHubReviewSnapshot>();
    for (const review of reviews) {
      const key = review.author ?? '';
      const existing = latestByAuthor.get(key);
      if (existing === undefined || (review.submittedAt ?? '') > (existing.submittedAt ?? '')) {
        latestByAuthor.set(key, review);
      }
    }
    const latest = [...latestByAuthor.values()].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
    const decision: GitHubReviewSummary['decision'] =
      latest.length === 0
        ? 'none'
        : latest.some((review) => review.state === 'changes_requested')
          ? 'changes_requested'
          : latest.some((review) => review.state === 'approved')
            ? 'approved'
            : 'review_required';

    return { decision, latestByAuthor: latest, unresolvedThreads: null };
  }
}

function asRecordOrThrow(value: unknown, path: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === null) throw invalid(path, 'response is not an object');
  return record;
}
