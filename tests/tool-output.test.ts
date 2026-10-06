import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOOL_OUTPUT_POLICY,
  FileToolOutputStore,
  InMemoryToolOutputStore,
  boundToolOutput,
  readToolOutput,
  searchToolOutput,
  type ToolOutputPolicy,
} from '../src/evidence/tool-output.js';
import { attachToolOutputTelemetry, providerTelemetry } from '../src/agents/provider-telemetry.js';

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
    assert.ok(output.artifact.stdoutBytes > output.stdout.previewBytes);
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
      channel: 'stderr', offset: 0, length: output.artifact.stderrBytes,
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

  it('projects artifact size into the existing largest-payload pilot telemetry without retaining content', () => {
    const output = boundToolOutput({
      outcome: 'failed', exitCode: 9, stdout: 'x'.repeat(100), stderr: '', store: new InMemoryToolOutputStore(),
    });
    const telemetry = attachToolOutputTelemetry(providerTelemetry({ provider: 'test', largestToolResultBytes: 12 }), output);
    assert.equal(telemetry.largestToolResultBytes, output.artifact.totalBytes);
  });
});

describe('UTF-8 tool output ranges', () => {
  for (const kind of ['memory', 'file'] as const) {
    function withStore(run: (store: InMemoryToolOutputStore | FileToolOutputStore) => void): void {
      if (kind === 'memory') {
        run(new InMemoryToolOutputStore());
        return;
      }
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-utf8-range-'));
      try {
        run(new FileToolOutputStore(directory));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    it(`${kind}: reconstructs valid UTF-8 with small byte budgets on both channels`, () => {
      withStore((store) => {
        const texts = ['', 'ASCII\r\nend', '中文日本語', '🙂🚀', 'e\u0301か\u3099', 'A中🙂e\u0301B', '👩‍💻尾'];
        for (const text of texts) {
          const artifact = store.save({ stdout: text, stderr: text });
          for (const channel of ['stdout', 'stderr'] as const) {
            for (const length of [1, 2, 3, 4, 5, 7, 16]) {
              let offset = 0;
              let reconstructed = '';
              let reads = 0;
              for (;;) {
                assert.ok(++reads <= Array.from(text).length + 1, 'range reads must make progress');
                const result = store.read(artifact, { channel, offset, length });
                assert.equal(result.channel, channel);
                assert.equal(result.offset, offset);
                assert.equal(result.bytes, Buffer.byteLength(result.text, 'utf8'));
                assert.equal(result.nextOffset, offset + result.bytes);
                assert.equal(result.eof, result.nextOffset === Buffer.byteLength(text, 'utf8'));
                assert.ok(result.bytes <= Math.max(length, 4));
                assert.equal(result.text.includes('\ufffd'), false);
                reconstructed += result.text;
                if (result.eof) break;
                assert.ok(result.nextOffset > offset);
                offset = result.nextOffset;
              }
              assert.equal(reconstructed, text);
              assert.deepEqual(Buffer.from(reconstructed), Buffer.from(text));
            }
          }
        }
      });
    });

    it(`${kind}: reports actual aligned offsets and complete characters near boundaries and EOF`, () => {
      withStore((store) => {
        const artifact = store.save({ stdout: 'A中🙂e\u0301B', stderr: '' });
        const cases = [
          { offset: 0, length: 2, actual: 0, text: 'A', next: 1 },
          { offset: 1, length: 1, actual: 1, text: '中', next: 4 },
          { offset: 2, length: 1, actual: 1, text: '中', next: 4 },
          { offset: 3, length: 4, actual: 1, text: '中', next: 4 },
          { offset: 4, length: 3, actual: 4, text: '🙂', next: 8 },
          { offset: 5, length: 1, actual: 4, text: '🙂', next: 8 },
          { offset: 6, length: 1, actual: 4, text: '🙂', next: 8 },
          { offset: 7, length: 1, actual: 4, text: '🙂', next: 8 },
          { offset: 8, length: 2, actual: 8, text: 'e', next: 9 },
          { offset: 9, length: 1, actual: 9, text: '\u0301', next: 11 },
          { offset: 10, length: 1, actual: 9, text: '\u0301', next: 11 },
          { offset: 11, length: 1, actual: 11, text: 'B', next: 12 },
          { offset: 12, length: 1, actual: 12, text: '', next: 12 },
          { offset: 5, length: Number.MAX_SAFE_INTEGER, actual: 4, text: '🙂e\u0301B', next: 12 },
        ];
        for (const test of cases) {
          assert.deepEqual(store.read(artifact, { channel: 'stdout', offset: test.offset, length: test.length }), {
            channel: 'stdout', offset: test.actual, text: test.text,
            bytes: test.next - test.actual, nextOffset: test.next, eof: test.next === 12,
          });
        }
      });
    });

    if (kind === 'file') {
      it('file: reads UTF-8 ranges from persisted files without using the memory fallback', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-utf8-file-source-'));
        try {
          const store = new FileToolOutputStore(directory);
          const artifact = store.save({ stdout: 'A中🙂B', stderr: '' });
          const persisted = readdirSync(directory);
          assert.equal(persisted.length, 2);
          assert.ok(persisted.some((name) => readFileSync(path.join(directory, name), 'utf8') === 'A中🙂B'));
          const fallback = (store as unknown as { readonly fallback: InMemoryToolOutputStore }).fallback;
          fallback.read = () => { throw new Error('memory fallback was used'); };
          assert.deepEqual(store.read(artifact, { channel: 'stdout', offset: 2, length: 1 }), {
            channel: 'stdout', offset: 1, text: '中', bytes: 3, nextOffset: 4, eof: false,
          });
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }

    it(`${kind}: preserves ASCII, empty output, default reads and invalid-request refusals`, () => {
      withStore((store) => {
        const artifact = store.save({ stdout: 'abc', stderr: '' });
        assert.deepEqual(store.read(artifact, { channel: 'stdout', offset: 1, length: 1 }), {
          channel: 'stdout', offset: 1, text: 'b', bytes: 1, nextOffset: 2, eof: false,
        });
        assert.deepEqual(store.read(artifact, { channel: 'stderr' }), {
          channel: 'stderr', offset: 0, text: '', bytes: 0, nextOffset: 0, eof: true,
        });
        assert.equal(store.read(artifact, { channel: 'stdout' }).text, 'abc');
        assert.equal(store.read(artifact, { channel: 'stdout', offset: 3 }).eof, true);
        assert.throws(() => store.read(artifact, { channel: 'stdout', offset: -1 }), /offset/);
        assert.throws(() => store.read(artifact, { channel: 'stdout', offset: 4 }), /offset/);
        assert.throws(() => store.read(artifact, { channel: 'stdout', length: 0 }), /positive safe integer/);
        const envelope = boundToolOutput({
          outcome: 'passed', exitCode: 0, stdout: '中🙂', stderr: '', store,
          policy: { ...policy, readBytes: 1 },
        });
        const first = readToolOutput(envelope, store, { channel: 'stdout' });
        assert.equal(first.text, '中');
        assert.equal(first.nextOffset, 3);
        assert.equal(readToolOutput(envelope, store, { channel: 'stdout', offset: first.nextOffset }).text, '🙂');
      });
    });
  }
});
