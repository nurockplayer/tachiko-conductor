import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync as fsWriteSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter, hasPinnedPnpmAuthority } from '../src/validation/local-command.js';
import type { LocalValidationConfiguration } from '../src/adapters/validation.js';
import { FileToolOutputStore, InMemoryToolOutputStore, readToolOutput } from '../src/evidence/tool-output.js';
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
    assert.equal(result.commands[0]?.commandIndex, 0);
    assert.equal(result.commands[0]?.executable, process.execPath);
    assert.equal(result.commands[0]?.outcome, 'passed');
    assert.equal(result.commands[0]?.exitCode, 0);
    assert.equal(Object.hasOwn(result.commands[0]!, 'output'), false);
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

  it('preserves direct exit truth when inherited pipes hit the deadline and aborts empty capture operations', async () => {
    const owned = request();
    const evidenceRoot = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-held-pipes-'));
    dirs.push(evidenceRoot);
    const store = new FileToolOutputStore(evidenceRoot, { capacity: 1 });
    const code = 7;
    const marker = 'DIRECT-BEFORE-DEADLINE';
    const script = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: 'inherit' }); process.stdout.write(${JSON.stringify(marker)}); setImmediate(() => process.exit(${code}));`;
    const childApi = createRequire(import.meta.url)('node:child_process') as { spawn: typeof childProcess.spawn };
    const originalSpawn = childApi.spawn;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let selectedDeadline: (() => void) | undefined;
    let selectedTimer: ReturnType<typeof setTimeout> | undefined;
    let observedMarker = '';
    let observedExit = false;
    let ready = false;
    let deliveryQueued = false;
    let watchdogFired = false;
    let commandChild: ReturnType<typeof childProcess.spawn> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const deliverWhenReady = (): void => {
      if (ready || deliveryQueued || !observedExit || !observedMarker.includes(marker) || selectedDeadline === undefined) return;
      // The wrapper's exit listener runs before the adapter's listener. A
      // setImmediate queues delivery after all listeners on that exit event.
      deliveryQueued = true;
      setImmediate(() => {
        if (ready) return;
        ready = true;
        if (selectedTimer !== undefined) originalClearTimeout(selectedTimer);
        selectedDeadline?.();
      });
    };
    childApi.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      commandChild = child;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (observedMarker.length < marker.length) observedMarker += chunk.toString('utf8').slice(0, marker.length - observedMarker.length);
        deliverWhenReady();
      });
      child.once('exit', () => { observedExit = true; deliverWhenReady(); });
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 250) {
        selectedDeadline = () => callback(...args);
        // Keep a real timer handle so production clearTimeout remains real.
        selectedTimer = originalSetTimeout(() => undefined, 60_000);
        watchdog = originalSetTimeout(() => {
          watchdogFired = true;
          // Fail-only cleanup: the assertion below rejects this path even
          // though it delivers the production callback to settle the child.
          selectedDeadline?.();
        }, 5_000);
        return selectedTimer;
      }
      return originalSetTimeout(callback, delay, ...args);
    }) as typeof globalThis.setTimeout;
    let result;
    try {
      result = await new ConfiguredLocalValidationAdapter({
        ...configuration([process.execPath, '-e', script], 250),
        commands: [{ argv: [process.execPath, '-e', script], timeoutMs: 250, captureOutput: true }],
        outputStore: store,
      }).validate(owned);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      childApi.spawn = originalSpawn;
      syncBuiltinESMExports();
      if (watchdog !== undefined) originalClearTimeout(watchdog);
      if (selectedTimer !== undefined) originalClearTimeout(selectedTimer);
      if (!ready && commandChild?.pid !== undefined && process.platform !== 'win32') {
        try { process.kill(-commandChild.pid, 'SIGKILL'); } catch { /* cleanup only after a failed readiness path */ }
      }
    }
    assert.equal(watchdogFired, false, 'independent real watchdog must not provide the expected transition');
    assert.equal(ready, true, 'actual parent-side exit and complete marker must precede deadline delivery');
    assert.equal(result!.status, 'failed');
    assert.equal(result!.commands[0]?.outcome, 'failed');
    assert.equal(result!.commands[0]?.exitCode, code);
    assert.equal(result!.commands[0]?.captureStatus, 'partial', 'forced cleanup cannot claim complete pipe capture');
    assert.equal(result!.commands[0]?.output, undefined, 'incomplete capture cannot publish an artifact');
    assert.ok(result!.commands[0]?.capturePreview?.stdout.preview.includes(marker));
    assert.deepEqual(readdirSync(evidenceRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);

    const missing = new FileToolOutputStore(path.join(evidenceRoot, 'empty-operation'), { capacity: 1 });
    const unavailable = await new ConfiguredLocalValidationAdapter({
      ...configuration([path.join(evidenceRoot, 'missing-command')]),
      commands: [{ argv: [path.join(evidenceRoot, 'missing-command')], timeoutMs: 1_000, captureOutput: true }],
      outputStore: missing,
    }).validate(owned);
    assert.equal(unavailable.status, 'unknown');
    const reusable = missing.beginOperation({ kind: 'after-empty-validation-operation' });
    reusable.abort();
  });

  it('keeps forced-incomplete capture partial even when a custom writer cannot abort', async () => {
    const owned = request();
    const marker = 'CUSTOM-WRITER-FORCED-INCOMPLETE';
    for (const abortBehavior of ['absent', 'noop', 'throws'] as const) {
      const backing = new InMemoryToolOutputStore();
      let finishCalls = 0;
      const outputStore = {
        save: backing.save.bind(backing),
        read: backing.read.bind(backing),
        search: backing.search.bind(backing),
        startCapture(policy: Parameters<typeof backing.startCapture>[0]) {
          const writer = backing.startCapture(policy);
          return {
            write: writer.write.bind(writer),
            finish() { finishCalls += 1; return writer.finish(); },
            ...(abortBehavior === 'absent' ? {} : { abort: abortBehavior === 'noop' ? () => undefined : () => { throw new Error('abort unavailable'); } }),
          };
        },
      } as NonNullable<LocalValidationConfiguration['outputStore']>;
      const script = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' }); process.stdout.write(${JSON.stringify(marker)}); setImmediate(() => process.exit(0));`;
      const result = await new ConfiguredLocalValidationAdapter({
        ...configuration([process.execPath, '-e', script], 1_000),
        commands: [{ argv: [process.execPath, '-e', script], timeoutMs: 1_000, captureOutput: true }],
        outputStore,
      }).validate(owned);
      assert.equal(result.commands[0]?.outcome, 'passed', 'actual direct child exit remains independent of capture cleanup');
      assert.equal(result.commands[0]?.exitCode, 0);
      assert.equal(result.commands[0]?.captureStatus, 'partial');
      assert.equal(result.commands[0]?.output, undefined);
      assert.ok(result.commands[0]?.capturePreview?.stdout.preview.includes(marker));
      assert.equal(finishCalls, 0, `${abortBehavior} abort behavior cannot allow writer.finish after forced invalidation`);
    }
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
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = clone ]; then sleep 1.5; fi\nexec ${JSON.stringify(realGit)} "$@"\n`);
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

  it('persists bounded local-command evidence under one validation-owned operation', async () => {
    const owned = request();
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-evidence-'));
    dirs.push(root);
    const outputStore = new FileToolOutputStore(path.join(root, 'store'));
    let beforeSpawnCalls = 0;
    const evidence = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', "process.stdout.write('VALIDATION-MARKER\\n')"]),
      commands: [{ argv: [process.execPath, '-e', "process.stdout.write('VALIDATION-MARKER\\n')"], timeoutMs: 1_000, captureOutput: true }],
      outputStore,
      outputPolicy: { previewBytes: 16, diagnosticBytes: 64, maxDiagnostics: 4, readBytes: 32 },
    }).validate({ ...owned, runId: 'run-attribution-only', beforeSpawn: () => { beforeSpawnCalls += 1; } });

    const command = evidence.commands[0]!;
    assert.equal(evidence.status, 'passed');
    assert.equal(beforeSpawnCalls, 1);
    assert.equal(command.captureStatus, 'complete');
    assert.ok(command.output);
    const artifact = command.output.artifact;
    assert.ok(artifact.operationId);
    assert.ok(artifact.retainedUntil);
    assert.equal(readToolOutput(command.output, outputStore, { channel: 'stdout' }).text, 'VALIDATION-MARKER\n');
    const operation = JSON.parse(readFileSync(path.join(root, 'store', 'operations', `${artifact.operationId}.json`), 'utf8')) as Record<string, unknown>;
    assert.equal(operation.state, 'closed');
    assert.equal(operation.retainedUntil, artifact.retainedUntil);
    assert.deepEqual(operation.attribution, {
      kind: 'validation', owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
      headSha: owned.headSha, configRevision: 'test-v1', runId: 'run-attribution-only',
    });
  });

  it('captures actual child pipe bytes without replacement decoding before validation evidence persistence', async () => {
    const owned = request();
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-raw-pipes-'));
    dirs.push(root);
    const store = new FileToolOutputStore(path.join(root, 'store'));
    const stdout = Buffer.from([0x4f, 0xff, 0x80, 0xe2, 0x82, 0x42]);
    const stderr = Buffer.from([0xc0, 0xaf, 0xf0, 0x9f, 0x99, 0x82]);
    const script = `process.stdout.write(Buffer.from(${JSON.stringify([...stdout])})); process.stderr.write(Buffer.from(${JSON.stringify([...stderr])}));`;
    const evidence = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', script]),
      commands: [{ argv: [process.execPath, '-e', script], timeoutMs: 2_000, captureOutput: true }],
      outputStore: store,
      outputPolicy: { previewBytes: 32, diagnosticBytes: 64, maxDiagnostics: 4, readBytes: 32 },
    }).validate(owned);
    const command = evidence.commands[0]!;
    assert.equal(command.captureStatus, 'complete');
    assert.ok(command.output);
    const artifact = command.output.artifact;
    assert.deepEqual(readFileSync(path.join(root, 'store', `${artifact.id}.stdout`)), stdout);
    assert.deepEqual(readFileSync(path.join(root, 'store', `${artifact.id}.stderr`)), stderr);
    assert.equal(command.output.stdout.preview, 'O????B');
    assert.equal(command.output.stderr.preview, '??🙂');
    assert.equal(artifact.stdoutBytes, stdout.length);
    assert.equal(artifact.stderrBytes, stderr.length);
    assert.equal(readToolOutput(command.output, store, { channel: 'stdout' }).text, 'O????B');
  });

  it('keeps validation outcome truthful when capture close needs a bounded store-owned retry', async () => {
    const owned = request();
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-terminal-retry-'));
    dirs.push(root);
    let failClosedSync = true;
    const storeRoot = path.join(root, 'store');
    const outputStore = new FileToolOutputStore(storeRoot, { capacity: 1, testFaults: {
      beforeOperationMetadataDirectoryFsync: (value) => {
        if ((value as { readonly state?: string }).state === 'closed' && failClosedSync) {
          failClosedSync = false;
          throw Object.assign(new Error('validation close directory fsync EIO'), { code: 'EIO' });
        }
      },
    } });
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'validation-terminal-retry-v1',
      commands: [{ argv: [process.execPath, '-e', "process.stdout.write('VALIDATION-TERMINAL-MARKER')"], timeoutMs: 1_000, captureOutput: true }],
      outputStore,
    }).validate(owned);

    assert.equal(result.status, 'passed', 'terminal capture metadata failure does not rewrite the real child outcome');
    assert.equal(result.commands[0]?.outcome, 'passed');
    assert.equal(result.commands[0]?.captureStatus, 'unavailable', 'uncommitted references are withheld from returned evidence');
    assert.equal(result.commands[0]?.output, undefined);
    const cleanup = new FileToolOutputStore(storeRoot, { capacity: 1 }).cleanupExpired({ maxSlotProbes: 1, maxDeletions: 8 });
    assert.equal(cleanup.protected, 1, 'retry commits original unexpired retention and does not evict validation evidence');
    const operationFiles = readdirSync(path.join(storeRoot, 'operations')).filter((name) => name.endsWith('.json') && !name.startsWith('slot-') && name !== 'index.json');
    assert.equal(operationFiles.length, 1);
    const metadata = JSON.parse(readFileSync(path.join(storeRoot, 'operations', operationFiles[0]!), 'utf8')) as { readonly state: string; readonly artifacts: readonly [{ readonly id: string }] };
    assert.equal(metadata.state, 'closed');
    assert.equal(readFileSync(path.join(storeRoot, `${metadata.artifacts[0]!.id}.stdout`), 'utf8'), 'VALIDATION-TERMINAL-MARKER');
  });

  it('captures only explicitly opted-in commands and starts the operation only when reached', async () => {
    const owned = request();
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-opt-in-'));
    dirs.push(root);
    const storeRoot = path.join(root, 'store');
    const evidence = await new ConfiguredLocalValidationAdapter({
      revision: 'opt-in-v1',
      commands: [
        { argv: [process.execPath, '-e', "process.stdout.write('TRANSIENT-ONLY')"], timeoutMs: 1_000 },
        { argv: [process.execPath, '-e', "process.stdout.write('EXPLICIT-EVIDENCE')"], timeoutMs: 1_000, captureOutput: true },
      ],
      outputStore: new FileToolOutputStore(storeRoot),
    }).validate(owned);
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.commands[0]?.captureStatus, undefined);
    assert.equal(evidence.commands[0]?.output, undefined);
    assert.equal(evidence.commands[1]?.captureStatus, 'complete');
    assert.equal(readToolOutput(evidence.commands[1]!.output!, new FileToolOutputStore(storeRoot), { channel: 'stdout' }).text, 'EXPLICIT-EVIDENCE');
    assert.equal(readdirSync(storeRoot).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')).length, 2);

    const unreachedRoot = path.join(root, 'unreached-store');
    const unreached = await new ConfiguredLocalValidationAdapter({
      revision: 'unreached-v1',
      commands: [
        { argv: [process.execPath, '-e', 'process.exit(9)'], timeoutMs: 1_000 },
        { argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1_000, captureOutput: true },
      ],
      outputStore: new FileToolOutputStore(unreachedRoot),
    }).validate(owned);
    assert.equal(unreached.status, 'failed');
    assert.equal(existsSync(unreachedRoot), false, 'a later opted-in command that is never reached starts no operation');
  });

  it('observes opted-in output as unavailable when no evidence store is provided', async () => {
    const owned = request();
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'missing-store-v1',
      commands: [{ argv: [process.execPath, '-e', "process.stdout.write('bounded-without-store')"], timeoutMs: 1_000, captureOutput: true }],
    }).validate(owned);
    assert.equal(result.status, 'passed');
    assert.equal(result.commands[0]?.captureStatus, 'unavailable');
    assert.ok(result.commands[0]?.capturePreview?.stdout.preview.includes('bounded-without-store'));
  });

  it('rejects a nonboolean direct-adapter capture authority before spawning', async () => {
    const owned = request();
    let spawned = false;
    const malformed = {
      revision: 'malformed-capture-v1',
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 1_000, captureOutput: 'yes' }],
    } as unknown as LocalValidationConfiguration;
    const result = await new ConfiguredLocalValidationAdapter(malformed).validate({ ...owned, beforeSpawn: () => { spawned = true; } });
    assert.equal(result.status, 'unknown');
    assert.equal(spawned, false);
    assert.equal(result.commands[0]?.outcome, 'malformed');
  });

  it('keeps bounded local validation diagnostics when a real file-backed write fails', async () => {
    const owned = request();
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-capture-fault-'));
    dirs.push(root);
    let writes = 0;
    const outputStore = new FileToolOutputStore(path.join(root, 'store'), { testFaults: {
      writeSync: (fd, bytes, offset, length) => {
        writes += 1;
        if (writes === 1) return fsWriteSync(fd, bytes, offset, Math.max(1, Math.floor(length / 2)));
        return 0;
      },
    } });
    const evidence = await new ConfiguredLocalValidationAdapter({
      ...configuration([process.execPath, '-e', "process.stdout.write('VALIDATION-FAULT-MARKER\\n'); process.stderr.write('ERROR: retained-root-cause\\n')"]),
      commands: [{ argv: [process.execPath, '-e', "process.stdout.write('VALIDATION-FAULT-MARKER\\n'); process.stderr.write('ERROR: retained-root-cause\\n')"], timeoutMs: 1_000, captureOutput: true }],
      outputStore, outputPolicy: { previewBytes: 64, diagnosticBytes: 128, maxDiagnostics: 4, readBytes: 32 },
    }).validate(owned);
    const command = evidence.commands[0]!;
    assert.equal(evidence.status, 'passed', 'evidence sink failure does not change validation truth');
    assert.equal(command.outcome, 'passed');
    assert.equal(command.captureStatus, 'partial');
    assert.equal(command.output, undefined, 'partial bytes are never advertised as a durable artifact');
    assert.ok(command.capturePreview?.stdout.preview.includes('VALIDATION-FAULT-MARKER'));
    assert.ok(command.capturePreview?.diagnostics.some((line) => line.includes('retained-root-cause')));
    assert.deepEqual(readdirSync(path.join(root, 'store')).filter((name) => name.endsWith('.stdout') || name.endsWith('.stderr')), []);
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
