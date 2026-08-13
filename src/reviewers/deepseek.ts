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
  | 'REVIEW_NO_PR';

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
  readDiff(owner: string, repo: string, pullNumber: number): Promise<string>;
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
    let prompt: string;
    if (target.kind === 'issue') {
      const snapshot = await this.github.readLiveSnapshot(target);
      const pullNumber = snapshot.pullRequest?.number ?? null;
      if (pullNumber === null) {
        throw new ReviewerError(
          'REVIEW_NO_PR',
          `Issue ${target.owner}/${target.repo}#${target.issueNumber} has no associated pull request to review.`,
        );
      }
      const diff = await this.diffReader.readDiff(target.owner, target.repo, pullNumber);
      prompt = buildReviewPrompt({ target, headSha, pullRequestNumber: pullNumber, diff, instructions: request.instructions, snapshot });
    } else {
      const branch = await this.github.readBranch(target);
      const pullNumber = branch.pullRequestNumbers[0] ?? null;
      if (pullNumber === null) {
        throw new ReviewerError(
          'REVIEW_NO_PR',
          `Branch ${target.owner}/${target.repo}@${target.branch} has no open pull request to review.`,
        );
      }
      const diff = await this.diffReader.readDiff(target.owner, target.repo, pullNumber);
      prompt = buildReviewPrompt({
        target,
        headSha,
        pullRequestNumber: pullNumber,
        diff,
        instructions: request.instructions,
        branchHead: branch.headSha,
      });
    }

    const raw = await this.client.complete(prompt, { model: this.model });
    return this.parseReview(raw, headSha);
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

    const blockers = record.blocking_findings;
    if (!Array.isArray(blockers)) throw invalidOutput('Reviewer output is missing the blocking_findings array.');
    const findings: ReviewFinding[] = blockers.map((blocker) => {
      const finding = asRecord(blocker);
      if (finding === null) throw invalidOutput('A blocking finding was not an object.');
      const summary = typeof finding.summary === 'string' ? finding.summary.trim() : '';
      if (summary === '') throw invalidOutput('A blocking finding is missing a summary.');
      const detail = typeof finding.detail === 'string' && finding.detail !== '' ? finding.detail : undefined;
      return { severity: 'blocking', summary, ...(detail === undefined ? {} : { detail }) };
    });

    if (record.verdict === 'PASS') {
      if (findings.length > 0) {
        throw new ReviewerError(
          'REVIEW_CONTRADICTORY',
          'Reviewer returned PASS while also listing blocking findings; refusing the approval.',
          { details: { findingCount: findings.length } },
        );
      }
      return { verdict: 'approve', reviewerName: this.reviewerName, headSha, findings: [] };
    }
    if (record.verdict === 'REQUEST_CHANGES') {
      return { verdict: 'request_changes', reviewerName: this.reviewerName, headSha, findings };
    }
    throw invalidOutput(`Unknown reviewer verdict "${String(record.verdict)}".`);
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

  async readDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const files = await this.transport.getPaginated(`repos/${owner}/${repo}/pulls/${pullNumber}/files`);
    return files
      .map((item) => {
        const record = asRecord(item);
        if (record === null) return '';
        const filename = typeof record.filename === 'string' ? record.filename : '?';
        const status = typeof record.status === 'string' ? record.status : 'modified';
        const patch = typeof record.patch === 'string' ? record.patch : '(no patch)';
        return `### ${filename} (${status})\n${patch}`;
      })
      .filter((section) => section !== '')
      .join('\n\n');
  }
}
