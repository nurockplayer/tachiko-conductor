import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { GitHubLiveStateError } from '../src/github/errors.js';
import { FileToolOutputStore } from '../src/evidence/tool-output.js';
import {
  GhCliTransport,
  NodeProcessRunner,
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

  it('uses the explicit POST/PATCH surface only with a JSON body field', async () => {
    const runner = new RecordingRunner([result('{"id":9,"body":"runtime"}'), result('{"id":9,"body":"next"}')]);
    const transport = new GhCliTransport({ runner });

    assert.deepEqual(await transport.write('repos/acme/widgets/issues/3/comments', 'POST', { body: 'runtime' }), { id: 9, body: 'runtime' });
    assert.deepEqual(await transport.write('repos/acme/widgets/issues/comments/9', 'PATCH', { body: 'next' }), { id: 9, body: 'next' });
    assert.deepEqual(runner.calls.map((call) => call.args.slice(0, 5)), [
      ['api', '--method', 'POST', 'repos/acme/widgets/issues/3/comments', '-H'],
      ['api', '--method', 'PATCH', 'repos/acme/widgets/issues/comments/9', '-H'],
    ]);
    assert.ok(runner.calls.every((call) => call.args.includes('-f') && call.args.includes(call === runner.calls[0] ? 'body=runtime' : 'body=next')));
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

  it('keeps parser input transient and complete when a deprecated store and tiny preview budget are configured', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-gh-parser-output-'));
    const bin = path.join(directory, 'bin');
    const evidence = path.join(directory, 'evidence');
    const previousPath = process.env.PATH;
    try {
      const expected = 'TAIL-MARKER-' + 'x'.repeat(64 * 1024);
      const source = `process.stdout.write(JSON.stringify({ payload: ${JSON.stringify(expected)} }))`;
      const fakeGh = path.join(bin, 'gh');
      mkdirSync(bin);
      writeFileSync(fakeGh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`);
      chmodSync(fakeGh, 0o755);
      process.env.PATH = bin;
      const result = await new GhCliTransport({
        outputStore: new FileToolOutputStore(evidence),
        outputPolicy: { previewBytes: 8, diagnosticBytes: 32, maxDiagnostics: 2, readBytes: 16 },
      }).get('/repos/example/project');
      assert.equal((result as { readonly payload: string }).payload, expected);
      assert.equal(existsSync(evidence), false, 'parser command created no artifact or operation files');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('NodeProcessRunner', () => {
  it('runs beforeSpawn immediately before child creation and rejects without spawning when it throws', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-before-spawn-'));
    try {
      const ready = path.join(directory, 'ready');
      const launched = path.join(directory, 'launched');
      const runner = new NodeProcessRunner();
      const result = await runner.run(process.execPath, ['-e', `const fs=require('node:fs'); if (!fs.existsSync(${JSON.stringify(ready)})) process.exit(31); process.stdout.write('spawned')`], {
        timeoutMs: 1_000,
        beforeSpawn: () => writeFileSync(ready, 'ready'),
      });
      assert.equal(result.stdout, 'spawned');
      assert.equal(readFileSync(ready, 'utf8'), 'ready');

      await assert.rejects(() => runner.run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes')`], {
        timeoutMs: 1_000,
        beforeSpawn: () => { throw new Error('host check rejected'); },
      }), /host check rejected/);
      assert.equal(existsSync(launched), false);

      const evidenceRoot = path.join(directory, 'evidence');
      const admissionError = new Error('captured host check rejected');
      await assert.rejects(() => runner.run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'yes')`], {
        timeoutMs: 1_000,
        outputStore: new FileToolOutputStore(evidenceRoot),
        beforeSpawn: () => { throw admissionError; },
      }), (error: unknown) => {
        const value = error as { readonly message?: string; readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown } };
        assert.equal(error, admissionError, 'capture cleanup preserves admission-error identity');
        assert.match(value.message ?? '', /captured host check rejected/);
        assert.equal(value.captureStatus, 'unavailable');
        assert.equal(value.captureObservation?.status, 'unavailable');
        return true;
      });
      assert.equal(existsSync(launched), false, 'captured refusal rejects without creating child');
      assert.deepEqual(readdirSync(evidenceRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves frozen Error and primitive beforeSpawn refusals when capture observation cannot be attached', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-immutable-admission-refusal-'));
    try {
      const marker = path.join(directory, 'child-ran');
      const frozenRefusal = Object.freeze(Object.assign(new Error('frozen host refusal'), { code: 'HOST_REFUSAL' }));
      const refusals: readonly unknown[] = [frozenRefusal, 'primitive host refusal'];
      for (const [index, refusal] of refusals.entries()) {
        const evidenceRoot = path.join(directory, `evidence-${index}`);
        const store = new FileToolOutputStore(evidenceRoot);
        await assert.rejects(new NodeProcessRunner().run(process.execPath,
          ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          { timeoutMs: 1_000, outputStore: store, beforeSpawn: () => { throw refusal; } }),
        (error: unknown) => {
          assert.equal(error, refusal, 'metadata attachment must not replace the original thrown value');
          if (refusal === frozenRefusal) assert.equal((error as NodeJS.ErrnoException).code, 'HOST_REFUSAL');
          return true;
        });
        assert.equal(existsSync(marker), false, 'admission refusal occurs before child creation');
        assert.deepEqual(readdirSync(evidenceRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], 'prepared capture files are purged');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('waits for child settlement after stdin EPIPE instead of leaving an orphan', async () => {
    const result = await new NodeProcessRunner().run(
      process.execPath,
      ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(7), 25)'],
      { timeoutMs: 1_000, stdin: 'x'.repeat(1024 * 1024) },
    );

    assert.equal(result.exitCode, 7);
  });

  it('keeps captured numeric nonzero exit authoritative over stdin EPIPE, but rejects EPIPE on zero exit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-captured-stdin-epipe-'));
    try {
      const store = new FileToolOutputStore(root);
      const failed = await new NodeProcessRunner().run(process.execPath,
        ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(23), 25)'],
        { timeoutMs: 1_000, stdin: 'x'.repeat(1024 * 1024), outputStore: store });
      assert.equal(failed.exitCode, 23);
      await assert.rejects(new NodeProcessRunner().run(process.execPath,
        ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 25)'],
        { timeoutMs: 1_000, stdin: 'x'.repeat(1024 * 1024), outputStore: store }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EPIPE');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
