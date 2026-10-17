import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, readlinkSync, readSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import { ensureDurableDirectory, type SyncDirectoryHierarchy } from '../durable-directory.js';
import { assertSafeCurrentAccountPathIfApplicable } from '../account-home.js';

export class DispatchInvocationLockedError extends Error {
  constructor(lockPath: string) {
    super(`A same-host dispatch invocation already owns ${lockPath}; leaving it undisturbed.`);
    this.name = 'DispatchInvocationLockedError';
  }
}

interface LegacyLockRecord {
  readonly nonce: string;
  readonly pid: number;
}

interface VersionedLockRecord extends LegacyLockRecord {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly bootId: string;
  readonly processStartId: string;
}

type LockRecord = LegacyLockRecord | VersionedLockRecord;
type TakeoverClaim = LockRecord;

export interface PreparedDispatchInvocationPublication {
  readonly owner: Readonly<VersionedLockRecord>;
  readonly temporaryPath: string;
  readonly generation: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
}

export interface DispatchInvocationPublicationHandoff {
  /** Retire the prepared descriptor only when this publication never linked. */
  discardUnpublished(): void;
  /** Admit and qualify the shared rollback unlink before it mutates the canonical path. */
  beforeRollbackUnlink(): void;
  /** Record the already successful rollback unlink without performing I/O. */
  afterRollbackUnlink(): void;
  /** Optional deterministic fault seam immediately before retiring the sibling alias. */
  beforeTemporaryUnlink?(): void;
}

export interface DispatchInvocationReadAllowance {
  /** Consume part of an already charged read reservation before allocation or I/O. */
  accountRead(bytes: number): void;
  /** Return unused reserved bytes when the corresponding irreversible step did not occur. */
  releaseUnused(): void;
}

export interface DispatchInvocationReadPolicy {
  readonly maxRecordBytes: number;
  /** Charge ordinary owner and claim reads before allocating or reading their contents. */
  readonly accountRead: (bytes: number) => void;
  /** Atomically charge a finite critical branch against the same aggregate pass ledger. */
  readonly reserveReadBytes: (bytes: number) => DispatchInvocationReadAllowance;
  /** Conservative per-symlink readlink precharge, qualified by the caller for this pass. */
  readonly symlinkReadBytes: number;
  /** Reserved allowance for releasing an acquired owner after body exhaustion. */
  readonly releaseRead?: DispatchInvocationReadAllowance;
}

export interface DispatchInvocationIdentity {
  readonly hostId: string;
  readonly bootId: string;
}

export interface DispatchInvocationLockOptions {
  readonly lockPath: string;
  readonly nonce?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Test seams for deterministic identity and stale-takeover interleavings. */
  readonly hostBootIdentity?: () => DispatchInvocationIdentity;
  readonly processStartIdentity?: (pid: number) => string | null;
  readonly beforeCanonicalLink?: () => void;
  readonly preparePublication?: (publication: PreparedDispatchInvocationPublication, accountRead?: (bytes: number) => void) => DispatchInvocationPublicationHandoff;
  /** Opt-in bounded read/accounting contract. Omitting it preserves legacy dispatch behavior. */
  readonly readPolicy?: DispatchInvocationReadPolicy;
  readonly syncDirectory?: (directory: string) => void;
  /** Separate path-aware barrier for every component leading to the lock directory. */
  readonly syncDirectoryHierarchy?: SyncDirectoryHierarchy;
  readonly beforeStaleTakeover?: () => void;
}

