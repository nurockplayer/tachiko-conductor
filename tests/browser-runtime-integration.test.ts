import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
  ManagedPlaywrightMcpRuntime,
  type BrowserRuntimeHandle,
} from '../src/browser/playwright-mcp-runtime.js';
import { openBrowserForBootstrap } from '../src/browser/mcp-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pinnedShutdownContract(): { pinnedVersion: boolean; watchdogFound: boolean; stdinClose: boolean; sigterm: boolean; awaitedGracefulClose: boolean } {
  // Inspect only the selected installed library, never browser/profile data.
  const absent = { pinnedVersion: false, watchdogFound: false, stdinClose: false, sigterm: false, awaitedGracefulClose: false };
  try {
    const require = createRequire(import.meta.url);
    const mcp = createRequire(require.resolve('@playwright/mcp/package.json'));
    const version = JSON.parse(readFileSync(mcp.resolve('playwright-core/package.json'), 'utf8')).version;
    const bundle = mcp.resolve('playwright-core/lib/coreBundle');
    if (statSync(bundle).size > 32 * 1024 * 1024) return absent;
    const source = readFileSync(bundle, 'utf8');
    const at = source.indexOf('function setupExitWatchdog(');
    const watchdog = at < 0 ? '' : source.slice(at, at + 4_000);
    return { pinnedVersion: version === '1.63.0-alpha-2026-08-05', watchdogFound: at >= 0,
      stdinClose: /process\.stdin\.on\(["']close["']/.test(watchdog),
      sigterm: /process\.on\(["']SIGTERM["']/.test(watchdog),
      awaitedGracefulClose: /await gracefullyCloseAll\(/.test(watchdog) };
  } catch { return absent; }
}


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

function reportIntegrationPhase(startedAt: number, phase: string, state: 'start' | 'done'): void {
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(`[browser-runtime-integration] ${new Date().toISOString()} +${elapsedMs}ms ${phase} ${state}`);
}

async function withClient<T>(endpoint: string, action: (client: Client) => Promise<T>, diagnostic?: { readonly startedAt: number; readonly label: string }): Promise<T> {
  const client = new Client({ name: 'tachiko-browser-integration-test', version: '0.1.0' });
  const phase = (name: string, state: 'start' | 'done') => {
    if (diagnostic !== undefined) reportIntegrationPhase(diagnostic.startedAt, `${diagnostic.label}.${name}`, state);
  };
  try {
    phase('connect', 'start');
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    phase('connect', 'done');
    phase('tool-action', 'start');
    const result = await action(client);
    phase('tool-action', 'done');
    return result;
  } finally {
    phase('close', 'start');
    await client.close().catch(() => undefined);
    phase('close', 'done');
  }
}

function contentText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (item: unknown): item is { type: 'text'; text: string } =>
        typeof item === 'object' &&
        item !== null &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n');
}

describe('managed Playwright MCP integration', () => {
  it('keeps the bootstrap browser context alive across transient client disconnects', { timeout: 60_000 }, async () => {
    const diagnosticStartedAt = performance.now();
    const phase = (name: string, state: 'start' | 'done') => reportIntegrationPhase(diagnosticStartedAt, name, state);
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-bootstrap-integration-'));
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
      env: { ...process.env, PLAYWRIGHT_MCP_PING_TIMEOUT_MS: '100' },
    });
    let handle: BrowserRuntimeHandle | undefined;
    let bootstrapLease: { close(): Promise<void> } | undefined;
    try {
      phase('freePort', 'start');
      const port = await freePort();
      phase('freePort', 'done');
      phase('runtime.start', 'start');
      handle = await runtime.start({ profile: 'bootstrap', port, headless: true });
      phase('runtime.start', 'done');
      phase('openBrowserForBootstrap', 'start');
      bootstrapLease = await openBrowserForBootstrap(handle.snapshot.endpoint);
      phase('openBrowserForBootstrap', 'done');

      await withClient(handle.snapshot.endpoint, async (client) => {
        phase('first-client.callTool', 'start');
        const written = await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: "() => { globalThis.__tachikoBootstrapSentinel = 'still-open'; return globalThis.__tachikoBootstrapSentinel; }",
          },
        });
        phase('first-client.callTool', 'done');
        phase('first-client.assertions', 'start');
        assert.notEqual(written.isError, true);
        assert.match(contentText(written), /still-open/);
        phase('first-client.assertions', 'done');
      }, { startedAt: diagnosticStartedAt, label: 'first-client' });

      phase('disconnect-wait-4500ms', 'start');
      await new Promise<void>((resolve) => setTimeout(resolve, 4_500));
      phase('disconnect-wait-4500ms', 'done');

      await withClient(handle.snapshot.endpoint, async (client) => {
        phase('second-client.callTool', 'start');
        const read = await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => globalThis.__tachikoBootstrapSentinel' },
        });
        phase('second-client.callTool', 'done');
        phase('second-client.assertions', 'start');
        assert.notEqual(read.isError, true);
        assert.match(contentText(read), /still-open/);
        phase('second-client.assertions', 'done');
      }, { startedAt: diagnosticStartedAt, label: 'second-client' });
    } finally {
      phase('bootstrapLease.close', 'start');
      await bootstrapLease?.close().catch(() => undefined);
      phase('bootstrapLease.close', 'done');
      phase('runtime.handle.stop', 'start');
      await handle?.stop().catch(() => undefined);
      phase('runtime.handle.stop', 'done');
      phase('temporary-root.cleanup', 'start');
      rmSync(root, { recursive: true, force: true });
      phase('temporary-root.cleanup', 'done');
    }
  });

  it('uses a local fixture and reuses persistent profile state after a clean restart', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-integration-'));
    const fixture = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Tachiko fixture</title><main>local fixture sentinel</main>');
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const fixtureAddress = fixture.address();
    assert.ok(fixtureAddress !== null && typeof fixtureAddress !== 'string');
    const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
    });
    let first: BrowserRuntimeHandle | undefined;
    let second: BrowserRuntimeHandle | undefined;
    const contract = pinnedShutdownContract();
    const lifecycle: { profileDir: string | null; signals: string[]; stdinEnded: boolean; exited: boolean; exitCode: number | null; exitSignal: string | null }[] = [];
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const argv = Array.isArray(args[1]) ? args[1] : [];
      const child = originalSpawn(...args);
      if (typeof argv[0] === 'string' && argv[0].startsWith('--title=tachiko-browser-runtime-')) {
        const profileIndex = argv.indexOf('--user-data-dir');
        const record = { profileDir: typeof argv[profileIndex + 1] === 'string' ? argv[profileIndex + 1] as string : null,
          signals: [] as string[], stdinEnded: false, exited: false, exitCode: null as number | null, exitSignal: null as string | null };
        lifecycle.push(record);
        const kill = child.kill.bind(child);
        child.kill = signal => { if (signal === 'SIGTERM' || signal === 'SIGKILL') record.signals.push(signal); return kill(signal); };
        child.stdin?.once('finish', () => { record.stdinEnded = true; });
        child.once('exit', (code, signal) => { record.exited = true; record.exitCode = code; record.exitSignal = signal; });
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    let firstWriteSentinel = false;
    let firstOriginMatches = false;
    let secondOriginMatches = false;
    let secondReadSentinel = false;
    let stopped: Awaited<ReturnType<BrowserRuntimeHandle['stop']>> | undefined;
    const report = (phase: 'first-written' | 'first-stopped' | 'second-read' | 'cleanup') => {
      const owned = lifecycle[0];
      process.stderr.write('STAGE10_BROWSER_PERSISTENCE ' + JSON.stringify({
        phase, contract, firstWriteSentinel, firstOriginMatches, secondOriginMatches, secondReadSentinel,
        firstProfileMatches: owned?.profileDir === path.join(root, 'profiles', 'persistent'),
        sameProfile: lifecycle.length >= 2 ? owned?.profileDir !== null && owned?.profileDir === lifecycle[1]!.profileDir : null,
        freshRuntime: first !== undefined && second !== undefined ? first.snapshot.runtimeId !== second.snapshot.runtimeId : null,
        stopState: stopped?.state ?? 'not_observed', stopHealth: stopped?.health ?? 'not_observed',
        stopExitCode: stopped?.exitCode ?? null, stopExitSignal: stopped?.exitSignal ?? null,
        wrapperExitObserved: owned?.exited ?? false, wrapperExitCode: owned?.exitCode ?? null, wrapperExitSignal: owned?.exitSignal ?? null,
        sigtermRequested: owned?.signals.includes('SIGTERM') ?? false, sigkillRequested: owned?.signals.includes('SIGKILL') ?? false,
        stdinEnded: owned?.stdinEnded ?? false, browserContextClose: 'not_observed',
      }) + '\n');
    };
    try {
      first = await runtime.start({ profile: 'persistent', port: await freePort(), headless: true });
      assert.equal(first.snapshot.host, '127.0.0.1');
      await assert.rejects(
        runtime.start({ profile: 'persistent', port: await freePort(), headless: true }),
        (error) => {
          assert.ok(error instanceof BrowserRuntimeError);
          assert.equal(error.code, BROWSER_RUNTIME_ERROR_CODE.PROFILE_IN_USE);
          return true;
        },
      );

      await withClient(first.snapshot.endpoint, async (client) => {
        const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
        assert.notEqual(navigation.isError, true);
        assert.match(contentText(navigation), /Page Title: Tachiko fixture/);
        const fixtureText = await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: '() => document.body.textContent' },
        });
        assert.notEqual(fixtureText.isError, true);
        assert.match(contentText(fixtureText), /local fixture sentinel/);
        const written = await client.callTool({
          name: 'browser_evaluate',
          arguments: {
            function: "() => { localStorage.setItem('tachiko-persistent', 'state-from-first-session'); return localStorage.getItem('tachiko-persistent'); }",
          },
        });
        assert.notEqual(written.isError, true);
        firstWriteSentinel = /state-from-first-session/.test(contentText(written));
        assert.match(contentText(written), /state-from-first-session/);
        const origin = await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => location.origin === ${JSON.stringify(new URL(fixtureUrl).origin)}` } });
        assert.notEqual(origin.isError, true);
        firstOriginMatches = /^### Result\s+true(?:\s|$)/m.test(contentText(origin));
        report('first-written');
        assert.equal(firstOriginMatches, true, 'first session uses the synthetic fixture origin');
      });
      stopped = await first.stop();
      report('first-stopped');

      second = await runtime.start({ profile: 'persistent', port: await freePort(), headless: true });
      await withClient(second.snapshot.endpoint, async (client) => {
        const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
        assert.notEqual(navigation.isError, true);
        const read = await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: "() => localStorage.getItem('tachiko-persistent')" },
        });
        assert.notEqual(read.isError, true);
        secondReadSentinel = /state-from-first-session/.test(contentText(read));
        const origin = await client.callTool({ name: 'browser_evaluate', arguments: { function: `() => location.origin === ${JSON.stringify(new URL(fixtureUrl).origin)}` } });
        assert.notEqual(origin.isError, true);
        secondOriginMatches = /^### Result\s+true(?:\s|$)/m.test(contentText(origin));
        report('second-read');
        assert.match(contentText(read), /state-from-first-session/);
        assert.equal(secondOriginMatches, true, 'second session uses the same synthetic fixture origin');
        assert.equal(lifecycle.length, 2, 'a fresh owned MCP child is started for each session');
        assert.equal(lifecycle[0]!.profileDir, lifecycle[1]!.profileDir);
        assert.notEqual(first!.snapshot.runtimeId, second!.snapshot.runtimeId);
      });
    } finally {
      try {
        await first?.stop().catch(() => undefined);
        await second?.stop().catch(() => undefined);
        report('cleanup');
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    }
  });
  it('refuses new browser starts while permitting exact-owned cleanup after installation authority is revoked', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-authority-integration-'));
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'), runtimeRoot: path.join(root, 'runtimes'), repositoryRoot: REPO_ROOT,
    });
    let allowed = true;
    const refusal = new Error('Controlled current installation is unavailable.');
    const beforeStart = () => { if (!allowed) throw refusal; };
    let handle: BrowserRuntimeHandle | undefined;
    try {
      handle = await runtime.start({ profile: 'owned', port: await freePort(), headless: true, beforeStart });
      assert.equal(handle.snapshot.state, 'ready');
      allowed = false;
      await assert.rejects(runtime.start({ profile: 'refused', port: await freePort(), headless: true, beforeStart }), error => error === refusal);
      assert.equal(existsSync(path.join(root, 'profiles', 'refused')), false, 'refused service start creates no profile ownership');
      const stopped = await handle.stop();
      assert.equal(stopped.runtimeId, handle.snapshot.runtimeId);
      assert.equal(stopped.state, 'stopped');
      assert.equal((await runtime.status('owned'))?.runtimeId, handle.snapshot.runtimeId);
      assert.equal((await runtime.status('owned'))?.state, 'stopped');
    } finally { await handle?.stop().catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
  });
});
