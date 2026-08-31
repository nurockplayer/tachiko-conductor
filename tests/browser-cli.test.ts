import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import {
  browserBootstrapCommand,
  browserImplementationCapabilities,
  browserStartCommand,
  browserStatusCommand,
  browserStopCommand,
  parseBrowserPort,
  resolveBrowserRoots,
  resolveRepositoryRoot,
  resumeCommandHint,
  waitForOwnedBrowser,
} from '../src/cli.js';
import type {
  BrowserRuntime,
  BrowserRuntimeHandle,
  BrowserRuntimeSnapshot,
  StartBrowserRuntimeOptions,
} from '../src/browser/playwright-mcp-runtime.js';
import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
} from '../src/browser/playwright-mcp-runtime.js';

const READY: BrowserRuntimeSnapshot = {
  runtimeId: 'runtime-1',
  profile: 'work',
  endpoint: 'http://127.0.0.1:8931/mcp',
  host: '127.0.0.1',
  port: 8931,
  pid: 1234,
  ownerPid: 1233,
  stopTimeoutMs: 5000,
  headless: true,
  state: 'ready',
  health: 'ready',
  startedAt: '2026-08-29T00:00:00.000Z',
  readyAt: '2026-08-29T00:00:01.000Z',
};

class FakeBrowserRuntime implements BrowserRuntime {
  readonly starts: StartBrowserRuntimeOptions[] = [];
  readonly statuses: string[] = [];
  readonly stops: string[] = [];
  handleStops = 0;
  current: BrowserRuntimeSnapshot | null = READY;

  async start(options: StartBrowserRuntimeOptions): Promise<BrowserRuntimeHandle> {
    this.starts.push(options);
    const runtime = this;
    const snapshot = { ...READY, profile: options.profile, headless: options.headless ?? true };
    return {
      snapshot,
      async stop() {
        runtime.handleStops += 1;
        return { ...snapshot, state: 'stopped', health: 'stopped' };
      },
      async waitForExit() {
        return { ...snapshot, state: 'stopped', health: 'stopped' };
      },
    };
  }

  async status(profile: string): Promise<BrowserRuntimeSnapshot | null> {
    this.statuses.push(profile);
    return this.current;
  }

  async stop(profile: string): Promise<BrowserRuntimeSnapshot> {
    this.stops.push(profile);
    return { ...READY, profile, state: 'stopped', health: 'stopped' };
  }
}

