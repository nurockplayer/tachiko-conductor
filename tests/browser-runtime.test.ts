import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const cleanups: Array<() => Promise<void> | void> = [];

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
    const handle = await runtime.start({ profile: 'github-work', port, headless: true });
    cleanups.push(async () => {
      await handle.stop().catch(() => undefined);
    });

    assert.equal(handle.snapshot.state, 'ready');
    assert.equal(handle.snapshot.health, 'ready');
    assert.equal(handle.snapshot.endpoint, `http://127.0.0.1:${port}/mcp`);
    assert.equal(handle.snapshot.profile, 'github-work');
    assert.equal(handle.snapshot.headless, true);
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
    writeFileSync(path.join(profileDir, '.tachiko-runtime-lock.guard'), '{}\n', { mode: 0o600 });

    await assert.rejects(
      runtime.start({ profile: 'guarded', port: await freePort() }),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE),
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

  it('returns null for a profile with no runtime metadata and refuses to stop it', async () => {
    const { runtime } = tempRuntime();
    assert.equal(await runtime.status('missing'), null);
    await assert.rejects(
      runtime.stop('missing'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
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
        headless: true,
        state: 'ready',
        health: 'ready',
        startedAt: '2026-08-29T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );

    const status = await runtime.status('reused');
    assert.equal(status?.state, 'failed');
    assert.equal(status?.errorCode, BROWSER_RUNTIME_ERROR_CODE.OWNER_EXITED);
    await assert.rejects(
      runtime.stop('reused'),
      (error) => assertRuntimeError(error, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING),
    );
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
  });
});
