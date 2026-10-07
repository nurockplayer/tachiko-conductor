import assert from 'node:assert/strict';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

      it('file: recovers explicit early-release owner unlink EIO without renewing consent or affecting an unexpired control', () => {
        for (const fault of ['metadata-directory-sync', 'owner-unlink', 'owner-directory-sync'] as const) {
          const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-release-${fault}-`));
          try {
            const now = new Date('2030-01-01T00:00:00.000Z');
            const store = new FileToolOutputStore(directory, { capacity: 2, retentionMs: 365 * 24 * 60 * 60 * 1000, now: () => now });
            const released = store.save({ stdout: 'explicit-release-consent', stderr: '' });
            const control = store.save({ stdout: 'unexpired-no-release-consent', stderr: '' });
            const metadataPath = path.join(directory, 'operations', `${released.operationId}.json`);
            const before = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly retainedUntil: string; readonly artifacts: readonly unknown[] };
            let injected = false;
            const fail = (message: string): never => {
              injected = true;
              throw Object.assign(new Error(message), { code: 'EIO' });
            };
            const releaseStore = new FileToolOutputStore(directory, { capacity: 2, now: () => now, testFaults: {
              beforeOperationMetadataDirectoryFsync: (value) => {
                if (fault === 'metadata-directory-sync' && !injected && (value as { readonly state?: string }).state === 'released') fail('explicit release metadata directory fsync EIO');
              },
              beforeOwnerLockUnlink: (lockPath) => {
                if (fault === 'owner-unlink' && lockPath.endsWith(`${released.operationId}.lock`) && !injected) fail('explicit release owner unlink EIO');
              },
              beforeOwnerLockDirectoryFsync: (lockPath) => {
                if (fault === 'owner-directory-sync' && lockPath.endsWith(`${released.operationId}.lock`) && !injected) fail('explicit release owner directory fsync EIO');
              },
            } });
            assert.throws(() => releaseStore.release(released), /explicit release .* EIO/);
            assert.equal(injected, true, `${fault} fault was actually reached`);
            const afterFailure = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly state: string; readonly releasedAt: string; readonly retainedUntil: string; readonly artifacts: readonly unknown[] };
            assert.equal(afterFailure.state, 'released', 'the explicit consent is visible but remains backed by its indexed continuation');
            assert.match(afterFailure.releasedAt, /^\d{4}-\d\d-\d\dT/);
            assert.equal(afterFailure.retainedUntil, before.retainedUntil, 'release preserves the original deadline');
            assert.deepEqual(afterFailure.artifacts, before.artifacts, 'the committed artifact reference set remains immutable');
            assert.throws(() => releaseStore.read(released, { channel: 'stdout' }), /unavailable or expired/);

            const maintenance = new FileToolOutputStore(directory, { capacity: 2, now: () => now });
            const ownerRetry = maintenance.cleanupExpired({ maxSlotProbes: 2, maxDeletions: 8 });
            assert.ok(ownerRetry.attempted <= 8);
            assert.equal(existsSync(path.join(directory, 'operations', `${released.operationId}.lock`)), false,
              'maintenance completes the pinned release owner disposal without another public release call');
            assert.ok(existsSync(path.join(directory, `${released.id}.stdout`)), 'release-owner recovery does not run an unbudgeted raw deletion batch');
            assert.equal(maintenance.read(control, { channel: 'stdout' }).text, 'unexpired-no-release-consent');

            const reclaimResults = [];
            const operationSlotPath = readdirSync(path.join(directory, 'operations')).find((entry) => entry.startsWith('slot-'))!;
            const stateBeforeReclaim = {
              slot: readFileSync(path.join(directory, 'operations', operationSlotPath), 'utf8'),
              metadata: existsSync(metadataPath) ? readFileSync(metadataPath, 'utf8') : 'missing',
            };
            for (let pass = 0; pass < 4 && existsSync(path.join(directory, `${released.id}.stdout`)); pass += 1) {
              const reclaim = maintenance.cleanupExpired({ maxSlotProbes: 2, maxDeletions: 8 });
              reclaimResults.push(reclaim);
              assert.ok(reclaim.attempted <= 8, `${fault} release pass ${pass + 1}: ${JSON.stringify(reclaim)}`);
            }
            assert.equal(existsSync(path.join(directory, `${released.id}.stdout`)), false, `${fault} release is reclaimed within four bounded passes: ${JSON.stringify(reclaimResults)} state=${JSON.stringify(stateBeforeReclaim)}`);
            assert.equal(maintenance.read(control, { channel: 'stdout' }).text, 'unexpired-no-release-consent',
              'ordinary unexpired evidence without explicit release stays protected');
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
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

      it('file: capture handles are one-shot and operation abort still removes finished uncommitted evidence', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-terminal-capture-'));
        try {
          const store = new FileToolOutputStore(directory, { capacity: 4 });
          const operation = store.beginOperation({ kind: 'terminal-handles' });
          const first = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          const second = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          first.write('stdout', 'first-committed');
          second.write('stdout', 'second-committed');
          const firstSummary = first.finish();
          assert.throws(() => first.finish(), /finish once/i, 'a second finish is rejected before touching operation bookkeeping');
          const metadata = JSON.parse(readFileSync(path.join(directory, 'operations', `${operation.id}.json`), 'utf8')) as { readonly activeCaptureIds: readonly string[] };
          assert.equal(metadata.activeCaptureIds.length, 2, 'both prepared capture IDs remain indexed until the operation terminal commit');
          const secondId = metadata.activeCaptureIds.find((captureId) => captureId !== firstSummary.artifact.id)!;
          const secondSummary = second.finish();
          assert.equal(secondSummary.artifact.id, secondId);
          const committed = operation.close();
          first.abort?.();
          assert.equal(store.read(committed.find((artifact) => artifact.id === firstSummary.artifact.id)!, { channel: 'stdout' }).text, 'first-committed');
          assert.equal(store.read(committed.find((artifact) => artifact.id === secondSummary.artifact.id)!, { channel: 'stdout' }).text, 'second-committed');

          const abortedOperation = store.beginOperation({ kind: 'private-abort-cleanup' });
          const finishedUncommitted = abortedOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          finishedUncommitted.write('stdout', 'purge-on-operation-abort');
          const uncommittedSummary = finishedUncommitted.finish();
          finishedUncommitted.abort?.();
          assert.ok(existsSync(path.join(directory, `${uncommittedSummary.artifact.id}.stdout`)), 'public abort after finish is harmless');
          abortedOperation.abort();
          assert.equal(existsSync(path.join(directory, `${uncommittedSummary.artifact.id}.stdout`)), false, 'private operation abort still purges finished uncommitted data');

          const standalone = store.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          standalone.write('stdout', 'standalone-committed');
          const standaloneSummary = standalone.finish();
          standalone.abort?.();
          assert.throws(() => standalone.finish(), /finish once/i);
          assert.equal(store.read(standaloneSummary.artifact, { channel: 'stdout' }).text, 'standalone-committed');

          const memory = new InMemoryToolOutputStore();
          const buffered = memory.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          buffered.write('stdout', 'buffered-committed');
          const bufferedSummary = buffered.finish();
          assert.throws(() => buffered.finish(), /finish once/i);
          buffered.abort?.();
          assert.equal(memory.read(bufferedSummary.artifact, { channel: 'stdout' }).text, 'buffered-committed');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: close and abort remain retryable until their owner-fence unlink and directory barrier commit', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-terminal-fence-retry-'));
        try {
          let failCloseUnlink = true;
          let failAbortUnlink = true;
          let failCloseSync = true;
          let closeUnlinks = 0;
          let closeSyncs = 0;
          let closeOperationId = '';
          let abortOperationId = '';
          let syncOperationId = '';
          const store = new FileToolOutputStore(directory, { capacity: 2, retentionMs: 60_000, testFaults: {
            beforeOwnerLockUnlink: (lockPath) => {
              if (closeOperationId !== '' && lockPath.includes(`${closeOperationId}.lock`)) {
                closeUnlinks += 1;
                if (failCloseUnlink) { failCloseUnlink = false; throw Object.assign(new Error('close owner unlink EIO'), { code: 'EIO' }); }
              }
              if (abortOperationId !== '' && lockPath.includes(`${abortOperationId}.lock`) && failAbortUnlink) {
                failAbortUnlink = false;
                throw Object.assign(new Error('abort owner unlink EIO'), { code: 'EIO' });
              }
            },
            beforeOwnerLockDirectoryFsync: (lockPath) => {
              if (syncOperationId !== '' && lockPath.includes(`${syncOperationId}.lock`)) {
                closeSyncs += 1;
                if (failCloseSync) { failCloseSync = false; throw Object.assign(new Error('close owner directory fsync EIO'), { code: 'EIO' }); }
              }
            },
          } });

          const closeOperation = store.beginOperation({ kind: 'close-fence' });
          closeOperationId = closeOperation.id;
          const closeWriter = closeOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          closeWriter.write('stdout', 'retry-close'); closeWriter.finish();
          const closeMetadataPath = path.join(directory, 'operations', `${closeOperation.id}.json`);
          assert.throws(() => closeOperation.close(), /close owner unlink EIO/);
          const frozen = JSON.parse(readFileSync(closeMetadataPath, 'utf8')) as { readonly state: string; readonly closedAt: string; readonly retainedUntil: string };
          assert.equal(frozen.state, 'closed');
          assert.throws(() => closeOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY), /not accepting captures/);
          assert.throws(() => closeOperation.abort(), /close is pending/);
          assert.ok(existsSync(path.join(directory, 'operations', `${closeOperation.id}.lock`)), 'owner fence remains until retry commits');
          const committed = closeOperation.close();
          assert.equal(closeUnlinks, 2, 'retry revalidates then removes the exact owner once');
          assert.equal(JSON.parse(readFileSync(closeMetadataPath, 'utf8')).closedAt, frozen.closedAt);
          assert.equal(JSON.parse(readFileSync(closeMetadataPath, 'utf8')).retainedUntil, frozen.retainedUntil);
          assert.equal(store.read(committed[0]!, { channel: 'stdout' }).text, 'retry-close');

          const abortOperation = store.beginOperation({ kind: 'abort-fence' });
          abortOperationId = abortOperation.id;
          const abortWriter = abortOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          abortWriter.write('stdout', 'retry-abort');
          const abortCaptureId = JSON.parse(readFileSync(path.join(directory, 'operations', `${abortOperation.id}.json`), 'utf8')).activeCaptureIds[0] as string;
          assert.throws(() => abortOperation.abort(), /abort owner unlink EIO/);
          const aborted = JSON.parse(readFileSync(path.join(directory, 'operations', `${abortOperation.id}.json`), 'utf8')) as { readonly state: string };
          assert.equal(aborted.state, 'aborted');
          assert.ok(existsSync(path.join(directory, 'operations', `${abortOperation.id}.lock`)));
          assert.throws(() => abortOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY), /not accepting captures/);
          abortOperation.abort();
          assert.equal(existsSync(path.join(directory, 'operations', `${abortOperation.id}.lock`)), false);
          assert.equal(existsSync(path.join(directory, `${abortCaptureId}.stdout`)), false);

          const syncOperation = store.beginOperation({ kind: 'close-sync' });
          syncOperationId = syncOperation.id;
          const syncWriter = syncOperation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          syncWriter.write('stdout', 'retry-directory-sync'); syncWriter.finish();
          assert.throws(() => syncOperation.close(), /close owner directory fsync EIO/);
          assert.equal(existsSync(path.join(directory, 'operations', `${syncOperation.id}.lock`)), false, 'unlink already happened before the failed barrier');
          const syncRefs = syncOperation.close();
          assert.equal(closeSyncs, 2, 'retry performs only the missing directory barrier');
          assert.equal(store.read(syncRefs[0]!, { channel: 'stdout' }).text, 'retry-directory-sync');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: retires a consumed pinned-owner descriptor before close error retry can hit a reused descriptor', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-owner-close-consumed-'));
        const victimPath = path.join(directory, 'owned-victim.txt');
        writeFileSync(victimPath, 'victim remains open');
        let victimDescriptor = -1;
        let injected = false;
        try {
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeOwnerLockDescriptorClose: (_lockPath, descriptor) => {
              if (injected) return;
              injected = true;
              closeSync(descriptor); // Model close consuming the fd before its error is reported.
              victimDescriptor = openSync(victimPath, 'r');
              assert.equal(victimDescriptor, descriptor, 'the OS may immediately reuse the numeric descriptor');
              throw Object.assign(new Error('consumed owner descriptor close EIO'), { code: 'EIO' });
            },
          } });
          const operation = store.beginOperation({ kind: 'consumed-owner-close' });
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'committed-before-owner-close');
          writer.finish();
          assert.throws(() => operation.close(), /consumed owner descriptor close EIO/);
          assert.equal(injected, true);
          assert.equal(fstatSync(victimDescriptor).isFile(), true);
          const references = operation.close();
          assert.equal(references?.[0]?.stdoutBytes, Buffer.byteLength('committed-before-owner-close'));
          assert.equal(fstatSync(victimDescriptor).isFile(), true, 'public retry completes bookkeeping without closing the reused fd');
          assert.equal(readFileSync(victimPath, 'utf8'), 'victim remains open');
        } finally {
          if (victimDescriptor >= 0) closeSync(victimDescriptor);
          rmSync(directory, { recursive: true, force: true });
        }
      });

      it('file: standalone finish and save retry only terminal metadata without renewing or purging evidence', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-standalone-terminal-retry-'));
        try {
          let failClosedSync = true;
          const store = new FileToolOutputStore(directory, { capacity: 2, retentionMs: 1000, testFaults: {
            beforeOperationMetadataDirectoryFsync: (value) => {
              if ((value as { readonly state?: string }).state === 'closed' && failClosedSync) {
                failClosedSync = false;
                throw Object.assign(new Error('closed metadata directory fsync EIO'), { code: 'EIO' });
              }
            },
          } });
          const standalone = store.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          standalone.write('stdout', 'standalone-finish-retry');
          assert.throws(() => standalone.finish(), /closed metadata directory fsync EIO/);
          standalone.abort?.();
          const summary = standalone.finish();
          assert.equal(store.read(summary.artifact, { channel: 'stdout' }).text, 'standalone-finish-retry');
          assert.throws(() => standalone.finish(), /finish once/i, 'a committed standalone summary remains one-shot');

          const saveDirectory = path.join(directory, 'save-retry');
          let failSaveSync = true;
          const saveStore = new FileToolOutputStore(saveDirectory, { capacity: 1, retentionMs: 1000, testFaults: {
            beforeOperationMetadataDirectoryFsync: (value) => {
              if ((value as { readonly state?: string }).state === 'closed' && failSaveSync) {
                failSaveSync = false;
                throw Object.assign(new Error('save metadata directory fsync EIO'), { code: 'EIO' });
              }
            },
          } });
          assert.throws(() => saveStore.save({ stdout: 'save-terminal-debt', stderr: '' }), /save metadata directory fsync EIO/);
          const metadataPath = path.join(saveDirectory, 'operations');
          const operationId = readdirSync(metadataPath).find((name) => name.endsWith('.json') && !name.startsWith('slot-') && name !== 'index.json')!.slice(0, -5);
          const original = JSON.parse(readFileSync(path.join(metadataPath, `${operationId}.json`), 'utf8')) as { readonly retainedUntil: string; readonly artifacts: readonly [{ readonly id: string }] };
          const cleanup = new FileToolOutputStore(saveDirectory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(cleanup.protected, 1, 'valid unexpired evidence stays committed and occupies its slot');
          assert.equal(JSON.parse(readFileSync(path.join(metadataPath, `${operationId}.json`), 'utf8')).retainedUntil, original.retainedUntil);
          assert.equal(readFileSync(path.join(saveDirectory, `${original.artifacts[0]!.id}.stdout`), 'utf8'), 'save-terminal-debt');
          assert.ok(existsSync(path.join(metadataPath, 'slot-0000.json')));
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: a byte-identical successor owner on a new inode blocks pending terminal release', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-terminal-successor-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `
            import fs from 'node:fs'; import path from 'node:path';
            const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)});
            const root = fs.realpathSync(${JSON.stringify(directory)}); let operationId = ''; let substituted = false;
            const store = new FileToolOutputStore(root, { capacity: 1, testFaults: { beforeOwnerLockUnlink: (lockPath) => {
              if (substituted || !lockPath.endsWith(operationId + '.lock')) return;
              substituted = true;
              const bytes = fs.readFileSync(lockPath);
              const replacement = lockPath + '.successor';
              fs.writeFileSync(replacement, bytes, { mode: 0o600 });
              fs.renameSync(replacement, lockPath);
            } } });
            const operation = store.beginOperation({ kind: 'terminal-successor' }); operationId = operation.id;
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'protected-successor-evidence'); writer.finish();
            const lockPath = path.join(root, 'operations', operation.id + '.lock'); const originalBytes = fs.readFileSync(lockPath, 'utf8');
            let firstError = ''; try { operation.close(); } catch (error) { firstError = error.message; }
            const cleanup = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            const metadata = JSON.parse(fs.readFileSync(path.join(root, 'operations', operation.id + '.json'), 'utf8'));
            console.log(JSON.stringify({ firstError, substituted, cleanup, lock: fs.readFileSync(lockPath, 'utf8'), originalBytes,
              metadata, artifactExists: fs.existsSync(path.join(root, metadata.artifacts[0].id + '.stdout')) }));
            process.exit(0);
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly firstError: string; readonly substituted: boolean; readonly cleanup: { readonly protected: number; readonly deleted: number }; readonly lock: string; readonly originalBytes: string; readonly metadata: { readonly state: string }; readonly artifactExists: boolean };
          assert.match(result.firstError, /generation changed/);
          assert.equal(result.substituted, true);
          assert.equal(result.lock, result.originalBytes, 'same owner bytes on a new inode remain untouched');
          assert.equal(result.metadata.state, 'closed', 'the frozen metadata is retained but never rewritten under the successor');
          assert.equal(result.cleanup.protected, 1);
          assert.equal(result.cleanup.deleted, 0);
          assert.equal(result.artifactExists, true);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: maintenance recovery preserves one undelivered public close or standalone finish response', () => {
        const closeDirectory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-close-response-retry-'));
        const finishDirectory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-finish-response-retry-'));
        try {
          let operationId = '';
          let failUnlink = true;
          const closeStore = new FileToolOutputStore(closeDirectory, { capacity: 1, testFaults: {
            beforeOwnerLockUnlink: (lockPath) => {
              if (failUnlink && lockPath.endsWith(`${operationId}.lock`)) {
                failUnlink = false;
                throw Object.assign(new Error('close delivery unlink EIO'), { code: 'EIO' });
              }
            },
          } });
          const operation = closeStore.beginOperation({ kind: 'close-response-retry' });
          operationId = operation.id;
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'one-close-response'); writer.finish();
          assert.throws(() => operation.close(), /close delivery unlink EIO/);
          const recoveredClose = new FileToolOutputStore(closeDirectory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recoveredClose.protected, 1, 'same-root maintenance completes the close transition but preserves unexpired data');
          const references = operation.close();
          assert.equal(closeStore.read(references[0]!, { channel: 'stdout' }).text, 'one-close-response');
          assert.throws(() => operation.close(), /already closed/);

          let failMetadataSync = true;
          const finishStore = new FileToolOutputStore(finishDirectory, { capacity: 1, testFaults: {
            beforeOperationMetadataDirectoryFsync: (value) => {
              if ((value as { readonly state?: string }).state === 'closed' && failMetadataSync) {
                failMetadataSync = false;
                throw Object.assign(new Error('standalone delivery metadata sync EIO'), { code: 'EIO' });
              }
            },
          } });
          const capture = finishStore.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          capture.write('stdout', 'one-finish-response');
          assert.throws(() => capture.finish(), /standalone delivery metadata sync EIO/);
          const recoveredFinish = new FileToolOutputStore(finishDirectory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recoveredFinish.protected, 1);
          const summary = capture.finish();
          assert.equal(finishStore.read(summary.artifact, { channel: 'stdout' }).text, 'one-finish-response');
          assert.throws(() => capture.finish(), /finish once/i);
        } finally {
          rmSync(closeDirectory, { recursive: true, force: true });
          rmSync(finishDirectory, { recursive: true, force: true });
        }
      });

      it('file: double finish cannot unindex a second writer across a real process crash', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-double-finish-crash-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `
            import { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } from ${JSON.stringify(moduleUrl)};
            const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 });
            const operation = store.beginOperation({ kind: 'double-finish-crash' });
            const first = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
            const second = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
            first.write('stdout', 'first-finished'); second.write('stdout', 'second-still-open');
            const firstResult = first.finish();
            let repeatedRejected = false; try { first.finish(); } catch { repeatedRejected = true; }
            const metadata = JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(path.join(directory, 'operations'))} + '/' + operation.id + '.json', 'utf8'));
            console.log(JSON.stringify({ operationId: operation.id, firstId: firstResult.artifact.id, secondId: metadata.activeCaptureIds.find((id) => id !== firstResult.artifact.id), repeatedRejected }));
            process.exit(0);
          `;
          const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          });
          const child = JSON.parse(output.trim()) as { readonly operationId: string; readonly firstId: string; readonly secondId: string; readonly repeatedRejected: boolean };
          assert.equal(child.repeatedRejected, true, 'the live process rejects second finish before it can unindex the other writer');
          assert.ok(existsSync(path.join(directory, `${child.secondId}.stdout`)));
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') });
          const cleanup = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(cleanup.protected, 0);
          assert.equal(existsSync(path.join(directory, `${child.firstId}.stdout`)), false);
          assert.equal(existsSync(path.join(directory, `${child.secondId}.stdout`)), false, 'fresh bounded recovery removes B instead of orphaning it');
          assert.equal(existsSync(path.join(directory, 'operations', 'slot-0000.json')), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: preserves a finish failure when disposal also fails', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-finish-abort-primary-'));
        try {
          const finishFailure = Object.assign(new Error('owned finish hash failure'), { code: 'EIO' });
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeHash: () => { throw finishFailure; },
            beforeUnlink: () => { throw Object.assign(new Error('owned abort disposal failure'), { code: 'EACCES' }); },
          } });
          const capture = store.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          capture.write('stdout', 'still-indexed-after-failed-finish');
          assert.throws(() => capture.finish(), (error: unknown) => error === finishFailure);
          assert.doesNotThrow(() => capture.abort?.(), 'public disposal cannot replace the already-reported finish error');
          const operationIds = readdirSync(path.join(directory, 'operations')).filter((name) => name.endsWith('.json') && !name.startsWith('slot-') && name !== 'index.json');
          assert.equal(operationIds.length, 1, 'failed finish/disposal remains represented by operation metadata');
          assert.equal(readdirSync(directory).filter((name) => name.endsWith('.stdout')).length, 1);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: abort metadata failure retains its owner fence and permits a safe retry', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-abort-retry-fence-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `
            import fs from 'node:fs';
            import path from 'node:path';
            import { syncBuiltinESMExports } from 'node:module';
            const root = fs.realpathSync(${JSON.stringify(directory)});
            const originalRename = fs.renameSync; let armed = false; let failRename = true; let failUnlink = true; let metadataPath = '';
            fs.renameSync = (from, to) => {
              if (armed && to === metadataPath && failRename) { failRename = false; throw Object.assign(new Error('owned abort metadata rename EIO'), { code: 'EIO' }); }
              return originalRename(from, to);
            };
            syncBuiltinESMExports();
            const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)});
            const store = new FileToolOutputStore(root, { capacity: 1, testFaults: { beforeUnlink: () => {
              if (armed && failUnlink) { failUnlink = false; throw Object.assign(new Error('owned abort unlink EIO'), { code: 'EIO' }); }
            } } });
            const operation = store.beginOperation({ kind: 'abort-retry-fence' });
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'retryable-owned-abort');
            metadataPath = path.join(root, 'operations', operation.id + '.json');
            const lockPath = path.join(root, 'operations', operation.id + '.lock');
            const before = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); const owner = before.ownerNonce; const captureId = before.activeCaptureIds[0];
            armed = true; let firstError;
            try { operation.abort(); } catch (error) { firstError = { code: error.code, message: error.message }; }
            const afterFailure = { state: JSON.parse(fs.readFileSync(metadataPath, 'utf8')).state, ids: JSON.parse(fs.readFileSync(metadataPath, 'utf8')).activeCaptureIds, lock: JSON.parse(fs.readFileSync(lockPath, 'utf8')) };
            let captureRefused = false; try { operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); } catch { captureRefused = true; }
            let closeRefused = false; try { operation.close(); } catch { closeRefused = true; }
            armed = false; operation.abort();
            const afterRetry = { state: JSON.parse(fs.readFileSync(metadataPath, 'utf8')).state, ids: JSON.parse(fs.readFileSync(metadataPath, 'utf8')).activeCaptureIds, lockExists: fs.existsSync(lockPath), stdoutExists: fs.existsSync(path.join(root, captureId + '.stdout')) };
            console.log(JSON.stringify({ id: operation.id, owner, firstError, afterFailure, captureRefused, closeRefused, afterRetry }));
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly owner: string; readonly firstError: { readonly code: string }; readonly afterFailure: { readonly state: string; readonly ids: readonly string[]; readonly lock: { readonly nonce: string } }; readonly captureRefused: boolean; readonly closeRefused: boolean; readonly afterRetry: { readonly state: string; readonly lockExists: boolean; readonly stdoutExists: boolean } };
          assert.equal(result.firstError.code, 'EIO');
          assert.equal(result.afterFailure.state, 'active', 'failed terminal metadata must not replace the last recoverable record');
          assert.equal(result.afterFailure.ids.length, 1, 'the failed stream stays indexed through the retry window');
          assert.equal(result.afterFailure.lock.nonce, result.owner, 'the original versioned owner proof remains present');
          assert.equal(result.captureRefused, true);
          assert.equal(result.closeRefused, true);
          assert.equal(result.afterRetry.state, 'aborted');
          assert.equal(result.afterRetry.lockExists, false);
          assert.equal(result.afterRetry.stdoutExists, false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: failed active-owner tombstone publication keeps the fence for fresh-process recovery', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-active-tombstone-retry-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const ownerSource = `
            import { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } from ${JSON.stringify(moduleUrl)};
            const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 });
            const operation = store.beginOperation({ kind: 'active-tombstone-owner' });
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'active-tombstone-recovery-marker');
            const artifact = writer.finish().artifact;
            console.log(JSON.stringify({ operationId: operation.id, artifactId: artifact.id })); process.exit(0);
          `;
          const owner = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ownerSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly operationId: string; readonly artifactId: string };
          const cleanupSource = `
            import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
            const root = fs.realpathSync(${JSON.stringify(directory)}); const slotPath = path.join(root, 'operations', 'slot-0000.json');
            const originalRename = fs.renameSync; let armed = true; let faults = 0;
            fs.renameSync = (from, to) => { if (armed && to === slotPath && faults++ === 0) throw Object.assign(new Error('owned tombstone rename EIO'), { code: 'EIO' }); return originalRename(from, to); };
            syncBuiltinESMExports(); const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)});
            const store = new FileToolOutputStore(root, { capacity: 1 }); const cleanup = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            armed = false; fs.renameSync = originalRename; syncBuiltinESMExports();
            const metadata = JSON.parse(fs.readFileSync(path.join(root, 'operations', ${JSON.stringify(owner.operationId)} + '.json'), 'utf8'));
            const lockPath = path.join(root, 'operations', ${JSON.stringify(owner.operationId)} + '.lock');
            console.log(JSON.stringify({ faults, cleanup, state: metadata.state, lockExists: fs.existsSync(lockPath), ownerNonce: metadata.ownerNonce, lockNonce: JSON.parse(fs.readFileSync(lockPath, 'utf8')).nonce }));
          `;
          const failed = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', cleanupSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly faults: number; readonly cleanup: { readonly protected: number; readonly deleted: number }; readonly state: string; readonly lockExists: boolean; readonly ownerNonce: string; readonly lockNonce: string };
          assert.equal(failed.faults, 1);
          assert.equal(failed.state, 'active');
          assert.equal(failed.lockExists, true, 'failed active-to-tombstone publication cannot release its acquired owner fence');
          assert.equal(failed.lockNonce, failed.ownerNonce);
          assert.equal(failed.cleanup.protected, 1);
          assert.equal(failed.cleanup.deleted, 0);

          const recovered = new FileToolOutputStore(directory, { capacity: 1 });
          const cleanup = recovered.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(cleanup.protected, 0);
          assert.equal(existsSync(path.join(directory, `${owner.artifactId}.stdout`)), false);
          assert.equal(existsSync(path.join(directory, 'operations', 'slot-0000.json')), false);
          const reused = recovered.beginOperation({ kind: 'after-fence-safe-tombstone-recovery' }); reused.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: retries close with its original retention deadline after metadata publication failure', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-close-retry-deadline-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `
            import fs from 'node:fs'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
            const root = fs.realpathSync(${JSON.stringify(directory)}); const originalRename = fs.renameSync;
            const initial = new Date('2030-01-01T00:00:00.000Z'); let now = initial; let metadataPath = ''; let armed = false; let failOnce = true;
            fs.renameSync = (from, to) => { if (armed && to === metadataPath && failOnce) { failOnce = false; throw Object.assign(new Error('owned close rename EIO'), { code: 'EIO' }); } return originalRename(from, to); };
            syncBuiltinESMExports(); const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)});
            const store = new FileToolOutputStore(root, { capacity: 1, retentionMs: 1000, now: () => now });
            const operation = store.beginOperation({ kind: 'close-retry-deadline' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'close-retry'); writer.finish();
            metadataPath = path.join(root, 'operations', operation.id + '.json'); armed = true; let firstError;
            try { operation.close(); } catch (error) { firstError = error.code; }
            armed = false; now = new Date(initial.getTime() + 50_000); const reference = operation.close()[0];
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); console.log(JSON.stringify({ firstError, reference, metadata, expectedClosedAt: initial.toISOString(), expectedRetainedUntil: new Date(initial.getTime() + 1000).toISOString() }));
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly firstError: string; readonly reference: { readonly retainedUntil: string }; readonly metadata: { readonly closedAt: string; readonly retainedUntil: string }; readonly expectedClosedAt: string; readonly expectedRetainedUntil: string };
          assert.equal(result.firstError, 'EIO');
          assert.equal(result.metadata.closedAt, result.expectedClosedAt);
          assert.equal(result.metadata.retainedUntil, result.expectedRetainedUntil);
          assert.equal(result.reference.retainedUntil, result.expectedRetainedUntil);
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
          assert.throws(() => abortOperation.abort(), /injected abort directory sync failure/,
            'abort reports the directory durability failure after recording recoverable debt');
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
          assert.equal(result.deleted, 5, 'two stream files, metadata, owner lock and operation slot are reclaimed');
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
          assert.equal(result.deleted, 3, 'already removed stdout is idempotently absent; stderr, cleanup owner lock and slot are deleted');
          assert.equal(existsSync(path.join(directory, artifact.id + '.stdout')), false);
          assert.equal(existsSync(path.join(directory, artifact.id + '.stderr')), false);
          assert.equal(existsSync(path.join(operations, 'slot-0000.json')), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: continues bounded cleanup after the live cleanup owner unlink fails', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-cleanup-owner-retry-'));
        try {
          const old = new Date('2026-09-01T00:00:00.000Z');
          const expiredStore = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1, now: () => old });
          const operation = expiredStore.beginOperation({ kind: 'cleanup-owner-retry' });
          for (let index = 0; index < 2; index += 1) {
            const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
            writer.write('stdout', `cleanup-owner-payload-${index}`);
            writer.finish();
          }
          operation.close();
          let failOwnerUnlink = true;
          const maintenance = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'), testFaults: {
            beforeOwnerLockUnlink: (lockPath) => {
              if (lockPath.endsWith(`${operation.id}.lock`) && failOwnerUnlink) {
                failOwnerUnlink = false;
                throw Object.assign(new Error('cleanup owner unlink EIO'), { code: 'EIO' });
              }
            },
          } });
          const first = maintenance.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 4 });
          assert.equal(first.protected, 1);
          assert.ok(first.attempted <= 4);
          assert.ok(existsSync(path.join(directory, 'operations', 'slot-0000.json')), 'the tombstone keeps the slot discoverable after owner unlink failure');

          const retries = [
            maintenance.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 }),
            new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 }),
          ];
          assert.equal(failOwnerUnlink, false);
          for (const pass of retries) {
            assert.ok(pass.attempted <= 8, 'owner retry and artifact reclaim stay inside each caller budget');
            assert.ok(pass.probed <= 1);
          }
          assert.equal(existsSync(path.join(directory, 'operations', 'slot-0000.json')), false);
          assert.deepEqual(readdirSync(directory).filter((name) => /\.(stdout|stderr)$/.test(name)), []);
          const reusable = new FileToolOutputStore(directory, { capacity: 1 }).beginOperation({ kind: 'after-cleanup-owner-recovery' });
          reusable.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: resumes active cleanup after tombstone rename and post-rename directory-sync faults', () => {
        const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
        for (const fault of ['rename', 'directory-sync'] as const) {
          const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-cleanup-${fault}-`));
          try {
            const ownerSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'cleanup-active-owner' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'active-cleanup-recovery'); writer.finish(); console.log(operation.id); process.exit(0);`;
            const operationId = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ownerSource], {
              cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            assert.match(operationId, /^[0-9a-f-]{36}$/);
            const recoverySource = `
              import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
              const root = ${JSON.stringify(directory)}; const operations = root + '/operations'; const target = operations + '/slot-0000.json';
              const originalRename = fs.renameSync; const originalOpen = fs.openSync; const originalFsync = fs.fsyncSync;
              let fired = false; let renameCalls = 0; const operationId = ${JSON.stringify(operationId)};
              if (${JSON.stringify(fault)} === 'rename') {
                fs.renameSync = (from, to) => {
                  renameCalls += 1;
                  if (!fired && String(to).endsWith('/slot-0000.json')) { fired = true; throw Object.assign(new Error('cleanup tombstone rename EIO'), { code: 'EIO' }); }
                  return originalRename(from, to);
                };
              } else {
                fs.fsyncSync = (descriptor) => {
                  if (!fired && fs.existsSync(target) && JSON.parse(fs.readFileSync(target, 'utf8')).deleting === true) { fired = true; throw Object.assign(new Error('cleanup tombstone directory sync EIO'), { code: 'EIO' }); }
                  return originalFsync(descriptor);
                };
              }
              syncBuiltinESMExports();
              try {
                const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)});
                const store = new FileToolOutputStore(root, { capacity: 1 });
                const first = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
                const second = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
                const raw = fs.readdirSync(root).filter((name) => /\\.(stdout|stderr)$/.test(name));
                const slotExists = fs.existsSync(target);
                const reusable = new FileToolOutputStore(root, { capacity: 1 }).beginOperation({ kind: 'after-active-cleanup' }); reusable.abort();
                console.log(JSON.stringify({ operationId, fired, renameCalls, first, second, raw, slotExists }));
              } finally { fs.renameSync = originalRename; fs.openSync = originalOpen; fs.fsyncSync = originalFsync; syncBuiltinESMExports(); }
            `;
            const recovered = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', recoverySource], {
              cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            }).trim()) as { readonly fired: boolean; readonly first: { readonly protected: number }; readonly second: { readonly protected: number; readonly attempted: number }; readonly raw: readonly string[]; readonly slotExists: boolean };
            assert.equal(recovered.fired, true, `${fault} fault was actually reached: ${JSON.stringify(recovered)}`);
            assert.equal(recovered.first.protected, 1, 'the failing active publication remains protected with its owner continuation');
            assert.equal(recovered.second.protected, 0, 'a fault-free same-process pass completes the pinned transition');
            assert.ok(recovered.second.attempted <= 8);
            assert.deepEqual(recovered.raw, []);
            assert.equal(recovered.slotExists, false);
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
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
          assert.equal(passes, 11, 'the bounded cursor revisits the retained tombstone until every artifact is reclaimed');
          assert.equal(deleted, 91, 'the simulated pre-pass unlink is absent; artifact and cleanup-owner unlink attempts are counted');
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
