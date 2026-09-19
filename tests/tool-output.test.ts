import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOOL_OUTPUT_POLICY,
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
