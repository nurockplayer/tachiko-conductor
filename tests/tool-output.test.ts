import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync as fsWriteSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  DEFAULT_TOOL_OUTPUT_POLICY,
  ContainedToolOutputCaptureSession,
  FileToolOutputStore,
  InMemoryToolOutputStore,
  boundToolOutput,
  boundToolOutputFromCapture,
  isToolOutputEnvelope,
  readToolOutput,
  searchToolOutput,
  validateToolOutputPolicy,
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
  it('validates optional retention authority as an absent pair or a canonical pair', () => {
    const base = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: '', stderr: '',
      store: new InMemoryToolOutputStore(), policy });
    const validId = '00000000-0000-4000-8000-000000000000';
    const canonicalPast = '2000-01-01T00:00:00.000Z';
    assert.equal(isToolOutputEnvelope(base), true, 'legacy and memory references may omit both retention fields');
    assert.equal(isToolOutputEnvelope({ ...base, artifact: { ...base.artifact,
      operationId: validId, retainedUntil: canonicalPast } }), true,
    'a valid past deadline remains structurally valid without making a freshness decision');
    for (const fields of [
      { operationId: 7, retainedUntil: canonicalPast },
      { operationId: validId, retainedUntil: null },
      { operationId: 'bad-operation-id', retainedUntil: canonicalPast },
      { operationId: validId, retainedUntil: '2000-1-1T00:00:00.000Z' },
      { operationId: validId },
      { retainedUntil: canonicalPast },
    ]) {
      assert.equal(isToolOutputEnvelope({ ...base, artifact: { ...base.artifact, ...fields } }), false,
        `malformed retention metadata is rejected: ${JSON.stringify(fields)}`);
    }
  });

  it('admits one cumulative UTF-8 operation quota across channels and writers without refunds', () => {
    const exactRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-capture-quota-exact-'));
    const faultRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-capture-quota-fault-'));
    try {
      const exact = new FileToolOutputStore(exactRoot, { capacity: 2, captureMaxBytes: 8 });
      const exactOperation = exact.beginOperation({ kind: 'exact-cumulative-quota' });
      const exactWriter = exactOperation.startCapture(policy);
      exactWriter.write('stdout', 'éé');
      exactWriter.write('stderr', 'abcd');
      const exactCapture = exactWriter.finish();
      const [exactArtifact] = exactOperation.close();
      assert.equal(exactArtifact?.totalBytes, 8, 'UTF-8 bytes across both channels share the exact operation limit');
      assert.equal(readFileSync(path.join(exactRoot, `${exactCapture.artifact.id}.stdout`), 'utf8'), 'éé');

      let shortWrite = false;
      let wrotePrefix = false;
      const store = new FileToolOutputStore(faultRoot, { capacity: 2, captureMaxBytes: 8, testFaults: {
        writeSync: (descriptor, bytes, offset, length) => {
          if (!shortWrite) return fsWriteSync(descriptor, bytes, offset, length);
          if (!wrotePrefix) { wrotePrefix = true; return fsWriteSync(descriptor, bytes, offset, 1); }
          throw new Error('injected write failure after a physical prefix');
        },
      } });
      const operation = store.beginOperation({ kind: 'quota-no-refund' });
      const sibling = operation.startCapture(policy);
      sibling.write('stdout', 'abc');
      const siblingSummary = sibling.finish();
      const failed = operation.startCapture(policy);
      shortWrite = true;
      assert.throws(() => failed.write('stderr', 'xyz'), /injected write failure/);
      failed.abort?.();
      const overBudget = operation.startCapture(policy);
      assert.throws(() => overBudget.write('stdout', 'xyz'), /byte budget exhausted/);
      assert.throws(() => overBudget.finish(), /cannot finish/);
      overBudget.abort?.();
      const [committed] = operation.close();
      assert.equal(committed?.id, siblingSummary.artifact.id, 'a completed sibling still commits');
      assert.equal(readFileSync(path.join(faultRoot, `${siblingSummary.artifact.id}.stdout`), 'utf8'), 'abc');
      assert.deepEqual(readdirSync(faultRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')).sort(),
        [`${siblingSummary.artifact.id}.stderr`, `${siblingSummary.artifact.id}.stdout`].sort(), 'failed and over-budget captures leave no artifact files');
    } finally { rmSync(exactRoot, { recursive: true, force: true }); rmSync(faultRoot, { recursive: true, force: true }); }
  });

  it('rejects invalid capture quotas before filesystem changes and refuses unsafe existing evidence leaves unchanged', () => {
    const invalidRoot = path.join(os.tmpdir(), `tachiko-invalid-capture-quota-${process.pid}-${Date.now()}`);
    assert.throws(() => new FileToolOutputStore(invalidRoot, { captureMaxBytes: 0 }), /positive safe integer/);
    assert.throws(() => new FileToolOutputStore(invalidRoot, { captureMaxBytes: 64 * 1_048_576 + 1 }), /exceeds the maximum/);
    assert.equal(existsSync(invalidRoot), false, 'invalid constructor budgets do not create the root');

    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-unsafe-evidence-root-'));
    const sentinel = path.join(root, 'sentinel');
    writeFileSync(sentinel, 'keep');
    chmodSync(root, 0o755);
    try {
      const store = new FileToolOutputStore(root, { capacity: 1 });
      assert.throws(() => store.beginOperation({ kind: 'unsafe-root' }), /owned by the current user and private/);
      assert.equal(lstatSync(root).mode & 0o777, 0o755, 'existing evidence root mode is never repaired');
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
      assert.equal(existsSync(path.join(root, 'operations')), false, 'unsafe root is rejected before operations/slot mutation');
    } finally { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); }

    const operationsRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-unsafe-operations-'));
    const operations = path.join(operationsRoot, 'operations');
    mkdirSync(operations, { mode: 0o700 });
    const operationSentinel = path.join(operations, 'sentinel');
    writeFileSync(operationSentinel, 'keep');
    chmodSync(operations, 0o755);
    try {
      assert.throws(() => new FileToolOutputStore(operationsRoot, { capacity: 1 }).beginOperation(), /owned by the current user and private/);
      assert.equal(lstatSync(operations).mode & 0o777, 0o755, 'existing operations mode is never repaired');
      assert.equal(readFileSync(operationSentinel, 'utf8'), 'keep');
      assert.deepEqual(readdirSync(operations), ['sentinel'], 'unsafe operations leaf is rejected before lock or slot mutation');
    } finally { chmodSync(operations, 0o700); rmSync(operationsRoot, { recursive: true, force: true }); }

    const newParent = mkdtempSync(path.join(os.tmpdir(), 'tachiko-new-evidence-parent-'));
    try {
      const newRoot = path.join(newParent, 'nested', 'evidence');
      const operation = new FileToolOutputStore(newRoot, { capacity: 1 }).beginOperation({ kind: 'new-private-leaves' });
      operation.abort();
      assert.equal(lstatSync(path.join(newParent, 'nested')).mode & 0o777, 0o700);
      assert.equal(lstatSync(newRoot).mode & 0o777, 0o700);
      assert.equal(lstatSync(path.join(newRoot, 'operations')).mode & 0o777, 0o700);
    } finally { rmSync(newParent, { recursive: true, force: true }); }
  });

  it('preflights the complete initial attribution envelope before filesystem mutation', () => {
    const absentRoot = path.join(os.tmpdir(), `tachiko-attribution-preflight-${process.pid}-${Date.now()}`);
    const absent = new FileToolOutputStore(absentRoot, { capacity: 1 });
    const oversized = { escaped: '\\"\\n\\t', multibyte: '界🙂', payload: 'x'.repeat(1_048_576) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.throws(() => absent.beginOperation(oversized), /bounded metadata limit/);
      assert.equal(existsSync(absentRoot), false, 'deterministically inadmissible metadata does not create the evidence root');
    }
    const unsupportedRoot = path.join(os.tmpdir(), `tachiko-attribution-unsupported-${process.pid}-${Date.now()}`);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => new FileToolOutputStore(unsupportedRoot, { capacity: 1 }).beginOperation(cyclic as never), /scalar record|scalar/);
    assert.equal(existsSync(unsupportedRoot), false, 'unsupported caller values are rejected before root mutation');

    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-attribution-existing-root-'));
    try {
      const store = new FileToolOutputStore(root, { capacity: 1 });
      const owner = store.beginOperation({ kind: 'existing-capacity-owner' });
      const operations = path.join(root, 'operations');
      const snapshot = (): Array<[string, string]> => readdirSync(operations).sort().map((name) => [name, readFileSync(path.join(operations, name)).toString('base64')]);
      const before = snapshot();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.throws(() => store.beginOperation(oversized), /bounded metadata limit/);
        assert.deepEqual(snapshot(), before, 'rejected attribution leaves slot, index, owner and cursor bytes unchanged');
      }
      owner.abort();
      const mutable = { label: 'before' };
      const admitted = store.beginOperation(mutable);
      mutable.label = 'after';
      const metadata = JSON.parse(readFileSync(path.join(operations, `${admitted.id}.json`), 'utf8')) as { attribution: { label: string } };
      assert.equal(metadata.attribution.label, 'before', 'initial metadata uses the detached admission snapshot');
      admitted.abort();
    } finally { rmSync(root, { recursive: true, force: true }); }

    const exactRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-attribution-exact-bound-'));
    try {
      const fixed = { schemaVersion: 1, id: '0'.repeat(36), slot: 0, ownerNonce: '0'.repeat(36), createdAt: '2030-01-01T00:00:00.000Z', attribution: { value: '' }, state: 'active', artifacts: [], activeCaptureIds: [] };
      const exactBytes = 1_048_576 - Buffer.byteLength(JSON.stringify(fixed), 'utf8');
      const exact = new FileToolOutputStore(exactRoot, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') });
      const operation = exact.beginOperation({ value: 'x'.repeat(exactBytes) });
      assert.equal(Buffer.byteLength(readFileSync(path.join(exactRoot, 'operations', `${operation.id}.json`)), 'utf8'), 1_048_576,
        'the complete initial envelope admits the exact UTF-8 metadata limit');
      rmSync(exactRoot, { recursive: true, force: true });
    } finally { rmSync(exactRoot, { recursive: true, force: true }); }

    const conservativeRoot = path.join(os.tmpdir(), `tachiko-attribution-conservative-${process.pid}-${Date.now()}`);
    const slotZeroFixed = { schemaVersion: 1, id: '0'.repeat(36), slot: 0, ownerNonce: '0'.repeat(36), createdAt: '2030-01-01T00:00:00.000Z', attribution: { value: '' }, state: 'active', artifacts: [], activeCaptureIds: [] };
    const slotZeroExactBytes = 1_048_576 - Buffer.byteLength(JSON.stringify(slotZeroFixed), 'utf8');
    assert.throws(() => new FileToolOutputStore(conservativeRoot, { capacity: 256, now: () => new Date('2030-01-01T00:00:00.000Z') })
      .beginOperation({ value: 'x'.repeat(slotZeroExactBytes) }), /bounded metadata limit/,
    'the maximum slot width may conservatively refuse metadata that would fit the first slot');
    assert.equal(existsSync(conservativeRoot), false, 'conservative boundary refusal still precedes all filesystem mutation');
  });

  it('fails closed before mutation when private POSIX identity proof is unavailable and prefers effective uid', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const effectiveUid = Object.getOwnPropertyDescriptor(process, 'geteuid');
    const realUid = Object.getOwnPropertyDescriptor(process, 'getuid');
    const unsupported = path.join(os.tmpdir(), `tachiko-unsupported-file-capture-${process.pid}-${Date.now()}`);
    const roots: string[] = [];
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      assert.throws(() => new FileToolOutputStore(unsupported).beginOperation(), /requires supported POSIX/);
      assert.equal(existsSync(unsupported), false, 'unsupported platform is rejected before mkdir');

      Object.defineProperty(process, 'platform', platform);
      const uidRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-effective-uid-'));
      roots.push(uidRoot);
      Object.defineProperty(process, 'geteuid', { configurable: true, writable: true, value: () => (realUid!.value as () => number)() + 1 });
      assert.throws(() => new FileToolOutputStore(uidRoot).beginOperation(), /owned by the current user and private/);
      assert.equal(existsSync(path.join(uidRoot, 'operations')), false, 'different effective uid is rejected before child-directory creation');

      Object.defineProperty(process, 'geteuid', { configurable: true, writable: true, value: () => { throw new Error('effective uid unavailable'); } });
      const failedLookupRoot = path.join(os.tmpdir(), `tachiko-failed-euid-${process.pid}-${Date.now()}`);
      assert.throws(() => new FileToolOutputStore(failedLookupRoot).beginOperation(), /cannot verify the current effective user/);
      assert.equal(existsSync(failedLookupRoot), false, 'failed effective lookup does not fall back or mutate the root');

      Object.defineProperty(process, 'geteuid', { configurable: true, writable: true, value: null });
      const unusableLookupRoot = path.join(os.tmpdir(), `tachiko-unusable-euid-${process.pid}-${Date.now()}`);
      assert.throws(() => new FileToolOutputStore(unusableLookupRoot).beginOperation(), /cannot verify the current effective user/);
      assert.equal(existsSync(unusableLookupRoot), false, 'an unusable present effective-uid API does not fall back');

      Object.defineProperty(process, 'geteuid', { configurable: true, writable: true, value: undefined });
      const fallbackRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-real-uid-fallback-'));
      roots.push(fallbackRoot);
      const operation = new FileToolOutputStore(fallbackRoot).beginOperation({ kind: 'getuid-fallback' });
      operation.abort();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (effectiveUid === undefined) delete (process as NodeJS.Process & { geteuid?: () => number }).geteuid;
      else Object.defineProperty(process, 'geteuid', effectiveUid);
      if (realUid === undefined) delete (process as NodeJS.Process & { getuid?: () => number }).getuid;
      else Object.defineProperty(process, 'getuid', realUid);
      rmSync(unsupported, { recursive: true, force: true });
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects oversized read and search requests before looking up an artifact in either store', () => {
    const missing = { kind: 'tool-output', id: 'missing', stdoutBytes: 0, stderrBytes: 0, totalBytes: 0, sha256: '0'.repeat(64) } as const;
    for (const store of [new InMemoryToolOutputStore(), new FileToolOutputStore(path.join(os.tmpdir(), `tachiko-request-bounds-${process.pid}-${Date.now()}`))]) {
      assert.throws(() => store.read(missing, { channel: 'stdout', length: 1_048_577 }), /range length exceeds/);
      assert.throws(() => store.search(missing, { channel: 'stdout', query: 'x', maxMatches: 129 }), /maxMatches exceeds/);
      assert.throws(() => store.search(missing, { channel: 'stdout', query: 'x', maxBytes: 65_537 }), /maxBytes exceeds/);
      assert.throws(() => store.search(missing, { channel: 'stdout', query: 'x'.repeat(65_537) }), /query exceeds/);
    }
  });

  it('accepts the exact read, query, match and per-line maxima including a multibyte query boundary', () => {
    const store = new InMemoryToolOutputStore();
    const query = `${'界'.repeat(21_845)}x`;
    assert.equal(Buffer.byteLength(query, 'utf8'), 65_536);
    const reference = store.save({ stdout: query, stderr: '' });
    assert.equal(store.read(reference, { channel: 'stdout', length: 1_048_576 }).text, query);
    const matches = store.search(reference, { channel: 'stdout', query, maxMatches: 128, maxBytes: 65_536 });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.text, query);

    const astralQuery = '🙂'.repeat(16_384);
    assert.equal(Buffer.byteLength(astralQuery, 'utf8'), 65_536);
    const astralReference = store.save({ stdout: astralQuery, stderr: astralQuery });
    for (const channel of ['stdout', 'stderr'] as const) {
      const astralMatches = store.search(astralReference, { channel, query: astralQuery, maxBytes: 65_536 });
      assert.equal(astralMatches.length, 1);
      assert.equal(astralMatches[0]?.text, astralQuery);
      assert.equal(astralMatches[0]?.text.includes('\uFFFD'), false);
    }
  });

  it('keeps search overlap scalar-safe at a native 64 KiB boundary on both streams and stores', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-search-scalar-boundary-'));
    try {
      const content = `first\n${'a'.repeat(65_526)}🙂xy\n`;
      assert.equal(Buffer.byteLength(content.slice(0, content.indexOf('xy')), 'utf8'), 65_536,
        'the first native file-search chunk ends exactly after a complete astral scalar');
      for (const store of [new InMemoryToolOutputStore(), new FileToolOutputStore(directory)]) {
        const artifact = store.save({ stdout: content, stderr: content });
        for (const channel of ['stdout', 'stderr'] as const) {
          const ascii = store.search(artifact, { channel, query: 'xy', maxBytes: 24 });
          assert.equal(ascii.length, 1);
          assert.equal(ascii[0]?.line, 2);
          assert.equal(ascii[0]?.offset, 6);
          assert.ok(ascii[0]?.text.includes('🙂xy'));
          assert.equal(ascii[0]?.text.includes('\uFFFD'), false);
          assert.ok(Buffer.byteLength(ascii[0]!.text, 'utf8') <= 24);

          const astral = store.search(artifact, { channel, query: '🙂xy', maxBytes: 24 });
          assert.equal(astral.length, 1);
          assert.equal(astral[0]?.line, 2);
          assert.equal(astral[0]?.offset, 6);
          assert.ok(astral[0]?.text.includes('🙂xy'));
          assert.equal(astral[0]?.text.includes('\uFFFD'), false);

          const tiny = store.search(artifact, { channel, query: 'xy', maxBytes: 1 });
          assert.equal(tiny.length, 1);
          assert.ok(Buffer.byteLength(tiny[0]!.text, 'utf8') <= 1);
          assert.equal(tiny[0]?.text.includes('\uFFFD'), false);
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('treats split CRLF as one delimiter with file and memory search parity', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-search-crlf-boundary-'));
    try {
      const content = `prefix\n${'n'.repeat(65_524)}\nhit\r\nafter\nrepeat\r\r\nother\rZ\nend\r`;
      assert.equal(Buffer.byteLength(content.slice(0, content.indexOf('hit') + 4), 'utf8'), 65_536,
        'an earlier nonmatching delimiter and short target put CR at byte 65,535 and LF at 65,536');
      const stores = [new InMemoryToolOutputStore(), new FileToolOutputStore(directory)];
      const references = stores.map((store) => store.save({ stdout: content, stderr: content }));
      for (const channel of ['stdout', 'stderr'] as const) {
        for (const maxBytes of [4, 5, 6]) {
          const file = stores[1]!.search(references[1]!, { channel, query: 'after', maxBytes });
          const memory = stores[0]!.search(references[0]!, { channel, query: 'after', maxBytes });
          assert.deepEqual(file, memory);
          assert.equal(file[0]?.line, 4);
          assert.equal(file[0]?.offset, 65_537, 'CRLF consumes two bytes in the raw offset even after earlier delimiters');
          assert.equal(Boolean(file[0]?.truncated), maxBytes < 5);
        }
        assert.deepEqual(stores[1]!.search(references[1]!, { channel, query: 'hit\r' }), [], 'the CRLF delimiter is not searchable line content');
        const repeatedCR = stores[1]!.search(references[1]!, { channel, query: 'repeat\r' });
        assert.deepEqual(repeatedCR, stores[0]!.search(references[0]!, { channel, query: 'repeat\r' }));
        assert.deepEqual(repeatedCR.map(({ line, offset, text }) => ({ line, offset, text })), [{ line: 5, offset: 65_543, text: 'repeat\r' }]);
        const bareCR = stores[1]!.search(references[1]!, { channel, query: 'other\rZ' });
        assert.deepEqual(bareCR, stores[0]!.search(references[0]!, { channel, query: 'other\rZ' }));
        assert.deepEqual(bareCR.map(({ line, offset, text }) => ({ line, offset, text })), [{ line: 6, offset: 65_552, text: 'other\rZ' }]);
        const eofCR = stores[1]!.search(references[1]!, { channel, query: 'end\r' });
        assert.deepEqual(eofCR, stores[0]!.search(references[0]!, { channel, query: 'end\r' }));
        assert.deepEqual(eofCR.map(({ line, offset, text }) => ({ line, offset, text })), [{ line: 7, offset: 65_560, text: 'end\r' }]);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves bounded context when committing an ordinary carried carriage return', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-search-carried-cr-context-'));
    try {
      const stores = [new InMemoryToolOutputStore(), new FileToolOutputStore(directory)];
      const eofReference = stores.map((store) => store.save({ stdout: 'hit\r', stderr: 'hit\r' }));
      for (const channel of ['stdout', 'stderr'] as const) {
        for (const query of ['hit', 'hit\r']) {
          const full = stores[1]!.search(eofReference[1]!, { channel, query, maxBytes: 64 });
          assert.deepEqual(full, stores[0]!.search(eofReference[0]!, { channel, query, maxBytes: 64 }));
          assert.deepEqual(full.map(({ text, truncated }) => ({ text, truncated })), [{ text: 'hit\r', truncated: undefined }]);
        }
        const exact = stores[1]!.search(eofReference[1]!, { channel, query: 'hit\r', maxBytes: 4 });
        assert.deepEqual(exact, stores[0]!.search(eofReference[0]!, { channel, query: 'hit\r', maxBytes: 4 }));
        assert.deepEqual(exact.map(({ text, truncated }) => ({ text, truncated })), [{ text: 'hit\r', truncated: undefined }]);
        const clipped = stores[1]!.search(eofReference[1]!, { channel, query: 'hit\r', maxBytes: 3 });
        assert.deepEqual(clipped, stores[0]!.search(eofReference[0]!, { channel, query: 'hit\r', maxBytes: 3 }));
        assert.deepEqual(clipped.map(({ text, truncated }) => ({ text, truncated })), [{ text: 'hit', truncated: true }]);
        assert.equal(stores[1]!.read(eofReference[1]!, { channel, length: 4 }).text, 'hit\r', 'search never changes raw artifact bytes');

        const boundaryContent = `prefix\n${'n'.repeat(65_524)}\nhit\rX\nafter\n`;
        assert.equal(Buffer.byteLength(boundaryContent.slice(0, boundaryContent.indexOf('hit') + 4), 'utf8'), 65_536);
        const boundaryReferences = stores.map((store) => store.save({ stdout: boundaryContent, stderr: boundaryContent }));
        const hit = stores[1]!.search(boundaryReferences[1]!, { channel, query: 'hit', maxBytes: 64 });
        assert.equal(stores[0]!.search(boundaryReferences[0]!, { channel, query: 'hit', maxBytes: 64 })[0]?.text, 'hit\rX',
          'memory scanner retains the context present in its single input chunk');
        assert.deepEqual(hit.map(({ line, offset, text, truncated }) => ({ line, offset, text, truncated })),
          [{ line: 3, offset: 65_532, text: 'hit\r', truncated: true }], 'a full-prefix frozen match may gain the carried CR but remains bounded before X');
        const endingCR = stores[1]!.search(boundaryReferences[1]!, { channel, query: 'hit\r', maxBytes: 64 });
        assert.deepEqual(endingCR, stores[0]!.search(boundaryReferences[0]!, { channel, query: 'hit\r', maxBytes: 64 }));
        assert.deepEqual(endingCR.map(({ text, truncated }) => ({ text, truncated })),
          [{ text: 'hit\rX', truncated: undefined }], 'without a frozen match, CR and following context stay coalesced');
        const following = stores[1]!.search(boundaryReferences[1]!, { channel, query: 'after', maxBytes: 64 });
        assert.deepEqual(following, stores[0]!.search(boundaryReferences[0]!, { channel, query: 'after', maxBytes: 64 }));
        assert.equal(following[0]?.offset, 65_538);

        const partialReference = stores.map((store) => store.save({ stdout: 'prefixhit\r', stderr: 'prefixhit\r' }));
        const partial = stores[1]!.search(partialReference[1]!, { channel, query: 'hit', maxBytes: 3 });
        assert.deepEqual(partial, stores[0]!.search(partialReference[0]!, { channel, query: 'hit', maxBytes: 3 }));
        assert.deepEqual(partial.map(({ text, truncated }) => ({ text, truncated })),
          [{ text: 'hit', truncated: true }], 'a bounded fragment missing its prefix is not extended with the adjacent CR');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects malformed UTF-16 queries before artifact access but preserves literal replacement characters', () => {
    const fileRoot = path.join(os.tmpdir(), `tachiko-malformed-query-${process.pid}-${Date.now()}`);
    let artifactOpens = 0;
    const fileStore = new FileToolOutputStore(fileRoot, { testFaults: { beforeArtifactOpen: () => { artifactOpens += 1; } } });
    const missing = { kind: 'tool-output', id: 'missing', stdoutBytes: 0, stderrBytes: 0, totalBytes: 0, sha256: '0'.repeat(64) } as const;
    const memoryStore = new InMemoryToolOutputStore();
    for (const query of ['\uD800', '\uDC00', '\uD800x', 'x\uDC00']) {
      assert.throws(() => fileStore.search(missing, { query }), /well-formed Unicode/);
      assert.throws(() => memoryStore.search(missing, { query }), /well-formed Unicode/);
    }
    assert.equal(artifactOpens, 0);
    assert.equal(existsSync(fileRoot), false, 'malformed input is rejected before File store path admission');

    const fileArtifact = fileStore.save({ stdout: 'literal �x astral 🙂', stderr: '' });
    const memoryArtifact = memoryStore.save({ stdout: 'literal �x astral 🙂', stderr: '' });
    assert.equal(fileStore.search(fileArtifact, { query: '�x' })[0]?.text.includes('�x'), true);
    assert.equal(memoryStore.search(memoryArtifact, { query: '�x' })[0]?.text.includes('�x'), true);
    assert.equal(fileStore.search(fileArtifact, { query: '🙂' })[0]?.text.includes('🙂'), true);
    assert.equal(memoryStore.search(memoryArtifact, { query: '🙂' })[0]?.text.includes('🙂'), true);
    rmSync(fileRoot, { recursive: true, force: true });
  });

  it('contains durable quota exhaustion while draining and returns bounded partial observations without an artifact', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-capture-quota-session-'));
    try {
      const store = new FileToolOutputStore(directory, { capacity: 1, captureMaxBytes: 3 });
      const operation = store.beginOperation({ kind: 'contained-quota-exhaustion' });
      const writer = operation.startCapture(policy);
      const session = new ContainedToolOutputCaptureSession(policy);
      session.write(writer, 'stdout', 'four');
      session.write(writer, 'stderr', 'also-drained');
      const result = session.finish(writer);
      assert.equal(result.status, 'partial');
      assert.equal(result.capture, undefined);
      assert.equal(result.stdout.bytes, 4);
      assert.equal(result.stderr.bytes, 12);
      assert.equal(result.stdout.preview, 'four');
      operation.abort();
      assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects over-limit policies before capture mutation and copies caller policy scalars', () => {
    const directory = path.join(os.tmpdir(), `tachiko-invalid-policy-${process.pid}-${Date.now()}`);
    const store = new FileToolOutputStore(directory);
    assert.throws(() => store.startCapture({ ...DEFAULT_TOOL_OUTPUT_POLICY, previewBytes: 65_537 }), /previewBytes.*maximum/);
    assert.equal(existsSync(directory), false, 'invalid standalone policy is rejected before root creation');
    assert.throws(() => validateToolOutputPolicy({ ...DEFAULT_TOOL_OUTPUT_POLICY, maxDiagnostics: 129 }), /maxDiagnostics.*maximum/);
    assert.throws(() => new ContainedToolOutputCaptureSession({ ...DEFAULT_TOOL_OUTPUT_POLICY, readBytes: 1_048_577 }), /readBytes.*maximum/);
    const operation = store.beginOperation({ kind: 'invalid-policy-before-capture-id' });
    const metadataPath = path.join(directory, 'operations', `${operation.id}.json`);
    assert.throws(() => operation.startCapture({ ...DEFAULT_TOOL_OUTPUT_POLICY, diagnosticBytes: 65_537 }), /diagnosticBytes.*maximum/);
    assert.deepEqual(JSON.parse(readFileSync(metadataPath, 'utf8')).activeCaptureIds, [], 'invalid operation policy is rejected before a prepared capture ID is written');
    assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
    operation.abort();
    const mutable = { previewBytes: 8, diagnosticBytes: 24, maxDiagnostics: 2, readBytes: 16 };
    const writer = new InMemoryToolOutputStore().startCapture(mutable);
    mutable.previewBytes = 65_536;
    writer.write('stdout', '0123456789abcdef');
    assert.equal(writer.finish().stdout.previewBytes, 8, 'capture keeps the validated scalar snapshot');
  });

  it('bounds retained diagnostic candidate strings and each priority bucket by UTF-8 bytes', () => {
    const capture = new ContainedToolOutputCaptureSession({ previewBytes: 8, diagnosticBytes: 24, maxDiagnostics: 4, readBytes: 8 });
    capture.write(undefined, 'stderr', `${'界'.repeat(2_000)} ERROR: ${'界'.repeat(2_000)}\n`);
    capture.write(undefined, 'stdout', `${'ordinary '.repeat(2_000)}\n`);
    const result = capture.finish(undefined);
    assert.ok(result.diagnostics.every((line) => Buffer.byteLength(line, 'utf8') <= 24));
    assert.ok(result.diagnostics.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) <= 24);
    assert.equal(result.diagnosticsTruncated, true);
  });

  it('accounts for joined diagnostic separators across buffered, file, and partial observations', () => {
    const diagnosticPolicy = { previewBytes: 8, diagnosticBytes: 65_536, maxDiagnostics: 2, readBytes: 8 };
    const line = `ERROR: ${'x'.repeat(32_761)}`;
    assert.equal(Buffer.byteLength(line), 32_768);

    const direct = boundToolOutput({ outcome: 'failed', exitCode: 1, stderr: line, stdout: line,
      store: new InMemoryToolOutputStore(), policy: diagnosticPolicy });
    assert.equal(Buffer.byteLength(direct.diagnostics.join('\n')), 65_536);
    assert.equal(direct.overflow.diagnostics, true);
    assert.equal(isToolOutputEnvelope(direct), true);

    const bufferedStore = new InMemoryToolOutputStore();
    const buffered = bufferedStore.startCapture(diagnosticPolicy);
    buffered.write('stderr', line);
    buffered.write('stdout', line);
    const bufferedEnvelope = boundToolOutputFromCapture({ outcome: 'failed', exitCode: 1,
      capture: buffered.finish(), policy: diagnosticPolicy });
    assert.equal(Buffer.byteLength(bufferedEnvelope.diagnostics.join('\n')), 65_536);
    assert.equal(isToolOutputEnvelope(bufferedEnvelope), true);

    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-diagnostic-joined-bound-'));
    try {
      const fileStore = new FileToolOutputStore(root);
      const file = fileStore.startCapture(diagnosticPolicy);
      file.write('stderr', line);
      file.write('stdout', line);
      const fileEnvelope = boundToolOutputFromCapture({ outcome: 'failed', exitCode: 1,
        capture: file.finish(), policy: diagnosticPolicy });
      assert.equal(Buffer.byteLength(fileEnvelope.diagnostics.join('\n')), 65_536);
      assert.equal(isToolOutputEnvelope(fileEnvelope), true);
    } finally { rmSync(root, { recursive: true, force: true }); }

    const unavailable = new ContainedToolOutputCaptureSession(diagnosticPolicy);
    unavailable.write(undefined, 'stderr', line);
    unavailable.write(undefined, 'stdout', line);
    const unavailableResult = unavailable.finish(undefined);
    assert.equal(unavailableResult.status, 'unavailable');
    assert.equal(Buffer.byteLength(unavailableResult.diagnostics.join('\n')), 65_536);
    assert.equal(unavailableResult.diagnosticsTruncated, true);

    const partial = new ContainedToolOutputCaptureSession(diagnosticPolicy);
    const failingWriter = { write: () => undefined, finish: () => { throw new Error('sink failed'); }, abort: () => undefined };
    partial.write(failingWriter, 'stderr', line);
    partial.write(failingWriter, 'stdout', line);
    const partialResult = partial.finish(failingWriter);
    assert.equal(partialResult.status, 'partial');
    assert.equal(Buffer.byteLength(partialResult.diagnostics.join('\n')), 65_536);
    assert.equal(partialResult.diagnosticsTruncated, true);
  });

  it('keeps an exact single diagnostic line and marks omitted UTF-8 scalars truthfully', () => {
    const exactLine = `ERROR: ${'x'.repeat(65_529)}`;
    const exact = boundToolOutput({ outcome: 'failed', exitCode: 1, stderr: exactLine, stdout: '',
      store: new InMemoryToolOutputStore(), policy: { previewBytes: 8, diagnosticBytes: 65_536, maxDiagnostics: 2, readBytes: 8 } });
    assert.equal(Buffer.byteLength(exact.diagnostics[0] ?? ''), 65_536);
    assert.equal(exact.overflow.diagnostics, false);
    assert.equal(isToolOutputEnvelope(exact), true);

    const tiny = new ContainedToolOutputCaptureSession({ previewBytes: 1, diagnosticBytes: 2, maxDiagnostics: 1, readBytes: 1 });
    tiny.write(undefined, 'stderr', '界');
    const omitted = tiny.finish(undefined);
    assert.deepEqual(omitted.diagnostics, []);
    assert.equal(omitted.diagnosticsTruncated, true);
  });

  it('enforces each declared envelope payload limit and preserves exact UTF-8 boundaries', () => {
    const base = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'xy', stderr: '',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 1, diagnosticBytes: 1, maxDiagnostics: 1, readBytes: 1 } });
    assert.equal(isToolOutputEnvelope(base), true);

    const invalid = (mutate: (envelope: any) => void) => {
      const envelope = structuredClone(base) as any;
      mutate(envelope);
      return envelope;
    };
    const overPreview = invalid((envelope) => {
      envelope.stdout.preview = 'xy';
      envelope.stdout.previewBytes = Buffer.byteLength(envelope.stdout.preview);
      envelope.overflow.retainedBytes = envelope.stdout.previewBytes + envelope.stderr.previewBytes;
      envelope.overflow.omittedBytes = Math.max(0, envelope.overflow.totalBytes - envelope.overflow.retainedBytes);
    });
    const overSummary = invalid((envelope) => { envelope.summary = 'x'.repeat(65_537); });
    const overDiagnosticBytes = invalid((envelope) => { envelope.diagnostics = ['xx']; });
    const overJoinedDiagnosticBytes = invalid((envelope) => {
      envelope.overflow.diagnosticLimitBytes = 2;
      envelope.overflow.diagnosticLimitLines = 2;
      envelope.diagnostics = ['x', 'x'];
    });
    const overDiagnosticLines = invalid((envelope) => {
      envelope.overflow.diagnosticLimitBytes = 4;
      envelope.diagnostics = ['x', 'x'];
    });
    const previewExceedsStreamBytes = invalid((envelope) => {
      envelope.stdout.preview = 'xy';
      envelope.stdout.previewBytes = Buffer.byteLength(envelope.stdout.preview);
      envelope.stdout.bytes = 1;
      envelope.overflow.previewLimitBytes = 4;
      envelope.overflow.retainedBytes = envelope.stdout.previewBytes + envelope.stderr.previewBytes;
      envelope.overflow.omittedBytes = Math.max(0, envelope.overflow.totalBytes - envelope.overflow.retainedBytes);
    });
    const mismatchedStreamBytes = invalid((envelope) => { envelope.stdout.bytes += 1; });
    const falseStdoutTruncation = invalid((envelope) => {
      envelope.stdout.truncated = false;
      envelope.overflow.stdout = false;
      envelope.overflow.truncated = envelope.overflow.capture || envelope.overflow.summary || envelope.overflow.diagnostics ||
        envelope.overflow.stdout || envelope.overflow.stderr;
    });
    const falseStderrTruncation = invalid((envelope) => {
      envelope.stderr.bytes = 2;
      envelope.artifact.stderrBytes = 2;
      envelope.artifact.totalBytes = envelope.artifact.stdoutBytes + envelope.artifact.stderrBytes;
      envelope.overflow.totalBytes = envelope.artifact.totalBytes;
      envelope.overflow.omittedBytes = envelope.overflow.totalBytes - envelope.overflow.retainedBytes;
      envelope.stderr.truncated = false;
      envelope.overflow.stderr = false;
    });
    const linkedTruncationMismatch = invalid((envelope) => {
      envelope.stdout.bytes = 1;
      envelope.artifact.stdoutBytes = 1;
      envelope.artifact.totalBytes = envelope.artifact.stdoutBytes + envelope.artifact.stderrBytes;
      envelope.overflow.totalBytes = envelope.artifact.totalBytes;
      envelope.overflow.retainedBytes = envelope.stdout.previewBytes + envelope.stderr.previewBytes;
      envelope.overflow.omittedBytes = Math.max(0, envelope.overflow.totalBytes - envelope.overflow.retainedBytes);
      envelope.stdout.truncated = false;
      // Keep overflow.stdout true to verify the existing channel linkage check.
    });
    for (const [kind, envelope] of [
      ['preview', overPreview], ['summary', overSummary], ['diagnostic bytes', overDiagnosticBytes],
      ['joined diagnostic bytes including LF', overJoinedDiagnosticBytes], ['diagnostic lines', overDiagnosticLines],
      ['preview larger than stream bytes', previewExceedsStreamBytes], ['stream/artifact size', mismatchedStreamBytes],
      ['stdout over declared limit without truncation', falseStdoutTruncation],
      ['stderr over declared limit without truncation', falseStderrTruncation],
      ['channel truncation flag contradicts overflow linkage', linkedTruncationMismatch],
    ] as const) {
      assert.equal(isToolOutputEnvelope(envelope), false, `${kind} beyond its declared envelope contract is rejected`);
    }

    const exact = boundToolOutput({ outcome: 'failed', exitCode: 1, stdout: 'ERROR!', stderr: '', summary: '界界',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 6, diagnosticBytes: 6, maxDiagnostics: 1, readBytes: 1 } });
    assert.equal(Buffer.byteLength(exact.stdout.preview), 6);
    assert.equal(Buffer.byteLength(exact.summary), 6);
    assert.deepEqual(exact.diagnostics, ['ERROR!']);
    assert.equal(isToolOutputEnvelope(exact), true, 'exact preview, summary, joined diagnostic bytes, and line count are admitted');

    const tinyScalar = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: '界', stderr: '',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 1, diagnosticBytes: 1, maxDiagnostics: 1, readBytes: 1 } });
    assert.equal(isToolOutputEnvelope(tinyScalar), true, 'legitimate tiny UTF-8 producer output remains coherent');

    const exactStreams = boundToolOutput({ outcome: 'passed', exitCode: 0, stdout: 'x', stderr: 'y',
      store: new InMemoryToolOutputStore(),
      policy: { previewBytes: 1, diagnosticBytes: 1, maxDiagnostics: 1, readBytes: 1 } });
    assert.equal(exactStreams.stdout.truncated, false);
    assert.equal(exactStreams.stderr.truncated, false);
    assert.equal(isToolOutputEnvelope(exactStreams), true, 'both streams at the declared boundary may remain untruncated');

    const retainedBelowDeclaredMaximum = structuredClone(base) as any;
    retainedBelowDeclaredMaximum.overflow.previewLimitBytes = 65_536;
    assert.equal(retainedBelowDeclaredMaximum.stdout.bytes, 2);
    assert.equal(retainedBelowDeclaredMaximum.stdout.truncated, true);
    assert.equal(isToolOutputEnvelope(retainedBelowDeclaredMaximum), true,
      'a producer may report a narrower retained preview while the declared maximum is larger');
  });

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
      let artifactPath = '';
      let replacementPath = '';
      let mutated = false;
      const store = new FileToolOutputStore(directory, { testFaults: {
        beforeArtifactOpen: (at, channel) => {
          if (at !== kind || channel !== 'stdout' || mutated) return;
          mutated = true;
          renameSync(replacementPath, artifactPath);
        },
      } });
      try {
        const artifact = store.save({ stdout: 'safe', stderr: '' });
        artifactId = artifact.id;
        artifactPath = path.join(directory, `${artifactId}.stdout`);
        replacementPath = `${artifactPath}.replacement-${process.pid}`;
        const original = lstatSync(artifactPath, { bigint: true });
        assert.equal(original.dev.toString(), artifact.fileIdentity!.stdout.dev, `${kind}: original device matches the admitted artifact identity`);
        assert.equal(original.ino.toString(), artifact.fileIdentity!.stdout.ino, `${kind}: original inode matches the admitted artifact identity`);
        assert.equal(original.size, BigInt(artifact.stdoutBytes), `${kind}: original size matches the admitted artifact identity`);
        assert.equal(readFileSync(artifactPath, 'utf8'), 'safe', `${kind}: original content is committed before replacement setup`);

        // Keep the admitted allocation alive while creating the replacement,
        // so the filesystem cannot recycle its inode for this same-length file.
        writeFileSync(replacementPath, 'evil', { flag: 'wx', mode: 0o600 });
        const stillOriginal = lstatSync(artifactPath, { bigint: true });
        assert.equal(stillOriginal.dev, original.dev, `${kind}: original allocation remains present during replacement creation`);
        assert.equal(stillOriginal.ino, original.ino, `${kind}: original inode remains allocated during replacement creation`);
        const replacement = lstatSync(replacementPath, { bigint: true });
        assert.equal(replacement.size, original.size, `${kind}: replacement has the same length as the original`);
        assert.equal(readFileSync(replacementPath, 'utf8'), 'evil');
        assert.ok(replacement.dev !== original.dev || replacement.ino !== original.ino,
          `${kind}: replacement generation differs while both allocations exist`);

        assert.throws(() => kind === 'read'
          ? store.read(artifact, { channel: 'stdout', offset: 0, length: 4 })
          : store.search(artifact, { channel: 'stdout', query: 'evil' }), /unavailable|identity|size/i);
        assert.equal(mutated, true);
        const installed = lstatSync(artifactPath, { bigint: true });
        assert.equal(installed.dev, replacement.dev, `${kind}: the seam installed the precreated replacement device`);
        assert.equal(installed.ino, replacement.ino, `${kind}: the seam installed the precreated replacement inode`);
        assert.equal(installed.size, original.size, `${kind}: installed replacement remains same-sized`);
        assert.equal(readFileSync(artifactPath, 'utf8'), 'evil', `${kind}: substituted content was not adopted by the read/search operation`);
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
          { offset: 5, length: 1_048_576, actual: 4, text: '🙂e\u0301B', next: 12 },
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
          chmodSync(safeRoot, 0o700);
          const operationsTarget = path.join(directory, 'operations-target');
          mkdirSync(operationsTarget);
          symlinkSync(operationsTarget, path.join(safeRoot, 'operations'), 'dir');
          assert.throws(() => store.beginOperation({ kind: 'symlink-test' }), /symlink/);
          assert.deepEqual(readdirSync(operationsTarget), [], 'refusal creates no operation metadata under the symlink target');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: rejects unrepresentable retention deadlines before admission and keeps an overflowing close abortable', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-retention-deadline-'));
        try {
          const absentRoot = path.join(directory, 'absent');
          assert.throws(() => new FileToolOutputStore(absentRoot, { retentionMs: Number.MAX_SAFE_INTEGER }), /retention deadline.*representable/i);
          assert.equal(existsSync(absentRoot), false, 'an invalid configured deadline is refused before root creation');
          assert.throws(() => new FileToolOutputStore(absentRoot, { retentionMs: 1, now: () => new Date(Number.NaN) }), /valid date|representable/i);
          assert.equal(existsSync(absentRoot), false, 'an invalid injected clock is refused before root creation');

          const maxDateTime = 8.64e15;
          const atBoundary = new FileToolOutputStore(path.join(directory, 'boundary'), {
            capacity: 1, retentionMs: 1_000, now: () => new Date(maxDateTime - 1_000),
          });
          const boundaryReference = atBoundary.save({ stdout: 'upper date boundary', stderr: '' });
          assert.equal(boundaryReference.retainedUntil, new Date(maxDateTime).toISOString(), 'the inclusive ECMAScript date boundary remains valid');
          assert.throws(() => new FileToolOutputStore(path.join(directory, 'past-boundary'), {
            retentionMs: 1_001, now: () => new Date(maxDateTime - 1_000),
          }), /retention deadline.*representable/i);

          let now = new Date('2030-01-01T00:00:00.000Z');
          const root = path.join(directory, 'advancing-clock');
          const store = new FileToolOutputStore(root, { capacity: 1, retentionMs: 1_000, now: () => now });
          const operation = store.beginOperation({ kind: 'retention-deadline-overflow' });
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
          writer.write('stdout', 'abortable evidence');
          writer.finish();
          now = new Date(maxDateTime - 500);
          assert.throws(() => operation.close(), /retention deadline.*representable/i);
          operation.abort();
          const metadataPath = path.join(root, 'operations', `${operation.id}.json`);
          const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly state: string; readonly retainedUntil?: string; readonly artifacts?: readonly unknown[] };
          assert.equal(metadata.state, 'aborted', 'a rejected close leaves the operation available for cleanup');
          assert.equal(metadata.retainedUntil, undefined, 'no invalid closed deadline is persisted');
          assert.deepEqual(metadata.artifacts, [], 'no artifact reference is published after the rejected close');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: aborts standalone captures when a close deadline is refused before terminal intent', () => {
        for (const mode of ['standalone', 'contained'] as const) {
          const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-output-retention-${mode}-`));
          try {
            let now = new Date('2030-01-01T00:00:00.000Z');
            const root = path.join(directory, 'evidence');
            const store = new FileToolOutputStore(root, { capacity: 1, retentionMs: 1_000, now: () => now });
            const writer = store.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);

            if (mode === 'standalone') {
              writer.write('stdout', 'standalone retention refusal');
              now = new Date(8.64e15 - 500);
              assert.throws(() => writer.finish(), /retention deadline.*representable/i);
            } else {
              const session = new ContainedToolOutputCaptureSession(DEFAULT_TOOL_OUTPUT_POLICY);
              session.write(writer, 'stdout', 'standalone retention refusal');
              now = new Date(8.64e15 - 500);
              const result = session.finish(writer);
              assert.equal(result.status, 'partial');
              assert.equal(result.capture, undefined, 'a refused deadline cannot publish a reference');
            }

            const operations = path.join(root, 'operations');
            const operationFiles = readdirSync(operations).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
            assert.equal(operationFiles.length, 1);
            const metadata = JSON.parse(readFileSync(path.join(operations, operationFiles[0]!), 'utf8')) as {
              readonly state: string; readonly retainedUntil?: string; readonly artifacts?: readonly unknown[];
            };
            assert.equal(metadata.state, 'aborted', 'standalone cleanup records an abort instead of an invalid closed record');
            assert.equal(metadata.retainedUntil, undefined);
            assert.deepEqual(metadata.artifacts, []);
            assert.deepEqual(readdirSync(root).filter((name) => /\.(stdout|stderr)$/.test(name)), [], 'both raw stream files are removed');
            assert.deepEqual(readdirSync(operations).filter((name) => name.endsWith('.lock')), [], 'the operation owner is released');

            now = new Date('2030-01-01T00:00:00.000Z');
            const reusable = store.beginOperation({ kind: 'after-standalone-retention-refusal' });
            reusable.abort();
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
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

      it('file: preserves the original public release timestamp across an unpinned admission retry', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-admission-snapshot-'));
        try {
          let now = new Date('2030-04-05T06:07:08.000Z');
          let failPin = true;
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => now, testFaults: {
            beforePreparedOwnerOpen: () => { if (failPin) throw Object.assign(new Error('prepared owner pin EIO'), { code: 'EIO' }); },
          } });
          const operation = store.beginOperation({ kind: 'release-admission-snapshot' });
          const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'release snapshot'); writer.finish();
          const reference = operation.close()[0]!;
          assert.throws(() => store.release(reference), /prepared owner pin EIO/);
          now = new Date('2030-04-06T06:07:08.000Z');
          failPin = false;
          store.release(reference);
          const metadata = JSON.parse(readFileSync(path.join(directory, 'operations', `${operation.id}.json`), 'utf8')) as { readonly state: string; readonly releasedAt?: string };
          assert.equal(metadata.state, 'released');
          assert.equal(metadata.releasedAt, '2030-04-05T06:07:08.000Z', 'retry completes the original consent snapshot without calling now() again');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: bounds stale-owner release reacquisition by the current deletion budget', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-reacquire-stale-budget-'));
        try {
          const moduleUrl = new URL('../src/dispatch/invocation-lock.ts', import.meta.url).href;
          let failPin = true;
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-05-06T07:08:09.000Z'), testFaults: {
            beforePreparedOwnerOpen: () => { if (failPin) throw Object.assign(new Error('release reacquire pin EIO'), { code: 'EIO' }); },
          } });
          const artifact = store.save({ stdout: 'stale release reacquisition', stderr: '' });
          assert.throws(() => store.release(artifact), /release reacquire pin EIO/);
          failPin = false;
          const metadataPath = path.join(directory, 'operations', `${artifact.operationId}.json`);
          const originalMetadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { readonly ownerNonce: string };
          const originalReleasedAt = '2030-05-06T07:08:09.000Z';
          const lockPath = path.join(directory, 'operations', `${artifact.operationId}.lock`);
          const childSource = `const m = await import(${JSON.stringify(moduleUrl)}); const { acquireDispatchInvocationLock } = m.acquireDispatchInvocationLock ? m : m.default; acquireDispatchInvocationLock({ lockPath: ${JSON.stringify(lockPath)}, nonce: () => ${JSON.stringify(originalMetadata.ownerNonce)} });`;
          execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], { cwd: process.cwd() });

          const short = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 1, maxMetadataReadBytes: 1_048_576 });
          assert.equal(short.protected, 1, 'one deletion cannot pay for stale takeover and replacement-owner disposal');
          assert.equal(short.attempted, 0);
          assert.equal(existsSync(lockPath), true, 'the dead same-nonce owner stays in place when admission is refused');
          assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).state, 'closed', 'refused admission has not written the release snapshot');

          const recovered = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8, maxMetadataReadBytes: 1_048_576 });
          assert.equal(recovered.protected, 0);
          assert.equal(recovered.attempted, 2, 'stale owner unlink and acquired-owner disposal are both charged');
          assert.equal(recovered.deleted, 2);
          assert.equal(existsSync(lockPath), false);
          if (existsSync(metadataPath)) {
            assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).releasedAt, originalReleasedAt,
              'a retained metadata record keeps the original release timestamp');
          }

          const reclaimed = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8, maxMetadataReadBytes: 1_048_576 });
          assert.equal(reclaimed.protected, 0);
          assert.equal(existsSync(path.join(directory, `${artifact.id}.stdout`)), false);
          const successor = store.beginOperation({ kind: 'release-reacquire-budget-reuse' });
          successor.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: refuses release reacquisition after rollback consumes the caller deletion budget', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-release-reacquire-depleted-budget-'));
        try {
          let failTemporaryUnlink = true;
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-06-07T08:09:10.000Z'), testFaults: {
            beforeOwnerLockTemporaryUnlink: () => {
              if (failTemporaryUnlink) throw Object.assign(new Error('release temporary cleanup EIO'), { code: 'EIO' });
            },
          } });
          const artifact = store.save({ stdout: 'depleted release reacquisition', stderr: '' });
          const metadataPath = path.join(directory, 'operations', `${artifact.operationId}.json`);
          const lockPath = path.join(directory, 'operations', `${artifact.operationId}.lock`);
          assert.throws(() => store.release(artifact), /release temporary cleanup EIO/);
          const releasedAt = '2030-06-07T08:09:10.000Z';
          failTemporaryUnlink = false;

          const short = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 2, maxMetadataReadBytes: 1_048_576 });
          assert.equal(short.protected, 1, 'rollback cleanup uses both current deletion attempts before reacquisition');
          assert.equal(short.attempted, 2);
          assert.equal(short.deleted, 2);
          assert.equal(existsSync(lockPath), false, 'exhausted recovery does not publish another owner');
          assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).state, 'closed', 'rollback-budget refusal has not published a replacement owner or consent metadata');

          const recovered = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8, maxMetadataReadBytes: 1_048_576 });
          assert.equal(recovered.protected, 0);
          assert.equal(recovered.attempted, 1, 'a later caller can acquire and dispose within its own budget');
          assert.equal(recovered.deleted, 1);
          assert.equal(existsSync(lockPath), false);
          if (existsSync(metadataPath)) assert.equal(JSON.parse(readFileSync(metadataPath, 'utf8')).releasedAt, releasedAt);
          for (let pass = 0; pass < 4 && existsSync(path.join(directory, `${artifact.id}.stdout`)); pass += 1) {
            const result = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8, maxMetadataReadBytes: 1_048_576 });
            assert.ok(result.attempted <= 8);
          }
          assert.equal(existsSync(path.join(directory, `${artifact.id}.stdout`)), false);
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
          assert.equal(readdirSync(directory).filter((name) => /\.(stdout|stderr)$/.test(name)).length, 2,
            'a genuine close-pending failure keeps committed bytes while the frozen close is retried');
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

      it('file: retained cleanup retries charge every nested read to the current caller budget', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-current-read-budget-'));
        try {
          const old = new Date('2000-01-01T00:00:00.000Z');
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1, now: () => old })
            .save({ stdout: 'retained-read-budget', stderr: '' });
          const lockPath = path.join(directory, 'operations', `${artifact.operationId}.lock`);
          let failOwnerUnlink = true;
          const firstStore = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'), testFaults: {
            beforeOwnerLockUnlink: (candidate) => {
              if (candidate.endsWith(`${artifact.operationId}.lock`) && failOwnerUnlink) {
                failOwnerUnlink = false;
                throw Object.assign(new Error('retained read-budget owner unlink EIO'), { code: 'EIO' });
              }
            },
          } });
          const firstResult = firstStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
          assert.equal(firstResult.protected, 1, `${JSON.stringify(firstResult)} failOwnerUnlink=${failOwnerUnlink}`);
          assert.equal(failOwnerUnlink, false);
          const operations = path.join(directory, 'operations');
          const indexBytes = readFileSync(path.join(operations, 'index.json')).byteLength;
          const slotBytes = readFileSync(path.join(operations, 'slot-0000.json')).byteLength;
          const ownerBytes = readFileSync(lockPath).byteLength;
          const metadataBytes = readFileSync(path.join(operations, `${artifact.operationId}.json`)).byteLength;
          const currentReadBudget = indexBytes + slotBytes + (2 * ownerBytes) + metadataBytes + slotBytes;
          const retryStore = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') });
          let retryError: unknown;
          try { retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: currentReadBudget, maxDeletions: 8 }); }
          catch (error) { retryError = error; }
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')),
            `the current read limit must leave a discoverable tombstone; error=${String(retryError)} budget=${currentReadBudget}`);
          const recovered = retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
          assert.ok(recovered.attempted <= 8);
          assert.equal(existsSync(path.join(operations, 'slot-0000.json')), false, 'a later larger current budget resumes the same pinned continuation');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: retained cleanup retries enforce the current per-operation metadata cap', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-current-cleanup-metadata-cap-'));
        try {
          const old = new Date('2000-01-01T00:00:00.000Z');
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1, now: () => old })
            .save({ stdout: 'retained-cleanup-metadata-cap', stderr: '' });
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, `${artifact.operationId}.json`);
          assert.ok(readFileSync(metadataPath).byteLength > 64);
          let failOwnerUnlink = true;
          const firstStore = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'), testFaults: {
            beforeOwnerLockUnlink: (candidate) => {
              if (candidate.endsWith(`${artifact.operationId}.lock`) && failOwnerUnlink) {
                failOwnerUnlink = false;
                throw Object.assign(new Error('metadata-cap cleanup owner unlink EIO'), { code: 'EIO' });
              }
            },
          } });
          assert.equal(firstStore.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 }).protected, 1);
          const retryStore = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') });
          const limited = retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 64, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
          assert.equal(limited.protected, 1);
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')), 'the current smaller cap preserves cleanup debt');
          retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 65_536, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: retained release retries enforce the current per-operation metadata cap', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-current-release-metadata-cap-'));
        try {
          const now = new Date('2030-01-01T00:00:00.000Z');
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 60_000, now: () => now })
            .save({ stdout: 'retained-release-metadata-cap', stderr: '' });
          const operations = path.join(directory, 'operations');
          const metadataPath = path.join(operations, `${artifact.operationId}.json`);
          assert.ok(readFileSync(metadataPath).byteLength > 64);
          let failMetadataSync = true;
          const releaseStore = new FileToolOutputStore(directory, { capacity: 1, now: () => now, testFaults: {
            beforeOperationMetadataDirectoryFsync: (value) => {
              if ((value as { readonly state?: string }).state === 'released' && failMetadataSync) {
                failMetadataSync = false;
                throw Object.assign(new Error('metadata-cap release directory fsync EIO'), { code: 'EIO' });
              }
            },
          } });
          assert.throws(() => releaseStore.release(artifact), /metadata-cap release directory fsync EIO/);
          const lockPath = path.join(operations, `${artifact.operationId}.lock`);
          const retryStore = new FileToolOutputStore(directory, { capacity: 1, now: () => now });
          const limited = retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 64, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
          assert.equal(limited.protected, 1);
          assert.ok(existsSync(lockPath), 'the too-small current cap cannot commit release owner disposal');
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')));
          retryStore.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 65_536, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: refuses cleanup owner admission before a low read budget can strand an unregistered lock', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-owner-admission-read-budget-'));
        try {
          const old = new Date('2000-01-01T00:00:00.000Z');
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1, now: () => old })
            .save({ stdout: 'owner-admission-read-budget', stderr: '' });
          const operations = path.join(directory, 'operations');
          const indexBytes = readFileSync(path.join(operations, 'index.json')).byteLength;
          const slotBytes = readFileSync(path.join(operations, 'slot-0000.json')).byteLength;
          const metadataBytes = readFileSync(path.join(operations, `${artifact.operationId}.json`)).byteLength;
          const cleanupLock = path.join(operations, `${artifact.operationId}.lock`);
          let unlinkAttempted = false;
          const store = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'), testFaults: {
            beforeOwnerLockUnlink: (candidate) => {
              if (candidate === cleanupLock) {
                unlinkAttempted = true;
                throw Object.assign(new Error('low-budget owner unlink EIO'), { code: 'EIO' });
              }
            },
          } });
          let result: ReturnType<typeof store.cleanupExpired> | undefined;
          let admissionError: unknown;
          try { result = store.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: indexBytes + slotBytes + metadataBytes + 1, maxDeletions: 8 }); }
          catch (error) { admissionError = error; }
          if (admissionError !== undefined) assert.match(String(admissionError), /metadata-read budget exhausted/);
          else assert.equal(result?.protected, 1);
          assert.equal(unlinkAttempted, false, 'budget refusal happens before creating or disposing a cleanup owner');
          assert.equal(existsSync(cleanupLock), false, 'no unregistered live cleanup owner is left behind');
          assert.ok(existsSync(path.join(operations, 'slot-0000.json')));
          assert.ok(existsSync(path.join(directory, `${artifact.id}.stdout`)));
          const recovered = store.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 65_536, maxDeletions: 8 });
          assert.ok(recovered.attempted <= 8);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: refuses publication when the prepared owner no-follow open fails, then recovers on a later pass', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-prepared-open-failure-'));
        try {
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1,
            now: () => new Date('2000-01-01T00:00:00.000Z') }).save({ stdout: 'prepared-open', stderr: '' });
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `import fs from 'node:fs';
            const root = ${JSON.stringify(directory)}; const operationId = ${JSON.stringify(artifact.operationId)};
            const lockPath = root + '/operations/' + operationId + '.lock';
            let armed = true; let injected = false; let unlinkAttempts = 0;
            const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)});
            const store = new FileToolOutputStore(root, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'),
              testFaults: {
                beforeOwnerLockUnlink: (candidate) => { if (candidate === lockPath) unlinkAttempts += 1; },
                beforePreparedOwnerOpen: (temporaryPath) => {
                  if (!armed || injected) return;
                  injected = true; fs.unlinkSync(temporaryPath); fs.symlinkSync(temporaryPath, temporaryPath);
                },
              } });
            const metadataPath = root + '/operations/' + operationId + '.json';
            const metadataBefore = fs.readFileSync(metadataPath, 'utf8');
            const slotPath = root + '/operations/slot-0000.json'; const slotBefore = fs.readFileSync(slotPath, 'utf8');
            const unlinkAttemptsBeforeFirst = unlinkAttempts;
            const first = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            const unlinkAttemptsAfterFirst = unlinkAttempts;
            const canonicalAbsent = !fs.existsSync(lockPath);
            const temporaryAliases = fs.readdirSync(root + '/operations').filter((name) => name.startsWith(operationId + '.lock.tmp-'));
            const metadataUnchanged = fs.existsSync(metadataPath) && fs.readFileSync(metadataPath, 'utf8') === metadataBefore;
            const slotUnchanged = fs.existsSync(slotPath) && fs.readFileSync(slotPath, 'utf8') === slotBefore;
            const artifactExistsAfterFirst = fs.existsSync(root + '/' + ${JSON.stringify(artifact.id)} + '.stdout');
            armed = false;
            const second = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            const unlinkAttemptsAfterSecond = unlinkAttempts;
            console.log(JSON.stringify({ injected, unlinkAttemptsBeforeFirst, unlinkAttemptsAfterFirst, unlinkAttemptsAfterSecond,
              first, second, canonicalAbsent, temporaryAliases, metadataUnchanged, slotUnchanged,
              artifactExistsAfterFirst }));
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as {
            readonly injected: boolean; readonly unlinkAttemptsBeforeFirst: number;
            readonly unlinkAttemptsAfterFirst: number; readonly unlinkAttemptsAfterSecond: number;
            readonly first: { readonly attempted: number; readonly protected: number }; readonly second: { readonly protected: number };
            readonly canonicalAbsent: boolean; readonly temporaryAliases: readonly string[];
            readonly metadataUnchanged: boolean; readonly slotUnchanged: boolean; readonly artifactExistsAfterFirst: boolean;
          };
          assert.equal(result.injected, true, `the actual temporary no-follow open failed before canonical publication: ${JSON.stringify(result)}`);
          assert.equal(result.unlinkAttemptsBeforeFirst, 0, 'no owner-disposal callback has fired before the faulted first pass');
          assert.equal(result.unlinkAttemptsAfterFirst, result.unlinkAttemptsBeforeFirst,
            `the pre-publication failure pass cannot attempt owner disposal: ${JSON.stringify(result)}`);
          assert.equal(result.unlinkAttemptsAfterFirst - result.unlinkAttemptsBeforeFirst, 0,
            `the pre-publication failure pass cannot attempt owner disposal: ${JSON.stringify(result)}`);
          assert.equal(result.first.attempted, 0, 'the pre-publication refusal consumes no deletion attempt');
          assert.equal(result.first.protected, 1);
          assert.equal(result.canonicalAbsent, true);
          assert.deepEqual(result.temporaryAliases, []);
          assert.equal(result.metadataUnchanged, true);
          assert.equal(result.slotUnchanged, true);
          assert.equal(result.artifactExistsAfterFirst, true, 'the no-follow open fault preserves evidence before a later recovery pass');
          assert.equal(result.second.protected, 0);
          assert.ok(result.unlinkAttemptsAfterSecond >= result.unlinkAttemptsAfterFirst,
            'the separate recovery-phase counter includes any legitimate later owner disposal');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: retains a published owner anchor through temporary-alias unlink failure and retries the exact alias', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-prepared-temp-unlink-'));
        try {
          const artifact = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1,
            now: () => new Date('2000-01-01T00:00:00.000Z') }).save({ stdout: 'temporary-unlink', stderr: '' });
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `import fs from 'node:fs';
            const root = ${JSON.stringify(directory)}; const operationId = ${JSON.stringify(artifact.operationId)};
            const lockPath = root + '/operations/' + operationId + '.lock';
            let armed = false; let injected = false; let temporaryPath = ''; let temporaryHookCalls = 0; let candidateSeen = '';
            const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)});
            const store = new FileToolOutputStore(root, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z'), testFaults: {
              beforeOwnerLockTemporaryUnlink: (candidate, temporary) => {
                temporaryHookCalls += 1;
                candidateSeen = candidate;
                if (armed && !injected && candidate.endsWith(operationId + '.lock')) {
                  injected = true; temporaryPath = temporary;
                  throw Object.assign(new Error('prepared temporary alias unlink EIO'), { code: 'EIO' });
                }
              },
            } });
            armed = true;
            const first = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            armed = false;
            const ownerHeld = fs.existsSync(lockPath);
            const exactTemporaryHeld = temporaryPath !== '' && fs.existsSync(temporaryPath);
            const second = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            const ownerReleased = !fs.existsSync(lockPath);
            const exactTemporaryRemoved = temporaryPath !== '' && !fs.existsSync(temporaryPath);
            const third = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
            console.log(JSON.stringify({ injected, temporaryHookCalls, candidateSeen, lockPath, first, second, third, ownerHeld, exactTemporaryHeld, ownerReleased, exactTemporaryRemoved,
              artifactExists: fs.existsSync(root + '/' + ${JSON.stringify(artifact.id)} + '.stdout') }));
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as {
            readonly injected: boolean; readonly temporaryHookCalls: number; readonly candidateSeen: string; readonly lockPath: string; readonly first: { readonly protected: number };
            readonly second: { readonly attempted: number }; readonly third: { readonly protected: number; readonly attempted: number };
            readonly ownerHeld: boolean; readonly exactTemporaryHeld: boolean;
            readonly ownerReleased: boolean; readonly exactTemporaryRemoved: boolean; readonly artifactExists: boolean;
          };
          assert.equal(result.injected, true, `the post-publication temp unlink fault was reached: ${JSON.stringify(result)}`);
          assert.equal(result.first.protected, 1);
          assert.equal(result.ownerHeld, true, 'the linked owner remains anchored after post-link temp cleanup failure');
          assert.equal(result.exactTemporaryHeld, true);
          assert.ok(result.second.attempted <= 8);
          assert.equal(result.ownerReleased, true, 'the pending entry disposes only the exact owner using the later caller budget');
          assert.equal(result.exactTemporaryRemoved, true, 'the pending entry cleans only the prepared temp alias');
          assert.ok(result.third.attempted <= 8);
          assert.equal(result.third.protected, 0);
          assert.equal(result.artifactExists, false, 'a subsequent bounded cleanup pass converges');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reserves shared stale-owner reads before takeover and recovers with a larger caller budget', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-shared-owner-read-reserve-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const childSource = `const { FileToolOutputStore } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'shared-owner-read-reserve' }); const writer = operation.startCapture({ previewBytes: 16, diagnosticBytes: 32, maxDiagnostics: 1, readBytes: 32 }); writer.write('stdout', 'reserved-owner'); writer.finish(); console.log(operation.id); process.exit(0);`;
          const operationId = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          const operations = path.join(directory, 'operations');
          const indexPath = path.join(operations, 'index.json');
          const slotPath = path.join(operations, 'slot-0000.json');
          const metadataPath = path.join(operations, `${operationId}.json`);
          const lockPath = path.join(operations, `${operationId}.lock`);
          const indexBytes = readFileSync(indexPath);
          const slotBytes = readFileSync(slotPath);
          const metadataBytes = readFileSync(metadataPath);
          const ownerBytes = readFileSync(lockPath);
          const stdoutPath = readdirSync(directory).find((name) => name.endsWith('.stdout'))!;
          const artifactBytes = readFileSync(path.join(directory, stdoutPath));
          const oldGuardBudget = indexBytes.byteLength + slotBytes.byteLength + metadataBytes.byteLength + (3 * 4096);
          const refused = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') })
            .cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: oldGuardBudget, maxDeletions: 8 });
          assert.equal(refused.protected, 1, 'the old three-record guard is insufficient for the admitted shared and local envelope');
          assert.deepEqual(readFileSync(lockPath), ownerBytes, 'refusal leaves the stale owner unchanged');
          assert.deepEqual(readFileSync(slotPath), slotBytes, 'refusal leaves the slot unchanged');
          assert.deepEqual(readFileSync(metadataPath), metadataBytes, 'refusal leaves operation metadata unchanged');
          assert.deepEqual(readFileSync(path.join(directory, stdoutPath)), artifactBytes, 'refusal leaves the artifact unchanged');

          const recovered = new FileToolOutputStore(directory, { capacity: 1, now: () => new Date('2030-01-01T00:00:00.000Z') })
            .cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 1_048_576, maxDeletions: 8 });
          assert.equal(recovered.protected, 0);
          assert.equal(existsSync(lockPath), false, 'an adequate fresh budget reclaims the stale owner');
          assert.equal(existsSync(slotPath), false, 'an adequate fresh budget completes the cleanup');
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: rejects stale active-owner unlink until the frozen-ID tombstone preflight succeeds', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-stale-active-preunlink-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const ownerSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'stale-active-preunlink' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'preserve-until-tombstone'); const artifact = writer.finish().artifact; console.log(JSON.stringify({ id: operation.id, artifactId: artifact.id })); process.exit(0);`;
          const owner = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ownerSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly id: string; readonly artifactId: string };
          const operations = path.join(directory, 'operations');
          const slotPath = path.join(operations, 'slot-0000.json');
          const lockPath = path.join(operations, `${owner.id}.lock`);
          const originalLock = readFileSync(lockPath);
          let failPreflight = true;
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeActiveCleanupTombstone: () => { if (failPreflight) throw Object.assign(new Error('pre-unlink tombstone EIO'), { code: 'EIO' }); },
          } });
          const blocked = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(blocked.protected, 1);
          assert.deepEqual(readFileSync(lockPath), originalLock, 'the stale canonical owner stays present when tombstone admission fails');
          assert.equal(JSON.parse(readFileSync(slotPath, 'utf8')).deleting, undefined, 'the active source slot is unchanged');
          assert.equal(existsSync(path.join(directory, `${owner.artifactId}.stdout`)), true, 'indexed artifacts stay present');
          failPreflight = false;
          const recovered = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recovered.protected, 0);
          assert.equal(existsSync(lockPath), false);
          assert.equal(existsSync(slotPath), false);
          assert.equal(existsSync(path.join(directory, `${owner.artifactId}.stdout`)), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: reuses the frozen cleanup transition after tombstone rename succeeds but its barrier fails', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-stale-active-barrier-retry-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const ownerSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'stale-active-barrier-retry' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'frozen tombstone retry'); const artifact = writer.finish().artifact; console.log(JSON.stringify({ id: operation.id, artifactId: artifact.id })); process.exit(0);`;
          const owner = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ownerSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()) as { readonly id: string; readonly artifactId: string };
          let failBarrier = true;
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeActiveCleanupTombstoneDirectoryFsync: () => {
              if (failBarrier) throw Object.assign(new Error('active tombstone directory fsync EIO'), { code: 'EIO' });
            },
          } });
          const first = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          const slotPath = path.join(directory, 'operations', 'slot-0000.json');
          const lockPath = path.join(directory, 'operations', `${owner.id}.lock`);
          assert.equal(first.protected, 1);
          assert.deepEqual(JSON.parse(readFileSync(slotPath, 'utf8')).artifactIds, [owner.artifactId], 'the exact frozen ID tombstone is visible after rename');
          assert.equal(existsSync(lockPath), true, 'the stale canonical owner was not unlinked after the failed barrier');
          failBarrier = false;
          const recovered = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recovered.protected, 0);
          assert.equal(existsSync(slotPath), false);
          assert.equal(existsSync(path.join(directory, `${owner.artifactId}.stdout`)), false);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: stale active takeover rejects identical owner bytes on a different inode', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-stale-active-generation-'));
        try {
          const moduleUrl = new URL('../src/evidence/tool-output.ts', import.meta.url).href;
          const ownerSource = `const { FileToolOutputStore, DEFAULT_TOOL_OUTPUT_POLICY } = await import(${JSON.stringify(moduleUrl)}); const store = new FileToolOutputStore(${JSON.stringify(directory)}, { capacity: 1 }); const operation = store.beginOperation({ kind: 'stale-active-generation' }); const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY); writer.write('stdout', 'generation-bound owner'); writer.finish(); console.log(operation.id); process.exit(0);`;
          const id = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', ownerSource], {
            cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
          const lockPath = path.join(directory, 'operations', `${id}.lock`);
          const originalBytes = readFileSync(lockPath);
          const originalStats = lstatSync(lockPath, { bigint: true });
          let replaced = false;
          const store = new FileToolOutputStore(directory, { capacity: 1, testFaults: {
            beforeStaleTakeover: () => {
              if (replaced) return;
              replaced = true;
              renameSync(lockPath, `${lockPath}.held`);
              writeFileSync(lockPath, originalBytes, { mode: 0o600, flag: 'wx' });
            },
          } });
          const refused = store.cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          const successor = lstatSync(lockPath, { bigint: true });
          assert.equal(replaced, true);
          assert.equal(refused.protected, 1);
          assert.equal(successor.dev === originalStats.dev && successor.ino === originalStats.ino, false);
          assert.deepEqual(readFileSync(lockPath), originalBytes, 'byte equality cannot substitute for the frozen owner inode');
          unlinkSync(`${lockPath}.held`);
          const recovered = new FileToolOutputStore(directory, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
          assert.equal(recovered.protected, 0);
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

      it('file: refuses aggregate budgets below maintenance finalization before publishing an owner', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-maintenance-reserve-'));
        try {
          const store = new FileToolOutputStore(directory, { capacity: 1 });
          const operations = path.join(directory, 'operations');
          assert.throws(() => store.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 8_191 }), /metadata-read budget exhausted/);
          assert.equal(existsSync(path.join(operations, 'maintenance.lock')), false);
          assert.deepEqual(readdirSync(operations).filter((name) => name.startsWith('maintenance.lock.tmp-')), []);
          const reusable = store.beginOperation({ kind: 'after-maintenance-reservation-refusal' });
          reusable.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: releases the pinned maintenance owner after ordinary cleanup reads exhaust', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-maintenance-finalizer-'));
        try {
          const store = new FileToolOutputStore(directory, { capacity: 1 });
          const operation = store.beginOperation({ kind: 'maintenance-finalizer-body-exhaustion' });
          const maintenanceOwnerBytes = readFileSync(path.join(directory, 'operations', `${operation.id}.lock`)).byteLength;
          operation.abort();
          store.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 65_536 });
          assert.ok(maintenanceOwnerBytes > 0);
          const maintenancePath = path.join(directory, 'operations', 'maintenance.lock');
          assert.throws(() => store.cleanupExpired({ maxSlotProbes: 1, maxMetadataReadBytes: 8_192 + maintenanceOwnerBytes + 1 }), /metadata-read budget exhausted/);
          assert.equal(existsSync(maintenancePath), false, 'the reserved owner finalizer completes after body-ledger exhaustion');
          const reusable = store.beginOperation({ kind: 'after-maintenance-body-exhaustion' });
          reusable.abort();
        } finally { rmSync(directory, { recursive: true, force: true }); }
      });

      it('file: bounds and preserves an oversized malformed maintenance owner', () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-output-oversized-maintenance-'));
        try {
          let now = new Date('2020-01-01T00:00:00.000Z');
          const store = new FileToolOutputStore(directory, { capacity: 1, retentionMs: 1, now: () => now });
          const artifact = store.save({ stdout: 'protected-by-oversized-owner', stderr: '' });
          const operations = path.join(directory, 'operations');
          const maintenancePath = path.join(operations, 'maintenance.lock');
          const malformed = Buffer.alloc(2 * 1_048_576, 0x78);
          writeFileSync(maintenancePath, malformed, { mode: 0o600 });
          const metadataPath = path.join(operations, `${artifact.operationId}.json`);
          const metadataBefore = readFileSync(metadataPath);
          assert.throws(() => store.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 4_096, maxMetadataReadBytes: 65_536 }), /lock|owner|invocation/i);
          assert.deepEqual(readFileSync(maintenancePath), malformed, 'oversized owner bytes remain untouched');
          assert.deepEqual(readFileSync(metadataPath), metadataBefore, 'the protected operation metadata remains untouched');
          assert.equal(existsSync(path.join(directory, `${artifact.id}.stdout`)), true);
          unlinkSync(maintenancePath);
          now = new Date('2030-01-01T00:00:00.000Z');
          store.cleanupExpired({ maxSlotProbes: 1, maxMetadataBytes: 4_096, maxMetadataReadBytes: 65_536 });
          const reusable = store.beginOperation({ kind: 'after-oversized-maintenance-owner' });
          reusable.abort();
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

