import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, writeSync, renameSync, fsyncSync, lstatSync, fstatSync, constants, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { acquireDispatchInvocationLock, type DispatchInvocationLock } from '../dispatch/invocation-lock.js';

export const TOOL_OUTPUT_CONTRACT_VERSION = 'tachiko.tool-output.v1' as const;
export const DEFAULT_TOOL_OUTPUT_SLOT_CAPACITY = 256;
export const DEFAULT_TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOOL_OUTPUT_REGISTRATION_PROBES = 16;

export interface ToolOutputCleanupBudget {
  readonly maxSlotProbes?: number;
  readonly maxMetadataReadBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly maxDeletions?: number;
}

export interface ToolOutputCleanupResult {
  readonly probed: number;
  readonly deleted: number;
  readonly attempted: number;
  readonly protected: number;
  readonly cursor: number;
}

/** Deterministic filesystem fault seams used by focused capture containment tests. */
export interface ToolOutputFileTestFaults {
  readonly beforeCaptureStart?: () => void;
  readonly beforeSecondOpen?: () => void;
  readonly beforeFinish?: () => void;
  readonly writeSync?: (descriptor: number, bytes: Buffer, offset: number, length: number) => number;
  readonly beforeFsync?: (channel: 'stdout' | 'stderr') => void;
  readonly beforeHash?: () => void;
  readonly beforeArtifactOpen?: (kind: 'hash' | 'read' | 'search', channel: 'stdout' | 'stderr') => void;
  readonly afterArtifactOpen?: (descriptor: number, kind: 'hash' | 'read' | 'search', channel: 'stdout' | 'stderr') => void;
  readonly beforeUnlink?: (filePath: string) => void;
  readonly beforeOwnerLockUnlink?: (lockPath: string) => void;
  readonly beforeOwnerLockDirectoryFsync?: (lockPath: string) => void;
  readonly beforeOwnerLockDescriptorClose?: (lockPath: string, descriptor: number) => void;
  readonly beforeOperationMetadataDirectoryFsync?: (value: unknown) => void;
  readonly beforeStaleTakeover?: () => void;
  readonly beforeArtifactRootFsync?: (phase: 'abort' | 'finish' | 'cleanup') => void;
}

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
  /** Stable file identities recorded from the owned descriptors at capture finish. */
  readonly fileIdentity?: ToolOutputArtifactFileIdentity;
  readonly operationId?: string;
  readonly retainedUntil?: string;
}

export interface ToolOutputArtifactFileIdentity {
  readonly stdout: { readonly dev: string; readonly ino: string };
  readonly stderr: { readonly dev: string; readonly ino: string };
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
  abort?(): void;
}

export interface ToolOutputReadRequest {
  readonly channel: 'stdout' | 'stderr';
  /** A byte offset inside a UTF-8 character is aligned back to its start. */
  readonly offset?: number;
  /** Byte budget; a first character that cannot fit is returned whole (at most 4 bytes). */
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
  beginOperation?(attribution?: Readonly<Record<string, string | number | null>>): ToolOutputOperation;
  read(reference: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult;
  search(reference: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[];
}

export interface ToolOutputOperation {
  readonly id: string;
  startCapture(policy: ToolOutputPolicy, attribution?: Readonly<Record<string, string | number | null>>): ToolOutputCaptureWriter;
  close(): readonly ToolOutputArtifactReference[];
  abort(): void;
}

export interface ToolOutputCaptureSessionResult {
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly stdout: ToolOutputStream;
  readonly stderr: ToolOutputStream;
  readonly diagnostics: readonly string[];
  readonly diagnosticsTruncated: boolean;
  readonly capture?: ToolOutputCaptureSummary;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

interface EvidenceOperationLockRecord {
  readonly schemaVersion: 1;
  readonly nonce: string;
  readonly pid: number;
  readonly hostId: string;
  readonly bootId: string;
  readonly processStartId: string;
}

function isEvidenceOperationLockRecord(value: unknown): value is EvidenceOperationLockRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  return keys === 'bootId,hostId,nonce,pid,processStartId,schemaVersion' && record.schemaVersion === 1 &&
    typeof record.nonce === 'string' && record.nonce !== '' && record.nonce.length <= 256 &&
    Number.isSafeInteger(record.pid) && (record.pid as number) > 0 &&
    typeof record.hostId === 'string' && /^[0-9a-f]{64}$/.test(record.hostId) &&
    typeof record.bootId === 'string' && /^[0-9a-f]{64}$/.test(record.bootId) &&
    typeof record.processStartId === 'string' && record.processStartId !== '' && record.processStartId.length <= 256;
}

function sameEvidenceOperationLockRecord(left: EvidenceOperationLockRecord, right: EvidenceOperationLockRecord): boolean {
  return left.schemaVersion === right.schemaVersion && left.nonce === right.nonce && left.pid === right.pid &&
    left.hostId === right.hostId && left.bootId === right.bootId && left.processStartId === right.processStartId;
}

function readEvidenceOperationLock(lockPath: string, accountRead?: (bytes: number) => void): EvidenceOperationLockRecord | undefined {
  let pathStats;
  try { pathStats = lstatSync(lockPath, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || pathStats.size > 4096n) {
    throw new Error('Evidence operation lock is not a bounded regular file.');
  }
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('Evidence operation lock admission requires O_NOFOLLOW support.');
  }
  const size = Number(pathStats.size);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Evidence operation lock has an invalid size.');
  accountRead?.(size);
  const descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0));
  try {
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    if (!descriptorStats.isFile() || descriptorStats.dev !== pathStats.dev || descriptorStats.ino !== pathStats.ino ||
        descriptorStats.size !== pathStats.size) throw new Error('Evidence operation lock changed during safe open.');
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(descriptor, data, offset, data.length - offset, offset);
      if (count === 0) throw new Error('Evidence operation lock read was shorter than its admitted size.');
      offset += count;
    }
    const finalStats = fstatSync(descriptor, { bigint: true });
    if (finalStats.dev !== descriptorStats.dev || finalStats.ino !== descriptorStats.ino || finalStats.size !== descriptorStats.size) {
      throw new Error('Evidence operation lock changed while being read.');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString('utf8')); }
    catch { throw new Error('Evidence operation lock is malformed JSON.'); }
    if (!isEvidenceOperationLockRecord(parsed)) throw new Error('Evidence operation lock does not use the exact versioned schema.');
    return parsed;
  } finally { closeSync(descriptor); }
}

interface AcquiredEvidenceOperationFence extends DispatchInvocationLock {
  readonly ownerNonce: string;
}

function acquireEvidenceOperationFence(
  lockPath: string,
  expectedOwnerNonce?: string,
  testFaults?: ToolOutputFileTestFaults,
  accountRead?: (bytes: number) => void,
  admittedPreflight?: { readonly record: EvidenceOperationLockRecord | undefined },
  onStaleTakeoverAttempt?: () => void,
): AcquiredEvidenceOperationFence {
  const preflight = admittedPreflight ?? { record: readEvidenceOperationLock(lockPath, accountRead) };
  if (preflight.record !== undefined && expectedOwnerNonce !== undefined && preflight.record.nonce !== expectedOwnerNonce) {
    throw new Error('Evidence operation lock nonce does not match its persisted owner.');
  }
  const ownerNonce = expectedOwnerNonce ?? randomUUID();
  const acquired = acquireDispatchInvocationLock({
    lockPath,
    nonce: () => ownerNonce,
    beforeStaleTakeover: () => {
      testFaults?.beforeStaleTakeover?.();
      const current = readEvidenceOperationLock(lockPath, accountRead);
      if (preflight.record === undefined || current === undefined || !sameEvidenceOperationLockRecord(current, preflight.record) ||
          (expectedOwnerNonce !== undefined && current.nonce !== expectedOwnerNonce)) {
        throw new Error('Evidence operation lock changed after strict preflight; stale takeover refused.');
      }
      onStaleTakeoverAttempt?.();
    },
  });
  // The shared primitive's exact owner record is stable for this operation;
  // consume this private handle before forwarding release so a duplicate call
  // cannot remove a later acquisition that intentionally reuses the nonce.
  let released = false;
  return {
    ownerNonce,
    release() {
      if (released) return;
      released = true;
      acquired.release();
    },
  };
}

interface PendingTerminalTransition {
  readonly kind: 'terminal';
  readonly id: string;
  readonly slot: number;
  retry(accountRead: (bytes: number) => void, beginDeletion: () => void, finishDeletion: () => void): void;
}

interface PendingReleaseTransition {
  readonly kind: 'release';
  readonly id: string;
  readonly slot: number;
  retry(budget: CleanupRetryBudget): 'complete' | 'pending';
}

interface CleanupRetryBudget extends TerminalRetryBudget {
  readonly remainingDeletions: () => number;
  readonly maxMetadataBytes: number;
  readonly canRead: (bytes: number) => boolean;
}

interface PendingCleanupTransition {
  readonly kind: 'cleanup';
  readonly id: string;
  readonly slot: number;
  retry(budget: CleanupRetryBudget): 'complete' | 'released' | 'pending';
}

interface CleanupSlotWrite {
  readonly fromDeleting: boolean;
  readonly fromIds: readonly string[];
  readonly toIds: readonly string[];
}

interface CleanupRecoveryState {
  phase: 'admission' | 'tombstone' | 'owner-release' | 'release-only' | 'finalize' | 'slot-sync';
  tombstoneDurable: boolean;
  artifactIds: string[];
  pendingSlotWrite?: CleanupSlotWrite;
  ownerDisposed: boolean;
  metadataRemoved: boolean;
  slotUnlinkCommitted: boolean;
}

type PendingRecoveryTransition = PendingTerminalTransition | PendingReleaseTransition | PendingCleanupTransition;

interface TerminalRetryBudget {
  readonly accountRead: (bytes: number) => void;
  readonly beginDeletion: () => void;
  readonly finishDeletion: () => void;
}

const pendingTerminalTransitions = new Map<string, Map<string, PendingRecoveryTransition>>();

function rootTerminalTransitions(root: string): Map<string, PendingRecoveryTransition> {
  let transitions = pendingTerminalTransitions.get(root);
  if (transitions === undefined) {
    transitions = new Map();
    pendingTerminalTransitions.set(root, transitions);
  }
  return transitions;
}

