import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter, copyDependencyStore, disposePrivateTrees, hasSupportedProductionGitRuntime } from '../src/validation/local-command.js';
import { acquireDispatchInvocationLock, DispatchInvocationLockedError } from '../src/dispatch/invocation-lock.js';
import { TARGET } from './helpers.js';

const dirs: string[] = [];

function request() {
  const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-sandbox-'));
  dirs.push(workspacePath);
  for (const args of [['init'], ['config', 'user.email', 'validation@example.test'], ['config', 'user.name', 'Validation'], ['add', '.'], ['commit', '-m', 'initial']]) {
    if (args[0] === 'add') writeFileSync(path.join(workspacePath, 'README.md'), 'validation\n');
    assert.equal(spawnSync('git', ['-C', workspacePath, ...args], { encoding: 'utf8' }).status, 0);
  }
  const headSha = spawnSync('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(spawnSync('git', ['-C', workspacePath, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git'], { encoding: 'utf8' }).status, 0);
  return { target: TARGET, headSha, workspacePath };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('ConfiguredLocalValidationAdapter sandbox boundary', () => {
  it('keeps a live native macOS owner fenced when only the caller timezone changes', (t) => {
    if (process.platform !== 'darwin') {
      t.skip('native macOS ps timezone regression');
      return;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-lock-native-tz-'));
    const lockPath = path.join(directory, 'once.lock');
    const priorTimezone = process.env.TZ;
    let first: ReturnType<typeof acquireDispatchInvocationLock> | undefined;
    try {
      process.env.TZ = 'Asia/Tokyo';
      first = acquireDispatchInvocationLock({ lockPath, nonce: () => 'native-tokyo-owner' });
      const originalOwner = readFileSync(lockPath, 'utf8');
      assert.match((JSON.parse(originalOwner) as { processStartId: string }).processStartId, /^darwin-ps-start-utc:/,
        'mandatory host coverage must use native ps identity, never the isolated simulation');
      assert.doesNotMatch(process.env.NODE_OPTIONS ?? '', /isolated-lock-preload/);

      process.env.TZ = 'UTC0';
      assert.throws(() => acquireDispatchInvocationLock({
        lockPath, nonce: () => 'native-utc-contender',
      }), DispatchInvocationLockedError);
      assert.equal(readFileSync(lockPath, 'utf8'), originalOwner,
        'a TZ-only environment change cannot reclaim or replace the live canonical owner');
    } finally {
      if (priorTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimezone;
      first?.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects an installed Homebrew Git runtime before executing candidate validation', { skip: process.platform !== 'darwin' }, async (t) => {
    const git = '/opt/homebrew/bin/git';
    if (!existsSync(git)) { t.skip('Homebrew Git is not installed on this host'); return; }
    assert.equal(spawnSync(git, ['--version'], { encoding: 'utf8' }).status, 0);
    assert.equal(hasSupportedProductionGitRuntime(git), false);
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm !== undefined && path.isAbsolute(pnpm));
    const owned = request();
    writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }));
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'package.json']).status, 0);
    assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'pin package manager']).status, 0);
    owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    const result = await new ConfiguredLocalValidationAdapter({
      revision: 'unsupported-git-runtime-v1', nodeProgram: process.execPath, pnpmProgram: pnpm, gitProgram: git,
      commands: [{ argv: [pnpm, '--version'], timeoutMs: 30_000 }],
    }).validate(owned);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.commands, [{ commandIndex: 0, executable: 'git', outcome: 'unavailable', exitCode: null, durationMs: 0 }]);
  });

  it('settles a normal-exit descendant under the real configured pnpm seatbelt before cleanup or later commands', { skip: process.platform !== 'darwin' }, async (t) => {
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm !== undefined && path.isAbsolute(pnpm), 'run the Darwin regression through pinned pnpm');
    for (const mode of ['owned request', 'pre-existing PR workspace'] as const) {
      await t.test(mode, async () => {
        const owned = request();
        const artifact = mkdtempSync(path.join(os.tmpdir(), 'tachiko-sandbox-group-artifact-'));
        dirs.push(artifact);
        const lockfile = 'lockfileVersion: 9.0\n';
        writeFileSync(path.join(owned.workspacePath, 'pnpm-lock.yaml'), lockfile);
        writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({
          packageManager: 'pnpm@10.34.5', scripts: { leak: 'node leak.cjs', later: 'node later.cjs' },
        }));
        writeFileSync(path.join(owned.workspacePath, 'leak.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const ready = path.join(process.env.TMPDIR, 'descendant-ready');
const childSource = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(ready) + ",'ready');setInterval(()=>{},1000)";
const child = require('node:child_process').spawn(process.execPath, ['-e', childSource], { stdio: 'ignore' });
child.unref();
fs.writeFileSync(path.join(process.env.TMPDIR, 'normal-exit-descendant.json'), JSON.stringify({ pid: child.pid, workspace: process.cwd() }));
let checks = 0;
const waiting = setInterval(() => {
  if (fs.existsSync(ready)) { clearInterval(waiting); process.exit(0); }
  if (++checks > 200) process.exit(18);
}, 25);
`);
        writeFileSync(path.join(owned.workspacePath, 'later.cjs'), "require('node:fs').writeFileSync(require('node:path').join(process.env.TMPDIR,'later-command'),'ran');\n");
        assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', '.']).status, 0);
        assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'normal-exit descendant fixture']).status, 0);
        owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        // A real private store copy exposes only this owned runtime path to the
        // host fixture; the descendant writes no host file or network socket.
        mkdirSync(path.join(artifact, 'store'));
        writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), createHash('sha256').update(lockfile).digest('hex'));
        let runtime: string | undefined;
        let descendantPid: number | undefined;
        let cleanupCalls = 0;
        const rememberDescendant = () => {
          if (runtime === undefined) return;
          const receipt = path.join(runtime, 'tmp', 'normal-exit-descendant.json');
          if (existsSync(receipt)) {
            const recorded = JSON.parse(readFileSync(receipt, 'utf8')) as { pid: number; workspace: string };
            descendantPid = recorded.pid;
            assert.equal(path.basename(recorded.workspace), 'workspace');
            const snapshot = path.dirname(recorded.workspace);
            assert.ok(path.basename(snapshot).startsWith('tachiko-validation-snapshot-'));
            dirs.push(snapshot);
          }
        };
        try {
          const result = await new ConfiguredLocalValidationAdapter({
            revision: 'darwin-normal-exit-group-v1', nodeProgram: process.execPath, pnpmProgram: pnpm, gitProgram: '/usr/bin/git',
            dependencyArtifactPath: artifact,
            ...(mode === 'pre-existing PR workspace' ? { workspacePath: owned.workspacePath } : {}),
            commands: [
              { argv: [pnpm, 'run', 'leak'], timeoutMs: 30_000 },
              { argv: [pnpm, 'run', 'later'], timeoutMs: 30_000 },
            ],
          }, async (source, destination) => {
            runtime = path.dirname(destination);
            dirs.push(runtime);
            return copyDependencyStore(source, destination);
          }, async (paths) => {
            cleanupCalls += 1;
            dirs.push(...paths);
            rememberDescendant();
            assert.ok(descendantPid !== undefined && Number.isSafeInteger(descendantPid) && descendantPid > 1);
            assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' }, 'cleanup must follow real owned descendant settlement');
            assert.equal(existsSync(path.join(runtime!, 'tmp', 'later-command')), false);
            return disposePrivateTrees(paths);
          }).validate(mode === 'owned request' ? owned : { target: TARGET, headSha: owned.headSha });
          assert.equal(result.status, 'unknown', JSON.stringify(result));
          assert.equal(result.commands.length, 1, JSON.stringify(result));
          assert.equal(result.commands[0]?.outcome, 'unavailable', JSON.stringify(result));
          assert.equal(result.commands[0]?.exitCode, null);
          assert.equal(cleanupCalls, 1);
          assert.ok(runtime !== undefined);
          assert.equal(existsSync(runtime), false);
        } finally {
          rememberDescendant();
          if (descendantPid !== undefined) {
            assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1 && descendantPid !== process.pid);
            try { process.kill(descendantPid, 'SIGKILL'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            const deadline = Date.now() + 2_000;
            while (Date.now() < deadline) {
              try { process.kill(descendantPid, 0); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
              await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
            assert.throws(() => process.kill(descendantPid!, 0), { code: 'ESRCH' });
          }
        }
      });
    }
  });

  it('runs pinned tools with private IPC while denying host files, sockets and IP networking under the macOS seatbelt', { skip: process.platform !== 'darwin' }, async (t) => {
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm !== undefined && path.isAbsolute(pnpm), 'run the Darwin regression through the pinned pnpm test command');
    const gitFromPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(path.isAbsolute(gitFromPath), 'PATH must resolve an absolute Git executable');
    for (const profile of ['PATH Git', 'CLT Git launcher', 'renamed configured tools'] as const) {
      await t.test(profile, async (profileTest) => {
        let node = process.execPath; let packageManager = pnpm;
        let git = profile === 'PATH Git' ? gitFromPath : '/usr/bin/git';
        if (profile === 'renamed configured tools') {
          const renamedTools = mkdtempSync(path.join(os.tmpdir(), 'tt-'));
          dirs.push(renamedTools);
          node = path.join(renamedTools, 'configured-node');
          packageManager = path.join(renamedTools, 'configured-package-manager');
          git = path.join(renamedTools, 'configured-vcs');
          symlinkSync(process.execPath, node);
          symlinkSync(pnpm, packageManager);
          writeFileSync(git, '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "git version configured-authority"\nelse\n  exec /Library/Developer/CommandLineTools/usr/bin/git "$@"\nfi\n', { mode: 0o700 });
        }
        const owned = request();
        const outside = mkdtempSync(path.join(os.tmpdir(), 'ths-'));
        dirs.push(outside);
        const sentinel = path.join(outside, 'credential');
        writeFileSync(sentinel, 'must remain outside the sandbox');
        const hostSocket = path.join(outside, 's');
        const hostServer = net.createServer((socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(hostSocket, resolve); });
        profileTest.after(() => new Promise<void>((resolve, reject) => hostServer.close((error) => error === undefined ? resolve() : reject(error))));
        writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5', scripts: { probe: 'node probe.cjs' } }));
        writeFileSync(path.join(owned.workspacePath, 'probe.cjs'), `
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
require('node:os').type();
assert.equal(require('node:os').availableParallelism(), ${os.availableParallelism()});
assert.match(execFileSync('git', ['--version'], { encoding: 'utf8' }), /^git version /);
${profile === 'renamed configured tools' ? "assert.equal(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), 'git version configured-authority');" : ''}
assert.equal(execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(), '10.34.5');
const gitFile = path.join(process.cwd(), '.git');
const gitMetadata = fs.statSync(gitFile).isDirectory()
  ? gitFile
  : path.resolve(process.cwd(), fs.readFileSync(gitFile, 'utf8').trim().replace(/^gitdir:\\s*/, ''));
assert.throws(() => fs.writeFileSync(path.join(gitMetadata, 'config'), 'replacement'), /EPERM|EACCES/);
assert.throws(() => fs.renameSync(path.join(gitMetadata, 'config'), path.join(gitMetadata, 'config.replaced')), /EPERM|EACCES/);
assert.throws(() => fs.renameSync(gitMetadata, gitMetadata + '-replaced'), /EPERM|EACCES/);
if (fs.statSync(gitFile).isDirectory()) {
  assert.throws(() => fs.writeFileSync(path.join(gitFile, 'config'), 'replacement'), /EPERM|EACCES/);
  assert.throws(() => fs.renameSync(gitFile, gitFile + '-replaced'), /EPERM|EACCES/);
}
const toolBin = path.resolve(process.env.HOME, '..', 'bin');
for (const name of ['node', 'pnpm', 'git']) {
  const alias = path.join(toolBin, name);
  assert.throws(() => fs.unlinkSync(alias), /EPERM|EACCES/);
  assert.throws(() => fs.renameSync(alias, path.join(process.env.TMPDIR, name)), /EPERM|EACCES/);
  assert.throws(() => fs.writeFileSync(alias, 'replacement'), /EPERM|EACCES/);
}
assert.throws(() => fs.renameSync(toolBin, toolBin + '-replaced'), /EPERM|EACCES/);
assert.throws(() => fs.symlinkSync('/bin/true', path.join(toolBin, 'replacement')), /EPERM|EACCES/);
assert.throws(() => fs.readFileSync(${JSON.stringify(sentinel)}), /EPERM|EACCES/);
assert.throws(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed'), /EPERM|EACCES/);
assert.throws(() => process.kill(${process.pid}, 0), /EPERM/);
const socketPath = path.join(process.env.TMPDIR, 'private.sock');
const server = net.createServer((socket) => { socket.end(); server.close(); });
server.listen(socketPath, () => net.connect(socketPath).on('error', (error) => { throw error; }));
const internet = net.connect({ host: '127.0.0.1', port: 1 });
internet.on('connect', () => { throw new Error('host loopback must remain denied'); });
internet.on('error', (error) => assert.equal(error.code, 'EPERM'));
const hostIpc = net.connect(${JSON.stringify(hostSocket)});
hostIpc.on('connect', () => { throw new Error('host Unix sockets must remain denied'); });
hostIpc.on('error', (error) => assert.equal(error.code, 'EPERM'));
`);
        assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'add', 'package.json', 'probe.cjs'], { encoding: 'utf8' }).status, 0);
        assert.equal(spawnSync('git', ['-C', owned.workspacePath, 'commit', '-m', 'pin package manager'], { encoding: 'utf8' }).status, 0);
        owned.headSha = spawnSync('git', ['-C', owned.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        const result = await new ConfiguredLocalValidationAdapter({
          revision: `darwin-real-toolchain-${profile}-v3`, nodeProgram: node, pnpmProgram: packageManager, gitProgram: git,
          commands: [{ argv: [packageManager, '--version'], timeoutMs: 30_000 }, { argv: [packageManager, 'run', 'probe'], timeoutMs: 30_000 }, { argv: [packageManager, '--version'], timeoutMs: 30_000 }],
        }).validate(owned);
        assert.equal(result.status, 'passed', JSON.stringify(result));
        assert.equal(readFileSync(sentinel, 'utf8'), 'must remain outside the sandbox');

        const baseline = mkdtempSync(path.join(os.tmpdir(), 'tbs-'));
        dirs.push(baseline);
        assert.equal(spawnSync('git', ['clone', '--no-local', owned.workspacePath, baseline], { encoding: 'utf8' }).status, 0);
        const baselineResult = await new ConfiguredLocalValidationAdapter({
          revision: `darwin-baseline-metadata-${profile}-v1`, nodeProgram: node, pnpmProgram: packageManager, gitProgram: git,
          trustedIgnoredBaselinePath: baseline,
          commands: [{ argv: [packageManager, '--version'], timeoutMs: 30_000 }, { argv: [packageManager, 'run', 'probe'], timeoutMs: 30_000 }, { argv: [packageManager, '--version'], timeoutMs: 30_000 }],
        }).validate(owned);
        assert.equal(baselineResult.status, 'passed', JSON.stringify(baselineResult));

        const drifted = request();
        writeFileSync(path.join(drifted.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5', scripts: { drift: 'node drift.cjs' } }));
        writeFileSync(path.join(drifted.workspacePath, 'drift.cjs'), `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync('README.md', 'tracked drift\\n');
const gitFile = path.join(process.cwd(), '.git');
const gitMetadata = fs.statSync(gitFile).isDirectory()
  ? gitFile
  : path.resolve(process.cwd(), fs.readFileSync(gitFile, 'utf8').trim().replace(/^gitdir:\\s*/, ''));
const attempt = (fn) => { try { fn(); } catch {} };
attempt(() => execFileSync('git', ['config', '--local', 'core.worktree', path.join(process.cwd(), 'replacement-worktree')]));
attempt(() => execFileSync('git', ['config', '--local', 'include.path', path.join(process.cwd(), 'replacement-include')]));
attempt(() => fs.renameSync(path.join(gitMetadata, 'config'), path.join(gitMetadata, 'config.replaced')));
attempt(() => fs.renameSync(gitMetadata, gitMetadata + '-replaced'));
attempt(() => execFileSync('git', ['add', 'README.md']));
attempt(() => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['write-tree'], { encoding: 'utf8' }).trim();
  const replacement = execFileSync('git', ['commit-tree', tree, '-p', head], { input: 'replacement\\n', encoding: 'utf8' }).trim();
  execFileSync('git', ['replace', head, replacement]);
});
`);
        assert.equal(spawnSync('git', ['-C', drifted.workspacePath, 'add', 'package.json', 'drift.cjs']).status, 0);
        assert.equal(spawnSync('git', ['-C', drifted.workspacePath, 'commit', '-m', 'add tracked drift probe']).status, 0);
        drifted.headSha = spawnSync('git', ['-C', drifted.workspacePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        const driftResult = await new ConfiguredLocalValidationAdapter({
          revision: `darwin-tracked-drift-${profile}-v1`, nodeProgram: node, pnpmProgram: packageManager, gitProgram: git,
          commands: [{ argv: [packageManager, 'run', 'drift'], timeoutMs: 30_000 }, { argv: [packageManager, '--version'], timeoutMs: 30_000 }],
        }).validate(drifted);
        assert.equal(driftResult.status, 'unknown', JSON.stringify(driftResult));
        assert.equal(driftResult.commands[0]?.outcome, 'passed', JSON.stringify(driftResult));
        assert.equal(driftResult.commands[1]?.outcome, 'unavailable', JSON.stringify(driftResult));
      });
    }
  });
});
