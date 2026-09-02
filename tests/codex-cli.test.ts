import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import type { ProcessResult, ProcessRunner, ProcessRunOptions } from '../src/github/transport.js';
import { TARGET } from './helpers.js';

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options: ProcessRunOptions }> = [];

  constructor(private readonly outcomes: Array<ProcessResult | Error>) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
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

function codexJsonl(summary = 'Implemented Issue #15.', threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53'): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: summary } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n');
}

describe('CodexCliAdapter', () => {
  const HEAD = '9d9cc7d210960f3c81d7d7498a36f65c67b9f4a9';

  it('runs a fresh Codex exec with an argument array and returns its exact HEAD and thread identity', async () => {
    const runner = new FakeRunner([result(codexJsonl()), result(HEAD)]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo', timeoutMs: 9000 });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'success');
    assert.equal(agentResult.summary, 'Implemented Issue #15.');
    assert.equal(agentResult.headSha, HEAD);
    assert.deepEqual(agentResult.executor, {
      provider: 'codex-cli',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    });
    assert.equal(runner.calls[0]?.file, 'codex');
    assert.deepEqual(runner.calls[0]?.args.slice(0, 2), ['exec', '--json']);
    assert.match(String(runner.calls[0]?.args.at(-1)), /acme\/widgets#42/);
    assert.deepEqual(runner.calls[0]?.options, { timeoutMs: 9000, cwd: '/tmp/repo' });
    assert.deepEqual(runner.calls[1]?.args, ['rev-parse', 'HEAD']);
  });

  it('runs both Codex and exact-HEAD discovery inside the prepared workspace', async () => {
    const runner = new FakeRunner([result(codexJsonl()), result(HEAD)]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/source' });

    await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      workspacePath: '/tmp/prepared-worktree',
      branch: 'tachiko/issue-42',
    });

    assert.deepEqual(runner.calls.map((call) => call.options.cwd), [
      '/tmp/prepared-worktree',
      '/tmp/prepared-worktree',
    ]);
  });

  it('revalidates the prepared workspace immediately before spawning Codex', async () => {
    const runner = new FakeRunner([]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/source' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      workspacePath: '/tmp/prepared-worktree',
      workspaceGuard: {
        assertValid() {
          throw new Error('prepared workspace identity changed');
        },
      },
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CODEX_EXEC_FAILURE/);
    assert.equal(runner.calls.length, 0);
  });

  it('resumes the exact persisted Codex thread without falling back to a fresh exec', async () => {
    const threadId = '0199a213-81c0-7800-8aa1-bbab2a035a53';
    const runner = new FakeRunner([result(codexJsonl('Fixed review findings.', threadId)), result(HEAD)]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      instructions: 'Fix the blocking finding.',
      executor: { provider: 'codex-cli', sessionId: threadId },
    });

    assert.equal(agentResult.exitStatus, 'success');
    assert.deepEqual(runner.calls[0]?.args.slice(0, 4), ['exec', 'resume', '--json', threadId]);
    assert.match(String(runner.calls[0]?.args.at(-1)), /Fix the blocking finding/);
  });

  it('fails explicitly when a resume reports a different thread identity', async () => {
    const runner = new FakeRunner([
      result(codexJsonl('Unexpected fresh execution.', '0199a213-81c0-7800-8aa1-bbab2a035a54')),
    ]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      executor: { provider: 'codex-cli', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' },
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CODEX_RESUME_IDENTITY_MISMATCH/);
    assert.equal(runner.calls.length, 1);
  });

  it('injects resolved model, reasoning, sandbox, approval, and timeout configuration without selecting defaults', async () => {
    const runner = new FakeRunner([result(codexJsonl()), result(HEAD)]);
    const adapter = new CodexCliAdapter({
      runner,
      cwd: '/tmp/repo',
      timeoutMs: 12_345,
      model: 'resolved-model',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });

    await adapter.run({ target: TARGET, baseSha: 'base-1' });

    const args = runner.calls[0]?.args ?? [];
    assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'resolved-model']);
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.ok(args.includes('approval_policy="never"'));
    assert.equal(runner.calls[0]?.options.timeoutMs, 12_345);
  });

  it('maps timeout, cancellation, missing executable, non-zero exit, and malformed output to typed failures', async () => {
    const cases: Array<{ outcome: ProcessResult | Error; code: string }> = [
      { outcome: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), code: 'CODEX_TIMEOUT' },
      { outcome: Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), code: 'CODEX_CANCELLED' },
      { outcome: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }), code: 'CODEX_NOT_FOUND' },
      { outcome: result('', 'auth failed', 1), code: 'CODEX_EXIT_FAILURE' },
      { outcome: result('{bad json'), code: 'CODEX_INVALID_OUTPUT' },
      { outcome: result(JSON.stringify({ type: 'turn.completed' })), code: 'CODEX_INVALID_OUTPUT' },
      {
        outcome: result([
          JSON.stringify({ type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }),
          JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } }),
        ].join('\n')),
        code: 'CODEX_ERROR',
      },
    ];

    for (const { outcome, code } of cases) {
      const runner = new FakeRunner([outcome]);
      const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });
      const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });
      assert.equal(agentResult.exitStatus, 'failure', code);
      assert.match(agentResult.diagnostics?.join('\n') ?? '', new RegExp(code));
      assert.equal(runner.calls.length, 1);
    }
  });

  it('rejects stale or unusable resume identity before executing Codex', async () => {
    const cases = [
      { provider: 'claude-code', sessionId: 'session-1' },
      { provider: 'codex-cli', sessionId: '' },
    ];
    for (const executor of cases) {
      const runner = new FakeRunner([]);
      const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });
      const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1', executor });
      assert.equal(agentResult.exitStatus, 'failure');
      assert.match(agentResult.diagnostics?.join('\n') ?? '', /CODEX_RESUME_IDENTITY_INVALID/);
      assert.equal(runner.calls.length, 0);
    }
  });

  it('never reports success when the exact post-run Git HEAD cannot be established', async () => {
    const runner = new FakeRunner([result(codexJsonl()), result('not-a-sha')]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1' });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.equal(agentResult.headSha, undefined);
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /HEAD_READ_FAILED/);
    assert.deepEqual(agentResult.executor, {
      provider: 'codex-cli',
      sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    });
  });

  it('preserves the persisted executor identity when a resume command fails', async () => {
    const executor = { provider: 'codex-cli', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' } as const;
    const runner = new FakeRunner([result('', 'session not found', 1)]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({ target: TARGET, baseSha: 'base-1', executor });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CODEX_RESUME_FAILED/);
    assert.deepEqual(agentResult.executor, executor);
    assert.equal(runner.calls.length, 1);
  });

  it('reads live target authority without copying a large issue body into the prompt', async () => {
    const runner = new FakeRunner([result(codexJsonl()), result(HEAD)]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      authority: 'live-target',
      instructions: 'VERY LARGE ISSUE BODY THAT SHOULD NOT BE COPIED',
      supplementalInstructions: 'Create and associate an open implementation pull request.',
    });

    const prompt = String(runner.calls[0]?.args.at(-1));
    assert.doesNotMatch(prompt, /VERY LARGE ISSUE BODY/);
    assert.match(prompt, /Create and associate an open implementation pull request/);
    assert.match(prompt, /Read the live target/);
  });

  it('injects generic HTTP MCP capabilities and preserves the human-takeover protocol', async () => {
    const runner = new FakeRunner([result(codexJsonl('TACHIKO_NEEDS_HUMAN: browser login requires 2FA'))]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      capabilities: [{
        kind: 'mcp-http',
        name: 'tachiko_browser',
        endpoint: 'http://127.0.0.1:8931/mcp',
      }],
    });

    const args = runner.calls[0]?.args ?? [];
    assert.ok(args.includes(
      'mcp_servers.tachiko_browser={url="http://127.0.0.1:8931/mcp",required=true,default_tools_approval_mode="approve"}',
    ));
    assert.match(String(args.at(-1)), /TACHIKO_NEEDS_HUMAN: <reason>/);
    assert.equal(agentResult.exitStatus, 'failure');
    assert.equal(agentResult.summary, 'browser login requires 2FA');
    assert.deepEqual(agentResult.diagnostics, ['TACHIKO_NEEDS_HUMAN: browser login requires 2FA']);
    assert.equal(runner.calls.length, 1);
  });

  it('rejects duplicate MCP capability names before starting Codex', async () => {
    const runner = new FakeRunner([]);
    const adapter = new CodexCliAdapter({ runner, cwd: '/tmp/repo' });

    const agentResult = await adapter.run({
      target: TARGET,
      baseSha: 'base-1',
      capabilities: [
        { kind: 'mcp-http', name: 'browser', endpoint: 'http://127.0.0.1:8931/mcp' },
        { kind: 'mcp-http', name: 'browser', endpoint: 'http://127.0.0.1:8932/mcp' },
      ],
    });

    assert.equal(agentResult.exitStatus, 'failure');
    assert.match(agentResult.diagnostics?.join('\n') ?? '', /CODEX_EXEC_FAILURE.*Duplicate MCP capability name/);
    assert.equal(runner.calls.length, 0);
  });
});
