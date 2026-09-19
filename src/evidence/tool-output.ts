import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync, writeSync } from 'node:fs';
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
  readonly artifact: ToolOutputArtifactReference;
  readonly overflow: ToolOutputOverflow;
}

export interface ToolOutputCapture {
  readonly stdout: string;
  readonly stderr: string;
}

export interface ToolOutputCaptureSummary {
  readonly artifact: ToolOutputArtifactReference;
  readonly stdout: ToolOutputStream;
  readonly stderr: ToolOutputStream;
  readonly diagnostics: readonly string[];
  readonly diagnosticsTruncated: boolean;
}

export interface ToolOutputCaptureWriter {
  write(channel: 'stdout' | 'stderr', chunk: string): void;
  finish(): ToolOutputCaptureSummary;
}

export interface ToolOutputReadRequest {
  readonly channel: 'stdout' | 'stderr';
  readonly offset?: number;
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
  for (const line of selected.slice(-policy.maxDiagnostics)) {
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
  const artifact = input.store.save({ stdout: input.stdout, stderr: input.stderr });
  const stdout = stream(input.stdout, policy.previewBytes);
  const stderr = stream(input.stderr, policy.previewBytes);
  const diagnostics = boundedDiagnostics(input.stdout, input.stderr, policy);
  const rawSummary = input.summary?.trim() || `${input.outcome}${input.exitCode === null ? '' : ` (exit ${input.exitCode})`}`;
  const summary = head(rawSummary, policy.diagnosticBytes);
  const retainedBytes = stdout.previewBytes + stderr.previewBytes;
  const totalBytes = artifact.totalBytes;
  const overflow = {
    truncated: Boolean(input.captureTruncated) || stdout.truncated || stderr.truncated || diagnostics.truncated || utf8Bytes(summary) < utf8Bytes(rawSummary),
    capture: Boolean(input.captureTruncated),
    summary: utf8Bytes(summary) < utf8Bytes(rawSummary),
    diagnostics: diagnostics.truncated,
    stdout: stdout.truncated,
    stderr: stderr.truncated,
    totalBytes,
    retainedBytes,
    omittedBytes: Math.max(0, totalBytes - retainedBytes),
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
    stdout,
    stderr,
    diagnostics: diagnostics.lines,
    artifact,
    overflow,
  };
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
  const rawSummary = input.summary?.trim() || `${input.outcome}${input.exitCode === null ? '' : ` (exit ${input.exitCode})`}`;
  const summary = head(rawSummary, policy.diagnosticBytes);
  const overflow = {
    truncated: Boolean(input.captureTruncated) || input.capture.stdout.truncated || input.capture.stderr.truncated || input.capture.diagnosticsTruncated || utf8Bytes(summary) < utf8Bytes(rawSummary),
    capture: Boolean(input.captureTruncated),
    summary: utf8Bytes(summary) < utf8Bytes(rawSummary),
    diagnostics: input.capture.diagnosticsTruncated,
    stdout: input.capture.stdout.truncated,
    stderr: input.capture.stderr.truncated,
    totalBytes: input.capture.artifact.totalBytes,
    retainedBytes: input.capture.stdout.previewBytes + input.capture.stderr.previewBytes,
    omittedBytes: Math.max(0, input.capture.artifact.totalBytes - input.capture.stdout.previewBytes - input.capture.stderr.previewBytes),
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
  return store.read(envelope.artifact, { ...request, ...(request.length === undefined ? { length: envelope.readBytes } : {}) });
}

export function searchToolOutput(
  envelope: ToolOutputEnvelope,
  store: ToolOutputStore,
  request: ToolOutputSearchRequest,
): readonly ToolOutputMatch[] {
  if (envelope.version !== TOOL_OUTPUT_CONTRACT_VERSION) throw new Error('Unsupported tool-output envelope version.');
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
  if (!isToolOutputArtifact(envelope.artifact)) return false;
  const overflow = envelope.overflow;
  if (typeof overflow !== 'object' || overflow === null) return false;
  const overflowRecord = overflow as Record<string, unknown>;
  if (typeof overflowRecord.truncated !== 'boolean' || typeof overflowRecord.capture !== 'boolean' || typeof overflowRecord.summary !== 'boolean' ||
    typeof overflowRecord.diagnostics !== 'boolean' || typeof overflowRecord.stdout !== 'boolean' || typeof overflowRecord.stderr !== 'boolean' ||
    ![overflowRecord.totalBytes, overflowRecord.retainedBytes, overflowRecord.omittedBytes, overflowRecord.previewLimitBytes,
      overflowRecord.diagnosticLimitBytes, overflowRecord.diagnosticLimitLines]
      .every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)) return false;
  const expectedTruncated = overflowRecord.capture || overflowRecord.summary || overflowRecord.diagnostics || overflowRecord.stdout || overflowRecord.stderr;
  return envelope.stdout.previewBytes === utf8Bytes(envelope.stdout.preview) &&
    envelope.stderr.previewBytes === utf8Bytes(envelope.stderr.preview) &&
    envelope.artifact.totalBytes === envelope.artifact.stdoutBytes + envelope.artifact.stderrBytes &&
    overflowRecord.totalBytes === envelope.artifact.totalBytes &&
    overflowRecord.retainedBytes === envelope.stdout.previewBytes + envelope.stderr.previewBytes &&
    overflowRecord.omittedBytes === Math.max(0, overflowRecord.totalBytes - overflowRecord.retainedBytes) &&
    overflowRecord.stdout === envelope.stdout.truncated && overflowRecord.stderr === envelope.stderr.truncated &&
    overflowRecord.truncated === expectedTruncated;
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
  const total = request.channel === 'stdout' ? reference.stdoutBytes : reference.stderrBytes;
  const offset = request.offset ?? 0;
  const length = request.length ?? readBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error('Tool-output range offset is outside the artifact.');
  assertPositiveInteger(length, 'Tool-output range length');
  return { offset, length, total };
}

function readStringRange(value: string, offset: number, length: number): ToolOutputReadResult {
  const bytes = Buffer.from(value, 'utf8');
  const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + length));
  const text = chunk.toString('utf8');
  const nextOffset = Math.min(bytes.length, offset + chunk.length);
  return { channel: 'stdout', offset, text, bytes: chunk.length, nextOffset, eof: nextOffset >= bytes.length };
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

  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
    return new BufferedToolOutputWriter(this, policy);
  }

  read(referenceValue: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult {
    const capture = this.values.get(referenceValue.id);
    if (capture === undefined) throw new Error(`Tool-output artifact ${referenceValue.id} is unavailable.`);
    const range = validateReadRequest(referenceValue, request, DEFAULT_TOOL_OUTPUT_POLICY.readBytes);
    const value = request.channel === 'stdout' ? capture.stdout : capture.stderr;
    const result = readStringRange(value, range.offset, range.length);
    return { ...result, channel: request.channel };
  }

  search(referenceValue: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
    const capture = this.values.get(referenceValue.id);
    if (capture === undefined) throw new Error(`Tool-output artifact ${referenceValue.id} is unavailable.`);
    return searchCapture(capture, request);
  }
}

