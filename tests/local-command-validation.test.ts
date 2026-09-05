import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('forces a signal-resistant command to settle after the bounded grace period', async () => {
    const startedAt = Date.now();
    const result = await new ConfiguredLocalValidationAdapter(
      configuration([process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], 100),
    ).validate(request());
    assert.equal(result.status, 'failed');
    assert.equal(result.commands[0]?.outcome, 'timed_out');
    assert.ok(Date.now() - startedAt < 2_500);
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
