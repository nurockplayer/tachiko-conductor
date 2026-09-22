import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter, copyDependencyStore, disposePrivateTrees, hasPinnedPnpmAuthority, ignoredManifest } from '../src/validation/local-command.js';
import type { LocalValidationConfiguration } from '../src/adapters/validation.js';
import { TARGET } from './helpers.js';

const dirs: string[] = [];

function request(packageManager?: string) {
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-'));
  dirs.push(workspacePath);
  for (const args of [['init'], ['config', 'user.email', 'validation@example.test'], ['config', 'user.name', 'Validation'], ['add', '.'], ['commit', '-m', 'initial']]) {
    if (args[0] === 'add') {
      writeFileSync(path.join(workspacePath, 'README.md'), 'validation\n');
      if (packageManager !== undefined) writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ packageManager }));
    }
    assert.equal(spawnSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).status, 0);
  }
  const headSha = spawnSync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['-C', workspacePath, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { encoding: 'utf8' }).status, 0);
  return { target: TARGET, headSha, workspacePath };
}

function preExistingPullRequestRequest() {
  return request();
}

function linkedWorktreeRequest() {
  const source = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-linked-source-'));
  const workspaceParent = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-linked-root-'));
  const workspacePath = path.join(workspaceParent, 'worktree');
  // Remove the workspace path from cleanup before its parent so Git's linked
  // worktree metadata is no longer needed when the fixture is torn down.
  dirs.push(workspacePath, workspaceParent, source);
  for (const args of [['init'], ['config', 'user.email', 'validation@example.test'], ['config', 'user.name', 'Validation']]) {
    assert.equal(spawnSync('git', ['-C', source, ...args], { encoding: 'utf8' }).status, 0);
  }
  writeFileSync(path.join(source, 'README.md'), 'validation\n');
  assert.equal(spawnSync('git', ['-C', source, 'add', 'README.md'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', source, 'commit', '-m', 'initial'], { encoding: 'utf8' }).status, 0);
  const headSha = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['-C', source, 'worktree', 'add', '--detach', workspacePath, headSha], { encoding: 'utf8' }).status, 0);
  return { target: TARGET, headSha, workspacePath };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configuration(argv: readonly string[], timeoutMs = 5_000): LocalValidationConfiguration {
  return { revision: 'test-v1', commands: [{ argv, timeoutMs }] };
}

function pinnedPnpm(workspacePath: string, version: string, exitCode = 0): string {
  const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-pnpm-version-'));
  dirs.push(tools);
  const program = path.join(tools, 'pnpm');
  writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\nexit ${exitCode}\n`);
  chmodSync(program, 0o755);
  writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }));
  return program;
}

describe('ConfiguredLocalValidationAdapter', () => {
  it('fails closed when bounded ignored-manifest limits are exceeded', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'ignored\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore fixture'], { encoding: 'utf8' }).status, 0);
    mkdirSync(path.join(owned.workspacePath, 'ignored', 'deep', 'more'), { recursive: true });
    writeFileSync(path.join(owned.workspacePath, 'ignored', 'deep', 'more', 'leaf'), 'deep');
    writeFileSync(path.join(owned.workspacePath, 'ignored', 'tiny'), 'ok');
    writeFileSync(path.join(owned.workspacePath, 'ignored', 'large'), 'x'.repeat(32));
    writeFileSync(path.join(owned.workspacePath, 'ignored', 'sparse'), '');
    truncateSync(path.join(owned.workspacePath, 'ignored', 'sparse'), 128);
    const authority = { path: owned.workspacePath, gitDir: path.join(owned.workspacePath, '.git') };
    assert.notEqual(await ignoredManifest(authority, 'git', { maxEntries: 100, maxDepth: 10, maxFileBytes: 256, maxTotalBytes: 1_024, maxOutputBytes: 1_024 * 1_024 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxEntries: 100, maxDepth: 10, maxFileBytes: 64, maxTotalBytes: 1_024, maxOutputBytes: 1_024 * 1_024 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxEntries: 100, maxDepth: 10, maxFileBytes: 256, maxTotalBytes: 100, maxOutputBytes: 1_024 * 1_024 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxEntries: 1 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxDepth: 1 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxFileBytes: 16 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxTotalBytes: 16 }), null);
    assert.equal(await ignoredManifest(authority, 'git', { maxOutputBytes: 16 }), null);
  });

  it('binds pnpm validation authority to the exact repository packageManager pin', () => {
    const owned = request();
    const matching = pinnedPnpm(owned.workspacePath, '10.34.5');
    const environment = { PATH: path.dirname(matching) };
    assert.equal(hasPinnedPnpmAuthority(owned.workspacePath, matching, environment), true);

    const mismatched = pinnedPnpm(owned.workspacePath, '10.34.4');
    assert.equal(hasPinnedPnpmAuthority(owned.workspacePath, mismatched, { PATH: path.dirname(mismatched) }), false);
    const unprovable = pinnedPnpm(owned.workspacePath, '10.34.5', 71);
    assert.equal(hasPinnedPnpmAuthority(owned.workspacePath, unprovable, { PATH: path.dirname(unprovable) }), false);
    writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.4' }));
    assert.equal(hasPinnedPnpmAuthority(owned.workspacePath, matching, environment), false);
  });

  it('uses a configured Git executable for validator admission and reconstruction probes', async () => {
    const owned = request();
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-configured-git-'));
    dirs.push(tools);
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(actualGit, '');
    const marker = path.join(tools, 'configured-git-ran');
    const configuredGit = path.join(tools, 'git');
    writeFileSync(configuredGit, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexec ${JSON.stringify(actualGit)} "$@"\n`);
    chmodSync(configuredGit, 0o755);
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'configured-git-v1', gitProgram: configuredGit,
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }],
    }).validate(owned);
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(marker), true);
  });

  it('runs admission, reconstruction, and command-workspace Git probes without dispatcher credentials', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitattributes'), 'README.md text\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitattributes'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'exercise immutable attribute probe'], { encoding: 'utf8' }).status, 0);
    owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-sanitized-git-'));
    dirs.push(tools);
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(actualGit, '');
    const log = path.join(tools, 'invocations');
    const configuredGit = path.join(tools, 'git');
    writeFileSync(configuredGit, `#!/bin/sh
for key in GITHUB_TOKEN GH_TOKEN SSH_AUTH_SOCK AWS_SECRET_ACCESS_KEY OPENAI_API_KEY PROVIDER_API_TOKEN UNRELATED_DISPATCHER_SECRET GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; do
  printenv "$key" >/dev/null && exit 92
done
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exec ${JSON.stringify(actualGit)} "$@"
`);
    chmodSync(configuredGit, 0o755);
    const inherited = Object.fromEntries(['GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'PROVIDER_API_TOKEN', 'UNRELATED_DISPATCHER_SECRET', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      GITHUB_TOKEN: 'github-secret', GH_TOKEN: 'gh-secret', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'provider-secret',
      OPENAI_API_KEY: 'api-secret', PROVIDER_API_TOKEN: 'provider-token', UNRELATED_DISPATCHER_SECRET: 'dispatcher-secret',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!false',
    });
    try {
      const result = await new ConfiguredLocalValidationAdapter({
        revision: 'sanitized-git-reconstruction-v1', gitProgram: configuredGit,
        commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }],
      }).validate(owned);
      assert.equal(result.status, 'passed');
      const invocations = readFileSync(log, 'utf8');
      for (const probe of [' ls-files ', ' rev-parse ', ' clone ', ' remote remove', ' ls-tree ', ' cat-file ', ' checkout ']) {
        assert.match(` ${invocations}`, new RegExp(probe));
      }
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('runs trusted-baseline admission and settlement Git probes without dispatcher credentials', async () => {
    const owned = request();
    const baseline = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-'));
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-sanitized-git-'));
    dirs.push(baseline, tools);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
    const actualGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(actualGit, '');
    const log = path.join(tools, 'invocations');
    const configuredGit = path.join(tools, 'git');
    writeFileSync(configuredGit, `#!/bin/sh
for key in GITHUB_TOKEN GH_TOKEN SSH_AUTH_SOCK AWS_SECRET_ACCESS_KEY OPENAI_API_KEY PROVIDER_API_TOKEN UNRELATED_DISPATCHER_SECRET GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0; do
  printenv "$key" >/dev/null && exit 92
done
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exec ${JSON.stringify(actualGit)} "$@"
`);
    chmodSync(configuredGit, 0o755);
    const inherited = Object.fromEntries(['GITHUB_TOKEN', 'GH_TOKEN', 'SSH_AUTH_SOCK', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'PROVIDER_API_TOKEN', 'UNRELATED_DISPATCHER_SECRET', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'].map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      GITHUB_TOKEN: 'github-secret', GH_TOKEN: 'gh-secret', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'provider-secret',
      OPENAI_API_KEY: 'api-secret', PROVIDER_API_TOKEN: 'provider-token', UNRELATED_DISPATCHER_SECRET: 'dispatcher-secret',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!false',
    });
    try {
      const result = await new ConfiguredLocalValidationAdapter({
        revision: 'sanitized-git-baseline-v1', gitProgram: configuredGit, trustedIgnoredBaselinePath: baseline,
        commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }],
      }).validate(owned);
      assert.equal(result.status, 'passed');
      const invocations = readFileSync(log, 'utf8');
      assert.match(` ${invocations}`, / ls-files /);
      assert.match(` ${invocations}`, / rev-parse /);
      assert.match(` ${invocations}`, / ls-files /);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('rejects substituted or mismatched pnpm before a validation command can run', async () => {
    const owned = request('pnpm@10.34.5');
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');
    const pnpm = pinnedPnpm(owned.workspacePath, '10.34.4');
    writeFileSync(pnpm, `#!/bin/sh\nif [ "$1" = --version ]; then printf '%s\\n' 10.34.4; exit 0; fi\n: > ${JSON.stringify(marker)}\n`);
    chmodSync(pnpm, 0o755);

    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'pinned-pnpm-gate-v1', pnpmProgram: pnpm,
      commands: [{ argv: [pnpm, 'test'], timeoutMs: 5_000 }],
    }).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);

    const substituted = await new ConfiguredLocalValidationAdapter({
      revision: 'substituted-pnpm-gate-v1', pnpmProgram: pnpm,
      commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 5_000 }],
    }).validate(owned);
    assert.equal(substituted.status, 'unknown');
    assert.equal(substituted.commands[0]?.outcome, 'malformed');
    assert.equal(existsSync(marker), false);
  });

  it('runs explicit argument-array commands at the real process boundary and retains no output or arguments', async () => {
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', 'process.exit(0)']),
    ).validate(request());

    assert.equal(result.status, 'passed');
    assert.deepEqual(result.commands, [{
      commandIndex: 0, executable: process.execPath, outcome: 'passed', exitCode: 0,
      durationMs: result.commands[0]?.durationMs,
    }]);
    assert.equal(Object.hasOwn(result.commands[0]!, 'argv'), false);
  });

  it('runs candidate validation with only a fresh credential-free runtime environment', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const proof = path.join(proofDir, 'environment.json');
    const inherited = {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      CHATGPT_API_KEY: process.env.CHATGPT_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
      TACHIKO_LUNA_CODEX_HOME: process.env.TACHIKO_LUNA_CODEX_HOME,
      UNRELATED_SECRET: process.env.UNRELATED_SECRET,
    };
    Object.assign(process.env, {
      GITHUB_TOKEN: 'github-secret', SSH_AUTH_SOCK: '/tmp/ssh-agent', CHATGPT_API_KEY: 'chatgpt-secret',
      CODEX_HOME: '/tmp/codex-home', TACHIKO_LUNA_CODEX_HOME: '/tmp/luna-home', UNRELATED_SECRET: 'secret',
    });
    try {
      const result = await new ConfiguredLocalValidationAdapter(configuration([
        process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(proof)}, JSON.stringify(process.env))`,
      ])).validate(owned);
      assert.equal(result.status, 'passed');
      const environment = JSON.parse(readFileSync(proof, 'utf8')) as Record<string, string>;
      // macOS may add __CF_USER_TEXT_ENCODING at exec time. Assert the real
      // denial invariant instead of treating that platform metadata as a
      // credential inherited from the dispatcher.
    assert.match(environment.HOME!, /[/\\]tcv-[^/\\]+[/\\]home$/);
    assert.match(environment.XDG_CACHE_HOME!, /[/\\]tcv-[^/\\]+[/\\]cache$/);
    assert.match(environment.TMPDIR!, /[/\\]tcv-[^/\\]+[/\\]tmp$/);
    assert.equal(environment.TMP, environment.TMPDIR);
    assert.equal(environment.TEMP, environment.TMPDIR);
      assert.equal(environment.GITHUB_TOKEN, undefined);
      assert.equal(environment.SSH_AUTH_SOCK, undefined);
      assert.equal(environment.CHATGPT_API_KEY, undefined);
      assert.equal(environment.CODEX_HOME, undefined);
      assert.equal(environment.TACHIKO_LUNA_CODEX_HOME, undefined);
      assert.equal(environment.UNRELATED_SECRET, undefined);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('freezes ignored state between commands and admits an authorized terminal generated root only at the end', async () => {
    const prepareIgnoredDistWorkspace = () => {
      const owned = request();
      writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'dist/\n');
      assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
      assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore build output'], { encoding: 'utf8' }).status, 0);
      owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      return owned;
    };
    const build = "require('node:fs').mkdirSync('dist', {recursive:true}); require('node:fs').writeFileSync('dist/output.js', 'ok')";
    for (const root of ['dist/', 'dist//', './dist/']) {
      const result = await new ConfiguredLocalValidationAdapter({
        revision: `terminal-generated-root-${root.length}-v1`, terminalGeneratedIgnoredRoots: [root],
        commands: [
          { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 },
          { argv: [process.execPath, '-e', build], timeoutMs: 5_000 },
        ],
      }).validate(prepareIgnoredDistWorkspace());
      assert.equal(result.status, 'passed');
    }

    const rejected = await new ConfiguredLocalValidationAdapter({
      revision: 'terminal-generated-root-reject-v1', terminalGeneratedIgnoredRoots: ['dist'],
      commands: [
        { argv: [process.execPath, '-e', build], timeoutMs: 5_000 },
        { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 },
      ],
    }).validate(prepareIgnoredDistWorkspace());
    assert.equal(rejected.status, 'unknown');
    assert.equal(rejected.commands.length, 2);
    assert.equal(rejected.commands[1]?.outcome, 'unavailable');

    for (const roots of [['./'], ['../'], ['./../'], ['dist/../../'], ['dist', 'dist/']] as const) {
      const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-terminal-root-proof-'));
      dirs.push(proofDir);
      const marker = path.join(proofDir, 'ran');
      const result = await new ConfiguredLocalValidationAdapter({
        revision: 'terminal-generated-root-invalid-v1', terminalGeneratedIgnoredRoots: roots,
        commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 5_000 }],
      }).validate(request());
      assert.equal(result.status, 'unknown');
      assert.equal(existsSync(marker), false);
    }
  });

  it('uses only the configured host browser artifacts, never an ambient browser cache', async () => {
    const owned = request();
    const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-host-playwright-'));
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(artifactRoot, proofDir);
    const proof = path.join(proofDir, 'environment.json');
    const inherited = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/ambient/user/browser-cache';
    try {
      const config: LocalValidationConfiguration = {
        ...configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(proof)}, JSON.stringify(process.env))`]),
        playwrightBrowsersPath: artifactRoot,
      };
      const result = await new ConfiguredLocalValidationAdapter(config).validate(owned);
      assert.equal(result.status, 'passed');
      const environment = JSON.parse(readFileSync(proof, 'utf8')) as Record<string, string>;
      assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, artifactRoot);
      assert.notEqual(environment.PLAYWRIGHT_BROWSERS_PATH, '/ambient/user/browser-cache');
      assert.notEqual(environment.HOME, artifactRoot);
      assert.notEqual(environment.XDG_CACHE_HOME, artifactRoot);
    } finally {
      if (inherited === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = inherited;
    }
  });

  it('maps a non-zero exit to failed compact evidence', async () => {
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', 'process.exit(7)']),
    ).validate(request());

    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'failed');
    assert.equal(result.commands[0]?.exitCode, 7);
  });

  it('maps a bounded timeout to failed evidence', async () => {
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', 'setTimeout(() => {}, 1_000)'], 100),
    ).validate(request());

    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'timed_out');
  });

  it('runs in an isolated exact-HEAD reconstruction and rejects a wrong checkout', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const cwdProof = path.join(proofDir, 'cwd');
    const adapter = new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cwdProof)}, process.cwd())`]),
    );
    const result = await adapter.validate(owned);
    assert.equal(result.status, 'passed');
    assert.notEqual(path.resolve(readFileSync(cwdProof, 'utf8')), realpathSync(owned.workspacePath));

    const clean = request();
    const wrongHead = await adapter.validate({ ...clean, headSha: '0'.repeat(40) });
    assert.equal(wrongHead.status, 'unknown');
  });

  it('validates an ordinary linked worktree with a .git file indirection', async () => {
    const owned = linkedWorktreeRequest();
    assert.equal(readFileSync(path.join(owned.workspacePath, '.git'), 'utf8').startsWith('gitdir:'), true);
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', 'process.exit(0)']),
    ).validate(owned);
    assert.equal(result.status, 'passed');
  });

  it('accepts a linked worktree as the trusted ignored-state baseline', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'node_modules/\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore dependencies'], { encoding: 'utf8' }).status, 0);
    owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const source = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-source-'));
    const baselineParent = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-root-'));
    const baseline = path.join(baselineParent, 'worktree');
    dirs.push(baseline, baselineParent, source);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, source], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', source, 'worktree', 'add', '--detach', baseline, owned.headSha], { encoding: 'utf8' }).status, 0);
    assert.equal(readFileSync(path.join(baseline, '.git'), 'utf8').startsWith('gitdir:'), true);
    for (const workspace of [owned.workspacePath, baseline]) {
      mkdirSync(path.join(workspace, 'node_modules', 'trusted'), { recursive: true });
      writeFileSync(path.join(workspace, 'node_modules', 'trusted', 'index.js'), 'module.exports = true\n');
    }
    const marker = path.join(baselineParent, 'validation-ran');
    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
      trustedIgnoredBaselinePath: baseline,
    }).validate(owned);
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(marker), true);
  });

  it('rejects tracked drift despite worker Git replace, worktree, or include metadata', async () => {
    for (const mode of ['replace', 'worktree', 'include'] as const) {
      const owned = request();
      const proofDir = mkdtempSync(path.join(os.tmpdir(), `tachiko-git-${mode}-proof-`));
      dirs.push(proofDir);
      const marker = path.join(proofDir, 'validation-ran');
      const replacementWorktree = path.join(proofDir, 'replacement-worktree');
      mkdirSync(replacementWorktree);
      if (mode === 'replace') {
        const tree = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim();
        const replacement = spawnSync('git', ['-C', owned.workspacePath, 'commit-tree', tree, '-m', 'replacement'], {
          encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Validation', GIT_AUTHOR_EMAIL: 'validation@example.test', GIT_COMMITTER_NAME: 'Validation', GIT_COMMITTER_EMAIL: 'validation@example.test' },
        }).stdout.trim();
        assert.match(replacement, /^[0-9a-f]{40}$/);
        assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'replace', owned.headSha, replacement], { encoding: 'utf8' }).status, 0);
      } else {
        const config = path.join(owned.workspacePath, '.git', 'config');
        const include = path.join(proofDir, 'included-config');
        if (mode === 'worktree') writeFileSync(config, `${readFileSync(config, 'utf8')}\n[core]\n\tworktree = ${replacementWorktree}\n`);
        else {
          writeFileSync(include, `[core]\n\tworktree = ${replacementWorktree}\n`);
          writeFileSync(config, `${readFileSync(config, 'utf8')}\n[include]\n\tpath = ${include}\n`);
        }
      }
      writeFileSync(path.join(owned.workspacePath, 'README.md'), `${mode} hidden drift\n`);
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
      ).validate(owned);
      assert.equal(result.status, 'unknown', mode);
      assert.equal(existsSync(marker), false, mode);
    }
  });

  it('never executes a candidate-planted fsmonitor while verifying validation Git metadata', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'fsmonitor-ran');
    const monitor = path.join(proofDir, 'fsmonitor');
    writeFileSync(monitor, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nprintf '00000000\\n'\n`);
    chmodSync(monitor, 0o755);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'config', 'core.fsmonitor', monitor], { encoding: 'utf8' }).status, 0);

    const result = await new ConfiguredLocalValidationAdapter(configuration([process.execPath, '-e', 'process.exit(0)'])).validate(owned);

    assert.equal(result.status, 'passed');
    assert.equal(existsSync(marker), false);
  });

  it('fails closed when a command creates an untracked source byte before a later command can consume it', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'second-command-ran');
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'untracked-command-v1',
      commands: [
        { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('worker-created-source.js', 'unexpected')"], timeoutMs: 5_000 },
        { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 5_000 },
      ],
    }).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.equal(result.commands.length, 2);
    assert.equal(result.commands[1]?.outcome, 'unavailable');
    assert.equal(existsSync(marker), false);
  });

  it('uses only a matching host lockfile-bound store for cold offline hydration and freezes its node_modules manifest', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'node_modules/\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'pnpm-lock.yaml', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'lock dependency graph'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const artifact = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dependency-artifact-'));
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-offline-pnpm-'));
    dirs.push(artifact, tools);
    mkdirSync(path.join(artifact, 'store'));
    writeFileSync(path.join(artifact, 'store', 'trusted'), 'immutable');
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex'));
    const pnpm = path.join(tools, 'pnpm');
    const marker = path.join(tools, 'validated');
    writeFileSync(pnpm, `#!/bin/sh\n[ \"$npm_config_offline\" = true ] && [ \"$npm_config_store_dir\" != ${JSON.stringify(path.join(artifact, 'store'))} ] && [ -f \"$npm_config_store_dir/trusted\" ] || exit 91\nprintf changed > \"$npm_config_store_dir/trusted\"\nmkdir -p node_modules/fixture\nprintf fixture > node_modules/fixture/index.js\n`);
    chmodSync(pnpm, 0o755);
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'cold-offline-fixture-v1', dependencyArtifactPath: artifact,
      commands: [
        { argv: [pnpm], timeoutMs: 5_000 },
        { argv: ['/bin/sh', '-c', `[ -f node_modules/fixture/index.js ] && : > ${JSON.stringify(marker)}`], timeoutMs: 5_000 },
      ],
    }).validate({ ...owned, headSha });
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(path.join(artifact, 'store', 'trusted'), 'utf8'), 'immutable');
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), '0'.repeat(64));
    assert.equal((await new ConfiguredLocalValidationAdapter({ revision: 'mismatch-v1', dependencyArtifactPath: artifact, commands: [{ argv: [pnpm], timeoutMs: 5_000 }] }).validate({ ...owned, headSha })).status, 'unknown');
  });

  it('copies dependency artifacts in a child process without dereferencing links', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-source-'));
    const destinationRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-destination-'));
    dirs.push(source, destinationRoot);
    writeFileSync(path.join(source, 'host-artifact'), 'immutable host bytes');
    symlinkSync('host-artifact', path.join(source, 'artifact-link'));

    const destination = path.join(destinationRoot, 'store');
    assert.equal(await copyDependencyStore(source, destination), true);
    assert.equal(readFileSync(path.join(destination, 'host-artifact'), 'utf8'), 'immutable host bytes');
    assert.equal(readlinkSync(path.join(destination, 'artifact-link')), 'host-artifact');
    writeFileSync(path.join(destination, 'host-artifact'), 'private mutation');
    assert.equal(readFileSync(path.join(source, 'host-artifact'), 'utf8'), 'immutable host bytes');
    assert.equal(readlinkSync(path.join(source, 'artifact-link')), 'host-artifact');
    assert.equal(await copyDependencyStore(path.join(source, 'missing'), path.join(destinationRoot, 'failed-store')), false);
  });

  it('bounds a stalled copy child without blocking the event loop and waits for its process group', async () => {
    const source = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-stall-source-'));
    const destinationRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-stall-destination-'));
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-stall-tool-'));
    dirs.push(source, destinationRoot, tools);
    const pidFile = path.join(tools, 'copier.pid');
    const stalledCopier = path.join(tools, 'stalled-copier');
    writeFileSync(stalledCopier, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do :; done\n`);
    chmodSync(stalledCopier, 0o755);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    const startedAt = Date.now();
    try {
      assert.equal(await copyDependencyStore(source, path.join(destinationRoot, 'store'), { nodeProgram: stalledCopier, timeoutMs: 1_000 }), false);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticks > 0);
    assert.ok(Date.now() - startedAt < 5_000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isSafeInteger(pid));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });

  it('cleans every owned private tree in one bounded child invocation', async () => {
    const first = mkdtempSync(path.join(os.tmpdir(), 'tachiko-clean-first-'));
    const second = mkdtempSync(path.join(os.tmpdir(), 'tachiko-clean-second-'));
    dirs.push(first, second);
    writeFileSync(path.join(first, 'first'), 'private');
    mkdirSync(path.join(second, 'nested'));
    writeFileSync(path.join(second, 'nested', 'second'), 'private');
    assert.equal(await disposePrivateTrees([first, second]), true);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
  });

  it('rejects unsafe cleanup targets before invoking a child', async () => {
    for (const targets of [[], ['relative-path'], [path.parse(process.cwd()).root], ['/tmp/invalid\0path']]) {
      assert.equal(await disposePrivateTrees(targets), false);
    }
  });

  it('bounds a stalled cleanup child while the event loop remains responsive', async () => {
    const privateTree = mkdtempSync(path.join(os.tmpdir(), 'tachiko-clean-stall-tree-'));
    const tools = mkdtempSync(path.join(os.tmpdir(), 'tachiko-clean-stall-tool-'));
    dirs.push(privateTree, tools);
    const pidFile = path.join(tools, 'cleaner.pid');
    const stalledCleaner = path.join(tools, 'stalled-cleaner');
    writeFileSync(stalledCleaner, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\ntrap '' TERM\nwhile :; do :; done\n`);
    chmodSync(stalledCleaner, 0o755);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 10);
    const startedAt = Date.now();
    try {
      assert.equal(await disposePrivateTrees([privateTree], { nodeProgram: stalledCleaner, timeoutMs: 1_000 }), false);
    } finally {
      clearInterval(ticker);
    }
    assert.ok(ticks > 0);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.equal(existsSync(pidFile), true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isSafeInteger(pid));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });

  it('fails closed when private cleanup cannot be proven after passed commands', async () => {
    const owned = request();
    const attempted: string[][] = [];
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', 'process.exit(0)']),
      undefined,
      async (paths) => { attempted.push([...paths]); return false; },
    ).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.equal(result.commands[0]?.outcome, 'passed');
    assert.equal(result.commands[1]?.outcome, 'unavailable');
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0]?.length, 2);
    for (const privateTree of attempted[0]!) {
      assert.equal(existsSync(privateTree), true);
      dirs.push(privateTree);
    }
  });

  it('removes its snapshot when validation returns before creating its runtime', async () => {
    const owned = request();
    const attempted: string[][] = [];
    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', 'process.exit(0)']), playwrightBrowsersPath: 'relative-path',
    }, undefined, async (paths) => {
      attempted.push([...paths]);
      dirs.push(...paths);
      return disposePrivateTrees(paths);
    }).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0]?.length, 1);
    assert.equal(existsSync(attempted[0]![0]!), false);
  });

  for (const copyOutcome of ['failed', 'timed_out'] as const) it(`reports unavailable ${copyOutcome} copy evidence before commands and removes its private runtime`, async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'pnpm-lock.yaml'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'lock dependency graph'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const artifact = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-failure-artifact-'));
    const proof = mkdtempSync(path.join(os.tmpdir(), 'tachiko-copy-failure-proof-'));
    dirs.push(artifact, proof);
    mkdirSync(path.join(artifact, 'store'));
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex'));
    const marker = path.join(proof, 'candidate-ran');
    const copier = path.join(proof, 'copier');
    const copierStarted = path.join(proof, 'copier-started');
    writeFileSync(copier, `#!/bin/sh\n: > ${JSON.stringify(copierStarted)}\n${copyOutcome === 'failed' ? 'exit 17' : "trap '' TERM\nwhile :; do :; done"}\n`);
    chmodSync(copier, 0o755);
    let privateStore: string | undefined;
    const adapter = new ConfiguredLocalValidationAdapter({
      revision: 'copy-failure-v1', dependencyArtifactPath: artifact,
      commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 5_000 }],
    }, async (_source, destination) => {
      privateStore = destination;
      mkdirSync(destination);
      writeFileSync(path.join(destination, 'partial'), 'partial copy');
      return copyDependencyStore(_source, destination, { nodeProgram: copier, timeoutMs: 1_000 });
    });

    const result = await adapter.validate({ ...owned, headSha });
    assert.equal(result.status, 'unknown');
    assert.equal(result.commands[0]?.outcome, 'unavailable');
    assert.equal(existsSync(copierStarted), true);
    assert.equal(existsSync(marker), false);
    assert.notEqual(privateStore, undefined);
    assert.equal(existsSync(path.dirname(privateStore!)), false);
  });

  it('admits only explicitly configured workspace dependency roots and freezes their bytes', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'node_modules/\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'workspace dependency fixture'], { encoding: 'utf8' }).status, 0);
    owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const artifact = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workspace-artifact-'));
    dirs.push(artifact);
    mkdirSync(path.join(artifact, 'store'));
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex'));
    const roots = ['node_modules', 'apps/example/node_modules'];
    const hydrate = { argv: [process.execPath, '-e', `const fs=require('node:fs'); for(const root of ${JSON.stringify(roots)}) {fs.mkdirSync(root,{recursive:true});fs.writeFileSync(root+'/fixture.js','frozen');}`], timeoutMs: 5_000 };
    const config = { revision: 'workspace-hydration-v1', dependencyArtifactPath: artifact, commands: [hydrate] };
    assert.equal((await new ConfiguredLocalValidationAdapter(config).validate(owned)).status, 'unknown');
    assert.equal((await new ConfiguredLocalValidationAdapter({ ...config, hydratedDependencyRoots: roots }).validate(owned)).status, 'passed');
    const changed = { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('apps/example/node_modules/fixture.js','changed')"], timeoutMs: 5_000 };
    assert.equal((await new ConfiguredLocalValidationAdapter({ ...config, hydratedDependencyRoots: roots, commands: [hydrate, changed] }).validate(owned)).status, 'unknown');
    for (const invalid of [['../node_modules'], ['apps/../node_modules'], ['dist'], []]) {
      const result = await new ConfiguredLocalValidationAdapter({ ...config, hydratedDependencyRoots: invalid }).validate(owned);
      assert.equal(result.commands[0]?.outcome, 'malformed');
    }
  });

  it('uses a dedicated reconstruction budget rather than a short validation-command timeout', async () => {
    const owned = request();
    const wrapperDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-slow-git-'));
    dirs.push(wrapperDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(realGit, '');
    const wrapper = path.join(wrapperDir, 'git');
    const delayedClone = path.join(wrapperDir, 'clone-delayed');
    writeFileSync(wrapper, `#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = clone ]; then sleep 1.1; : > ${JSON.stringify(delayedClone)}; break; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration(['/bin/sh', '-c', 'exit 0'], 100), gitProgram: wrapper,
    }).validate(owned);
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(delayedClone), true);
  });

  it('uses a dedicated ignored-manifest budget rather than the short Git probe timeout', async () => {
    const owned = request();
    const wrapperDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-slow-git-'));
    dirs.push(wrapperDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(realGit, '');
    const wrapper = path.join(wrapperDir, 'git');
    const delayedStatus = path.join(wrapperDir, 'status-delayed');
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" status "*) sleep 1.1; : > ${JSON.stringify(delayedStatus)} ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration(['/bin/sh', '-c', 'exit 0'], 100), gitProgram: wrapper,
    }).validate(owned);
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(delayedStatus), true);
  });

  it('does not authorize worker-controlled .git bytes through a tracked validation script', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');
    writeFileSync(
      path.join(owned.workspacePath, 'validate.js'),
      `const fs = require('node:fs');\ntry { fs.readFileSync('.git/validation-helper.js'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); } catch { process.exit(71); }\n`,
    );
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'validate.js'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'tracked validation script'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(owned.workspacePath, '.git', 'validation-helper.js'), 'module.exports = true\n');

    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, 'validate.js']),
    ).validate({ ...owned, headSha });

    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.exitCode, 71);
    assert.equal(existsSync(marker), false);
  });

  it('disconnects a reconstructed validator from worker-controlled Git metadata', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');
    writeFileSync(
      path.join(owned.workspacePath, 'validate.js'),
      `const { execFileSync } = require('node:child_process'); const fs = require('node:fs'); try { const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(); fs.readFileSync(origin + '/.git/validation-helper.js'); fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); } catch { process.exit(71); }\n`,
    );
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'validate.js'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'tracked validation script'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(owned.workspacePath, '.git', 'validation-helper.js'), 'module.exports = true\n');

    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, 'validate.js']),
    ).validate({ ...owned, headSha });

    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.exitCode, 71);
    assert.equal(existsSync(marker), false);
  });

  it('rejects committed gitlinks before an incomplete reconstruction can run validation', async () => {
    const owned = request();
    const dependencyHead = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'update-index', '--add', '--cacheinfo', `160000,${dependencyHead},dependency`], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'record dependency gitlink'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');

    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
    ).validate({ ...owned, headSha });

    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);
  });

  it('rejects tracked filter attributes before snapshot checkout can invoke ambient clean or smudge commands', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'smudge-ran');
    const smudge = path.join(proofDir, 'smudge');
    const globalConfig = path.join(proofDir, 'gitconfig');
    writeFileSync(smudge, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(smudge, 0o755);
    writeFileSync(globalConfig, `[filter "marker"]\n\tclean = ${JSON.stringify(smudge)}\n\tsmudge = ${JSON.stringify(smudge)}\n`);
    writeFileSync(path.join(owned.workspacePath, '.gitattributes'), 'probe.txt filter=marker\n');
    writeFileSync(path.join(owned.workspacePath, 'probe.txt'), 'candidate bytes\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitattributes', 'probe.txt'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'add tracked filter'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([process.execPath, '-e', 'process.exit(0)']),
      ).validate({ ...owned, headSha });
      assert.equal(result.status, 'unknown');
      assert.equal(existsSync(marker), false);
    } finally {
      if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
    }
  });

  it('fails closed before validation when ignored worker state could supply absent committed bytes', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), '.env\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore env'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(path.join(owned.workspacePath, '.env'), 'worker-created=true\n');
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
    ).validate({ ...owned, headSha });
    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);
  });

  it('permits only an identical ignored dependency baseline, never new worker ignored state', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'node_modules/\n.env\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore dependencies'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const baseline = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-'));
    dirs.push(baseline);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
    for (const workspace of [baseline, owned.workspacePath]) {
      mkdirSync(path.join(workspace, 'node_modules', 'trusted'), { recursive: true });
      writeFileSync(path.join(workspace, 'node_modules', 'trusted', 'index.js'), 'module.exports = true\n');
    }
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');
    const adapter = new ConfiguredLocalValidationAdapter({
      ...configuration(['/bin/sh', '-c', `: > ${JSON.stringify(marker)}`]),
      trustedIgnoredBaselinePath: baseline,
    });
    assert.equal((await adapter.validate({ ...owned, headSha })).status, 'passed');
    assert.equal(existsSync(marker), true);

    writeFileSync(path.join(owned.workspacePath, '.env'), 'worker-created=true\n');
    assert.equal((await adapter.validate({ ...owned, headSha })).status, 'unknown');
  });

  it('does not execute in a stale configured baseline with an empty ignored manifest', async () => {
    const owned = request();
    const baseline = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-'));
    dirs.push(baseline);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
    writeFileSync(path.join(owned.workspacePath, 'README.md'), 'new implementation\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'README.md'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'new implementation'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');

    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
      trustedIgnoredBaselinePath: baseline,
    }).validate({ ...owned, headSha });

    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);
  });

  it('rejects a trusted baseline whose hidden index flag conceals tracked-byte changes', async () => {
    const owned = request();
    const baseline = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-'));
    dirs.push(baseline);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', baseline, 'update-index', '--assume-unchanged', 'README.md'], { encoding: 'utf8' }).status, 0);
    writeFileSync(path.join(baseline, 'README.md'), 'concealed baseline bytes\n');
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');

    const result = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
      trustedIgnoredBaselinePath: baseline,
    }).validate(owned);

    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);
  });

  it('rejects a worker checkout whose hidden index flag conceals tracked-byte changes', async () => {
    const owned = request();
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'update-index', '--skip-worktree', 'README.md'], { encoding: 'utf8' }).status, 0);
    writeFileSync(path.join(owned.workspacePath, 'README.md'), 'concealed worker bytes\n');
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'validation-ran');

    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
    ).validate(owned);

    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);
  });

  it('accepts a large identical ignored baseline without truncating the Git status manifest', async () => {
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, '.gitignore'), 'ignored-*/\n');
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.gitignore'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'ignore generated directories'], { encoding: 'utf8' }).status, 0);
    const headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const baseline = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-baseline-'));
    dirs.push(baseline);
    assert.equal(spawnSync('git', ['clone', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
    for (const workspace of [baseline, owned.workspacePath]) {
      for (let index = 0; index < 1_000; index += 1) {
        const directory = path.join(workspace, `ignored-${index}`);
        mkdirSync(directory);
        writeFileSync(path.join(directory, 'generated.txt'), `${index}\n`);
      }
    }
    const adapter = new ConfiguredLocalValidationAdapter({
      ...configuration(['/bin/sh', '-c', ':']), trustedIgnoredBaselinePath: baseline,
    });
    assert.equal((await adapter.validate({ ...owned, headSha })).status, 'passed');
  });

  it('runs a configured real command for an explicit verified pre-existing-PR workspace, never the ambient cwd', async () => {
    const existing = preExistingPullRequestRequest();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const cwdProof = path.join(proofDir, 'cwd');
    const adapter = new ConfiguredLocalValidationAdapter({
      revision: 'pre-existing-pr-v1',
      workspacePath: existing.workspacePath,
      commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cwdProof)}, process.cwd())`], timeoutMs: 5_000 }],
    });
    const result = await adapter.validate({ target: TARGET, headSha: existing.headSha });
    assert.equal(result.status, 'passed');
    assert.equal(result.commands[0]?.outcome, 'passed');
    assert.notEqual(path.resolve(readFileSync(cwdProof, 'utf8')), realpathSync(existing.workspacePath));

    assert.equal(
      (await new ConfiguredLocalValidationAdapter({
        revision: 'wrong-repository-v1', workspacePath: existing.workspacePath,
        commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }],
      }).validate({ target: { ...TARGET, repo: 'other' }, headSha: existing.headSha })).status,
      'unknown',
    );
  });

  it('forces a signal-resistant command to settle after the bounded grace period', async () => {
    const startedAt = Date.now();
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], 100),
    ).validate(request());
    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'timed_out');
    assert.ok(Date.now() - startedAt < 2_500);
  });

  it('does not record a timeout until a signal-resistant descendant process group has settled', async () => {
    const owned = request();
    const pidFile = path.join(owned.workspacePath, 'descendant.pid');
    const source = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', source], 1_000),
    ).validate(owned);
    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'timed_out');
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isSafeInteger(pid));
    assert.throws(() => process.kill(pid, 0), (error: unknown) =>
      typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH');
  });

  it('classifies a Windows process-tree timeout as timed_out after taskkill settles it', async () => {
    const owned = request();
    const taskkillDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-taskkill-'));
    dirs.push(taskkillDir);
    const taskkill = path.join(taskkillDir, 'taskkill');
    writeFileSync(taskkill, '#!/bin/sh\nkill -KILL "$2"\n', 'utf8');
    chmodSync(taskkill, 0o755);
    const originalPlatform = process.platform;
    const originalPath = process.env.PATH;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    process.env.PATH = `${taskkillDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([process.execPath, '-e', 'setInterval(() => {}, 1_000)'], 100),
      ).validate(owned);

      assert.equal(result.status, 'failed');
      assert.equal(result.commands[0]?.outcome, 'timed_out');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('fails closed for malformed configuration and an unavailable executable', async () => {
    const malformed = new ConfiguredLocalValidationAdapter({
      revision: 'test-v1', commands: [{ argv: [], timeoutMs: 1 }] as unknown as LocalValidationConfiguration['commands'],
    }).validate(request());
    const unavailable = new ConfiguredLocalValidationAdapter(
      configuration(['definitely-not-an-executable-for-tachiko-validation', '--version']),
    ).validate(request());

    assert.equal((await malformed).status, 'unknown');
    assert.equal((await unavailable).status, 'unknown');
  });
});
