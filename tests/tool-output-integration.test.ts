import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_TOOL_OUTPUT_POLICY, FileToolOutputStore, InMemoryToolOutputStore, readToolOutput, searchToolOutput, type ToolOutputCaptureWriter, type ToolOutputPolicy, type ToolOutputStore } from '../src/evidence/tool-output.js';
import { NodeProcessRunner } from '../src/github/transport.js';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const observedMarker = 'ERROR: ROOT-CAUSE-OBSERVED\n';
const observedMarkerBytes = Buffer.byteLength(observedMarker, 'utf8');

function observingStore(delegate: InMemoryToolOutputStore, onObserved: () => void): ToolOutputStore {
  let stderr = '';
  let observed = false;
  return {
    save: delegate.save.bind(delegate),
    startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
      const writer = delegate.startCapture(policy);
      return {
        write(channel, chunk) {
          writer.write(channel, chunk);
          if (channel === 'stderr' && !observed) {
            stderr += chunk.slice(0, observedMarkerBytes - Buffer.byteLength(stderr, 'utf8'));
            if (stderr.includes(observedMarker)) {
              observed = true;
              onObserved();
            }
          }
        },
        finish: writer.finish.bind(writer),
        abort: writer.abort?.bind(writer),
      };
    },
    read: delegate.read.bind(delegate),
    search: delegate.search.bind(delegate),
  };
}

function fragmentedMarkerScript(terminal: 'hang' | 'signal'): string {
  const ending = terminal === 'signal'
    ? "process.stderr.write('', () => process.kill(process.pid, 'SIGTERM'));"
    : 'setInterval(() => {}, 1000);';
  return [
    "const parts = ['ERROR: ROOT-CAUSE-', 'OBSERVED\\n'];",
    'let index = 0;',
    `function emit() { if (index === parts.length) { ${ending} return; } process.stderr.write(parts[index++], emit); }`,
    'emit();',
  ].join('\n');
}

function assertPartialCapture(error: unknown, terminal: 'timeout' | 'cancel' | 'signal', policy: ToolOutputPolicy): void {
  const value = error as { readonly code?: unknown; readonly signal?: unknown; readonly output?: unknown;
    readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown; readonly stderr?: { readonly bytes: number; readonly preview: string }; readonly diagnostics?: readonly string[] } };
  assert.equal(value.captureStatus, 'partial');
  assert.equal(value.captureObservation?.status, 'partial');
  const observedStderr = value.captureObservation?.stderr;
  assert.ok(observedStderr !== undefined && observedStderr.bytes > 0);
  assert.ok(Buffer.byteLength(observedStderr.preview, 'utf8') <= policy.previewBytes);
  assert.ok(observedStderr.preview.includes(observedMarker.trimEnd()));
  const diagnostics = value.captureObservation?.diagnostics ?? [];
  assert.ok(diagnostics.some((line) => line.includes(observedMarker.trimEnd())));
  assert.ok(diagnostics.length <= policy.maxDiagnostics);
  assert.ok(Buffer.byteLength(diagnostics.join('\n'), 'utf8') <= policy.diagnosticBytes);
  assert.equal(value.output, undefined, 'a failed sink never advertises durable evidence');
  if (terminal === 'timeout') assert.equal(value.code, 'ETIMEDOUT');
  if (terminal === 'cancel') assert.equal(value.code, 'ABORT_ERR');
  if (terminal === 'signal') {
    assert.equal(value.code, null);
    assert.equal(value.signal, 'SIGTERM');
  }
}

