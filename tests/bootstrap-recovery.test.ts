import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError } from '../src/adapters/bootstrap.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';

const fixtures: BootstrapGitFixture[] = [];
const target = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
const errorCode = (code: string) => (error: unknown) => error instanceof ImplementationBootstrapError && error.code === code;

afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

describe('real bootstrap recovery contracts', () => {
  it('proves an unlocked exact registration before a missing-workspace CAS', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'locked-cas', target, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    const remote = fixture.commit(identity.workspacePath, 'feature.txt', 'remote advance\n');
    fixture.git(identity.workspacePath, ['push', 'origin', identity.branch]);
    fixture.git(identity.workspacePath, ['reset', '--hard', fixture.baseSha]);
    fixture.git(fixture.source, ['worktree', 'lock', identity.workspacePath]);
    rmSync(identity.workspacePath, { recursive: true, force: true });
    const before = fixture.commands.length;
    await assert.rejects(() => bootstrap.prepare({ ...request, existing: identity, recoveryAuthority: { expectedHeadSha: remote } }));
    assert.equal(fixture.git(fixture.source, ['rev-parse', `refs/heads/${identity.branch}`]), fixture.baseSha);
    assert.equal(fixture.commands.slice(before).some((c) => c.args[0] === 'update-ref'), false);
  });
  it('rejects review verification when the reviewed base has no tree progress', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'review-no-progress', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'review-no-progress', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    fixture.git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    await assert.rejects(
      () => bootstrap.verifyDurable({ identity, expectedHeadSha: fixture.baseSha, progressBaseSha: fixture.baseSha }),
      errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.HEAD_MISMATCH),
    );
  });

  it('accepts a real descendant commit and rejects a divergent recovery head', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'recovery-descendant', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'recovery-descendant', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'feature.txt', 'implemented\n');
    fixture.git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    assert.deepEqual(await bootstrap.verifyDurable({ identity, expectedHeadSha: head }), { headSha: head, branch: identity.branch });
    fixture.git(identity.workspacePath, ['reset', '--hard', fixture.baseSha]);
    fixture.commit(identity.workspacePath, 'local-only.txt', 'diverged\n', 'diverged local recovery');
    await assert.rejects(
      () => bootstrap.prepare({ runId: 'recovery-descendant', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: head } }),
      errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.STALE_IDENTITY),
    );
  });

  it('rejects an initial recovery head that is unrelated to immutable B', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'orphan-recovery', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    const tree = fixture.git(fixture.source, ['rev-parse', `${fixture.baseSha}^{tree}`]);
    const orphan = execFileSync('git', ['commit-tree', tree, '-m', 'unrelated orphan'], { cwd: fixture.source, encoding: 'utf8', input: '' }).trim();
    fixture.git(fixture.source, ['push', 'origin', `${orphan}:refs/heads/${identity.branch}`]);
    await assert.rejects(
      () => bootstrap.prepare({ runId: 'orphan-recovery', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: orphan } }),
      errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.STALE_IDENTITY),
    );
    assert.equal(fixture.commands.some((command) => command.args[0] === 'worktree' && command.args[1] === 'add'), false);
  });

  it('verifyDurable rejects a clean published orphan even when workspace and remote agree', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'orphan-durable', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    const tree = fixture.git(fixture.source, ['rev-parse', `${fixture.baseSha}^{tree}`]);
    const orphan = execFileSync('git', ['commit-tree', tree, '-m', 'unrelated durable orphan'], { cwd: fixture.source, encoding: 'utf8', input: '' }).trim();
    fixture.git(fixture.source, ['worktree', 'add', '-b', identity.branch, identity.workspacePath, fixture.baseSha]);
    fixture.git(identity.workspacePath, ['reset', '--hard', orphan]);
    fixture.git(identity.workspacePath, ['push', 'origin', `HEAD:refs/heads/${identity.branch}`]);
    await assert.rejects(
      () => bootstrap.verifyDurable({ identity, expectedHeadSha: orphan }),
      errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.HEAD_MISMATCH),
    );
  });

  it('reconstructs a pre-PR workspace from only a local branch without PR head authority', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'pre-pr-only-local', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    fixture.git(fixture.source, ['branch', identity.branch, fixture.baseSha]);
    await assert.doesNotReject(
      () => bootstrap.prepare({ runId: 'pre-pr-only-local', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity }),
    );
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), fixture.baseSha);
  });

  it('reconstructs a pre-PR workspace from only a remote branch without PR head authority', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'pre-pr-only-remote', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    fixture.git(fixture.source, ['push', 'origin', `${fixture.baseSha}:refs/heads/${identity.branch}`]);
    await assert.doesNotReject(() => bootstrap.prepare({ runId: 'pre-pr-only-remote', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity }));
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), fixture.baseSha);
  });

  it('reconstructs a pre-PR workspace when local and remote replicas are equal', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'pre-pr-equal', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    fixture.git(fixture.source, ['branch', identity.branch, fixture.baseSha]);
    fixture.git(fixture.source, ['push', 'origin', `${fixture.baseSha}:refs/heads/${identity.branch}`]);
    await assert.doesNotReject(() => bootstrap.prepare({ runId: 'pre-pr-equal', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity }));
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), fixture.baseSha);
  });

  it('rejects a branch registered in a foreign worktree before any ref mutation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'foreign-registration', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    const foreign = `${fixture.root}/foreign-worktree`;
    fixture.git(fixture.source, ['worktree', 'add', '-b', identity.branch, foreign, fixture.baseSha]);
    fixture.git(fixture.source, ['push', 'origin', `${fixture.baseSha}:refs/heads/${identity.branch}`]);
    await assert.rejects(
      () => bootstrap.prepare({ runId: 'foreign-registration', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: fixture.baseSha } }),
      errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(fixture.git(fixture.source, ['rev-parse', `refs/heads/${identity.branch}`]), fixture.baseSha);
    assert.equal(fixture.git(fixture.source, ['rev-parse', `refs/remotes/origin/${identity.branch}`]), fixture.baseSha);
  });

  it('guard rejects a dirty prepared workspace before execution', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'dirty-guard', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'dirty-guard', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    writeFileSync(`${identity.workspacePath}/untracked.txt`, 'dirty\n');
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.DIRTY_WORKSPACE));
  });

  it('guard rejects a prepared workspace whose branch drifts before execution', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'branch-drift', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'branch-drift', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    fixture.git(identity.workspacePath, ['switch', '-c', 'other-branch', fixture.baseSha]);
    await assert.rejects(async () => { await bootstrap.guard(identity).assertValid(); }, errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.STALE_IDENTITY));
  });

  it('rebuilds a missing workspace from an exact remote recovery head without tracking fallback', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'missing-workspace', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'missing-workspace', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    const head = fixture.commit(identity.workspacePath, 'feature.txt', 'published\n');
    fixture.git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    // Remove only the workspace; recovery must use the explicitly proven R.
    fixture.git(fixture.source, ['worktree', 'remove', '--force', identity.workspacePath]);
    fixture.git(fixture.source, ['update-ref', '-d', `refs/heads/${identity.branch}`]);
    fixture.git(fixture.source, ['update-ref', '-d', `refs/remotes/origin/${identity.branch}`]);
    const restarted = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    await restarted.prepare({ runId: 'missing-workspace', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: head } });
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), head);
  });

  it('accepts a literal slash in a Git base branch ref', async () => {
    const fixture = createBootstrapGitFixture({ branch: 'release/2026' }); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const request = { runId: 'slash-ref', target, baseBranch: 'release/2026', baseSha: fixture.baseSha };
    const identity = await bootstrap.plan(request);
    await bootstrap.prepare({ ...request, existing: identity });
    assert.equal(fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']), fixture.baseSha);
  });

  it('rejects malformed literal Git branch names before fetch or mutation', async () => {
    for (const baseBranch of ['a..b', 'a//b', 'a.lock', '@{-1}', '-leading', 'trailing/', 'a b', 'HEAD', 'a~b']) {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      await assert.rejects(
        () => bootstrap.plan({ runId: `bad-ref-${baseBranch.replaceAll(/[^A-Za-z0-9]/g, 'x')}`, target, baseBranch, baseSha: fixture.baseSha }),
        errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.INVALID_REQUEST),
      );
      assert.equal(fixture.commands.some((command) => command.args[0] === 'fetch'), false);
    }
  });

  it('does not add or move refs when an equal local/remote recovery already has its workspace', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await bootstrap.plan({ runId: 'equal-existing', target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'equal-existing', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
    fixture.git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    const before = fixture.commands.length;
    await bootstrap.prepare({ runId: 'equal-existing', target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity, recoveryAuthority: { expectedHeadSha: fixture.baseSha } });
    const recovery = fixture.commands.slice(before).map((command) => command.args[0]);
    assert.equal(recovery.includes('update-ref'), false);
    assert.equal(recovery.includes('merge'), false);
    assert.equal(fixture.commands.slice(before).some((c) => c.args[0] === 'worktree' && c.args[1] === 'add'), false);
  });
});

