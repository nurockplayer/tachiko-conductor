import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

  it('runs inside the owned clean worktree and rejects a wrong or modified checkout', async () => {
    const owned = request();
    const adapter = new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', "require('node:fs').writeFileSync('proof.txt', process.cwd())"]),
    );
    const modified = await adapter.validate(owned);
    assert.equal(modified.status, 'unknown');
    assert.equal(existsSync(path.join(owned.workspacePath, 'proof.txt')), true);

    const clean = request();
    const wrongHead = await adapter.validate({ ...clean, headSha: '0'.repeat(40) });
    assert.equal(wrongHead.status, 'unknown');
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
    assert.equal(realpathSync(readFileSync(cwdProof, 'utf8')), realpathSync(existing.workspacePath));

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
      configuration([process.execPath, '-e', source], 100),
    ).validate(owned);
    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'timed_out');
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.ok(Number.isSafeInteger(pid));
    assert.throws(() => process.kill(pid, 0), (error: unknown) =>
      typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ESRCH');
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
