import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubLiveStateError } from '../src/github/errors.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import {
  GhCliTransport,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from '../src/github/transport.js';
import type { IssueTarget } from '../src/domain/types.js';

const TARGET: IssueTarget = { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 42 };
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PR_PATH = 'repos/acme/widgets/pulls/7';
const STATUS_PATH = `repos/acme/widgets/commits/${HEAD}/status`;
const CHECK_RUNS_PATH = `repos/acme/widgets/commits/${HEAD}/check-runs`;

type Failure = {
  readonly path: string;
  readonly occurrence?: number;
  readonly outcome: ProcessResult | Error;
};

type HostedPages = ReadonlyMap<string, readonly unknown[]>;

function result(stdout: string, stderr = '', exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode };
}

function issue(): Record<string, unknown> {
  return {
    node_id: 'I_42',
    number: 42,
    title: 'Implement the validation workflow',
    body: 'Issue specification.',
    state: 'open',
    html_url: 'https://github.test/acme/widgets/issues/42',
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T01:00:00.000Z',
  };
}

function pull(): Record<string, unknown> {
  return {
    node_id: 'PR_7',
    number: 7,
    title: 'Implement the validation workflow',
    state: 'open',
    draft: false,
    html_url: 'https://github.test/acme/widgets/pull/7',
    mergeable: true,
    mergeable_state: 'clean',
    updated_at: '2026-08-14T02:00:00.000Z',
    merged_at: null,
    head: { sha: HEAD, ref: 'issue-20-validation', repo: { name: 'widgets', owner: { login: 'acme' } } },
    base: { sha: BASE, ref: 'main' },
  };
}

function reviewThreads(): Record<string, unknown> {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      },
    },
  };
}

function crossReference(): Record<string, unknown> {
  return {
    event: 'cross-referenced',
    source: {
      issue: {
        number: 7,
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' },
      },
    },
  };
}

/** A ProcessRunner fixture that exercises the real GhCliTransport command boundary. */
class GitHubProcessFixture implements ProcessRunner {
  readonly calls: Array<{ readonly file: string; readonly args: readonly string[]; readonly timeoutMs: number }> = [];
  private readonly occurrences = new Map<string, number>();

  constructor(
    private readonly failure?: Failure,
    private readonly hostedPages?: HostedPages,
  ) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, timeoutMs: options.timeoutMs });
    const path = args[1] === 'graphql' ? 'graphql' : args[3];
    if (path === undefined) throw new Error(`Fixture could not identify API path from ${args.join(' ')}`);
    const occurrence = (this.occurrences.get(path) ?? 0) + 1;
    this.occurrences.set(path, occurrence);

    if (
      this.failure !== undefined &&
      this.failure.path === path &&
      (this.failure.occurrence === undefined || this.failure.occurrence === occurrence)
    ) {
      if (this.failure.outcome instanceof Error) throw this.failure.outcome;
      return this.failure.outcome;
    }

    const payload = this.payload(path, occurrence, args);
    return result(JSON.stringify(args.includes('--paginate') ? [payload] : payload));
  }

  private payload(path: string, occurrence: number, args: readonly string[]): unknown {
    const pages = this.hostedPages?.get(path);
    if (pages !== undefined) {
      const pageArgument = args.find((argument) => /^page=\d+$/.test(argument));
      const page = pageArgument === undefined ? 1 : Number(pageArgument.slice('page='.length));
      const payload = pages[page - 1];
      if (payload === undefined) throw new Error(`No hosted fixture page ${page} for ${path}`);
      return payload;
    }
    if (path === 'repos/acme/widgets/issues/42') return issue();
    if (path === 'repos/acme/widgets/issues/42/timeline') return [crossReference()];
    if (path === PR_PATH) return pull();
    if (path === 'repos/acme/widgets/issues/42/comments') return [];
    if (path === 'repos/acme/widgets/issues/7/comments') return [];
    if (path === 'repos/acme/widgets/pulls/7/reviews') return [];
    if (path === 'repos/acme/widgets/pulls/7/comments') return [];
    if (path === STATUS_PATH) return { state: 'success', total_count: 0, statuses: [] };
    if (path === CHECK_RUNS_PATH) return { total_count: 0, check_runs: [] };
    if (path === 'graphql') return reviewThreads();
    throw new Error(`No fixture payload for ${path} occurrence ${occurrence}`);
  }
}

function timeout(): Error {
  return Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
}

function httpFailure(status: number): ProcessResult {
  return result('', `HTTP ${status}: Service Unavailable`, 1);
}

function malformedJson(): ProcessResult {
  return result('{ malformed json');
}

function adapterFor(runner: ProcessRunner): LiveGitHubAdapter {
  return new LiveGitHubAdapter({ transport: new GhCliTransport({ runner, timeoutMs: 1234 }) });
}

function assertCoreAuthority(snapshot: Awaited<ReturnType<LiveGitHubAdapter['readLiveSnapshot']>>): void {
  assert.equal(snapshot.issue.number, 42);
  assert.equal(snapshot.issue.state, 'open');
  assert.equal(snapshot.pullRequest?.number, 7);
  assert.equal(snapshot.pullRequest?.headSha, HEAD);
  assert.equal(snapshot.pullRequest?.mergeStateStatus, 'clean');
  assert.equal(snapshot.headSha, HEAD);
}

