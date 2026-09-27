import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { hasGovernedPublicationConfinement } from '../src/adapters/agent.js';
import { IsolatedLunaAdapter, LUNA_ISOLATED_MODEL, LUNA_ISOLATED_PROVIDER, isolatedLunaEnvironment, parseTrustedLunaConfig } from '../src/agents/luna-isolated.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';

describe('qualified Luna runtime configuration', () => {
  const fixtures: BootstrapGitFixture[] = [];
  it('qualifies and runs only with the exact source-prepared standalone guard', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-governed-'));
    try {
      const home = path.join(root, 'qualified-home');
      const bin = path.join(root, 'bin');
      mkdirSync(home); mkdirSync(bin);
      const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const plan = { runId: 'run-luna', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(plan);
      await bootstrap.prepare({ ...plan, existing: identity });
      const workspacePath = identity.workspacePath;
      writeFileSync(path.join(home, 'config.toml'), [
        'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"',
        '[features]', 'plugins = false', 'apps = false', 'mcp_servers = {}', 'web_search = false',
        '[sandbox_workspace_write]', 'network_access = false', '',
      ].join('\n'));
      const head = fixture.baseSha;
      const codex = path.join(bin, 'codex');
      const spawnMarker = path.join(root, 'codex-spawned');
      writeFileSync(codex, `#!/bin/sh\nprintf x > '${spawnMarker}'\nprintf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'luna-thread' })}' '${JSON.stringify({ type: 'turn.started' })}' '${JSON.stringify({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'bounded result' } })}' '${JSON.stringify({ type: 'turn.completed' })}'\n`);
      chmodSync(codex, 0o755);
      const git = path.join(bin, 'git');
      writeFileSync(git, `#!/bin/sh\n[ "$1" = rev-parse ] && [ "$2" = HEAD ] || exit 91\nprintf '%s\\n' '${head}'\n`);
      chmodSync(git, 0o755);

      const adapter = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000, path: bin });
      assert.equal(hasGovernedPublicationConfinement(adapter), true);
      const result = await adapter.run({
        target,
        baseSha: fixture.baseSha, workspacePath, branch: identity.branch, workspaceGuard: bootstrap.guard(identity), authority: 'embedded',
        instructions: 'Implement the bounded task.',
        execution: { profile: 'standard', revision: 'profiles-v1', executor: LUNA_ISOLATED_PROVIDER, model: LUNA_ISOLATED_MODEL, reasoningEffort: 'high', timeoutMs: 10_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        runtimeOwnership: { runId: 'run-luna', generation: 'luna-generation' },
        governedPublication: { required: true, continuation: false },
      });

      assert.equal(result.exitStatus, 'success', result.summary);
      assert.equal(result.headSha, head);
      assert.equal(result.executor?.provider, 'codex-cli', 'the confined Luna wrapper reports its actual inner CLI transport');
      assert.equal(result.executor?.sessionId, 'luna-thread');
      assert.equal(existsSync(spawnMarker), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const fixture of fixtures.splice(0)) fixture.cleanup();
    }
  });

  it('holds missing and copied guards before any model process', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-unqualified-'));
    try {
      const home = path.join(root, 'home'); const bin = path.join(root, 'bin'); const workspace = path.join(root, 'plain');
      mkdirSync(home); mkdirSync(bin); mkdirSync(workspace);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const marker = path.join(root, 'spawned'); const codex = path.join(bin, 'codex');
      writeFileSync(codex, `#!/bin/sh\nprintf x > '${marker}'\n`); chmodSync(codex, 0o755);
      const adapter = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000, path: bin });
      const request = {
        target: { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 }, baseSha: fixture.baseSha,
        workspacePath: workspace, branch: 'tachiko/fake', authority: 'embedded' as const, instructions: 'task',
        execution: { profile: 'standard', revision: 'profiles-v1', executor: LUNA_ISOLATED_PROVIDER, model: LUNA_ISOLATED_MODEL, reasoningEffort: 'high', timeoutMs: 10_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' } as const,
        runtimeOwnership: { runId: 'run-luna', generation: 'generation' }, governedPublication: { required: true as const, continuation: false },
      };
      const missing = await adapter.run(request);
      assert.equal(missing.exitStatus, 'failure');
      assert.equal(existsSync(marker), false);
      const fakeGuard = Object.freeze({ assertValid() {} });
      const copied = await adapter.run({ ...request, workspaceGuard: fakeGuard });
      assert.equal(copied.exitStatus, 'failure');
      assert.equal(existsSync(marker), false);
    } finally { rmSync(root, { recursive: true, force: true }); for (const fixture of fixtures.splice(0)) fixture.cleanup(); }
  });

  it('pins all capability-denying overrides after repository configuration', () => {
    const config = parseTrustedLunaConfig('tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
    assert.deepEqual(config, ['features.plugins=false', 'features.apps=false', 'mcp_servers={}', 'web_search=false', 'sandbox_workspace_write.network_access=false']);
  });
  it('rejects an incomplete trusted configuration before any model spawn', () => {
    assert.throws(() => parseTrustedLunaConfig('tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\n'), /explicitly disable/);
  });
  it('supplies a trusted commit identity without ambient user Git configuration', () => {
    const env = isolatedLunaEnvironment('/tmp/qualified-luna', '/usr/bin');
    assert.equal(env.HOME, '/tmp/qualified-luna');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_AUTHOR_EMAIL, 'tachiko-luna@localhost');
    assert.equal(env.GIT_COMMITTER_NAME, 'Tachiko Isolated Luna');
  });
  it('creates a fresh isolated commit using only the supplied identity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-identity-'));
    try {
      const home = path.join(root, 'qualified-home');
      const repository = path.join(root, 'repository');
      mkdirSync(home); mkdirSync(repository);
      const env = isolatedLunaEnvironment(home, process.env.PATH);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository, env, stdio: 'ignore' });
      writeFileSync(path.join(repository, 'fresh.txt'), 'isolated\n');
      execFileSync('git', ['add', 'fresh.txt'], { cwd: repository, env, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'fresh isolated identity'], { cwd: repository, env, stdio: 'ignore' });
      assert.equal(execFileSync('git', ['show', '-s', '--format=%an <%ae>'], { cwd: repository, env, encoding: 'utf8' }).trim(), 'Tachiko Isolated Luna <tachiko-luna@localhost>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
