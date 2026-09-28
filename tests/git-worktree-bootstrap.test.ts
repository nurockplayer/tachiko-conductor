import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError } from '../src/adapters/bootstrap.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../src/github/transport.js';
import { ExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { TARGET } from './helpers.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';

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

  it('recovers an authorized descendant after the original named base ref is removed', async () => {
    const fixture = createBootstrapGitFixture();
    try {
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId: 'historical-base-ref-removed', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request);
      const authorizedHead = fixture.commit(fixture.source, 'authorized.txt', 'authorized recovery\n');
      fixture.git(fixture.source, ['push', 'origin', `${authorizedHead}:refs/heads/${identity.branch}`]);
      fixture.git(fixture.remote, ['branch', '-D', fixture.branch]);

      const recovered = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      await recovered.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: authorizedHead } });
      assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), authorizedHead);
      assert.equal(fixture.git(identity.workspacePath, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '');
    } finally { fixture.cleanup(); }
  });

  it('refuses immutable-base fetch when the remote no longer serves a locally cached planned commit', async () => {
    const fixture = createBootstrapGitFixture();
    try {
      let preparing = false;
      let exactBaseFetches = 0;
      let beforeMutationCalls = 0;
      let failedFetchExit: number | undefined;
      let immutableFetchArgs: string[] | undefined;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          const immutableFetch = preparing && file === 'git' && args[0] === 'fetch' && args.includes('origin') && args.at(-1) === fixture.baseSha;
          if (immutableFetch) {
            exactBaseFetches += 1;
            immutableFetchArgs = [...args];
            const original = options.beforeSpawn;
            const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: () => {
              beforeMutationCalls += 1;
              original?.();
            } });
            failedFetchExit = result.exitCode;
            return result;
          }
          return fixture.runner.run(file, args, options);
        },
      };
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const request = { runId: 'linked-base-remote-unavailable', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request);
      assert.equal(fixture.git(fixture.source, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '', 'the source checkout still caches the planned commit');
      fixture.git(fixture.remote, ['update-ref', '-d', `refs/heads/${fixture.branch}`]);
      fixture.git(fixture.remote, ['reflog', 'expire', '--expire=now', '--all']);
      fixture.git(fixture.remote, ['gc', '--prune=now']);
      assert.throws(() => fixture.git(fixture.remote, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]),
        (error: unknown) => error instanceof Error,
        'the isolated bare remote no longer has the planned commit object');
      assert.equal(fixture.git(fixture.source, ['cat-file', '-e', `${fixture.baseSha}^{commit}`]), '',
        'the trusted source still has its local copy before prepare');
      preparing = true;

      await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity }), (error: unknown) =>
        error instanceof ImplementationBootstrapError && error.code === IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COMMAND_FAILED);

      assert.equal(exactBaseFetches, 1, 'prepare attempted exactly the authorized immutable-base fetch');
      assert.ok(immutableFetchArgs?.includes('--refetch'), 'the immutable-base import bypasses cached-object negotiation');
      assert.equal(beforeMutationCalls, 1, 'the actual failed fetch crossed its synchronous admission callback');
      assert.notEqual(failedFetchExit, 0, 'the remote rejected the unavailable object despite the local cache');
      assert.equal(existsSync(identity.workspacePath), false, 'no worktree was created after the failed fetch');
      assert.equal(fixture.git(fixture.source, ['branch', '--list', identity.branch]).trim(), '', 'no local publication ref was created');
      assert.equal(fixture.commands.slice(fixture.commands.findIndex(({ args }) => args[0] === 'fetch')).some(({ args }) =>
        args[0] === 'worktree' || args[0] === 'update-ref' || args[0] === 'merge'), false,
      'no ref, worktree, or merge effect followed the unavailable-base fetch');
    } finally { fixture.cleanup(); }
  });

  it('rejects a wrong FETCH_HEAD after the actual immutable-base fetch before any worktree or ref mutation', async () => {
    const fixture = createBootstrapGitFixture();
    try {
      let preparing = false;
      let exactBaseFetches = 0;
      let beforeMutationCalls = 0;
      let wrongFetchHead: string | undefined;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          const immutableFetch = preparing && file === 'git' && args[0] === 'fetch' && args.includes('origin') && args.at(-1) === fixture.baseSha;
          if (immutableFetch) {
            exactBaseFetches += 1;
            const original = options.beforeSpawn;
            const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: () => {
              beforeMutationCalls += 1;
              original?.();
            } });
            if (result.exitCode === 0) {
              wrongFetchHead = fixture.commit(fixture.source, 'wrong-fetch-head.txt', 'different cached commit\n');
              writeFileSync(path.join(fixture.source, '.git', 'FETCH_HEAD'), `${wrongFetchHead}\t\tfixture wrong fetch head\n`);
            }
            return result;
          }
          return fixture.runner.run(file, args, options);
        },
      };
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const request = { runId: 'linked-base-wrong-fetch-head', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const identity = await bootstrap.plan(request);
      preparing = true;

      await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity }), (error: unknown) =>
        error instanceof ImplementationBootstrapError && error.code === IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.BASE_DRIFT);

      assert.notEqual(wrongFetchHead, undefined);
      assert.notEqual(wrongFetchHead, fixture.baseSha);
      assert.equal(fixture.git(fixture.source, ['rev-parse', 'FETCH_HEAD']), wrongFetchHead, 'the negative case observes the wrong fetched identity');
      assert.equal(exactBaseFetches, 1);
      assert.equal(beforeMutationCalls, 1, 'the real immutable-base fetch crossed its synchronous admission callback');
      assert.equal(existsSync(identity.workspacePath), false);
      assert.equal(fixture.git(fixture.source, ['branch', '--list', identity.branch]).trim(), '');
      const commands = fixture.commands.slice(fixture.commands.findIndex(({ args }) => args[0] === 'fetch'));
      assert.equal(commands.some(({ args }) => args[0] === 'worktree' || args[0] === 'update-ref' || args[0] === 'merge'), false,
        'the wrong FETCH_HEAD is rejected before subsequent worktree or ref effects');
    } finally { fixture.cleanup(); }
  });
});