// Adversarial fixtures retain real Git graph/ref/worktree operations. Only the
// stated observation/race is controlled; no provider or GitHub write is used.
describe('recovery preservation and race boundaries', () => {
  for (const missing of [false, true]) {
    it(`preserves an ahead local commit with missing workspace=${missing}`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
      const request = { runId: `ahead-${missing}`, target, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      f.git(i.workspacePath, ['push', 'origin', i.branch]);
      const ahead = f.commit(i.workspacePath, 'local.txt', 'must survive\n');
      if (missing) rmSync(i.workspacePath, { recursive: true, force: true });
      const before = f.commands.length;
      await assert.rejects(() => b.prepare({ ...request, existing: i, recoveryAuthority: { expectedHeadSha: f.baseSha } }), errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.STALE_IDENTITY));
      assert.equal(f.git(f.source, ['rev-parse', `refs/heads/${i.branch}`]), ahead);
      assert.match(f.git(f.source, ['ls-remote', 'origin', `refs/heads/${i.branch}`]), new RegExp(`^${f.baseSha}`));
      assert.equal(f.git(f.source, ['show', `${ahead}:local.txt`]), 'must survive');
      assertNoRepair(f.commands.slice(before));
    });
  }
  for (const file of ['README.md', 'untracked.txt']) {
    it(`preserves dirty ${file} before any recovery mutation`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
      const request = { runId: `dirty-${file}`, target, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      writeFileSync(`${i.workspacePath}/${file}`, 'preserve dirty bytes\n');
      const before = f.commands.length;
      await assert.rejects(() => b.prepare({ ...request, existing: i }), errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.DIRTY_WORKSPACE));
      assert.equal(readFileSync(`${i.workspacePath}/${file}`, 'utf8'), 'preserve dirty bytes\n');
      assert.equal(f.git(f.source, ['rev-parse', `refs/heads/${i.branch}`]), f.baseSha);
      assertNoRepair(f.commands.slice(before));
    });
  }
  it('rejects a standalone checkout with the same path, branch and SHA', async () => {
    const f = createBootstrapGitFixture(); fixtures.push(f);
    const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
    const request = { runId: 'foreign-common', target, baseBranch: f.branch, baseSha: f.baseSha };
    const i = await b.plan(request); await b.prepare({ ...request, existing: i });
    f.git(f.source, ['worktree', 'remove', i.workspacePath]);
    f.git(f.source, ['clone', f.source, i.workspacePath]);
    f.git(i.workspacePath, ['switch', '-c', i.branch, f.baseSha]);
    const before = f.commands.length;
    await assert.rejects(() => b.prepare({ ...request, existing: i }), errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.STALE_IDENTITY));
    assert.equal(f.git(i.workspacePath, ['rev-parse', 'HEAD']), f.baseSha);
    assertNoRepair(f.commands.slice(before));
  });
  for (const race of ['none', 'cas', 'post-remote'] as const) {
    it(`missing workspace behind recovery: ${race}`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      let active = false;
      let concurrent = '';
      const runner: ProcessRunner = { run: async (file, args, options) => {
        if (active && race === 'cas' && args[0] === 'update-ref') {
          f.git(f.source, ['update-ref', args[1]!, concurrent]);
        }
        const result = await f.runner.run(file, args, options);
        if (active && race === 'post-remote' && args[0] === 'worktree' && args[1] === 'add') {
          f.git(f.source, ['push', 'origin', `${concurrent}:refs/heads/${i.branch}`]);
        }
        return result;
      } };
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner });
      const request = { runId: `cas-${race}`, target, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      const remote = f.commit(i.workspacePath, 'feature.txt', 'published\n');
      f.git(i.workspacePath, ['push', 'origin', i.branch]);
      concurrent = f.commit(i.workspacePath, 'another.txt', 'race\n');
      f.git(i.workspacePath, ['reset', '--hard', f.baseSha]);
      rmSync(i.workspacePath, { recursive: true, force: true });
      const before = f.commands.length; active = true;
      const operation = () => b.prepare({ ...request, existing: i, recoveryAuthority: { expectedHeadSha: remote } });
      if (race === 'none') await operation(); else await assert.rejects(operation);
      const commands = f.commands.slice(before);
      assert.deepEqual(commands.find((c) => c.args[0] === 'update-ref')?.args, ['update-ref', `refs/heads/${i.branch}`, remote, f.baseSha]);
      assert.equal(f.git(f.source, ['rev-parse', `refs/heads/${i.branch}`]), race === 'cas' ? concurrent : remote);
      if (race === 'cas') assert.equal(existsSync(i.workspacePath), false);
      else assert.equal(f.git(i.workspacePath, ['rev-parse', 'HEAD']), remote);
      assert.equal(commands.some((c) => ['reset', 'push'].includes(c.args[0]!)), false);
    });
  }
  for (const observation of ['missing-remote', 'fetch-head', 'wrong-registration', 'duplicate-registration'] as const) {
    it(`rejects ${observation} before local ref or workspace repair`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      let active = false;
      const runner: ProcessRunner = { run: async (file, args, options) => {
        const result = await f.runner.run(file, args, options);
        if (!active) return result;
        if (observation === 'missing-remote' && args[0] === 'ls-remote') return { ...result, stdout: '' };
        if (observation === 'fetch-head' && args.join(' ') === 'rev-parse FETCH_HEAD') return { ...result, stdout: f.baseSha + '\n' };
        if (args.join(' ') === 'worktree list --porcelain') {
          if (observation === 'wrong-registration') return { ...result, stdout: result.stdout.replace(`branch refs/heads/${i.branch}`, 'branch refs/heads/foreign') };
          if (observation === 'duplicate-registration') return { ...result, stdout: result.stdout + `\nworktree ${f.root}/elsewhere\nHEAD ${f.baseSha}\nbranch refs/heads/${i.branch}\n\n` };
        }
        return result;
      } };
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner });
      const request = { runId: `obs-${observation}`, target, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      const remote = f.commit(i.workspacePath, 'feature.txt', 'published\n');
      f.git(i.workspacePath, ['push', 'origin', i.branch]);
      f.git(i.workspacePath, ['reset', '--hard', f.baseSha]);
      rmSync(i.workspacePath, { recursive: true, force: true });
      const before = f.commands.length; active = true;
      await assert.rejects(() => b.prepare({ ...request, existing: i, recoveryAuthority: { expectedHeadSha: remote } }));
      assert.equal(f.git(f.source, ['rev-parse', `refs/heads/${i.branch}`]), f.baseSha);
      assert.equal(existsSync(i.workspacePath), false);
      assertNoRepair(f.commands.slice(before));
    });
  }
  it('rejects stale live base SHA before creating any implementation ref', async () => {
    const f = createBootstrapGitFixture(); fixtures.push(f);
    const newer = f.commit(f.source, 'base-new.txt', 'base advanced\n');
    f.git(f.source, ['push', 'origin', f.branch]);
    const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
    await assert.rejects(() => b.plan({ runId: 'base-drift', target, baseBranch: f.branch, baseSha: f.baseSha }), errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.BASE_DRIFT));
    assert.equal(f.git(f.source, ['rev-parse', 'HEAD']), newer);
    assertNoRepair(f.commands);
  });
});

