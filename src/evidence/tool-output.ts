import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const TOOL_OUTPUT_CONTRACT_VERSION = 'tachiko.tool-output.v1' as const;

export type ToolOutputOutcome = 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'unknown';

export interface ToolOutputPolicy {
  /** Maximum UTF-8 bytes retained in each routine stream preview. */
  readonly previewBytes: number;
  /** Maximum UTF-8 bytes retained in the high-signal diagnostic lines. */
  readonly diagnosticBytes: number;
  /** Maximum number of diagnostic lines returned in the envelope. */
  readonly maxDiagnostics: number;
  /** Default size for an explicit range read when a caller omits a length. */
  readonly readBytes: number;
}

export const DEFAULT_TOOL_OUTPUT_POLICY: ToolOutputPolicy = {
  previewBytes: 4_096,
  diagnosticBytes: 8_192,
  maxDiagnostics: 16,
  readBytes: 16_384,
};

export interface ToolOutputStream {
  readonly bytes: number;
  readonly preview: string;
  readonly previewBytes: number;
  readonly truncated: boolean;
}

export interface ToolOutputOverflow {
  readonly truncated: boolean;
  readonly capture: boolean;
  readonly summary: boolean;
  readonly diagnostics: boolean;
  readonly stdout: boolean;
  readonly stderr: boolean;
  readonly totalBytes: number;
  readonly retainedBytes: number;
  readonly omittedBytes: number;
  readonly previewLimitBytes: number;
  readonly diagnosticLimitBytes: number;
  readonly diagnosticLimitLines: number;
}