describe('bounded output integration', () => {
  it('attaches bounded evidence to a real command while retaining the exact exit code', async () => {
    const store = new InMemoryToolOutputStore();
    const result = await new NodeProcessRunner({ outputPolicy: { previewBytes: 64, diagnosticBytes: 256, maxDiagnostics: 4, readBytes: 128 } }).run(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000)); process.stderr.write('ERROR: command failed\\\\n'); process.exit(23)"],
      { timeoutMs: 5_000, outputStore: store },
    );

    assert.equal(result.exitCode, 23);
    assert.equal(result.output?.outcome, 'failed');
    assert.equal(result.output?.overflow.truncated, true);
    assert.ok(result.output?.diagnostics.some((line) => line.includes('command failed')));
    assert.equal(result.output?.artifact.stdoutBytes, 20_000);
  });

  it('keeps bounded partial timeout observations after the actual marker reaches the capture writer', async (t) => {
    const controller = new AbortController();
    const delegate = new InMemoryToolOutputStore();
    let markerReachedWriter = false;
    let terminalTriggered = false;
    let watchdogFired = false;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = observingStore(delegate, () => {
      markerReachedWriter = true;
      queueMicrotask(() => { terminalTriggered = true; t.mock.timers.tick(200); });
    });
    const watchdog = realSetTimeout(() => { watchdogFired = true; controller.abort(); }, 5_000);
    try {
      let rejection: unknown;
      try {
        await new NodeProcessRunner().run(process.execPath,
          ['-e', fragmentedMarkerScript('hang')],
          { timeoutMs: 200, signal: controller.signal, outputStore: store });
      } catch (error) { rejection = error; }
      assert.ok(markerReachedWriter, 'the full marker was captured by the actual in-memory writer before deadline delivery');
      assert.ok(terminalTriggered, 'the production deadline was driven only after writer observation');
      assert.equal(watchdogFired, false, 'the real watchdog did not supply the expected terminal result');
      assert.ok(rejection, 'the actual timeout path rejects');
      assertPartialCapture(rejection, 'timeout', DEFAULT_TOOL_OUTPUT_POLICY);
    } finally {
      controller.abort();
      realClearTimeout(watchdog);
      t.mock.timers.reset();
    }
  });

  it('streams explicit in-memory evidence past the former execFile safety cap', async () => {
    const store = new InMemoryToolOutputStore();
    const result = await new NodeProcessRunner().run(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024))"],
      { timeoutMs: 10_000, outputStore: store },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.output?.artifact.totalBytes, 17 * 1024 * 1024);
    assert.equal(result.output?.overflow.capture, false);
  });

  it('searches a file-backed artifact in bounded chunks with byte offsets', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-file-output-'));
    try {
      const store = new FileToolOutputStore(directory);
      const result = await new NodeProcessRunner().run(
        process.execPath,
        ['-e', "process.stdout.write('α\\r\\nneedle here\\r\\nend\\r\\n')"],
        { timeoutMs: 5_000, outputStore: store },
      );
      const matches = searchToolOutput(result.output!, store, { channel: 'stdout', query: 'needle' });
      assert.deepEqual(matches, [{ channel: 'stdout', line: 2, offset: 4, text: 'needle here' }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the same content digest for buffered and file-backed artifacts', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-file-output-hash-'));
    try {
      const fileStore = new FileToolOutputStore(directory);
      const bufferedStore = new InMemoryToolOutputStore();
      const fileResult = await new NodeProcessRunner().run(
        process.execPath,
        ['-e', "process.stdout.write('hash stdout'); process.stderr.write('hash stderr')"],
        { timeoutMs: 5_000, outputStore: fileStore },
      );
      const bufferedResult = await new NodeProcessRunner().run(
        process.execPath,
        ['-e', "process.stdout.write('hash stdout'); process.stderr.write('hash stderr')"],
        { timeoutMs: 5_000, outputStore: bufferedStore },
      );

      assert.equal(fileResult.output?.artifact.sha256, bufferedResult.output?.artifact.sha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not create raw artifacts when a generic command only sets a preview policy', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-no-default-evidence-'));
    const prior = process.env.TACHIKO_EVIDENCE_DIR;
    try {
      process.env.TACHIKO_EVIDENCE_DIR = directory;
      const runner = new NodeProcessRunner({
        outputStore: new FileToolOutputStore(directory),
        outputPolicy: { previewBytes: 8, diagnosticBytes: 32, maxDiagnostics: 2, readBytes: 64 },
      });
      if (prior === undefined) delete process.env.TACHIKO_EVIDENCE_DIR;
      else process.env.TACHIKO_EVIDENCE_DIR = prior;
      const result = await runner.run(process.execPath, ['-e', "process.stdout.write('private output')"], {
        timeoutMs: 5_000,
        outputPolicy: { previewBytes: 8, diagnosticBytes: 32, maxDiagnostics: 2, readBytes: 64 },
      });
      assert.equal(result.stdout, 'private output');
      assert.equal(result.output, undefined);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      if (prior === undefined) delete process.env.TACHIKO_EVIDENCE_DIR;
      else process.env.TACHIKO_EVIDENCE_DIR = prior;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('streams both channels beyond the former per-stream cap and preserves full drill-down for either exit status', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-large-evidence-'));
    const payloadBytes = 17 * 1024 * 1024;
    const script = [
      "const chunk = 'x'.repeat(64 * 1024);",
      'const count = (17 * 1024 * 1024) / Buffer.byteLength(chunk);',
      'async function emit(stream, start, end) {',
      '  stream.write(start);',
      '  for (let i = 0; i < count; i += 1) await new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()));',
      '  stream.write(end);',
      '}',
      "Promise.all([emit(process.stdout, 'OUT-BEGIN\\n', '\\nOUT-END'), emit(process.stderr, 'ERR-BEGIN\\n', '\\nERR-END')]).then(() => { process.exitCode = Number(process.argv[1]); });",
    ].join('\n');
    try {
      for (const exitCode of [0, 17]) {
        const store = new FileToolOutputStore(directory);
        const result = await new NodeProcessRunner().run(process.execPath, ['-e', script, String(exitCode)], {
          timeoutMs: 30_000,
          outputStore: store,
          outputPolicy: { previewBytes: 128, diagnosticBytes: 512, maxDiagnostics: 8, readBytes: 256 },
        });

        assert.equal(result.exitCode, exitCode);
        assert.ok(result.stdout.length < 1_000, 'evidence mode returns a bounded stdout view');
        assert.ok(result.stderr.length < 1_000, 'evidence mode returns a bounded stderr view');
        assert.ok(result.output);
        assert.ok(result.output.artifact.operationId);
        assert.ok(result.output.artifact.retainedUntil);
        const retentionDeadline = result.output.artifact.retainedUntil;
        assert.equal(result.output.stdout.bytes, payloadBytes + Buffer.byteLength('OUT-BEGIN\n\nOUT-END'));
        assert.equal(result.output.stderr.bytes, payloadBytes + Buffer.byteLength('ERR-BEGIN\n\nERR-END'));
        assert.equal(readToolOutput(result.output, store, {
          channel: 'stdout', offset: result.output.stdout.bytes - 7, length: 7,
        }).text, 'OUT-END');
        assert.equal(readToolOutput(result.output, store, {
          channel: 'stderr', offset: result.output.stderr.bytes - 7, length: 7,
        }).text, 'ERR-END');
        assert.equal(searchToolOutput(result.output, store, { channel: 'stdout', query: 'OUT-BEGIN', maxMatches: 1 })[0]?.text, 'OUT-BEGIN');
        assert.equal(searchToolOutput(result.output, store, { channel: 'stderr', query: 'ERR-BEGIN', maxMatches: 1 })[0]?.text, 'ERR-BEGIN');
        assert.equal(result.output.artifact.retainedUntil, retentionDeadline, 'drilldown does not renew the persisted deadline');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves a UTF-8 code point split across child pipe chunks', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-split-utf8-'));
    try {
      const result = await new NodeProcessRunner().run(process.execPath, ['-e',
        "process.stdout.write(Buffer.from([0xf0,0x9f])); setTimeout(() => process.stdout.write(Buffer.from([0x98,0x80])), 30)"],
      { timeoutMs: 5_000, outputStore: new FileToolOutputStore(directory) });
      assert.equal(result.output?.stdout.bytes, 4);
      assert.equal(readToolOutput(result.output!, new FileToolOutputStore(directory), { channel: 'stdout', offset: 0, length: 1 }).text, '😀');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('closes inherited pipes at a positive deadline without confusing child success and capture completeness', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-inherited-pipe-deadline-'));
    const childHoldingPipe = (holdMs: number, emit = true): string => {
      const descendant = emit
        ? `setTimeout(() => { process.stdout.write('DESCENDANT-EOF-MARKER'); process.stderr.write('DESCENDANT-ERR-MARKER'); }, ${holdMs})`
        : `setTimeout(() => {}, ${holdMs})`;
      return `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); process.stdout.write('PARENT-OUT'); process.stderr.write('PARENT-ERR'); setImmediate(() => process.exit(0));`;
    };
    try {
      for (const mode of ['ordinary', 'captured'] as const) {
        const evidenceRoot = path.join(directory, `${mode}-deadline`);
        const startedAt = Date.now();
        const result = await new NodeProcessRunner().run(process.execPath, ['-e', childHoldingPipe(850, false)], {
          timeoutMs: 250,
          ...(mode === 'captured' ? { outputStore: new FileToolOutputStore(evidenceRoot) } : {}),
        });
        const elapsedMs = Date.now() - startedAt;
        assert.equal(result.exitCode, 0, `${mode}: direct child completed successfully before its descendant released inherited pipes`);
        assert.ok(elapsedMs < 650, `${mode}: unfinished inherited pipes settle near the positive deadline (observed ${elapsedMs}ms)`);
        if (mode === 'captured') {
          assert.equal(result.captureStatus, 'partial', 'forced pipe closure cannot claim complete capture');
          assert.equal(result.captureObservation?.status, 'partial');
          assert.ok(result.captureObservation?.stdout.bytes > 0);
          assert.ok(result.captureObservation?.stdout.preview.includes('PARENT-OUT'));
          assert.ok(result.captureObservation?.stderr.bytes > 0);
          assert.ok(result.captureObservation?.stderr.preview.includes('PARENT-ERR'));
          assert.equal(result.output, undefined, 'a forced incomplete capture cannot publish a complete artifact');
          assert.deepEqual(readdirSync(evidenceRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], 'incomplete durable streams are purged');
        }
      }

      const lateAbortRoot = path.join(directory, 'late-abort-natural-drain');
      const lateAbort = new AbortController();
      const lateAbortPromise = new NodeProcessRunner().run(process.execPath, ['-e', childHoldingPipe(400)], {
        timeoutMs: 2_000, signal: lateAbort.signal, outputStore: new FileToolOutputStore(lateAbortRoot),
      });
      setTimeout(() => lateAbort.abort(), 150);
      const lateAbortResult = await lateAbortPromise;
      assert.equal(lateAbortResult.exitCode, 0);
      assert.equal(lateAbortResult.captureStatus, 'complete', 'late abort does not destroy pipes before their natural EOF');
      assert.equal(lateAbortResult.output?.outcome, 'passed');
      assert.equal(readToolOutput(lateAbortResult.output!, new FileToolOutputStore(lateAbortRoot), {
        channel: 'stdout', offset: 0, length: 128,
      }).text, 'PARENT-OUTDESCENDANT-EOF-MARKER');

      const naturalEofRoot = path.join(directory, 'natural-eof-before-deadline');
      const naturalEof = await new NodeProcessRunner().run(process.execPath, ['-e', childHoldingPipe(150)], {
        timeoutMs: 1_000, outputStore: new FileToolOutputStore(naturalEofRoot),
      });
      assert.equal(naturalEof.exitCode, 0);
      assert.equal(naturalEof.captureStatus, 'complete', 'natural EOF observed before the timer remains complete');
      assert.equal(readToolOutput(naturalEof.output!, new FileToolOutputStore(naturalEofRoot), {
        channel: 'stderr', offset: 0, length: 128,
      }).text, 'PARENT-ERRDESCENDANT-ERR-MARKER');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves signal termination as an unknown child outcome while retaining completed evidence', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-signal-evidence-'));
    try {
      await assert.rejects(
        new NodeProcessRunner().run(process.execPath, ['-e', "process.stdout.write('SIGNAL-TRANSCRIPT'); process.kill(process.pid, 'SIGTERM')"], {
          timeoutMs: 5_000, outputStore: new FileToolOutputStore(directory),
        }),
        (error: unknown) => {
          const value = error as { readonly code?: unknown; readonly signal?: unknown; readonly output?: { readonly outcome?: unknown; readonly exitCode?: unknown; readonly artifact?: unknown } };
          assert.equal(value.code, null);
          assert.equal(value.signal, 'SIGTERM');
          assert.equal(value.output?.outcome, 'unknown');
          assert.equal(value.output?.exitCode, null);
          assert.ok(value.output?.artifact, 'fully written streams may be retained with an unknown process outcome');
          assert.equal(readToolOutput(value.output as never, new FileToolOutputStore(directory), { channel: 'stdout', offset: 0, length: 64 }).text, 'SIGNAL-TRANSCRIPT');
          return true;
        },
      );
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  async function runSinkFailureTerminalCase(terminal: 'timeout' | 'cancel' | 'signal', t: import('node:test').TestContext): Promise<void> {
    const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-${terminal}-partial-observation-`));
    const controller = new AbortController();
    let capturedStderr = '';
    let markerReachedSink = false;
    let sinkFailureObserved = false;
    let sinkFaulted = false;
    let terminalTriggered = false;
    let watchdogFired = false;
    if (terminal === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const policy = { previewBytes: 64, diagnosticBytes: 128, maxDiagnostics: 3, readBytes: 32 } as const;
    const store = new FileToolOutputStore(directory, { testFaults: {
      writeSync: (descriptor, bytes, offset, length) => {
        const remainingBytes = observedMarkerBytes - Buffer.byteLength(capturedStderr, 'utf8');
        if (remainingBytes > 0) capturedStderr += bytes.subarray(offset, offset + Math.min(length, remainingBytes)).toString('utf8');
        if (!sinkFaulted && capturedStderr.includes(observedMarker)) {
          sinkFaulted = true;
          markerReachedSink = true;
          if (terminal === 'timeout') queueMicrotask(() => { terminalTriggered = true; t.mock.timers.tick(200); });
          if (terminal === 'cancel') queueMicrotask(() => { terminalTriggered = true; controller.abort(); });
          sinkFailureObserved = true;
          throw new Error('injected durable sink failure after full marker');
        }
        return writeSync(descriptor, bytes, offset, length);
      },
    } });
    const watchdog = realSetTimeout(() => { watchdogFired = true; controller.abort(); }, 5_000);
    try {
      let rejection: unknown;
      const args = ['-e', fragmentedMarkerScript(terminal === 'signal' ? 'signal' : 'hang')];
      try {
        await new NodeProcessRunner().run(process.execPath, args, {
          timeoutMs: terminal === 'timeout' ? 200 : 0,
          signal: controller.signal,
          outputStore: store,
          outputPolicy: policy,
        });
      } catch (error) { rejection = error; }
      assert.ok(markerReachedSink, 'the complete fragmented marker reached the real file writer before the terminal transition');
      assert.ok(sinkFailureObserved, 'the actual file-backed writer faulted after observing the complete marker');
      if (terminal !== 'signal') assert.ok(terminalTriggered, 'the actual terminal transition followed observed sink containment');
      assert.equal(watchdogFired, false, 'the real watchdog did not supply the expected terminal result');
      assert.ok(rejection, `the actual ${terminal} path rejects`);
      assertPartialCapture(rejection, terminal, policy);
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], 'no raw artifacts remain after the contained failure');
    } finally {
      controller.abort();
      realClearTimeout(watchdog);
      if (terminal === 'timeout') t.mock.timers.reset();
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('retains partial marker observations on the actual timeout after durable sink failure', async (t) => {
    await runSinkFailureTerminalCase('timeout', t);
  });

  it('retains partial marker observations on cancellation after durable sink failure', async (t) => {
    await runSinkFailureTerminalCase('cancel', t);
  });

  it('retains partial marker observations on SIGTERM after durable sink failure', async (t) => {
    await runSinkFailureTerminalCase('signal', t);
  });

  it('observes aborts that occur synchronously inside beforeSpawn', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-before-spawn-abort-'));
    const marker = path.join(directory, 'launched');
    const controller = new AbortController();
    try {
      await assert.rejects(
        new NodeProcessRunner().run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`], {
          timeoutMs: 5_000,
          signal: controller.signal,
          outputStore: new FileToolOutputStore(path.join(directory, 'evidence')),
          beforeSpawn: () => controller.abort(),
        }),
        (error: unknown) => (error as { readonly code?: unknown }).code === 'ABORT_ERR',
      );
      assert.equal(existsSync(marker), false, 'the newly aborted command is killed before it can perform work');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('purges pre-spawn aborted captures and failed-spawn preparations while preserving process errors', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-prepared-capture-purge-'));
    try {
      const store = new FileToolOutputStore(directory);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(new NodeProcessRunner().run(process.execPath, ['-e', 'process.exit(0)'], {
        timeoutMs: 1_000, signal: controller.signal, outputStore: store,
      }), (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown } };
        assert.equal(value.code, 'ABORT_ERR');
        assert.equal(value.captureStatus, 'partial', 'the admitted child was aborted after its successful spawn event');
        assert.equal(value.captureObservation?.status, 'partial');
        return true;
      });
      await assert.rejects(new NodeProcessRunner().run(path.join(directory, 'missing-executable'), [], {
        timeoutMs: 1_000, outputStore: store,
      }), (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly captureStatus?: unknown; readonly captureObservation?: { readonly status?: unknown } };
        assert.equal(value.code, 'ENOENT');
        assert.equal(value.captureStatus, 'unavailable');
        assert.equal(value.captureObservation?.status, 'unavailable');
        return true;
      });
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('contains actual file-backed start, second-open, mid-write, short-write, finish, hash, file/root fsync and cleanup faults', async () => {
    for (const fault of ['start', 'second-open', 'mid-write', 'short-write', 'finish', 'hash', 'fsync', 'root-fsync', 'cleanup'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-capture-fault-'));
      try {
        let writes = 0;
        let cleanupFaulted = false;
        const store = new FileToolOutputStore(directory, { testFaults: {
          beforeCaptureStart: () => { if (fault === 'start') throw new Error('injected start fault'); },
          beforeSecondOpen: () => { if (fault === 'second-open') throw new Error('injected second-open fault'); },
          writeSync: (fd, bytes, offset, length) => {
            writes += 1;
            if (fault === 'mid-write' && writes === 1) {
              writeSync(fd, bytes, offset, Math.max(1, Math.floor(length / 2)));
              throw new Error('injected mid-write fault');
            }
            if (fault === 'short-write') {
              if (writes === 1) return writeSync(fd, bytes, offset, Math.max(1, Math.floor(length / 2)));
              return 0;
            }
            return writeSync(fd, bytes, offset, length);
          },
          beforeFinish: () => { if (fault === 'finish') throw new Error('injected finish fault'); },
          beforeHash: () => { if (fault === 'hash') throw new Error('injected hash fault'); },
          beforeFsync: () => { if (fault === 'fsync') throw new Error('injected fsync fault'); },
          beforeArtifactRootFsync: (phase) => { if (fault === 'root-fsync' && phase === 'finish') throw new Error('injected artifact root fsync fault'); },
          beforeUnlink: () => {
            if (fault === 'cleanup' && !cleanupFaulted) { cleanupFaulted = true; throw new Error('injected cleanup fault'); }
          },
        } });
        // Cleanup mode also needs a finish fault so that disposal runs after capture setup.
        const faultingStore = fault === 'cleanup' ? {
          save: store.save.bind(store), read: store.read.bind(store), search: store.search.bind(store),
          beginOperation: store.beginOperation.bind(store),
          startCapture(policy: Parameters<typeof store.startCapture>[0]) {
            const writer = store.startCapture(policy);
            return { write: writer.write.bind(writer), finish: () => { throw new Error('injected finish before cleanup'); }, abort: writer.abort?.bind(writer) };
          },
        } : store;
        const result = await new NodeProcessRunner().run(process.execPath, ['-e',
          "process.stdout.write('ERROR: CAPTURE-SENTINEL\\n'); process.stderr.write('FAIL test-capture-fault\\n'); process.exit(7)"],
        { timeoutMs: 5_000, outputStore: faultingStore,
          outputPolicy: { previewBytes: 64, diagnosticBytes: 256, maxDiagnostics: 4, readBytes: 64 } });
        assert.equal(result.exitCode, 7, fault + ': sink faults do not change the actual child exit');
        assert.equal(result.output, undefined, fault + ': failed sink cannot publish an artifact reference');
        assert.ok(result.stdout.includes('CAPTURE-SENTINEL'), fault + ': bounded view survives sink fault');
        assert.equal(result.captureStatus, fault === 'start' || fault === 'second-open' ? 'unavailable' : 'partial');
        assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], fault + ': no raw capture remains after contained cleanup');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
});