function assertNoRepair(commands: BootstrapGitFixture['commands']): void {
  assert.equal(commands.some((c) => ['update-ref', 'merge', 'reset', 'push'].includes(c.args[0]!) || (c.args[0] === 'worktree' && ['add', 'remove', 'prune', 'repair'].includes(c.args[1]!))), false);
}

for (const url of ['', 'not-a-url', 'https://gitlab.com/acme/widgets.git', 'git@github.com:other/widgets.git', 'git@github.com:acme/other.git', 'git@github.com:acme/widgets.git\n\n']) {
  it(`rejects an unproved effective endpoint ${JSON.stringify(url)} before fetch`, async () => {
    const f = createBootstrapGitFixture(); fixtures.push(f);
    const runner: ProcessRunner = { run: async (file, args, options) => {
      if (args.join(' ') === 'remote get-url --all --push origin') return { stdout: url, stderr: '', exitCode: 0 };
      return f.runner.run(file, args, options);
    } };
    const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner });
    await assert.rejects(() => b.plan({ runId: 'endpoints', target, baseBranch: f.branch, baseSha: f.baseSha }), errorCode(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.REPOSITORY_MISMATCH));
    assert.equal(f.commands.some((c) => c.args[0] === 'fetch'), false);
    assertNoRepair(f.commands);
  });
}

it('resumes after parent mkdir but before worktree add without adopting an empty leaf', async () => {
  const f = createBootstrapGitFixture(); fixtures.push(f);
  let interrupt = true;
  const runner: ProcessRunner = { run: async (file, args, options) => {
    if (interrupt && args[0] === 'worktree' && args[1] === 'add') throw new Error('fixture interruption before add');
    return f.runner.run(file, args, options);
  } };
  const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner });
  const request = { runId: 'parent-interruption', target, baseBranch: f.branch, baseSha: f.baseSha };
  const i = await b.plan(request);
  await assert.rejects(() => b.prepare({ ...request, existing: i }));
  assert.equal(existsSync(i.workspacePath), false);
  assert.equal(f.git(f.source, ['rev-parse', `refs/heads/${i.branch}`]), f.baseSha);
  interrupt = false;
  const restarted = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner });
  await restarted.prepare({ ...request, existing: i });
  assert.equal(f.git(i.workspacePath, ['rev-parse', 'HEAD']), f.baseSha);
});
