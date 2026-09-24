import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubLiveStateError } from '../src/github/errors.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import type { GitHubApiTransport } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

const OBSERVED_AT = '2026-08-14T03:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

class RouteTransport implements GitHubApiTransport {
  readonly calls: Array<{ kind: 'get' | 'paginated' | 'graphql'; path: string }> = [];
  private readonly objects = new Map<string, unknown[]>();
  private readonly collections = new Map<string, readonly unknown[]>();
  private readonly faults = new Map<string, Error>();
  private readonly graphqlResponses: unknown[] = [];

  queue(path: string, ...values: unknown[]): this {
    this.objects.set(path, [...values]);
    return this;
  }

  collection(path: string, values: readonly unknown[]): this {
    this.collections.set(path, values);
    return this;
  }

  fault(path: string, error: Error): this {
    this.faults.set(path, error);
    return this;
  }

  queueGraphql(...values: unknown[]): this {
    this.graphqlResponses.push(...values);
    return this;
  }

  async get(path: string): Promise<unknown> {
    this.calls.push({ kind: 'get', path });
    const fault = this.faults.get(path);
    if (fault !== undefined) throw fault;
    const queue = this.objects.get(path);
    if (queue === undefined || queue.length === 0) throw new Error(`No object fixture for ${path}`);
    return queue.shift();
  }

  async getPaginated(path: string): Promise<readonly unknown[]> {
    this.calls.push({ kind: 'paginated', path });
    const fault = this.faults.get(path);
    if (fault !== undefined) throw fault;
    const value = this.collections.get(path);
    if (value === undefined) throw new Error(`No collection fixture for ${path}`);
    return value;
  }

  async graphql(): Promise<unknown> {
    this.calls.push({ kind: 'graphql', path: 'graphql' });
    return this.graphqlResponses.shift() ?? {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    };
  }
}

function issue(state = 'open'): Record<string, unknown> {
  return {
    node_id: 'I_3',
    number: 3,
    title: 'Implement GitHub live state',
    body: 'Issue specification.',
    state,
    html_url: 'https://github.test/acme/widgets/issues/3',
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T01:00:00.000Z',
  };
}

function pull(
  number = 7,
  headSha = HEAD,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    node_id: `PR_${number}`,
    number,
    title: 'Implement live state',
    body: 'Closes #42',
    state: 'open',
    draft: false,
    html_url: `https://github.test/acme/widgets/pull/${number}`,
    mergeable: true,
    mergeable_state: 'clean',
    updated_at: '2026-08-14T02:00:00.000Z',
    merged_at: null,
    head: { sha: headSha },
    base: { sha: BASE },
    ...overrides,
  };
}

function crossRef(number: number): Record<string, unknown> {
  return {
    event: 'cross-referenced',
    source: {
      issue: {
        number,
        pull_request: { url: `https://api.github.com/repos/acme/widgets/pulls/${number}` },
      },
    },
  };
}

function apiComment(id: string, body: string, updatedAt: string): Record<string, unknown> {
  return {
    node_id: id,
    id: Number(id.replace(/\D/g, '')) || 1,
    user: { login: 'alice' },
    body,
    created_at: updatedAt,
    updated_at: updatedAt,
    html_url: `https://github.test/comments/${id}`,
  };
}

function closingIssues(...numbers: number[]): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: numbers.map((number) => ({ number, repository: { nameWithOwner: 'acme/widgets' } })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  };
}

async function expectError(promise: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof GitHubLiveStateError && error.code === code && error.retryable === retryable,
  );
}

/** A transport fully wired for one open PR #7 at the live HEAD, ready to override. */
function prTransport(): RouteTransport {
  return new RouteTransport()
    .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
    .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
    .collection('repos/acme/widgets/issues/42/comments', [])
    .queue('repos/acme/widgets/pulls/7', pull(), pull())
    .collection('repos/acme/widgets/issues/7/comments', [])
    .collection('repos/acme/widgets/pulls/7/reviews', [])
    .collection('repos/acme/widgets/pulls/7/comments', [])
    .queue('repos/acme/widgets/commits/' + HEAD + '/status', { state: 'success', statuses: [] })
    .queue('repos/acme/widgets/commits/' + HEAD + '/check-runs', { total_count: 0, check_runs: [] });
}

