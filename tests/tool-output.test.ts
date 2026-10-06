import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  it('retains the first root cause and later failed-test identities within the diagnostic budget', () => {
    const output = boundToolOutput({
      outcome: 'failed', exitCode: 1,
      stdout: '',
      stderr: ['ERROR: ROOT-CAUSE-9f3a', ...Array.from({ length: 30 }, (_, index) => `FAIL test-${index}`)].join('\n'),
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 8, diagnosticBytes: 96, maxDiagnostics: 4, readBytes: 16 },
    });
    assert.ok(output.diagnostics[0]?.includes('ROOT-CAUSE-9f3a'));
    assert.ok(output.diagnostics.some((line) => line.includes('FAIL test-29')));
    assert.ok(Buffer.byteLength(output.diagnostics.join(''), 'utf8') <= 96);
    assert.equal(output.stdout.previewBytes <= 8, true);
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
      it('file: rejects forged artifact byte counts, hashes, operation IDs and deadlines', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-forged-output-ref-'));
        try {
          const store = new FileToolOutputStore(directory);
          const artifact = store.save({ stdout: 'persisted', stderr: 'proof' });
          for (const forged of [
            { ...artifact, stdoutBytes: artifact.stdoutBytes + 1 },
            { ...artifact, sha256: '0'.repeat(64) },
            { ...artifact, retainedUntil: new Date(Date.parse(artifact.retainedUntil!) + 86_400_000).toISOString() },
            { ...artifact, operationId: '00000000-0000-4000-8000-000000000000' },
          ]) {
            assert.throws(() => store.read(forged, { channel: 'stdout' }), /unavailable or expired/);
            assert.throws(() => store.search(forged, { query: 'proof' }), /unavailable or expired/);
          }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: refuses root and operations-directory symlinks before creating private state', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-symlink-'));
        try {
          const target = path.join(directory, 'target');
          const rootAlias = path.join(directory, 'root-alias');
          mkdirSync(target);
          symlinkSync(target, rootAlias, 'dir');
          assert.throws(() => new FileToolOutputStore(rootAlias), /symlink/);

          const safeRoot = path.join(directory, 'safe-root');
          const store = new FileToolOutputStore(safeRoot);
          mkdirSync(safeRoot);
          const operationsTarget = path.join(directory, 'operations-target');
          mkdirSync(operationsTarget);
          symlinkSync(operationsTarget, path.join(safeRoot, 'operations'), 'dir');
          assert.throws(() => store.beginOperation({ kind: 'symlink-test' }), /symlink/);
          assert.deepEqual(readdirSync(operationsTarget), [], 'refusal creates no operation metadata under the symlink target');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: persists finite per-operation retention and releases only the selected operation early', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-'));
        try {
          const now = new Date();
          const short = new FileToolOutputStore(directory, { capacity: 2, retentionMs: 60 * 60 * 1000, now: () => now });
          const first = short.save({ stdout: 'release-me', stderr: '' });
          const second = short.save({ stdout: 'keep-me', stderr: '' });
          const persistedDeadline = first.retainedUntil;
          const storedOperation = JSON.parse(readFileSync(path.join(directory, 'operations', `${first.operationId}.json`), 'utf8')) as { readonly retainedUntil?: string };
          assert.equal(storedOperation.retainedUntil, persistedDeadline, 'the configured finite deadline is persisted in the operation record');
          const reopened = new FileToolOutputStore(directory, { capacity: 2, retentionMs: 90 * 24 * 60 * 60 * 1000 });
          assert.equal(first.retainedUntil, persistedDeadline, 'reopening with a longer policy does not renew the existing reference');
          assert.equal(reopened.read(first, { channel: 'stdout' }).text, 'release-me');
          reopened.release(first);
          assert.throws(() => reopened.read(first, { channel: 'stdout' }), /unavailable or expired/);
          assert.throws(() => reopened.search(first, { query: 'release' }), /unavailable or expired/);
          const cleanup = reopened.cleanupExpired({ maxSlotProbes: 2, maxDeletions: 16 });
          assert.ok(cleanup.attempted <= 16);
          assert.equal(reopened.read(second, { channel: 'stdout' }).text, 'keep-me', 'release leaves another operation available');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: expires reads and searches against the store clock rather than wall clock', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-injected-expiry-'));
        try {
          let now = new Date('2030-01-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { retentionMs: 1_000, now: () => now });
          const artifact = store.save({ stdout: 'clock-controlled', stderr: '' });
          const wallClockBeforeExpiry = Date.now();
          assert.ok(wallClockBeforeExpiry < Date.parse(artifact.retainedUntil!));
          now = new Date(Date.parse(artifact.retainedUntil!) + 1);
          assert.throws(() => store.read(artifact, { channel: 'stdout' }), /expired/);
          assert.throws(() => store.search(artifact, { query: 'clock' }), /expired/);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: releases failed save/startCapture setup and permits same-process reuse', () => {
        for (const surface of ['save', 'startCapture'] as const) {
          for (const fault of ['start', 'second-open'] as const) {
            const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-start-failure-'));
            try {
              let injected = false;
              const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
                beforeCaptureStart: () => {
                  if (fault === 'start' && !injected) { injected = true; throw new Error('original start fault'); }
                },
                beforeSecondOpen: () => {
                  if (fault === 'second-open' && !injected) { injected = true; throw new Error('original second-open fault'); }
                },
              } });
              const expected = fault === 'start' ? /original start fault/ : /original second-open fault/;
              if (surface === 'save') assert.throws(() => store.save({ stdout: 'never persisted', stderr: '' }), expected);
              else assert.throws(() => store.startCapture(DEFAULT_TOOL_OUTPUT_POLICY), expected);

              const operations = path.join(directory, 'operations');
              assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], `${surface}/${fault}: no stream files remain`);
              assert.deepEqual(readdirSync(operations).filter((name) => name.endsWith('.lock')), [], `${surface}/${fault}: operation and maintenance locks were released`);

              const recovered = store.save({ stdout: `${surface}-${fault}-recovered`, stderr: '' });
              assert.equal(store.read(recovered, { channel: 'stdout' }).text, `${surface}-${fault}-recovered`, `${surface}/${fault}: same process can reuse the capacity-one store`);
            } finally { rmSync(directory, { recursive: true, force: true }); }
          }
        }
      });

      it('file: bounds registration probes and advances the persisted cursor past protected slots', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-registration-budget-'));
        try {
          const store = new FileToolOutputStore(directory, { capacity: 4, maxRegistrationProbes: 1 });
          store.cleanupExpired({ maxSlotProbes: 1 });
          const operations = path.join(directory, 'operations');
          writeFileSync(path.join(operations, 'slot-0001.json'), 'corrupt protected identity');
          assert.throws(() => store.beginOperation({ kind: 'bounded-registration' }), /registration probe budget was exhausted/);
          const next = store.beginOperation({ kind: 'bounded-registration-after-protected' });
          assert.equal(next.id.length, 36, 'the durable registration cursor reaches a later free slot');
          next.abort();
          assert.equal(readFileSync(path.join(operations, 'slot-0001.json'), 'utf8'), 'corrupt protected identity');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: persists cleanup traversal progress across fresh processes and protected slots', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-cleanup-cursor-'));
        try {
          const now = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 5, now: () => now });
          const protectedOperation = store.beginOperation({ kind: 'protected-test' });
          const refs = [];
          for (let index = 0; index < 4; index += 1) refs.push(store.save({ stdout: 'expired-' + index, stderr: '' }));
          const visits = [];
          writeFileSync(path.join(directory, 'operations', 'index.json'), JSON.stringify({ schemaVersion: 1, capacity: 5, cursor: 0 }));
          writeFileSync(path.join(directory, 'operations', 'slot-0001.json'), 'corrupt protected slot');
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 5 }); console.log(JSON.stringify(store.cleanupExpired({ maxSlotProbes: 1 })));`;
          for (let batch = 0; batch < 5; batch += 1) {
            const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
              cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            });
            visits.push(JSON.parse(output.trim()) as { readonly cursor: number; readonly protected: number });
          }
          assert.deepEqual(visits.map((visit) => visit.cursor), [1, 2, 3, 4, 0]);
          assert.equal(visits[0]!.protected, 1, 'live owner remains protected in a separate process');
          assert.equal(visits[1]!.protected, 1, 'corrupt slot remains protected and traversal advances');
          assert.equal(existsSync(path.join(directory, refs[3]!.id + '.stdout')), false, 'later expired identity is reclaimed after protected slots');
          protectedOperation.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reclaims a finished capture left by a dead validation-operation owner before close', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dead-output-owner-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'dead-owner-test' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'finished-before-close'); const summary = writer.finish(); console.log(summary.artifact.id); process.exit(0);`;
          const artifactId = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          assert.match(artifactId, /^[0-9a-f-]{36}$/);
          assert.ok(existsSync(path.join(directory, artifactId + '.stdout')));
          const result = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1 });
          assert.equal(result.deleted, 4, 'two stream files, metadata and operation slot are reclaimed');
          assert.equal(existsSync(path.join(directory, artifactId + '.stdout')), false);
          assert.equal(existsSync(path.join(directory, 'operations', 'slot-0000.json')), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: protects dead-owner files when the persisted owner nonce disagrees with the stale lock', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-owner-mismatch-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'owner-mismatch-test' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'must-remain-protected'); const summary = writer.finish(); console.log(JSON.stringify({ operationId: operation.id, artifactId: summary.artifact.id })); process.exit(0);`;
          const owner = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly operationId: string; readonly artifactId: string };
          const metadataPath = path.join(directory, 'operations', `${owner.operationId}.json`);
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
          writeFileSync(metadataPath, JSON.stringify({ ...metadata, ownerNonce: 'mismatched-owner-nonce' }));
          const cleanup = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1 });
          assert.equal(cleanup.deleted, 0, 'a stale lock cannot authorize cleanup for a different persisted owner identity');
          assert.equal(cleanup.protected, 1);
          assert.ok(existsSync(path.join(directory, `${owner.artifactId}.stdout`)));
          assert.ok(existsSync(path.join(directory, 'operations', 'slot-0000.json')));
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: resumes a durable deletion tombstone after a simulated cleanup interruption', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-cleanup-resume-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => old });
          const artifact = store.save({ stdout: 'stdout-to-remove', stderr: 'stderr-to-remove' });
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, artifact.operationId + '.json');
          unlinkSync(metadataPath);
          writeFileSync(path.join(operations, 'slot-0000.json'), JSON.stringify({
            schemaVersion: 1, capacity: 1, slot: 0, id: artifact.operationId,
            deleting: true, artifactIds: [artifact.id],
          }));
          unlinkSync(path.join(directory, artifact.id + '.stdout'));
          const cleanup = new FileToolOutputStore(directory, { capacity: 1 });
          const result = cleanup.cleanupExpired({ maxSlotProbes: 1 });
          assert.equal(result.deleted, 2, 'already removed stdout is idempotently absent; stderr and the known-owned slot are deleted');
          assert.equal(existsSync(path.join(directory, artifact.id + '.stdout')), false);
          assert.equal(existsSync(path.join(directory, artifact.id + '.stderr')), false);
          assert.equal(existsSync(path.join(operations, 'slot-0000.json')), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reports bounded cleanup attempts and refuses an exhausted metadata-read budget', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-cleanup-budget-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => old });
          const artifact = store.save({ stdout: 'budgeted', stderr: '' });
          const pass = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 1 });
          assert.ok(pass.attempted <= 1);
          assert.ok(existsSync(path.join(directory, artifact.id + '.stdout')), 'strict deletion budget leaves the owned artifact for a later pass');
          assert.throws(() => new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 1 }), /metadata-read budget exhausted/);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reclaims a large expired operation over bounded deletion batches', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-cleanup-batches-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => old });
          const operation = store.beginOperation({ kind: 'bounded-deletion-test' });
          const ids: string[] = [];
          for (let index = 0; index < 40; index += 1) {
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY, { commandIndex: index });
            writer.write('stdout', 'payload-' + index);
            ids.push(writer.finish().artifact.id);
          }
          operation.close();
          let passes = 0;
          let deleted = 0;
          while (existsSync(path.join(directory, 'operations', 'slot-0000.json')) && passes < 16) {
            const result = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 10 });
            passes += 1; deleted += result.deleted;
          }
          assert.equal(passes, 10, 'the bounded cursor revisits the retained tombstone until every artifact is reclaimed');
          assert.equal(deleted, 82, '80 stream files, operation metadata and stable slot are bounded physical deletions');
          for (const id of ids) {
            assert.equal(existsSync(path.join(directory, id + '.stdout')), false);
            assert.equal(existsSync(path.join(directory, id + '.stderr')), false);
          }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reads UTF-8 ranges from persisted files without using the memory fallback', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-utf8-file-source-'));
        try {
          const store = new FileToolOutputStore(directory);
          const artifact = store.save({ stdout: 'A中🙂B', stderr: '' });
          const persisted = readdirSync(directory);
          assert.ok(persisted.includes(`${artifact.id}.stdout`));
          assert.ok(persisted.includes(`${artifact.id}.stderr`));
          assert.ok(persisted.some((name) => readFileSync(path.join(directory, name), 'utf8') === 'A中🙂B'));
          assert.equal(Object.hasOwn(store, 'fallback'), false, 'file store does not keep a memory fallback');
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
