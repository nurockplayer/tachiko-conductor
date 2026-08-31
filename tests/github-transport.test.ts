import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubLiveStateError } from '../src/github/errors.js';
import {
  GhCliTransport,
  type ProcessResult,
  type ProcessRunner,
  type ProcessRunOptions,
} from '../src/github/transport.js';

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];

  constructor(private readonly outcomes: Array<ProcessResult | Error>) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, timeoutMs: options.timeoutMs });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No fake outcome queued');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function result(stdout: string, stderr = '', exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode };
}

async function expectCode(promise: Promise<unknown>, code: string, retryable: boolean): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof GitHubLiveStateError && error.code === code && error.retryable === retryable,
  );
}

describe('GhCliTransport', () => {
  it('uses a fixed executable and argument array for a GET request', async () => {
    const runner = new RecordingRunner([result('{"number":3}')]);
    const transport = new GhCliTransport({ runner, timeoutMs: 1234 });

    assert.deepEqual(await transport.get('repos/acme/widgets/issues/3', { state: 'all', per_page: '100' }), {
      number: 3,
    });
    assert.deepEqual(runner.calls, [
      {
        file: 'gh',
        timeoutMs: 1234,
        args: [
          'api',
          '--method',
          'GET',
          'repos/acme/widgets/issues/3',
          '-H',
          'Accept: application/vnd.github+json',
          '-H',
          'X-GitHub-Api-Version: 2022-11-28',
          '-f',
          'per_page=100',
          '-f',
          'state=all',
        ],
      },
    ]);
  });

  it('flattens fully paginated slurp output without returning partial pages', async () => {
    const runner = new RecordingRunner([result('[[{"id":1}],[{"id":2},{"id":3}]]')]);
    const transport = new GhCliTransport({ runner });

    assert.deepEqual(await transport.getPaginated('repos/acme/widgets/issues/3/comments'), [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    assert.deepEqual(runner.calls[0]?.args.slice(-2), ['--paginate', '--slurp']);
  });

  it('reads a raw media representation without JSON parsing', async () => {
    const diff = 'diff --git a/a.ts b/a.ts\n+ok\n';
    const runner = new RecordingRunner([result(diff)]);
    const transport = new GhCliTransport({ runner });

    assert.equal(
      await transport.getRaw('repos/acme/widgets/pulls/7', 'application/vnd.github.diff'),
      diff,
    );
    assert.ok(runner.calls[0]?.args.includes('Accept: application/vnd.github.diff'));
  });

  it('executes GraphQL with typed variables and parses the response', async () => {
    const runner = new RecordingRunner([result('{"data":{"ok":true}}')]);
    const transport = new GhCliTransport({ runner });

    assert.deepEqual(await transport.graphql('query($number: Int!) { ok }', { owner: 'acme', number: 7 }), {
      data: { ok: true },
    });
    assert.deepEqual(runner.calls[0]?.args, [
      'api',
      'graphql',
      '-f',
      'query=query($number: Int!) { ok }',
      '-F',
      'number=7',
      '-F',
      'owner=acme',
    ]);
  });

  it('rejects malformed JSON and non-array pagination pages', async () => {
    const malformed = new GhCliTransport({ runner: new RecordingRunner([result('{bad')]) });
    await expectCode(malformed.get('repos/acme/widgets/issues/3'), 'GH_INVALID_RESPONSE', false);

    const wrongPages = new GhCliTransport({ runner: new RecordingRunner([result('[{"id":1}]')]) });
    await expectCode(
      wrongPages.getPaginated('repos/acme/widgets/issues/3/comments'),
      'GH_INVALID_RESPONSE',
      false,
    );
  });

  it('maps authentication, not-found, rate-limit, and generic command failures', async () => {
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([result('', 'HTTP 401: Requires authentication', 1)]) }).get('x'),
      'GH_AUTH_REQUIRED',
      false,
    );
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([result('', 'HTTP 404: Not Found', 1)]) }).get('x'),
      'GH_NOT_FOUND',
      false,
    );
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([result('', 'API rate limit exceeded', 1)]) }).get('x'),
      'GH_RATE_LIMITED',
      true,
    );
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([result('', 'connection reset', 1)]) }).get('x'),
      'GH_TRANSPORT_FAILED',
      true,
    );
  });

  it('maps missing gh and process timeout exceptions deterministically', async () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([missing]) }).get('x'),
      'GH_TRANSPORT_FAILED',
      false,
    );

    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    await expectCode(
      new GhCliTransport({ runner: new RecordingRunner([timeout]) }).get('x'),
      'GH_TIMEOUT',
      true,
    );
  });
});
