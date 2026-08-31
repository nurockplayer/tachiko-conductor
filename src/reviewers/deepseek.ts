import type { GitHubAdapter, GitHubLiveSnapshot } from '../adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../adapters/reviewer.js';
import type { ReviewFinding, ReviewResult, Target } from '../domain/types.js';
import type { GitHubApiTransport } from '../github/transport.js';

export type ReviewerErrorCode =
  | 'REVIEW_INVALID_OUTPUT'
  | 'REVIEW_STALE_HEAD'
  | 'REVIEW_CONTRADICTORY'
  | 'REVIEW_API_FAILED'
  | 'REVIEW_API_UNAUTHORIZED'
  | 'REVIEW_API_TIMEOUT'
  | 'REVIEW_NO_PR'
  | 'REVIEW_GITHUB_FAILED'
  | 'REVIEW_DIFF_FAILED'
  | 'REVIEW_DIFF_INCOMPLETE';

/** A fatal, machine-readable reviewer failure. Never counts as an approval. */
export class ReviewerError extends Error {
  readonly code: ReviewerErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ReviewerErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Readonly<Record<string, unknown>>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReviewerError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export interface ReviewApiClient {
  complete(prompt: string, options: { model: string }): Promise<string>;
}

export interface PullRequestDiffReader {
  readDiff(owner: string, repo: string, pullNumber: number, expectedHeadSha: string): Promise<string>;
}

export interface DeepSeekReviewerOptions {
  readonly github: GitHubAdapter;
  readonly diffReader: PullRequestDiffReader;
  readonly client: ReviewApiClient;
  readonly model?: string;
  readonly reviewerName?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidOutput(message: string): ReviewerError {
  return new ReviewerError('REVIEW_INVALID_OUTPUT', message);
}

interface PromptContext {
  readonly target: Target;
  readonly headSha: string;
  readonly pullRequestNumber: number;
  readonly diff: string;
  readonly instructions?: string;
  readonly snapshot?: GitHubLiveSnapshot;
  readonly branchHead?: string;
}

function buildReviewPrompt(context: PromptContext): string {
  const lines = [
    'You are an independent code reviewer for a pull request. Review the diff at the exact HEAD SHA below.',
    '',
    `Target: ${formatTarget(context.target)}`,
    `Pull request: #${context.pullRequestNumber}`,
    `HEAD SHA: ${context.headSha}`,
  ];
  if (context.snapshot !== undefined) {
    lines.push(`Issue state: ${context.snapshot.issue.state}`, `Issue title: ${context.snapshot.issue.title}`);
    lines.push('', 'Issue/spec context:', context.snapshot.issue.body === '' ? '(no issue body)' : context.snapshot.issue.body);
  }
  if (context.branchHead !== undefined) {
    lines.push(`Branch HEAD: ${context.branchHead}`);
  }
  if (context.instructions !== undefined && context.instructions !== '') {
    lines.push('', 'Review instructions:', context.instructions);
  }
  lines.push('', 'Diff:', context.diff);
  lines.push(
    '',
    'Respond with ONLY JSON:',
    '{ "verdict": "PASS" or "REQUEST_CHANGES", "reviewed_head_sha": "<exact 40-hex HEAD SHA>", "blocking_findings": [{"summary": "...", "detail": "..."}], "non_blocking_suggestions": [{"summary": "..."}] }',
  );
  return lines.join('\n');
}

function formatTarget(target: Target): string {
  if (target.kind === 'issue') return `${target.owner}/${target.repo}#${target.issueNumber}`;
  return `${target.owner}/${target.repo}@${target.branch}`;
}

function retryableFrom(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true;
}

function normalizeBoundaryError(
  code: 'REVIEW_GITHUB_FAILED' | 'REVIEW_DIFF_FAILED' | 'REVIEW_API_FAILED',
  operation: string,
  error: unknown,
): ReviewerError {
  if (error instanceof ReviewerError) return error;
  return new ReviewerError(code, `${operation} failed: ${errorMessage(error)}`, {
    retryable: retryableFrom(error),
    details: { operation },
    cause: error,
  });
}

function assertExpectedHead(
  actualHeadSha: string | null,
  expectedHeadSha: string,
  context: Readonly<Record<string, unknown>>,
): asserts actualHeadSha is string {
  if (actualHeadSha !== expectedHeadSha) {
    throw new ReviewerError(
      'REVIEW_STALE_HEAD',
      `Live GitHub HEAD "${actualHeadSha ?? '(none)'}" does not match requested HEAD "${expectedHeadSha}".`,
      {
        retryable: true,
        details: { ...context, liveHeadSha: actualHeadSha, requestedHeadSha: expectedHeadSha },
      },
    );
  }
}

interface ReviewIdentity {
  readonly pullRequestNumber: number;
  readonly snapshot?: GitHubLiveSnapshot;
  readonly branchHead?: string;
}

/**
 * Independent reviewer backed by a configurable DeepSeek chat-completions
 * endpoint. Output is validated before it can become an approval: a stale,
 * malformed, or contradictory result throws a typed ReviewerError instead.
 */
export class DeepSeekReviewer implements ReviewerAdapter {
  readonly kind: 'reviewer' = 'reviewer';
  private readonly github: GitHubAdapter;
  private readonly diffReader: PullRequestDiffReader;
  private readonly client: ReviewApiClient;
  private readonly model: string;
  private readonly reviewerName: string;