describe('LiveGitHubAdapter', () => {
  it('returns a successful no-PR snapshot without inventing a HEAD', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets', { default_branch: 'main' })
      .queue('repos/acme/widgets/commits/main', { sha: BASE });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.issue.number, 42);
    assert.equal(snapshot.pullRequest, null);
    assert.equal(snapshot.headSha, null);
    assert.equal(snapshot.repository.defaultBranch, 'main');
    assert.equal(snapshot.repository.defaultBranchHeadSha, BASE);
    assert.deepEqual(snapshot.checks, { availability: 'unavailable', overall: 'unavailable', checks: [] });
    assert.deepEqual(snapshot.reviews, { decision: 'none', latestByAuthor: [], unresolvedThreads: null });
    assert.equal(snapshot.handoff, null);
    assert.deepEqual(snapshot.problems, []);
    assert.equal(snapshot.observedAt, OBSERVED_AT);
  });

  it('aggregates one associated open PR and binds every derived view to its re-read exact HEAD', async () => {
    const handoff = `<!-- agent-handoff:v1 -->

## Current State

HEAD: \`${HEAD}\`
PR: #7`;
    const timeline = [
      {
        event: 'cross-referenced',
        source: {
          issue: {
            number: 7,
            pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' },
          },
        },
      },
    ];
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', timeline)
      .collection('repos/acme/widgets/issues/42/comments', [
        apiComment('IC_1', 'ordinary issue note', '2026-08-14T00:30:00.000Z'),
      ])
      .queue('repos/acme/widgets/pulls/7', pull(), pull())
      .collection('repos/acme/widgets/issues/7/comments', [
        apiComment('IC_2', handoff, '2026-08-14T01:30:00.000Z'),
      ])
      .collection('repos/acme/widgets/pulls/7/reviews', [
        {
          node_id: 'R_1',
          user: { login: 'reviewer' },
          state: 'CHANGES_REQUESTED',
          commit_id: HEAD,
          submitted_at: '2026-08-14T01:00:00.000Z',
          html_url: 'https://github.test/reviews/1',
          body: 'Fix it.',
        },
        {
          node_id: 'R_2',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          commit_id: HEAD,
          submitted_at: '2026-08-14T02:00:00.000Z',
          html_url: 'https://github.test/reviews/2',
          body: 'Approved.',
        },
      ])
      .collection('repos/acme/widgets/pulls/7/comments', [])
      .queue('repos/acme/widgets/commits/' + HEAD + '/status', {
        state: 'success',
        statuses: [
          {
            id: 1,
            context: 'legacy/ci',
            state: 'success',
            target_url: 'https://ci.test/1',
            updated_at: '2026-08-14T02:00:00.000Z',
          },
        ],
      })
      .queue('repos/acme/widgets/commits/' + HEAD + '/check-runs', {
        total_count: 1,
        check_runs: [
          {
            id: 2,
            name: 'tests',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://ci.test/2',
            completed_at: '2026-08-14T02:00:00.000Z',
          },
        ],
      });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.pullRequest?.number, 7);
    assert.equal(snapshot.pullRequest?.headSha, HEAD);
    assert.equal(snapshot.pullRequest?.mergeStateStatus, 'clean');
    assert.equal(snapshot.headSha, HEAD);
    assert.equal(snapshot.checks.availability, 'available');
    assert.equal(snapshot.checks.overall, 'passing');
    assert.deepEqual(snapshot.checks.checks.map((check) => [check.name, check.state]), [
      ['legacy/ci', 'passing'],
      ['tests', 'passing'],
    ]);
    assert.equal(snapshot.reviews.decision, 'approved');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_2']);
    assert.equal(snapshot.reviews.latestByAuthor[0]?.fresh, true);
    assert.equal(snapshot.reviews.unresolvedThreads, 0);
    assert.equal(snapshot.handoff?.sourceId, 'IC_2');
    assert.equal(snapshot.handoff?.freshness, 'current');
    assert.deepEqual(snapshot.conversations.map((entry) => entry.id), ['IC_1', 'IC_2', 'R_1', 'R_2']);
    assert.deepEqual(snapshot.problems, []);
    assert.equal(
      transport.calls.filter((call) => call.kind === 'get' && call.path === 'repos/acme/widgets/pulls/7').length,
      2,
    );
  });

  it('reports successful empty check responses as available and passing', async () => {
    const adapter = new LiveGitHubAdapter({ transport: prTransport(), now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.deepEqual(snapshot.checks, { availability: 'available', overall: 'passing', checks: [] });
  });

  it('counts unresolved review threads across GraphQL pages', async () => {
    const transport = prTransport().queueGraphql(
      closingIssues(42),
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }, { isResolved: true }],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          },
        },
      },
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
    );
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.unresolvedThreads, 2);
    assert.equal(transport.calls.filter((call) => call.kind === 'graphql').length, 3);
  });

  it('fails closed when review evidence collections cannot be read instead of treating them as empty', async () => {
    for (const path of [
      'repos/acme/widgets/pulls/7/reviews',
      'repos/acme/widgets/pulls/7/comments',
    ]) {
      const transport = prTransport().fault(
        path,
        new GitHubLiveStateError('GH_RATE_LIMITED', 'rate limited', { retryable: true }),
      );
      const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

      await expectError(adapter.readLiveSnapshot(TARGET), 'GH_RATE_LIMITED', true);
    }
  });

  it('gives a latest change request precedence over another author approval', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_APPROVED',
        user: { login: 'alice' },
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/approved',
      },
      {
        node_id: 'R_CHANGES',
        user: { login: 'bob' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/changes',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_APPROVED', 'R_CHANGES']);
  });

  it('keeps a current-HEAD change request active across a later comment-only review from the same author', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_CHANGES',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/changes',
      },
      {
        node_id: 'R_COMMENT',
        user: { login: 'alice' },
        state: 'COMMENTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/comment',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_CHANGES']);
  });

  it('keeps an unknown-provenance change request across a later current-HEAD comment-only review', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_UNKNOWN_CHANGES',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: null,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/unknown-changes',
      },
      {
        node_id: 'R_COMMENT',
        user: { login: 'alice' },
        state: 'COMMENTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/comment',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_UNKNOWN_CHANGES']);
    assert.equal(snapshot.reviews.latestByAuthor[0]?.commitSha, null);
  });

  it('lets a later unknown-provenance change request override an earlier current-HEAD comment', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_COMMENT',
        user: { login: 'alice' },
        state: 'COMMENTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/comment',
      },
      {
        node_id: 'R_UNKNOWN_CHANGES',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: null,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/unknown-changes',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_UNKNOWN_CHANGES']);
  });

  it('lets a later current-HEAD approval clear an earlier unknown-provenance change request', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_UNKNOWN_CHANGES',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: null,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/unknown-changes',
      },
      {
        node_id: 'R_APPROVED',
        user: { login: 'alice' },
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/approved',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'approved');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_APPROVED']);
  });

  it('fails closed when a current approval ties an unknown-provenance change request', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_CURRENT_APPROVED_TIE',
        user: { login: 'alice' },
        state: 'APPROVED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/current-approved-tie',
      },
      {
        node_id: 'R_UNKNOWN_CHANGES_TIE',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: null,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/unknown-changes-tie',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_UNKNOWN_CHANGES_TIE']);
  });

  it('fails closed on equal-timestamp approval/change-request ties regardless of collection order', async () => {
    const approval = {
      node_id: 'R_APPROVED_TIE',
      user: { login: 'alice' },
      state: 'APPROVED',
      commit_id: HEAD,
      submitted_at: '2026-08-14T02:00:00.000Z',
      html_url: 'https://github.test/reviews/approved-tie',
    };
    const changes = {
      node_id: 'R_CHANGES_TIE',
      user: { login: 'alice' },
      state: 'CHANGES_REQUESTED',
      commit_id: HEAD,
      submitted_at: '2026-08-14T02:00:00.000Z',
      html_url: 'https://github.test/reviews/changes-tie',
    };

    for (const ordered of [[approval, changes], [changes, approval]]) {
      const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', ordered);
      const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

      const snapshot = await adapter.readLiveSnapshot(TARGET);

      assert.equal(snapshot.reviews.decision, 'changes_requested');
      assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_CHANGES_TIE']);
    }
  });

  it('does not let a later-submitted stale approval supersede a current-HEAD change request', async () => {
    const transport = prTransport().collection('repos/acme/widgets/pulls/7/reviews', [
      {
        node_id: 'R_CHANGES',
        user: { login: 'alice' },
        state: 'CHANGES_REQUESTED',
        commit_id: HEAD,
        submitted_at: '2026-08-14T01:00:00.000Z',
        html_url: 'https://github.test/reviews/changes',
      },
      {
        node_id: 'R_STALE_APPROVAL',
        user: { login: 'alice' },
        state: 'APPROVED',
        commit_id: BASE,
        submitted_at: '2026-08-14T02:00:00.000Z',
        html_url: 'https://github.test/reviews/stale-approval',
      },
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.reviews.decision, 'changes_requested');
    assert.deepEqual(snapshot.reviews.latestByAuthor.map((review) => review.id), ['R_CHANGES']);
  });

  it('rejects more than one open associated pull request', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7), crossRef(8)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets/pulls/7', pull())
      .queue('repos/acme/widgets/pulls/8', pull(8))
      .queueGraphql(closingIssues(), closingIssues());
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_AMBIGUOUS_OPEN_PRS', true);
  });

  it('preserves ambiguity when GitHub authoritatively reports multiple closing PRs', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7), crossRef(8)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { body: 'Closes #42' }))
      .queue('repos/acme/widgets/pulls/8', pull(8, HEAD, { body: 'Closes #12' }))
      .queueGraphql(closingIssues(42), closingIssues(42));
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_AMBIGUOUS_OPEN_PRS', true);
  });

  it('selects the sole open PR that GitHub says closes the issue when stacked PRs also cross-reference it', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7), crossRef(8)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { body: '' }), pull(7, HEAD, { body: '' }))
      .queue('repos/acme/widgets/pulls/8', pull(8, HEAD, { body: 'Closes #12' }))
      .collection('repos/acme/widgets/issues/7/comments', [])
      .collection('repos/acme/widgets/pulls/7/reviews', [])
      .collection('repos/acme/widgets/pulls/7/comments', [])
      .queue('repos/acme/widgets/commits/' + HEAD + '/status', { state: 'success', statuses: [] })
      .queue('repos/acme/widgets/commits/' + HEAD + '/check-runs', { total_count: 0, check_runs: [] })
      .queueGraphql(closingIssues(42), closingIssues(12));
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.pullRequest?.number, 7);
    assert.equal(snapshot.reviews.unresolvedThreads, 0);
  });

  it('uses an exact closing reference in the live PR body while a stacked base keeps GraphQL closers empty', async () => {
    const closingPull = pull(7, HEAD, { body: 'Closes #42' });
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7), crossRef(8)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets/pulls/7', closingPull, closingPull)
      .queue('repos/acme/widgets/pulls/8', pull(8, HEAD, { body: 'Closes #12' }))
      .collection('repos/acme/widgets/issues/7/comments', [])
      .collection('repos/acme/widgets/pulls/7/reviews', [])
      .collection('repos/acme/widgets/pulls/7/comments', [])
      .queue('repos/acme/widgets/commits/' + HEAD + '/status', { state: 'success', statuses: [] })
      .queue('repos/acme/widgets/commits/' + HEAD + '/check-runs', { total_count: 0, check_runs: [] })
      .queueGraphql(closingIssues(), closingIssues());
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.pullRequest?.number, 7);
  });

  it('treats an empty pull request HEAD as a fatal contradictory state', async () => {
    const transport = prTransport().queue('repos/acme/widgets/pulls/7', pull(7, ''));
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_CONTRADICTORY_STATE', false);
  });

  it('rejects a pull request whose number does not match the timeline reference', async () => {
    const transport = prTransport().queue('repos/acme/widgets/pulls/7', { ...pull(), number: 8 });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_INVALID_RESPONSE', false);
  });

  it('refuses a snapshot whose HEAD changes between the first read and the re-read gate', async () => {
    const transport = prTransport().queue(
      'repos/acme/widgets/pulls/7',
      pull(7, HEAD),
      pull(7, BASE),
    );
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_SNAPSHOT_CHANGED', true);
  });

  it('refuses same-HEAD ownership drift during the coherent snapshot reread', async () => {
    const first = pull(7, HEAD, {
      head: { sha: HEAD, ref: 'owned', repo: { name: 'widgets', owner: { login: 'acme' } } },
      base: { sha: BASE, ref: 'main' },
    });
    const changed = [
      { head: { sha: HEAD, ref: 'other', repo: { name: 'widgets', owner: { login: 'acme' } } } },
      { head: { sha: HEAD, ref: 'owned', repo: { name: 'other', owner: { login: 'acme' } } } },
      { head: { sha: HEAD, ref: 'owned', repo: { name: 'widgets', owner: { login: 'other' } } } },
      { head: { sha: HEAD, ref: 'owned', repo: null } },
      { base: { sha: BASE, ref: 'release' } },
      { draft: true },
      { mergeable: false },
      { mergeable_state: 'blocked' },
      { base: { sha: 'c'.repeat(40), ref: 'main' } },
    ];
    for (const delta of changed) {
      const transport = prTransport().queue('repos/acme/widgets/pulls/7', first, { ...first, ...delta });
      const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });
      await expectError(adapter.readLiveSnapshot(TARGET), 'GH_SNAPSHOT_CHANGED', true);
    }
  });

  it('keeps core authority while recording a hosted status transport failure', async () => {
    const transport = prTransport().fault(
      'repos/acme/widgets/commits/' + HEAD + '/status',
      new GitHubLiveStateError('GH_RATE_LIMITED', 'rate limited', { retryable: true }),
    );
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.issue.number, 42);
    assert.equal(snapshot.pullRequest?.number, 7);
    assert.equal(snapshot.headSha, HEAD);
    assert.deepEqual(snapshot.checks, { availability: 'unavailable', overall: 'unavailable', checks: [] });
    assert.ok(snapshot.problems.some((problem) => problem.code === 'CHECKS_UNAVAILABLE'));
  });

  it('marks a handoff claiming a stale HEAD as stale and never lets it supply the live HEAD', async () => {
    const staleHandoff = `<!-- agent-handoff:v1 -->

## Current State

HEAD: \`${BASE}\`
PR: #7`;
    const transport = prTransport().collection('repos/acme/widgets/issues/7/comments', [
      apiComment('IC_STALE', staleHandoff, '2026-08-14T01:30:00.000Z'),
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.headSha, HEAD);
    assert.equal(snapshot.handoff?.sourceId, 'IC_STALE');
    assert.equal(snapshot.handoff?.freshness, 'stale');
    assert.ok(snapshot.problems.some((problem) => problem.code === 'STALE_HANDOFF'));
  });

  it('reports a closed issue with an open pull request as a nonfatal contradictory diagnostic', async () => {
    const transport = prTransport().queue('repos/acme/widgets/issues/42', { ...issue('closed'), number: 42 });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.issue.state, 'closed');
    assert.equal(snapshot.pullRequest?.number, 7);
    assert.ok(snapshot.problems.some((problem) => problem.code === 'CONTRADICTORY_STATE'));
  });

  it('selects the latest handoff regardless of which flattened page it landed on', async () => {
    const handoff = `<!-- agent-handoff:v1 -->

## Current State

HEAD: \`${HEAD}\`
PR: #7`;
    const transport = prTransport().collection('repos/acme/widgets/issues/7/comments', [
      apiComment('IC_EARLY', 'ordinary note', '2026-08-14T00:30:00.000Z'),
      apiComment('IC_LAST', handoff, '2026-08-14T01:30:00.000Z'),
    ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.handoff?.sourceId, 'IC_LAST');
    assert.equal(snapshot.handoff?.freshness, 'current');
  });

  it('deduplicates identical conversation IDs and orders entries deterministically', async () => {
    const transport = prTransport()
      .collection('repos/acme/widgets/issues/42/comments', [
        apiComment('IC_DUP', 'issue note', '2026-08-14T00:30:00.000Z'),
      ])
      .collection('repos/acme/widgets/issues/7/comments', [
        apiComment('IC_DUP', 'pr note with the same id', '2026-08-14T01:30:00.000Z'),
      ])
      .collection('repos/acme/widgets/pulls/7/reviews', [
        {
          node_id: 'R_2',
          user: { login: 'reviewer' },
          state: 'APPROVED',
          commit_id: HEAD,
          submitted_at: '2026-08-14T02:00:00.000Z',
          html_url: 'https://github.test/reviews/2',
          body: 'Approved.',
        },
      ]);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.deepEqual(snapshot.conversations.map((entry) => entry.id), ['IC_DUP', 'R_2']);
    assert.equal(snapshot.conversations.filter((entry) => entry.id === 'IC_DUP').length, 1);
  });

  it('produces identical snapshots across repeated reads with a fixed clock', async () => {
    const transport = prTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 }, { ...issue(), number: 42 })
      .queue('repos/acme/widgets/pulls/7', pull(), pull(), pull(), pull())
      .queue(
        'repos/acme/widgets/commits/' + HEAD + '/status',
        { state: 'success', statuses: [] },
        { state: 'success', statuses: [] },
      )
      .queue(
        'repos/acme/widgets/commits/' + HEAD + '/check-runs',
        { total_count: 0, check_runs: [] },
        { total_count: 0, check_runs: [] },
      );
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const first = await adapter.readLiveSnapshot(TARGET);
    const second = await adapter.readLiveSnapshot(TARGET);

    assert.deepEqual(second, first);
    assert.equal(second.observedAt, OBSERVED_AT);
  });

  it('does not associate an unrelated open PR that only mentions the Issue in prose', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { body: 'Follow-up work discussed in #42.' }))
      .queueGraphql(closingIssues())
      .queue('repos/acme/widgets', { default_branch: 'main' })
      .queue('repos/acme/widgets/commits/main', { sha: BASE });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.pullRequest, null);
    assert.equal(snapshot.headSha, null);
    assert.equal(snapshot.repository.defaultBranch, 'main');
  });

  it('keeps listPullRequests and readLiveSnapshot aligned on canonical association', async () => {
    const proseTransport = new RouteTransport()
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
      .queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { body: 'See #42.' }))
      .queueGraphql(closingIssues());
    const proseAdapter = new LiveGitHubAdapter({ transport: proseTransport, now: () => OBSERVED_AT });
    assert.deepEqual(await proseAdapter.listPullRequests(TARGET), []);

    const mergedTransport = new RouteTransport()
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
      .queue(
        'repos/acme/widgets/pulls/7',
        pull(7, HEAD, {
          state: 'closed',
          merged_at: '2026-08-14T02:30:00.000Z',
          body: 'Mentions #42 but implements #32.',
        }),
      )
      .queueGraphql(closingIssues());
    const mergedAdapter = new LiveGitHubAdapter({ transport: mergedTransport, now: () => OBSERVED_AT });
    assert.deepEqual(await mergedAdapter.listPullRequests(TARGET), []);
  });

  it('keeps a genuine open implementation PR associated so it still blocks a second writer', async () => {
    const transport = new RouteTransport()
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
      .queue(
        'repos/acme/widgets/pulls/7',
        pull(7, HEAD, { body: 'Closes #42\n\nConductor-owned implementation pull request.' }),
      );
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const pulls = await adapter.listPullRequests(TARGET);

    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]?.number, 7);
    assert.equal(pulls[0]?.state, 'open');
  });

  it('reads the exact persisted pull request directly, including merged state and repository branch identities', async () => {
    const exact = pull(7, HEAD, {
      state: 'closed',
      merged_at: '2026-08-14T02:30:00.000Z',
      head: { sha: HEAD, ref: 'feature/42', repo: { name: 'widgets', owner: { login: 'acme' } } },
      base: { sha: BASE, ref: 'main', repo: { name: 'widgets', owner: { login: 'acme' } } },
    });
    const transport = new RouteTransport().queue('repos/acme/widgets/pulls/7', exact);
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });
    const live = await adapter.readPullRequest('acme', 'widgets', 7);
    assert.equal(live.number, 7);
    assert.equal(live.state, 'merged');
    assert.equal(live.headSha, HEAD);
    assert.equal(live.headRef, 'feature/42');
    assert.deepEqual(live.headRepository, { owner: 'acme', repo: 'widgets' });
    assert.equal(live.baseRef, 'main');
    assert.deepEqual(live.baseRepository, { owner: 'acme', repo: 'widgets' });
    assert.deepEqual(transport.calls, [{ kind: 'get', path: 'repos/acme/widgets/pulls/7' }]);

    const malformedTransport = new RouteTransport().queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { state: 'closed', merged_at: '' }));
    const malformedAdapter = new LiveGitHubAdapter({ transport: malformedTransport, now: () => OBSERVED_AT });
    await assert.rejects(malformedAdapter.readPullRequest('acme', 'widgets', 7), /merged_at and closed state/);
  });

  it('does not pick arbitrarily when multiple cross-references are all incidental', async () => {
    const transport = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7), crossRef(8)])
      .collection('repos/acme/widgets/issues/42/comments', [])
      .queue(
        'repos/acme/widgets/pulls/7',
        pull(7, HEAD, { body: 'Implements #32.' }),
        pull(7, HEAD, { body: 'Implements #32.' }),
      )
      .queue('repos/acme/widgets/pulls/8', pull(8, HEAD, { body: 'Docs for #12.' }))
      .queueGraphql(closingIssues(), closingIssues())
      .queue('repos/acme/widgets', { default_branch: 'main' })
      .queue('repos/acme/widgets/commits/main', { sha: BASE });
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const snapshot = await adapter.readLiveSnapshot(TARGET);

    assert.equal(snapshot.pullRequest, null);
  });

  it('fails closed on a prose cross-reference when no first-party closing channel exists', async () => {
    const route = new RouteTransport()
      .queue('repos/acme/widgets/issues/42', { ...issue(), number: 42 })
      .collection('repos/acme/widgets/issues/42/timeline', [crossRef(7)])
      .queue('repos/acme/widgets/pulls/7', pull(7, HEAD, { body: 'See #42.' }), pull(7, HEAD, { body: 'See #42.' }));
    const transport: GitHubApiTransport = {
      get: (path) => route.get(path),
      getPaginated: (path) => route.getPaginated(path),
    };
    const adapter = new LiveGitHubAdapter({ transport, now: () => OBSERVED_AT });

    const candidates = await adapter.listPullRequests(TARGET);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.number, 7);
    await expectError(adapter.readLiveSnapshot(TARGET), 'GH_PR_ASSOCIATION_UNKNOWN', true);
  });
});
