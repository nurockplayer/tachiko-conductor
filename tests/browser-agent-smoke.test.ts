import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { NodeClaudeProcessRunner } from '../src/agents/claude-code.js';
import { buildBrowserAgentConnection } from '../src/browser/agent-config.js';
import { ManagedPlaywrightMcpRuntime, type BrowserRuntimeHandle } from '../src/browser/playwright-mcp-runtime.js';

// Opt-in real-agent smoke for issue #12. It uses a localhost fixture and the
// managed Playwright MCP runtime, but invokes the authenticated Codex CLI once:
//   TACHIKO_BROWSER_AGENT_SMOKE=1 pnpm exec tsx --test tests/browser-agent-smoke.test.ts
// It is skipped in the default suite and CI so no paid/model network is required.
const enabled = process.env.TACHIKO_BROWSER_AGENT_SMOKE === '1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('managed browser real-agent smoke (opt-in)', { skip: !enabled }, () => {
  it('lets Codex read a localhost sentinel through the injected MCP capability', { timeout: 180_000 }, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-browser-agent-smoke-'));
    const sentinel = 'tachiko-browser-agent-smoke-ok';
    const fixture = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Agent smoke</title><main>${sentinel}</main>`);
    });
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    assert.ok(address !== null && typeof address !== 'string');
    const fixtureUrl = `http://127.0.0.1:${address.port}/`;
    const runtime = new ManagedPlaywrightMcpRuntime({
      profileRoot: path.join(root, 'profiles'),
      runtimeRoot: path.join(root, 'runtimes'),
      repositoryRoot: REPO_ROOT,
    });
    let handle: BrowserRuntimeHandle | undefined;
    try {
      handle = await runtime.start({ profile: 'agent-smoke', headless: true });
      const connection = buildBrowserAgentConnection(handle.snapshot);
      const runner = new NodeClaudeProcessRunner();
      const result = await runner.run(
        'codex',
        [
          '--ask-for-approval',
          'never',
          '--sandbox',
          'read-only',
          '--cd',
          REPO_ROOT,
          '--config',
          connection.codex.configOverride,
          '--config',
          'mcp_servers.tachiko_browser.enabled_tools=["browser_navigate","browser_snapshot"]',
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--json',
          `Use only the tachiko_browser MCP tools. Navigate to ${fixtureUrl}, read the page, and reply with the exact page text only.`,
        ],
        { timeoutMs: 150_000, cwd: REPO_ROOT },
      );
      assert.equal(result.exitCode, 0, result.stderr);
      const events = result.stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as CodexEvent);
      assert.ok(
        events.some((event) => event.item?.type === 'mcp_tool_call'),
        `Codex did not report an MCP tool call:\n${result.stdout}`,
      );
      const messages = events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .map((event) => event.item?.text);
      assert.equal(messages.at(-1), sentinel);
    } finally {
      await handle?.stop().catch(() => undefined);
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface CodexEvent {
  readonly type?: string;
  readonly item?: {
    readonly type?: string;
    readonly text?: string;
  };
}