  constructor(options: DeepSeekReviewerOptions) {
    this.github = options.github;
    this.diffReader = options.diffReader;
    this.client = options.client;
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
    this.reviewerName = options.reviewerName ?? 'deepseek';
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const { target, headSha } = request;
    const beforeDiff = await this.readIdentity(target, headSha);
    let diff: string;
    try {
      diff = await this.diffReader.readDiff(target.owner, target.repo, beforeDiff.pullRequestNumber, headSha);
    } catch (error) {
      throw normalizeBoundaryError('REVIEW_DIFF_FAILED', 'Pull request diff acquisition', error);
    }
    const afterDiff = await this.readIdentity(target, headSha);
    this.assertSamePullRequest(beforeDiff, afterDiff, headSha);

    const prompt = buildReviewPrompt({
      target,
      headSha,
      pullRequestNumber: beforeDiff.pullRequestNumber,
      diff,
      instructions: request.instructions,
      ...(beforeDiff.snapshot === undefined ? {} : { snapshot: beforeDiff.snapshot }),
      ...(beforeDiff.branchHead === undefined ? {} : { branchHead: beforeDiff.branchHead }),
    });

    let raw: string;
    try {
      raw = await this.client.complete(prompt, { model: this.model });
    } catch (error) {
      throw normalizeBoundaryError('REVIEW_API_FAILED', 'Reviewer API request', error);
    }
    const afterReview = await this.readIdentity(target, headSha);
    this.assertSamePullRequest(beforeDiff, afterReview, headSha);
    return this.parseReview(raw, headSha);
  }

  private async readIdentity(target: Target, expectedHeadSha: string): Promise<ReviewIdentity> {
    try {
      if (target.kind === 'issue') {
        const snapshot = await this.github.readLiveSnapshot(target);
        const pullNumber = snapshot.pullRequest?.number ?? null;
        if (pullNumber === null) {
          throw new ReviewerError(
            'REVIEW_NO_PR',
            `Issue ${target.owner}/${target.repo}#${target.issueNumber} has no associated pull request to review.`,
          );
        }
        assertExpectedHead(snapshot.headSha, expectedHeadSha, {
          owner: target.owner,
          repo: target.repo,
          pullRequestNumber: pullNumber,
        });
        return { pullRequestNumber: pullNumber, snapshot };
      }

      const branch = await this.github.readBranch(target);
      assertExpectedHead(branch.headSha, expectedHeadSha, {
        owner: target.owner,
        repo: target.repo,
        branch: target.branch,
      });
      const pullNumber = branch.pullRequestNumbers[0] ?? null;
      if (pullNumber === null) {
        throw new ReviewerError(
          'REVIEW_NO_PR',
          `Branch ${target.owner}/${target.repo}@${target.branch} has no open pull request to review.`,
        );
      }
      return { pullRequestNumber: pullNumber, branchHead: branch.headSha };
    } catch (error) {
      throw normalizeBoundaryError('REVIEW_GITHUB_FAILED', 'GitHub review identity read', error);
    }
  }

