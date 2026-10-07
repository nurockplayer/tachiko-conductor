import assert from 'node:assert/strict';
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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

describe('file-backed artifact point-of-use safety', () => {
  it('rejects a same-length symlink swap at the hash-open boundary', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-hash-symlink-race-'));
    const target = path.join(directory, 'same-length-target');
    writeFileSync(target, 'evil');
    const store = new FileToolOutputStore(directory, { testFaults: {
      beforeHash: () => {
        const stdoutPath = path.join(directory, readdirSync(directory).find((name) => name.endsWith('.stdout'))!);
        unlinkSync(stdoutPath);
        symlinkSync(target, stdoutPath);
      },
    } });
    try {
      assert.throws(() => store.save({ stdout: 'safe', stderr: '' }), /symlink|artifact|file|open/i);
      assert.equal(readFileSync(target, 'utf8'), 'evil', 'the race target is never modified or adopted');
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), [], 'failed hash admission purges the replaced capture path');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects symlink and same-size inode substitutions at each read and search open', () => {
    for (const kind of ['read', 'search'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-${kind}-symlink-race-`));
      const target = path.join(directory, 'same-length-target');
      writeFileSync(target, 'evil');
      let artifactId = '';
      let mutated = false;
      const store = new FileToolOutputStore(directory, { testFaults: {
        beforeArtifactOpen: (at, channel) => {
          if (at !== kind || channel !== 'stdout' || mutated) return;
          mutated = true;
          const artifactPath = path.join(directory, `${artifactId}.stdout`);
          unlinkSync(artifactPath);
          symlinkSync(target, artifactPath);
        },
      } });
      try {
        const artifact = store.save({ stdout: 'safe', stderr: '' });
        artifactId = artifact.id;
        assert.throws(() => kind === 'read'
          ? store.read(artifact, { channel: 'stdout', offset: 0, length: 4 })
          : store.search(artifact, { channel: 'stdout', query: 'evil' }), /unavailable|identity|regular|symlink|open/i);
        assert.equal(readFileSync(target, 'utf8'), 'evil');
        assert.equal(mutated, true, `${kind}: test races the actual point-of-use open after validation`);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }

    for (const kind of ['read', 'search'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-${kind}-inode-race-`));
      let artifactId = '';
      let mutated = false;
      const store = new FileToolOutputStore(directory, { testFaults: {
        beforeArtifactOpen: (at, channel) => {
          if (at !== kind || channel !== 'stdout' || mutated) return;
          mutated = true;
          const artifactPath = path.join(directory, `${artifactId}.stdout`);
          unlinkSync(artifactPath);
          writeFileSync(artifactPath, 'evil');
        },
      } });
      try {
        const artifact = store.save({ stdout: 'safe', stderr: '' });
        artifactId = artifact.id;
        assert.throws(() => kind === 'read'
          ? store.read(artifact, { channel: 'stdout', offset: 0, length: 4 })
          : store.search(artifact, { channel: 'stdout', query: 'evil' }), /unavailable|identity|size/i);
        assert.equal(mutated, true);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it('reads and searches the verified descriptor after the artifact pathname changes', () => {
    for (const kind of ['read', 'search'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-${kind}-opened-path-change-`));
      let artifactId = '';
      let mutated = false;
      const store = new FileToolOutputStore(directory, { testFaults: {
        afterArtifactOpen: (descriptor, at, channel) => {
          if (at !== kind || channel !== 'stdout' || mutated) return;
          assert.ok(fstatSync(descriptor).isFile(), `${kind}: seam observes the already-open regular-file descriptor`);
          mutated = true;
          const artifactPath = path.join(directory, `${artifactId}.stdout`);
          unlinkSync(artifactPath);
          writeFileSync(artifactPath, 'evil');
        },
      } });
      try {
        const artifact = store.save({ stdout: 'safe', stderr: '' });
        artifactId = artifact.id;
        if (kind === 'read') {
          const result = store.read(artifact, { channel: 'stdout', offset: 0, length: 4 });
          assert.equal(result.text, 'safe', 'read remains bound to the inode opened before the pathname changed');
        } else {
          const matches = store.search(artifact, { channel: 'stdout', query: 'safe' });
          assert.equal(matches.length, 1, 'search reads the verified open descriptor');
          assert.equal(matches[0]?.text, 'safe');
        }
        assert.equal(mutated, true, `${kind}: pathname changed after the descriptor was opened`);
        assert.equal(readFileSync(path.join(directory, `${artifactId}.stdout`), 'utf8'), 'evil', 'replacement remains separate from the validated descriptor');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });

  it('rejects wrong-size and non-regular artifacts without blocking and closes opened descriptors on faults', (context) => {
    for (const replacement of ['wrong-size', 'directory', 'fifo'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-${replacement}-`));
      let artifactId = '';
      let mutated = false;
      const store = new FileToolOutputStore(directory, { testFaults: {
        beforeArtifactOpen: (kind, channel) => {
          if (kind !== 'read' || channel !== 'stdout' || mutated) return;
          mutated = true;
          const artifactPath = path.join(directory, `${artifactId}.stdout`);
          unlinkSync(artifactPath);
          if (replacement === 'wrong-size') writeFileSync(artifactPath, 'too-long');
          else if (replacement === 'directory') mkdirSync(artifactPath);
          else execFileSync('mkfifo', [artifactPath], { stdio: 'ignore' });
        },
      } });
      try {
        const artifact = store.save({ stdout: 'safe', stderr: '' });
        artifactId = artifact.id;
        assert.throws(() => store.read(artifact, { channel: 'stdout', offset: 0, length: 4 }), /unavailable|identity|size|regular/i);
        assert.equal(mutated, true);
      } catch (error) {
        if (replacement === 'fifo' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          context.skip('mkfifo is unavailable on this platform');
          return;
        }
        throw error;
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }

    for (const failedKind of ['hash', 'read', 'search'] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-fd-close-${failedKind}-`));
      let artifactId = '';
      let openedDescriptor: number | undefined;
      const store = new FileToolOutputStore(directory, { testFaults: {
        afterArtifactOpen: (descriptor, kind, channel) => {
          if (kind !== failedKind || channel !== 'stdout' || openedDescriptor !== undefined) return;
          openedDescriptor = descriptor;
          throw new Error(`injected ${failedKind} post-open fault`);
        },
      } });
      try {
        if (failedKind === 'hash') {
          assert.throws(() => store.save({ stdout: 'safe', stderr: '' }), /injected hash post-open fault/);
        } else {
          const artifact = store.save({ stdout: 'safe', stderr: '' });
          assert.throws(() => failedKind === 'read'
            ? store.read(artifact, { channel: 'stdout', offset: 0, length: 4 })
            : store.search(artifact, { channel: 'stdout', query: 'safe' }), new RegExp(`injected ${failedKind} post-open fault`));
          artifactId = artifact.id;
        }
        assert.ok(openedDescriptor !== undefined, `${failedKind}: descriptor-open seam was reached`);
        assert.throws(() => fstatSync(openedDescriptor!), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBADF');
      } finally {
        if (artifactId !== '') {
          for (const channel of ['stdout', 'stderr']) { try { unlinkSync(path.join(directory, `${artifactId}.${channel}`)); } catch { /* cleanup after injected fault */ } }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }
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

      it('file: retains failed-constructor capture debt through abort and reclaims it before capacity-one reuse', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-prepared-capture-debt-'));
        let operation: ReturnType<FileToolOutputStore['beginOperation']> | undefined;
        try {
          const secondOpenFailure = Object.assign(new Error('original second-open EIO'), { code: 'EIO' });
          let unlinkCalls = 0;
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeSecondOpen: () => { throw secondOpenFailure; },
            beforeUnlink: () => { unlinkCalls += 1; throw Object.assign(new Error('injected owned unlink refusal'), { code: 'EACCES' }); },
          } });
          operation = store.beginOperation({ kind: 'prepared-id-debt' });
          assert.throws(() => operation!.startCapture(DEFAULT_TOOL_OUTPUT_POLICY), (error: unknown) => {
            assert.equal(error, secondOpenFailure, 'constructor cleanup preserves the original second-open error');
            return true;
          });
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, `${operation.id}.json`);
          const metadataBeforeAbort = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly activeCaptureIds?: readonly string[] };
          assert.equal(metadataBeforeAbort.activeCaptureIds?.length, 1, 'failed constructor ID remains durably prepared');
          assert.throws(() => operation!.close(), /prepared|capture|open|unresolved/i, 'close refuses to commit unresolved preparation debt');
          assert.equal(unlinkCalls, 1, 'constructor disposal uses the beforeUnlink seam');
          operation.abort();
          operation = undefined;
          const metadataAfterAbort = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly state?: string; readonly activeCaptureIds?: readonly string[] };
          assert.equal(metadataAfterAbort.state, 'aborted');
          assert.equal(metadataAfterAbort.activeCaptureIds?.length, 1, 'abort retains IDs for writers that never constructed');
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')), 'unresolved debt protects its capacity-one slot');
          assert.ok(readdirSync(directory).some((name) => name.endsWith('.stdout')), 'the failed unlink leaves a reclaimable known-path orphan');

          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); console.log(JSON.stringify(store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 })));`;
          const cleanup = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly attempted: number; readonly deleted: number };
          assert.ok(cleanup.attempted <= 8, 'fresh-process recovery stays within the physical deletion budget');
          assert.equal(cleanup.deleted >= 2, true);
          assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
          assert.equal(existsSync(path.join(operations, 'slot-0000.json')), false, 'the prepared ID is removed only after bounded known-path recovery');
          const successor = new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'after-prepared-debt-reclaim' });
          successor.abort();
        } finally {
          try { operation?.abort(); } catch { /* preserve the failing assertion */ }
          rmSync(directory, { recursive: true, force: true });
        }
      });

      it('file: release refuses a matching-nonce legacy PID-only operation lock without changing state', () => {
        for (const kind of ['legacy', 'corrupt', 'foreign-nonce'] as const) {
          const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-release-${kind}-lock-`));
          try {
            const store = new FileToolOutputStore(directory, { capacity: 1 });
            const operation = store.beginOperation({ kind: `release-${kind}-lock` });
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
            writer.write('stdout', 'must-remain-committed');
            writer.finish();
            const operations = path.join(directory, 'operations');
            const versioned = JSON.parse(readFileSync(path.join(operations, `${operation.id}.lock`), 'utf8')) as Record<string, unknown>;
            const artifact = operation.close()[0]!;
            const lockPath = path.join(operations, `${operation.id}.lock`);
            const lock = kind === 'legacy'
              ? { nonce: versioned.nonce, pid: 2_147_483_647 }
              : kind === 'foreign-nonce'
                ? { ...versioned, nonce: 'different-owner-nonce', pid: 2_147_483_647 }
                : '{ malformed owner metadata';
            const raw = typeof lock === 'string' ? lock : JSON.stringify(lock);
            writeFileSync(lockPath, raw);
            assert.throws(() => store.release(artifact), /lock|owner|version|unavailable|invalid/i);
            const after = JSON.parse(readFileSync(path.join(operations, `${operation.id}.json`), 'utf8')) as { readonly state: string };
            assert.equal(after.state, 'closed', `${kind}: failed admission does not release the operation`);
            assert.equal(readFileSync(lockPath, 'utf8'), raw, `${kind}: unsupported lock is not rewritten or taken over`);
            assert.ok(existsSync(path.join(directory, `${artifact.id}.stdout`)), `${kind}: release refusal leaves artifact files untouched`);
            assert.ok(existsSync(path.join(operations, 'slot-0000.json')), `${kind}: release refusal retains slot ownership`);
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
      });

      it('file: strict release takeover rechecks the exact admitted versioned owner record', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-owner-recheck-'));
        try {
          const operations = path.join(directory, 'operations');
          let operationId = '';
          let hookCalls = 0;
          let replacement: Record<string, unknown> | undefined;
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeStaleTakeover: () => {
              hookCalls += 1;
              assert.ok(replacement !== undefined);
              writeFileSync(path.join(operations, `${operationId}.lock`), JSON.stringify(replacement));
            },
          } });
          const operation = store.beginOperation({ kind: 'strict-release-recheck' });
          operationId = operation.id;
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'protected-by-exact-lock');
          writer.finish();
          const staleRecord = JSON.parse(readFileSync(path.join(operations, `${operationId}.lock`), 'utf8')) as Record<string, unknown>;
          const reference = operation.close()[0]!;
          const staleOwner = { ...staleRecord, pid: 2_147_483_647 };
          replacement = { ...staleOwner, nonce: 'replacement-owner-nonce' };
          writeFileSync(path.join(operations, `${operationId}.lock`), JSON.stringify(staleOwner));

          assert.throws(() => store.release(reference), /changed after strict preflight|lock|owner/i);
          assert.equal(hookCalls, 1, 'existing primitive hook exercises the post-preflight exact-record recheck');
          assert.equal(readFileSync(path.join(operations, `${operationId}.lock`), 'utf8'), JSON.stringify(replacement), 'replacement lock is left untouched');
          const metadata = JSON.parse(readFileSync(path.join(operations, `${operationId}.json`), 'utf8')) as { readonly state: string };
          assert.equal(metadata.state, 'closed', 'a changed stale record cannot release committed metadata');
          assert.ok(existsSync(path.join(directory, `${reference.id}.stdout`)), 'a changed stale record cannot authorize artifact deletion');
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')));
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: strict release recovers an exact dead versioned owner record', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-exact-recovery-'));
        try {
          const operations = path.join(directory, 'operations');
          const store = new FileToolOutputStore(directory, { capacity: 1 });
          const operation = store.beginOperation({ kind: 'strict-release-recovery' });
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'release-after-exact-recovery');
          writer.finish();
          const owner = JSON.parse(readFileSync(path.join(operations, `${operation.id}.lock`), 'utf8')) as Record<string, unknown>;
          const reference = operation.close()[0]!;
          writeFileSync(path.join(operations, `${operation.id}.lock`), JSON.stringify({ ...owner, pid: 2_147_483_647 }));

          store.release(reference);
          const metadata = JSON.parse(readFileSync(path.join(operations, `${operation.id}.json`), 'utf8')) as { readonly state: string };
          assert.equal(metadata.state, 'released');
          assert.throws(() => store.read(reference, { channel: 'stdout' }), /unavailable or expired/);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reclaims after a fresh-process fence crash with the persisted owner nonce', () => {
        const fixtureModuleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
        const fixtureSource = `
          import fs from 'node:fs';
          import path from 'node:path';
          import { FileToolOutputStore } from ${JSON.stringify(fixtureModuleUrl)};
          const [root, operationId] = process.argv.slice(1);
          const lockPath = path.join(root, 'operations', operationId + '.lock');
          const store = new FileToolOutputStore(root, { capacity: 1, now: () => {
            if (fs.existsSync(lockPath)) {
              const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
              if (lock.pid === process.pid) {
                console.log(JSON.stringify({ kind: 'crash-after-fence-publication', nonce: lock.nonce }));
                process.exit(91);
              }
            }
            return new Date('2030-01-01T00:00:00.000Z');
          } });
          store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          throw new Error('expected fixture process to stop after fence publication');
        `;
        for (const initialLock of ['missing', 'stale-versioned'] as const) {
          const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-nonce-recovery-${initialLock}-`));
          try {
            const store = new FileToolOutputStore(directory, { capacity: 1 });
            const operation = store.beginOperation({ kind: `recovery-${initialLock}` });
            const lockPath = path.join(directory, 'operations', `${operation.id}.lock`);
            const initialRecord = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
            writer.write('stdout', 'recovery-source-fixture');
            writer.finish();
            const artifact = operation.close()[0]!;
            const metadataPath = path.join(directory, 'operations', `${operation.id}.json`);
            const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly ownerNonce: string };
            if (initialLock === 'stale-versioned') {
              writeFileSync(lockPath, JSON.stringify({
                ...initialRecord,
                pid: 2_147_483_647,
                processStartId: 'dead-owner-fixture',
              }));
            }

            const crashed = spawnSync(process.execPath, [
              '--import', 'tsx', '--input-type=module', '-e', fixtureSource, directory, operation.id,
            ], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
            assert.equal(crashed.status, 91, `${initialLock}: fixture child exits itself after fence publication`);
            assert.equal(crashed.signal, null);
            const crashEvidence = JSON.parse(crashed.stdout.trim()) as { readonly nonce: string };
            assert.equal(crashEvidence.nonce, metadata.ownerNonce, `${initialLock}: fence retains the persisted operation nonce`);
            assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).ownerNonce, metadata.ownerNonce);

            const recoveredStore = new FileToolOutputStore(directory, {
              capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'),
            });
            const cleanup = recoveredStore.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            assert.equal(cleanup.protected, 0, `${initialLock}: dead exact owner is recoverable`);
            assert.equal(existsSync(path.join(directory, `${artifact.id}.stdout`)), false);
            assert.equal(existsSync(path.join(directory, 'operations', 'slot-0000.json')), false);
            const reused = recoveredStore.beginOperation({ kind: `recovered-${initialLock}` });
            reused.abort();
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
      });

      it('file: syncs artifact directory before commit, abort debt removal and cleanup tombstone progress', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-root-fsync-order-'));
        try {
          const events: string[] = [];
          let operationId = '';
          const store = new FileToolOutputStore(directory, { capacity: 2, testFaults: {
            beforeFsync: (channel) => { events.push(`file-${channel}`); },
            beforeArtifactRootFsync: (phase) => {
              events.push(`root-${phase}`);
              if (phase === 'finish') {
                const metadata = JSON.parse(readFileSync(path.join(directory, 'operations', `${operationId}.json`), 'utf8')) as { readonly activeCaptureIds?: readonly string[]; readonly artifacts?: readonly unknown[] };
                assert.equal(metadata.activeCaptureIds?.length, 1, 'artifact is not advertised before root directory sync');
                assert.equal(metadata.artifacts?.length ?? 0, 0);
              }
            },
          } });
          const operation = store.beginOperation({ kind: 'root-fsync-finish-order' });
          operationId = operation.id;
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'durable-before-reference');
          const summary = writer.finish();
          assert.equal(events.join(','), 'file-stdout,file-stderr,root-finish');
          assert.ok(summary.artifact.id.length > 0);
          assert.equal((JSON.parse(readFileSync(path.join(directory, 'operations', `${operationId}.json`), 'utf8')) as { readonly captures?: readonly unknown[] }).captures?.length, 1,
            'metadata advertises the artifact only after finish returns from the root barrier');
          operation.close();

          let abortSyncFailed = false;
          const abortDirectory = path.join(directory, 'abort-debt');
          const abortStore = new FileToolOutputStore(abortDirectory, { capacity: 1, testFaults: {
            beforeArtifactRootFsync: (phase) => {
              if (phase === 'abort' && !abortSyncFailed) { abortSyncFailed = true; throw new Error('injected abort directory sync failure'); }
            },
          } });
          const abortOperation = abortStore.beginOperation({ kind: 'abort-root-fsync-debt' });
          const abortWriter = abortOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          abortWriter.write('stdout', 'already-unlinked-but-not-durable');
          abortOperation.abort();
          const abortMetadata = JSON.parse(readFileSync(path.join(abortDirectory, 'operations', `${abortOperation.id}.json`), 'utf8')) as { readonly state: string; readonly activeCaptureIds?: readonly string[] };
          assert.equal(abortMetadata.state, 'aborted');
          assert.equal(abortMetadata.activeCaptureIds?.length, 1, 'root fsync failure retains prepared-ID debt despite absent paths');
          assert.ok(existsSync(path.join(abortDirectory, 'operations', 'slot-0000.json')));
          const abortRecovery = new FileToolOutputStore(abortDirectory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(abortRecovery.deleted >= 2, true, 'bounded cleanup syncs absent known paths before freeing the slot');
          assert.equal(existsSync(path.join(abortDirectory, 'operations', 'slot-0000.json')), false);

          const old = new Date('2026-09-01T00:00:00.000Z');
          const cleanupDirectory = path.join(directory, 'cleanup-root-fsync-debt');
          const expiring = new FileToolOutputStore(cleanupDirectory, { capacity: 1, now: () => old });
          const expired = expiring.save({ stdout: 'cleanup-after-directory-sync', stderr: '' });
          let cleanupSyncFailed = false;
          const failingCleanup = new FileToolOutputStore(cleanupDirectory, { capacity: 1, testFaults: {
            beforeArtifactRootFsync: (phase) => {
              if (phase === 'cleanup' && !cleanupSyncFailed) { cleanupSyncFailed = true; throw new Error('injected cleanup directory sync failure'); }
            },
          } });
          const failedBatch = failingCleanup.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(failedBatch.protected, 1, 'fsync failure is contained and retains cleanup debt');
          assert.ok(existsSync(path.join(cleanupDirectory, 'operations', 'slot-0000.json')));
          const recovered = new FileToolOutputStore(cleanupDirectory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recovered.deleted >= 2, true);
          assert.equal(existsSync(path.join(cleanupDirectory, 'operations', 'slot-0000.json')), false);
          assert.equal(existsSync(path.join(cleanupDirectory, `${expired.id}.stdout`)), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
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

      it('file: protects active evidence from a matching-nonce legacy PID-only owner lock', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-legacy-owner-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'legacy-owner-test' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'legacy-must-stay'); const summary = writer.finish(); console.log(JSON.stringify({ id: operation.id, artifactId: summary.artifact.id })); process.exit(0);`;
          const active = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly id: string; readonly artifactId: string };
          const metadata = JSON.parse(readFileSync(path.join(directory, 'operations', `${active.id}.json`), 'utf8')) as { readonly ownerNonce: string };
          writeFileSync(path.join(directory, 'operations', `${active.id}.lock`), JSON.stringify({ nonce: metadata.ownerNonce, pid: 2_147_483_647 }));
          const result = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1 });
          assert.equal(result.deleted, 0);
          assert.equal(result.protected, 1);
          assert.ok(existsSync(path.join(directory, `${active.artifactId}.stdout`)));
          assert.ok(existsSync(path.join(directory, 'operations', 'slot-0000.json')));
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: protects deleting tombstones from legacy PID-only locks and cannot reuse their slot', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-legacy-tombstone-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => old });
          const artifact = store.save({ stdout: 'legacy-tombstone-payload', stderr: '' });
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, `${artifact.operationId}.json`);
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly ownerNonce: string };
          unlinkSync(metadataPath);
          writeFileSync(path.join(operations, 'slot-0000.json'), JSON.stringify({ schemaVersion: 1, capacity: 1, slot: 0,
            id: artifact.operationId, deleting: true, artifactIds: [artifact.id] }));
          writeFileSync(path.join(operations, `${artifact.operationId}.lock`), JSON.stringify({ nonce: metadata.ownerNonce, pid: 2_147_483_647 }));
          const result = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1 });
          assert.equal(result.deleted, 0);
          assert.equal(result.protected, 1);
          assert.ok(existsSync(path.join(directory, `${artifact.id}.stdout`)));
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')));
          assert.throws(() => new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'must-not-reuse' }), /capacity|slot/i);
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
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, `${operation.id}.json`);
          unlinkSync(metadataPath);
          writeFileSync(path.join(operations, 'slot-0000.json'), JSON.stringify({ schemaVersion: 1, capacity: 1, slot: 0,
            id: operation.id, deleting: true, artifactIds: ids }));
          unlinkSync(path.join(directory, `${ids[0]}.stdout`)); // simulate interruption after one owned unlink
          let passes = 0;
          let deleted = 0;
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)}); const { existsSync } = await import('node:fs'); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const result = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 10 }); console.log(JSON.stringify({ result, slotExists: existsSync(${JSON.stringify(path.join(operations, 'slot-0000.json'))}) }));`;
          const childResults: Array<{ readonly result: { readonly deleted: number; readonly attempted: number; readonly probed: number }; readonly slotExists: boolean }> = [];
          while (existsSync(path.join(directory, 'operations', 'slot-0000.json')) && passes < 16) {
            const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
              cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            });
            const result = JSON.parse(output.trim()) as typeof childResults[number];
            childResults.push(result);
            assert.ok(result.result.attempted <= 10, 'each fresh-process pass respects the physical deletion-attempt budget');
            assert.ok(result.result.probed <= 1, 'each fresh-process pass respects the slot-probe budget');
            passes += 1; deleted += result.result.deleted;
            if (passes < 10) assert.equal(result.slotExists, true, 'capacity-one tombstone remains occupied across a fresh-process bounded pass');
          }
          assert.equal(passes, 10, 'the bounded cursor revisits the retained tombstone until every artifact is reclaimed');
          assert.equal(deleted, 80, 'the simulated pre-pass unlink is absent from the bounded physical deletion count');
          assert.equal(childResults.at(-1)?.slotExists, false);
          const reused = new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'after-complete-reclaim' });
          reused.abort();
          for (const id of ids) {
            assert.equal(existsSync(path.join(directory, id + '.stdout')), false);
            assert.equal(existsSync(path.join(directory, id + '.stderr')), false);
          }
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: refuses capacity-one registration while a large tombstone remains and succeeds only after bounded reclaim', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-capacity-no-reuse-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => old });
          const operation = store.beginOperation({ kind: 'capacity-no-premature-reuse' });
          for (let index = 0; index < 40; index += 1) {
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY, { commandIndex: index });
            writer.write('stdout', `capacity-payload-${index}`);
            writer.finish();
          }
          operation.close();
          const first = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 10 });
          assert.ok(first.attempted <= 10);
          assert.ok(first.probed <= 1);
          const slotPath = path.join(directory, 'operations', 'slot-0000.json');
          assert.ok(existsSync(slotPath));
          assert.throws(() => new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'premature-reuse' }), /capacity is full/);
          assert.ok(existsSync(slotPath), 'failed registration cannot reuse a slot whose tombstone is still present');

          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); console.log(JSON.stringify(store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 10 })));`;
          let passes = 0;
          while (existsSync(slotPath) && passes < 16) {
            const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
              cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            });
            const pass = JSON.parse(output.trim()) as { readonly attempted: number; readonly probed: number };
            assert.ok(pass.attempted <= 10);
            assert.ok(pass.probed <= 1);
            passes += 1;
          }
          assert.ok(passes > 0 && passes < 16);
          assert.equal(existsSync(slotPath), false);
          const afterReclaim = new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'post-reclaim-registration' });
          afterReclaim.abort();
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
