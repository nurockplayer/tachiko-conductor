import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import { main } from '../src/cli.js';
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
    };
    const printed: string[] = [];
    const original = console.log;
    try {
      process.env.TACHIKO_DATA_DIR = path.join(directory, 'runs');
      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock');
      process.env.TACHIKO_DISPATCH_WAKE_PATH = path.join(directory, 'wake');
      delete process.env.TACHIKO_EXECUTION_PROFILE_CONFIG;
      writeOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR, {
        schemaVersion: 1, updatedAt: '2026-09-21T00:00:00.000Z', supervisor: 'parked', stage: 'maintenance_hold',
        eventWakeEligible: false, maintenanceHold: { active: true, reason: 'operator hold' }, ownership: 'none', checkpoint: 'durable',
        manualLane: { repository: 'repo', worktree: '/worktree', branch: 'branch', checkpointSha: 'a'.repeat(40), clean: true, state: 'parked', recoverable: true },
      });
      console.log = (value?: unknown) => { printed.push(String(value)); };
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'once']), 0));
      assert.match(printed.at(-1) ?? '', /"outcome": "maintenance_hold"/);
      printed.length = 0;
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '2']), 0));
      assert.match(printed.at(-1) ?? '', /"cycles": 2/);
      assert.match(printed.at(-1) ?? '', /"maintenance_hold"/);
      const first = readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR);
      assert.deepEqual({ supervisor: first?.supervisor, stage: first?.stage, ownership: first?.ownership, checkpoint: first?.checkpoint, hold: first?.maintenanceHold.active, lane: first?.manualLane?.checkpointSha }, {
        supervisor: 'parked', stage: 'maintenance_hold', ownership: 'none', checkpoint: 'durable', hold: true, lane: 'a'.repeat(40),
      });
      // A fresh supervised process sees the identical durable held state and
      // cannot manufacture another writer or claim.
      await withAccountHome(accountHome, async () => assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '1']), 0));
      const second = readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR);
      const { updatedAt: _firstUpdatedAt, ...firstStable } = first!;
      const { updatedAt: _secondUpdatedAt, ...secondStable } = second!;
      assert.deepEqual(secondStable, firstStable);
    } finally {
      console.log = original;
      for (const [name, value] of Object.entries(previous)) {
        const key = name === 'data' ? 'TACHIKO_DATA_DIR' : name === 'lock' ? 'TACHIKO_DISPATCH_LOCK_PATH' : name === 'wake' ? 'TACHIKO_DISPATCH_WAKE_PATH' : 'TACHIKO_EXECUTION_PROFILE_CONFIG';
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
    };
    const printed: string[] = [];
    const original = console.log;
    try {
      const lockPath = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock');
      const wakePath = path.join(directory, 'wake');
      process.env.TACHIKO_DATA_DIR = path.join(directory, 'runs');
      process.env.TACHIKO_DISPATCH_LOCK_PATH = lockPath;
      process.env.TACHIKO_DISPATCH_WAKE_PATH = wakePath;
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
    } finally {
      console.log = original;
      for (const [name, value] of Object.entries(previous)) {
        const key = name === 'data' ? 'TACHIKO_DATA_DIR' : name === 'lock' ? 'TACHIKO_DISPATCH_LOCK_PATH' : 'TACHIKO_DISPATCH_WAKE_PATH';
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