export interface ToolOutputArtifactReference {
  readonly kind: 'tool-output';
  readonly id: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

export interface ToolOutputEnvelope {
  readonly version: typeof TOOL_OUTPUT_CONTRACT_VERSION;
  readonly outcome: ToolOutputOutcome;
  /** Exact child exit status; null means no process exit was observed. */
  readonly exitCode: number | null;
  /** Default byte size for an explicit drill-down read of this artifact. */
  readonly readBytes: number;
  readonly summary: string;
  readonly stdout: ToolOutputStream;
  readonly stderr: ToolOutputStream;
  /** High-signal lines selected before the complete artifact is loaded. */
  readonly diagnostics: readonly string[];
  /** Null means storage failed; overflow.capture is then true, never silently complete. */
  readonly artifact: ToolOutputArtifactReference | null;
  readonly overflow: ToolOutputOverflow;
}

export interface ToolOutputCapture {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ToolOutputCaptureSummary {
  readonly artifact: ToolOutputArtifactReference | null;
  readonly stdout: ToolOutputStream;
  readonly stderr: ToolOutputStream;
  readonly diagnostics: readonly string[];
  readonly diagnosticsTruncated: boolean;
}

export interface ToolOutputCaptureWriter {
  write(channel: 'stdout' | 'stderr', chunk: string): void;
  finish(): ToolOutputCaptureSummary;
  /** Discard an incomplete capture and release its resources. */
  abort?(): void;
}

export interface ToolOutputReadRequest {
  readonly channel: 'stdout' | 'stderr';
  readonly offset?: number;
  /** Byte budget; UTF-8 boundary alignment may add up to six bytes. */
  readonly length?: number;
}

export interface ToolOutputReadResult {
  readonly channel: 'stdout' | 'stderr';
  readonly offset: number;
  readonly text: string;
  readonly bytes: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

export interface ToolOutputSearchRequest {
  readonly channel?: 'stdout' | 'stderr';
  readonly query: string;
  readonly maxMatches?: number;
  /** Maximum UTF-8 bytes returned for each matching line. */
  readonly maxBytes?: number;
}

export interface ToolOutputMatch {
  readonly channel: 'stdout' | 'stderr';
  readonly line: number;
  readonly offset: number;
  readonly text: string;
  readonly truncated?: boolean;
}

export interface ToolOutputStore {
  save(capture: ToolOutputCapture): ToolOutputArtifactReference;
  /** Explicit owner-controlled retention: remove only this exact artifact. */
  delete(reference: ToolOutputArtifactReference): void;
  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter;
  read(reference: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult;
  search(reference: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[];
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}

function normalizePolicy(policy: ToolOutputPolicy | undefined): ToolOutputPolicy {
  const resolved = policy ?? DEFAULT_TOOL_OUTPUT_POLICY;
  assertPositiveInteger(resolved.previewBytes, 'previewBytes');
  assertPositiveInteger(resolved.diagnosticBytes, 'diagnosticBytes');
  assertPositiveInteger(resolved.maxDiagnostics, 'maxDiagnostics');
  assertPositiveInteger(resolved.readBytes, 'readBytes');
  return resolved;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

function head(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  let start = end - 1;
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start >= 0) {
    const first = bytes[start]!;
    const expected = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
    if (expected > end - start) end = start;
  }
  return bytes.subarray(0, Math.max(0, end)).toString('utf8');
}

function boundedDiagnostics(stdout: string, stderr: string, policy: ToolOutputPolicy): { readonly lines: string[]; readonly truncated: boolean } {
  const lines: string[] = [];
  const highSignal = /\b(error|failed|failure|fatal|exception|assert|panic|timeout|timed[ -]?out|denied|invalid|cannot|could not)\b/i;
  for (const source of [stderr, stdout]) {
    for (const line of source.split(/\r?\n/)) {
      const normalized = line.trim();
      if (normalized !== '' && highSignal.test(normalized)) lines.push(normalized);
    }
  }
  const selected = lines.length > 0 ? lines : [stderr, stdout].flatMap((value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2));
  const result: string[] = [];
  let truncated = selected.length > policy.maxDiagnostics;
  let used = 0;
  for (const line of selected.slice(0, policy.maxDiagnostics)) {
    const remaining = policy.diagnosticBytes - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const bounded = head(line, remaining);
    if (bounded === '') continue;
    result.push(bounded);
    if (bounded.length < line.length || utf8Bytes(bounded) < utf8Bytes(line)) truncated = true;
    used += utf8Bytes(bounded);
  }
  return { lines: result, truncated };
}

function artifactHash(stdout: string, stderr: string): string {
  return createHash('sha256').update(stdout, 'utf8').update('\0', 'utf8').update(stderr, 'utf8').digest('hex');
}

function stream(value: string, previewBytes: number): ToolOutputStream {
  const bytes = utf8Bytes(value);
  const preview = tail(value, previewBytes);
  return { bytes, preview, previewBytes: utf8Bytes(preview), truncated: bytes > previewBytes };
}

export function boundToolOutput(input: {
  readonly outcome: ToolOutputOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly summary?: string;
  readonly store: ToolOutputStore;
  readonly policy?: ToolOutputPolicy;
  readonly captureTruncated?: boolean;
}): ToolOutputEnvelope {
  if (!Number.isInteger(input.exitCode) && input.exitCode !== null) throw new Error('exitCode must be an integer or null.');
  const policy = normalizePolicy(input.policy);
  const capture = captureToolOutput(input.store, policy);
  capture.write('stdout', input.stdout);
  capture.write('stderr', input.stderr);
  return boundToolOutputFromCapture({ ...input, capture: capture.finish(), policy });
}

export function boundToolOutputFromCapture(input: {
  readonly outcome: ToolOutputOutcome;
  readonly exitCode: number | null;
  readonly capture: ToolOutputCaptureSummary;
  readonly summary?: string;
  readonly policy?: ToolOutputPolicy;
  readonly captureTruncated?: boolean;
}): ToolOutputEnvelope {
  if (!Number.isInteger(input.exitCode) && input.exitCode !== null) throw new Error('exitCode must be an integer or null.');
  const policy = normalizePolicy(input.policy);
  const captureTruncated = Boolean(input.captureTruncated) || input.capture.artifact === null;
  const rawSummary = input.summary?.trim() || `${input.outcome}${input.exitCode === null ? '' : ` (exit ${input.exitCode})`}`;
  const summary = head(rawSummary, policy.diagnosticBytes);
  const overflow = {
    truncated: captureTruncated || input.capture.stdout.truncated || input.capture.stderr.truncated || input.capture.diagnosticsTruncated || utf8Bytes(summary) < utf8Bytes(rawSummary),
    capture: captureTruncated,
    summary: utf8Bytes(summary) < utf8Bytes(rawSummary),
    diagnostics: input.capture.diagnosticsTruncated,
    stdout: input.capture.stdout.truncated,
    stderr: input.capture.stderr.truncated,
    totalBytes: (input.capture.stdout.bytes + input.capture.stderr.bytes),
    retainedBytes: input.capture.stdout.previewBytes + input.capture.stderr.previewBytes,
    omittedBytes: Math.max(0, (input.capture.stdout.bytes + input.capture.stderr.bytes) - input.capture.stdout.previewBytes - input.capture.stderr.previewBytes),
    previewLimitBytes: policy.previewBytes,
    diagnosticLimitBytes: policy.diagnosticBytes,
    diagnosticLimitLines: policy.maxDiagnostics,
  } satisfies ToolOutputOverflow;
  return {
    version: TOOL_OUTPUT_CONTRACT_VERSION,
    outcome: input.outcome,
    exitCode: input.exitCode,
    readBytes: policy.readBytes,
    summary,
    stdout: input.capture.stdout,
    stderr: input.capture.stderr,
    diagnostics: input.capture.diagnostics,
    artifact: input.capture.artifact,
    overflow,
  };
}

export function readToolOutput(
  envelope: ToolOutputEnvelope,
  store: ToolOutputStore,
  request: ToolOutputReadRequest,
): ToolOutputReadResult {
  if (envelope.version !== TOOL_OUTPUT_CONTRACT_VERSION) throw new Error('Unsupported tool-output envelope version.');
  if (envelope.artifact === null) throw new Error('Tool-output evidence is unavailable; capture failed.');
  return store.read(envelope.artifact, { ...request, ...(request.length === undefined ? { length: envelope.readBytes } : {}) });
}

export function searchToolOutput(
  envelope: ToolOutputEnvelope,
  store: ToolOutputStore,
  request: ToolOutputSearchRequest,
): readonly ToolOutputMatch[] {
  if (envelope.version !== TOOL_OUTPUT_CONTRACT_VERSION) throw new Error('Unsupported tool-output envelope version.');
  if (envelope.artifact === null) throw new Error('Tool-output evidence is unavailable; capture failed.');
  return store.search(envelope.artifact, {
    ...request,
    maxBytes: request.maxBytes ?? envelope.overflow.diagnosticLimitBytes,
  });
}

export function isToolOutputEnvelope(value: unknown): value is ToolOutputEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== TOOL_OUTPUT_CONTRACT_VERSION ||
      !['passed', 'failed', 'timed_out', 'cancelled', 'unknown'].includes(envelope.outcome as string) ||
      (envelope.exitCode !== null && (!Number.isInteger(envelope.exitCode) || typeof envelope.exitCode !== 'number')) ||
      typeof envelope.readBytes !== 'number' || !Number.isSafeInteger(envelope.readBytes) || envelope.readBytes < 1 ||
      typeof envelope.summary !== 'string' || !Array.isArray(envelope.diagnostics) ||
      !envelope.diagnostics.every((item) => typeof item === 'string')) return false;
  if (!isToolOutputStream(envelope.stdout) || !isToolOutputStream(envelope.stderr)) return false;
  if (envelope.artifact !== null && !isToolOutputArtifact(envelope.artifact)) return false;
  const overflow = envelope.overflow;
  if (typeof overflow !== 'object' || overflow === null) return false;
  const overflowRecord = overflow as Record<string, unknown>;
  if (typeof overflowRecord.truncated !== 'boolean' || typeof overflowRecord.capture !== 'boolean' || typeof overflowRecord.summary !== 'boolean' ||
    typeof overflowRecord.diagnostics !== 'boolean' || typeof overflowRecord.stdout !== 'boolean' || typeof overflowRecord.stderr !== 'boolean' ||
    ![overflowRecord.totalBytes, overflowRecord.retainedBytes, overflowRecord.omittedBytes, overflowRecord.previewLimitBytes,
      overflowRecord.diagnosticLimitBytes, overflowRecord.diagnosticLimitLines]
      .every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) return false;
  // The shape checks above prove every member of the advertised contract.
  // Enforce those advertised limits without inventing a global/task budget.
  const checked = overflowRecord as unknown as ToolOutputOverflow;
  if (checked.previewLimitBytes < 1 || checked.diagnosticLimitBytes < 1 || checked.diagnosticLimitLines < 1 ||
      utf8Bytes(envelope.summary) > checked.diagnosticLimitBytes ||
      envelope.diagnostics.length > checked.diagnosticLimitLines ||
      envelope.diagnostics.reduce((bytes, line: string) => bytes + utf8Bytes(line), 0) > checked.diagnosticLimitBytes) return false;
  const streamCoherent = (value: ToolOutputStream): boolean =>
    value.previewBytes === utf8Bytes(value.preview) &&
    value.previewBytes <= value.bytes && value.previewBytes <= checked.previewLimitBytes &&
    value.truncated === (value.bytes > checked.previewLimitBytes) &&
    (value.truncated || value.previewBytes === value.bytes);
  const expectedTruncated = checked.capture || checked.summary || checked.diagnostics || checked.stdout || checked.stderr;
  return streamCoherent(envelope.stdout) && streamCoherent(envelope.stderr) &&
    (envelope.artifact === null ? checked.capture === true :
      envelope.artifact.totalBytes === envelope.artifact.stdoutBytes + envelope.artifact.stderrBytes &&
      envelope.artifact.stdoutBytes === envelope.stdout.bytes && envelope.artifact.stderrBytes === envelope.stderr.bytes) &&
    checked.totalBytes === envelope.stdout.bytes + envelope.stderr.bytes &&
    checked.retainedBytes === envelope.stdout.previewBytes + envelope.stderr.previewBytes &&
    checked.omittedBytes === Math.max(0, checked.totalBytes - checked.retainedBytes) &&
    checked.stdout === envelope.stdout.truncated && checked.stderr === envelope.stderr.truncated &&
    checked.truncated === expectedTruncated;
}

function isToolOutputStream(value: unknown): value is ToolOutputStream {
  if (typeof value !== 'object' || value === null) return false;
  const streamValue = value as Record<string, unknown>;
  return typeof streamValue.bytes === 'number' && Number.isSafeInteger(streamValue.bytes) && streamValue.bytes >= 0 &&
    typeof streamValue.preview === 'string' && typeof streamValue.previewBytes === 'number' &&
    Number.isSafeInteger(streamValue.previewBytes) && streamValue.previewBytes >= 0 &&
    typeof streamValue.truncated === 'boolean';
}

function isToolOutputArtifact(value: unknown): value is ToolOutputArtifactReference {
  if (typeof value !== 'object' || value === null) return false;
  const artifact = value as Record<string, unknown>;
  return artifact.kind === 'tool-output' && typeof artifact.id === 'string' && artifact.id.trim() !== '' &&
    [artifact.stdoutBytes, artifact.stderrBytes, artifact.totalBytes].every((item) =>
      typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) &&
    typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256);
}

function validateReadRequest(reference: ToolOutputArtifactReference, request: ToolOutputReadRequest, readBytes: number): { readonly offset: number; readonly length: number; readonly total: number } {
  if (request.channel !== 'stdout' && request.channel !== 'stderr') throw new Error('Invalid tool-output channel.');
  const total = request.channel === 'stdout' ? reference.stdoutBytes : reference.stderrBytes;
  const offset = request.offset ?? 0;
  const length = request.length ?? readBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error('Tool-output range offset is outside the artifact.');
  assertPositiveInteger(length, 'Tool-output range length');
  return { offset, length, total };
}

/** Align both ends to whole UTF-8 code points. The returned offset is authoritative. */
function alignedRange(bytes: Buffer, offset: number, length: number): { start: number; end: number } {
  let start = offset;
  while (start > 0 && start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  let end = Math.min(bytes.length, offset + length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
  return { start, end };
}

function readStringRange(value: string, offset: number, length: number): ToolOutputReadResult {
  const bytes = Buffer.from(value, 'utf8');
  const range = alignedRange(bytes, offset, length);
  const chunk = bytes.subarray(range.start, range.end);
  return { channel: 'stdout', offset: range.start, text: chunk.toString('utf8'), bytes: chunk.length,
    nextOffset: range.end, eof: range.end >= bytes.length };
}

export class InMemoryToolOutputStore implements ToolOutputStore {
  private readonly values = new Map<string, ToolOutputCapture>();
  private readonly maxArtifacts: number;
  private readonly order: string[] = [];

  constructor(options: { readonly maxArtifacts?: number } = {}) {
    this.maxArtifacts = options.maxArtifacts ?? Number.POSITIVE_INFINITY;
    if (this.maxArtifacts !== Number.POSITIVE_INFINITY) assertPositiveInteger(this.maxArtifacts, 'maxArtifacts');
  }

  save(capture: ToolOutputCapture): ToolOutputArtifactReference {
    const id = randomUUID();
    this.values.set(id, { stdout: capture.stdout, stderr: capture.stderr });
    this.order.push(id);
    while (this.order.length > this.maxArtifacts) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.values.delete(evicted);
    }
    return reference(id, capture.stdout, capture.stderr);
  }

  delete(referenceValue: ToolOutputArtifactReference): void {
    this.values.delete(referenceValue.id);
    const index = this.order.indexOf(referenceValue.id);
    if (index >= 0) this.order.splice(index, 1);
  }

  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
    return new BufferedToolOutputWriter(this, policy);
  }

  read(referenceValue: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult {
    const capture = this.verifiedCapture(referenceValue);
    const range = validateReadRequest(referenceValue, request, DEFAULT_TOOL_OUTPUT_POLICY.readBytes);
    const value = request.channel === 'stdout' ? capture.stdout : capture.stderr;
    const result = readStringRange(value, range.offset, range.length);
    return { ...result, channel: request.channel };
  }

  search(referenceValue: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
    return searchCapture(this.verifiedCapture(referenceValue), request);
  }

  private verifiedCapture(referenceValue: ToolOutputArtifactReference): ToolOutputCapture {
    const capture = this.values.get(referenceValue.id);
    if (capture === undefined) throw new Error(`Tool-output artifact ${referenceValue.id} is unavailable.`);
    if (referenceValue.sha256 !== artifactHash(capture.stdout, capture.stderr) ||
        referenceValue.stdoutBytes !== utf8Bytes(capture.stdout) || referenceValue.stderrBytes !== utf8Bytes(capture.stderr) ||
        referenceValue.totalBytes !== referenceValue.stdoutBytes + referenceValue.stderrBytes) {
      throw new Error('Tool-output artifact identity mismatch.');
    }
    return capture;
  }
}

export class FileToolOutputStore implements ToolOutputStore {
  private readonly root: string;

  constructor(root = process.env.TACHIKO_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'tachiko-conductor', 'evidence')) {
    this.root = path.resolve(root);
  }

  save(capture: ToolOutputCapture): ToolOutputArtifactReference {
    const writer = this.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
    try {
      writer.write('stdout', capture.stdout);
      writer.write('stderr', capture.stderr);
      const artifact = writer.finish().artifact;
      if (artifact === null) throw new Error('Tool-output artifact unavailable.');
      return artifact;
    } catch (error) {
      writer.abort?.();
      throw error;
    }
  }

  delete(referenceValue: ToolOutputArtifactReference): void {
    for (const channel of ['stdout', 'stderr'] as const) {
      try { unlinkSync(this.file(referenceValue.id, channel)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
    return new FileToolOutputWriter(this.root, normalizePolicy(policy));
  }

  read(referenceValue: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult {
    const range = validateReadRequest(referenceValue, request, DEFAULT_TOOL_OUTPUT_POLICY.readBytes);
    const start = Math.max(0, range.offset - 3);
    const buffer = Buffer.alloc(Math.min(range.length + 6, range.total - start));
    this.inspect(referenceValue, (channel, chunk, offset) => {
      if (channel !== request.channel) return;
      const from = Math.max(start, offset);
      const to = Math.min(start + buffer.length, offset + chunk.length);
      if (to > from) chunk.copy(buffer, from - start, from - offset, to - offset);
    });
    const aligned = alignedRange(buffer, range.offset - start, range.length);
    const chunk = buffer.subarray(aligned.start, aligned.end);
    const nextOffset = start + aligned.end;
    return { channel: request.channel, offset: start + aligned.start, text: chunk.toString('utf8'),
      bytes: chunk.length, nextOffset, eof: nextOffset >= range.total };
  }

  search(referenceValue: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
    const { maxMatches, maxBytes } = validateSearchRequest(request);
    const results: ToolOutputMatch[] = [];
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const states = { stdout: emptySearchState(), stderr: emptySearchState() };
    this.inspect(referenceValue, (channel, chunk, _offset, final) => {
      if ((request.channel !== undefined && channel !== request.channel) || results.length >= maxMatches) return;
      const decoded = decoders[channel].write(chunk) + (final ? decoders[channel].end() : '');
      states[channel] = scanDecodedChunks(channel, request.query, maxMatches, maxBytes, results,
        [decoded], states[channel], final);
    });
    return results;
  }

  /**
   * Produce bounded results from the very bytes being hashed, then verify the
   * complete identity before returning. Never verify and reopen a mutable file.
   */
  private inspect(
    referenceValue: ToolOutputArtifactReference,
    consume: (channel: 'stdout' | 'stderr', chunk: Buffer, offset: number, final: boolean) => void,
  ): void {
    if (!isToolOutputArtifact(referenceValue) || referenceValue.totalBytes !== referenceValue.stdoutBytes + referenceValue.stderrBytes) {
      throw new Error('Invalid tool-output artifact identity.');
    }
    const hash = createHash('sha256');
    for (const channel of ['stdout', 'stderr'] as const) {
      if (channel === 'stderr') hash.update('\0', 'utf8');
      const handle = openPrivateFile(this.file(referenceValue.id, channel));
      try {
        const expected = channel === 'stdout' ? referenceValue.stdoutBytes : referenceValue.stderrBytes;
        if (fstatSync(handle).size !== expected) throw new Error('Tool-output artifact size changed.');
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < expected) {
          const count = readSync(handle, buffer, 0, Math.min(buffer.length, expected - offset), offset);
          if (count === 0) throw new Error('Tool-output artifact ended unexpectedly.');
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          consume(channel, chunk, offset, false);
          offset += count;
        }
        consume(channel, Buffer.alloc(0), offset, true);
        if (fstatSync(handle).size !== expected) throw new Error('Tool-output artifact size changed.');
      } finally { closeSync(handle); }
    }
    if (hash.digest('hex') !== referenceValue.sha256) throw new Error('Tool-output artifact digest changed.');
  }

  private file(id: string, channel: 'stdout' | 'stderr'): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid tool-output artifact id.');
    return path.join(this.root, `${id}.${channel}`);
  }
}

class StreamCapture {
  private total = 0;
  private preview = '';

  constructor(private readonly limit: number) {}

  append(chunk: string): void {
    this.total += utf8Bytes(chunk);
    this.preview = tail(`${this.preview}${chunk}`, this.limit);
  }

  value(): ToolOutputStream {
    return {
      bytes: this.total,
      preview: this.preview,
      previewBytes: utf8Bytes(this.preview),
      truncated: this.total > this.limit,
    };
  }
}

class DiagnosticCapture {
  private pending = '';
  private readonly highSignal: string[] = [];
  private readonly fallback: string[] = [];
  private dropped = false;
  private readonly highSignalPattern = /\b(error|failed|failure|fatal|exception|assert|panic|timeout|timed[ -]?out|denied|invalid|cannot|could not)\b/i;

  constructor(private readonly policy: ToolOutputPolicy) {}

  append(chunk: string): void {
    for (const [index, segment] of chunk.split('\n').entries()) {
      if (index > 0) { this.line(this.pending.replace(/\r$/, '')); this.pending = ''; }
      const combined = this.pending + segment;
      this.pending = head(combined, this.policy.diagnosticBytes);
      if (utf8Bytes(this.pending) < utf8Bytes(combined)) this.dropped = true;
    }
  }

  finish(): { readonly lines: readonly string[]; readonly truncated: boolean } {
    if (this.pending !== '') this.line(this.pending);
    const selected = this.highSignal.length > 0 ? this.highSignal : this.fallback;
    const bounded = boundedDiagnostics(selected.join('\n'), '', this.policy);
    return { lines: bounded.lines, truncated: this.dropped || bounded.truncated };
  }

  private line(value: string): void {
    const normalized = value.trim();
    if (normalized === '') return;
    this.fallback.push(normalized);
    while (this.fallback.length > 2) this.fallback.shift();
    if (!this.highSignalPattern.test(normalized)) return;
    this.highSignal.push(normalized);
    if (this.highSignal.length > this.policy.maxDiagnostics) {
      this.highSignal.pop();
      this.dropped = true;
    }
  }
}

/** Storage failures never replace a command's authoritative outcome. */
export function captureToolOutput(store: ToolOutputStore, requestedPolicy?: ToolOutputPolicy): ToolOutputCaptureWriter {
  const policy = normalizePolicy(requestedPolicy);
  const stdout = new StreamCapture(policy.previewBytes);
  const stderr = new StreamCapture(policy.previewBytes);
  const stdoutDiagnostics = new DiagnosticCapture(policy);
  const stderrDiagnostics = new DiagnosticCapture(policy);
  let writer: ToolOutputCaptureWriter | undefined;
  let completed: ToolOutputCaptureSummary | undefined;
  const discard = (): void => {
    try { writer?.abort?.(); } catch { /* supplemental cleanup cannot alter process status */ }
    writer = undefined;
  };
  try { writer = store.startCapture(policy); } catch { /* explicit unavailable artifact below */ }
  return {
    write(channel, chunk) {
      if (completed !== undefined) throw new Error('Tool-output capture is already finished.');
      (channel === 'stdout' ? stdout : stderr).append(chunk);
      (channel === 'stdout' ? stdoutDiagnostics : stderrDiagnostics).append(chunk);
      try { writer?.write(channel, chunk); } catch { discard(); }
    },
    finish() {
      if (completed !== undefined) return completed;
      let artifact: ToolOutputArtifactReference | null = null;
      try { artifact = writer?.finish().artifact ?? null; } catch { discard(); }
      const outDiagnostics = stdoutDiagnostics.finish();
      const errDiagnostics = stderrDiagnostics.finish();
      const diagnostics = boundedDiagnostics(outDiagnostics.lines.join('\n'), errDiagnostics.lines.join('\n'), policy);
      completed = { artifact, stdout: stdout.value(), stderr: stderr.value(), diagnostics: diagnostics.lines,
        diagnosticsTruncated: outDiagnostics.truncated || errDiagnostics.truncated || diagnostics.truncated };
      return completed;
    },
    abort: discard,
  };
}

class BufferedToolOutputWriter implements ToolOutputCaptureWriter {
  private stdout = '';
  private stderr = '';

  constructor(private readonly store: ToolOutputStore, private readonly policy: ToolOutputPolicy) {}

  write(channel: 'stdout' | 'stderr', chunk: string): void {
    if (channel === 'stdout') this.stdout += chunk;
    else this.stderr += chunk;
  }

  finish(): ToolOutputCaptureSummary {
    const artifact = this.store.save({ stdout: this.stdout, stderr: this.stderr });
    const diagnostics = boundedDiagnostics(this.stdout, this.stderr, this.policy);
    return {
      artifact,
      stdout: stream(this.stdout, this.policy.previewBytes),
      stderr: stream(this.stderr, this.policy.previewBytes),
      diagnostics: diagnostics.lines,
      diagnosticsTruncated: diagnostics.truncated,
    };
  }
}

class FileToolOutputWriter implements ToolOutputCaptureWriter {
  private readonly id = randomUUID();
  private readonly stdoutHandle: number;
  private readonly stderrHandle: number;
  private readonly stdoutCapture: StreamCapture;
  private readonly stderrCapture: StreamCapture;
  private readonly stdoutDiagnostics: DiagnosticCapture;
  private readonly stderrDiagnostics: DiagnosticCapture;
  private finished = false;

  constructor(private readonly root: string, private readonly policy: ToolOutputPolicy) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error('Tool-output evidence directory must be private and owned by the current user.');
    }
    this.stdoutHandle = openSync(path.join(root, `${this.id}.stdout`), 'wx', 0o600);
    try { this.stderrHandle = openSync(path.join(root, `${this.id}.stderr`), 'wx', 0o600); }
    catch (error) {
      closeSync(this.stdoutHandle);
      unlinkSync(path.join(root, `${this.id}.stdout`));
      throw error;
    }
    this.stdoutCapture = new StreamCapture(policy.previewBytes);
    this.stderrCapture = new StreamCapture(policy.previewBytes);
    this.stdoutDiagnostics = new DiagnosticCapture(policy);
    this.stderrDiagnostics = new DiagnosticCapture(policy);
  }

  write(channel: 'stdout' | 'stderr', chunk: string): void {
    if (this.finished) throw new Error('Tool-output capture is already finished.');
    const bytes = Buffer.from(chunk, 'utf8');
    const handle = channel === 'stdout' ? this.stdoutHandle : this.stderrHandle;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(handle, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error('Tool-output write made no progress.');
      offset += written;
    }
    if (channel === 'stdout') {
      this.stdoutCapture.append(chunk);
      this.stdoutDiagnostics.append(chunk);
    } else {
      this.stderrCapture.append(chunk);
      this.stderrDiagnostics.append(chunk);
    }
  }

  abort(): void {
    if (!this.finished) {
      this.finished = true;
      try { closeSync(this.stdoutHandle); } catch { /* best-effort resource release */ }
      try { closeSync(this.stderrHandle); } catch { /* best-effort resource release */ }
    }
    for (const channel of ['stdout', 'stderr']) {
      try { unlinkSync(path.join(this.root, `${this.id}.${channel}`)); } catch { /* unavailable storage */ }
    }
  }

  finish(): ToolOutputCaptureSummary {
    if (!this.finished) {
      this.finished = true;
      try { closeSync(this.stdoutHandle); } finally { closeSync(this.stderrHandle); }
    }
    const stdout = this.stdoutCapture.value();
    const stderr = this.stderrCapture.value();
    const stdoutBytes = stdout.bytes;
    const stderrBytes = stderr.bytes;
    const hash = hashFiles(
      path.join(this.root, `${this.id}.stdout`),
      path.join(this.root, `${this.id}.stderr`),
    );
    const artifact: ToolOutputArtifactReference = {
      kind: 'tool-output', id: this.id, stdoutBytes, stderrBytes, totalBytes: stdoutBytes + stderrBytes, sha256: hash,
    };
    const stdoutDiagnostics = this.stdoutDiagnostics.finish();
    const stderrDiagnostics = this.stderrDiagnostics.finish();
    const diagnostics = boundedDiagnostics(
      [...stdoutDiagnostics.lines, ...stderrDiagnostics.lines].join('\n'), '', this.policy,
    );
    return {
      artifact,
      stdout,
      stderr,
      diagnostics: diagnostics.lines,
      diagnosticsTruncated: stdoutDiagnostics.truncated || stderrDiagnostics.truncated || diagnostics.truncated,
    };
  }
}

function reference(id: string, stdout: string, stderr: string): ToolOutputArtifactReference {
  return {
    kind: 'tool-output',
    id,
    stdoutBytes: utf8Bytes(stdout),
    stderrBytes: utf8Bytes(stderr),
    totalBytes: utf8Bytes(stdout) + utf8Bytes(stderr),
    sha256: artifactHash(stdout, stderr),
  };
}

function openPrivateFile(filePath: string): number {
  const handle = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stat = fstatSync(handle);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())) {
    closeSync(handle);
    throw new Error('Tool-output artifact is not a private regular file.');
  }
  return handle;
}

