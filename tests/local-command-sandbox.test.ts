import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';

import { ConfiguredLocalValidationAdapter } from '../src/validation/local-command.js';
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
  it('runs pinned tools with private IPC while denying host files, sockets and IP networking under the macOS seatbelt', { skip: process.platform !== 'darwin' }, async (t) => {
    const owned = request();
    const pnpm = process.env.npm_execpath;
    assert.ok(pnpm !== undefined && path.isAbsolute(pnpm), 'run the Darwin regression through the pinned pnpm test command');
    const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'ths-'));
    dirs.push(outside);
    const sentinel = path.join(outside, 'credential');
    writeFileSync(sentinel, 'must remain outside the sandbox');
    const hostSocket = path.join(outside, 's');
    const hostServer = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { hostServer.once('error', reject); hostServer.listen(hostSocket, resolve); });
    t.after(() => new Promise<void>((resolve, reject) => hostServer.close((error) => error === undefined ? resolve() : reject(error))));
    writeFileSync(path.join(owned.workspacePath, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.5', scripts: { probe: 'node probe.cjs' } }));
    writeFileSync(path.join(owned.workspacePath, 'probe.cjs'), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
require('node:os').type();
assert.equal(require('node:os').availableParallelism(), ${os.availableParallelism()});
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
      revision: 'darwin-real-toolchain-v2', nodeProgram: process.execPath, pnpmProgram: pnpm, gitProgram: git,
      commands: [{ argv: [pnpm, '--version'], timeoutMs: 30_000 }, { argv: [pnpm, 'run', 'probe'], timeoutMs: 30_000 }],
    }).validate(owned);
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(readFileSync(sentinel, 'utf8'), 'must remain outside the sandbox');
  });
});
