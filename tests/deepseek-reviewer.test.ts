import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewRequest } from '../src/adapters/reviewer.js';
import {
  DeepSeekReviewer,
  ReviewerError,
  type PullRequestDiffReader,
  type ReviewApiClient,
} from '../src/reviewers/deepseek.js';
import { TARGET } from './helpers.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function liveSnapshot(): GitHubLiveSnapshot {
  return {
    repository: { owner: 'acme', repo: 'widgets' },
    issue: {
      id: 'I_42',
      number: 42,
      title: 'Fix the widget',
      body: 'DoR-ready.',
      state: 'open',
      url: 'https://github.test/acme/widgets/issues/42',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z',
    },
    pullRequest: { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: null, updatedAt: '', headSha: HEAD, baseSha: 'base' },
    headSha: HEAD,
    checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: '2026-08-14T03:00:00.000Z',
  };
}

function githubAdapter(): GitHubAdapter {
  return {
    kind: 'github',
    async readIssue() {
      throw new Error('unused');
    },
    async readBranch() {
      throw new Error('unused');
    },
    async listPullRequests() {
      throw new Error('unused');
    },
    async readLiveSnapshot() {
      return liveSnapshot();
    },
  };
}

class FakeClient implements ReviewApiClient {
  readonly prompts: string[] = [];

  constructor(private readonly responses: Array<string | Error>) {}

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response queued');
    if (response instanceof Error) throw response;
    return response;
  }
}

class FakeDiffReader implements PullRequestDiffReader {
  readonly calls: Array<{ owner: string; repo: string; pullNumber: number }> = [];

  async readDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    this.calls.push({ owner, repo, pullNumber });
    return 'diff --git a/src/a.ts b/src/a.ts\n+ok';
  }
}

function reviewerJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    verdict: 'PASS',
    reviewed_head_sha: HEAD,
    blocking_findings: [],
    non_blocking_suggestions: [],
    ...overrides,
  });
}

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return { target: TARGET, headSha: HEAD, instructions: 'Review the diff.', ...overrides };
}

function makeReviewer(client: ReviewApiClient, diffReader = new FakeDiffReader()): DeepSeekReviewer {
  return new DeepSeekReviewer({ github: githubAdapter(), diffReader, client, model: 'deepseek-chat', reviewerName: 'deepseek' });
}

describe('DeepSeekReviewer', () => {
  it('converts a clean PASS to an approval bound to the exact reviewed HEAD', async () => {
    const client = new FakeClient([reviewerJson()]);
    const diffReader = new FakeDiffReader();
    const reviewer = makeReviewer(client, diffReader);

    const result = await reviewer.review(request());

    assert.deepEqual(result, { verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] });
    assert.deepEqual(diffReader.calls, [{ owner: 'acme', repo: 'widgets', pullNumber: 7 }]);
    assert.match(client.prompts[0] ?? '', /acme\/widgets#42/);
    assert.match(client.prompts[0] ?? '', /diff --git a\/src\/a.ts/);
  });

  it('routes REQUEST_CHANGES with only blocking findings back to the implementation loop', async () => {
    const client = new FakeClient([
      reviewerJson({
        verdict: 'REQUEST_CHANGES',
        blocking_findings: [{ summary: 'the diff has a bug', detail: 'line 4' }],
        non_blocking_suggestions: [{ summary: 'rename x' }],
      }),
    ]);
    const reviewer = makeReviewer(client);

    const result = await reviewer.review(request());

    assert.equal(result.verdict, 'request_changes');
    assert.equal(result.headSha, HEAD);
    assert.deepEqual(result.findings, [{ severity: 'blocking', summary: 'the diff has a bug', detail: 'line 4' }]);
  });

  it('rejects a reviewed SHA that does not match the requested HEAD', async () => {
    const client = new FakeClient([reviewerJson({ reviewed_head_sha: OTHER_HEAD })]);
    const reviewer = makeReviewer(client);

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_STALE_HEAD',
    );
  });

  it('rejects a missing reviewed SHA instead of counting it as approval', async () => {
    const client = new FakeClient([reviewerJson({ reviewed_head_sha: undefined })]);
    const reviewer = makeReviewer(client);

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_STALE_HEAD',
    );
  });

  it('rejects malformed output: unknown verdict and non-array findings', async () => {
    const unknown = new FakeClient([reviewerJson({ verdict: 'MAYBE' })]);
    await assert.rejects(
      makeReviewer(unknown).review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_INVALID_OUTPUT',
    );

    const nonArray = new FakeClient([reviewerJson({ blocking_findings: 'nope' })]);
    await assert.rejects(
      makeReviewer(nonArray).review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_INVALID_OUTPUT',
    );
  });

  it('rejects a PASS that carries blocking findings as contradictory', async () => {
    const client = new FakeClient([
      reviewerJson({ blocking_findings: [{ summary: 'must not approve' }] }),
    ]);
    const reviewer = makeReviewer(client);

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_CONTRADICTORY',
    );
  });

  it('propagates typed API failures without ever producing an approval', async () => {
    const client = new FakeClient([new ReviewerError('REVIEW_API_FAILED', 'quota', { retryable: true })]);
    const reviewer = makeReviewer(client);

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_API_FAILED' && error.retryable === true,
    );
  });

  it('rejects unparseable non-JSON reviewer output', async () => {
    const client = new FakeClient(['not json at all']);
    const reviewer = makeReviewer(client);

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_INVALID_OUTPUT',
    );
  });
});
