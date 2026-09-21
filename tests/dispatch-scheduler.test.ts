import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from '../src/dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from '../src/dispatch/launchd.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import { main } from '../src/cli.js';
import { readOperationalRuntimeProjection, writeOperationalRuntimeProjection } from '../src/operational/runtime-projection.js';

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

  it('persists the revisioned #104 policy and owner-controlled Luna home across restarts', () => {
    const plist = renderDispatchLaunchdPlist({
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      nodeProgram: '/Users/example/.local/node/bin/node',
      lunaCodexHome: '/Users/example/.tachiko/luna-codex-home',
      playwrightBrowsersPath: '/Users/example/.tachiko/playwright-browsers',
      workingDirectory: '/Users/example/Developer/tachiko-conductor',
    });
    assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/Users\/example\/Library/);
    assert.doesNotMatch(plist, /TACHIKO_DISPATCH_CONFIG/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /<key>TACHIKO_NODE_PROGRAM<\/key><string>\/Users\/example\/\.local\/node\/bin\/node<\/string>/);
    assert.match(plist, /<key>TACHIKO_LUNA_CODEX_HOME<\/key><string>\/Users\/example\/\.tachiko\/luna-codex-home<\/string>/);
    assert.match(plist, /<key>TACHIKO_PLAYWRIGHT_BROWSERS_PATH<\/key><string>\/Users\/example\/\.tachiko\/playwright-browsers<\/string>/);
    assert.match(plist, /<key>TACHIKO_EXECUTION_PROFILE_CONFIG<\/key>/);
    assert.match(plist, /<key>TACHIKO_LOCAL_VALIDATION_CONFIG<\/key>/);
    assert.match(plist, /<key>TACHIKO_HOSTED_CHECK_POLICY_CONFIG<\/key><string>{&quot;revision&quot;:&quot;issue-104-production-v2&quot;,&quot;mode&quot;:&quot;not_required&quot;}<\/string>/);
    assert.doesNotMatch(plist, /StartCalendarInterval/);
  });

  it('renders the same supervisor across reinstall without creating a timer wake', () => {
    const options = {
      program: '/Users/example/Library/Application Support/tachiko-dispatch/run.sh',
      nodeProgram: '/Users/example/.local/node/bin/node',
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
    assert.doesNotMatch(wrapper, /exec corepack/);
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

  it('keeps serve parked across held restart/re-entry without configuration, queue, worker, or model admission', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-held-serve-'));
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
      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(directory, 'dispatch.lock');
      process.env.TACHIKO_DISPATCH_WAKE_PATH = path.join(directory, 'wake');
      delete process.env.TACHIKO_EXECUTION_PROFILE_CONFIG;
      writeOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR, {
        schemaVersion: 1, updatedAt: '2026-09-21T00:00:00.000Z', supervisor: 'parked', stage: 'maintenance_hold',
        eventWakeEligible: false, maintenanceHold: { active: true, reason: 'operator hold' }, ownership: 'none', checkpoint: 'durable',
        manualLane: { repository: 'repo', worktree: '/worktree', branch: 'branch', checkpointSha: 'a'.repeat(40), clean: true, state: 'parked', recoverable: true },
      });
      console.log = (value?: unknown) => { printed.push(String(value)); };
      assert.equal(await main(['dispatch', 'once']), 0);
      assert.match(printed.at(-1) ?? '', /"outcome": "maintenance_hold"/);
      printed.length = 0;
      assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '2']), 0);
      assert.match(printed.at(-1) ?? '', /"cycles": 2/);
      assert.match(printed.at(-1) ?? '', /"maintenance_hold"/);
      const first = readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR);
      assert.deepEqual({ supervisor: first?.supervisor, stage: first?.stage, ownership: first?.ownership, checkpoint: first?.checkpoint, hold: first?.maintenanceHold.active, lane: first?.manualLane?.checkpointSha }, {
        supervisor: 'parked', stage: 'maintenance_hold', ownership: 'none', checkpoint: 'durable', hold: true, lane: 'a'.repeat(40),
      });
      // A fresh supervised process sees the identical durable held state and
      // cannot manufacture another writer or claim.
      assert.equal(await main(['dispatch', 'serve', '--idle-poll-ms', '1', '--max-cycles', '1']), 0);
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
    const previous = {
      data: process.env.TACHIKO_DATA_DIR,
      lock: process.env.TACHIKO_DISPATCH_LOCK_PATH,
      wake: process.env.TACHIKO_DISPATCH_WAKE_PATH,
    };
    const printed: string[] = [];
    const original = console.log;
    try {
      const lockPath = path.join(directory, 'dispatch.lock');
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
      const holding = main(['dispatch', 'maintenance', 'hold']);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      assert.equal(readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR)?.maintenanceHold.active, false);
      admission.release();
      assert.equal(await holding, 0);
      assert.equal(readOperationalRuntimeProjection(process.env.TACHIKO_DATA_DIR)?.maintenanceHold.active, true);

      printed.length = 0;
      assert.equal(await main(['dispatch', 'maintenance', 'release']), 0);
      const firstRelease = JSON.parse(printed.at(-1) ?? '{}') as { wake?: string };
      assert.match(firstRelease.wake ?? '', /^[0-9a-f-]{36}$/);
      const firstToken = readFileSync(wakePath, 'utf8');
      printed.length = 0;
      assert.equal(await main(['dispatch', 'maintenance', 'release']), 0);
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
