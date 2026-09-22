import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter, hasSupportedProductionGitRuntime } from '../src/validation/local-command.js';
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
      });
    }
  });
});