  private assertSamePullRequest(before: ReviewIdentity, after: ReviewIdentity, expectedHeadSha: string): void {
    if (after.pullRequestNumber !== before.pullRequestNumber) {
      throw new ReviewerError(
        'REVIEW_STALE_HEAD',
        `GitHub selected pull request #${after.pullRequestNumber} after initially selecting #${before.pullRequestNumber}; refusing a mixed review.`,
        {
          retryable: true,
          details: {
            requestedHeadSha: expectedHeadSha,
            beforePullRequestNumber: before.pullRequestNumber,
            afterPullRequestNumber: after.pullRequestNumber,
          },
        },
      );
    }
  }

  private parseReview(raw: string, headSha: string): ReviewResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw invalidOutput('Reviewer output was not valid JSON.');
    }
    const record = asRecord(parsed);
    if (record === null) throw invalidOutput('Reviewer output was not a JSON object.');

    const reviewedSha = record.reviewed_head_sha;
    if (typeof reviewedSha !== 'string' || reviewedSha.trim().toLowerCase() !== headSha.trim().toLowerCase()) {
      throw new ReviewerError(
        'REVIEW_STALE_HEAD',
        `Reviewer claimed HEAD "${String(reviewedSha)}" but the review was requested for "${headSha}".`,
        { details: { reviewedHeadSha: reviewedSha, requestedHeadSha: headSha } },
      );
    }

    const blockers = this.parseFindings(record.blocking_findings, 'blocking', 'blocking_findings');
    const suggestions = this.parseFindings(
      record.non_blocking_suggestions,
      'non_blocking',
      'non_blocking_suggestions',
    );

    if (record.verdict === 'PASS') {
      if (blockers.length > 0) {
        throw new ReviewerError(
          'REVIEW_CONTRADICTORY',
          'Reviewer returned PASS while also listing blocking findings; refusing the approval.',
          { details: { findingCount: blockers.length } },
        );
      }
      return { verdict: 'approve', reviewerName: this.reviewerName, headSha, findings: suggestions };
    }
    if (record.verdict === 'REQUEST_CHANGES') {
      if (blockers.length === 0) {
        throw new ReviewerError(
          'REVIEW_CONTRADICTORY',
          'Reviewer returned REQUEST_CHANGES without any actionable blocking findings.',
        );
      }
      return {
        verdict: 'request_changes',
        reviewerName: this.reviewerName,
        headSha,
        findings: [...blockers, ...suggestions],
      };
    }
    throw invalidOutput(`Unknown reviewer verdict "${String(record.verdict)}".`);
  }

  private parseFindings(
    value: unknown,
    severity: ReviewFinding['severity'],
    fieldName: 'blocking_findings' | 'non_blocking_suggestions',
  ): ReviewFinding[] {
    if (!Array.isArray(value)) throw invalidOutput(`Reviewer output is missing the ${fieldName} array.`);
    return value.map((item) => {
      const finding = asRecord(item);
      if (finding === null) throw invalidOutput(`An item in ${fieldName} was not an object.`);
      const summary = typeof finding.summary === 'string' ? finding.summary.trim() : '';
      if (summary === '') throw invalidOutput(`An item in ${fieldName} is missing a summary.`);
      if (finding.detail !== undefined && typeof finding.detail !== 'string') {
        throw invalidOutput(`An item in ${fieldName} has a non-string detail.`);
      }
      const detail = typeof finding.detail === 'string' && finding.detail.trim() !== ''
        ? finding.detail.trim()
        : undefined;
      return { severity, summary, ...(detail === undefined ? {} : { detail }) };
    });
  }
}

