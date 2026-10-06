import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { FileToolOutputStore, InMemoryToolOutputStore, searchToolOutput } from '../src/evidence/tool-output.js';
import { NodeProcessRunner } from '../src/github/transport.js';

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

  it('keeps bounded timeout evidence available to the caller', async () => {
    const store = new InMemoryToolOutputStore();
    await assert.rejects(
      new NodeProcessRunner().run(
        process.execPath,
        ['-e', "process.stderr.write('ERROR: timeout evidence\\n'); setTimeout(() => {}, 1000)"],
        { timeoutMs: 200, outputStore: store },
      ),
      (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly output?: { readonly outcome?: unknown; readonly diagnostics?: readonly string[] } };
        assert.equal(value.code, 'ETIMEDOUT');
        assert.equal(value.output?.outcome, 'timed_out');
        assert.ok(value.output?.diagnostics?.some((line) => line.includes('timeout evidence')));
        return true;
      },
    );
  });

  it('preserves explicit overflow evidence when execFile reaches its safety cap', async () => {
    const store = new InMemoryToolOutputStore();
    await assert.rejects(
      new NodeProcessRunner().run(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(17 * 1024 * 1024))"],
        { timeoutMs: 10_000, outputStore: store },
      ),
      (error: unknown) => {
        const value = error as { readonly code?: unknown; readonly output?: { readonly overflow?: { readonly capture?: boolean }; readonly artifact?: { readonly totalBytes?: number } } };
        assert.equal(value.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
        assert.equal(value.output?.overflow?.capture, true);
        assert.ok((value.output?.artifact?.totalBytes ?? 0) > 0);
        return true;
      },
    );
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
});