export class FileToolOutputStore implements ToolOutputStore {
  private readonly root: string;
  private readonly fallback = new InMemoryToolOutputStore();

  constructor(root = process.env.TACHIKO_EVIDENCE_DIR ?? path.join(os.tmpdir(), 'tachiko-conductor', 'evidence')) {
    this.root = path.resolve(root);
  }

  save(capture: ToolOutputCapture): ToolOutputArtifactReference {
    const id = randomUUID();
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      chmodSync(this.root, 0o700);
      writeFileSync(this.file(id, 'stdout'), capture.stdout, { encoding: 'utf8', mode: 0o600 });
      writeFileSync(this.file(id, 'stderr'), capture.stderr, { encoding: 'utf8', mode: 0o600 });
      return reference(id, capture.stdout, capture.stderr);
    } catch {
      // Evidence persistence must not change command/HEAD semantics. Keep a
      // same-process fallback so diagnostics remain drillable when the
      // configured artifact directory is temporarily unavailable.
      return this.fallback.save(capture);
    }
  }

  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
    try {
      return new FileToolOutputWriter(this.root, policy);
    } catch {
      return new BufferedToolOutputWriter(this.fallback, policy);
    }
  }

  read(referenceValue: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult {
    const range = validateReadRequest(referenceValue, request, DEFAULT_TOOL_OUTPUT_POLICY.readBytes);
    const filePath = this.file(referenceValue.id, request.channel);
    if (!existsSync(filePath)) return this.fallback.read(referenceValue, request);
    const handle = openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(range.length, range.total - range.offset));
      const bytes = readSync(handle, buffer, 0, buffer.length, range.offset);
      const text = buffer.subarray(0, bytes).toString('utf8');
      const nextOffset = range.offset + bytes;
      return { channel: request.channel, offset: range.offset, text, bytes, nextOffset, eof: nextOffset >= range.total };
    } finally {
      closeSync(handle);
    }
  }

  search(referenceValue: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
    const { maxMatches, maxBytes } = validateSearchRequest(request);
    const channels = request.channel === undefined ? (['stdout', 'stderr'] as const) : [request.channel];
    const results: ToolOutputMatch[] = [];
    for (const channel of channels) {
      const filePath = this.file(referenceValue.id, channel);
      if (!existsSync(filePath)) return this.fallback.search(referenceValue, request);
      results.push(...searchFile(filePath, channel, request.query, maxMatches, maxBytes, results.length));
      if (results.length >= maxMatches) break;
    }
    return results.slice(0, maxMatches);
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
    this.pending += chunk;
    let match: RegExpMatchArray | null;
    while ((match = this.pending.match(/\r?\n/)) !== null) {
      const index = match.index ?? 0;
      this.line(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + match[0].length);
    }
    if (utf8Bytes(this.pending) > this.policy.diagnosticBytes * 2) {
      this.pending = tail(this.pending, this.policy.diagnosticBytes);
      this.dropped = true;
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
      this.highSignal.shift();
      this.dropped = true;
    }
  }
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
  private readonly stdoutHash = createHash('sha256');
  private readonly stderrHash = createHash('sha256');
  private finished = false;

  constructor(private readonly root: string, private readonly policy: ToolOutputPolicy) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.stdoutHandle = openSync(path.join(root, `${this.id}.stdout`), 'wx', 0o600);
    this.stderrHandle = openSync(path.join(root, `${this.id}.stderr`), 'wx', 0o600);
    this.stdoutCapture = new StreamCapture(policy.previewBytes);
    this.stderrCapture = new StreamCapture(policy.previewBytes);
    this.stdoutDiagnostics = new DiagnosticCapture(policy);
    this.stderrDiagnostics = new DiagnosticCapture(policy);
  }

  write(channel: 'stdout' | 'stderr', chunk: string): void {
    if (this.finished) throw new Error('Tool-output capture is already finished.');
    const bytes = Buffer.from(chunk, 'utf8');
    const handle = channel === 'stdout' ? this.stdoutHandle : this.stderrHandle;
    writeSync(handle, bytes, 0, bytes.length);
    if (channel === 'stdout') {
      this.stdoutHash.update(bytes);
      this.stdoutCapture.append(chunk);
      this.stdoutDiagnostics.append(chunk);
    } else {
      this.stderrHash.update(bytes);
      this.stderrCapture.append(chunk);
      this.stderrDiagnostics.append(chunk);
    }
  }

  finish(): ToolOutputCaptureSummary {
    if (!this.finished) {
      this.finished = true;
      closeSync(this.stdoutHandle);
      closeSync(this.stderrHandle);
    }
    const stdout = this.stdoutCapture.value();
    const stderr = this.stderrCapture.value();
    const stdoutBytes = stdout.bytes;
    const stderrBytes = stderr.bytes;
    const hash = createHash('sha256')
      .update(this.stdoutHash.digest())
      .update('\0', 'utf8')
      .update(this.stderrHash.digest())
      .digest('hex');
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

function searchFile(
  filePath: string,
  channel: 'stdout' | 'stderr',
  query: string,
  maxMatches: number,
  maxBytes: number,
  existingMatches: number,
): readonly ToolOutputMatch[] {
  const results: ToolOutputMatch[] = [];
  const handle = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let state = emptySearchState();
    let bytesRead: number;
    let chunks: string[] = [];
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) chunks.push(decoder.write(buffer.subarray(0, bytesRead)));
      if (chunks.length > 0) {
        state = scanDecodedChunks(channel, query, maxMatches - existingMatches, maxBytes, results, chunks, state);
        chunks = [];
      }
    } while (bytesRead > 0 && results.length + existingMatches < maxMatches);
    chunks.push(decoder.end());
    if (results.length + existingMatches < maxMatches) {
      scanDecodedChunks(channel, query, maxMatches - existingMatches, maxBytes, results, chunks, state, true);
    }
  } finally {
    closeSync(handle);
  }
  return results;
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
    matchTail: candidate.slice(-Math.max(0, query.length - 1)),
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
