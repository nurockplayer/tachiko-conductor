import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  type BrowserRuntimeSnapshot,
} from '../src/browser/playwright-mcp-runtime.js';
import { openBrowserForBootstrap } from '../src/browser/mcp-client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const endpointUrl = new URL(endpoint);
  const nativeFetch = globalThis.fetch;
  let firstEndpointGetSeen = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readinessOutcome = readiness.then(
    () => ({ kind: 'ready' as const }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  );
  const readinessFetch: typeof fetch = (input, init) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : input.toString(), endpointUrl);
    } catch {
      return nativeFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (requestUrl.href !== endpointUrl.href || method !== 'GET' || firstEndpointGetSeen) {
      return nativeFetch(input, init);
    }
    firstEndpointGetSeen = true;

    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
    const requestSessionId = requestHeaders.get('mcp-session-id');
    try {
      return nativeFetch(input, init).then((response) => {
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        const responseSessionId = response.headers.get('mcp-session-id');
        if (response.status === 200 && mediaType === 'text/event-stream' && response.body !== null &&
          requestSessionId !== null && requestSessionId.length > 0 && responseSessionId === requestSessionId) {
          resolveReady();
        } else {
          rejectReady(new Error('The integration MCP event stream was not established for the initialized session.'));
        }
        return response;
      }, (error: unknown) => {
        rejectReady(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
  const phase = (name: string, state: 'start' | 'done') => {
    if (diagnostic !== undefined) reportIntegrationPhase(diagnostic.startedAt, `${diagnostic.label}.${name}`, state);
  };
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    phase('connect', 'start');
    await client.connect(new StreamableHTTPClientTransport(endpointUrl, { fetch: readinessFetch }));
    phase('connect', 'done');
    phase('event-stream-ready', 'start');
    const timedOut = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      readinessTimer = setTimeout(() => resolve({ kind: 'timeout' }), 5_000);
    });
    const ready = await Promise.race([readinessOutcome, timedOut]);
    if (readinessTimer !== undefined) {
      clearTimeout(readinessTimer);
      readinessTimer = undefined;
    }
    if (ready.kind === 'timeout') throw new Error('Timed out waiting for the integration MCP event stream.');
    if (ready.kind === 'error') throw ready.error;
    phase('event-stream-ready', 'done');
    phase('tool-action', 'start');
    const result = await action(client);
    phase('tool-action', 'done');
    return result;
  } finally {
    if (readinessTimer !== undefined) clearTimeout(readinessTimer);
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
    let firstSnapshot: BrowserRuntimeSnapshot | undefined;
    let firstStopSnapshot: BrowserRuntimeSnapshot | undefined;
    let firstStopElapsedMs: number | undefined;
    let secondNavigationDiagnostic: { readonly isError: unknown; readonly text: string } | undefined;
    let secondReadDiagnostic: { readonly isError: unknown; readonly text: string } | undefined;
    const boundedToolResult = (value: unknown): { readonly isError: unknown; readonly text: string } => {
      if (typeof value !== 'object' || value === null) return { isError: undefined, text: '' };
      const toolResult = value as { readonly isError?: unknown; readonly content?: unknown };
      const text = Array.isArray(toolResult.content)
        ? toolResult.content.slice(0, 4).flatMap((item: unknown) => {
          if (typeof item !== 'object' || item === null) return [];
          const entry = item as { readonly type?: unknown; readonly text?: unknown };
          return entry.type === 'text' && typeof entry.text === 'string' ? [entry.text.slice(0, 320)] : [];
        }).join('\n').slice(0, 1_200)
        : '';
      return { isError: toolResult.isError, text };
    };
    const persistenceDiagnostic = (): string => JSON.stringify({
      fixtureOrigin: new URL(fixtureUrl).origin,
      profileRoot: path.join(root, 'profiles'),
      firstRuntimeId: firstSnapshot?.runtimeId,
      firstProfile: firstSnapshot?.profile,
      firstStopElapsedMs,
      firstStopSnapshot: firstStopSnapshot === undefined ? undefined : {
        runtimeId: firstStopSnapshot.runtimeId,
        profile: firstStopSnapshot.profile,
        state: firstStopSnapshot.state,
        health: firstStopSnapshot.health,
        exitCode: firstStopSnapshot.exitCode,
        exitSignal: firstStopSnapshot.exitSignal,
        stoppedAt: firstStopSnapshot.stoppedAt,
      },
      secondRuntimeId: second?.snapshot.runtimeId,
      secondProfile: second?.snapshot.profile,
      secondNavigation: secondNavigationDiagnostic,
      secondRead: secondReadDiagnostic,
    });
    try {
      first = await runtime.start({ profile: 'persistent', port: await freePort(), headless: true });
      firstSnapshot = first.snapshot;
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
        assert.match(contentText(written), /state-from-first-session/);
      });
      const firstStopStartedAt = Date.now();
      firstStopSnapshot = await first.stop();
      firstStopElapsedMs = Date.now() - firstStopStartedAt;
      first = undefined;

      second = await runtime.start({ profile: 'persistent', port: await freePort(), headless: true });
      await withClient(second.snapshot.endpoint, async (client) => {
        const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
        secondNavigationDiagnostic = boundedToolResult(navigation);
        assert.notEqual(navigation.isError, true, `second same-profile navigation failed; bounded runtime context=${persistenceDiagnostic()}`);
        const read = await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: "() => localStorage.getItem('tachiko-persistent')" },
        });
        secondReadDiagnostic = boundedToolResult(read);
        assert.notEqual(read.isError, true, `second same-profile read failed; bounded runtime context=${persistenceDiagnostic()}`);
        assert.match(contentText(read), /state-from-first-session/, `persisted value missing; bounded runtime context=${persistenceDiagnostic()}`);
      });
    } finally {
      await first?.stop().catch(() => undefined);
      await second?.stop().catch(() => undefined);
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