function hashFiles(stdoutPath: string, stderrPath: string): string {
  const hash = createHash('sha256');
  hashFile(stdoutPath, hash);
  hash.update('\0', 'utf8');
  hashFile(stderrPath, hash);
  return hash.digest('hex');
}

function hashFile(filePath: string, hash: ReturnType<typeof createHash>): void {
  const handle = openPrivateFile(filePath);
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(handle);
  }
}

function searchCapture(capture: ToolOutputCapture, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
  const { maxMatches, maxBytes } = validateSearchRequest(request);
  const channels = request.channel === undefined ? (['stdout', 'stderr'] as const) : [request.channel];
  const results: ToolOutputMatch[] = [];
  for (const channel of channels) {
    const value = channel === 'stdout' ? capture.stdout : capture.stderr;
    scanText(channel, value, request.query, maxMatches, maxBytes, results);
    if (results.length >= maxMatches) return results;
  }
  return results;
}

function validateSearchRequest(request: ToolOutputSearchRequest): { readonly maxMatches: number; readonly maxBytes: number } {
  if (request.channel !== undefined && request.channel !== 'stdout' && request.channel !== 'stderr') throw new Error('Invalid tool-output channel.');
  if (request.query.trim() === '') throw new Error('Tool-output search query must not be empty.');
  const maxMatches = request.maxMatches ?? DEFAULT_TOOL_OUTPUT_POLICY.maxDiagnostics;
  assertPositiveInteger(maxMatches, 'maxMatches');
  const maxBytes = request.maxBytes ?? DEFAULT_TOOL_OUTPUT_POLICY.diagnosticBytes;
  assertPositiveInteger(maxBytes, 'maxBytes');
  return { maxMatches, maxBytes };
}