describe('raw-byte tool output capture', () => {
  it('preserves malformed source bytes and projects each invalid byte consistently across stores', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-raw-byte-capture-'));
    const raw = Buffer.from([0x41, 0xff, 0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80, 0xe2, 0x82, 0x0a, 0x42]);
    const stderr = Buffer.from([0x00, 0xef, 0xbb, 0xbf, 0xef, 0xbf, 0xbd, 0xe2, 0x82]);
    const expected = Buffer.from([0x41, ...Buffer.from('?????????????\n'), 0x42]);
    try {
      for (const store of [new InMemoryToolOutputStore(), new FileToolOutputStore(directory)]) {
        const writer = store.startCapture(policy);
        writer.writeBytes!('stdout', raw.subarray(0, 2));
        writer.writeBytes!('stdout', raw.subarray(2, 9));
        writer.writeBytes!('stdout', raw.subarray(9));
        writer.writeBytes!('stderr', stderr);
        const summary = writer.finish();
        assert.equal(summary.artifact.stdoutBytes, raw.length);
        assert.equal(summary.artifact.stderrBytes, stderr.length);
        assert.equal(summary.artifact.sha256,
          createHash('sha256').update(raw).update('\0').update(stderr).digest('hex'));
        assert.equal(summary.stdout.preview, expected.toString('utf8'));
        assert.equal(summary.stdout.bytes, raw.length, 'preview accounting is charged in original bytes');
        assert.equal(summary.stderr.preview, '\0\ufeff\ufffd??', 'NUL, BOM, literal U+FFFD, and truncated EOF bytes retain distinct meanings');
        assert.equal(store.read(summary.artifact, { channel: 'stdout', offset: 0, length: 64 }).text, expected.toString('utf8'));
        assert.deepEqual(store.search(summary.artifact, { channel: 'stdout', query: 'B' })[0]?.offset, raw.length - 1,
          'search reports original source-byte offsets after malformed input');
        if (store instanceof FileToolOutputStore) {
          assert.deepEqual(readFileSync(path.join(directory, `${summary.artifact.id}.stdout`)), raw);
          assert.deepEqual(readFileSync(path.join(directory, `${summary.artifact.id}.stderr`)), stderr);
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('copies memory writer buffers and preserves valid UTF-8 split across writes', () => {
    const store = new InMemoryToolOutputStore();
    const writer = store.startCapture(policy);
    for (const split of [1, 2, 3]) {
      const bytes = Buffer.from([0xf0, 0x9f, 0x99, 0x82]);
      const first = bytes.subarray(0, split);
      const second = bytes.subarray(split);
      writer.writeBytes!('stdout', first);
      writer.writeBytes!('stdout', second);
      // Each partition is independently projected by a fresh store below.
      const check = new InMemoryToolOutputStore().startCapture(policy);
      check.writeBytes!('stdout', bytes.subarray(0, split));
      check.writeBytes!('stdout', bytes.subarray(split));
      assert.equal(check.finish().stdout.preview, '🙂');
      first.fill(0);
      second.fill(0);
    }
    const summary = writer.finish();
    assert.equal(summary.artifact.stdoutBytes, 12);
    assert.equal(store.read(summary.artifact, { channel: 'stdout', length: 12 }).text, '🙂🙂🙂');
    assert.equal(store.read(summary.artifact, { channel: 'stdout', offset: 1, length: 1 }).bytes, 4,
      'range reads align only to the valid scalar containing the requested raw offset');
  });

  it('charges file capture limits in raw bytes and fails closed for a legacy string-only sink', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-raw-byte-quota-'));
    try {
      const store = new FileToolOutputStore(directory, { captureMaxBytes: 2 });
      const exact = store.startCapture(policy);
      exact.writeBytes!('stdout', Buffer.from([0xff, 0x80]));
      assert.equal(exact.finish().artifact.totalBytes, 2);

      const over = store.startCapture(policy);
      assert.throws(() => over.writeBytes!('stdout', Buffer.from([0xff, 0x80, 0x81])), /budget exhausted/);
      assert.throws(() => over.finish(), /cannot finish/);
      over.abort?.();

      let aborted = 0;
      const legacy = {
        write() { throw new Error('raw bytes must never be coerced into this legacy writer'); },
        finish() { throw new Error('partial capture must not finish'); },
        abort() { aborted += 1; },
      };
      const session = new ContainedToolOutputCaptureSession(policy);
      session.writeBytes(legacy, 'stdout', Buffer.from([0xff]));
      const result = session.finish(legacy);
      assert.equal(aborted, 1);
      assert.equal(result.status, 'partial');
      assert.equal(result.stdout.preview, '?');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('reserves oversized string bytes before encoding and charges mixed strings and raw buffers exactly once', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-string-admission-order-'));
    try {
    const oversizedStore = new FileToolOutputStore(path.join(directory, 'oversized'), { captureMaxBytes: 1 });
    const oversizedWriter = oversizedStore.startCapture(policy);
    const largeString = 'x'.repeat(262_163);
    const originalFrom = Buffer.from;
    let largeEncodes = 0;
    Buffer.from = new Proxy(originalFrom, {
      apply(target, thisArg, argumentsList: unknown[]) {
        if (typeof argumentsList[0] === 'string' && argumentsList[0].length > 100_000) largeEncodes += 1;
        return Reflect.apply(target, thisArg, argumentsList);
      },
    }) as typeof Buffer.from;
    try {
      assert.throws(() => oversizedWriter.write('stdout', largeString), /budget exhausted/);
      assert.equal(largeEncodes, 0, 'a refused string is never converted into a full Buffer');
      assert.throws(() => oversizedWriter.finish(), /cannot finish/);
    } finally {
      Buffer.from = originalFrom;
      oversizedWriter.abort?.();
    }

    const exactStore = new FileToolOutputStore(path.join(directory, 'exact'), { captureMaxBytes: 4 });
    const exactWriter = exactStore.startCapture(policy);
    exactWriter.write('stdout', 'é');
    exactWriter.writeBytes!('stderr', Buffer.from([0xff, 0x80]));
    const summary = exactWriter.finish();
    assert.equal(summary.artifact.stdoutBytes, 2);
    assert.equal(summary.artifact.stderrBytes, 2);
    assert.equal(summary.artifact.totalBytes, 4, 'string and raw writes share the exact aggregate quota');
    assert.equal(summary.stdout.bytes, 2);
    assert.equal(summary.stderr.bytes, 2);
    assert.equal(summary.stderr.preview, '??');
    assert.equal(summary.artifact.sha256,
      createHash('sha256').update(Buffer.from('é')).update('\0').update(Buffer.from([0xff, 0x80])).digest('hex'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
