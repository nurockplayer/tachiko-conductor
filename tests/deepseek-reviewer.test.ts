import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewRequest } from '../src/adapters/reviewer.js';
import {
  DeepSeekApiClient,
  DeepSeekReviewer,
  GhPullRequestDiffReader,
  ReviewerError,
  type PullRequestDiffReader,
  type ReviewApiClient,
  type ReviewCompletion,
} from '../src/reviewers/deepseek.js';
import type { GitHubApiTransport } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function liveSnapshot(headSha: string = HEAD): GitHubLiveSnapshot {
  return {
    repository: { owner: 'acme', repo: 'widgets', defaultBranch: null, defaultBranchHeadSha: null },
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
    pullRequest: { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: null, updatedAt: '', headSha, baseSha: 'base' },
    headSha,
    checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: '2026-08-14T03:00:00.000Z',
  };
}

function githubAdapter(outcomes: Array<GitHubLiveSnapshot | Error> = [liveSnapshot()]): GitHubAdapter {
  let index = 0;
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
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome === undefined) throw new Error('No live snapshot queued');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

class FakeClient implements ReviewApiClient {
  readonly prompts: string[] = [];

  constructor(private readonly responses: Array<string | ReviewCompletion | Error>) {}

  async complete(prompt: string): Promise<string | ReviewCompletion> {
    this.prompts.push(prompt);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No fake response queued');
    if (response instanceof Error) throw response;
    return response;
  }
}

class FakeDiffReader implements PullRequestDiffReader {
  readonly calls: Array<{ owner: string; repo: string; pullNumber: number; expectedHeadSha: string }> = [];

  constructor(private readonly outcome: string | Error = 'diff --git a/src/a.ts b/src/a.ts\n+ok') {}

