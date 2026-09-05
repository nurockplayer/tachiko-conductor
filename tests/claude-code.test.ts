import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClaudeCodeAdapter, NodeClaudeProcessRunner } from '../src/agents/claude-code.js';
import type { ClaudeProcessRunner, ClaudeRunOptions } from '../src/agents/claude-code.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import { WorkspaceGuardFailure } from '../src/adapters/agent.js';
import type { ProcessResult } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

class FakeRunner implements ClaudeProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options: ClaudeRunOptions }> = [];

  constructor(private readonly outcomes: Array<ProcessResult | Error>) {}

  async run(file: string, args: readonly string[], options: ClaudeRunOptions): Promise<ProcessResult> {
    this.calls.push({ file, args, options });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No fake outcome queued');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function result(stdout: string, stderr = '', exitCode = 0): ProcessResult {
  return { stdout, stderr, exitCode };
}

function claudeJson(resultText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', session_id: 'sess-1', result: resultText, is_error: false, ...extra });
}

describe('ClaudeCodeAdapter', () => {
  const HEAD = '9d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';

  it('revalidates a prepared workspace immediately before spawn and never invokes Claude after guard failure', async () => {
    const runner = new FakeRunner([]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });
    await assert.rejects(
      () => adapter.run({
        target: TARGET, baseSha: 'base', workspacePath: '/tmp/prepared',
        workspaceGuard: { assertValid: () => { throw new Error('branch switched'); } },
      }),
      WorkspaceGuardFailure,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('runs claude with an argument array and converts a JSON result to a success AgentResult', async () => {
    const runner = new FakeRunner([result(claudeJson('implemented')), result(HEAD)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo', timeoutMs: 9000 });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1', instructions: 'Fix it.' });

    assert.equal(agentResult.exitStatus, 'success');
    assert.equal(agentResult.summary, 'implemented');
    assert.equal(agentResult.headSha, HEAD);
    assert.equal(agentResult.sessionId, 'sess-1');
    assert.deepEqual(agentResult.executor, { provider: 'claude-code', sessionId: 'sess-1' });
    assert.equal(typeof agentResult.durationMs, 'number');
    assert.deepEqual(runner.calls[0]?.options, { timeoutMs: 9000, cwd: '/tmp/repo' });
    assert.equal(runner.calls[0]?.file, 'claude');
    const args = runner.calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 6), ['-p', args[1], '--output-format', 'json', '--permission-mode', 'acceptEdits']);
    assert.match(String(args[1]), /acme\/widgets#42/);
    assert.match(String(args[1]), /Fix it\./);
    assert.match(String(args[1]), /validation and tests before reporting success/);
    assert.deepEqual(runner.calls[1]?.args, ['rev-parse', 'HEAD']);
  });

  it('maps a non-zero claude exit to a deterministic failure without reading git', async () => {
    const runner = new FakeRunner([result('', 'claude crashed', 1)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.summary, /status 1/);
    assert.doesNotMatch(agentResult.summary, /claude crashed/);
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CLAUDE_EXIT_FAILURE/);
    assert.equal(agentResult.headSha, undefined);
    assert.equal(runner.calls.length, 1);
  });

  it('maps is_error results, timeouts, missing executables, and invalid structured output deterministically', async () => {
    const cases: Array<{ outcome: ProcessResult | Error; code: string }> = [
      { outcome: result(claudeJson('failed', { is_error: true })), code: 'CLAUDE_ERROR' },
      { outcome: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), code: 'CLAUDE_TIMEOUT' },
      { outcome: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), code: 'CLAUDE_NOT_FOUND' },
      { outcome: result('{bad json'), code: 'CLAUDE_INVALID_OUTPUT' },
      { outcome: result('{}'), code: 'CLAUDE_INVALID_OUTPUT' },
      { outcome: result(JSON.stringify({ type: 'result', result: 42, is_error: false })), code: 'CLAUDE_INVALID_OUTPUT' },
    ];
    for (const { outcome, code } of cases) {
      const runner = new FakeRunner([outcome]);
      const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });
      const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });
      assert.equal(agentResult.exitStatus, 'failure', `expected failure for ${code}`);
      assert.match(agentResult.diagnostics?.join('\n') ?? '', new RegExp(code));
      assert.equal(typeof agentResult.durationMs, 'number');
    }
  });

  it('never reports success when the post-run git HEAD cannot be read', async () => {
    const runner = new FakeRunner([
      result(claudeJson('implemented')),
      Object.assign(new Error('not a git repo'), { code: 'ENOENT' }),
    ]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.equal(agentResult.headSha, undefined);
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /HEAD_READ_FAILED/);
  });

  it('returns a session id that a new adapter can resume after process restart', async () => {
    const runner = new FakeRunner([
      result(claudeJson('implemented', { session_id: 'sess-2' })),
      result(HEAD),
      result(claudeJson('fixed', { session_id: 'sess-3' })),
      result(HEAD),
    ]);
    const firstAdapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const first = await firstAdapter.run({ target: TARGET, baseSha: 'base-1', sessionId: 'sess-1' });
    assert.equal(first.exitStatus, 'success');
    assert.equal(first.sessionId, 'sess-2');
    assert.ok(runner.calls[0]?.args.includes('--resume'));
    assert.ok(runner.calls[0]?.args.includes('sess-1'));

    const restartedAdapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });
    const second = await restartedAdapter.run({ target: TARGET, baseSha: 'base-1', sessionId: first.sessionId });
    assert.equal(second.exitStatus, 'success');
    assert.equal(second.sessionId, 'sess-3');
    assert.ok(runner.calls[2]?.args.includes('--resume'));
    assert.ok(runner.calls[2]?.args.includes('sess-2'));
  });

  it('resumes from provider-neutral executor metadata after process restart', async () => {
    const runner = new FakeRunner([
      result(claudeJson('fixed', { session_id: 'sess-2' })),
      result(HEAD),
    ]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const resultValue = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      executor: { provider: 'claude-code', sessionId: 'sess-1' },
    });

    assert.equal(resultValue.exitStatus, 'success');
    assert.ok(runner.calls[0]?.args.includes('--resume'));
    assert.ok(runner.calls[0]?.args.includes('sess-1'));
    assert.deepEqual(resultValue.executor, { provider: 'claude-code', sessionId: 'sess-2' });
  });

  it('passes AbortSignal to the process and maps cancellation deterministically', async () => {
    const controller = new AbortController();
    const calls: Array<{ file: string; options: ClaudeRunOptions }> = [];
    const runner: ClaudeProcessRunner = {
      async run(file, _args, options) {
        calls.push({ file, options });
        controller.abort();
        throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
      },
    };
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      sessionId: 'persisted-session',
      signal: controller.signal,
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CLAUDE_CANCELLED/);
    assert.equal(agentResult.sessionId, 'persisted-session');
    assert.equal(calls[0]?.options.signal, controller.signal);
    assert.equal(calls.length, 1);
  });

  it('preserves a persisted session when cancelled before process execution', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new FakeRunner([]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      sessionId: 'persisted-session',
      signal: controller.signal,
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.equal(agentResult.sessionId, 'persisted-session');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CLAUDE_CANCELLED/);
    assert.equal(runner.calls.length, 0);
  });

  function githubAdapter(snapshot: () => GitHubLiveSnapshot | never): GitHubAdapter {
    return {
      kind: 'github',
      async readIssue() {
        throw new Error('unused');
      },
      async readBranch() {
        throw new Error('unused');
      },
      async listPullRequests() {
        throw new Error('unused');
      },
      async readLiveSnapshot() {
        return snapshot();
      },
    };
  }

  it('injects a live GitHub snapshot summary into the prompt', async () => {
    const github = githubAdapter(() => ({
      repository: { owner: 'acme', repo: 'widgets', defaultBranch: null, defaultBranchHeadSha: null },
      issue: { id: 'I_42', number: 42, title: 'Fix the widget', body: '', state: 'open', url: '', createdAt: '', updatedAt: '' },
      pullRequest: null,
      headSha: null,
      checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
      reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null },
      conversations: [],
      handoff: null,
      problems: [],
      observedAt: '2026-08-14T03:00:00.000Z',
    }));
    const runner = new FakeRunner([result(claudeJson('done')), result(HEAD)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo', github });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'success');
    const prompt = String(runner.calls[0]?.args[1]);
    assert.match(prompt, /Issue: 42 \(open\)/);
    assert.match(prompt, /Pull request: none/);
  });

  it('injects HTTP MCP capabilities per invocation and auto-approves only that server', async () => {
    const runner = new FakeRunner([result(claudeJson('implemented')), result(HEAD)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      capabilities: [
        {
          kind: 'mcp-http',
          name: 'tachiko_browser',
          endpoint: 'http://127.0.0.1:8931/mcp',
        },
      ],
    });

    assert.equal(agentResult.exitStatus, 'success');
    const args = runner.calls[0]?.args ?? [];
    const configIndex = args.indexOf('--mcp-config');
    assert.notEqual(configIndex, -1);
    assert.deepEqual(JSON.parse(String(args[configIndex + 1])), {
      mcpServers: {
        tachiko_browser: { type: 'http', url: 'http://127.0.0.1:8931/mcp' },
      },
    });
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('mcp__tachiko_browser__*'));
    assert.ok(!args.includes('mcp__*'));
  });

  it('supports an explicitly configured remote HTTP MCP endpoint per invocation', async () => {
    const runner = new FakeRunner([result(claudeJson('implemented')), result(HEAD)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'https://browser.internal/mcp' }],
    });

    assert.equal(agentResult.exitStatus, 'success');
    const args = runner.calls[0]?.args ?? [];
    const configIndex = args.indexOf('--mcp-config');
    assert.deepEqual(JSON.parse(String(args[configIndex + 1])), {
      mcpServers: { browser: { type: 'http', url: 'https://browser.internal/mcp' } },
    });
  });

  it('rejects unsafe MCP capability names and endpoints', async () => {
    const runner = new FakeRunner([]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    await assert.rejects(
      adapter.run({
        target: TARGET,
        baseSha: 'base-1',
        capabilities: [{ kind: 'mcp-http', name: 'bad name', endpoint: 'http://127.0.0.1:8931/mcp' }],
      }),
      /Invalid MCP capability name/,
    );
    await assert.rejects(
      adapter.run({
        target: TARGET,
        baseSha: 'base-1',
        capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'ftp://127.0.0.1/mcp' }],
      }),
      /must use an HTTP or HTTPS endpoint/,
    );
    await assert.rejects(
      adapter.run({
        target: TARGET,
        baseSha: 'base-1',
        capabilities: [{ kind: 'mcp-http', name: 'browser', endpoint: 'https://user:secret@example.com/mcp' }],
      }),
      /must not embed credentials/,
    );
    assert.equal(runner.calls.length, 0);
  });

  it('maps the explicit human-takeover protocol to a deterministic failure without reading git', async () => {
    const runner = new FakeRunner([result(claudeJson('TACHIKO_NEEDS_HUMAN: login expired; run browser bootstrap'))]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      capabilities: [
        { kind: 'mcp-http', name: 'tachiko_browser', endpoint: 'http://127.0.0.1:8931/mcp' },
      ],
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.equal(agentResult.summary, 'login expired; run browser bootstrap');
    assert.deepEqual(agentResult.diagnostics, ['TACHIKO_NEEDS_HUMAN: login expired; run browser bootstrap']);
    assert.equal(runner.calls.length, 1);
    assert.match(String(runner.calls[0]?.args[1]), /Authentication, 2FA, or CAPTCHA/);
    assert.match(String(runner.calls[0]?.args[1]), /purchase, payment, billing, account deletion/);
  });

  it('degrades to an unavailable live-state note when the snapshot read fails', async () => {
    const github = githubAdapter(() => {
      throw new Error('boom');
    });
    const runner = new FakeRunner([result(claudeJson('done')), result(HEAD)]);
    const adapter = new ClaudeCodeAdapter({ runner, cwd: '/tmp/repo', github });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'success');
    const prompt = String(runner.calls[0]?.args[1]);
    assert.match(prompt, /Live GitHub state: unavailable/);
  });
});

describe('NodeClaudeProcessRunner', () => {
  it('closes child stdin so non-interactive CLIs do not wait for piped context', async () => {
    const runner = new NodeClaudeProcessRunner();

    const child = await runner.run(
      process.execPath,
      ['-e', "process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('closed'))"],
      { timeoutMs: 1_000, cwd: process.cwd() },
    );

    assert.deepEqual(child, { stdout: 'closed', stderr: '', exitCode: 0 });
  });
});