describe('GitWorktreeBootstrap actual mutation callbacks', () => {
  for (const boundary of ['merge', 'update-ref', 'worktree-add'] as const) {
    it(`refuses ${boundary} after injected asynchronous preparation without executing that child`, async () => {
      const fixture = createBootstrapGitFixture();
      const identityRequest = { runId: `effect-${boundary}`, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const entered = (() => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; })();
      const resume = (() => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; })();
      const refusal = new ExecutionAdmissionRefusal(`blocked ${boundary}`, false);
      let selected = false;
      let armed = false;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          const matches = file === 'git' && (boundary === 'merge'
            ? args[0] === 'merge' && args[1] === '--ff-only'
            : boundary === 'update-ref' ? args[0] === 'update-ref' : args[0] === 'worktree' && args[1] === 'add');
          if (matches && !selected) {
            selected = true;
            entered.resolve();
            await resume.promise;
            armed = true;
          }
          options.beforeSpawn?.();
          return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
        },
      };
      try {
        const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
        const identity = await bootstrap.plan(identityRequest);
        let expectedHead = fixture.baseSha;
        if (boundary === 'merge') {
          await bootstrap.prepare({ ...identityRequest, existing: identity });
          expectedHead = fixture.commit(identity.workspacePath, 'recovery.txt', 'remote recovery\n');
          fixture.git(identity.workspacePath, ['push', 'origin', identity.branch]);
          fixture.git(identity.workspacePath, ['reset', '--hard', fixture.baseSha]);
        } else {
          fixture.git(fixture.source, ['push', 'origin', `${fixture.baseSha}:refs/heads/${identity.branch}`]);
        }
        const expectedTree = boundary === 'merge' ? fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']) : null;
        const prepare = bootstrap.prepare({
          ...identityRequest, existing: identity,
          ...(boundary === 'merge' ? { recoveryAuthority: { expectedHeadSha: expectedHead } } : {}),
          beforeMutation: () => { if (armed) throw refusal; },
        });
        await entered.promise;
        resume.resolve();
        await assert.rejects(prepare, (error) => error === refusal, 'the original tagged refusal remains primary');
        assert.equal(selected, true);
        assert.equal(fixture.commands.some(({ args }) => boundary === 'merge'
          ? args[0] === 'merge' && args[1] === '--ff-only'
          : boundary === 'update-ref' ? args[0] === 'update-ref' : args[0] === 'worktree' && args[1] === 'add'), false,
        'the blocked child never reached the real runner');
        if (boundary === 'merge') {
          assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), expectedTree, 'the blocked merge leaves the local checkpoint unchanged');
          assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.branch}`]), expectedHead, 'the prior remote checkpoint remains intact');
        } else if (boundary === 'update-ref') {
          assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.branch}`]), fixture.baseSha, 'the prior remote checkpoint remains intact');
          assert.equal(fixture.git(fixture.source, ['branch', '--list', identity.branch]), '', 'the blocked update-ref does not create a local branch');
        } else {
          assert.equal(existsSync(identity.workspacePath), false, 'worktree creation is blocked after its permitted ref update');
          assert.equal(fixture.git(fixture.source, ['rev-parse', `refs/heads/${identity.branch}`]), fixture.baseSha, 'the preceding authorized ref update is retained');
        }
      } finally {
        resume.resolve();
        fixture.cleanup();
      }
    });
  }
});