function assertHostedUnavailable(
  snapshot: Awaited<ReturnType<LiveGitHubAdapter['readLiveSnapshot']>>,
): void {
  assert.equal(snapshot.checks.availability, 'unavailable');
  assert.equal(snapshot.checks.overall, 'unavailable');
  assert.ok(snapshot.problems.some((problem) => problem.code === 'CHECKS_UNAVAILABLE'));
}

function passingStatuses(count: number): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    context: `status-${String(index + 1)}`,
    state: 'success',
  }));
}

function pendingCheckRun(): Record<string, unknown> {
  return { id: 999, name: 'later-pending', status: 'in_progress', conclusion: null };
}

describe('LiveGitHubAdapter hosted observation transport boundary', () => {
  it('does not pass an all-green first status page when a later page is failing', async () => {
    const runner = new GitHubProcessFixture(
      undefined,
      new Map([
        [
          STATUS_PATH,
          [
            { state: 'success', total_count: 101, statuses: passingStatuses(100) },
            { state: 'failure', total_count: 101, statuses: [{ id: 101, context: 'later-failure', state: 'failure' }] },
          ],
        ],
      ]),
    );

    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assert.equal(snapshot.checks.availability, 'available');
    assert.equal(snapshot.checks.overall, 'failing');
    assert.ok(snapshot.checks.checks.some((check) => check.name === 'later-failure' && check.state === 'failing'));
    const statusCalls = runner.calls.filter((call) => call.args[3] === STATUS_PATH);
    assert.equal(statusCalls.length, 2);
    assert.ok(statusCalls[1]?.args.includes('page=2'));
  });

  it('does not pass an all-green first check-runs page when a later page is pending', async () => {
    const runner = new GitHubProcessFixture(
      undefined,
      new Map([
        [
          CHECK_RUNS_PATH,
          [
            {
              total_count: 101,
              check_runs: Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                name: `check-${String(index + 1)}`,
                status: 'completed',
                conclusion: 'success',
              })),
            },
            { total_count: 101, check_runs: [pendingCheckRun()] },
          ],
        ],
      ]),
    );

    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assert.equal(snapshot.checks.availability, 'available');
    assert.equal(snapshot.checks.overall, 'pending');
    assert.ok(snapshot.checks.checks.some((check) => check.name === 'later-pending' && check.state === 'pending'));
    const checkRunCalls = runner.calls.filter((call) => call.args[3] === CHECK_RUNS_PATH);
    assert.equal(checkRunCalls.length, 2);
    assert.ok(checkRunCalls[1]?.args.includes('page=2'));
  });

  it('marks advertised-but-missing hosted entries unavailable rather than passing', async () => {
    const runner = new GitHubProcessFixture(
      undefined,
      new Map([
        [
          STATUS_PATH,
          [
            { state: 'success', total_count: 2, statuses: passingStatuses(1) },
            { state: 'success', total_count: 2, statuses: [] },
          ],
        ],
      ]),
    );

    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('keeps core authority when a later hosted page fails to fetch', async () => {
    const runner = new GitHubProcessFixture(
      { path: STATUS_PATH, occurrence: 2, outcome: httpFailure(503) },
      new Map([
        [STATUS_PATH, [{ state: 'success', total_count: 101, statuses: passingStatuses(100) }]],
      ]),
    );

    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('retains core authority when status transport times out', async () => {
    const runner = new GitHubProcessFixture({ path: STATUS_PATH, outcome: timeout() });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
    assert.equal(runner.calls[0]?.file, 'gh');
    assert.equal(runner.calls[0]?.timeoutMs, 1234);
  });

  it('retains core authority when check-runs transport returns an HTTP failure', async () => {
    const runner = new GitHubProcessFixture({ path: CHECK_RUNS_PATH, outcome: httpFailure(503) });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('retains core authority when status transport returns malformed JSON', async () => {
    const runner = new GitHubProcessFixture({ path: STATUS_PATH, outcome: malformedJson() });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('retains core authority when status transport returns an HTTP failure', async () => {
    const runner = new GitHubProcessFixture({ path: STATUS_PATH, outcome: httpFailure(503) });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('retains core authority when check-runs transport times out', async () => {
    const runner = new GitHubProcessFixture({ path: CHECK_RUNS_PATH, outcome: timeout() });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('retains core authority when check-runs transport returns malformed JSON', async () => {
    const runner = new GitHubProcessFixture({ path: CHECK_RUNS_PATH, outcome: malformedJson() });
    const snapshot = await adapterFor(runner).readLiveSnapshot(TARGET);

    assertCoreAuthority(snapshot);
    assertHostedUnavailable(snapshot);
  });

  it('rejects a snapshot when the core Issue read fails', async () => {
    const runner = new GitHubProcessFixture({ path: 'repos/acme/widgets/issues/42', outcome: httpFailure(503) });

    await assert.rejects(
      adapterFor(runner).readLiveSnapshot(TARGET),
      (error: unknown) => error instanceof GitHubLiveStateError && error.code === 'GH_TRANSPORT_FAILED',
    );
  });

  it('rejects a snapshot when the final PR reread fails', async () => {
    const runner = new GitHubProcessFixture({ path: PR_PATH, occurrence: 2, outcome: httpFailure(503) });

    await assert.rejects(
      adapterFor(runner).readLiveSnapshot(TARGET),
      (error: unknown) => error instanceof GitHubLiveStateError && error.code === 'GH_TRANSPORT_FAILED',
    );
  });
});
