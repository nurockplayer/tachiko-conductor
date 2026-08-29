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
} from '../src/browser/playwright-mcp-runtime.js';

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

async function withClient<T>(endpoint: string, action: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'tachiko-browser-integration-test', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
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
        assert.match(contentText(written), /state-from-first-session/);
      });
      await first.stop();
      first = undefined;

      second = await runtime.start({ profile: 'persistent', port: await freePort(), headless: true });
      await withClient(second.snapshot.endpoint, async (client) => {
        const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: fixtureUrl } });
        assert.notEqual(navigation.isError, true);
        const read = await client.callTool({
          name: 'browser_evaluate',
          arguments: { function: "() => localStorage.getItem('tachiko-persistent')" },
        });
        assert.notEqual(read.isError, true);
        assert.match(contentText(read), /state-from-first-session/);
      });
    } finally {
      await first?.stop().catch(() => undefined);
      await second?.stop().catch(() => undefined);
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