describe('browser CLI command layer', () => {
  it('resolves dedicated browser roots outside the repository and allows explicit overrides', () => {
    assert.deepEqual(resolveBrowserRoots({}, '/Users/example'), {
      profileRoot: '/Users/example/.tachiko-conductor/browser/profiles',
      runtimeRoot: '/Users/example/.tachiko-conductor/browser/runtimes',
    });
    assert.deepEqual(
      resolveBrowserRoots(
        {
          TACHIKO_BROWSER_PROFILE_ROOT: '/var/tachiko/profiles',
          TACHIKO_BROWSER_RUNTIME_ROOT: '/var/tachiko/runtimes',
        },
        '/Users/example',
      ),
      { profileRoot: '/var/tachiko/profiles', runtimeRoot: '/var/tachiko/runtimes' },
    );
  });

  it('uses the Git top-level as the repository boundary when invoked from a subdirectory', () => {
    assert.equal(
      resolveRepositoryRoot('/work/repository/src', (cwd) => {
        assert.equal(cwd, '/work/repository/src');
        return '/work/repository\n';
      }),
      '/work/repository',
    );
  });

  it('fails closed when the Git repository top-level cannot be established', () => {
    assert.throws(
      () => resolveRepositoryRoot('/work/repository/src', () => {
        throw new Error('git timed out');
      }),
      /Cannot establish the Git repository top-level.*refusing browser storage/,
    );
    assert.throws(
      () => resolveRepositoryRoot('/work/repository/src', () => '   \n'),
      /Cannot establish the Git repository top-level.*refusing browser storage/,
    );
  });

  it('preserves the selected browser profile in takeover resume instructions', () => {
    assert.equal(
      resumeCommandHint('run-123', 'github-work'),
      'tachiko run resume run-123 --decision <choice> --browser-profile github-work',
    );
    assert.equal(resumeCommandHint('run-123'), 'tachiko run resume run-123 --decision <choice>');
  });

  it('installs signal cleanup before startup and stops only the returned handle after early interruption', async () => {
    const signals = new EventEmitter();
    let handleStops = 0;
    const stopped = { ...READY, state: 'stopped', health: 'stopped' } as const;
    const handle: BrowserRuntimeHandle = {
      snapshot: READY,
      async stop() {
        handleStops += 1;
        return stopped;
      },
      async waitForExit() {
        throw new Error('interrupted startup must stop instead of waiting indefinitely');
      },
    };

    const finalSnapshot = await waitForOwnedBrowser(
      async (signal) => {
        assert.equal(signals.listenerCount('SIGINT'), 1);
        assert.equal(signal.aborted, false);
        signals.emit('SIGINT');
        assert.equal(signal.aborted, true);
        assert.equal(signals.listenerCount('SIGINT'), 1);
        signals.emit('SIGINT');
        return {
          handle,
          runtime: READY,
          capability: { kind: 'mcp-http', name: 'tachiko_browser', endpoint: READY.endpoint },
          claudeCode: { mcpServers: {} },
          codex: { configOverride: '' },
        };
      },
      () => undefined,
      signals,
    );

    assert.equal(finalSnapshot.state, 'stopped');
    assert.equal(handleStops, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  it('does not issue a profile-wide stop when an interrupted startup returns no handle', async () => {
    const signals = new EventEmitter();
    await assert.rejects(
      waitForOwnedBrowser(
        async (signal) => {
          signals.emit('SIGTERM');
          assert.equal(signal.aborted, true);
          assert.equal(signals.listenerCount('SIGTERM'), 1);
          signals.emit('SIGTERM');
          throw new Error('profile is already owned by another runtime');
        },
        () => undefined,
        signals,
      ),
      /already owned by another runtime/,
    );
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });

  it('parses browser ports strictly', () => {
    assert.equal(parseBrowserPort('8931'), 8931);
    assert.throws(() => parseBrowserPort('0'), /integer from 1 to 65535/);
    assert.throws(() => parseBrowserPort('65536'), /integer from 1 to 65535/);
    assert.throws(() => parseBrowserPort('8931oops'), /integer from 1 to 65535/);
  });

  it('starts headless by default and emits provider-specific configs from one generic capability', async () => {
    const runtime = new FakeBrowserRuntime();
    const result = await browserStartCommand(runtime, 'work', { port: 8931 });

    assert.deepEqual(runtime.starts, [{ profile: 'work', port: 8931, headless: true }]);
    assert.equal(result.runtime.state, 'ready');
    assert.deepEqual(result.capability, {
      kind: 'mcp-http',
      name: 'tachiko_browser',
      endpoint: 'http://127.0.0.1:8931/mcp',
    });
    assert.deepEqual(result.claudeCode, {
      mcpServers: {
        tachiko_browser: { type: 'http', url: 'http://127.0.0.1:8931/mcp' },
      },
    });
    assert.equal(
      result.codex.configOverride,
      'mcp_servers.tachiko_browser={url="http://127.0.0.1:8931/mcp",required=true,default_tools_approval_mode="approve"}',
    );
  });

  it('bootstraps headed and opens the dedicated profile before returning', async () => {
    const runtime = new FakeBrowserRuntime();
    const opened: string[] = [];
    const result = await browserBootstrapCommand(runtime, 'login', {}, async (endpoint) => {
      opened.push(endpoint);
    });

    assert.deepEqual(runtime.starts, [{ profile: 'login', headless: false }]);
    assert.deepEqual(opened, ['http://127.0.0.1:8931/mcp']);
    assert.equal(result.runtime.headless, false);
  });

  it('holds the bootstrap browser lease until the owned runtime handle finishes', async () => {
    const runtime = new FakeBrowserRuntime();
    let leaseCloses = 0;
    const result = await browserBootstrapCommand(runtime, 'login', {}, async () => ({
      async close() {
        leaseCloses += 1;
      },
    }));

    assert.equal(leaseCloses, 0);
    await result.handle.stop();
    assert.equal(runtime.handleStops, 1);
    assert.equal(leaseCloses, 1);
    await result.handle.waitForExit();
    assert.equal(leaseCloses, 1);
  });

  it('stops the exact local handle when bootstrap opening is aborted', async () => {
    const runtime = new FakeBrowserRuntime();
    const controller = new AbortController();
    let resolveOpen: ((lease: { close(): Promise<void> }) => void) | undefined;
    let leaseCloses = 0;
    const opening = browserBootstrapCommand(
      runtime,
      'login',
      { signal: controller.signal },
      async () => {
        controller.abort();
        return await new Promise<{ close(): Promise<void> }>((resolve) => {
          resolveOpen = resolve;
        });
      },
    );

    await assert.rejects(opening, (error) => {
      assert.equal((error as BrowserRuntimeError).code, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING);
      return true;
    });
    assert.equal(runtime.handleStops, 1);
    assert.notEqual(resolveOpen, undefined);
    resolveOpen?.({
      async close() {
        leaseCloses += 1;
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(leaseCloses, 1);
  });

  it('does not invoke bootstrap opening for a pre-aborted attempt', async () => {
    const runtime = new FakeBrowserRuntime();
    const controller = new AbortController();
    controller.abort();
    let openCalls = 0;

    await assert.rejects(
      browserBootstrapCommand(runtime, 'login', { signal: controller.signal }, async () => {
        openCalls += 1;
      }),
      (error) => {
        assert.equal((error as BrowserRuntimeError).code, BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING);
        return true;
      },
    );
    assert.equal(openCalls, 0);
    assert.equal(runtime.handleStops, 1);
  });

  it('reports status, stops by profile name, and fails clearly when status is absent', async () => {
    const runtime = new FakeBrowserRuntime();
    assert.equal((await browserStatusCommand(runtime, 'work')).profile, 'work');
    assert.equal((await browserStopCommand(runtime, 'work')).state, 'stopped');
    assert.deepEqual(runtime.statuses, ['work']);
    assert.deepEqual(runtime.stops, ['work']);

    runtime.current = null;
    await assert.rejects(browserStatusCommand(runtime, 'missing'), /Browser profile "missing" has no runtime metadata/);
  });

  it('resolves only a ready named profile into ephemeral workflow capabilities', async () => {
    const runtime = new FakeBrowserRuntime();
    assert.equal(await browserImplementationCapabilities(runtime, undefined), undefined);
    assert.deepEqual(await browserImplementationCapabilities(runtime, 'work'), [
      {
        kind: 'mcp-http',
        name: 'tachiko_browser',
        endpoint: 'http://127.0.0.1:8931/mcp',
      },
    ]);

    runtime.current = { ...READY, state: 'failed', health: 'failed' };
    await assert.rejects(
      browserImplementationCapabilities(runtime, 'work'),
      /Browser profile "work" is not ready/,
    );
  });
});