export interface DeepSeekApiClientOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/** Production DeepSeek (OpenAI-compatible) chat-completions client. */
export class DeepSeekApiClient implements ReviewApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: DeepSeekApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '';
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async complete(prompt: string, options: { model: string }): Promise<string> {
    if (this.apiKey === '') {
      throw new ReviewerError('REVIEW_API_UNAUTHORIZED', 'DeepSeek API key is not configured.', {
        details: { hint: 'Set DEEPSEEK_API_KEY.' },
      });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ReviewerError('REVIEW_API_TIMEOUT', `DeepSeek request timed out after ${this.timeoutMs}ms.`, {
          retryable: true,
        });
      }
      throw new ReviewerError('REVIEW_API_FAILED', `DeepSeek request failed: ${errorMessage(error)}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ReviewerError('REVIEW_API_UNAUTHORIZED', 'DeepSeek authentication failed.', {});
    }
    if (response.status === 429) {
      throw new ReviewerError('REVIEW_API_FAILED', 'DeepSeek rate-limited the request.', { retryable: true });
    }
    if (!response.ok) {
      throw new ReviewerError('REVIEW_API_FAILED', `DeepSeek returned HTTP ${response.status}.`, {
        retryable: response.status >= 500,
      });
    }
    let data: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new ReviewerError('REVIEW_INVALID_OUTPUT', 'DeepSeek returned invalid JSON.', {});
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ReviewerError('REVIEW_INVALID_OUTPUT', 'DeepSeek returned an empty completion.', {});
    }
    return content;
  }
}

/** PR diff reader backed by the issue #3 GitHub API transport. */
export class GhPullRequestDiffReader implements PullRequestDiffReader {
  constructor(private readonly transport: GitHubApiTransport) {}

  async readDiff(owner: string, repo: string, pullNumber: number, expectedHeadSha: string): Promise<string> {
    const path = `repos/${owner}/${repo}/pulls/${pullNumber}`;
    const before = await this.readPullMetadata(path, expectedHeadSha);
    if (this.transport.getRaw === undefined) {
      throw new ReviewerError(
        'REVIEW_DIFF_INCOMPLETE',
        'GitHub transport cannot read the complete pull-request diff representation.',
        { details: { owner, repo, pullRequestNumber: pullNumber, expectedHeadSha } },
      );
    }
    const diff = await this.transport.getRaw(path, 'application/vnd.github.diff');
    const after = await this.readPullMetadata(path, expectedHeadSha);
    if (
      after.changedFiles !== before.changedFiles ||
      after.additions !== before.additions ||
      after.deletions !== before.deletions
    ) {
      throw new ReviewerError(
        'REVIEW_STALE_HEAD',
        `Pull request #${pullNumber} diff metadata changed while the diff was being read.`,
        { retryable: true, details: { owner, repo, pullRequestNumber: pullNumber, expectedHeadSha } },
      );
    }
    if (!this.isCompleteDiff(diff, before)) {
      throw new ReviewerError(
        'REVIEW_DIFF_INCOMPLETE',
        `GitHub did not return a complete unified diff for pull request #${pullNumber}.`,
        { details: { owner, repo, pullRequestNumber: pullNumber, expectedHeadSha, ...before } },
      );
    }
    return diff;
  }

  private async readPullMetadata(
    path: string,
    expectedHeadSha: string,
  ): Promise<{ readonly changedFiles: number; readonly additions: number; readonly deletions: number }> {
    const pull = asRecord(await this.transport.get(path));
    const head = pull === null ? null : asRecord(pull.head);
    const actualHeadSha = head !== null && typeof head.sha === 'string' ? head.sha : null;
    assertExpectedHead(actualHeadSha, expectedHeadSha, { path });
    const changedFiles = pull?.changed_files;
    const additions = pull?.additions;
    const deletions = pull?.deletions;
    if (
      typeof changedFiles !== 'number' || !Number.isInteger(changedFiles) || changedFiles < 1 ||
      typeof additions !== 'number' || !Number.isInteger(additions) || additions < 0 ||
      typeof deletions !== 'number' || !Number.isInteger(deletions) || deletions < 0
    ) {
      throw new ReviewerError(
        'REVIEW_DIFF_INCOMPLETE',
        'GitHub pull-request metadata did not include valid diff completeness counters.',
        { details: { path, expectedHeadSha } },
      );
    }
    return { changedFiles, additions, deletions };
  }

  private isCompleteDiff(
    diff: string,
    expected: { readonly changedFiles: number; readonly additions: number; readonly deletions: number },
  ): boolean {
    const lines = diff.split('\n');
    const sectionStarts = lines
      .map((line, index) => line.startsWith('diff --git ') ? index : -1)
      .filter((index) => index >= 0);
    if (sectionStarts.length !== expected.changedFiles) return false;

    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) additions += 1;
      if (line.startsWith('-') && !line.startsWith('--- ')) deletions += 1;
    }
    if (additions !== expected.additions || deletions !== expected.deletions) return false;

    return sectionStarts.every((start, sectionIndex) => {
      const end = sectionStarts[sectionIndex + 1] ?? lines.length;
      return lines.slice(start + 1, end).some((line) =>
        line.startsWith('@@ ') ||
        line.startsWith('Binary files ') ||
        line === 'GIT binary patch' ||
        /^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to) /.test(line),
      );
    });
  }
}
