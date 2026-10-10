import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { GitHubLiveStateError } from '../src/github/errors.js';
import { FileToolOutputStore, InMemoryToolOutputStore } from '../src/evidence/tool-output.js';
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
  it('runs the admission fence before rejecting invalid captured timeouts without preparing capture or child', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-invalid-captured-timeout-fence-'));
    try {
      const values = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
      for (const [index, timeoutMs] of values.entries()) {
        const evidenceRoot = path.join(directory, `evidence-${index}`);
        const launched = path.join(directory, `launched-${index}`);
        let fenceCalls = 0;
        const controller = new AbortController();
        await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'started')`], {
          timeoutMs,
          signal: controller.signal,
          outputStore: new FileToolOutputStore(evidenceRoot),
          beforeSpawn: () => { fenceCalls += 1; controller.abort(); },
        }), (error: unknown) => {
          assert.equal((error as NodeJS.ErrnoException).code, 'ERR_OUT_OF_RANGE');
          assert.ok(error instanceof RangeError);
          return true;
        });
        assert.equal(fenceCalls, 1, `timeout ${String(timeoutMs)}: invalid captured configuration still runs the authority fence exactly once`);
        assert.equal(existsSync(evidenceRoot), false, 'invalid timeout does not create capture operation or root');
        assert.equal(existsSync(launched), false, 'invalid timeout rejects before child creation');
      }

      for (const [index, refusal] of [
        Object.freeze(Object.assign(new Error('host refuses invalid timeout'), { code: 'HOST_REFUSAL' })),
        'primitive host refusal for invalid timeout',
      ].entries()) {
        let refusalFenceCalls = 0;
        const evidenceRoot = path.join(directory, `refusal-evidence-${index}`);
        await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', 'process.exit(0)'], {
          timeoutMs: -1,
          outputStore: new FileToolOutputStore(evidenceRoot),
          beforeSpawn: () => { refusalFenceCalls += 1; throw refusal; },
        }), (error: unknown) => {
          assert.equal(error, refusal, 'frozen or primitive host refusal wins over invalid timeout validation');
          return true;
        });
        assert.equal(refusalFenceCalls, 1);
        assert.equal(existsSync(evidenceRoot), false);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps valid zero and positive captured timeouts in capture-preparation then immediate-fence order', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-valid-captured-timeout-order-'));
    try {
      for (const timeoutMs of [0, 1_000]) {
        const events: string[] = [];
        const store = new FileToolOutputStore(path.join(directory, `evidence-${timeoutMs}`), {
          testFaults: { beforeCaptureStart: () => { events.push('capture-prepared'); } },
        });
        let fenceCalls = 0;
        const result = await new NodeProcessRunner().run(process.execPath, ['-e', "process.stdout.write('valid')"], {
          timeoutMs,
          outputStore: store,
          beforeSpawn: () => { events.push('beforeSpawn'); fenceCalls += 1; },
        });
        assert.equal(result.stdout, 'valid');
        assert.deepEqual(events, ['capture-prepared', 'beforeSpawn'], `timeout ${timeoutMs}: valid captured flow preserves preparation/fence order`);
        assert.equal(fenceCalls, 1);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('retains actual process pipe bytes in memory capture while exposing a bounded text projection', async () => {
    const store = new InMemoryToolOutputStore();
    const stdout = Buffer.from([0x41, 0xff, 0x80, 0xe2, 0x82, 0x42]);
    const stderr = Buffer.from([0xf0, 0x9f, 0x99, 0x82, 0xed, 0xa0, 0x80]);
    const script = `process.stdout.write(Buffer.from(${JSON.stringify([...stdout])})); process.stderr.write(Buffer.from(${JSON.stringify([...stderr])}));`;
    const result = await new NodeProcessRunner().run(process.execPath, ['-e', script], {
      timeoutMs: 2_000, outputStore: store,
    });
    assert.equal(result.captureStatus, 'complete');
    assert.ok(result.output);
    assert.equal(result.output.stdout.bytes, stdout.length);
    assert.equal(result.output.stderr.bytes, stderr.length);
    assert.equal(result.output.stdout.preview, 'A????B');
    assert.equal(result.output.stderr.preview, '🙂???');
    assert.equal(store.read(result.output.artifact, { channel: 'stdout', length: 32 }).text, 'A????B');
    assert.equal(store.read(result.output.artifact, { channel: 'stderr', length: 32 }).text, '🙂???');
    assert.equal(result.output.artifact.sha256,
      createHash('sha256').update(stdout).update('\0').update(stderr).digest('hex'));
  });

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
      for (const mode of ['ordinary', 'captured'] as const) {
        const failed = await new NodeProcessRunner().run(process.execPath,
          ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(23), 25)'],
          { timeoutMs: 1_000, stdin: 'x'.repeat(1024 * 1024), ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}) });
        assert.equal(failed.exitCode, 23, `${mode}: numeric nonzero child exit outranks incidental EPIPE`);
      }
      for (const mode of ['ordinary', 'captured'] as const) {
        await assert.rejects(new NodeProcessRunner().run(process.execPath,
          ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 25)'],
          { timeoutMs: 1_000, stdin: 'x'.repeat(1024 * 1024), ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}) }),
        (error: unknown) => {
          const value = error as NodeJS.ErrnoException & { readonly output?: { readonly outcome?: unknown; readonly exitCode?: unknown } };
          assert.equal(value.code, 'EPIPE');
          if (mode === 'captured') {
            assert.equal(value.output?.outcome, 'failed', 'a rejected zero-exit EPIPE invocation cannot advertise a passed outcome');
            assert.equal(value.output?.exitCode, 0);
          }
          return true;
        });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('matches execFile timeout admission and treats zero as no deadline', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-timeout-admission-'));
    const marker = path.join(directory, 'child-ran');
    try {
      const script = `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('TIMEOUT-ZERO-OK'); }, 50)`;
      const ordinary = await new NodeProcessRunner().run(process.execPath, ['-e', script], { timeoutMs: 0 });
      assert.equal(ordinary.exitCode, 0);
      assert.equal(ordinary.stdout, 'TIMEOUT-ZERO-OK');
      assert.equal(readFileSync(marker, 'utf8'), 'ran');

      rmSync(marker);
      const evidenceRoot = path.join(directory, 'evidence');
      const captured = await new NodeProcessRunner().run(process.execPath, ['-e', script], {
        timeoutMs: 0, outputStore: new FileToolOutputStore(evidenceRoot),
      });
      assert.equal(captured.exitCode, ordinary.exitCode);
      assert.equal(captured.stdout, 'TIMEOUT-ZERO-OK');
      assert.equal(captured.output?.outcome, 'passed');
      assert.equal(existsSync(marker), true);

      for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const invalidMarker = path.join(directory, `invalid-${String(timeoutMs)}`);
        const invalidRoot = path.join(directory, `evidence-${String(timeoutMs)}`);
        const invalidScript = `require('node:fs').writeFileSync(${JSON.stringify(invalidMarker)}, 'ran')`;
        await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', invalidScript], { timeoutMs }),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'ERR_OUT_OF_RANGE');
        await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', invalidScript], {
          timeoutMs, outputStore: new FileToolOutputStore(invalidRoot),
        }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ERR_OUT_OF_RANGE');
        assert.equal(existsSync(invalidMarker), false, `invalid timeout ${String(timeoutMs)} launches no child`);
        assert.equal(existsSync(invalidRoot), false, `invalid timeout ${String(timeoutMs)} prepares no capture`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('matches execFile actual-result precedence for handled timeout, genuine abort, and late abort', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-process-truth-'));
    const code = (error: unknown): unknown => (error as NodeJS.ErrnoException).code;
    try {
      for (const mode of ['ordinary', 'captured'] as const) {
        const root = path.join(directory, `${mode}-timeout-zero-exit`);
        const runner = new NodeProcessRunner();
        const result = await runner.run(process.execPath, ['-e', "process.on('SIGTERM', () => { process.stdout.write('TIMEOUT-HANDLED'); process.exit(0); }); setInterval(() => {}, 1000)"], {
          timeoutMs: 300, ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}),
        });
        assert.equal(result.exitCode, 0, `${mode}: a handled timeout signal with exit 0 is successful`);
        if (mode === 'captured') {
          assert.equal(result.captureStatus, 'partial', 'deadline-closed streams cannot advertise a complete artifact');
          assert.equal(result.output, undefined);
        }
      }

      for (const mode of ['ordinary', 'captured'] as const) {
        const root = path.join(directory, `${mode}-timeout-nonzero-exit`);
        await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(9)); setInterval(() => {}, 1000)"], {
          timeoutMs: 300, ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}),
        }), (error: unknown) => {
          const value = error as NodeJS.ErrnoException & { readonly output?: { readonly outcome?: unknown } };
          assert.equal(value.code, 'ETIMEDOUT');
          if (mode === 'captured') {
            assert.equal((value as NodeJS.ErrnoException & { readonly captureStatus?: unknown }).captureStatus, 'partial');
            assert.equal(value.output, undefined);
          }
          return true;
        });
      }

      for (const mode of ['ordinary', 'captured'] as const) {
        const controller = new AbortController();
        const root = path.join(directory, `${mode}-abort-zero-exit`);
        const pending = new NodeProcessRunner().run(process.execPath, ['-e', "process.on('SIGTERM', () => { process.stdout.write('ABORT-HANDLED'); process.exit(0); }); setInterval(() => {}, 1000)"], {
          timeoutMs: 5_000, signal: controller.signal,
          ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}),
        });
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(pending, (error: unknown) => {
          const value = error as NodeJS.ErrnoException & { readonly output?: { readonly outcome?: unknown } };
          assert.equal(code(error), 'ABORT_ERR');
          if (mode === 'captured') {
            assert.equal((value as NodeJS.ErrnoException & { readonly captureStatus?: unknown }).captureStatus, 'partial');
            assert.equal(value.output, undefined);
          }
          return true;
        });
      }

      const originalEmit = ChildProcess.prototype.emit;
      for (const mode of ['ordinary', 'captured'] as const) {
        for (const directExitCode of [0, 17] as const) {
          const controller = new AbortController();
          const root = path.join(directory, `${mode}-late-abort-${directExitCode}`);
          const outputMarker = directExitCode === 0 ? 'LATE-PIPE-DONE' : 'LATE-NONZERO-DONE';
          const script = [
            "const { spawn } = require('node:child_process');",
            `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => process.stdout.write('${outputMarker}'), 250)`)}], { stdio: 'inherit' });`,
            `setTimeout(() => process.exit(${directExitCode}), 150);`,
          ].join(' ');
          let ownedChild: ChildProcess | undefined;
          let spawnedAt: number | undefined;
          let closed = false;
          let resolveClosed!: () => void;
          const closeObserved = new Promise<void>((resolve) => { resolveClosed = resolve; });
          let resolveDirectExit!: (value: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly elapsedSinceSpawnMs: number }) => void;
          const directExitObserved = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly elapsedSinceSpawnMs: number }>((resolve) => {
            resolveDirectExit = resolve;
          });
          const isOwnedChild = (child: ChildProcess): boolean => child.spawnfile === process.execPath
            && child.spawnargs[1] === '-e' && child.spawnargs[2] === script;
          const observedEmit = function (this: ChildProcess, eventName: string | symbol, ...args: unknown[]): boolean {
            const isTarget = isOwnedChild(this);
            if (isTarget && eventName === 'spawn' && ownedChild === undefined) {
              ownedChild = this;
              spawnedAt = Date.now();
              this.once('close', () => { closed = true; resolveClosed(); });
            }
            const emitted = Reflect.apply(originalEmit, this, [eventName, ...args]) as boolean;
            if (isTarget && this === ownedChild && eventName === 'exit') {
              const observedAt = Date.now();
              resolveDirectExit({
                code: typeof args[0] === 'number' ? args[0] : null,
                signal: typeof args[1] === 'string' ? args[1] as NodeJS.Signals : null,
                elapsedSinceSpawnMs: spawnedAt === undefined ? -1 : observedAt - spawnedAt,
              });
              // The production exit listeners have all run before this event observer delivers the abort.
              controller.abort();
            }
            return emitted;
          };
          ChildProcess.prototype.emit = observedEmit as typeof originalEmit;
          let pending: Promise<ProcessResult> | undefined;
          let settled: Promise<{ readonly result: ProcessResult } | { readonly error: unknown }> | undefined;
          let exitDeadline: ReturnType<typeof setTimeout> | undefined;
          let settlementDeadline: ReturnType<typeof setTimeout> | undefined;
          try {
            pending = new NodeProcessRunner().run(process.execPath, ['-e', script], {
              timeoutMs: 5_000, signal: controller.signal,
              ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}),
            });
            settled = pending.then((result) => ({ result }), (error: unknown) => ({ error }));
            const deadline = new Promise<never>((_resolve, reject) => {
              exitDeadline = setTimeout(() => reject(new Error(`${mode}/${directExitCode}: actual owned child did not exit`)), 3_000);
            });
            const observedExit = await Promise.race([directExitObserved, deadline]);
            if (exitDeadline !== undefined) clearTimeout(exitDeadline);
            assert.equal(observedExit.code, directExitCode, `${mode}/${directExitCode}: observer matched the expected real direct child`);
            assert.equal(observedExit.signal, null);
            assert.ok(observedExit.elapsedSinceSpawnMs >= 150,
              `${mode}/${directExitCode}: the actual child's 150ms startup makes the old 75ms timer a pre-exit abort`);
            assert.equal(controller.signal.aborted, true, `${mode}/${directExitCode}: abort is delivered after actual exit listeners run`);

            const settlementTimedOut = new Promise<never>((_resolve, reject) => {
              settlementDeadline = setTimeout(() => reject(new Error(`${mode}/${directExitCode}: runner did not settle after natural pipe close`)), 3_000);
            });
            const outcome = await Promise.race([settled, settlementTimedOut]);
            if (settlementDeadline !== undefined) clearTimeout(settlementDeadline);
            if (directExitCode !== 0) {
              assert.ok('error' in outcome, `${mode}/${directExitCode}: abort error is retained after the real nonzero exit`);
              assert.equal(code(outcome.error), 'ABORT_ERR');
              assert.equal(closed, true, `${mode}/${directExitCode}: inherited pipes reached actual close before the runner settled`);
              if (mode === 'captured') {
                const value = outcome.error as NodeJS.ErrnoException & {
                  readonly captureStatus?: unknown;
                  readonly captureObservation?: { readonly status?: unknown; readonly stdout?: { readonly preview?: string } };
                  readonly output?: { readonly outcome?: unknown; readonly exitCode?: unknown; readonly artifact?: unknown };
                };
                assert.equal(value.captureStatus, 'complete');
                assert.equal(value.captureObservation?.status, 'complete');
                assert.match(value.captureObservation?.stdout?.preview ?? '', new RegExp(outputMarker));
                assert.equal(value.output?.outcome, 'cancelled');
                assert.equal(value.output?.exitCode, directExitCode, 'the artifact retains the observed numeric child exit');
                assert.ok(value.output?.artifact, 'natural EOF retains the completed failure artifact');
              }
              continue;
            }
            assert.ok('result' in outcome, `${mode}/${directExitCode}: the observed successful child exit remains authoritative`);
            const result = outcome.result;
            assert.equal(result.exitCode, directExitCode);
            assert.match(result.stdout, new RegExp(outputMarker));
            assert.equal(closed, true, `${mode}/${directExitCode}: inherited pipes reached actual close before the runner settled`);
            if (mode === 'captured') {
              assert.equal(result.captureStatus, 'complete');
              assert.equal(result.captureObservation?.status, 'complete');
              assert.equal(result.output?.outcome, directExitCode === 0 ? 'passed' : 'failed');
              assert.equal(result.output?.exitCode, directExitCode);
              assert.ok(result.output?.artifact, `${mode}/${directExitCode}: naturally completed inherited pipes retain their artifact`);
            }
          } finally {
            if (exitDeadline !== undefined) clearTimeout(exitDeadline);
            if (settlementDeadline !== undefined) clearTimeout(settlementDeadline);
            ChildProcess.prototype.emit = originalEmit;
            if (!controller.signal.aborted) controller.abort();
            if (settled !== undefined) await settled;
            if (ownedChild !== undefined && !closed) {
              let closeDeadline: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([closeObserved, new Promise<void>((_resolve, reject) => {
                  closeDeadline = setTimeout(() => reject(new Error(`${mode}/${directExitCode}: owned child did not close`)), 3_000);
                })]);
              } finally {
                if (closeDeadline !== undefined) clearTimeout(closeDeadline);
              }
            }
          }
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('settles a successful genuine abort immediately even when the child handles SIGTERM slowly', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-abort-slow-handler-'));
    try {
      for (const mode of ['ordinary', 'captured'] as const) {
        const controller = new AbortController();
        const root = path.join(directory, mode);
        const marker = 'ABORT-OBSERVED';
        const script = `setTimeout(() => { process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1000)); process.stderr.write('${marker}\\n'); }, 400); setInterval(() => {}, 1000)`;
        const originalEmit = ChildProcess.prototype.emit;
        let child: ChildProcess | undefined;
        let observedReady = false;
        let markerSuffix = '';
        let abortAt: number | undefined;
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
        const observedEmit = function (this: ChildProcess, eventName: string | symbol, ...args: unknown[]): boolean {
          if (eventName === 'spawn' && this.spawnfile === process.execPath && this.spawnargs[1] === '-e' && this.spawnargs[2] === script) {
            child = this;
            this.once('close', resolveClosed);
            this.stderr?.on('data', (chunk: Buffer | string) => {
              const combined = markerSuffix + String(chunk);
              const containsMarker = combined.includes(marker);
              markerSuffix = combined.slice(-(marker.length - 1));
              if (observedReady || !containsMarker) return;
              observedReady = true;
              resolveReady();
              queueMicrotask(() => {
                abortAt = Date.now();
                controller.abort();
              });
            });
          }
          return Reflect.apply(originalEmit, this, [eventName, ...args]) as boolean;
        };
        ChildProcess.prototype.emit = observedEmit as typeof originalEmit;
        const pending = new NodeProcessRunner().run(process.execPath, ['-e', script], {
          timeoutMs: 2_000,
          signal: controller.signal,
          ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(root) } : {}),
        });
        const settled = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
        const readinessTimer = setTimeout(() => rejectReady(new Error(`${mode}: child readiness marker was not observed`)), 3_000);
        try {
          await ready;
          clearTimeout(readinessTimer);
          assert.equal(observedReady, true, `${mode}: readiness follows 400ms child initialization and installed SIGTERM handler`);
          const outcome = await settled;
          assert.ok('error' in outcome, `${mode}: genuine abort rejects the runner`);
          const error = outcome.error;
          assert.equal((error as NodeJS.ErrnoException).code, 'ABORT_ERR');
          assert.ok(abortAt !== undefined, `${mode}: abort was triggered only after the actual marker observation`);
          if (mode === 'captured') {
            const value = error as NodeJS.ErrnoException & { readonly captureStatus?: unknown; readonly output?: unknown;
              readonly captureObservation?: { readonly status?: unknown; readonly diagnostics?: readonly string[] } };
            assert.equal(value.captureStatus, 'partial');
            assert.equal(value.captureObservation?.status, 'partial');
            assert.ok(value.captureObservation?.diagnostics?.some((line) => line.includes(marker)));
            assert.equal(value.output, undefined, 'an aborted partial capture publishes no complete artifact');
            assert.deepEqual(readdirSync(root, { recursive: true }).map(String).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [],
              'an aborted partial capture leaves no raw artifact files');
          }
          const elapsedMs = Date.now() - abortAt!;
          assert.ok(elapsedMs < 650, `${mode}: abort settlement is measured from the observed abort trigger, not startup (observed ${elapsedMs}ms)`);
        } finally {
          clearTimeout(readinessTimer);
          ChildProcess.prototype.emit = originalEmit;
          if (!controller.signal.aborted) controller.abort();
          await settled;
          if (child !== undefined) {
            let closeDeadline: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([closed, new Promise<void>((_resolve, reject) => {
                closeDeadline = setTimeout(() => reject(new Error(`${mode}: owned child did not close after abort`)), 3_000);
              })]);
            } finally {
              if (closeDeadline !== undefined) clearTimeout(closeDeadline);
            }
          }
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not terminate before spawn admission and lets the spawn event reconsider an aborted signal', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-abort-spawn-admission-'));
    const originalKill = ChildProcess.prototype.kill;
    const invalidPidAttempts: Array<number | undefined> = [];
    ChildProcess.prototype.kill = function safeObservedKill(signal?: NodeJS.Signals | number): boolean {
      const pid = this.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
        invalidPidAttempts.push(pid);
        return false;
      }
      return originalKill.call(this, signal);
    };
    try {
      const missingExecutable = path.join(directory, 'missing-command');
      const missingController = new AbortController();
      const missingError = await new NodeProcessRunner().run(missingExecutable, [], {
        timeoutMs: 2_000,
        signal: missingController.signal,
        outputStore: new FileToolOutputStore(path.join(directory, 'missing-evidence')),
        beforeSpawn: () => missingController.abort(),
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      );

      const marker = path.join(directory, 'spawned-child-ran');
      const controller = new AbortController();
      const spawnedResult = await new NodeProcessRunner().run(process.execPath, ['-e', `setTimeout(() => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0); }, 300)`], {
        timeoutMs: 2_000,
        signal: controller.signal,
        outputStore: new FileToolOutputStore(path.join(directory, 'spawned-evidence')),
        beforeSpawn: () => controller.abort(),
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      assert.deepEqual(invalidPidAttempts, [], 'manual termination is never attempted until spawn supplies a valid PID');
      assert.equal((missingError as NodeJS.ErrnoException | undefined)?.code, 'ABORT_ERR', 'current abort state takes precedence over captured failed spawn');
      const missingValue = missingError as NodeJS.ErrnoException & { readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown } };
      assert.equal(missingValue.captureStatus, 'unavailable');
      assert.equal(missingValue.captureObservation?.status, 'unavailable');
      const value = 'error' in spawnedResult ? spawnedResult.error as NodeJS.ErrnoException & { readonly captureStatus?: unknown; readonly output?: unknown } : undefined;
      assert.equal(value?.code, 'ABORT_ERR', 'the successful spawn event reconsiders an abort raised before child creation');
      assert.equal(value?.captureStatus, 'partial');
      assert.equal(value?.output, undefined);
      assert.equal(existsSync(marker), false, 'the child is terminated before its delayed side effect');
    } finally {
      ChildProcess.prototype.kill = originalKill;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves uninstrumented missing-executable errors with and without a synchronous abort', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-missing-executable-smoke-'));
    const missingExecutable = path.join(directory, 'missing-command');
    try {
      await assert.rejects(new NodeProcessRunner().run(missingExecutable, [], { timeoutMs: 2_000 }), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
        return true;
      });

      const controller = new AbortController();
      await assert.rejects(new NodeProcessRunner().run(missingExecutable, [], {
        timeoutMs: 2_000,
        signal: controller.signal,
        beforeSpawn: () => controller.abort(),
      }), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'ABORT_ERR');
        return true;
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves already-aborted beforeSpawn refusals across ordinary and captured commands', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-preabort-fence-parity-'));
    const originalKill = ChildProcess.prototype.kill;
    let invalidPidAttempts = 0;
    ChildProcess.prototype.kill = function safeObservedKill(signal?: NodeJS.Signals | number): boolean {
      const pid = this.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
        invalidPidAttempts += 1;
        return false;
      }
      return originalKill.call(this, signal);
    };
    try {
      const refusals: readonly unknown[] = [
        Object.freeze(Object.assign(new Error('frozen pre-abort refusal'), { code: 'HOST_REFUSAL' })),
        'primitive pre-abort refusal',
        new Error('mutable pre-abort refusal'),
      ];
      const commands = [process.execPath, path.join(directory, 'missing-command')];
      for (const mode of ['ordinary', 'captured'] as const) {
        for (const command of commands) {
          for (const [index, refusal] of refusals.entries()) {
            const controller = new AbortController();
            controller.abort();
            let fenceCalls = 0;
            const options = {
              timeoutMs: 2_000,
              signal: controller.signal,
              beforeSpawn: () => { fenceCalls += 1; throw refusal; },
              ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(path.join(directory, `refusal-${mode}-${path.basename(command)}-${index}`)) } : {}),
            };
            await assert.rejects(new NodeProcessRunner().run(command, ['-e', 'process.exit(0)'], options), (error: unknown) => {
              assert.equal(error, refusal, `${mode}: original refusal identity wins for ${command}`);
              return true;
            });
            assert.equal(fenceCalls, 1, `${mode}: the synchronous admission fence runs before abort settlement`);
          }
        }
      }
      assert.equal(invalidPidAttempts, 0, 'a throwing admission fence creates no child and no manual kill attempt');
    } finally {
      ChildProcess.prototype.kill = originalKill;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reconsiders already-aborted captured valid and missing commands after the synchronous fence', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-preabort-spawn-parity-'));
    const originalKill = ChildProcess.prototype.kill;
    let invalidPidAttempts = 0;
    ChildProcess.prototype.kill = function safeObservedKill(signal?: NodeJS.Signals | number): boolean {
      const pid = this.pid;
      if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
        invalidPidAttempts += 1;
        return false;
      }
      return originalKill.call(this, signal);
    };
    try {
      for (const command of [process.execPath, path.join(directory, 'missing-command')]) {
        const controller = new AbortController();
        controller.abort();
        let fenceCalls = 0;
        await assert.rejects(new NodeProcessRunner().run(command, ['-e', 'setTimeout(() => process.exit(0), 300)'], {
          timeoutMs: 2_000,
          signal: controller.signal,
          outputStore: new FileToolOutputStore(path.join(directory, `capture-${path.basename(command)}`)),
          beforeSpawn: () => { fenceCalls += 1; },
        }), (error: unknown) => {
          assert.equal((error as NodeJS.ErrnoException).code, 'ABORT_ERR');
          return true;
        });
        assert.equal(fenceCalls, 1, 'pre-abort does not skip the authority fence');
      }
      assert.equal(invalidPidAttempts, 0, 'only successfully spawned children with valid PIDs can be terminated');
    } finally {
      ChildProcess.prototype.kill = originalKill;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves actual kill exceptions with main-equivalent abort and timeout precedence', async () => {
    const originalKill = ChildProcess.prototype.kill;
    try {
      for (const trigger of ['abort', 'timeout'] as const) {
        for (const mode of ['ordinary', 'captured'] as const) {
          const controller = new AbortController();
          const refusal = Object.assign(new Error('synthetic positive-PID kill refusal'), { code: 'EIO' });
          let calls = 0;
          ChildProcess.prototype.kill = function safeThrowingKill(): boolean {
            assert.ok(Number.isSafeInteger(this.pid) && this.pid! > 0, 'only a real spawned positive PID reaches the injected failure');
            calls += 1;
            throw refusal;
          };
          const startedAt = Date.now();
          const pending = new NodeProcessRunner().run(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 400)'], {
            timeoutMs: trigger === 'timeout' ? 100 : 1_000,
            ...(trigger === 'abort' ? { signal: controller.signal } : {}),
            ...(mode === 'captured' ? { outputStore: new InMemoryToolOutputStore() } : {}),
          });
          const timer = trigger === 'abort' ? setTimeout(() => controller.abort(), 100) : undefined;
          try {
          await assert.rejects(pending, (error: unknown) => {
              if (trigger === 'abort') {
                assert.equal((error as NodeJS.ErrnoException).code, 'ABORT_ERR', `${mode}: current aborted-state precedence matches execFile`);
              } else {
                assert.equal(error, refusal, `${mode}: a non-aborted timeout preserves the exact kill error`);
                assert.equal((error as NodeJS.ErrnoException).code, 'EIO');
              }
              if (mode === 'captured') {
                const value = error as NodeJS.ErrnoException & { readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown }; readonly output?: unknown };
                assert.equal(value.captureStatus, 'partial');
                assert.equal(value.captureObservation?.status, 'partial');
                assert.equal(value.output, undefined);
              }
              return true;
            });
            assert.equal(calls, 1, `${trigger}/${mode}: exactly one valid-PID termination attempt`);
            assert.ok(Date.now() - startedAt < 350, `${trigger}/${mode}: kill failure settles without waiting for child exit`);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      }
    } finally { ChildProcess.prototype.kill = originalKill; }
  });
});
