import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOOL_OUTPUT_POLICY,
  InMemoryToolOutputStore,
  boundToolOutput,
  boundToolOutputFromCapture,
  captureToolOutput,
  isToolOutputEnvelope,
  readToolOutput,
  searchToolOutput,
  type ToolOutputPolicy,
  type ToolOutputStore,
} from '../src/evidence/tool-output.js';


const policy: ToolOutputPolicy = {
  previewBytes: 32,
  diagnosticBytes: 96,
  maxDiagnostics: 4,
  readBytes: 64,
};

describe('bounded tool output contract', () => {
  it('bounds successful huge output without changing the success exit semantics', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({
      outcome: 'passed',
      exitCode: 0,
      stdout: `${'normal line\n'.repeat(100)}done\n`,
      stderr: '',
      store,
      policy,
      summary: 'command completed',
    });

    assert.equal(output.outcome, 'passed');
    assert.equal(output.exitCode, 0);
    assert.equal(output.overflow.truncated, true);
    assert.equal(output.stdout.truncated, true);
    assert.equal(output.stdout.preview.includes('done'), true);
    assert.ok(output.stdout.preview.length <= policy.previewBytes + 3);
    assert.ok(output.artifact!.stdoutBytes > output.stdout.previewBytes);
  });

  it('keeps actionable failure diagnostics and an artifact reference for full evidence', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({
      outcome: 'failed',
      exitCode: 23,
      stdout: 'before\n'.repeat(100),
      stderr: `${'noise\n'.repeat(30)}ERROR: assertion failed for exact HEAD\n`,
      store,
      policy,
    });

    assert.equal(output.outcome, 'failed');
    assert.equal(output.exitCode, 23);
    assert.equal(output.overflow.truncated, true);
    assert.ok(output.diagnostics.some((line) => line.includes('assertion failed')));

    const full = readToolOutput(output, store, {
      channel: 'stderr', offset: 0, length: output.artifact!.stderrBytes,
    });
    assert.equal(full.text.includes('ERROR: assertion failed for exact HEAD'), true);
    assert.equal(full.eof, true);
  });

  it('supports explicit range drill-down and bounded diagnostic search', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({
      outcome: 'unknown',
      exitCode: null,
      stdout: 'line-0\nline-1\nneedle: exact failure\nline-3\n',
      stderr: '',
      store,
      policy,
    });

    const range = readToolOutput(output, store, { channel: 'stdout', offset: 7, length: 7 });
    assert.equal(range.text, 'line-1\n');
    assert.equal(range.offset, 7);
    assert.equal(range.eof, false);

    const matches = searchToolOutput(output, store, { channel: 'stdout', query: 'needle', maxMatches: 2 });
    assert.deepEqual(matches.map((match) => match.text), ['needle: exact failure']);
    assert.equal(matches[0]?.line, 3);
  });

  it('bounds search matches even when a matching line is enormous', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({
      outcome: 'failed', exitCode: 1, stdout: `${'x'.repeat(500_000)}needle\n`, stderr: '', store,
    });

    const matches = searchToolOutput(output, store, { channel: 'stdout', query: 'needle', maxBytes: 64 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.text.includes('needle'), true);
    assert.equal(matches[0]?.truncated, true);
    assert.ok(Buffer.byteLength(matches[0]?.text ?? '', 'utf8') <= 64);
  });

  it('keeps one-character search state bounded on an enormous matching line', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({
      outcome: 'failed', exitCode: 1, stdout: `${'x'.repeat(500_000)}\n`, stderr: '', store,
    });

    const matches = searchToolOutput(output, store, { channel: 'stdout', query: 'x', maxBytes: 64 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.text.includes('x'), true);
    assert.equal(matches[0]?.truncated, true);
    assert.ok(Buffer.byteLength(matches[0]?.text ?? '', 'utf8') <= 64);
  });

  it('uses bounded defaults while allowing an explicit larger task budget', () => {
    const store = new InMemoryToolOutputStore();
    const text = 'x'.repeat(DEFAULT_TOOL_OUTPUT_POLICY.previewBytes + 1);
    const bounded = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: text, stderr: '', store });
    const expanded = boundToolOutput({
      outcome: 'passed', exitCode: 0, stdout: text, stderr: '', store,
      policy: { ...DEFAULT_TOOL_OUTPUT_POLICY, previewBytes: text.length + 1, readBytes: text.length + 1 },
    });

    assert.equal(bounded.overflow.truncated, true);
    assert.equal(expanded.overflow.truncated, false);
    assert.equal(expanded.exitCode, 0);
    assert.equal(readToolOutput(expanded, store, { channel: 'stdout' }).bytes, text.length);
  });

  it('keeps the first actionable failure when later diagnostics overflow', () => {
    const output = boundToolOutput({ outcome: 'failed', exitCode: 1, stdout: '',
      stderr: 'ERROR: root cause\n' + 'ERROR: cascading failure\n'.repeat(50),
      store: new InMemoryToolOutputStore(), policy });
    assert.match(output.diagnostics[0]!, /root cause/);
    assert.equal(output.overflow.diagnostics, true);
  });

  it('keeps the start of an oversized diagnostic line across chunk boundaries', () => {
    const capture = captureToolOutput(new InMemoryToolOutputStore(), policy);
    capture.write('stderr', 'ERROR: root cause ');
    for (let i = 0; i < 40; i++) capture.write('stderr', 'noise'.repeat(30));
    capture.write('stderr', '\n');
    const output = boundToolOutputFromCapture({ outcome: 'failed', exitCode: 1, capture: capture.finish(), policy });
    assert.match(output.diagnostics[0]!, /root cause/);
    assert.equal(output.overflow.diagnostics, true);
    assert.equal(output.overflow.capture, false);
    assert.equal(isToolOutputEnvelope(output), true);
  });

  it('reconstructs multibyte text through one-byte range requests', () => {
    const text = 'α中🙂é\n';
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: text, stderr: '', store });
    let restored = ''; let offset = 0;
    while (offset < output.artifact!.stdoutBytes) {
      const result = readToolOutput(output, store, { channel: 'stdout', offset, length: 1 });
      assert.equal(result.offset, offset);
      assert.ok(result.nextOffset > offset);
      assert.ok(result.bytes <= 7);
      restored += result.text; offset = result.nextOffset;
    }
    assert.equal(restored, text);
    const middle = readToolOutput(output, store, { channel: 'stdout', offset: 1, length: 1 });
    assert.deepEqual({ offset: middle.offset, text: middle.text }, { offset: 0, text: 'α' });
  });

  it('supports explicit artifact retention and fails clearly after deletion', () => {
    const store = new InMemoryToolOutputStore();
    const output = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'retained', stderr: '', store });
    store.delete(output.artifact!);
    assert.throws(() => readToolOutput(output, store, { channel: 'stdout' }), /unavailable/);
    store.delete(output.artifact!);
  });

  for (const failure of ['start', 'write', 'finish'] as const) {
    it(`preserves status and bounded diagnostics when evidence ${failure} fails`, () => {
      let aborted = false;
      const unavailable = (): never => { throw new Error('fixture storage unavailable'); };
      const store: ToolOutputStore = {
        save: unavailable, read: unavailable, search: unavailable, delete() {},
        startCapture() {
          if (failure === 'start') return unavailable();
          return {
            write() { if (failure === 'write') unavailable(); },
            finish: unavailable,
            abort() { aborted = true; },
          };
        },
      };
      const output = boundToolOutput({ outcome: 'failed', exitCode: 23,
        stdout: 'x'.repeat(10_000), stderr: 'ERROR: real command failure', store, policy });
      assert.equal(output.outcome, 'failed');
      assert.equal(output.exitCode, 23);
      assert.equal(output.artifact, null);
      assert.equal(output.overflow.capture, true);
      assert.ok(output.diagnostics.some((line) => line.includes('real command failure')));
      assert.ok(Buffer.byteLength(output.stdout.preview) <= policy.previewBytes);
      assert.equal(isToolOutputEnvelope(output), true);
      assert.equal(aborted, failure !== 'start');
      assert.throws(() => readToolOutput(output, store, { channel: 'stdout' }), /unavailable/);
    });
  }

  it('rejects forged in-memory identity for both search and range reads', () => {
    const store = new InMemoryToolOutputStore();
    const artifact = store.save({ stdout: 'needle', stderr: '' });
    for (const forged of [{ ...artifact, sha256: '0'.repeat(64) }, { ...artifact, totalBytes: artifact.totalBytes + 1 }]) {
      assert.throws(() => store.read(forged, { channel: 'stdout' }), /identity mismatch/);
      assert.throws(() => store.search(forged, { query: 'needle' }), /identity mismatch/);
    }
  });

});
