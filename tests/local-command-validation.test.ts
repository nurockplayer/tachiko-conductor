import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter, hasPinnedPnpmAuthority } from '../src/validation/local-command.js';
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

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configuration(argv: readonly string[], timeoutMs = 1_000): LocalValidationConfiguration {
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
  it('runs configured absolute Node and repository-pinned absolute pnpm under the macOS seatbelt', { skip: process.platform !== 'darwin' || !existsSync(path.resolve('node_modules/.bin/pnpm')) }, async () => {
    const owned = request();
    const pnpm = path.resolve('node_modules/.bin/pnpm');
    writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }));
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'package.json'], { encoding: 'utf8' }).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'pin package manager'], { encoding: 'utf8' }).status, 0);
    owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'darwin-real-toolchain-v1', nodeProgram: process.execPath, pnpmProgram: pnpm,
      commands: [{ argv: [pnpm, '--version'], timeoutMs: 30_000 }],
    }).validate(owned);
    assert.equal(result.status, 'passed');
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
      commands: [{ argv: [pnpm, 'test'], timeoutMs: 1_000 }],
    }).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.equal(existsSync(marker), false);

    const substituted = await new ConfiguredLocalValidationAdapter({
      revision: 'substituted-pnpm-gate-v1', pnpmProgram: pnpm,
      commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 1_000 }],
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
      assert.match(environment.HOME!, /tachiko-validation-runtime-/);
      assert.match(environment.XDG_CACHE_HOME!, /tachiko-validation-runtime-/);
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
        { argv: [process.execPath, '-e', "require('node:fs').writeFileSync('worker-created-source.js', 'unexpected')"], timeoutMs: 1_000 },
        { argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], timeoutMs: 1_000 },
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
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex'));
    const pnpm = path.join(tools, 'pnpm');
    const marker = path.join(tools, 'validated');
    writeFileSync(pnpm, `#!/bin/sh\n[ \"$npm_config_offline\" = true ] && [ \"$npm_config_store_dir\" = ${JSON.stringify(path.join(artifact, 'store'))} ] || exit 91\nmkdir -p node_modules/fixture\nprintf fixture > node_modules/fixture/index.js\n`);
    chmodSync(pnpm, 0o755);
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'cold-offline-fixture-v1', dependencyArtifactPath: artifact,
      commands: [
        { argv: [pnpm], timeoutMs: 1_000 },
        { argv: ['/bin/sh', '-c', `[ -f node_modules/fixture/index.js ] && : > ${JSON.stringify(marker)}`], timeoutMs: 1_000 },
      ],
    }).validate({ ...owned, headSha });
    assert.equal(result.status, 'passed');
    assert.equal(existsSync(marker), true);
    writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), '0'.repeat(64));
    assert.equal((await new ConfiguredLocalValidationAdapter({ revision: 'mismatch-v1', dependencyArtifactPath: artifact, commands: [{ argv: [pnpm], timeoutMs: 1_000 }] }).validate({ ...owned, headSha })).status, 'unknown');
  });

  it('uses a dedicated reconstruction budget rather than a short validation-command timeout', async () => {
    const owned = request();
    const wrapperDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-slow-git-'));
    dirs.push(wrapperDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(realGit, '');
    const wrapper = path.join(wrapperDir, 'git');
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = clone ]; then sleep 1.1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const nativeTrue = '/usr/bin/true';
      assert.ok(existsSync(nativeTrue), `expected local absolute native no-op at ${nativeTrue}`);
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([nativeTrue], 100),
      ).validate(owned);
      assert.equal(result.status, 'passed', JSON.stringify(result.commands));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('uses a dedicated ignored-manifest budget rather than the short Git probe timeout', async () => {
    const owned = request();
    const wrapperDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-slow-git-'));
    dirs.push(wrapperDir);
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.notEqual(realGit, '');
    const wrapper = path.join(wrapperDir, 'git');
    writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" status "*) sleep 1.1 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}${path.delimiter}${originalPath ?? ''}`;
    try {
      const nativeTrue = '/usr/bin/true';
      assert.ok(existsSync(nativeTrue), `expected local absolute native no-op at ${nativeTrue}`);
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([nativeTrue], 100),
      ).validate(owned);
      assert.equal(result.status, 'passed', JSON.stringify(result.commands));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
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

  it('rejects tracked filter attributes before snapshot checkout can invoke an ambient smudge command', async () => {
    const owned = request();
    const proofDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-proof-'));
    dirs.push(proofDir);
    const marker = path.join(proofDir, 'smudge-ran');
    const smudge = path.join(proofDir, 'smudge');
    const globalConfig = path.join(proofDir, 'gitconfig');
    writeFileSync(smudge, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`);
    chmodSync(smudge, 0o755);
    writeFileSync(globalConfig, `[filter "marker"]\n\tsmudge = ${JSON.stringify(smudge)}\n`);
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
      commands: [{ argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(cwdProof)}, process.cwd())`], timeoutMs: 1_000 }],
    });
    const result = await adapter.validate({ target: TARGET, headSha: existing.headSha });
    assert.equal(result.status, 'passed');
    assert.equal(result.commands[0]?.outcome, 'passed');
    assert.notEqual(path.resolve(readFileSync(cwdProof, 'utf8')), realpathSync(existing.workspacePath));

    assert.equal(
      (await new ConfiguredLocalValidationAdapter({
        revision: 'wrong-repository-v1', workspacePath: existing.workspacePath,
        commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1_000 }],
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