export interface DispatchInvocationLock {
  release(): void;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validLegacyRecord(value: Record<string, unknown>): value is Record<string, unknown> & LegacyLockRecord {
  return exactKeys(value, ['nonce', 'pid']) && typeof value.nonce === 'string' && value.nonce !== '' &&
    value.nonce.length <= 256 && Number.isSafeInteger(value.pid) && (value.pid as number) > 0;
}

function validVersionedRecord(value: Record<string, unknown>): value is Record<string, unknown> & VersionedLockRecord {
  return exactKeys(value, ['schemaVersion', 'nonce', 'pid', 'hostId', 'bootId', 'processStartId']) &&
    value.schemaVersion === 1 && typeof value.nonce === 'string' && value.nonce !== '' && value.nonce.length <= 256 &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 &&
    typeof value.hostId === 'string' && /^[0-9a-f]{64}$/.test(value.hostId) &&
    typeof value.bootId === 'string' && /^[0-9a-f]{64}$/.test(value.bootId) &&
    typeof value.processStartId === 'string' && value.processStartId.length > 0 && value.processStartId.length <= 256;
}

function parseLock(raw: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (validVersionedRecord(record)) {
      return {
        schemaVersion: 1, nonce: record.nonce, pid: record.pid,
        hostId: record.hostId, bootId: record.bootId, processStartId: record.processStartId,
      };
    }
    if (validLegacyRecord(record)) return { nonce: record.nonce, pid: record.pid };
    return null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code !== 'ESRCH';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000, maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return '';
  return result.stdout.trim();
}

function currentHostBootIdentity(): DispatchInvocationIdentity {
  let hostRaw: string;
  let bootRaw: string;
  if (process.platform === 'darwin') {
    const ioreg = commandOutput('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    hostRaw = ioreg.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? '';
    bootRaw = commandOutput('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  } else if (process.platform === 'linux') {
    try {
      hostRaw = readFileSync('/etc/machine-id', 'utf8').trim();
      bootRaw = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      hostRaw = '';
      bootRaw = '';
    }
  } else {
    throw new Error('Dispatch invocation lock requires a supported host identity source.');
  }
  if (!hostRaw || !bootRaw) throw new Error('Dispatch invocation lock could not establish host and boot identity.');
  return { hostId: sha256(hostRaw), bootId: sha256(bootRaw) };
}

function currentProcessStartIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const endOfCommand = stat.lastIndexOf(')');
      if (endOfCommand < 0) return null;
      const fieldsAfterCommand = stat.slice(endOfCommand + 1).trim().split(/\s+/);
      // Linux proc stat fields after comm start at field 3; starttime is field 22.
      const startTicks = fieldsAfterCommand[19];
      return startTicks ? `linux-start-ticks:${startTicks}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const started = commandOutput('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    return started ? `darwin-ps-start-utc:${started}` : null;
  }
  return null;
}

function sameLockRecord(left: LockRecord, right: LockRecord): boolean {
  if (left.nonce !== right.nonce || left.pid !== right.pid) return false;
  if (!('schemaVersion' in left) || !('schemaVersion' in right)) {
    return !('schemaVersion' in left) && !('schemaVersion' in right);
  }
  return left.schemaVersion === right.schemaVersion && left.hostId === right.hostId &&
    left.bootId === right.bootId && left.processStartId === right.processStartId;
}

function staleTakeoverPath(lockPath: string, record: LockRecord): string {
  const identity = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  return `${lockPath}.${identity}.stale-takeover`;
}

function staleTakeoverRecoveryPath(takeoverPath: string, previousClaim: TakeoverClaim): string {
  const identity = createHash('sha256').update(JSON.stringify(previousClaim)).digest('hex');
  return `${takeoverPath}.${identity}.recovery`;
}

function parseTakeoverClaim(raw: string): TakeoverClaim | null {
  return parseLock(raw);
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const stats = lstatSync(lockPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    return parseLock(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

interface BoundedLockRead {
  readonly record: LockRecord;
  readonly generation: Readonly<{ readonly dev: bigint; readonly ino: bigint }>;
}

function boundedRecordFromDescriptor(
  filePath: string,
  policy: DispatchInvocationReadPolicy,
  accountRead: (bytes: number) => void,
  expectedAlias?: Readonly<{ readonly dev: bigint; readonly ino: bigint }>,
): BoundedLockRead | null {
  let pathStats;
  try { pathStats = lstatSync(filePath, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size < 1n || pathStats.size > BigInt(policy.maxRecordBytes) ||
      (expectedAlias !== undefined && (pathStats.dev !== expectedAlias.dev || pathStats.ino !== expectedAlias.ino))) return null;
  if (typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0) throw new Error('Bounded dispatch lock reads require O_NOFOLLOW support.');
  const size = Number(pathStats.size);
  if (!Number.isSafeInteger(size) || size < 1) return null;
  accountRead(size);
  const descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== pathStats.dev || opened.ino !== pathStats.ino || opened.size !== pathStats.size) return null;
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, data, offset, size - offset, offset);
      if (count === 0) return null;
      offset += count;
    }
    const finalDescriptor = fstatSync(descriptor, { bigint: true });
    const finalPath = lstatSync(filePath, { bigint: true });
    if (finalDescriptor.dev !== opened.dev || finalDescriptor.ino !== opened.ino || finalDescriptor.size !== opened.size ||
        finalPath.isSymbolicLink() || !finalPath.isFile() || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size) return null;
    if (expectedAlias !== undefined) {
      const aliasPath = lstatSync(filePath, { bigint: true });
      if (aliasPath.dev !== expectedAlias.dev || aliasPath.ino !== expectedAlias.ino) return null;
    }
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { return null; }
    const record = parseLock(raw);
    if (record === null) return null;
    return { record, generation: { dev: opened.dev, ino: opened.ino } };
  } finally { closeSync(descriptor); }
}

function readLockBounded(
  lockPath: string,
  policy: DispatchInvocationReadPolicy,
  accountRead: (bytes: number) => void = policy.accountRead,
): BoundedLockRead | null {
  return boundedRecordFromDescriptor(lockPath, policy, accountRead);
}

function readSymlinkTakeoverClaimBounded(
  takeoverPath: string,
  policy: DispatchInvocationReadPolicy,
  accountRead: (bytes: number) => void,
): TakeoverClaim | null {
  let before;
  try { before = lstatSync(takeoverPath, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!before.isSymbolicLink() || before.size < 1n || before.size > BigInt(policy.maxRecordBytes) ||
      policy.symlinkReadBytes < policy.maxRecordBytes) return null;
  accountRead(policy.symlinkReadBytes);
  const raw = readlinkSync(takeoverPath, { encoding: 'buffer' });
  const after = lstatSync(takeoverPath, { bigint: true });
  if (!after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
      raw.byteLength !== Number(before.size) || raw.byteLength > policy.maxRecordBytes) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { return null; }
  return parseTakeoverClaim(text);
}

function readTakeoverClaimBounded(
  takeoverPath: string,
  lockPath: string,
  expectedLock: LockRecord,
  expectedLockGeneration: Readonly<{ readonly dev: bigint; readonly ino: bigint }>,
  policy: DispatchInvocationReadPolicy,
  accountRead: (bytes: number) => void,
): TakeoverClaim | null {
  let claimStats;
  try { claimStats = lstatSync(takeoverPath, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (claimStats.isSymbolicLink()) return readSymlinkTakeoverClaimBounded(takeoverPath, policy, accountRead);
  if (!claimStats.isFile() || claimStats.size > BigInt(policy.maxRecordBytes) ||
      claimStats.dev !== expectedLockGeneration.dev || claimStats.ino !== expectedLockGeneration.ino) return null;
  const lockStats = lstatSync(lockPath, { bigint: true });
  if (!lockStats.isFile() || lockStats.isSymbolicLink() || lockStats.dev !== expectedLockGeneration.dev ||
      lockStats.ino !== expectedLockGeneration.ino || lockStats.size !== claimStats.size) return null;
  const bounded = boundedRecordFromDescriptor(takeoverPath, policy, accountRead, expectedLockGeneration);
  const claimAfter = lstatSync(takeoverPath, { bigint: true });
  const lockAfter = lstatSync(lockPath, { bigint: true });
  if (bounded === null || claimAfter.isSymbolicLink() || !claimAfter.isFile() ||
      claimAfter.dev !== expectedLockGeneration.dev || claimAfter.ino !== expectedLockGeneration.ino ||
      lockAfter.isSymbolicLink() || !lockAfter.isFile() || lockAfter.dev !== expectedLockGeneration.dev ||
      lockAfter.ino !== expectedLockGeneration.ino || !sameLockRecord(bounded.record, expectedLock)) return null;
  return bounded.record;
}

function readSymlinkTakeoverClaim(takeoverPath: string): TakeoverClaim | null {
  try {
    return parseTakeoverClaim(readlinkSync(takeoverPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * PR #44's first implementation used a hard link to the stale lock as its
 * takeover claim. Recognize only that exact legacy shape: the claim must still
 * alias the exact stale lock record we observed. It remains immutable and a
 * successor symlink claim owns the recovery, so a concurrent wake cannot
 * unlink a replacement claim by pathname.
 */
function readLegacyHardLinkTakeoverClaim(
  takeoverPath: string,
  lockPath: string,
  expectedLock: LockRecord,
): TakeoverClaim | null {
  try {
    const claimStats = lstatSync(takeoverPath);
    const lockStats = lstatSync(lockPath);
    if (!claimStats.isFile() || claimStats.isSymbolicLink() ||
        !lockStats.isFile() || lockStats.isSymbolicLink() ||
        claimStats.dev !== lockStats.dev || claimStats.ino !== lockStats.ino) return null;
    const claim = parseTakeoverClaim(readFileSync(takeoverPath, 'utf8'));
    return claim !== null && sameLockRecord(claim, expectedLock) ? claim : null;
  } catch {
    return null;
  }
}

function readTakeoverClaim(takeoverPath: string, lockPath: string, expectedLock: LockRecord): TakeoverClaim | null {
  try {
    return parseTakeoverClaim(readlinkSync(takeoverPath, 'utf8'));
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'EINVAL') return null;
    return readLegacyHardLinkTakeoverClaim(takeoverPath, lockPath, expectedLock);
  }
}

function sameTakeoverClaim(left: TakeoverClaim, right: TakeoverClaim): boolean {
  return sameLockRecord(left, right);
}

function createTakeoverClaim(takeoverPath: string, claim: TakeoverClaim): boolean {
  try {
    // The symlink target is immutable ownership metadata created atomically
    // with the claim pathname. It is deliberately not followed or trusted as
    // a filesystem location.
    symlinkSync(JSON.stringify(claim), takeoverPath);
    return true;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') return false;
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

function definitelyStale(
  record: LockRecord,
  alive: (pid: number) => boolean,
  identity: () => DispatchInvocationIdentity,
  processStart: (pid: number) => string | null,
): boolean {
  if (!('schemaVersion' in record)) return !alive(record.pid);
  try {
    const current = identity();
    if (record.hostId !== current.hostId) return false;
    if (record.bootId !== current.bootId) return true;
    const currentStart = processStart(record.pid);
    if (currentStart !== null && currentStart !== record.processStartId &&
        compatibleProcessStartSchemes(record.processStartId, currentStart)) return true;
    return !alive(record.pid);
  } catch {
    return false;
  }
}

function compatibleProcessStartSchemes(recorded: string, current: string): boolean {
  const trustedSchemes = ['linux-start-ticks:', 'darwin-ps-start-utc:'];
  const recordedScheme = trustedSchemes.find((scheme) => recorded.startsWith(scheme));
  const currentScheme = trustedSchemes.find((scheme) => current.startsWith(scheme));
  return recordedScheme !== undefined && recordedScheme === currentScheme;
}

/** Acquire the small same-host fence that complements the GitHub claim lease. */
export function acquireDispatchInvocationLock(options: DispatchInvocationLockOptions): DispatchInvocationLock {
  if (!path.isAbsolute(options.lockPath)) throw new Error('TACHIKO_DISPATCH_LOCK_PATH must be an absolute path.');
  const readPolicy = options.readPolicy;
  if (readPolicy !== undefined && (!Number.isSafeInteger(readPolicy.maxRecordBytes) || readPolicy.maxRecordBytes < 1 ||
      readPolicy.maxRecordBytes > 4096 || !Number.isSafeInteger(readPolicy.symlinkReadBytes) ||
      readPolicy.symlinkReadBytes < readPolicy.maxRecordBytes)) {
    throw new Error('Dispatch invocation bounded-read policy is invalid.');
  }
  const validatePath = () => assertSafeCurrentAccountPathIfApplicable(options.lockPath, 'file');
  validatePath();
  const makeNonce = options.nonce ?? randomUUID;
  const alive = options.isProcessAlive ?? processAlive;
  const identity = options.hostBootIdentity ?? currentHostBootIdentity;
  const processStart = options.processStartIdentity ?? currentProcessStartIdentity;
  const nonce = makeNonce();
  const hostBoot = identity();
  const ownProcessStart = processStart(process.pid);
  if (!nonce || nonce.length > 256 ||
      !/^[0-9a-f]{64}$/.test(hostBoot.hostId) || !/^[0-9a-f]{64}$/.test(hostBoot.bootId) ||
      !ownProcessStart || ownProcessStart.length > 256) {
    throw new Error('Dispatch invocation lock could not establish a valid owner incarnation.');
  }
  const owner: VersionedLockRecord = {
    schemaVersion: 1, nonce, pid: process.pid,
    hostId: hostBoot.hostId, bootId: hostBoot.bootId, processStartId: ownProcessStart,
  };

  const fsyncParent = () => (options.syncDirectory ?? fsyncDirectory)(path.dirname(options.lockPath));
  const ordinaryRead = readPolicy?.accountRead;
  const publish = (accountRead?: (bytes: number) => void): boolean => {
    const directory = path.dirname(options.lockPath);
    ensureDurableDirectory(directory, { mode: 0o700, syncDirectoryHierarchy: options.syncDirectoryHierarchy });
    validatePath();
    const tempPath = `${options.lockPath}.tmp-${randomBytes(16).toString('hex')}`;
    let descriptor: number | undefined;
    let linked = false;
    let published = false;
    let exists = false;
    let handoff: DispatchInvocationPublicationHandoff | undefined;
    let discardConsumed = false;
    let failure: unknown;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      const data = Buffer.from(JSON.stringify(owner), 'utf8');
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(descriptor, data, offset, data.length - offset, null);
        if (written <= 0) throw new Error('Dispatch invocation lock owner record write was incomplete.');
        offset += written;
      }
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
      if (options.preparePublication !== undefined) {
        const stats = fstatSync(descriptor, { bigint: true });
        if (!stats.isFile() || stats.size !== BigInt(data.byteLength) || stats.size < 1n || stats.size > 4096n) {
          throw new Error('Dispatch invocation lock prepared owner is not the expected bounded regular file.');
        }
        const publication: PreparedDispatchInvocationPublication = Object.freeze({
          owner: Object.freeze({ ...owner }),
          temporaryPath: tempPath,
          generation: Object.freeze({ dev: stats.dev, ino: stats.ino }),
        });
        const closing = descriptor;
        descriptor = undefined;
        closeSync(closing);
        handoff = options.preparePublication(publication, accountRead ?? ordinaryRead);
      } else {
        const closing = descriptor;
        descriptor = undefined;
        closeSync(closing);
      }
      options.beforeCanonicalLink?.();
      validatePath();
      try {
        linkSync(tempPath, options.lockPath);
        linked = true;
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') exists = true;
        else throw error;
      }
      if (!exists) {
        fsyncParent();
        published = true;
      }
    } catch (error) {
      failure = error;
      if (linked) {
        try {
          const canonicalStats = lstatSync(options.lockPath, { bigint: true });
          const tempStats = lstatSync(tempPath, { bigint: true });
          if (canonicalStats.isFile() && !canonicalStats.isSymbolicLink() &&
              tempStats.isFile() && !tempStats.isSymbolicLink() &&
              canonicalStats.dev === tempStats.dev && canonicalStats.ino === tempStats.ino) {
            handoff?.beforeRollbackUnlink();
            validatePath();
            unlinkSync(options.lockPath);
            handoff?.afterRollbackUnlink();
            fsyncParent();
          }
        } catch {
          // Preserve the publication error. A failed handoff guard deliberately
          // leaves the exact published owner for its registered recovery entry.
        }
      }
    } finally {
      if (descriptor !== undefined) {
        const closing = descriptor;
        descriptor = undefined;
        try { closeSync(closing); } catch (error) { if (failure === undefined) failure = error; }
      }
      if (!linked && handoff !== undefined && !discardConsumed) {
        discardConsumed = true;
        try { handoff.discardUnpublished(); } catch (error) { if (failure === undefined) failure = error; }
      }
      try { handoff?.beforeTemporaryUnlink?.(); validatePath(); unlinkSync(tempPath); } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') {
          if (failure === undefined) failure = error;
        }
      }
    }
    if (failure !== undefined) throw failure;
    return published;
  };

  if (!publish()) {
    validatePath();
    const existingRead = readPolicy === undefined ? undefined : readLockBounded(options.lockPath, readPolicy);
    const existing = readPolicy === undefined ? readLock(options.lockPath) : existingRead?.record ?? null;
    if (existing === null || !definitelyStale(existing, alive, identity, processStart)) {
      throw new DispatchInvocationLockedError(options.lockPath);
    }
    options.beforeStaleTakeover?.();
    validatePath();

    // Each claimant is a versioned, immutable symlink target. A dead claimant
    // remains in place and a successor claims its deterministic recovery path,
    // avoiding check-then-unlink of a replacement owner.
    const takeoverRootPath = staleTakeoverPath(options.lockPath, existing);
    let takeoverPath = takeoverRootPath;
    const claim = owner;
    const visitedTakeoverPaths = new Set<string>();
    while (true) {
      if (visitedTakeoverPaths.has(takeoverPath)) {
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      visitedTakeoverPaths.add(takeoverPath);
      const continuation = readPolicy?.reserveReadBytes(4 * readPolicy.maxRecordBytes);
      const created = createTakeoverClaim(takeoverPath, claim);
      if (!created) {
        continuation?.releaseUnused();
        validatePath();
        const previousClaim = readPolicy === undefined
          ? readTakeoverClaim(takeoverPath, options.lockPath, existing)
          : existingRead == null ? null : readTakeoverClaimBounded(takeoverPath, options.lockPath, existing,
            existingRead.generation, readPolicy, ordinaryRead!);
        if (previousClaim === null || !definitelyStale(previousClaim, alive, identity, processStart)) {
          throw new DispatchInvocationLockedError(options.lockPath);
        }
        takeoverPath = staleTakeoverRecoveryPath(takeoverRootPath, previousClaim);
        continue;
      }
      const criticalRead = continuation?.accountRead ?? ordinaryRead;
      const currentRead = readPolicy === undefined ? undefined : readLockBounded(options.lockPath, readPolicy, criticalRead);
      const current = readPolicy === undefined ? readLock(options.lockPath) : currentRead?.record ?? null;
      if (current === null || !sameLockRecord(current, existing) ||
          (readPolicy !== undefined && (currentRead?.generation.dev !== existingRead?.generation.dev ||
            currentRead?.generation.ino !== existingRead?.generation.ino)) ||
          !definitelyStale(current, alive, identity, processStart)) {
        continuation?.releaseUnused();
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      try {
        validatePath();
        unlinkSync(options.lockPath);
        fsyncParent();
      } catch {
        continuation?.releaseUnused();
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      if (!publish(criticalRead)) {
        continuation?.releaseUnused();
        throw new DispatchInvocationLockedError(options.lockPath);
      }
      if (continuation !== undefined && readPolicy !== undefined) {
        const published = readLockBounded(options.lockPath, readPolicy, criticalRead);
        if (published === null || !sameLockRecord(published.record, owner)) {
          continuation.releaseUnused();
          throw new DispatchInvocationLockedError(options.lockPath);
        }
      }
      continuation?.releaseUnused();
      break;
    }
    if (readPolicy === undefined) {
      validatePath();
      if (!sameLockRecord(readLock(options.lockPath) ?? { nonce: '', pid: 0 }, owner)) {
        throw new DispatchInvocationLockedError(options.lockPath);
      }
    }
  }

  return {
    release() {
      validatePath();
      const currentRead = readPolicy === undefined ? undefined : readLockBounded(options.lockPath, readPolicy,
        readPolicy.releaseRead?.accountRead ?? readPolicy.accountRead);
      const current = readPolicy === undefined ? readLock(options.lockPath) : currentRead?.record ?? null;
      if (current === null || !sameLockRecord(current, owner)) return;
      if (readPolicy !== undefined) {
        const currentPath = lstatSync(options.lockPath, { bigint: true });
        if (!currentPath.isFile() || currentPath.isSymbolicLink() || currentPath.dev !== currentRead?.generation.dev ||
            currentPath.ino !== currentRead?.generation.ino) return;
      }
      try {
        validatePath();
        unlinkSync(options.lockPath);
        fsyncParent();
      } catch (error: unknown) {
        if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
    },
  };
}
