import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('renders a configurable hourly launchd schedule without configuration values', () => {
    const plist = renderDispatchLaunchdPlist({
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      workingDirectory: '/Users/example/Developer/tachiko-conductor',
      minute: 25,
    });
    assert.match(plist, /<key>Minute<\/key><integer>25<\/integer>/);
    assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/Users\/example\/Library/);
    assert.doesNotMatch(plist, /TACHIKO_DISPATCH_CONFIG/);
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