  async readDiff(owner: string, repo: string, pullNumber: number, expectedHeadSha: string): Promise<string> {
    this.calls.push({ owner, repo, pullNumber, expectedHeadSha });
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
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

function makeReviewer(
  client: ReviewApiClient,
  diffReader = new FakeDiffReader(),
  github: GitHubAdapter = githubAdapter(),
): DeepSeekReviewer {
  return new DeepSeekReviewer({ github, diffReader, client, model: 'deepseek-chat', reviewerName: 'deepseek' });
}

describe('DeepSeekReviewer', () => {
  it('converts a clean PASS to an approval bound to the exact reviewed HEAD', async () => {
    const client = new FakeClient([reviewerJson()]);
    const diffReader = new FakeDiffReader();
    const reviewer = makeReviewer(client, diffReader);

    const result = await reviewer.review(request());

    assert.deepEqual(result, { verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] });
    assert.deepEqual(diffReader.calls, [{ owner: 'acme', repo: 'widgets', pullNumber: 7, expectedHeadSha: HEAD }]);
    assert.match(client.prompts[0] ?? '', /acme\/widgets#42/);
    assert.match(client.prompts[0] ?? '', /diff --git a\/src\/a.ts/);
    assert.match(client.prompts[0] ?? '', /Issue\/spec context:\nDoR-ready\./);
  });

  it('preserves structured reviewer usage when the API client reports it', async () => {
    const client = new FakeClient([{
      content: reviewerJson(),
      telemetry: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        turns: 1,
        usage: { inputTokens: 1_200, cachedInputTokens: 1_000, outputTokens: 75 },
      },
    }]);
    const result = await makeReviewer(client).review(request());

    assert.deepEqual(result.telemetry, {
      provider: 'deepseek',
      model: 'deepseek-chat',
      turns: 1,
      usage: { inputTokens: 1_200, cachedInputTokens: 1_000, outputTokens: 75 },
    });
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
    assert.deepEqual(result.findings, [
      { severity: 'blocking', summary: 'the diff has a bug', detail: 'line 4' },
      { severity: 'non_blocking', summary: 'rename x' },
    ]);
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

  it('rejects REQUEST_CHANGES with no actionable blocker', async () => {
    const reviewer = makeReviewer(new FakeClient([
      reviewerJson({ verdict: 'REQUEST_CHANGES', non_blocking_suggestions: [{ summary: 'optional cleanup' }] }),
    ]));

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_CONTRADICTORY',
    );
  });

  it('validates non-blocking suggestions instead of silently discarding malformed output', async () => {
    const reviewer = makeReviewer(new FakeClient([
      reviewerJson({ non_blocking_suggestions: [{ summary: '' }] }),
    ]));

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_INVALID_OUTPUT',
    );
  });

  it('rejects a moved HEAD after diff acquisition before calling the reviewer API', async () => {
    const client = new FakeClient([reviewerJson()]);
    const reviewer = makeReviewer(
      client,
      new FakeDiffReader(),
      githubAdapter([liveSnapshot(HEAD), liveSnapshot(OTHER_HEAD)]),
    );

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_STALE_HEAD' && error.retryable,
    );
    assert.equal(client.prompts.length, 0);
  });

  it('rejects a moved HEAD while the reviewer API was running', async () => {
    const client = new FakeClient([reviewerJson()]);
    const reviewer = makeReviewer(
      client,
      new FakeDiffReader(),
      githubAdapter([liveSnapshot(HEAD), liveSnapshot(HEAD), liveSnapshot(OTHER_HEAD)]),
    );

    await assert.rejects(
      reviewer.review(request()),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_STALE_HEAD' && error.retryable,
    );
    assert.equal(client.prompts.length, 1);
  });

  it('normalizes snapshot and diff transport failures to typed reviewer errors', async () => {
    const snapshotFailure = Object.assign(new Error('network reset'), { retryable: true });
    await assert.rejects(
      makeReviewer(new FakeClient([]), new FakeDiffReader(), githubAdapter([snapshotFailure])).review(request()),
      (error: unknown) =>
        error instanceof ReviewerError && error.code === 'REVIEW_GITHUB_FAILED' && error.retryable,
    );

    const diffFailure = Object.assign(new Error('diff unavailable'), { retryable: true });
    await assert.rejects(
      makeReviewer(new FakeClient([]), new FakeDiffReader(diffFailure)).review(request()),
      (error: unknown) =>
        error instanceof ReviewerError && error.code === 'REVIEW_DIFF_FAILED' && error.retryable,
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

describe('DeepSeekApiClient telemetry', () => {
  function makeClient(payload: unknown): { readonly client: DeepSeekApiClient; readonly calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return {
      client: new DeepSeekApiClient({ apiKey: 'test-key', baseUrl: 'https://api.deepseek.test', fetchImpl }),
      calls,
    };
  }

  /** Real DeepSeek `/chat/completions` usage shape for a successful call. */
  function deepSeekChatCompletion(usage: Record<string, unknown>, model = 'deepseek-reasoner'): unknown {
    return {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reviewerJson() }, finish_reason: 'stop' }],
      usage,
    };
  }

  it('records one model turn and the real top-level DeepSeek usage fields', async () => {
    const { client, calls } = makeClient(deepSeekChatCompletion({
      prompt_tokens: 1_234,
      completion_tokens: 567,
      total_tokens: 1_801,
      prompt_cache_hit_tokens: 1_024,
      prompt_cache_miss_tokens: 210,
      prompt_tokens_details: { cached_tokens: 1_024 },
      completion_tokens_details: { reasoning_tokens: 321 },
    }));

    const completion = await client.complete('Review the diff.', { model: 'deepseek-chat' });

    assert.deepEqual(calls, ['https://api.deepseek.test/chat/completions']);
    assert.equal(completion.telemetry?.turns, 1);
    assert.equal(completion.telemetry?.model, 'deepseek-reasoner');
    assert.deepEqual(completion.telemetry?.usage, {
      inputTokens: 1_234,
      cachedInputTokens: 1_024,
      outputTokens: 567,
      reasoningTokens: 321,
    });
    assert.deepEqual(completion.telemetry?.context, { initialTokens: 1_234, peakTokens: 1_234 });
  });

  it('records nested DeepSeek cache and reasoning detail fields when top-level hits are absent', async () => {
    const { client } = makeClient(deepSeekChatCompletion({
      prompt_tokens: 900,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 12 },
    }, 'deepseek-chat'));

    const completion = await client.complete('Review the diff.', { model: 'deepseek-chat' });

    assert.equal(completion.telemetry?.turns, 1);
    assert.deepEqual(completion.telemetry?.usage, {
      inputTokens: 900,
      cachedInputTokens: 800,
      outputTokens: 40,
      reasoningTokens: 12,
    });
  });

  it('keeps unobservable cache and reasoning usage unknown rather than zero', async () => {
    const { client } = makeClient(deepSeekChatCompletion({
      prompt_tokens: 500,
      completion_tokens: 25,
      total_tokens: 525,
    }, 'deepseek-chat'));

    const completion = await client.complete('Review the diff.', { model: 'deepseek-chat' });

    assert.equal(completion.telemetry?.turns, 1);
    assert.deepEqual(completion.telemetry?.usage, { inputTokens: 500, outputTokens: 25 });
  });
});

describe('GhPullRequestDiffReader', () => {
  class DiffTransport implements GitHubApiTransport {
    readonly calls: string[] = [];

    constructor(
      private readonly heads: string[],
      private readonly diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+ok\n',
      private readonly metadata: { changed_files: number; additions: number; deletions: number } = {
        changed_files: 1,
        additions: 1,
        deletions: 0,
      },
    ) {}

    async get(): Promise<unknown> {
      const headSha = this.heads.shift();
      if (headSha === undefined) throw new Error('No PR head queued');
      this.calls.push(`head:${headSha}`);
      return { head: { sha: headSha }, ...this.metadata };
    }

    async getPaginated(): Promise<readonly unknown[]> {
      throw new Error('files endpoint must not be used for an exact full diff');
    }

    async getRaw(_path: string, accept: string): Promise<string> {
      this.calls.push(`raw:${accept}`);
      return this.diff;
    }
  }

  it('reads the full diff media type bracketed by exact-HEAD validation', async () => {
    const transport = new DiffTransport([HEAD, HEAD]);
    const reader = new GhPullRequestDiffReader(transport);

    assert.match(await reader.readDiff('acme', 'widgets', 7, HEAD), /diff --git/);
    assert.deepEqual(transport.calls, [
      `head:${HEAD}`,
      'raw:application/vnd.github.diff',
      `head:${HEAD}`,
    ]);
  });

  it('fails closed for an incomplete diff representation and post-read HEAD drift', async () => {
    await assert.rejects(
      new GhPullRequestDiffReader(new DiffTransport([HEAD, HEAD], '')).readDiff('acme', 'widgets', 7, HEAD),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_DIFF_INCOMPLETE',
    );
    await assert.rejects(
      new GhPullRequestDiffReader(new DiffTransport([HEAD, OTHER_HEAD])).readDiff('acme', 'widgets', 7, HEAD),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_STALE_HEAD',
    );
  });

  it('fails closed when raw diff file or hunk counts do not match PR metadata', async () => {
    const oneFile = 'diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+ok\n';
    await assert.rejects(
      new GhPullRequestDiffReader(
        new DiffTransport([HEAD, HEAD], oneFile, { changed_files: 2, additions: 1, deletions: 0 }),
      ).readDiff('acme', 'widgets', 7, HEAD),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_DIFF_INCOMPLETE',
    );
    await assert.rejects(
      new GhPullRequestDiffReader(
        new DiffTransport([HEAD, HEAD], oneFile, { changed_files: 1, additions: 2, deletions: 0 }),
      ).readDiff('acme', 'widgets', 7, HEAD),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_DIFF_INCOMPLETE',
    );
    await assert.rejects(
      new GhPullRequestDiffReader(
        new DiffTransport(
          [HEAD, HEAD],
          'diff --git a/src/a.ts b/src/a.ts\n',
          { changed_files: 1, additions: 0, deletions: 0 },
        ),
      ).readDiff('acme', 'widgets', 7, HEAD),
      (error: unknown) => error instanceof ReviewerError && error.code === 'REVIEW_DIFF_INCOMPLETE',
    );
  });
});
