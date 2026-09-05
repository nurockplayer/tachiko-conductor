import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError } from '../src/adapters/bootstrap.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../src/github/transport.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { TARGET } from './helpers.js';

const tempDirs: string[] = [];
const BASE = 'a'.repeat(40);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function code(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ImplementationBootstrapError && error.code === code;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class RemoteIdentityRunner implements ProcessRunner {
  remoteGood = true;
  constructor(private readonly delegate: ProcessRunner) {}
  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    if (file === 'git' && args.join(' ') === 'remote get-url origin') {
      return { stdout: this.remoteGood ? 'git@github.com:acme/widgets.git\n' : 'git@example.invalid:acme/widgets.git\n', stderr: '', exitCode: 0 };
    }
    if (file === 'git' && args.join(' ') === 'remote get-url --all --push origin') {
      return { stdout: this.remoteGood ? 'https://github.com/acme/widgets.git\n' : 'https://github.com/acme/other.git\n', stderr: '', exitCode: 0 };
    }
    return this.delegate.run(file, args, options);
  }
}

describe('GitWorktreeBootstrap', () => {
  it('rejects nested ..workspaces but accepts a sibling root with the same ordinary child name', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-path-'));
    tempDirs.push(root);
    const source = path.join(root, 'source');
    mkdirSync(source);
    assert.throws(
      () => new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot: path.join(source, '..workspaces') }),
      code(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.INVALID_REQUEST),
    );
    assert.doesNotThrow(() => new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot: path.join(root, '..workspaces') }));
  });

  it('rejects divergent effective push destinations before fetching or creating a workspace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-remote-'));
    tempDirs.push(root);
    const source = path.join(root, 'source');
    mkdirSync(source);
    const calls: readonly string[][] = [];
    const runner: ProcessRunner = {
      async run(_file, args) {
        (calls as string[][]).push([...args]);
        if (args.join(' ') === 'check-ref-format --branch main') return { stdout: 'main\n', stderr: '', exitCode: 0 };
        if (args.join(' ') === 'remote get-url origin') return { stdout: 'git@github.com:acme/widgets.git\n', stderr: '', exitCode: 0 };
        if (args.join(' ') === 'remote get-url --all --push origin') return { stdout: 'git@github.com:acme/widgets.git\nhttps://github.com/acme/other.git\n', stderr: '', exitCode: 0 };
        throw new Error(`unexpected command ${args.join(' ')}`);
      },
    };
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot: path.join(root, 'workspaces'), runner });
    await assert.rejects(
      () => bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE }),
      code(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.REPOSITORY_MISMATCH),
    );
    assert.equal((calls as string[][]).some((args) => args[0] === 'fetch'), false);
  });

  it('proves common-dir/branch/remote identity, recovers only the exact stale registration, and rechecks remote at guard time', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-real-'));
    tempDirs.push(root);
    const remote = path.join(root, 'remote.git');
    const source = path.join(root, 'source');
    const workspaceRoot = path.join(root, 'workspaces');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    mkdirSync(source);
    git(source, ['init', '-b', 'main']);
    writeFileSync(path.join(source, 'README.md'), 'base\n');
    git(source, ['add', 'README.md']);
    git(source, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'base']);
    git(source, ['remote', 'add', 'origin', `file://${remote}`]);
    git(source, ['push', '-u', 'origin', 'main']);
    const baseSha = git(source, ['rev-parse', 'HEAD']);
    const { NodeProcessRunner } = await import('../src/github/transport.js');
    const runner = new RemoteIdentityRunner(new NodeProcessRunner());
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot, runner });
    const identity = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha });
    await bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha, existing: identity });
    writeFileSync(path.join(identity.workspacePath, 'feature.txt'), 'done\n');
    git(identity.workspacePath, ['add', 'feature.txt']);
    git(identity.workspacePath, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'feature']);
    git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    const headSha = git(identity.workspacePath, ['rev-parse', 'HEAD']);
    assert.deepEqual(await bootstrap.verifyDurable({ identity, expectedHeadSha: headSha }), { headSha, branch: identity.branch });

    runner.remoteGood = false;
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid('after-execution'); }, code(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.REPOSITORY_MISMATCH));
    runner.remoteGood = true;
    // Fixture-only simulation of an old clean local replica: recovery may only
    // move it through the implementation's ff-only path.
    git(identity.workspacePath, ['reset', '--hard', baseSha]);
    const fastForwarded = new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot, runner });
    await fastForwarded.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: headSha } });
    assert.equal(git(identity.workspacePath, ['rev-parse', 'HEAD']), headSha);
    rmSync(identity.workspacePath, { recursive: true, force: true });
    const restarted = new GitWorktreeBootstrap({ repositoryRoot: source, workspaceRoot, runner });
    await restarted.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: headSha } });
    assert.deepEqual(await restarted.verifyDurable({ identity, expectedHeadSha: headSha }), { headSha, branch: identity.branch });
  });
});
