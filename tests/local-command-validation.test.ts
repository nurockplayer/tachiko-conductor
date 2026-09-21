import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter } from '../src/validation/local-command.js';
import type { LocalValidationConfiguration } from '../src/adapters/validation.js';
import { TARGET } from './helpers.js';

const dirs: string[] = [];

function request() {
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-'));
  dirs.push(workspacePath);
  for (const args of [['init'], ['config', 'user.email', 'validation@example.test'], ['config', 'user.name', 'Validation'], ['add', '.'], ['commit', '-m', 'initial']]) {
    if (args[0] === 'add') writeFileSync(path.join(workspacePath, 'README.md'), 'validation\n');
    assert.equal(spawnSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).status, 0);
  }
  const headSha = spawnSync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  return { target: TARGET, headSha, workspacePath };
}

function preExistingPullRequestRequest() {
  const value = request();
  assert.equal(spawnSync('git', ['-C', value.workspacePath, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { encoding: 'utf8' }).status, 0);
  return value;
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function configuration(argv: readonly string[], timeoutMs = 1_000): LocalValidationConfiguration {
  return { revision: 'test-v1', commands: [{ argv, timeoutMs }] };
}

describe('ConfiguredLocalValidationAdapter', () => {
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
      assert.deepEqual(Object.keys(environment).sort(), ['CI', 'HOME', 'PATH', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME']);
      assert.match(environment.HOME!, /tachiko-validation-runtime-/);
      assert.equal(environment.GITHUB_TOKEN, undefined);
    } finally {
      for (const [key, value] of Object.entries(inherited)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
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
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([process.execPath, '-e', 'process.exit(0)'], 100),
      ).validate(owned);
      assert.equal(result.status, 'passed');
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
      const result = await new ConfiguredLocalValidationAdapter(
        configuration([process.execPath, '-e', 'process.exit(0)'], 100),
      ).validate(owned);
      assert.equal(result.status, 'passed');
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
      ...configuration([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]),
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
      ...configuration([process.execPath, '-e', 'process.exit(0)']), trustedIgnoredBaselinePath: baseline,
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
