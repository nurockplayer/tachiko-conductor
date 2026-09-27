import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { hasGovernedPublicationConfinement } from '../src/adapters/agent.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
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

  it('does not qualify subclasses or a genuine runtime after execution/preflight methods are replaced', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-qualification-'));
    try {
      const home = path.join(root, 'home'); mkdirSync(home);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      class OverriddenLuna extends IsolatedLunaAdapter {
        override async run() { return { exitStatus: 'failure' as const, summary: 'overridden', durationMs: 0 }; }
      }
      const subclass = new OverriddenLuna({ codexHome: home, timeoutMs: 10_000 });
      assert.equal(hasGovernedPublicationConfinement(subclass), false);
      const replacedRun = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000 });
      (replacedRun as { run: IsolatedLunaAdapter['run'] }).run = async () => ({ exitStatus: 'failure', summary: 'replaced', durationMs: 0 });
      assert.equal(hasGovernedPublicationConfinement(replacedRun), false);
      const replacedPreflight = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000 });
      (replacedPreflight as { prepareGovernedInvocation: IsolatedLunaAdapter['prepareGovernedInvocation'] }).prepareGovernedInvocation = () => ({ status: 'held', reason: 'replacement' });
      assert.equal(hasGovernedPublicationConfinement(replacedPreflight), false);
      const prototypeReplacement = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000 });
      assert.equal(hasGovernedPublicationConfinement(prototypeReplacement), true);
      const originalPrototypeRun = IsolatedLunaAdapter.prototype.run;
      try {
        IsolatedLunaAdapter.prototype.run = async () => ({ exitStatus: 'failure', summary: 'prototype replacement', durationMs: 0 });
        assert.equal(hasGovernedPublicationConfinement(prototypeReplacement), false,
          'changing the prototype after construction cannot change the captured original method identity');
      } finally {
        IsolatedLunaAdapter.prototype.run = originalPrototypeRun;
      }
      assert.equal(hasGovernedPublicationConfinement(prototypeReplacement), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a nested CLI whose public run method was replaced before Luna creates it', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-cli-origin-'));
    const original = Object.getOwnPropertyDescriptor(CodexCliAdapter.prototype, 'run');
    try {
      const home = path.join(root, 'home'); const bin = path.join(root, 'bin');
      mkdirSync(home); mkdirSync(bin);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      let replacementCalls = 0;
      const replacement = async function () { replacementCalls += 1; return { exitStatus: 'success' as const, summary: 'ambient replacement', durationMs: 0 }; };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
      const plan = { runId: 'run-luna-cli-origin', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(plan);
      await bootstrap.prepare({ ...plan, existing: identity });
      const adapter = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000, path: bin });
      Object.defineProperty(CodexCliAdapter.prototype, 'run', { ...original, value: replacement });
      const result = await adapter.run({
        target, baseSha: fixture.baseSha, workspacePath: identity.workspacePath, branch: identity.branch,
        workspaceGuard: bootstrap.guard(identity), authority: 'embedded', instructions: 'bounded task',
        execution: { profile: 'standard', revision: 'profiles-v1', executor: LUNA_ISOLATED_PROVIDER, model: LUNA_ISOLATED_MODEL,
          reasoningEffort: 'high', timeoutMs: 10_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
        runtimeOwnership: { runId: plan.runId, generation: 'luna-generation' },
        governedPublication: { required: true, continuation: false },
      });
      assert.equal(result.exitStatus, 'failure');
      assert.match(result.diagnostics?.join(' ') ?? '', /GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED/);
      assert.equal(replacementCalls, 0, 'the ambient method is rejected before invocation');
    } finally {
      if (original !== undefined) Object.defineProperty(CodexCliAdapter.prototype, 'run', original);
      rmSync(root, { recursive: true, force: true });
      for (const item of fixtures.splice(0)) item.cleanup();
    }
  });

  it('checks original Luna method descriptors without invoking accessors', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-descriptors-'));
    const originalRun = Object.getOwnPropertyDescriptor(IsolatedLunaAdapter.prototype, 'run');
    try {
      const home = path.join(root, 'home'); mkdirSync(home);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const adapter = new IsolatedLunaAdapter({ codexHome: home, timeoutMs: 10_000 });
      const replacement = async () => ({ exitStatus: 'failure' as const, summary: 'replacement', durationMs: 0 });
      let getterCalls = 0;
      Object.defineProperty(adapter, 'run', { configurable: true, get() { getterCalls += 1; return replacement; } });
      assert.equal(hasGovernedPublicationConfinement(adapter), false);
      assert.equal(getterCalls, 0, 'own accessors are rejected by descriptor without execution');
      delete (adapter as { run?: IsolatedLunaAdapter['run'] }).run;

      getterCalls = 0;
      Object.defineProperty(IsolatedLunaAdapter.prototype, 'run', { configurable: true, get() { getterCalls += 1; return replacement; } });
      assert.equal(hasGovernedPublicationConfinement(adapter), false);
      assert.equal(getterCalls, 0, 'prototype accessors are rejected by descriptor without execution');
      assert.equal(hasGovernedPublicationConfinement(adapter), false, 'the descriptor remains unqualified without invoking it again');
      assert.equal(getterCalls, 0);
    } finally {
      if (originalRun !== undefined) Object.defineProperty(IsolatedLunaAdapter.prototype, 'run', originalRun);
      rmSync(root, { recursive: true, force: true });
    }
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
