import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  normalizeBrowserHost,
  parseRuntimeProcessIdentity,
  type BrowserRuntimeHandle,
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
  it('distinguishes unavailable, unrelated, and matching process command lines', () => {
    assert.equal(parseRuntimeProcessIdentity(' \r\n\t'), undefined);
    assert.equal(parseRuntimeProcessIdentity('node unrelated-worker.js'), null);
    assert.equal(
      parseRuntimeProcessIdentity('node --title=tachiko-browser-runtime-runtime-123 cli.js'),
      'tachiko-browser-runtime-runtime-123',
    );
  });

  it('normalizes bracketed IPv6 hosts before binding while preserving URL-safe formatting', () => {
    assert.equal(normalizeBrowserHost('[::1]'), '::1');
    assert.equal(normalizeBrowserHost('::1'), '::1');
    assert.equal(normalizeBrowserHost('127.0.0.1'), '127.0.0.1');
    assert.throws(
      () => normalizeBrowserHost('[localhost]'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

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

    const prospectiveRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-prospective-symlink-'));
    cleanups.push(() => rmSync(prospectiveRoot, { recursive: true, force: true }));
    const prospectiveRepository = path.join(prospectiveRoot, 'repository');
    const external = path.join(prospectiveRoot, 'external');
    mkdirSync(prospectiveRepository, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(prospectiveRepository, path.join(external, 'repository-alias'), 'dir');
    const notYetCreated = path.join(prospectiveRepository, 'must-not-be-created');
    const prospectiveSymlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(external, 'repository-alias', 'must-not-be-created'),
      runtimeRoot: path.join(prospectiveRoot, 'runtimes'),
      repositoryRoot: prospectiveRepository,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      prospectiveSymlinked.start({ profile: 'safe', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
    assert.equal(existsSync(notYetCreated), false, 'invalid storage must be rejected before it is created');

    const statusSymlinkRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-status-symlink-'));
    cleanups.push(() => rmSync(statusSymlinkRoot, { recursive: true, force: true }));
    const linkedRuntimes = path.join(statusSymlinkRoot, 'runtimes');
    symlinkSync(REPO_ROOT, linkedRuntimes, 'dir');
    const statusSymlinked = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(statusSymlinkRoot, 'profiles'),
      runtimeRoot: linkedRuntimes,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      statusSymlinked.status('safe'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const dedicatedRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-dedicated-profile-'));
    const unrelatedProfile = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-unrelated-profile-'));
    cleanups.push(() => rmSync(dedicatedRoot, { recursive: true, force: true }));
    cleanups.push(() => rmSync(unrelatedProfile, { recursive: true, force: true }));
    const dedicatedProfileRoot = path.join(dedicatedRoot, 'profiles');
    mkdirSync(dedicatedProfileRoot, { recursive: true });
    symlinkSync(unrelatedProfile, path.join(dedicatedProfileRoot, 'personal'), 'dir');
    const escapedProfile = new ManagedPlaywrightMcpRuntime({
      profileRoot: dedicatedProfileRoot,
      runtimeRoot: path.join(dedicatedRoot, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      escapedProfile.start({ profile: 'personal', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );

    const outputEscapeRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-output-escape-'));
    const unrelatedOutput = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-unrelated-output-'));
    cleanups.push(() => rmSync(outputEscapeRoot, { recursive: true, force: true }));
    cleanups.push(() => rmSync(unrelatedOutput, { recursive: true, force: true }));
    const outputRuntimeRoot = path.join(outputEscapeRoot, 'runtimes');
    mkdirSync(outputRuntimeRoot, { recursive: true });
    symlinkSync(unrelatedOutput, path.join(outputRuntimeRoot, 'escaped-output'), 'dir');
    const escapedOutput = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(outputEscapeRoot, 'profiles'),
      runtimeRoot: outputRuntimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      escapedOutput.start({ profile: 'escaped', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('rejects equal, nested, and canonically overlapping browser storage roots', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-overlapping-roots-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const shared = path.join(root, 'shared');
    const nested = path.join(shared, 'runtimes');
    const linked = path.join(root, 'linked');

    for (const [profileRoot, runtimeRoot] of [
      [shared, shared],
      [shared, nested],
    ] as const) {
      const runtime = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
      });
      await assert.rejects(
        runtime.start({ profile: 'overlap', port: await freePort() }),
        (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
      );
    }

    mkdirSync(shared, { recursive: true, mode: 0o700 });
    symlinkSync(shared, linked, 'dir');
    const aliased = new ManagedPlaywrightMcpRuntime({
      profileRoot: shared,
      runtimeRoot: linked,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });
    await assert.rejects(
      aliased.start({ profile: 'alias', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG),
    );
  });

  it('reclaims a stale lock when a live PID has a different process identity', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-pid-reuse-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const profileDir = path.join(profileRoot, 'pid-reuse');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(profileDir, '.tachiko-runtime-lock.json'),
      `${JSON.stringify({ version: 1, runtimeId: 'old-runtime', pid: process.pid, processIdentity: 'old-process' })}\n`,
      { mode: 0o600 },
    );
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: tcpReadinessProbe,
    });

    const handle = await runtime.start({ profile: 'pid-reuse', port: await freePort() });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });
    assert.equal(handle.snapshot.state, 'ready');
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    await handle.stop();
  });

  it('keeps a live-PID lock when process identity inspection is unavailable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-identity-unreadable-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const profileDir = path.join(profileRoot, 'unreadable');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(profileDir, '.tachiko-runtime-lock.json'),
      `${JSON.stringify({ version: 1, runtimeId: 'existing-runtime', pid: process.pid, processIdentity: 'tachiko-browser-runtime-existing-runtime' })}\n`,
      { mode: 0o600 },
    );
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      processIdentityReader: () => undefined,
    });

    await assert.rejects(
      runtime.start({ profile: 'unreadable', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );
  });

  it('stops the exact child and releases ownership when startup publication fails', async () => {
    for (const phase of ['lock', 'starting', 'ready'] as const) {
      const root = mkdtempSync(path.join(os.tmpdir(), `tachiko-browser-publish-${phase}-`));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const profileRoot = path.join(root, 'profiles');
      const runtimeRoot = path.join(root, 'runtimes');
      const pidPath = path.join(root, 'child.pid');
      const profile = `publish-${phase}`;
      const port = await freePort();
      const jsonWriter = (file: string, value: unknown): void => {
        const state = (value as { state?: unknown }).state;
        const isFailurePoint =
          (phase === 'lock' && file.endsWith('.tachiko-runtime-lock.json')) ||
          phase === state;
        if (isFailurePoint) throw new Error(`injected ${phase} publication failure`);
        writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      };
      const runtime = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
        readinessProbe: tcpReadinessProbe,
        env: { ...process.env, FAKE_MCP_PID_PATH: pidPath },
        jsonWriter,
      });

      await assert.rejects(
        runtime.start({ profile, port, stopTimeoutMs: 250 }),
        (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.SPAWN_FAILED),
      );
      const profileDir = path.join(profileRoot, profile);
      assert.equal(existsSync(path.join(profileDir, '.tachiko-runtime-lock.json')), false);
      assert.equal(existsSync(path.join(profileDir, '.tachiko-runtime-lock.guard')), false);
      if (existsSync(pidPath)) {
        const childPid = Number(readFileSync(pidPath, 'utf8').trim());
        await waitUntil(() => !processIsAlive(childPid));
      }

      const retry = new ManagedPlaywrightMcpRuntime({
        profileRoot,
        runtimeRoot,
        repositoryRoot: REPO_ROOT,
        playwrightCliPath: FAKE_MCP,
        readinessProbe: tcpReadinessProbe,
      });
      const handle = await retry.start({ profile, port });
      await handle.stop();
    }
  });

  it('rejects existing browser storage directories that expose data to other local users', async (context) => {
    if (process.platform === 'win32') {
      context.skip('POSIX mode-bit coverage');
      return;
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-permissions-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    mkdirSync(profileRoot, { mode: 0o755 });
    mkdirSync(runtimeRoot, { mode: 0o700 });
    chmodSync(profileRoot, 0o755);
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
    });

    await assert.rejects(
      runtime.start({ profile: 'private-only', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG);
        assert.match((error as Error).message, /permissions to 0700/);
        return true;
      },
    );
    assert.equal(existsSync(path.join(profileRoot, 'private-only')), false);
  });

  it('fails closed when a Windows storage ACL cannot be verified as private', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-windows-acl-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const inspected: string[] = [];
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      platform: 'win32',
      windowsAclInspector: (directory) => {
        inspected.push(directory);
        return false;
      },
    });

    await assert.rejects(
      runtime.start({ profile: 'acl-check', port: await freePort() }),
      (error) => {
        assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG);
        assert.match((error as Error).message, /trusted Windows system principals/);
        return true;
      },
    );
    assert.equal(inspected.length, 1);
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

  it('reports automatic-port host binding failures as typed runtime errors', async () => {
    const { runtime } = tempRuntime();
    await assert.rejects(
      runtime.start({ profile: 'invalid-auto-host', host: 'does-not-exist.invalid' }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PORT_IN_USE),
    );
  });

  it('fails actionably while profile ownership is being atomically updated', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const profileDir = path.join(profileRoot, 'guarded');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
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

  it('honors an identity-scoped external stop request while readiness is still pending', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-starting-stop-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => await new Promise<boolean>(() => undefined),
    });
    const starting = runtime.start({
      profile: 'stop-while-starting',
      port: await freePort(),
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
    });
    const startRejected = assert.rejects(
      starting,
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    await waitUntil(() => existsSync(path.join(runtimeRoot, 'stop-while-starting.json')));

    const stopped = await runtime.stop('stop-while-starting');
    assert.equal(stopped.state, 'stopped');
    await startRejected;
  });

  it('cancels the exact startup attempt through its AbortSignal', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-starting-abort-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const profileRoot = path.join(root, 'profiles');
    const runtimeRoot = path.join(root, 'runtimes');
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot,
      runtimeRoot,
      repositoryRoot: REPO_ROOT,
      playwrightCliPath: FAKE_MCP,
      readinessProbe: async () => await new Promise<boolean>(() => undefined),
    });
    const controller = new AbortController();
    const starting = runtime.start({
      profile: 'abort-while-starting',
      port: await freePort(),
      startupTimeoutMs: 5_000,
      stopTimeoutMs: 500,
      signal: controller.signal,
    });
    const startRejected = assert.rejects(
      starting,
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    await waitUntil(() => existsSync(path.join(runtimeRoot, 'abort-while-starting.json')));

    controller.abort();
    await startRejected;
    assert.equal(existsSync(path.join(profileRoot, 'abort-while-starting', '.tachiko-runtime-lock.json')), false);
    assert.equal((await runtime.status('abort-while-starting'))?.state, 'stopped');
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
    const stopRequestPath = path.join(runtimeRoot, '.tachiko-stop-requests', 'restart-race.old-runtime.json');
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

  it('isolates stop requests from valid profile metadata names', async () => {
    const { runtime } = tempRuntime();
    const first = await runtime.start({ profile: 'work', port: await freePort() });
    let second: BrowserRuntimeHandle | undefined;
    try {
      const collidingProfile = `work.${first.snapshot.runtimeId}.stop`;
      second = await runtime.start({ profile: collidingProfile, port: await freePort() });
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal((await runtime.status('work'))?.health, 'ready');
      assert.equal((await runtime.status(collidingProfile))?.health, 'ready');
    } finally {
      await second?.stop().catch(() => undefined);
      await first.stop().catch(() => undefined);
    }
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

  it('fails promptly and remains retryable when the ownership guard blocks an owned stop', async () => {
    const { runtime, profileRoot } = tempRuntime();
    const handle = await runtime.start({ profile: 'guarded-stop', port: await freePort() });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });
    const guardPath = path.join(profileRoot, 'guarded-stop', '.tachiko-runtime-lock.guard');
    writeFileSync(guardPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });

    await assert.rejects(
      handle.stop(),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
    );
    assert.equal(processIsAlive(handle.snapshot.pid), true);

    rmSync(guardPath, { force: true });
    const stopped = await handle.stop();
    assert.equal(stopped.state, 'stopped');
  });
});