function scanText(
  channel: 'stdout' | 'stderr',
  value: string,
  query: string,
  maxMatches: number,
  maxBytes: number,
  results: ToolOutputMatch[],
): void {
  scanDecodedChunks(channel, query, maxMatches, maxBytes, results, [value], emptySearchState(), true);
}

interface SearchScanState {
  line: number;
  offset: number;
  lineBytes: number;
  matchTail: string;
  matchedText?: string;
}

function emptySearchState(): SearchScanState {
  return { line: 1, offset: 0, lineBytes: 0, matchTail: '' };
}

function scanDecodedChunks(
  channel: 'stdout' | 'stderr',
  query: string,
  maxMatches: number,
  maxBytes: number,
  results: ToolOutputMatch[],
  chunks: readonly string[],
  initialState: SearchScanState,
  final = false,
): SearchScanState {
  let pending = initialState;
  for (const chunk of chunks) {
    let remainder = chunk;
    while (remainder !== '') {
      const newlineIndex = remainder.search(/\r?\n/);
      if (newlineIndex < 0) {
        pending = appendSearchSegment(pending, remainder, query, maxBytes);
        break;
      }
      const delimiter = remainder.startsWith('\r\n', newlineIndex) ? '\r\n' : remainder.slice(newlineIndex, newlineIndex + 1);
      pending = appendSearchSegment(pending, remainder.slice(0, newlineIndex), query, maxBytes);
      if (pending.matchedText !== undefined && results.length < maxMatches) {
        results.push({
          channel,
          line: pending.line,
          offset: pending.offset,
          text: pending.matchedText,
          ...(pending.lineBytes > utf8Bytes(pending.matchedText) ? { truncated: true } : {}),
        });
      }
      pending = {
        line: pending.line + 1,
        offset: pending.offset + pending.lineBytes + utf8Bytes(delimiter),
        lineBytes: 0,
        matchTail: '',
      };
      remainder = remainder.slice(newlineIndex + delimiter.length);
      if (results.length >= maxMatches) break;
    }
    if (results.length >= maxMatches) break;
  }
  if (final && results.length < maxMatches && pending.matchedText !== undefined) {
    results.push({
      channel,
      line: pending.line,
      offset: pending.offset,
      text: pending.matchedText,
      ...(pending.lineBytes > utf8Bytes(pending.matchedText) ? { truncated: true } : {}),
    });
  }
  return pending;
}

function appendSearchSegment(state: SearchScanState, segment: string, query: string, maxBytes: number): SearchScanState {
  if (segment === '') return state;
  const candidate = `${state.matchTail}${segment}`;
  const matchIndex = state.matchedText === undefined ? candidate.indexOf(query) : -1;
  return {
    ...state,
    lineBytes: state.lineBytes + utf8Bytes(segment),
    matchTail: query.length <= 1 ? '' : candidate.slice(-(query.length - 1)),
    ...(matchIndex < 0 || state.matchedText !== undefined ? {} : { matchedText: boundedMatchText(candidate, matchIndex, query, maxBytes) }),
  };
}

function boundedMatchText(line: string, matchIndex: number, query: string, maxBytes: number): string {
  if (utf8Bytes(line) <= maxBytes) return line;
  if (utf8Bytes(query) >= maxBytes) return head(query, maxBytes);
  const queryBytes = utf8Bytes(query);
  const contextBytes = maxBytes - queryBytes;
  const beforeBytes = Math.floor(contextBytes / 2);
  const afterBytes = contextBytes - beforeBytes;
  return `${tail(line.slice(0, matchIndex), beforeBytes)}${query}${head(line.slice(matchIndex + query.length), afterBytes)}`;
}