function registerPendingTerminalTransition(root: string, capacity: number, transition: PendingRecoveryTransition): void {
  const transitions = rootTerminalTransitions(root);
  const existing = transitions.get(transition.id);
  if (existing === transition) return;
  if (existing !== undefined) throw new Error('Tool-output operation already has a conflicting pending recovery entry.');
  if (transitions.size >= capacity) throw new Error('Tool-output pending terminal recovery capacity is full.');
  transitions.set(transition.id, transition);
}

function forgetPendingTerminalTransition(root: string, id: string): void {
  const transitions = pendingTerminalTransitions.get(root);
  transitions?.delete(id);
  if (transitions?.size === 0) pendingTerminalTransitions.delete(root);
}

interface PinnedEvidenceOperationFence {
  state(): 'present' | 'unlinked' | 'complete';
  assertCurrent(accountRead?: (bytes: number) => void): void;
  release(budget?: TerminalRetryBudget): void;
}

function readEvidenceOperationRecordFromDescriptor(
  descriptor: number,
  expectedGeneration: { readonly dev: bigint; readonly ino: bigint },
  accountRead?: (bytes: number) => void,
): EvidenceOperationLockRecord {
  const before = fstatSync(descriptor, { bigint: true });
  if (!before.isFile() || before.dev !== expectedGeneration.dev || before.ino !== expectedGeneration.ino ||
      before.size < 1n || before.size > 4096n) throw new Error('Pinned evidence operation owner changed.');
  const size = Number(before.size);
  accountRead?.(size);
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, data, offset, size - offset, offset);
    if (count === 0) throw new Error('Pinned evidence operation owner read was short.');
    offset += count;
  }
  const after = fstatSync(descriptor, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error('Pinned evidence operation owner changed while being read.');
  }
  let value: unknown;
  try { value = JSON.parse(data.toString('utf8')); }
  catch { throw new Error('Pinned evidence operation owner is malformed.'); }
  if (!isEvidenceOperationLockRecord(value)) throw new Error('Pinned evidence operation owner is not versioned.');
  return value;
}

function pinEvidenceOperationFence(
  lockPath: string,
  expectedNonce: string,
  testFaults?: ToolOutputFileTestFaults,
  accountRead?: (bytes: number) => void,
): PinnedEvidenceOperationFence {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('Evidence operation ownership requires O_NOFOLLOW support.');
  }
  const pathBefore = lstatSync(lockPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) throw new Error('Evidence operation owner path is not a regular file.');
  const descriptor = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0));
  let keepDescriptor = false;
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== pathBefore.dev || opened.ino !== pathBefore.ino) {
      throw new Error('Evidence operation owner changed during pinning.');
    }
    const record = readEvidenceOperationRecordFromDescriptor(descriptor, { dev: opened.dev, ino: opened.ino }, accountRead);
    if (record.nonce !== expectedNonce || record.pid !== process.pid) {
      throw new Error('Evidence operation owner does not match the acquired local owner.');
    }
    const pathAfter = lstatSync(lockPath, { bigint: true });
    if (pathAfter.isSymbolicLink() || !pathAfter.isFile() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error('Evidence operation owner changed after pinning.');
    }
    let unlinkCommitted = false;
    let complete = false;
    const generation = { dev: opened.dev, ino: opened.ino };
    const assertCurrent = (accountRead?: (bytes: number) => void): void => {
      if (complete || unlinkCommitted) throw new Error('Evidence operation owner is no longer present for metadata publication.');
      let current;
      try { current = lstatSync(lockPath, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Evidence operation owner disappeared before terminal metadata was durable.');
        throw error;
      }
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== generation.dev || current.ino !== generation.ino) {
        throw new Error('Evidence operation owner generation changed; terminal metadata retry is protected.');
      }
      const currentRecord = readEvidenceOperationRecordFromDescriptor(descriptor, generation, accountRead);
      if (!sameEvidenceOperationLockRecord(currentRecord, record)) {
        throw new Error('Evidence operation owner record changed; terminal metadata retry is protected.');
      }
      const afterRead = lstatSync(lockPath, { bigint: true });
      if (afterRead.isSymbolicLink() || afterRead.dev !== generation.dev || afterRead.ino !== generation.ino) {
        throw new Error('Evidence operation owner generation changed during verification.');
      }
    };
    const syncOwnerDirectory = (): void => {
      testFaults?.beforeOwnerLockDirectoryFsync?.(lockPath);
      const directory = openSync(path.dirname(lockPath), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    };
    const closePinnedDescriptor = (): void => {
      // Node/libuv may have consumed the descriptor even when close reports
      // an error. Retire this numeric capability before the one close call so
      // retries can never close a descriptor that the OS has since reused.
      keepDescriptor = false;
      complete = true;
      testFaults?.beforeOwnerLockDescriptorClose?.(lockPath, descriptor);
      closeSync(descriptor);
    };
    keepDescriptor = true;
    return {
      state: () => complete ? 'complete' : unlinkCommitted ? 'unlinked' : 'present',
      assertCurrent,
      release: (budget) => {
        if (complete) return;
        if (unlinkCommitted) {
          let current;
          try { current = lstatSync(lockPath, { bigint: true }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (current !== undefined) {
            throw new Error('Evidence operation successor occupies the released owner path; recovery remains pending.');
          }
          syncOwnerDirectory();
          closePinnedDescriptor();
          return;
        }
        assertCurrent(budget?.accountRead);
        testFaults?.beforeOwnerLockUnlink?.(lockPath);
        // Revalidate after the synchronous fault seam so replacement with a
        // byte-identical owner record on a different inode is never unlinked.
        assertCurrent(budget?.accountRead);
        budget?.beginDeletion();
        unlinkSync(lockPath);
        unlinkCommitted = true;
        budget?.finishDeletion();
        syncOwnerDirectory();
        closePinnedDescriptor();
      },
    };
  } finally {
    if (!keepDescriptor) { try { closeSync(descriptor); } catch { /* preserve pinning failure */ } }
  }
}

function isToolOutputArtifactFileIdentity(value: unknown): value is ToolOutputArtifactFileIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as Record<string, unknown>;
  const validPart = (part: unknown): boolean => typeof part === 'object' && part !== null &&
    typeof (part as Record<string, unknown>).dev === 'string' && /^\d+$/.test((part as Record<string, unknown>).dev as string) &&
    typeof (part as Record<string, unknown>).ino === 'string' && /^\d+$/.test((part as Record<string, unknown>).ino as string);
  return validPart(identity.stdout) && validPart(identity.stderr);
}

function sameToolOutputArtifactFileIdentity(left: unknown, right: ToolOutputArtifactFileIdentity): boolean {
  if (!isToolOutputArtifactFileIdentity(left)) return false;
  return left.stdout.dev === right.stdout.dev && left.stdout.ino === right.stdout.ino &&
    left.stderr.dev === right.stderr.dev && left.stderr.ino === right.stderr.ino;
}

function validOperationMetadata(value: Record<string, unknown>, id: string, slot: number): boolean {
  if (value.schemaVersion !== 1 || value.id !== id || value.slot !== slot ||
      typeof value.ownerNonce !== 'string' || value.ownerNonce === '' || value.ownerNonce.length > 256 ||
      !isCanonicalTimestamp(value.createdAt) || !['active', 'closed', 'released', 'aborted'].includes(String(value.state)) ||
      typeof value.attribution !== 'object' || value.attribution === null || Array.isArray(value.attribution)) return false;
  if (value.activeCaptureIds !== undefined && (!Array.isArray(value.activeCaptureIds) ||
      !value.activeCaptureIds.every((entry) => typeof entry === 'string' && /^[0-9a-f-]{36}$/.test(entry)))) return false;
  const validArtifact = (entry: unknown, committed: boolean): boolean => {
    if (typeof entry !== 'object' || entry === null) return false;
    const artifact = entry as Record<string, unknown>;
    return artifact.kind === 'tool-output' && typeof artifact.id === 'string' && /^[0-9a-f-]{36}$/.test(artifact.id) &&
      Number.isSafeInteger(artifact.stdoutBytes) && (artifact.stdoutBytes as number) >= 0 &&
      Number.isSafeInteger(artifact.stderrBytes) && (artifact.stderrBytes as number) >= 0 &&
      artifact.totalBytes === (artifact.stdoutBytes as number) + (artifact.stderrBytes as number) &&
      typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256) &&
      (artifact.fileIdentity === undefined || isToolOutputArtifactFileIdentity(artifact.fileIdentity)) &&
      (!committed || (artifact.operationId === id && artifact.retainedUntil === value.retainedUntil));
  };
  for (const name of ['artifacts', 'captures'] as const) {
    const entries = value[name];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return false;
    for (const entry of entries) {
      const artifact = name === 'captures' && typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>).artifact : entry;
      if (name === 'captures' && (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).attribution !== 'object')) return false;
      if (!validArtifact(artifact, value.state === 'closed' || value.state === 'released')) return false;
    }
  }
  if (value.state === 'active') return true;
  if (!isCanonicalTimestamp(value.closedAt)) return false;
  if (value.state === 'aborted') return true;
  if (!isCanonicalTimestamp(value.retainedUntil)) return false;
  if (value.state === 'released' && !isCanonicalTimestamp(value.releasedAt)) return false;
  return true;
}

function ensurePrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(resolved)) throw new Error('Tool-output evidence path must be absolute.');
  const root = path.parse(resolved).root;
  let current = root;
  for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (typeof error !== 'object' || error === null || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Tool-output evidence path contains a non-directory or symlink: ${current}`);
  }
  chmodSync(resolved, 0o700);
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
  const highSignal = /\b(error|failed|failure|fatal|exception|assert|panic|timeout|timed[ -]?out|denied|invalid|cannot|could not|fail|not ok\s+\d+)\b|✖/i;
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
  const retained = selected.length <= policy.maxDiagnostics ? selected
    : policy.maxDiagnostics === 1 ? [selected[0]!] : [selected[0]!, ...selected.slice(-(policy.maxDiagnostics - 1))];
  for (const line of retained) {
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
    typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    (artifact.fileIdentity === undefined || isToolOutputArtifactFileIdentity(artifact.fileIdentity));
}

function validateReadRequest(reference: ToolOutputArtifactReference, request: ToolOutputReadRequest, readBytes: number): { readonly offset: number; readonly length: number; readonly total: number } {
  const total = request.channel === 'stdout' ? reference.stdoutBytes : reference.stderrBytes;
  const offset = request.offset ?? 0;
  const length = request.length ?? readBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw new Error('Tool-output range offset is outside the artifact.');
  assertPositiveInteger(length, 'Tool-output range length');
  return { offset, length, total };
}

function readUtf8Range(bytes: Buffer, bufferOffset: number, offset: number, length: number, total: number): ToolOutputReadResult {
  // Both stores supply up to three bytes of lookbehind/lookahead so a valid
  // UTF-8 character is never decoded from an isolated partial byte sequence.
  let start = offset - bufferOffset;
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  let end = start + Math.min(length, bytes.length - start);
  while (end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  if (end === start && start < bytes.length) {
    // Even a one-byte budget must make progress. Return only the first whole
    // character when it is larger than the budget, never a replacement glyph.
    end = start + 1;
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  const chunk = bytes.subarray(start, end);
  const text = chunk.toString('utf8');
  const actualOffset = bufferOffset + start;
  const nextOffset = actualOffset + chunk.length;
  return { channel: 'stdout', offset: actualOffset, text, bytes: chunk.length, nextOffset, eof: nextOffset >= total };
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
    const bytes = Buffer.from(value, 'utf8');
    const result = readUtf8Range(bytes, 0, range.offset, range.length, bytes.length);
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
  private readonly operationsDir: string;
  private readonly capacity: number;
  private readonly retentionMs: number;
  private readonly maxRegistrationProbes: number;
  private readonly now: () => Date;
  private readonly testFaults: ToolOutputFileTestFaults | undefined;

  constructor(root: string, options: { readonly capacity?: number; readonly retentionMs?: number; readonly maxRegistrationProbes?: number; readonly now?: () => Date; readonly testFaults?: ToolOutputFileTestFaults } = {}) {
    if (!path.isAbsolute(root)) throw new Error('Tool-output evidence root must be an absolute stable path.');
    this.capacity = options.capacity ?? DEFAULT_TOOL_OUTPUT_SLOT_CAPACITY;
    assertPositiveInteger(this.capacity, 'Tool-output slot capacity');
    this.retentionMs = options.retentionMs ?? DEFAULT_TOOL_OUTPUT_RETENTION_MS;
    assertPositiveInteger(this.retentionMs, 'Tool-output retention duration');
    this.maxRegistrationProbes = options.maxRegistrationProbes ?? Math.min(DEFAULT_TOOL_OUTPUT_REGISTRATION_PROBES, this.capacity);
    assertPositiveInteger(this.maxRegistrationProbes, 'Tool-output registration probe budget');
    if (this.maxRegistrationProbes > this.capacity) throw new Error('Tool-output registration probe budget cannot exceed slot capacity.');
    this.now = options.now ?? (() => new Date());
    this.testFaults = options.testFaults;
    const requested = path.resolve(root);
    try {
      const suppliedRoot = lstatSync(requested);
      if (suppliedRoot.isSymbolicLink() || !suppliedRoot.isDirectory()) throw new Error('Tool-output evidence root must not be a symlink or non-directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let existing = requested;
    const suffix: string[] = [];
    while (!existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
    this.root = path.join(realpathSync(existing), ...suffix);
    this.operationsDir = path.join(this.root, 'operations');
  }

  save(capture: ToolOutputCapture): ToolOutputArtifactReference {
    const operation = this.beginOperation({ kind: 'standalone-save' });
    try {
      const writer = operation.startCapture(DEFAULT_TOOL_OUTPUT_POLICY);
      writer.write('stdout', capture.stdout);
      writer.write('stderr', capture.stderr);
      const summary = writer.finish();
      return operation.close().find((item) => item.id === summary.artifact.id)!;
    } catch (error) {
      try { operation.abort(); } catch { /* preserve the original capture-start/write failure */ }
      throw error;
    }
  }

  startCapture(policy: ToolOutputPolicy): ToolOutputCaptureWriter {
    const operation = this.beginOperation({ kind: 'standalone-capture' });
    let writer: ToolOutputCaptureWriter;
    try { writer = operation.startCapture(policy); }
    catch (error) {
      try { operation.abort(); } catch { /* preserve the original capture-start failure */ }
      throw error;
    }
    let captureState: 'open' | 'finishing' | 'finished' | 'failed' | 'aborted' | 'commit-pending' = 'open';
    let writerFinished = false;
    let finishedSummary: ToolOutputCaptureSummary | undefined;
    return {
      write: (channel, chunk) => {
        if (captureState !== 'open') throw new Error('Tool-output capture is no longer writable.');
        writer.write(channel, chunk);
      },
      finish: () => {
        if (captureState === 'commit-pending') {
          try {
            const artifact = operation.close().find((item) => item.id === finishedSummary!.artifact.id);
            if (artifact === undefined) throw new Error('Tool-output operation did not commit its artifact.');
            captureState = 'finished';
            return { ...finishedSummary!, artifact };
          } catch (error) {
            throw error;
          }
        }
        if (captureState !== 'open') throw new Error('Tool-output capture can only finish once.');
        captureState = 'finishing';
        let summary: ToolOutputCaptureSummary;
        try {
          summary = writer.finish();
          writerFinished = true;
          finishedSummary = summary;
        } catch (error) {
          captureState = 'failed';
          try { writer.abort?.(); } catch { /* preserve the original finish failure */ }
          try { operation.abort(); } catch { /* preserve the original finish failure */ }
          throw error;
        }
        try {
          const artifact = operation.close().find((item) => item.id === summary.artifact.id);
          if (artifact === undefined) throw new Error('Tool-output operation did not commit its artifact.');
          captureState = 'finished';
          return { ...summary, artifact };
        } catch (error) {
          // close() can fail after an atomic rename. Keep the backing files and
          // operation lock for a safe retry/recovery rather than aborting a
          // reference that may already be committed.
          captureState = 'commit-pending';
          throw error;
        }
      },
      abort: () => {
        if (captureState === 'finished' || captureState === 'aborted' || captureState === 'commit-pending') return;
        if (writerFinished) return;
        let failure: unknown;
        try { writer.abort?.(); } catch (error) { failure = error; }
        // A failed per-writer disposal must not strand its owning operation.
        // Operation abort retries every prepared writer and records unresolved
        // IDs before releasing ownership; keep the first disposal error as the
        // caller-visible result if that retry also encounters a fault.
        try { operation.abort(); } catch (error) { failure ??= error; }
        if (failure === undefined) captureState = 'aborted';
        else captureState = 'failed';
        if (failure !== undefined) throw failure;
      },
    };
  }

  beginOperation(attribution: Readonly<Record<string, string | number | null>> = {}): ToolOutputOperation {
    ensurePrivateDirectory(this.root);
    const operations = this.operationsDir;
    ensurePrivateDirectory(operations);
    // Reclaim at most one bounded cursor batch on each real capture operation.
    // Failure is explicit: a new capture never evicts or silently bypasses debt.
    this.cleanupExpired();
    const id = randomUUID();
    const lockPath = path.join(operations, `${id}.lock`);
    const ownerNonce = randomUUID();
    let lock: DispatchInvocationLock;
    try { lock = acquireDispatchInvocationLock({ lockPath, nonce: () => ownerNonce }); }
    catch (error) { throw new Error(`Tool-output capture operation ownership is unavailable: ${error instanceof Error ? error.message : 'unknown lock error'}`); }
    let ownerFence: PinnedEvidenceOperationFence;
    try { ownerFence = pinEvidenceOperationFence(lockPath, ownerNonce, this.testFaults); }
    catch (error) {
      try { lock.release(); } catch { /* initial owner-pin failure remains primary */ }
      throw error;
    }
    let slot: number;
    try { slot = this.registerOperation(id, operations); }
    catch (error) { try { ownerFence.release(); } catch { /* pre-metadata registration debt remains protected */ } throw error; }
    const artifacts: ToolOutputArtifactReference[] = [];
    const captureAttributions: Array<Readonly<Record<string, string | number | null>>> = [];
    const activeCaptureIds: string[] = [];
    const unresolvedCaptureIds = new Set<string>();
    const activeWriters = new Set<FileToolOutputWriter>();
    const allWriters = new Map<FileToolOutputWriter, string>();
    const metadataPath = path.join(operations, `${id}.json`);
    const writeMetadata = (value: unknown) => writeAtomicJson(operations, metadataPath, value, () => {
      const state = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).state : undefined;
      if (state === 'closed' || state === 'aborted') this.testFaults?.beforeOperationMetadataDirectoryFsync?.(value);
    });
    const createdAt = new Date().toISOString();
    const base = { schemaVersion: 1, id, slot, ownerNonce, createdAt, attribution };
    try { writeMetadata({ ...base, state: 'active', artifacts: [], activeCaptureIds }); }
    catch (error) { try { ownerFence.release(); } catch { /* initial metadata bootstrap debt remains protected */ } throw error; }
    let operationState: 'open' | 'close-pending' | 'abort-pending' | 'closed' = 'open';
    let closeTimestamp: string | undefined;
    let retainedUntil: string | undefined;
    let committedReferences: ToolOutputArtifactReference[] | undefined;
    let publicCloseDelivered = false;
    let abortTimestamp: string | undefined;
    let terminalKind: 'close' | 'abort' | undefined;
    let terminalMetadata: Record<string, unknown> | undefined;
    let terminalMetadataDurable = false;
    const pendingTransition: PendingTerminalTransition = {
      kind: 'terminal',
      id,
      slot,
      retry: (accountRead, beginDeletion, finishDeletion) => {
        attemptTerminalTransition({ accountRead, beginDeletion, finishDeletion });
      },
    };
    const attemptTerminalTransition = (budget?: TerminalRetryBudget): readonly ToolOutputArtifactReference[] | undefined => {
      if (terminalKind === undefined || terminalMetadata === undefined) throw new Error('Tool-output terminal transition has no frozen intent.');
      if (!terminalMetadataDurable) {
        ownerFence.assertCurrent(budget?.accountRead);
        writeMetadata(terminalMetadata);
        terminalMetadataDurable = true;
      }
      ownerFence.release(budget);
      operationState = 'closed';
      forgetPendingTerminalTransition(this.root, id);
      return terminalKind === 'close' ? committedReferences : undefined;
    };
    const retainPendingTransition = (): void => registerPendingTerminalTransition(this.root, this.capacity, pendingTransition);
    return {
      id,
      startCapture: (policy, commandAttribution = {}) => {
        if (operationState !== 'open') throw new Error('Tool-output operation is not accepting captures.');
        const captureId = randomUUID();
        activeCaptureIds.push(captureId);
        writeMetadata({ ...base, state: 'active', activeCaptureIds, captures: artifacts.map((artifact, index) => ({ artifact, attribution: captureAttributions[index] })) });
        let writer: FileToolOutputWriter;
        try {
          this.testFaults?.beforeCaptureStart?.();
          writer = new FileToolOutputWriter(this.root, policy, captureId, this.testFaults);
        }
        catch (error) {
          unresolvedCaptureIds.add(captureId);
          try { writeMetadata({ ...base, state: 'active', activeCaptureIds, artifacts }); } catch { /* preserve the original start failure */ }
          throw error;
        }
        activeWriters.add(writer);
        allWriters.set(writer, captureId);
        let captureState: 'open' | 'finishing' | 'finished' | 'failed' | 'aborted' = 'open';
        return {
          write: (channel, chunk) => {
            if (captureState !== 'open' || operationState !== 'open') throw new Error('Tool-output capture is no longer writable.');
            writer.write(channel, chunk);
          },
          finish: () => {
            if (captureState !== 'open' || operationState !== 'open') throw new Error('Tool-output capture can only finish once while its operation is open.');
            captureState = 'finishing';
            let summary: ToolOutputCaptureSummary;
            try { summary = writer.finish(); }
            catch (error) { captureState = 'failed'; throw error; }
            const nextArtifacts = [...artifacts, summary.artifact];
            const nextAttributions = [...captureAttributions, commandAttribution];
            try {
              // Keep the registered ID beside the finished reference until the
              // operation's terminal commit. Either old or new metadata then
              // names every file if this atomic replacement is interrupted.
              writeMetadata({
                ...base, state: 'active', activeCaptureIds,
                captures: nextArtifacts.map((artifact, index) => ({ artifact, attribution: nextAttributions[index] })),
                artifacts: nextArtifacts,
              });
            } catch (error) { captureState = 'failed'; throw error; }
            artifacts.push(summary.artifact);
            captureAttributions.push(commandAttribution);
            activeWriters.delete(writer);
            captureState = 'finished';
            return summary;
          },
          abort: () => {
            if (captureState === 'finished' || captureState === 'aborted' || operationState === 'closed') return;
            if (operationState === 'close-pending') throw new Error('Tool-output operation has a terminal commit pending.');
            try { writer.abort(); }
            catch (error) { captureState = 'failed'; throw error; }
            activeWriters.delete(writer);
            captureState = 'aborted';
          },
        };
      },
      close: () => {
        if (operationState === 'closed') {
          if (terminalKind === 'close' && !publicCloseDelivered) {
            publicCloseDelivered = true;
            return committedReferences!;
          }
          throw new Error('Tool-output operation is already closed.');
        }
        if (operationState === 'abort-pending') throw new Error('Tool-output operation abort is pending.');
        if (operationState === 'open') {
          if (activeWriters.size > 0 || unresolvedCaptureIds.size > 0) throw new Error('Tool-output operation cannot commit while a capture writer or prepared capture ID is unresolved.');
          closeTimestamp = this.now().toISOString();
          retainedUntil = new Date(Date.parse(closeTimestamp) + this.retentionMs).toISOString();
          committedReferences = artifacts.map((artifact) => ({ ...artifact, operationId: id, retainedUntil }));
          operationState = 'close-pending';
          terminalKind = 'close';
          terminalMetadata = {
            ...base, state: 'closed', closedAt: closeTimestamp, retainedUntil,
            activeCaptureIds: [],
            captures: committedReferences.map((artifact, index) => ({ artifact, attribution: captureAttributions[index] })),
            artifacts: committedReferences,
          };
          retainPendingTransition();
        }
        const references = attemptTerminalTransition()!;
        publicCloseDelivered = true;
        return references;
      },
      abort: () => {
        if (operationState === 'closed') return;
        if (operationState === 'close-pending') throw new Error('Tool-output operation close is pending and cannot be aborted.');
        if (operationState === 'abort-pending' && terminalMetadataDurable) {
          attemptTerminalTransition();
          return;
        }
        operationState = 'abort-pending';
        abortTimestamp ??= this.now().toISOString();
        let cleanupFailed = false;
        let firstFailure: unknown;
        for (const writer of allWriters.keys()) {
          try { writer.abort(); }
          catch (error) { cleanupFailed = true; firstFailure ??= error; }
        }
        const retainedCaptureIds = cleanupFailed ? [...activeCaptureIds] : [...unresolvedCaptureIds];
        terminalKind = 'abort';
        terminalMetadata = { ...base, state: 'aborted', closedAt: abortTimestamp, activeCaptureIds: retainedCaptureIds, artifacts: [] };
        terminalMetadataDurable = false;
        retainPendingTransition();
        try { attemptTerminalTransition(); }
        catch (error) { throw firstFailure ?? error; }
        if (firstFailure !== undefined) throw firstFailure;
      },
    };
  }

  read(referenceValue: ToolOutputArtifactReference, request: ToolOutputReadRequest): ToolOutputReadResult {
    const identity = this.assertAvailable(referenceValue);
    const range = validateReadRequest(referenceValue, request, DEFAULT_TOOL_OUTPUT_POLICY.readBytes);
    const filePath = this.file(referenceValue.id, request.channel);
    const expectedIdentity = identity[request.channel];
    const handle = openVerifiedArtifact(filePath, range.total, expectedIdentity, this.testFaults, 'read', request.channel);
    try {
      const bufferOffset = Math.max(0, range.offset - 3);
      const requestedBytes = Math.min(range.length, range.total - range.offset);
      const buffer = Buffer.alloc(Math.min(range.total - bufferOffset, range.offset - bufferOffset + requestedBytes + 3));
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(handle, buffer, bytes, buffer.length - bytes, bufferOffset + bytes);
        if (count === 0) throw new Error('Tool-output artifact range read was shorter than committed size.');
        bytes += count;
      }
      assertArtifactDescriptor(handle, range.total, expectedIdentity);
      const result = readUtf8Range(buffer.subarray(0, bytes), bufferOffset, range.offset, range.length, range.total);
      return { ...result, channel: request.channel };
    } finally {
      closeSync(handle);
    }
  }

  search(referenceValue: ToolOutputArtifactReference, request: ToolOutputSearchRequest): readonly ToolOutputMatch[] {
    const identity = this.assertAvailable(referenceValue);
    const { maxMatches, maxBytes } = validateSearchRequest(request);
    const channels = request.channel === undefined ? (['stdout', 'stderr'] as const) : [request.channel];
    const results: ToolOutputMatch[] = [];
    for (const channel of channels) {
      const filePath = this.file(referenceValue.id, channel);
      const expectedBytes = channel === 'stdout' ? referenceValue.stdoutBytes : referenceValue.stderrBytes;
      const handle = openVerifiedArtifact(filePath, expectedBytes, identity[channel], this.testFaults, 'search', channel);
      try {
        results.push(...searchFile(handle, expectedBytes, identity[channel], channel, request.query, maxMatches, maxBytes, results.length));
      } finally { closeSync(handle); }
      if (results.length >= maxMatches) break;
    }
    return results.slice(0, maxMatches);
  }

  /** Release one committed operation early; its refs become unavailable immediately. */
  release(referenceValue: ToolOutputArtifactReference): void {
    this.assertAvailable(referenceValue);
    const operationId = referenceValue.operationId!;
    const metadataPath = path.join(this.operationsDir, `${operationId}.json`);
    const initialMetadata = readBoundedJson(metadataPath, 1_048_576);
    const expectedOwnerNonce = initialMetadata.ownerNonce;
    const slot = initialMetadata.slot;
    if (initialMetadata.state !== 'closed' || initialMetadata.id !== operationId ||
        !Number.isSafeInteger(slot) || (slot as number) < 0 ||
        typeof expectedOwnerNonce !== 'string' || expectedOwnerNonce === '' || expectedOwnerNonce.length > 256 ||
        !validOperationMetadata(initialMetadata, operationId, slot as number)) {
      throw new Error('Tool-output operation cannot be released without valid committed owner metadata.');
    }
    const lockPath = path.join(this.operationsDir, `${operationId}.lock`);
    const admittedFence = acquireEvidenceOperationFence(
      lockPath, expectedOwnerNonce, this.testFaults,
    );
    let ownerFence: PinnedEvidenceOperationFence;
    try {
      ownerFence = pinEvidenceOperationFence(lockPath, admittedFence.ownerNonce, this.testFaults);
    } catch (error) {
      try { admittedFence.release(); } catch { /* preserve the pin failure */ }
      throw error;
    }
    const closedSnapshot = JSON.parse(JSON.stringify(initialMetadata)) as Record<string, unknown>;
    const releasedAt = this.now().toISOString();
    const releasedSnapshot: Record<string, unknown> = { ...closedSnapshot, state: 'released', releasedAt };
    let metadataDurable = false;
    let ownerDisposed = false;
    const transition: PendingReleaseTransition = {
      kind: 'release', id: operationId, slot: slot as number,
      retry: (budget) => {
        if (!ownerDisposed) {
          const ownerState = ownerFence.state();
          if (ownerState === 'complete') {
            ownerDisposed = true;
            forgetPendingTerminalTransition(this.root, operationId);
            return 'complete';
          }
          if (ownerState === 'unlinked') {
            ownerFence.release(budget);
            ownerDisposed = true;
            forgetPendingTerminalTransition(this.root, operationId);
            return 'complete';
          }
          ownerFence.assertCurrent(budget.accountRead);
          const currentSlot = this.readSlot(slot as number, budget.accountRead);
          if (currentSlot === undefined || currentSlot === null || currentSlot.id !== operationId || currentSlot.deleting) {
            throw new Error('Tool-output release slot changed before its owner disposal.');
          }
          if (!metadataDurable) {
            const current = readBoundedJson(metadataPath, budget.maxMetadataBytes, budget.accountRead);
            if (JSON.stringify(current) === JSON.stringify(releasedSnapshot)) {
              // A previous replacement may have succeeded while its directory
              // barrier failed. Re-establish that barrier before unlinking owner.
              const descriptor = openSync(this.operationsDir, constants.O_RDONLY);
              try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
            } else if (JSON.stringify(current) === JSON.stringify(closedSnapshot)) {
              ownerFence.assertCurrent(budget.accountRead);
              writeAtomicJson(this.operationsDir, metadataPath, releasedSnapshot,
                () => this.testFaults?.beforeOperationMetadataDirectoryFsync?.(releasedSnapshot));
            } else {
              throw new Error('Tool-output release metadata differs from its frozen consent snapshot.');
            }
            metadataDurable = true;
          }
          ownerFence.release(budget);
          ownerDisposed = true;
        }
        forgetPendingTerminalTransition(this.root, operationId);
        return 'complete';
      },
    };
    try { registerPendingTerminalTransition(this.root, this.capacity, transition); }
    catch (error) {
      try { ownerFence.release(); } catch { /* preserve indexed operation evidence on uncertain disposal */ }
      throw error;
    }
    const publicBudget: CleanupRetryBudget = {
      accountRead: () => {}, beginDeletion: () => {}, finishDeletion: () => {},
      remainingDeletions: () => Number.MAX_SAFE_INTEGER,
      maxMetadataBytes: 1_048_576,
      canRead: () => true,
    };
    transition.retry(publicBudget);
  }

  cleanupExpired(budget: ToolOutputCleanupBudget = {}): ToolOutputCleanupResult {
    const maxSlotProbes = budget.maxSlotProbes ?? 16;
    const maxMetadataBytes = budget.maxMetadataBytes ?? 1_048_576;
    const maxMetadataReadBytes = budget.maxMetadataReadBytes ?? 64 * 1_048_576;
    const maxDeletions = budget.maxDeletions ?? 64;
    assertPositiveInteger(maxSlotProbes, 'maxSlotProbes');
    assertPositiveInteger(maxMetadataBytes, 'maxMetadataBytes');
    assertPositiveInteger(maxMetadataReadBytes, 'maxMetadataReadBytes');
    assertPositiveInteger(maxDeletions, 'maxDeletions');
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(this.operationsDir);
    const maintenance = acquireDispatchInvocationLock({ lockPath: path.join(this.operationsDir, 'maintenance.lock') });
    let probed = 0;
    let deleted = 0;
    let attempted = 0;
    let protectedCount = 0;
    let cursor = 0;
    let metadataReadBytes = 0;
    const accountMetadataRead = (bytes: number): void => {
      if (metadataReadBytes + bytes > maxMetadataReadBytes) throw new Error('Tool-output cleanup metadata-read budget exhausted.');
      metadataReadBytes += bytes;
    };
    const retryBudget = (): CleanupRetryBudget => ({
      accountRead: accountMetadataRead,
      beginDeletion: () => {
        if (attempted >= maxDeletions) throw new Error('Tool-output cleanup deletion budget exhausted.');
        attempted += 1;
      },
      finishDeletion: () => { deleted += 1; },
      remainingDeletions: () => maxDeletions - attempted,
      maxMetadataBytes,
      canRead: (bytes) => metadataReadBytes + bytes <= maxMetadataReadBytes,
    });
    const syncOperationsDirectory = (): void => {
      const descriptor = openSync(this.operationsDir, constants.O_RDONLY);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    };
    const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((id, index) => id === right[index]);
    const cleanupTransition = (
      id: string,
      slot: number,
      initialSlot: { readonly id: string; readonly deleting: boolean; readonly artifactIds: readonly string[] },
      metadataOwnerNonce: string | undefined,
      ownerFence: PinnedEvidenceOperationFence,
    ): PendingCleanupTransition => {
      const slotPath = this.slotPath(slot);
      const metadataPath = path.join(this.operationsDir, `${id}.json`);
      const state: CleanupRecoveryState = {
        phase: 'admission', tombstoneDurable: false,
        artifactIds: initialSlot.deleting ? [...initialSlot.artifactIds] : [],
        ownerDisposed: false, metadataRemoved: false, slotUnlinkCommitted: false,
      };
      const readOwnSlot = (budget: CleanupRetryBudget): { readonly id: string; readonly deleting: boolean; readonly artifactIds: readonly string[] } => {
        const current = this.readSlot(slot, budget.accountRead);
        if (current === null || current === undefined || current.id !== id) {
          throw new Error('Cleanup slot identity changed while recovery was pending.');
        }
        return current;
      };
      const publishTombstone = (budget: CleanupRetryBudget): void => {
        const pending = state.pendingSlotWrite;
        if (pending === undefined) throw new Error('Cleanup tombstone write has no frozen transition.');
        const current = readOwnSlot(budget);
        const visibleTarget = current.deleting && sameIds(current.artifactIds, pending.toIds);
        const visibleSource = current.deleting === pending.fromDeleting && sameIds(current.artifactIds, pending.fromIds);
        if (visibleTarget) {
          syncOperationsDirectory();
        } else if (visibleSource) {
          ownerFence.assertCurrent(budget.accountRead);
          writeAtomicJson(this.operationsDir, slotPath, {
            schemaVersion: 1, capacity: this.capacity, slot, id,
            deleting: true, artifactIds: pending.toIds,
          });
        } else {
          throw new Error('Cleanup tombstone differs from its frozen source and target.');
        }
        state.artifactIds = [...pending.toIds];
        state.pendingSlotWrite = undefined;
        state.tombstoneDurable = true;
      };
      const finalizeReleasedCleanup = (budget: CleanupRetryBudget): 'complete' | 'released' => {
        if (state.artifactIds.length !== 0) return 'released';
        // A prior unlink may have succeeded while its directory fsync failed.
        // In that state the durable in-memory intent is the only authority;
        // retry the barrier without reopening or removing a possible successor.
        if (state.slotUnlinkCommitted || state.phase === 'slot-sync') {
          let slotExists = true;
          try { lstatSync(slotPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') slotExists = false; else throw error; }
          if (slotExists) throw new Error('Cleanup slot successor appeared before its directory barrier.');
          syncOperationsDirectory();
          state.slotUnlinkCommitted = false;
          forgetPendingTerminalTransition(this.root, id);
          return 'complete';
        }
        const current = readOwnSlot(budget);
        if (!current.deleting || current.artifactIds.length !== 0) throw new Error('Cleanup finalization requires the durable empty tombstone.');
        if (!state.metadataRemoved) {
          let metadataExists = true;
          try {
            const metadata = readBoundedJson(metadataPath, budget.maxMetadataBytes, budget.accountRead);
            if (!validOperationMetadata(metadata, id, slot) ||
                (metadataOwnerNonce !== undefined && metadata.ownerNonce !== metadataOwnerNonce)) {
              throw new Error('Cleanup operation metadata changed before final deletion.');
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') metadataExists = false;
            else throw error;
          }
          // Reserve the final slot unlink as well as metadata removal before
          // beginning either mutation; a short pass leaves the empty tombstone.
          const requiredDeletions = (metadataExists ? 1 : 0) + 1;
          if (budget.remainingDeletions() < requiredDeletions) return 'released';
          if (metadataExists) {
            budget.beginDeletion();
            try { unlinkSync(metadataPath); budget.finishDeletion(); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          syncOperationsDirectory();
          state.metadataRemoved = true;
        }
        if (budget.remainingDeletions() < 1) return 'released';
        const latest = this.readSlot(slot, budget.accountRead);
        if (latest === undefined) {
          state.phase = 'slot-sync';
          syncOperationsDirectory();
          state.phase = 'finalize';
          forgetPendingTerminalTransition(this.root, id);
          return 'complete';
        }
        if (latest === null || latest.id !== id || !latest.deleting || latest.artifactIds.length !== 0) {
          throw new Error('Cleanup slot changed before final removal.');
        }
        budget.beginDeletion();
        unlinkSync(slotPath);
        budget.finishDeletion();
        state.slotUnlinkCommitted = true;
        state.phase = 'slot-sync';
        syncOperationsDirectory();
        state.slotUnlinkCommitted = false;
        state.phase = 'finalize';
        forgetPendingTerminalTransition(this.root, id);
        return 'complete';
      };
      const resume = (budget: CleanupRetryBudget): 'complete' | 'released' | 'pending' => {
        if (state.phase === 'release-only') {
          ownerFence.release(budget);
          state.ownerDisposed = true;
          forgetPendingTerminalTransition(this.root, id);
          return 'released';
        }
        if (state.phase === 'admission') {
          ownerFence.assertCurrent(budget.accountRead);
          const current = readOwnSlot(budget);
          if (initialSlot.deleting) {
            if (!current.deleting || !sameIds(current.artifactIds, initialSlot.artifactIds)) {
              throw new Error('Existing cleanup tombstone changed before its barrier.');
            }
            state.artifactIds = [...current.artifactIds];
            state.phase = 'tombstone';
          } else {
            if (current.deleting) throw new Error('Active slot became a tombstone before cleanup admission.');
            const metadata = readBoundedJson(metadataPath, budget.maxMetadataBytes, budget.accountRead);
            if (!validOperationMetadata(metadata, id, slot) || metadata.ownerNonce !== metadataOwnerNonce) {
              throw new Error('Cleanup operation metadata changed before tombstone publication.');
            }
            if (metadata.state === 'closed' && (!isCanonicalTimestamp(metadata.retainedUntil) ||
                Date.parse(metadata.retainedUntil) > this.now().getTime())) {
              state.phase = 'release-only';
              return resume(budget);
            }
            const ids = new Set<string>();
            if (Array.isArray(metadata.activeCaptureIds)) {
              for (const value of metadata.activeCaptureIds) if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)) ids.add(value);
            }
            if (Array.isArray(metadata.artifacts)) {
              for (const value of metadata.artifacts) {
                if (typeof value !== 'object' || value === null) continue;
                const artifact = value as Record<string, unknown>;
                if (typeof artifact.id === 'string' && /^[0-9a-f-]{36}$/.test(artifact.id)) ids.add(artifact.id);
              }
            }
            if (Array.isArray(metadata.captures)) {
              for (const value of metadata.captures) {
                if (typeof value !== 'object' || value === null) continue;
                const artifact = (value as Record<string, unknown>).artifact;
                if (typeof artifact !== 'object' || artifact === null) continue;
                const ref = artifact as Record<string, unknown>;
                if (typeof ref.id === 'string' && /^[0-9a-f-]{36}$/.test(ref.id)) ids.add(ref.id);
              }
            }
            state.artifactIds = [...ids];
            state.pendingSlotWrite = { fromDeleting: false, fromIds: [], toIds: state.artifactIds };
            state.phase = 'tombstone';
          }
        }
        if (state.phase === 'tombstone') {
          ownerFence.assertCurrent(budget.accountRead);
          if (state.pendingSlotWrite !== undefined) publishTombstone(budget);
          else if (!state.tombstoneDurable) {
            const current = readOwnSlot(budget);
            if (!current.deleting || !sameIds(current.artifactIds, state.artifactIds)) {
              throw new Error('Existing cleanup tombstone does not match its frozen artifact IDs.');
            }
            syncOperationsDirectory();
            state.tombstoneDurable = true;
          }
          if (!state.tombstoneDurable) throw new Error('Cleanup tombstone is not durable.');
          const available = budget.remainingDeletions();
          const canFinishThisPass = available >= (state.artifactIds.length * 2) + 3;
          const boundedBatchCount = Math.floor(Math.max(0, available - 1) / 2);
          const batchCount = canFinishThisPass
            ? state.artifactIds.length
            : Math.min(Math.max(0, state.artifactIds.length - 1), boundedBatchCount);
          if (state.artifactIds.length > 0 && batchCount > 0) {
            const deletingIds = state.artifactIds.slice(0, batchCount);
            const remainingIds = state.artifactIds.slice(batchCount);
            const files = deletingIds.flatMap((artifactId) => [this.file(artifactId, 'stdout'), this.file(artifactId, 'stderr')]);
            for (const filePath of files) {
              try {
                const stats = lstatSync(filePath);
                if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Cleanup artifact is not a regular owned file.');
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
            for (const filePath of files) {
              budget.beginDeletion();
              try { unlinkSync(filePath); budget.finishDeletion(); }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            fsyncArtifactRoot(this.root, this.testFaults, 'cleanup');
            state.pendingSlotWrite = { fromDeleting: true, fromIds: state.artifactIds, toIds: remainingIds };
            publishTombstone(budget);
          }
          state.phase = 'owner-release';
        }
        if (state.phase === 'owner-release') {
          const requiredAfterRelease = state.artifactIds.length === 0 ? 2 : 0;
          if (budget.remainingDeletions() < requiredAfterRelease + 1) return 'pending';
          if (!state.ownerDisposed) {
            ownerFence.release(budget);
            state.ownerDisposed = true;
          }
          // A non-empty durable tombstone is the recovery record for the next
          // bounded pass. Reacquire its owner then, rather than retaining a
          // released handle that cannot safely mutate the remaining IDs.
          if (state.artifactIds.length > 0) {
            forgetPendingTerminalTransition(this.root, id);
            return 'released';
          }
          state.phase = 'finalize';
        }
        if (state.phase === 'finalize') {
          if (!state.ownerDisposed) throw new Error('Cleanup finalization cannot precede owner disposal.');
          return finalizeReleasedCleanup(budget);
        }
        if (state.phase === 'slot-sync') return finalizeReleasedCleanup(budget);
        return 'pending';
      };
      return { kind: 'cleanup', id, slot, retry: resume };
    };
    try {
      const index = this.readSlotIndex(true, accountMetadataRead);
      cursor = index.cursor;
      const toProbe = Math.min(maxSlotProbes, this.capacity);
      for (let step = 0; step < toProbe; step += 1) {
        const slot = (index.cursor + step) % this.capacity;
        probed += 1;
        const slotPath = this.slotPath(slot);
        const slotRecord = this.readSlot(slot, accountMetadataRead);
        const rootTransitions = pendingTerminalTransitions.get(this.root);
        const pendingBySlot = rootTransitions === undefined ? undefined : [...rootTransitions.values()].find((entry) => entry.slot === slot);
        if (pendingBySlot !== undefined && (slotRecord === undefined || slotRecord === null || slotRecord.id !== pendingBySlot.id)) {
          try {
            const retry = retryBudget();
            const result = pendingBySlot.kind === 'terminal'
              ? (pendingBySlot.retry(retry.accountRead, retry.beginDeletion, retry.finishDeletion), 'pending' as const)
              : pendingBySlot.retry(retry);
            if (result !== 'complete') protectedCount += 1;
          } catch (error) {
            if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
            protectedCount += 1;
          }
          continue;
        }
        if (slotRecord === undefined) continue;
        if (slotRecord === null) { protectedCount += 1; continue; }
        const pendingTransition = pendingTerminalTransitions.get(this.root)?.get(slotRecord.id);
        if (pendingTransition !== undefined) {
          if (pendingTransition.slot !== slot) { protectedCount += 1; continue; }
          if (pendingTransition.kind === 'cleanup') {
            try {
              const result = pendingTransition.retry(retryBudget());
              if (result !== 'complete') protectedCount += 1;
            } catch (error) {
              if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
              protectedCount += 1;
            }
            continue;
          }
          if (pendingTransition.kind === 'release') {
            try {
              const result = pendingTransition.retry(retryBudget());
              if (result !== 'complete') protectedCount += 1;
            } catch (error) {
              if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
              protectedCount += 1;
            }
            continue;
          }
          const retry = retryBudget();
          try {
            pendingTransition.retry(retry.accountRead, retry.beginDeletion, retry.finishDeletion);
          } catch (error) {
            if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
            protectedCount += 1;
            continue;
          }
          // Completing a terminal owner disposal may consume this caller's
          // final unlink attempt. Do not reacquire and pin a cleanup owner for
          // the same slot when this pass has no deletion budget left.
          if (retry.remainingDeletions() < 1) continue;
        }
        const metadataPath = path.join(this.operationsDir, slotRecord.id + '.json');
        let metadata: Record<string, unknown> = {};
        if (!slotRecord.deleting) {
          try {
            metadata = readBoundedJson(metadataPath, maxMetadataBytes, accountMetadataRead);
            if (!validOperationMetadata(metadata, slotRecord.id, slot)) {
              protectedCount += 1; continue;
            }
            if (metadata.state === 'closed' && (!isCanonicalTimestamp(metadata.retainedUntil) || Date.parse(metadata.retainedUntil) > this.now().getTime())) {
              protectedCount += 1; continue;
            }
            if (metadata.state === 'released' && !isCanonicalTimestamp(metadata.releasedAt)) {
              protectedCount += 1; continue;
            }
          } catch { protectedCount += 1; continue; }
        }
        const expectedOwnerNonce = typeof metadata.ownerNonce === 'string' ? metadata.ownerNonce : undefined;
        if (!slotRecord.deleting && (expectedOwnerNonce === undefined || expectedOwnerNonce === '' || expectedOwnerNonce.length > 256)) {
          protectedCount += 1; continue;
        }

        // Acquiring a stale/absent owner can read it once during takeover and
        // again while pinning. Reserve the fixed maximum for preflight,
        // takeover revalidation, and pin reads, plus one owner-disposal
        // attempt, before acquisition can create a new lock path.
        const retry = retryBudget();
        const ownerReadReservation = 3 * 4096;
        if (retry.remainingDeletions() < 1 || !retry.canRead(ownerReadReservation)) {
          protectedCount += 1; continue;
        }

        const lockPath = path.join(this.operationsDir, slotRecord.id + '.lock');
        let admittedLock: { readonly record: EvidenceOperationLockRecord | undefined };
        try {
          admittedLock = { record: readEvidenceOperationLock(lockPath, accountMetadataRead) };
          if (admittedLock.record === undefined && metadata.state === 'active') { protectedCount += 1; continue; }
          if (!slotRecord.deleting && admittedLock.record !== undefined && admittedLock.record.nonce !== expectedOwnerNonce) {
            protectedCount += 1; continue;
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
          protectedCount += 1; continue;
        }
        const admissionBudget = retryBudget();
        const staleTakeoverReserve = admittedLock.record === undefined ? 0 : 1;
        if (admissionBudget.remainingDeletions() < staleTakeoverReserve + 1) {
          protectedCount += 1; continue;
        }
        let admittedFence: AcquiredEvidenceOperationFence;
        try {
          admittedFence = acquireEvidenceOperationFence(
            lockPath, slotRecord.deleting ? undefined : expectedOwnerNonce, this.testFaults, accountMetadataRead, admittedLock,
            () => admissionBudget.beginDeletion(),
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
          protectedCount += 1; continue;
        }
        let ownerFence: PinnedEvidenceOperationFence;
        try {
          ownerFence = pinEvidenceOperationFence(lockPath, admittedFence.ownerNonce, this.testFaults, accountMetadataRead);
        } catch (error) {
          try {
            const disposal = retryBudget();
            disposal.beginDeletion();
            admittedFence.release();
            disposal.finishDeletion();
          } catch { /* preserve the original pin failure and the durable slot */ }
          if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
          protectedCount += 1; continue;
        }
        const pendingCleanup = cleanupTransition(slotRecord.id, slot, slotRecord, expectedOwnerNonce, ownerFence);
        try { registerPendingTerminalTransition(this.root, this.capacity, pendingCleanup); }
        catch (error) {
          try {
            const disposal = retryBudget();
            disposal.beginDeletion();
            ownerFence.release(disposal);
            disposal.finishDeletion();
          } catch { /* retain the durable slot for strict fresh-process recovery */ }
          protectedCount += 1; continue;
        }
        try {
          const result = pendingCleanup.retry(retryBudget());
          if (result !== 'complete') protectedCount += 1;
        } catch (error) {
          if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
          protectedCount += 1;
        }
      }
      const next = (index.cursor + probed) % this.capacity;
      this.writeSlotIndex({ schemaVersion: 1, capacity: this.capacity, cursor: next });
      cursor = next;
    } finally { maintenance.release(); }
    return { probed, deleted, attempted, protected: protectedCount, cursor };
  }

  private file(id: string, channel: 'stdout' | 'stderr'): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid tool-output artifact id.');
    return path.join(this.root, `${id}.${channel}`);
  }

  private slotPath(slot: number): string {
    return path.join(this.operationsDir, `slot-${String(slot).padStart(4, '0')}.json`);
  }

  private readSlotIndex(create: boolean, accountRead?: (bytes: number) => void): { readonly schemaVersion: 1; readonly capacity: number; readonly cursor: number } {
    const indexPath = path.join(this.operationsDir, 'index.json');
    try {
      const index = readBoundedJson(indexPath, 4096, accountRead);
      if (index.schemaVersion !== 1 || index.capacity !== this.capacity || !Number.isSafeInteger(index.cursor) ||
          (index.cursor as number) < 0 || (index.cursor as number) >= this.capacity) throw new Error('incompatible tool-output slot index');
      return index as { readonly schemaVersion: 1; readonly capacity: number; readonly cursor: number };
    } catch (error) {
      if (error instanceof Error && error.message.includes('metadata-read budget exhausted')) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw new Error('Tool-output operation index is unavailable or incompatible.');
      this.writeSlotIndex({ schemaVersion: 1, capacity: this.capacity, cursor: 0 });
      return { schemaVersion: 1, capacity: this.capacity, cursor: 0 };
    }
  }

  private writeSlotIndex(index: { readonly schemaVersion: 1; readonly capacity: number; readonly cursor: number }): void {
    writeAtomicJson(this.operationsDir, path.join(this.operationsDir, 'index.json'), index);
  }

  private readSlot(slot: number, accountRead?: (bytes: number) => void): { readonly id: string; readonly deleting: boolean; readonly artifactIds: readonly string[] } | null | undefined {
    try {
      const value = readBoundedJson(this.slotPath(slot), 1_048_576, accountRead);
      if (value.schemaVersion !== 1 || value.capacity !== this.capacity || value.slot !== slot ||
          typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/.test(value.id)) return null;
      if (value.deleting === true) {
        if (!Array.isArray(value.artifactIds) || !value.artifactIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))) return null;
        return { id: value.id, deleting: true, artifactIds: value.artifactIds as string[] };
      }
      if (value.deleting !== undefined || value.artifactIds !== undefined) return null;
      return { id: value.id, deleting: false, artifactIds: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return null;
    }
  }

  private registerOperation(id: string, operations: string): number {
    const maintenance = acquireDispatchInvocationLock({ lockPath: path.join(operations, 'maintenance.lock') });
    try {
      const index = this.readSlotIndex(true);
      const probes = Math.min(this.maxRegistrationProbes, this.capacity);
      for (let step = 0; step < probes; step += 1) {
        const slot = (index.cursor + step) % this.capacity;
        const pendingAtSlot = pendingTerminalTransitions.get(this.root);
        if (pendingAtSlot !== undefined && [...pendingAtSlot.values()].some((entry) => entry.slot === slot)) continue;
        if (this.readSlot(slot) !== undefined) continue;
        writeAtomicJson(operations, this.slotPath(slot), { schemaVersion: 1, capacity: this.capacity, slot, id });
        this.writeSlotIndex({ schemaVersion: 1, capacity: this.capacity, cursor: (slot + 1) % this.capacity });
        return slot;
      }
      this.writeSlotIndex({ schemaVersion: 1, capacity: this.capacity, cursor: (index.cursor + probes) % this.capacity });
      throw new Error(probes < this.capacity
        ? 'Tool-output operation registration probe budget was exhausted; no retained capture was evicted.'
        : 'Tool-output operation capacity is full; no retained capture was evicted.');
    } finally { maintenance.release(); }
  }

  private assertAvailable(referenceValue: ToolOutputArtifactReference): ToolOutputArtifactFileIdentity {
    if (referenceValue.operationId === undefined || referenceValue.retainedUntil === undefined) {
      throw new Error(`Tool-output artifact ${referenceValue.id} has no committed retention authority.`);
    }
    const until = Date.parse(referenceValue.retainedUntil);
    if (!Number.isFinite(until) || this.now().getTime() >= until) throw new Error(`Tool-output artifact ${referenceValue.id} is expired.`);
    if (!isToolOutputArtifactFileIdentity(referenceValue.fileIdentity)) throw new Error(`Tool-output artifact ${referenceValue.id} has no file identity.`);
    const fileIdentity = referenceValue.fileIdentity;
    if (!/^[0-9a-f-]{36}$/.test(referenceValue.operationId)) throw new Error('Invalid tool-output operation id.');
    const metadataPath = path.join(this.root, 'operations', `${referenceValue.operationId}.json`);
    try {
      const stats = lstatSync(metadataPath);
      if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 1_048_576) throw new Error('invalid operation metadata path');
      const descriptor = openSync(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let value: Record<string, unknown>;
      try {
        const actual = fstatSync(descriptor);
        if (!actual.isFile() || actual.size > 1_048_576) throw new Error('invalid operation metadata');
        const data = Buffer.alloc(actual.size);
        let offset = 0;
        while (offset < data.length) {
          const count = readSync(descriptor, data, offset, data.length - offset, offset);
          if (count === 0) throw new Error('short operation metadata');
          offset += count;
        }
        value = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      } finally { closeSync(descriptor); }
      const persisted = Array.isArray(value.artifacts) ? value.artifacts.find((item) =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).id === referenceValue.id) as Record<string, unknown> | undefined : undefined;
      if (value.state !== 'closed' || value.id !== referenceValue.operationId || value.retainedUntil !== referenceValue.retainedUntil ||
          persisted === undefined || persisted.kind !== referenceValue.kind || persisted.id !== referenceValue.id ||
          persisted.operationId !== referenceValue.operationId || persisted.retainedUntil !== referenceValue.retainedUntil ||
          persisted.stdoutBytes !== referenceValue.stdoutBytes || persisted.stderrBytes !== referenceValue.stderrBytes ||
          persisted.totalBytes !== referenceValue.totalBytes || persisted.sha256 !== referenceValue.sha256 ||
          !sameToolOutputArtifactFileIdentity(persisted.fileIdentity, fileIdentity)) {
        throw new Error('operation retention metadata is unavailable');
      }
      for (const channel of ['stdout', 'stderr'] as const) {
        const fileStats = lstatSync(this.file(referenceValue.id, channel), { bigint: true });
        if (fileStats.isSymbolicLink() || !fileStats.isFile() ||
            fileStats.dev.toString() !== fileIdentity[channel].dev || fileStats.ino.toString() !== fileIdentity[channel].ino) throw new Error('invalid artifact file identity');
        const expected = channel === 'stdout' ? referenceValue.stdoutBytes : referenceValue.stderrBytes;
        if (fileStats.size !== BigInt(expected)) throw new Error('artifact byte length differs from committed metadata');
      }
    } catch { throw new Error(`Tool-output artifact ${referenceValue.id} is unavailable or expired.`); }
    return fileIdentity;
  }
}

function readBoundedJson(filePath: string, maxBytes: number, accountRead?: (bytes: number) => void): Record<string, unknown> {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > maxBytes) throw new Error('Invalid bounded metadata file.');
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(descriptor);
    if (!actual.isFile() || actual.size > maxBytes) throw new Error('Invalid bounded metadata file.');
    accountRead?.(actual.size);
    const data = Buffer.alloc(actual.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(descriptor, data, offset, data.length - offset, offset);
      if (count === 0) throw new Error('Short metadata read.');
      offset += count;
    }
    const value: unknown = JSON.parse(data.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid metadata object.');
    return value as Record<string, unknown>;
  } finally { closeSync(descriptor); }
}

function writeAtomicJson(directory: string, filePath: string, value: unknown, beforeDirectoryFsync?: () => void): void {
  const encoded = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoded.length > 1_048_576) throw new Error('Tool-output metadata exceeds the bounded metadata limit.');
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFully(descriptor, encoded);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, filePath);
    beforeDirectoryFsync?.();
    const dir = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* preserve initial failure */ } }
    try { unlinkSync(temporary); } catch { /* preserve initial failure */ }
    throw error;
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
  private readonly highSignalPattern = /\b(error|failed|failure|fatal|exception|assert|panic|timeout|timed[ -]?out|denied|invalid|cannot|could not|fail|not ok\s+\d+)\b|✖/i;

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
      if (this.policy.maxDiagnostics > 1) this.highSignal.splice(1, 1);
      else this.highSignal.pop();
      this.dropped = true;
    }
  }
}

/** Bounded observation independent of the durable sink; sink faults never stop pipe draining. */
export class ContainedToolOutputCaptureSession {
  private readonly stdout: StreamCapture;
  private readonly stderr: StreamCapture;
  private readonly stdoutDiagnostics: DiagnosticCapture;
  private readonly stderrDiagnostics: DiagnosticCapture;
  private failed = false;

  constructor(private readonly policy: ToolOutputPolicy) {
    this.stdout = new StreamCapture(policy.previewBytes);
    this.stderr = new StreamCapture(policy.previewBytes);
    this.stdoutDiagnostics = new DiagnosticCapture(policy);
    this.stderrDiagnostics = new DiagnosticCapture(policy);
  }

  write(writer: ToolOutputCaptureWriter | undefined, channel: 'stdout' | 'stderr', chunk: string): void {
    if (channel === 'stdout') { this.stdout.append(chunk); this.stdoutDiagnostics.append(chunk); }
    else { this.stderr.append(chunk); this.stderrDiagnostics.append(chunk); }
    if (writer === undefined || this.failed) return;
    try { writer.write(channel, chunk); }
    catch {
      this.failed = true;
      try { writer.abort?.(); } catch { /* disposal faults cannot stop stream draining */ }
    }
  }

  finish(writer: ToolOutputCaptureWriter | undefined): ToolOutputCaptureSessionResult {
    const stdout = this.stdout.value();
    const stderr = this.stderr.value();
    const stdoutDiagnostics = this.stdoutDiagnostics.finish();
    const stderrDiagnostics = this.stderrDiagnostics.finish();
    const diagnostics = boundedDiagnostics([...stdoutDiagnostics.lines, ...stderrDiagnostics.lines].join('\n'), '', this.policy);
    const diagnosticsTruncated = stdoutDiagnostics.truncated || stderrDiagnostics.truncated || diagnostics.truncated;
    if (writer === undefined) return { status: 'unavailable', stdout, stderr, diagnostics: diagnostics.lines, diagnosticsTruncated };
    if (this.failed) return { status: 'partial', stdout, stderr, diagnostics: diagnostics.lines, diagnosticsTruncated };
    try {
      const capture = writer.finish();
      return { status: 'complete', stdout: capture.stdout, stderr: capture.stderr, diagnostics: capture.diagnostics,
        diagnosticsTruncated: capture.diagnosticsTruncated, capture };
    } catch {
      try { writer.abort?.(); } catch { /* disposal faults remain contained */ }
      return { status: 'partial', stdout, stderr, diagnostics: diagnostics.lines, diagnosticsTruncated };
    }
  }
}

class BufferedToolOutputWriter implements ToolOutputCaptureWriter {
  private stdout = '';
  private stderr = '';
  private state: 'open' | 'finished' | 'failed' | 'aborted' = 'open';

  constructor(private readonly store: ToolOutputStore, private readonly policy: ToolOutputPolicy) {}

  write(channel: 'stdout' | 'stderr', chunk: string): void {
    if (this.state !== 'open') throw new Error('Tool-output capture is no longer writable.');
    if (channel === 'stdout') this.stdout += chunk;
    else this.stderr += chunk;
  }

  finish(): ToolOutputCaptureSummary {
    if (this.state !== 'open') throw new Error('Tool-output capture can only finish once.');
    let artifact: ToolOutputArtifactReference;
    try { artifact = this.store.save({ stdout: this.stdout, stderr: this.stderr }); }
    catch (error) { this.state = 'failed'; throw error; }
    const diagnostics = boundedDiagnostics(this.stdout, this.stderr, this.policy);
    this.state = 'finished';
    return {
      artifact,
      stdout: stream(this.stdout, this.policy.previewBytes),
      stderr: stream(this.stderr, this.policy.previewBytes),
      diagnostics: diagnostics.lines,
      diagnosticsTruncated: diagnostics.truncated,
    };
  }

  abort(): void {
    if (this.state === 'finished' || this.state === 'aborted') return;
    this.stdout = '';
    this.stderr = '';
    this.state = 'aborted';
  }
}

class FileToolOutputWriter implements ToolOutputCaptureWriter {
  private stdoutHandle: number | undefined;
  private stderrHandle: number | undefined;
  private readonly stdoutCapture: StreamCapture;
  private readonly stderrCapture: StreamCapture;
  private readonly stdoutDiagnostics: DiagnosticCapture;
  private readonly stderrDiagnostics: DiagnosticCapture;
  private finished = false;
  private fileIdentity: ToolOutputArtifactFileIdentity | undefined;

  constructor(
    private readonly root: string,
    private readonly policy: ToolOutputPolicy,
    private readonly id = randomUUID(),
    private readonly testFaults?: ToolOutputFileTestFaults,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    try {
      this.stdoutHandle = openSync(path.join(root, `${this.id}.stdout`), 'wx', 0o600);
      testFaults?.beforeSecondOpen?.();
      this.stderrHandle = openSync(path.join(root, `${this.id}.stderr`), 'wx', 0o600);
    } catch (error) {
      if (this.stdoutHandle !== undefined) { try { closeSync(this.stdoutHandle); } catch { /* preserve primary constructor failure */ } }
      const stdoutPath = path.join(root, `${this.id}.stdout`);
      try { testFaults?.beforeUnlink?.(stdoutPath); unlinkSync(stdoutPath); } catch { /* preserve primary constructor failure and registered capture ID */ }
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
    if (handle === undefined) throw new Error('Tool-output capture descriptor is unavailable.');
    writeFully(handle, bytes, this.testFaults?.writeSync);
    if (channel === 'stdout') {
      this.stdoutCapture.append(chunk);
      this.stdoutDiagnostics.append(chunk);
    } else {
      this.stderrCapture.append(chunk);
      this.stderrDiagnostics.append(chunk);
    }
  }

  finish(): ToolOutputCaptureSummary {
    const stdout = this.stdoutCapture.value();
    const stderr = this.stderrCapture.value();
    const stdoutBytes = stdout.bytes;
    const stderrBytes = stderr.bytes;
    if (!this.finished) {
      this.testFaults?.beforeFinish?.();
      let failure: unknown;
      for (const [channel, handle] of [['stdout', this.stdoutHandle], ['stderr', this.stderrHandle]] as const) {
        if (handle !== undefined) { try { this.testFaults?.beforeFsync?.(channel); fsyncSync(handle); } catch (error) { if (failure === undefined) failure = error; } }
      }
      if (failure === undefined && this.stdoutHandle !== undefined && this.stderrHandle !== undefined) {
        try {
          this.fileIdentity = {
            stdout: ownedArtifactIdentity(this.stdoutHandle, stdoutBytes),
            stderr: ownedArtifactIdentity(this.stderrHandle, stderrBytes),
          };
        } catch (error) { failure = error; }
      }
      for (const handle of [this.stdoutHandle, this.stderrHandle]) {
        if (handle !== undefined) { try { closeSync(handle); } catch (error) { if (failure === undefined) failure = error; } }
      }
      this.finished = true;
      this.stdoutHandle = undefined;
      this.stderrHandle = undefined;
      if (failure !== undefined) throw failure;
    }
    if (this.fileIdentity === undefined) throw new Error('Tool-output capture identity was not recorded from its open descriptors.');
    this.testFaults?.beforeHash?.();
    const hash = hashFiles(
      path.join(this.root, `${this.id}.stdout`),
      stdoutBytes,
      path.join(this.root, `${this.id}.stderr`),
      stderrBytes,
      this.fileIdentity,
      this.testFaults,
    );
    const artifact: ToolOutputArtifactReference = {
      kind: 'tool-output', id: this.id, stdoutBytes, stderrBytes, totalBytes: stdoutBytes + stderrBytes, sha256: hash,
      fileIdentity: this.fileIdentity,
    };
    const stdoutDiagnostics = this.stdoutDiagnostics.finish();
    const stderrDiagnostics = this.stderrDiagnostics.finish();
    const diagnostics = boundedDiagnostics(
      [...stdoutDiagnostics.lines, ...stderrDiagnostics.lines].join('\n'), '', this.policy,
    );
    fsyncArtifactRoot(this.root, this.testFaults, 'finish');
    return {
      artifact,
      stdout,
      stderr,
      diagnostics: diagnostics.lines,
      diagnosticsTruncated: stdoutDiagnostics.truncated || stderrDiagnostics.truncated || diagnostics.truncated,
    };
  }

  abort(): void {
    if (!this.finished) {
      this.finished = true;
      for (const handle of [this.stdoutHandle, this.stderrHandle]) {
        if (handle !== undefined) { try { closeSync(handle); } catch { /* disposal is best effort */ } }
      }
    }
    this.stdoutHandle = undefined;
    this.stderrHandle = undefined;
    let failure: unknown;
    for (const channel of ['stdout', 'stderr'] as const) {
      const filePath = path.join(this.root, `${this.id}.${channel}`);
      try { this.testFaults?.beforeUnlink?.(filePath); unlinkSync(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
    fsyncArtifactRoot(this.root, this.testFaults, 'abort');
  }
}

function fsyncArtifactRoot(
  root: string,
  testFaults: ToolOutputFileTestFaults | undefined,
  phase: 'abort' | 'finish' | 'cleanup',
): void {
  testFaults?.beforeArtifactRootFsync?.(phase);
  const descriptor = openSync(root, constants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function writeFully(handle: number, bytes: Buffer, writer: ToolOutputFileTestFaults['writeSync'] = writeSync): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(handle, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Tool-output capture write was incomplete.');
    offset += written;
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

function ownedArtifactIdentity(descriptor: number, expectedBytes: number): ToolOutputArtifactFileIdentity['stdout'] {
  const stats = fstatSync(descriptor, { bigint: true });
  if (!stats.isFile() || stats.size !== BigInt(expectedBytes)) {
    throw new Error('Owned tool-output capture descriptor differs from its streamed byte count.');
  }
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

function assertArtifactDescriptor(
  descriptor: number,
  expectedBytes: number,
  identity: ToolOutputArtifactFileIdentity['stdout'],
): void {
  const stats = fstatSync(descriptor, { bigint: true });
  if (!stats.isFile() || stats.size !== BigInt(expectedBytes) ||
      stats.dev.toString() !== identity.dev || stats.ino.toString() !== identity.ino) {
    throw new Error('Tool-output artifact descriptor differs from its admitted identity or size.');
  }
}

function openVerifiedArtifact(
  filePath: string,
  expectedBytes: number,
  identity: ToolOutputArtifactFileIdentity['stdout'],
  faults: ToolOutputFileTestFaults | undefined,
  kind: 'hash' | 'read' | 'search',
  channel: 'stdout' | 'stderr',
): number {
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) {
    throw new Error('Safe artifact opens are unavailable because O_NOFOLLOW is unsupported.');
  }
  faults?.beforeArtifactOpen?.(kind, channel);
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0);
  const descriptor = openSync(filePath, flags);
  try {
    faults?.afterArtifactOpen?.(descriptor, kind, channel);
    assertArtifactDescriptor(descriptor, expectedBytes, identity);
    return descriptor;
  } catch (error) {
    try { closeSync(descriptor); } catch { /* preserve point-of-use validation failure */ }
    throw error;
  }
}

function hashFiles(
  stdoutPath: string,
  stdoutBytes: number,
  stderrPath: string,
  stderrBytes: number,
  identity: ToolOutputArtifactFileIdentity,
  faults?: ToolOutputFileTestFaults,
): string {
  const hash = createHash('sha256');
  hashFile(stdoutPath, stdoutBytes, identity.stdout, hash, faults, 'stdout');
  hash.update('\0', 'utf8');
  hashFile(stderrPath, stderrBytes, identity.stderr, hash, faults, 'stderr');
  return hash.digest('hex');
}

function hashFile(
  filePath: string,
  expectedBytes: number,
  identity: ToolOutputArtifactFileIdentity['stdout'],
  hash: ReturnType<typeof createHash>,
  faults: ToolOutputFileTestFaults | undefined,
  channel: 'stdout' | 'stderr',
): void {
  const handle = openVerifiedArtifact(filePath, expectedBytes, identity, faults, 'hash', channel);
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let offset = 0;
    while (offset < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - offset);
      let chunkBytes = 0;
      while (chunkBytes < requested) {
        const count = readSync(handle, buffer, chunkBytes, requested - chunkBytes, offset + chunkBytes);
        if (count === 0) throw new Error('Tool-output hash read was shorter than committed size.');
        chunkBytes += count;
      }
      hash.update(buffer.subarray(0, chunkBytes));
      offset += chunkBytes;
    }
    assertArtifactDescriptor(handle, expectedBytes, identity);
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
  handle: number,
  expectedBytes: number,
  identity: ToolOutputArtifactFileIdentity['stdout'],
  channel: 'stdout' | 'stderr',
  query: string,
  maxMatches: number,
  maxBytes: number,
  existingMatches: number,
): readonly ToolOutputMatch[] {
  const results: ToolOutputMatch[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let state = emptySearchState();
  let offset = 0;
  while (offset < expectedBytes && results.length + existingMatches < maxMatches) {
    const requested = Math.min(buffer.length, expectedBytes - offset);
    let chunkBytes = 0;
    while (chunkBytes < requested) {
      const count = readSync(handle, buffer, chunkBytes, requested - chunkBytes, offset + chunkBytes);
      if (count === 0) throw new Error('Tool-output search read was shorter than committed size.');
      chunkBytes += count;
    }
    offset += chunkBytes;
    const chunks = [decoder.write(buffer.subarray(0, chunkBytes))];
    state = scanDecodedChunks(channel, query, maxMatches - existingMatches, maxBytes, results, chunks, state);
  }
  assertArtifactDescriptor(handle, expectedBytes, identity);
  const tail = decoder.end();
  if (results.length + existingMatches < maxMatches) {
    scanDecodedChunks(channel, query, maxMatches - existingMatches, maxBytes, results, [tail], state, true);
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
