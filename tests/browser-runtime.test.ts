import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';

import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
  ManagedPlaywrightMcpRuntime,
  browserRuntimeCapability,
  buildPlaywrightMcpArgs,
} from '../src/browser/playwright-mcp-runtime.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-playwright-mcp.mjs', import.meta.url));
const RUNTIME_OWNER = fileURLToPath(new URL('./fixtures/browser-runtime-owner.ts', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];

async function tcpReadinessProbe(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('No TCP port assigned.'));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempRuntime(env: NodeJS.ProcessEnv = process.env): {
  runtime: ManagedPlaywrightMcpRuntime;
  root: string;
  profileRoot: string;
  runtimeRoot: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-runtime-'));
  const profileRoot = path.join(root, 'profiles');
  const runtimeRoot = path.join(root, 'runtimes');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return {
    runtime: new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      env,
      readinessProbe: tcpReadinessProbe,
    }),
    root,
    profileRoot,
    runtimeRoot,
  };
}

function assertRuntimeError(error: unknown, code: string): boolean {
  assert.ok(error instanceof BrowserRuntimeError);
  assert.equal(error.code, code);
  return true;
}

describe('ManagedPlaywrightMcpRuntime', () => {
  it('starts on loopback with an argument array, reports health, blocks duplicate profile ownership, and stops', async () => {
    const argsPath = path.join(os.tmpdir(), `tachiko-browser-args-${process.pid}-${Date.now()}.json`);
    cleanups.push(() => rmSync(argsPath, { force: true }));
    const { runtime, profileRoot, runtimeRoot } = tempRuntime({ ...process.env, FAKE_MCP_ARGS_PATH: argsPath });
    const port = await freePort();
    const handle = await runtime.start({ profile: 'github-work', port, headless: true, stopTimeoutMs: 1_234 });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });

    assert.equal(handle.snapshot.state, 'ready');
    assert.equal(handle.snapshot.health, 'ready');
    assert.equal(handle.snapshot.endpoint, `http://127.0.0.1:${port}/mcp`);
    assert.equal(handle.snapshot.profile, 'github-work');
    assert.equal(handle.snapshot.headless, true);
    assert.equal(handle.snapshot.stopTimeoutMs, 1_234);
    assert.ok(handle.snapshot.pid > 0);
    assert.deepEqual(browserRuntimeCapability(handle.snapshot), {
      kind: 'mcp-http',
      name: 'tachiko_browser',
      endpoint: `http://127.0.0.1:${port}/mcp`,
    });

    const childArgs = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(childArgs, buildPlaywrightMcpArgs({
      host: '127.0.0.1',
      port,
      profileDir: path.join(profileRoot, 'github-work'),
      outputDir: path.join(runtimeRoot, 'github-work-output'),
      headless: true,
    }));

    const status = await runtime.status('github-work');
    assert.equal(status?.health, 'ready');
    await assert.rejects(
      runtime.start({ profile: 'github-work', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );

    const stopped = await runtime.stop('github-work');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.health, 'stopped');
    assert.ok(stopped.stoppedAt);
  });

  it('rejects unsafe profiles, in-repository profile roots, and invalid ports before spawning', async () => {
    const { runtime } = tempRuntime();
    await assert.rejects(
      runtime.start({ profile: '../personal' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
    await assert.rejects(
      runtime.start({ profile: 'safe', port: 70_000 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const inside = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(REPO_ROOT, '.tachiko', 'profiles'),
      runtimeRoot: path.join(REPO_ROOT, '.tachiko', 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      inside.start({ profile: 'safe' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const symlinkRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-symlink-'));
    cleanups.push(() => rmSync(symlinkRoot, { recursive: true, force: true }));
    const linkedProfiles = path.join(symlinkRoot, 'profiles');
    symlinkSync(REPO_ROOT, linkedProfiles, 'dir');
    const symlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: linkedProfiles,
      runtimeRoot: path.join(symlinkRoot, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      symlinked.start({ profile: 'package.json' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('reports an occupied port with a typed actionable error', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const { runtime } = tempRuntime();

    await assert.rejects(
      runtime.start({ profile: 'occupied', port: address.port }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PORT_IN_USE),
    );
  });

  it('fails actionably while profile ownership is being atomically updated', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const profileDir = path.join(profileRoot, 'guarded');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, '.tachiko-runtime-lock.guard'), '{"pid":999999999}\n', { mode: 0o600 });

    await assert.rejects(
      runtime.start({ profile: 'guarded', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE);
        assert.match((error as Error).message, /remove that guard and retry/);
        return true;
      },
    );
  });

  it('requires an MCP handshake rather than treating any accepting socket as ready', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-handshake-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });

    await assert.rejects(
      runtime.start({ profile: 'not-mcp', port: await freePort(), startupTimeoutMs: 150 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );
  });

  it('reports startup timeout and an unexpected child exit deterministically', async () => {
    const timeoutRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'hang' }).runtime;
    await assert.rejects(
      timeoutRuntime.start({ profile: 'timeout', port: await freePort(), startupTimeoutMs: 100 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );

    const exitRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'exit' }).runtime;
    await assert.rejects(
      exitRuntime.start({ profile: 'exit', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
        assert.match((error as Error).message, /exit code 23/);
        return true;
      },
    );

    const lateExitRuntime = tempRuntime({ ...process.env, FAKE_MCP_MODE: 'exit-after-ready' }).runtime;
    const handle = await lateExitRuntime.start({ profile: 'late-exit', port: await freePort() });
    const failed = await handle.waitForExit();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.health, 'failed');
    assert.equal(failed.errorCode, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
    assert.equal(failed.exitCode, 24);
  });

  it('does not release profile ownership until a startup-timeout child has actually exited', async () => {
    const childPidPath = path.join(os.tmpdir(), `tachiko-browser-child-${process.pid}-${Date.now()}.pid`);
    cleanups.push(() => rmSync(childPidPath, { force: true }));
    const { runtime, profileRoot } = tempRuntime({
      ...process.env,
      FAKE_MCP_MODE: 'hang-ignore-term',
      FAKE_MCP_PID_PATH: childPidPath,
    });

    await assert.rejects(
      runtime.start({ profile: 'timeout-cleanup', port: await freePort(), startupTimeoutMs: 500, stopTimeoutMs: 150 }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.STARTUP_TIMEOUT),
    );

    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    assert.equal(processIsAlive(childPid), false);
    assert.equal(existsSync(path.join(profileRoot, 'timeout-cleanup', '.tachiko-runtime-lock.json')), false);
  });

  it('returns null for a profile with no runtime metadata and refuses to stop it', async () => {
    const { runtime } = tempRuntime();
    assert.equal(await runtime.status('missing'), null);
    await assert.rejects(
      runtime.stop('missing'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
  });

  it('rejects an unsafe persisted runtime identity before deriving sidecar paths', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(
      path.join(runtimeRoot, 'unsafe-identity.json'),
      `${JSON.stringify({
        runtimeId: '../../outside-runtime-root',
        profile: 'unsafe-identity',
        endpoint: 'http://127.0.0.1:65534/mcp',
        host: '127.0.0.1',
        port: 65534,
        pid: process.pid,
        ownerPid: process.pid,
        stopTimeoutMs: 5_000,
        headless: true,
        state: 'ready',
        health: 'ready',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(
      runtime.status('unsafe-identity'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('refuses an external PID-only stop when the recorded owner is gone', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.ok(unrelated.pid !== undefined);
    cleanups.push(() => {
      unrelated.kill('SIGKILL');
    });
    writeFileSync(
      path.join(runtimeRoot, 'reused.json'),
      `${JSON.stringify({
        runtimeId: 'stale-runtime',
        profile: 'reused',
        endpoint: 'http://127.0.0.1:65534/mcp',
        host: '127.0.0.1',
        port: 65534,
        pid: unrelated.pid,
        ownerPid: 999_999_999,
        stopTimeoutMs: 5_000,
        headless: true,
        state: 'ready',
        health: 'ready',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const status = await runtime.status('reused');
    assert.equal(status?.state, 'stopping');
    assert.equal(status?.errorCode, BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED);
    await assert.rejects(
      runtime.stop('reused'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  });

  it('cleans up the owned browser child and profile lock after the foreground owner is killed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-owner-death-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const snapshotPath = path.join(root, 'owner-snapshot.json');
    const childPidPath = path.join(root, 'mcp-child.pid');
    const port = await freePort();
    const owner = spawn(
      process.execPath,
      ['--import', 'tsx', RUNTIME_OWNER, profileRoot, runtimeRoot, REPO_ROOT, FAKE_MCP, 'orphan-safe', String(port), snapshotPath],
      { stdio: 'ignore', env: { ...process.env, FAKE_MCP_PID_PATH: childPidPath } },
    );
    cleanups.push(() => {
      owner.kill('SIGKILL');
    });
    await waitUntil(() => existsSync(snapshotPath) && existsSync(childPidPath));
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as { pid: number };
    const mcpPid = Number(readFileSync(childPidPath, 'utf8').trim());
    cleanups.push(() => {
      try { process.kill(snapshot.pid, 'SIGKILL'); } catch {}
      try { process.kill(mcpPid, 'SIGKILL'); } catch {}
    });

    owner.kill('SIGKILL');
    await new Promise<void>((resolve) => owner.once('exit', () => resolve()));
    const observer = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: tcpReadinessProbe,
    });
    let terminal = await observer.status('orphan-safe');
    const deadline = Date.now() + 5_000;
    while (terminal?.state !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      terminal = await observer.status('orphan-safe');
    }

    assert.equal(terminal?.state, 'failed');
    assert.equal(terminal?.errorCode, BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED);
    assert.equal(processIsAlive(snapshot.pid), false);
    assert.equal(processIsAlive(mcpPid), false);

    const restarted = await observer.start({ profile: 'orphan-safe', port: await freePort() });
    await restarted.stop();
    assert.equal(existsSync(path.join(profileRoot, 'orphan-safe', '.tachiko-runtime-lock.json')), false);
  });

  it('never overwrites a newer runtime identity while an older external stop completes', async () => {
    const { runtime, runtimeRoot } = tempRuntime();
    mkdirSync(runtimeRoot, { recursive: true });
    const oldChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    assert.ok(oldChild.pid !== undefined);
    cleanups.push(() => {
      oldChild.kill('SIGKILL');
    });
    const oldSnapshot = {
      runtimeId: 'old-runtime',
      profile: 'restart-race',
      endpoint: 'http://127.0.0.1:65533/mcp',
      host: '127.0.0.1',
      port: 65533,
      pid: oldChild.pid,
      ownerPid: process.pid,
      stopTimeoutMs: 5_000,
      headless: true,
      state: 'ready',
      health: 'ready',
      startedAt: '2026-08-29T00:00:00.000Z',
    } as const;
    const metadataPath = path.join(runtimeRoot, 'restart-race.json');
    writeFileSync(metadataPath, `${JSON.stringify(oldSnapshot)}\n`, { mode: 0o600 });

    const stopping = runtime.stop('restart-race');
    const stopRequestPath = path.join(runtimeRoot, 'restart-race.old-runtime.stop.json');
    await waitUntil(() => existsSync(stopRequestPath));
    oldChild.kill('SIGTERM');
    await new Promise<void>((resolve) => oldChild.once('exit', () => resolve()));
    const replacement = {
      ...oldSnapshot,
      runtimeId: 'new-runtime',
      pid: process.pid,
      state: 'ready',
      health: 'ready',
      startedAt: '2026-08-29T00:01:00.000Z',
    } as const;
    writeFileSync(metadataPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    const stopped = await stopping;
    assert.equal(stopped.runtimeId, 'old-runtime');
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf8')) as { runtimeId: string };
    assert.equal(persisted.runtimeId, 'new-runtime');
  });

  it('does not let an awaited status probe overwrite an unexpected child exit', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-status-race-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    let releaseStatusProbe: ((ready: boolean) => void) | undefined;
    let announceStatusProbe: (() => void) | undefined;
    const statusProbeStarted = new Promise<void>((resolve) => {
      announceStatusProbe = resolve;
    });
    let probeCount = 0;
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => {
        probeCount += 1;
        if (probeCount === 1) return true;
        announceStatusProbe?.();
        return await new Promise<boolean>((resolve) => {
          releaseStatusProbe = resolve;
        });
      },
    });
    const handle = await runtime.start({ profile: 'status-race', port: await freePort() });
    const pendingStatus = runtime.status('status-race');
    await statusProbeStarted;
    process.kill(handle.snapshot.pid, 'SIGTERM');
    const exited = await handle.waitForExit();
    assert.equal(exited.state, 'failed');
    releaseStatusProbe?.(true);

    const status = await pendingStatus;
    assert.equal(status?.state, 'failed');
    assert.equal(status?.errorCode, BROWSER_RUNTIME_ERROR_CODE.CHILD_EXITED);
  });

  it('finalizes under the ownership guard without overwriting replacement metadata', async () => {
    const { runtime, runtimeRoot, profileRoot } = tempRuntime();
    const handle = await runtime.start({ profile: 'completion-identity', port: await freePort() });
    const replacement = {
      ...handle.snapshot,
      runtimeId: 'replacement-runtime',
      pid: process.pid,
      ownerPid: process.pid,
      endpoint: 'http://127.0.0.1:65532/mcp',
      port: 65532,
      startedAt: '2026-08-29T01:00:00.000Z',
    } as const;
    const metadataPath = path.join(runtimeRoot, 'completion-identity.json');
    const profileDir = path.join(profileRoot, 'completion-identity');
    const lockPath = path.join(profileDir, '.tachiko-runtime-lock.json');
    const guardPath = path.join(profileDir, '.tachiko-runtime-lock.guard');
    writeFileSync(guardPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    process.kill(handle.snapshot.pid, 'SIGTERM');
    await waitUntil(() => !processIsAlive(handle.snapshot.pid));
    writeFileSync(lockPath, `${JSON.stringify({ version: 1, runtimeId: replacement.runtimeId, pid: process.pid })}\n`, { mode: 0o600 });
    writeFileSync(metadataPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
    rmSync(guardPath, { force: true });

    const oldFinal = await handle.waitForExit();
    assert.equal(oldFinal.runtimeId, handle.snapshot.runtimeId);
    assert.equal(oldFinal.state, 'failed');
    const persisted = JSON.parse(readFileSync(metadataPath, 'utf8')) as { runtimeId: string };
    assert.equal(persisted.runtimeId, replacement.runtimeId);
    const persistedLock = JSON.parse(readFileSync(lockPath, 'utf8')) as { runtimeId: string };
    assert.equal(persistedLock.runtimeId, replacement.runtimeId);
  });

  it('does not let a stale handle stop a replacement runtime for the same profile', async () => {
    const { runtime } = tempRuntime();
    const oldHandle = await runtime.start({ profile: 'stale-handle', port: await freePort() });
    process.kill(oldHandle.snapshot.pid, 'SIGTERM');
    await oldHandle.waitForExit();

    const replacement = await runtime.start({ profile: 'stale-handle', port: await freePort() });
    cleanups.push(async () => {
      await replacement.stop().catch(() => undefined);
    });
    const oldResult = await oldHandle.stop();

    assert.equal(oldResult.runtimeId, oldHandle.snapshot.runtimeId);
    const replacementStatus = await runtime.status('stale-handle');
    assert.equal(replacementStatus?.runtimeId, replacement.snapshot.runtimeId);
    assert.equal(replacementStatus?.state, 'ready');
    await replacement.stop();
  });
});
