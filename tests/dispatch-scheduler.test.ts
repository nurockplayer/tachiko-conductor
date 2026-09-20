import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { main } from '../src/cli.js';

describe('dispatch scheduler boundary', () => {
  it('keeps overlapping same-host invocations out and safely recovers a provably stale lock', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-'));
    const lockPath = path.join(directory, 'once.lock');
    try {
      const first = acquireDispatchInvocationLock({ lockPath, nonce: () => 'first' });
      assert.throws(() => acquireDispatchInvocationLock({ lockPath, nonce: () => 'second' }), DispatchInvocationLockedError);
      first.release();
      writeFileSync(lockPath, JSON.stringify({ nonce: 'crashed', pid: 41 }));
      const recovered = acquireDispatchInvocationLock({ lockPath, nonce: () => 'recovered', isProcessAlive: () => false });
      recovered.release();
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
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), { nonce: 'replacement', pid: process.pid });
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
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), {
        nonce: 'recovered-after-abandoned-claim',
        pid: process.pid,
      });
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
      assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), {
        nonce: 'recovered-after-legacy-hard-link',
        pid: process.pid,
      });
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

  it('renders a provider-neutral launchd supervisor without configuration values', () => {
    const plist = renderDispatchLaunchdPlist({
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      workingDirectory: '/Users/example/Developer/tachiko-conductor',
    });
    assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/Users\/example\/Library/);
    assert.doesNotMatch(plist, /TACHIKO_DISPATCH_CONFIG/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.doesNotMatch(plist, /StartCalendarInterval/);
  });

  it('renders the same supervisor across reinstall without creating a timer wake', () => {
    const options = {
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
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

  it('leaves a concurrent dispatch at a safe re-entry boundary without reading configuration or GitHub', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-main-lock-'));
    const lockPath = path.join(directory, 'once.lock');
    const previous = process.env.TACHIKO_DISPATCH_LOCK_PATH;
    const printed: string[] = [];
    const original = console.log;
    try {
      const lock = acquireDispatchInvocationLock({ lockPath, nonce: () => 'first' });
      process.env.TACHIKO_DISPATCH_LOCK_PATH = lockPath;
      console.log = (value?: unknown) => { printed.push(String(value)); };
      assert.equal(await main(['dispatch', 'once']), 0);
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
});
