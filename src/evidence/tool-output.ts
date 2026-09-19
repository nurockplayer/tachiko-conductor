import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
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
}

export interface ToolOutputMatch {
  readonly channel: 'stdout' | 'stderr';
  readonly line: number;
  readonly offset: number;
  readonly text: string;
}

export interface ToolOutputStore {
  save(capture: ToolOutputCapture): ToolOutputArtifactReference;
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
  return bytes.subarray(bytes.length - maxBytes).toString('utf8');
}

function head(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= maxBytes ? value : bytes.subarray(0, maxBytes).toString('utf8');
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
    truncated: stdout.truncated || stderr.truncated,
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
  return store.search(envelope.artifact, request);
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
  return typeof overflowRecord.truncated === 'boolean' && typeof overflowRecord.summary === 'boolean' &&
    typeof overflowRecord.diagnostics === 'boolean' &&
    typeof overflowRecord.stdout === 'boolean' && typeof overflowRecord.stderr === 'boolean' &&
    [overflowRecord.totalBytes, overflowRecord.retainedBytes, overflowRecord.omittedBytes, overflowRecord.previewLimitBytes,
      overflowRecord.diagnosticLimitBytes, overflowRecord.diagnosticLimitLines]
      .every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0);
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

  save(capture: ToolOutputCapture): ToolOutputArtifactReference {
    const id = randomUUID();
    this.values.set(id, { stdout: capture.stdout, stderr: capture.stderr });
    return reference(id, capture.stdout, capture.stderr);
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
    const maxMatches = validateSearchRequest(request);
    const channels = request.channel === undefined ? (['stdout', 'stderr'] as const) : [request.channel];
    const results: ToolOutputMatch[] = [];
    for (const channel of channels) {
      const filePath = this.file(referenceValue.id, channel);
      if (!existsSync(filePath)) return this.fallback.search(referenceValue, request);
      results.push(...searchFile(filePath, channel, request.query, maxMatches, results.length));
      if (results.length >= maxMatches) break;
    }
    return results.slice(0, maxMatches);
  }

  private file(id: string, channel: 'stdout' | 'stderr'): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid tool-output artifact id.');
    return path.join(this.root, `${id}.${channel}`);
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
  const maxMatches = validateSearchRequest(request);
  const channels = request.channel === undefined ? (['stdout', 'stderr'] as const) : [request.channel];
  const results: ToolOutputMatch[] = [];
  for (const channel of channels) {
    const value = channel === 'stdout' ? capture.stdout : capture.stderr;
    scanText(channel, value, request.query, maxMatches, results);
    if (results.length >= maxMatches) return results;
  }
  return results;
}

function validateSearchRequest(request: ToolOutputSearchRequest): number {
  if (request.query.trim() === '') throw new Error('Tool-output search query must not be empty.');
  const maxMatches = request.maxMatches ?? DEFAULT_TOOL_OUTPUT_POLICY.maxDiagnostics;
  assertPositiveInteger(maxMatches, 'maxMatches');
  return maxMatches;
}

function scanText(
  channel: 'stdout' | 'stderr',
  value: string,
  query: string,
  maxMatches: number,
  results: ToolOutputMatch[],
): void {
  scanDecodedChunks(channel, query, maxMatches, results, [value], { text: '', line: 1, offset: 0 }, true);
}

function searchFile(
  filePath: string,
  channel: 'stdout' | 'stderr',
  query: string,
  maxMatches: number,
  existingMatches: number,
): readonly ToolOutputMatch[] {
  const results: ToolOutputMatch[] = [];
  const handle = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let state: SearchScanState = { text: '', line: 1, offset: 0 };
    let bytesRead: number;
    let chunks: string[] = [];
    do {
      bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) chunks.push(decoder.write(buffer.subarray(0, bytesRead)));
      if (chunks.length > 0) {
        state = scanDecodedChunks(channel, query, maxMatches - existingMatches, results, chunks, state);
        chunks = [];
      }
    } while (bytesRead > 0 && results.length + existingMatches < maxMatches);
    chunks.push(decoder.end());
    if (results.length + existingMatches < maxMatches) {
      scanDecodedChunks(channel, query, maxMatches - existingMatches, results, chunks, state, true);
    }
  } finally {
    closeSync(handle);
  }
  return results;
}

interface SearchScanState {
  text: string;
  line: number;
  offset: number;
}

function scanDecodedChunks(
  channel: 'stdout' | 'stderr',
  query: string,
  maxMatches: number,
  results: ToolOutputMatch[],
  chunks: readonly string[],
  initialState: SearchScanState,
  final = false,
): SearchScanState {
  let pending = initialState;
  for (const chunk of chunks) {
    pending.text += chunk;
    let newline: RegExpMatchArray | null;
    while ((newline = pending.text.match(/\r?\n/)) !== null) {
      const newlineIndex = newline.index ?? 0;
      const lineText = pending.text.slice(0, newlineIndex);
      const delimiter = newline[0];
      if (lineText.includes(query) && results.length < maxMatches) {
        results.push({ channel, line: pending.line, offset: pending.offset, text: lineText });
      }
      pending = {
        text: pending.text.slice(newlineIndex + delimiter.length),
        line: pending.line + 1,
        offset: pending.offset + utf8Bytes(lineText) + utf8Bytes(delimiter),
      };
      if (results.length >= maxMatches) break;
    }
    if (results.length >= maxMatches) break;
  }
  if (final && results.length < maxMatches && pending.text !== '' && pending.text.includes(query)) {
    results.push({ channel, line: pending.line, offset: pending.offset, text: pending.text });
    pending = { text: '', line: pending.line, offset: pending.offset + utf8Bytes(pending.text) };
  }
  return pending;
}
