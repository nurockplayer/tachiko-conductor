import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';

import { WorkspaceGuardFailure } from '../src/adapters/agent.js';
import { ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';

const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
const SHA = 'a'.repeat(40);
const fixtures: BootstrapGitFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

class SpawnTrace implements ProcessRunner {
  readonly calls: string[] = [];
  async run(file: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.calls.push(file);
    throw new Error(`provider spawn forbidden in guard regression: ${file}`);
  }
}

class SuccessfulProviderStub implements ProcessRunner {
  readonly calls: string[] = [];
  private changed = false;
  constructor(private readonly delegate: ProcessRunner, private readonly workspacePath: string, private readonly provider: 'claude' | 'codex') {}
  async run(file: string, args: readonly string[], options: Parameters<ProcessRunner['run']>[2]) {
    this.calls.push(file);
    if (file === 'git') return this.delegate.run(file, args, options);
    if (!this.changed) {
      this.changed = true;
      writeFileSync(`${this.workspacePath}/provider-change.txt`, 'legitimate new head\n');
      return this.delegate.run('git', ['add', 'provider-change.txt'], { ...options, cwd: this.workspacePath }).then(async () => {
        await this.delegate.run('git', ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'provider change'], { ...options, cwd: this.workspacePath });
        return this.provider === 'claude'
          ? { stdout: JSON.stringify({ type: 'result', result: 'completed', is_error: false, session_id: 'stub-session' }), stderr: '', exitCode: 0 }
          : { stdout: `${JSON.stringify({ type: 'thread.started', thread_id: 'stub-thread' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'completed' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`, stderr: '', exitCode: 0 };
      });
    }
    return { stdout: '', stderr: '', exitCode: 1 };
  }
}

describe('provider guard parity', () => {
  for (const [name, make] of [
    ['Claude Code', (runner: ProcessRunner) => new ClaudeCodeAdapter({ runner })],
    ['Codex CLI', (runner: ProcessRunner) => new CodexCliAdapter({ runner })],
  ] as const) {
    it(`${name} evaluates the workspace guard before provider spawn`, async () => {
      const trace = new SpawnTrace();
      const guard = { assertValid: () => { throw new Error('branch changed during prompt resolution'); } };
      await assert.rejects(
        () => make(trace).run({ target, baseSha: SHA, workspaceGuard: guard }),
        (error: unknown) => error instanceof WorkspaceGuardFailure && error.message.includes('branch changed'),
      );
      assert.deepEqual(trace.calls, []);
    });
  }

  for (const [name, make, provider] of [
    ['Claude Code', (runner: ProcessRunner) => new ClaudeCodeAdapter({ runner }), 'claude'],
    ['Codex CLI', (runner: ProcessRunner) => new CodexCliAdapter({ runner }), 'codex'],
  ] as const) {
    it(`${name} permits a legitimate clean new HEAD at the post-result guard`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const runId = `provider-new-head-${provider}`;
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await bootstrap.plan({ runId, target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
      await bootstrap.prepare({ runId, target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
      const runner = new SuccessfulProviderStub(fixture.runner, identity.workspacePath, provider);
      const result = await make(runner).run({ target, baseSha: fixture.baseSha, workspacePath: identity.workspacePath, workspaceGuard: bootstrap.guard(identity) });
      assert.equal(result.exitStatus, 'success');
      assert.notEqual(result.headSha, fixture.baseSha);
      assert.equal(runner.calls.some((file) => file === provider), true);
    });
  }

  for (const [name, make] of [
    ['Claude Code', (runner: ProcessRunner) => new ClaudeCodeAdapter({ runner })],
    ['Codex CLI', (runner: ProcessRunner) => new CodexCliAdapter({ runner })],
  ] as const) {
  it(`${name} blocks a real dirty workspace at the pre-spawn boundary`, async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: `provider-dirty-${name === 'Claude Code' ? 'claude' : 'codex'}`, target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: `provider-dirty-${name === 'Claude Code' ? 'claude' : 'codex'}`, target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    writeFileSync(`${identity.workspacePath}/dirty.txt`, 'race\n');
    const calls: string[] = [];
    const runner: ProcessRunner = {
      run: async (file, args, options) => {
        calls.push(file);
        if (file === 'git') return fixture.runner.run(file, args, options);
        // Keep an accidental provider spawn bounded and deterministic.
        return { stdout: '', stderr: 'unexpected provider spawn', exitCode: 1 };
      },
    };
    await assert.rejects(
      () => make(runner).run({ target, baseSha: fixture.baseSha, workspacePath: identity.workspacePath, workspaceGuard: bootstrap.guard(identity) }),
      (error: unknown) => error instanceof WorkspaceGuardFailure && /tracked|dirty/i.test(error.message),
    );
    assert.equal(calls.some((file) => file === 'claude' || file === 'codex'), false);
  });
  }
});

for (const provider of ['claude', 'codex'] as const) {
  for (const drift of ['head', 'branch', 'push', 'common-dir', 'post-dirty', 'post-branch'] as const) {
    it(`${provider} rejects real ${drift} execution-boundary drift`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      let wrongPush = false;
      const identityRunner: ProcessRunner = { run: async (file, args, options) => {
        if (wrongPush && args.join(' ') === 'remote get-url --all --push origin') return { stdout: 'git@github.com:other/repo.git\n', stderr: '', exitCode: 0 };
        return f.runner.run(file, args, options);
      } };
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: identityRunner });
      const request = { runId: `${provider}-${drift}`, target, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      if (drift === 'head') f.commit(i.workspacePath, 'advance.txt', 'unexpected advance\n');
      if (drift === 'branch') f.git(i.workspacePath, ['switch', '-c', 'foreign']);
      if (drift === 'push') wrongPush = true;
      if (drift === 'common-dir') {
        f.git(f.source, ['worktree', 'remove', i.workspacePath]);
        f.git(f.source, ['clone', f.source, i.workspacePath]);
        f.git(i.workspacePath, ['switch', '-c', i.branch, f.baseSha]);
      }
      let spawns = 0;
      const runner: ProcessRunner = { run: async (file, args, options) => {
        if (file === 'git') return identityRunner.run(file, args, options);
        assert.equal(file, provider);
        spawns++;
        if (drift === 'post-dirty') writeFileSync(`${i.workspacePath}/dirty.txt`, 'must park\n');
        if (drift === 'post-branch') f.git(i.workspacePath, ['switch', '-c', 'foreign']);
        return provider === 'claude'
          ? { stdout: JSON.stringify({ type: 'result', result: 'done', is_error: false }), stderr: '', exitCode: 0 }
          : { stdout: [{ type: 'thread.started', thread_id: 'stub-thread' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, { type: 'turn.completed' }].map((event) => JSON.stringify(event)).join('\n') + '\n', stderr: '', exitCode: 0 };
      } };
      const adapter = provider === 'claude' ? new ClaudeCodeAdapter({ runner }) : new CodexCliAdapter({ runner });
      await assert.rejects(() => adapter.run({ target, baseSha: f.baseSha, workspacePath: i.workspacePath, workspaceGuard: b.guard(i) }), WorkspaceGuardFailure);
      assert.equal(spawns, drift.startsWith('post-') ? 1 : 0);
    });
  }
}
