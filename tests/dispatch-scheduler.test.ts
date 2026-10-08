import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import { main } from '../src/cli.js';
import { DEFAULT_MISSION_ADMISSION_CONFIG, createHostAdmissionRegistry, resolveManualOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { writeManualOwnerReceipt } from '../src/mission-admission/manual-owner-receipt.js';
import { readOperationalRuntimeProjection, writeOperationalRuntimeProjection } from '../src/operational/runtime-projection.js';
import { syncDirectory } from '../src/durable-directory.js';

async function withAccountHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(home, { recursive: true });
  const original = os.userInfo;
  Object.defineProperty(os, 'userInfo', { configurable: true, value: (...args: Parameters<typeof original>) => ({ ...original(...args), homedir: home }) });
  try { return await operation(); }
  finally { Object.defineProperty(os, 'userInfo', { configurable: true, value: original }); }
}

describe('dispatch scheduler boundary', () => {
  it('rejects unsafe canonical lock drift before identity, takeover, publication, or cleanup', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-account-'));
    const dispatch = path.join(home, '.tachiko-conductor', 'dispatch');
    mkdirSync(dispatch, { recursive: true, mode: 0o755 });
    chmodSync(path.join(home, '.tachiko-conductor'), 0o755);
    chmodSync(dispatch, 0o755);
    const lockPath = path.join(dispatch, 'once.lock');
    const stale = JSON.stringify({ nonce: 'stale-owner', pid: 41 });
    writeFileSync(lockPath, stale, { mode: 0o644 });
    const before = statSync(lockPath);
    let identityCalls = 0;
    let takeoverCalls = 0;
    await withAccountHome(home, async () => {
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        hostBootIdentity: () => { identityCalls += 1; return { hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }; },
        processStartIdentity: () => 'test-start',
        isProcessAlive: () => false,
        beforeStaleTakeover: () => { takeoverCalls += 1; },
      }), /Unsafe/);
    });
    const after = statSync(lockPath);
    assert.equal(readFileSync(lockPath, 'utf8'), stale);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(identityCalls, 0);
    assert.equal(takeoverCalls, 0);
    rmSync(home, { recursive: true, force: true });
  });

  it('rechecks dispatch ancestry after the pre-publication callback without repairing drift', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-account-callback-'));
    const conductor = path.join(home, '.tachiko-conductor');
    const dispatch = path.join(conductor, 'dispatch');
    mkdirSync(dispatch, { recursive: true, mode: 0o755 });
    chmodSync(conductor, 0o755);
    chmodSync(dispatch, 0o755);
    const lockPath = path.join(dispatch, 'once.lock');
    await withAccountHome(home, async () => {
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        hostBootIdentity: () => ({ hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }),
        processStartIdentity: () => 'test-start',
        beforeCanonicalLink: () => chmodSync(dispatch, 0o777),
      }), /Unsafe/);
    });
    assert.equal(existsSync(lockPath), false);
    assert.equal(statSync(dispatch).mode & 0o777, 0o777);
    chmodSync(dispatch, 0o755);
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects direct lock acquisition after a cached canonical conductor path is retargeted', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-account-retarget-'));
    const conductor = path.join(home, '.tachiko-conductor');
    const dispatch = path.join(conductor, 'dispatch');
    mkdirSync(dispatch, { recursive: true, mode: 0o755 });
    chmodSync(conductor, 0o755);
    chmodSync(dispatch, 0o755);
    const lockPath = path.join(dispatch, 'once.lock');
    const preserved = path.join(home, 'preserved-conductor');
    const alternate = path.join(home, 'alternate-conductor');
    mkdirSync(alternate, { mode: 0o755 });
    renameSync(conductor, preserved);
    symlinkSync(alternate, conductor, 'dir');
    let identityCalls = 0;
    await withAccountHome(home, async () => {
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        hostBootIdentity: () => { identityCalls += 1; return { hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }; },
        processStartIdentity: () => 'test-start',
      }), /symlink.*wrong filesystem type/);
    });
    assert.equal(identityCalls, 0);
    assert.equal(existsSync(path.join(alternate, 'dispatch')), false);
    assert.equal(existsSync(path.join(preserved, 'dispatch', 'once.lock')), false);
    rmSync(conductor);
    renameSync(preserved, conductor);
    rmSync(home, { recursive: true, force: true });
  });

  it('does not publish a dispatch lock until each visible lock-directory edge can be synced', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-hierarchy-'));
    const lockDirectory = path.join(directory, 'dispatch', 'nested');
    const lockPath = path.join(lockDirectory, 'once.lock');
    const failedParent = path.join(directory, 'dispatch');
    const seen: string[] = [];
    let fail = true;
    const syncHierarchy = (parent: string) => {
      seen.push(parent);
      if (fail && parent === failedParent) throw new Error('injected dispatch hierarchy sync failure');
      syncDirectory(parent);
    };
    try {
      assert.throws(() => acquireDispatchInvocationLock({ lockPath, syncDirectoryHierarchy: syncHierarchy }), /dispatch hierarchy sync failure/);
      assert.equal(existsSync(lockDirectory), true, 'visible directory remains available for verified retry');
      assert.equal(existsSync(lockPath), false, 'no canonical lock is published before hierarchy durability');
      assert.equal(readdirSync(lockDirectory).length, 0, 'no private lock claim temp is created before the barrier');
      assert.equal(seen.at(-1), failedParent);

      seen.length = 0;
      assert.throws(() => acquireDispatchInvocationLock({ lockPath, syncDirectoryHierarchy: syncHierarchy }), /dispatch hierarchy sync failure/);
      assert.equal(seen.at(-1), failedParent, 'retry re-syncs the parent of the already visible directory');
      assert.equal(existsSync(lockPath), false);

      fail = false;
      const lock = acquireDispatchInvocationLock({ lockPath, syncDirectoryHierarchy: syncHierarchy });
      assert.equal(existsSync(lockPath), true);
      lock.release();
      assert.equal(existsSync(lockPath), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps overlapping same-host invocations out and safely recovers a provably stale lock', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-'));
    const lockPath = path.join(directory, 'once.lock');
    try {
      const first = acquireDispatchInvocationLock({ lockPath, nonce: () => 'first' });
      assert.throws(() => acquireDispatchInvocationLock({ lockPath, nonce: () => 'second' }), DispatchInvocationLockedError);
      first.release();
      writeFileSync(lockPath, JSON.stringify({ nonce: 'crashed', pid: 41 }));
      const recovered = acquireDispatchInvocationLock({ lockPath, nonce: () => 'recovered', isProcessAlive: () => false });
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { schemaVersion: number; nonce: string; pid: number; hostId: string; bootId: string; processStartId: string };
      assert.deepEqual(Object.keys(owner).sort(), ['bootId', 'hostId', 'nonce', 'pid', 'processStartId', 'schemaVersion']);
      assert.equal(owner.schemaVersion, 1);
      assert.equal(owner.nonce, 'recovered');
      assert.equal(statSync(lockPath).mode & 0o777, 0o600);
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('writes and fsyncs a complete private sibling before atomically linking the canonical lock', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-publish-'));
    const lockPath = path.join(directory, 'once.lock');
    try {
      let observedTemp: string | undefined;
      const lock = acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'complete-owner',
        hostBootIdentity: () => ({ hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }),
        processStartIdentity: () => 'test-process-start',
        beforeCanonicalLink: () => {
          assert.throws(() => readFileSync(lockPath), { code: 'ENOENT' });
          const temporary = readdirSync(directory).find((entry) => entry.startsWith('once.lock.tmp-'));
          assert.ok(temporary, 'the fully written sibling exists before canonical publication');
          observedTemp = path.join(directory, temporary);
          const stats = statSync(observedTemp);
          assert.equal(stats.isFile(), true);
          assert.equal(stats.mode & 0o777, 0o600);
          const staged = JSON.parse(readFileSync(observedTemp, 'utf8')) as { schemaVersion: number; nonce: string };
          assert.equal(staged.schemaVersion, 1);
          assert.equal(staged.nonce, 'complete-owner');
        },
      });
      assert.ok(observedTemp);
      const canonical = JSON.parse(readFileSync(lockPath, 'utf8')) as { schemaVersion: number; nonce: string };
      assert.equal(canonical.schemaVersion, 1);
      assert.equal(canonical.nonce, 'complete-owner');
      assert.equal(readdirSync(directory).some((entry) => entry.startsWith('once.lock.tmp-')), false,
        'the owned staging link is removed after durable publication');
      lock.release();

      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'failed-before-link',
        hostBootIdentity: () => ({ hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }),
        processStartIdentity: () => 'test-process-start',
        beforeCanonicalLink: () => { throw new Error('injected pre-link failure'); },
      }), /injected pre-link failure/);
      assert.throws(() => readFileSync(lockPath), { code: 'ENOENT' });
      assert.equal(readdirSync(directory).some((entry) => entry.startsWith('once.lock.tmp-')), false,
        'an interrupted owner removes only its own unlinked temporary file');

      let directorySyncs = 0;
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'failed-after-link',
        hostBootIdentity: () => ({ hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }),
        processStartIdentity: () => 'test-process-start',
        syncDirectory: () => {
          directorySyncs += 1;
          if (directorySyncs === 1) throw new Error('injected parent fsync failure');
        },
      }), /injected parent fsync failure/);
      assert.equal(directorySyncs, 2, 'the failed publication attempts a parent sync after exact owned-link cleanup');
      assert.throws(() => readFileSync(lockPath), { code: 'ENOENT' },
        'failed post-link durability does not leave an unreleaseable live owner lock');
      assert.equal(readdirSync(directory).some((entry) => entry.startsWith('once.lock.tmp-')), false);
      const retry = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'retry-after-failed-fsync',
        hostBootIdentity: () => ({ hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) }),
        processStartIdentity: () => 'test-process-start',
      });
      retry.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hands a prepared publication anchor through rollback without discarding a linked owner', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-prepared-owner-'));
    const lockPath = path.join(directory, 'prepared.lock');
    const events: string[] = [];
    let prelink = false;
    let failPublicationBarrier = true;
    try {
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        preparePublication: (publication) => {
          assert.equal(publication.temporaryPath.startsWith(`${lockPath}.tmp-`), true);
          assert.equal(typeof publication.generation.dev, 'bigint');
          assert.equal(typeof publication.generation.ino, 'bigint');
          events.push('prepared');
          return {
            discardUnpublished: () => { events.push('discard'); },
            beforeRollbackUnlink: () => { events.push('guard'); },
            afterRollbackUnlink: () => { events.push('unlinked'); },
          };
        },
        beforeCanonicalLink: () => { prelink = true; events.push('prelink'); },
        syncDirectory: (directoryPath) => {
          if (prelink && failPublicationBarrier) {
            failPublicationBarrier = false;
            throw new Error('prepared publication barrier failure');
          }
          syncDirectory(directoryPath);
        },
      }), /prepared publication barrier failure/);
      assert.deepEqual(events, ['prepared', 'prelink', 'guard', 'unlinked']);
      assert.equal(existsSync(lockPath), false, 'the exact linked owner was rolled back only after its guard');
      assert.deepEqual(readdirSync(directory), [], 'the temporary alias is retired after rollback');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('reclaims versioned same-host locks only across reboot or process-start mismatch', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-incarnation-'));
    const lockPath = path.join(directory, 'once.lock');
    const hostId = 'a'.repeat(64);
    const oldBoot = 'b'.repeat(64);
    const currentBoot = 'c'.repeat(64);
    const staleRecord = {
      schemaVersion: 1, nonce: 'prior-owner', pid: 41, hostId, bootId: oldBoot,
      processStartId: 'linux-start-ticks:100',
    };
    try {
      writeFileSync(lockPath, JSON.stringify(staleRecord), { mode: 0o600 });
      const afterReboot = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'after-reboot',
        hostBootIdentity: () => ({ hostId, bootId: currentBoot }),
        processStartIdentity: () => 'linux-start-ticks:200',
        isProcessAlive: () => true,
      });
      assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string }).nonce, 'after-reboot',
        'same host with a different boot incarnation is stale even if the numeric PID exists');
      afterReboot.release();

      writeFileSync(lockPath, JSON.stringify({ ...staleRecord, bootId: currentBoot }), { mode: 0o600 });
      const afterPidReuse = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'after-pid-reuse',
        hostBootIdentity: () => ({ hostId, bootId: currentBoot }),
        processStartIdentity: () => 'linux-start-ticks:200',
        isProcessAlive: () => true,
      });
      assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string }).nonce, 'after-pid-reuse',
        'a live reused PID cannot inherit the previous process incarnation lock');
      afterPidReuse.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fences historical macOS start strings across timezone changes and migrates only after death proof', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-darwin-tz-'));
    const lockPath = path.join(directory, 'once.lock');
    const identity = { hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) };
    const historical = {
      schemaVersion: 1, nonce: 'old-macos-owner', pid: 41, hostId: identity.hostId, bootId: identity.bootId,
      processStartId: 'darwin-ps-start:Wed Jan  1 00:00:00 JST 2025',
    };
    try {
      writeFileSync(lockPath, JSON.stringify(historical), { mode: 0o600 });
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath, nonce: () => 'live-tz-mismatch',
        hostBootIdentity: () => identity,
        processStartIdentity: () => 'darwin-ps-start-utc:Wed Jan  1 00:00:00 UTC 2025',
        isProcessAlive: () => true,
      }), DispatchInvocationLockedError,
      'an incomparable historical local-time string cannot classify a live same-boot process as reused');
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), historical);

      const recovered = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'dead-historical-owner',
        hostBootIdentity: () => identity,
        processStartIdentity: () => 'darwin-ps-start-utc:Wed Jan  1 00:00:00 UTC 2025',
        isProcessAlive: () => false,
      });
      assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string }).nonce, 'dead-historical-owner',
        'legacy localized identity migrates only after confirmed PID death');
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a live native macOS owner fenced when only the caller timezone changes', (t) => {
    if (process.platform !== 'darwin') {
      t.skip('native macOS ps timezone regression');
      return;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-native-tz-'));
    const lockPath = path.join(directory, 'once.lock');
    const priorTimezone = process.env.TZ;
    let first: ReturnType<typeof acquireDispatchInvocationLock> | undefined;
    try {
      process.env.TZ = 'Asia/Tokyo';
      first = acquireDispatchInvocationLock({ lockPath, nonce: () => 'native-tokyo-owner' });
      const originalOwner = readFileSync(lockPath, 'utf8');

      process.env.TZ = 'UTC0';
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath, nonce: () => 'native-utc-contender',
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(lockPath, 'utf8'), originalOwner,
        'a TZ-only environment change cannot reclaim or replace the live canonical owner');
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
      first?.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('traverses more than sixteen immutable dead claims to acquire a fresh takeover claim', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-deep-claims-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'crashed-root', pid: 41 };
    const root = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    const oldClaims: string[] = [];
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      let takeoverPath = root;
      for (let index = 0; index < 20; index += 1) {
        const previousClaim = { nonce: `dead-claim-${index}`, pid: 50 + index };
        symlinkSync(JSON.stringify(previousClaim), takeoverPath);
        oldClaims.push(takeoverPath);
        takeoverPath = `${root}.${createHash('sha256').update(JSON.stringify(previousClaim)).digest('hex')}.recovery`;
      }
      const recovered = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'after-twenty-crashes', isProcessAlive: () => false,
      });
      assert.equal((JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string }).nonce, 'after-twenty-crashes');
      for (const oldClaim of oldClaims) assert.equal(readlinkSync(oldClaim).length > 0, true,
        'dead immutable claim records are traversed, never deleted');
      assert.equal((JSON.parse(readlinkSync(takeoverPath)) as { nonce: string }).nonce, 'after-twenty-crashes',
        'the successful takeover claim remains as immutable recovery history');
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('charges each bounded symlink claim and keeps the finite winning-claim lane', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-budgeted-claims-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'budgeted-crashed-root', pid: 41 };
    const root = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    let chargedBytes = 0;
    const policy = (limit: number) => ({
      maxRecordBytes: 4096,
      symlinkReadBytes: 4096,
      accountRead: (bytes: number) => {
        if (chargedBytes + bytes > limit) throw new Error('metadata-read budget exhausted');
        chargedBytes += bytes;
      },
      reserveReadBytes: (bytes: number) => {
        if (chargedBytes + bytes > limit) throw new Error('metadata-read budget exhausted');
        chargedBytes += bytes;
        let remaining = bytes;
        let active = true;
        return {
          accountRead: (count: number) => {
            if (!active || count > remaining) throw new Error('metadata-read budget exhausted');
            remaining -= count;
          },
          releaseUnused: () => {
            if (!active) return;
            chargedBytes -= remaining;
            active = false;
          },
        };
      },
    });
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      let takeoverPath = root;
      const claims: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const previousClaim = { nonce: `budgeted-dead-claim-${index}`, pid: 50 + index };
        symlinkSync(JSON.stringify(previousClaim), takeoverPath);
        claims.push(takeoverPath);
        takeoverPath = `${root}.${createHash('sha256').update(JSON.stringify(previousClaim)).digest('hex')}.recovery`;
      }
      const recovered = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'budgeted-live-winner', isProcessAlive: () => false, readPolicy: policy(1_000_000),
      });
      assert.ok(chargedBytes > 20 * 1024, 'every distinct historical symlink is charged at the qualified 4 KiB ceiling');
      assert.ok(claims.every((claim) => readlinkSync(claim).length > 0), 'claim history remains immutable');
      assert.equal((JSON.parse(readlinkSync(takeoverPath)) as { nonce: string }).nonce, 'budgeted-live-winner');
      recovered.release();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves a byte-identical canonical owner replacement after creating a bounded takeover claim', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-generation-'));
    const lockPath = path.join(directory, 'once.lock');
    const pinnedOriginalPath = path.join(directory, 'original-owner.pin');
    const staleBytes = JSON.stringify({ nonce: 'generation-crashed-owner', pid: 41 });
    const takeoverPath = `${lockPath}.${createHash('sha256').update(staleBytes).digest('hex')}.stale-takeover`;
    let chargedBytes = 0;
    let replacementInstalled = false;
    try {
      writeFileSync(lockPath, staleBytes);
      const originalGeneration = statSync(lockPath);
      linkSync(lockPath, pinnedOriginalPath);
      const installReplacement = () => {
        if (replacementInstalled || !lstatSync(takeoverPath).isSymbolicLink()) return;
        const replacementPath = path.join(directory, 'replacement-owner.tmp');
        writeFileSync(replacementPath, staleBytes);
        renameSync(replacementPath, lockPath);
        replacementInstalled = true;
      };
      const readPolicy = {
        maxRecordBytes: 4096,
        symlinkReadBytes: 4096,
        accountRead: (bytes: number) => {
          if (chargedBytes + bytes > 100_000) throw new Error('metadata-read budget exhausted');
          chargedBytes += bytes;
        },
        reserveReadBytes: (bytes: number) => {
          if (chargedBytes + bytes > 100_000) throw new Error('metadata-read budget exhausted');
          chargedBytes += bytes;
          let remaining = bytes;
          let active = true;
          const accountReservedRead = (count: number) => {
            if (!active || count > remaining) throw new Error('metadata-read budget exhausted');
            remaining -= count;
          };
          return {
            get accountRead() {
              // The source reads this getter after creating the fresh claim,
              // then passes the returned callback into boundedRecordFromDescriptor.
              // Replace now, before that reader's first lstat, so its own
              // descriptor/path generation checks see a stable replacement.
              installReplacement();
              return accountReservedRead;
            },
            releaseUnused: () => {
              if (active) { chargedBytes -= remaining; active = false; }
            },
          };
        },
      };

      assert.throws(() => acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'generation-live-successor',
        isProcessAlive: () => false,
        readPolicy,
      }), DispatchInvocationLockedError);

      assert.equal(replacementInstalled, true, 'replacement is installed after the fresh claim exists');
      assert.equal(readFileSync(lockPath, 'utf8'), staleBytes, 'byte-identical foreign replacement remains canonical');
      const replacementGeneration = statSync(lockPath);
      const pinnedGeneration = statSync(pinnedOriginalPath);
      assert.equal(pinnedGeneration.dev, originalGeneration.dev);
      assert.equal(pinnedGeneration.ino, originalGeneration.ino, 'hard link pins the original inode against reuse');
      assert.notEqual(replacementGeneration.ino, originalGeneration.ino, 'canonical path names a different inode');
      assert.equal((JSON.parse(readlinkSync(takeoverPath)) as { nonce: string }).nonce, 'generation-live-successor',
        'fresh claim history remains intact when takeover refuses the new generation');
      assert.ok(chargedBytes >= 2 * Buffer.byteLength(staleBytes), 'both admitted owner generations remain charged');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses a fresh live claim before creation when its bounded continuation cannot be reserved', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-reservation-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'reservation-crashed-root', pid: 41 };
    const root = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    const makePolicy = (limit: number) => {
      let charged = 0;
      return {
        maxRecordBytes: 4096, symlinkReadBytes: 4096,
        accountRead: (bytes: number) => { if (charged + bytes > limit) throw new Error('metadata-read budget exhausted'); charged += bytes; },
        reserveReadBytes: (bytes: number) => {
          if (charged + bytes > limit) throw new Error('metadata-read budget exhausted');
          charged += bytes;
          let remaining = bytes;
          let active = true;
          return {
            accountRead: (count: number) => { if (!active || count > remaining) throw new Error('metadata-read budget exhausted'); remaining -= count; },
            releaseUnused: () => { if (active) { charged -= remaining; active = false; } },
          };
        },
      };
    };
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath, nonce: () => 'first-live-winner', isProcessAlive: () => false, readPolicy: makePolicy(4096),
      }), /metadata-read budget exhausted/);
      assert.equal(existsSync(root), false, 'no claim naming this still-live process is published without its full continuation reserve');
      const recovered = acquireDispatchInvocationLock({
        lockPath, nonce: () => 'later-live-winner', isProcessAlive: () => false, readPolicy: makePolicy(1_000_000),
      });
      assert.equal((JSON.parse(readlinkSync(root)) as { nonce: string }).nonce, 'later-live-winner');
      recovered.release();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed on a deep live claim and on a repeated recovery path', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-deep-fenced-'));
    const makePaths = (lockPath: string, stale: { nonce: string; pid: number }, count: number, final?: string) => {
      const root = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
      const paths: string[] = [];
      let current = root;
      for (let index = 0; index < count; index += 1) {
        const claim = { nonce: `dead-prefix-${index}`, pid: 70 + index };
        symlinkSync(JSON.stringify(claim), current);
        paths.push(current);
        current = `${root}.${createHash('sha256').update(JSON.stringify(claim)).digest('hex')}.recovery`;
      }
      if (final !== undefined) symlinkSync(final, current);
      return { root, current, paths };
    };
    try {
      const liveLockPath = path.join(directory, 'live.lock');
      const liveStale = { nonce: 'live-stale-root', pid: 41 };
      writeFileSync(liveLockPath, JSON.stringify(liveStale));
      const liveChain = makePaths(liveLockPath, liveStale, 20, JSON.stringify({ nonce: 'deep-live-claim', pid: 999 }));
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath: liveLockPath, nonce: () => 'must-not-pass-live-claim',
        isProcessAlive: (pid) => pid === 999,
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(liveLockPath, 'utf8'), JSON.stringify(liveStale));
      assert.equal(readlinkSync(liveChain.current), JSON.stringify({ nonce: 'deep-live-claim', pid: 999 }));

      const malformedLockPath = path.join(directory, 'malformed.lock');
      const malformedStale = { nonce: 'malformed-stale-root', pid: 41 };
      writeFileSync(malformedLockPath, JSON.stringify(malformedStale));
      const malformedChain = makePaths(malformedLockPath, malformedStale, 20, 'not-json');
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath: malformedLockPath, nonce: () => 'must-not-pass-malformed-claim', isProcessAlive: () => false,
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(malformedLockPath, 'utf8'), JSON.stringify(malformedStale));
      assert.equal(readlinkSync(malformedChain.current), 'not-json',
        'a malformed claim beyond sixteen proven-dead claims remains fenced and immutable');

      const cyclicLockPath = path.join(directory, 'cycle.lock');
      const cyclicStale = { nonce: 'cycle-root', pid: 41 };
      writeFileSync(cyclicLockPath, JSON.stringify(cyclicStale));
      const cycleRoot = `${cyclicLockPath}.${createHash('sha256').update(JSON.stringify(cyclicStale)).digest('hex')}.stale-takeover`;
      const repeatedClaim = { nonce: 'same-dead-claim', pid: 42 };
      const repeatedRecovery = `${cycleRoot}.${createHash('sha256').update(JSON.stringify(repeatedClaim)).digest('hex')}.recovery`;
      symlinkSync(JSON.stringify(repeatedClaim), cycleRoot);
      symlinkSync(JSON.stringify(repeatedClaim), repeatedRecovery);
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath: cyclicLockPath, nonce: () => 'must-not-loop-on-cycle', isProcessAlive: () => false,
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(cyclicLockPath, 'utf8'), JSON.stringify(cyclicStale));
      assert.equal(readlinkSync(cycleRoot), JSON.stringify(repeatedClaim));
      assert.equal(readlinkSync(repeatedRecovery), JSON.stringify(repeatedClaim));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fences foreign, malformed, symlink and ambiguous live legacy lock records', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-fenced-'));
    const lockPath = path.join(directory, 'once.lock');
    const identity = { hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) };
    const acquire = () => acquireDispatchInvocationLock({
      lockPath, nonce: () => 'must-not-acquire', hostBootIdentity: () => identity,
      processStartIdentity: () => 'current-start', isProcessAlive: () => false,
    });
    try {
      const foreign = {
        schemaVersion: 1, nonce: 'foreign-owner', pid: 41, hostId: 'd'.repeat(64),
        bootId: 'b'.repeat(64), processStartId: 'foreign-start',
      };
      writeFileSync(lockPath, JSON.stringify(foreign), { mode: 0o600 });
      assert.throws(acquire, DispatchInvocationLockedError);
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), foreign,
        'a PID absent on this host cannot prove a foreign owner is dead');

      writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, nonce: 'ambiguous', pid: 41, hostId: 'a'.repeat(64) }), { mode: 0o600 });
      const malformed = readFileSync(lockPath, 'utf8');
      assert.throws(acquire, DispatchInvocationLockedError);
      assert.equal(readFileSync(lockPath, 'utf8'), malformed);

      writeFileSync(lockPath, JSON.stringify({ nonce: 'legacy-live', pid: 41 }), { mode: 0o600 });
      const legacy = readFileSync(lockPath, 'utf8');
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath, nonce: () => 'must-not-acquire', isProcessAlive: () => true,
        hostBootIdentity: () => identity, processStartIdentity: () => 'current-start',
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(lockPath, 'utf8'), legacy, 'live legacy PID-only records remain fenced');

      unlinkSync(lockPath);
      const target = path.join(directory, 'target.json');
      writeFileSync(target, JSON.stringify({ nonce: 'legacy-dead', pid: 41 }), { mode: 0o600 });
      symlinkSync(target, lockPath);
      assert.throws(acquire, DispatchInvocationLockedError);
      assert.equal(readlinkSync(lockPath), target, 'a symlink canonical path is never reclaimed or replaced');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not let a stale observer remove a replacement lock acquired during takeover', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-race-'));
    const lockPath = path.join(directory, 'once.lock');
    let replacement: ReturnType<typeof acquireDispatchInvocationLock> | undefined;
    try {
      writeFileSync(lockPath, JSON.stringify({ nonce: 'crashed', pid: 41 }));
      assert.throws(
        () => acquireDispatchInvocationLock({
          lockPath,
          nonce: () => 'stale-observer',
          isProcessAlive: () => false,
          beforeStaleTakeover: () => {
            replacement = acquireDispatchInvocationLock({
              lockPath,
              nonce: () => 'replacement',
              isProcessAlive: () => false,
            });
          },
        }),
        DispatchInvocationLockedError,
      );
      const replacementRecord = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string; pid: number; schemaVersion: number };
      assert.deepEqual({ nonce: replacementRecord.nonce, pid: replacementRecord.pid }, { nonce: 'replacement', pid: process.pid });
      assert.equal(replacementRecord.schemaVersion, 1);
      replacement?.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers a takeover claim whose owner died before stale recovery completed', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-abandoned-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'crashed', pid: 41 };
    const takeoverPath = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      symlinkSync(JSON.stringify({ nonce: 'dead-takeover', pid: 42 }), takeoverPath);
      const recovered = acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'recovered-after-abandoned-claim',
        isProcessAlive: () => false,
      });
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string; pid: number; schemaVersion: number };
      assert.deepEqual({ nonce: owner.nonce, pid: owner.pid }, {
        nonce: 'recovered-after-abandoned-claim', pid: process.pid,
      });
      assert.equal(owner.schemaVersion, 1);
      assert.equal(readlinkSync(takeoverPath, 'utf8'), JSON.stringify({ nonce: 'dead-takeover', pid: 42 }));
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recovers an exact legacy hard-link takeover claim without unlinking it', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-legacy-hard-link-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'crashed', pid: 41 };
    const takeoverPath = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      linkSync(lockPath, takeoverPath);
      const recovered = acquireDispatchInvocationLock({
        lockPath,
        nonce: () => 'recovered-after-legacy-hard-link',
        isProcessAlive: () => false,
      });
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string; pid: number; schemaVersion: number };
      assert.deepEqual({ nonce: owner.nonce, pid: owner.pid }, {
        nonce: 'recovered-after-legacy-hard-link', pid: process.pid,
      });
      assert.equal(owner.schemaVersion, 1);
      assert.deepEqual(JSON.parse(readFileSync(takeoverPath, 'utf8')), stale);
      recovered.release();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('leaves a takeover claim owned by a live recovery process untouched', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-live-claim-'));
    const lockPath = path.join(directory, 'once.lock');
    const stale = { nonce: 'crashed', pid: 41 };
    const takeoverPath = `${lockPath}.${createHash('sha256').update(JSON.stringify(stale)).digest('hex')}.stale-takeover`;
    try {
      writeFileSync(lockPath, JSON.stringify(stale));
      symlinkSync(JSON.stringify({ nonce: 'live-takeover', pid: process.pid }), takeoverPath);
      assert.throws(
        () => acquireDispatchInvocationLock({
          lockPath,
          nonce: () => 'other-recovery',
          isProcessAlive: (pid) => pid === process.pid,
        }),
        DispatchInvocationLockedError,
      );
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), stale);
      assert.equal(readlinkSync(takeoverPath, 'utf8'), JSON.stringify({ nonce: 'live-takeover', pid: process.pid }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('persists the revisioned #104 policy and owner-controlled Luna home across restarts', () => {
    const plist = renderDispatchLaunchdPlist({
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      nodeProgram: '/Users/example/.local/node/bin/node',
      pnpmProgram: '/Users/example/.local/node/bin/pnpm',
      dependencyArtifactPath: '/Users/example/.local/tachiko/pnpm-store',
      lunaCodexHome: '/Users/example/.tachiko/luna-codex-home',
      playwrightBrowsersPath: '/Users/example/.tachiko/playwright-browsers',
      workingDirectory: '/Users/example/Developer/tachiko-conductor',
    });
    assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/Users\/example\/Library/);
    assert.doesNotMatch(plist, /TACHIKO_DISPATCH_CONFIG/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /<key>TACHIKO_NODE_PROGRAM<\/key><string>\/Users\/example\/\.local\/node\/bin\/node<\/string>/);
    assert.match(plist, /<key>TACHIKO_PNPM_PROGRAM<\/key><string>\/Users\/example\/\.local\/node\/bin\/pnpm<\/string>/);
    assert.match(plist, /<key>TACHIKO_PNPM_DEPENDENCY_ARTIFACT<\/key><string>\/Users\/example\/\.local\/tachiko\/pnpm-store<\/string>/);
    assert.match(plist, /<key>TACHIKO_LUNA_CODEX_HOME<\/key><string>\/Users\/example\/\.tachiko\/luna-codex-home<\/string>/);
    assert.match(plist, /<key>TACHIKO_PLAYWRIGHT_BROWSERS_PATH<\/key><string>\/Users\/example\/\.tachiko\/playwright-browsers<\/string>/);
    assert.match(plist, /<key>TACHIKO_EXECUTION_PROFILE_CONFIG<\/key>/);
    assert.match(plist, /<key>TACHIKO_LOCAL_VALIDATION_CONFIG<\/key>/);
    assert.match(plist, /<key>TACHIKO_HOSTED_CHECK_POLICY_CONFIG<\/key><string>{&quot;revision&quot;:&quot;issue-104-production-v4&quot;,&quot;mode&quot;:&quot;not_required&quot;}<\/string>/);
    assert.doesNotMatch(plist, /StartCalendarInterval/);
  });

  it('renders the same supervisor across reinstall without creating a timer wake', () => {
    const options = {
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      nodeProgram: '/Users/example/.local/node/bin/node',
      pnpmProgram: '/Users/example/.local/node/bin/pnpm',
      dependencyArtifactPath: '/Users/example/.local/tachiko/pnpm-store',
      lunaCodexHome: '/Users/example/.tachiko/luna-codex-home',
      playwrightBrowsersPath: '/Users/example/.tachiko/playwright-browsers',
      workingDirectory: '/Users/example/Developer/tachiko-conductor',
      label: 'io.tachiko.conductor.dispatch-driver',
    } as const;
    const configured = renderDispatchLaunchdPlist(options);
    const reinstalled = renderDispatchLaunchdPlist(options);
    assert.equal(reinstalled, configured);
    assert.match(configured, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(configured, /<key>KeepAlive<\/key><true\/>/);
    assert.doesNotMatch(configured, /StartInterval/);
    assert.doesNotMatch(configured, /StartCalendarInterval/);
  });

  it('pins the canonical #101 queue location and sources the #104 production policy in the stable driver', () => {
    const wrapper = readFileSync(path.resolve('scripts/dispatch-driver.sh'), 'utf8');
    const match = wrapper.match(/export TACHIKO_DISPATCH_CONFIG='([^']+)'/);
    assert.ok(match);
    assert.deepEqual(parseDispatchConfiguration(match[1]!), {
      revision: 'dispatch-production-v1', owner: 'nurockplayer', repo: 'tachiko-conductor', controlIssue: 101, queueCommentId: 5755262217, leaseDurationMs: 900_000,
    });
    assert.match(wrapper, /issue-104-production-policy\.sh/);
    assert.match(wrapper, /TACHIKO_NODE_PROGRAM/);
    assert.match(wrapper, /TACHIKO_PNPM_PROGRAM/);
    assert.doesNotMatch(wrapper, /exec corepack/);
  });

  it('leaves a concurrent dispatch at a safe re-entry boundary without reading configuration or GitHub', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-main-lock-'));
    const accountHome = path.join(directory, 'account-home');
    const lockPath = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock');
    const previous = process.env.TACHIKO_DISPATCH_LOCK_PATH;
    const printed: string[] = [];
    const original = console.log;
    try {
      const lock = acquireDispatchInvocationLock({ lockPath, nonce: () => 'first' });
      process.env.TACHIKO_DISPATCH_LOCK_PATH = lockPath;
      console.log = (value?: unknown) => { printed.push(String(value)); };
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'once']), 0));
      assert.match(printed.at(-1) ?? '', /"outcome":"already_running"/);
      assert.doesNotMatch(printed.at(-1) ?? '', /TACHIKO_HEARTBEAT_SETTLED_V1/);
      lock.release();
    } finally {
      console.log = original;
      if (previous === undefined) delete process.env.TACHIKO_DISPATCH_LOCK_PATH;
      else process.env.TACHIKO_DISPATCH_LOCK_PATH = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps serve parked across held restart/re-entry without configuration, queue, worker, or model admission', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-held-serve-'));
    const accountHome = path.join(directory, 'account-home');
    const previous = {
      data: process.env.TACHIKO_DATA_DIR,
      lock: process.env.TACHIKO_DISPATCH_LOCK_PATH,
      wake: process.env.TACHIKO_DISPATCH_WAKE_PATH,
      execution: process.env.TACHIKO_EXECUTION_PROFILE_CONFIG,
      admissionPath: process.env.TACHIKO_MISSION_ADMISSION_PATH,
      admissionConfig: process.env.TACHIKO_MISSION_ADMISSION_CONFIG,
      manualReceipts: process.env.TACHIKO_MANUAL_OWNER_RECEIPTS_DIR,
    };
    const printed: string[] = [];
    const original = console.log;
    try {
      process.env.TACHIKO_DATA_DIR = path.join(directory, 'runs');
      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock');
      process.env.TACHIKO_DISPATCH_WAKE_PATH = path.join(directory, 'wake');
      const registryPath = path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'registry.json');
      const manualReceiptsPath = path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'manual-receipts');
      process.env.TACHIKO_MISSION_ADMISSION_PATH = registryPath;
      process.env.TACHIKO_MISSION_ADMISSION_CONFIG = JSON.stringify(DEFAULT_MISSION_ADMISSION_CONFIG);
      process.env.TACHIKO_MANUAL_OWNER_RECEIPTS_DIR = manualReceiptsPath;
      delete process.env.TACHIKO_EXECUTION_PROFILE_CONFIG;
      const workspace = path.join(directory, 'manual-worktree');
      mkdirSync(workspace);
      const canonicalWorkspace = realpathSync.native(workspace);
      const branch = 'held-scheduler-checkpoint';
      const checkpointSha = 'a'.repeat(40);
      let registryBytes = '';
      let receiptBytes = '';
      let manualReceiptPath = '';
      let admissionRevision = 0;
      let expectedManualLane: ReturnType<ReturnType<typeof createHostAdmissionRegistry>['readLane']>;
      await withAccountHome(accountHome, async () => {
        const registry = createHostAdmissionRegistry();
        const admitted = registry.admit({
          laneId: 'scheduler-held-manual-owner', role: 'production_captain',
          evidence: { repository: 'acme/widgets', repositoryScope: true, workspace: canonicalWorkspace },
        });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') throw new Error('could not create the held manual owner fixture');
        registry.parkManual(admitted.token, { worktree: canonicalWorkspace, branch, checkpointSha, clean: true, stopped: true });
        expectedManualLane = registry.readLane(admitted.token.laneId)!;
        manualReceiptPath = resolveManualOwnerReceiptPath('acme/widgets', canonicalWorkspace);
        writeManualOwnerReceipt(manualReceiptPath, {
          schemaVersion: 1, laneId: expectedManualLane.laneId, missionId: expectedManualLane.missionId,
          repository: 'acme/widgets', workspace: canonicalWorkspace, branch, checkpointSha,
          status: 'parked', generation: expectedManualLane.generation,
        });
        registryBytes = readFileSync(registryPath, 'utf8');
        receiptBytes = readFileSync(manualReceiptPath, 'utf8');
        const admission = registry.snapshot({ requireExisting: true });
        admissionRevision = admission.revision;
        assert.equal(admission.counts.writers, 0);
      });
      writeOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR, {
        schemaVersion: 1, updatedAt: '2026-09-21T00:00:00.000Z', supervisor: 'parked', stage: 'maintenance_hold',
        eventWakeEligible: false, maintenanceHold: { active: true, reason: 'operator hold' }, ownership: 'none', checkpoint: 'durable',
      });
      console.log = (value?: unknown) => { printed.push(String(value)); };
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'once']), 0));
      assert.match(printed.at(-1) ?? '', /"outcome": "maintenance_hold"/);
      printed.length = 0;
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '2']), 0));
      assert.match(printed.at(-1) ?? '', /"cycles": 2/);
      assert.match(printed.at(-1) ?? '', /"maintenance_hold"/);
      const first = readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR);
      assert.deepEqual({ supervisor: first?.supervisor, stage: first?.stage, ownership: first?.ownership, checkpoint: first?.checkpoint, hold: first?.maintenanceHold.active, lane: first?.manualLane }, {
        supervisor: 'parked', stage: 'maintenance_hold', ownership: 'none', checkpoint: 'durable', hold: true,
        lane: {
          repository: 'acme/widgets', worktree: canonicalWorkspace, branch, checkpointSha, clean: true, state: 'parked', recoverable: true,
          laneId: expectedManualLane!.laneId, missionId: expectedManualLane!.missionId,
          admissionRevision,
        },
      });
      // A fresh supervised process sees the identical durable held state and
      // cannot manufacture another writer or claim.
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '1']), 0));
      const second = readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR);
      const { updatedAt: _firstUpdatedAt, ...firstStable } = first!;
      const { updatedAt: _secondUpdatedAt, ...secondStable } = second!;
      assert.deepEqual(secondStable, firstStable);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBytes, 'held restart/re-entry does not mutate registry ownership or generation');
      assert.equal(readFileSync(manualReceiptPath, 'utf8'), receiptBytes,
        'held restart/re-entry preserves the exact private parked receipt');
    } finally {
      console.log = original;
      for (const [name, value] of Object.entries(previous)) {
        const key = name === 'data' ? 'TACHIKO_DATA_DIR' : name === 'lock' ? 'TACHIKO_DISPATCH_LOCK_PATH' : name === 'wake' ? 'TACHIKO_DISPATCH_WAKE_PATH' : name === 'execution' ? 'TACHIKO_EXECUTION_PROFILE_CONFIG' : name === 'admissionPath' ? 'TACHIKO_MISSION_ADMISSION_PATH' : name === 'admissionConfig' ? 'TACHIKO_MISSION_ADMISSION_CONFIG' : 'TACHIKO_MANUAL_OWNER_RECEIPTS_DIR';
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serializes maintenance transitions with admission and wakes only a meaningful release', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-maintenance-transition-'));
    const accountHome = path.join(directory, 'account-home');
    const previous = {
      data: process.env.TACHIKO_DATA_DIR,
      lock: process.env.TACHIKO_DISPATCH_LOCK_PATH,
      wake: process.env.TACHIKO_DISPATCH_WAKE_PATH,
      admissionPath: process.env.TACHIKO_MISSION_ADMISSION_PATH,
      admissionConfig: process.env.TACHIKO_MISSION_ADMISSION_CONFIG,
    };
    const printed: string[] = [];
    const original = console.log;
    try {
      const lockPath = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock');
      const wakePath = path.join(directory, 'wake');
      process.env.TACHIKO_DATA_DIR = path.join(directory, 'runs');
      process.env.TACHIKO_DISPATCH_LOCK_PATH = lockPath;
      process.env.TACHIKO_DISPATCH_WAKE_PATH = wakePath;
      const registryPath = path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'registry.json');
      process.env.TACHIKO_MISSION_ADMISSION_PATH = registryPath;
      process.env.TACHIKO_MISSION_ADMISSION_CONFIG = JSON.stringify(DEFAULT_MISSION_ADMISSION_CONFIG);
      let registryBytes = '';
      await withAccountHome(accountHome, async () => {
        mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
        writeFileSync(registryPath, `${JSON.stringify({
          schemaVersion: 1, revision: 0, config: DEFAULT_MISSION_ADMISSION_CONFIG, lanes: [], lastTransition: null,
        }, null, 2)}\n`, { mode: 0o600 });
        const registry = createHostAdmissionRegistry();
        assert.deepEqual(registry.snapshot({ requireExisting: true }), {
          schemaVersion: 1, revision: 0, counts: { captains: 0, writers: 0, highAutonomy: 0, parked: 0 },
          limits: DEFAULT_MISSION_ADMISSION_CONFIG.limits, omittedLaneCount: 0, lanesTruncated: false, lanes: [], lastTransition: null,
        }, 'the fixture establishes a real pristine initial host registry with the CLI configuration');
        registryBytes = readFileSync(registryPath, 'utf8');
      });
      writeOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR, {
        schemaVersion: 1, updatedAt: '2026-09-21T00:00:00.000Z', supervisor: 'parked', stage: 'idle',
        eventWakeEligible: true, maintenanceHold: { active: false }, ownership: 'none', checkpoint: 'durable',
      });
      console.log = (value?: unknown) => { printed.push(String(value)); };

      // A hold waits for the active reconciliation/admission interval. It
      // cannot rewrite the projection underneath that owner.
      const admission = acquireDispatchInvocationLock({ lockPath: `${lockPath}.admission`, nonce: () => 'active-reconcile' });
      const holding = withAccountHome(accountHome, () => main(['dispatch', 'maintenance', 'hold']));
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR)?.maintenanceHold.active, false);
      admission.release();
      assert.equal(await holding, 0);
      assert.equal(readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR)?.maintenanceHold.active, true);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBytes, 'maintenance hold does not mutate the pristine registry');

      printed.length = 0;
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'maintenance', 'release']), 0));
      const firstRelease = JSON.parse(printed.at(-1) ?? '{}') as { wake?: string };
      assert.match(firstRelease.wake ?? '', /^[0-9a-f-]{36}$/);
      const firstToken = readFileSync(wakePath, 'utf8');
      printed.length = 0;
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'maintenance', 'release']), 0));
      const repeatedRelease = JSON.parse(printed.at(-1) ?? '{}') as { wake?: string };
      assert.equal(repeatedRelease.wake, undefined);
      assert.equal(readFileSync(wakePath, 'utf8'), firstToken);
      assert.equal(readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR)?.maintenanceHold.active, false);
      assert.equal(readFileSync(registryPath, 'utf8'), registryBytes, 'maintenance release and repeated release preserve the pristine registry');
    } finally {
      console.log = original;
      for (const [name, value] of Object.entries(previous)) {
        const key = name === 'data' ? 'TACHIKO_DATA_DIR' : name === 'lock' ? 'TACHIKO_DISPATCH_LOCK_PATH' : name === 'wake' ? 'TACHIKO_DISPATCH_WAKE_PATH' : name === 'admissionPath' ? 'TACHIKO_MISSION_ADMISSION_PATH' : 'TACHIKO_MISSION_ADMISSION_CONFIG';
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
