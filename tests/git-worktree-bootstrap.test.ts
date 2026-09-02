import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  IMPLEMENTATION_BOOTSTRAP_ERROR_CODE,
  ImplementationBootstrapError,
} from '../src/adapters/bootstrap.js';
import type { ProcessResult, ProcessRunOptions, ProcessRunner } from '../src/github/transport.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { TARGET } from './helpers.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
function expectedBranch(runId: string): string {
  return `tachiko/issue-42-${createHash('sha256').update(runId).digest('hex').slice(0, 16)}`;
}
const BRANCH = expectedBranch('run-42');
const tempDirs: string[] = [];

interface GitCall {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
}

class FakeGitRunner implements ProcessRunner {
  readonly calls: GitCall[] = [];

  constructor(
    private readonly respond: (args: readonly string[], cwd: string | undefined) => ProcessResult,
  ) {}

  async run(file: string, args: readonly string[], options: ProcessRunOptions): Promise<ProcessResult> {
    assert.equal(file, 'git');
    this.calls.push({ args, cwd: options.cwd });
    return this.respond(args, options.cwd);
  }
}

function result(stdout = '', exitCode = 0): ProcessResult {
  return { stdout, stderr: '', exitCode };
}

function tempRoots(): { repositoryRoot: string; workspaceRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-'));
  tempDirs.push(root);
  const repositoryRoot = path.join(root, 'source');
  const workspaceRoot = path.join(root, 'workspaces');
  mkdirSync(repositoryRoot, { recursive: true });
  return { repositoryRoot, workspaceRoot };
}

function codeIs(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ImplementationBootstrapError && error.code === code;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GitWorktreeBootstrap', () => {
  it('rejects a workspace-root symlink that canonically enters the source repository', () => {
    const roots = tempRoots();
    symlinkSync(roots.repositoryRoot, roots.workspaceRoot, 'dir');

    assert.throws(
      () => new GitWorktreeBootstrap(roots),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.INVALID_REQUEST),
    );
  });

  it('boots and verifies durable state against a real local Git remote', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-integration-'));
    tempDirs.push(root);
    const remote = path.join(root, 'acme', 'widgets.git');
    const repositoryRoot = path.join(root, 'source');
    const workspaceRoot = path.join(root, 'workspaces');
    mkdirSync(path.dirname(remote), { recursive: true });
    const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    mkdirSync(repositoryRoot);
    git(repositoryRoot, ['init', '-b', 'main']);
    writeFileSync(path.join(repositoryRoot, 'README.md'), 'base\n', 'utf8');
    git(repositoryRoot, ['add', 'README.md']);
    git(repositoryRoot, ['-c', 'user.name=Tachiko Test', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'base']);
    git(repositoryRoot, ['remote', 'add', 'origin', `file://${remote}`]);
    git(repositoryRoot, ['push', '-u', 'origin', 'main']);
    const baseSha = git(repositoryRoot, ['rev-parse', 'HEAD']);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot, workspaceRoot });

    const planned = await bootstrap.plan({
      runId: 'run-real', target: TARGET, baseBranch: 'main', baseSha,
    });
    const identity = await bootstrap.prepare({
      runId: 'run-real', target: TARGET, baseBranch: 'main', baseSha, existing: planned,
    });
    writeFileSync(path.join(identity.workspacePath, 'feature.txt'), 'implemented\n', 'utf8');
    git(identity.workspacePath, ['add', 'feature.txt']);
    git(identity.workspacePath, [
      '-c', 'user.name=Tachiko Test', '-c', 'user.email=tachiko@example.invalid', 'commit', '-m', 'implement',
    ]);
    git(identity.workspacePath, ['push', '-u', 'origin', identity.branch]);
    const headSha = git(identity.workspacePath, ['rev-parse', 'HEAD']);

    assert.deepEqual(await bootstrap.verifyDurable({ identity, expectedHeadSha: headSha }), {
      headSha,
      branch: expectedBranch('run-real'),
    });
  });

  it('creates one deterministic branch/worktree from the fetched exact live base using argv arrays', async () => {
    const roots = tempRoots();
    let workspacePath = '';
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command.startsWith('ls-remote --heads')) return result();
      if (command === `cat-file -e ${BASE}^{commit}`) return result();
      if (command.startsWith(`worktree add -b ${BRANCH} `)) {
        workspacePath = args[4] ?? '';
        mkdirSync(workspacePath, { recursive: true });
        return result();
      }
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    const planned = await bootstrap.plan({
      runId: 'run-42',
      target: TARGET,
      baseBranch: 'main',
      baseSha: BASE,
    });
    const identity = await bootstrap.prepare({
      runId: 'run-42',
      target: TARGET,
      baseBranch: 'main',
      baseSha: BASE,
      existing: planned,
    });

    assert.equal(identity.branch, BRANCH);
    assert.equal(identity.baseSha, BASE);
    assert.equal(
      identity.workspacePath,
      path.join(realpathSync(path.dirname(roots.workspaceRoot)), 'workspaces', 'acme', 'widgets', 'run-42-issue-42'),
    );
    assert.deepEqual(
      runner.calls.find((call) => call.args[0] === 'worktree')?.args,
      ['worktree', 'add', '-b', BRANCH, identity.workspacePath, BASE],
    );
  });

  it('fails closed when fetched default-branch state drifted from live GitHub authority', async () => {
    const roots = tempRoots();
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('https://github.com/acme/widgets.git\n');
      if (command.startsWith('fetch ')) return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${HEAD}\n`);
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    await assert.rejects(
      bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.BASE_DRIFT),
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('fails stale persisted planning after a crash when no durable Git state exists', async () => {
    const roots = tempRoots();
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('https://github.com/acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command.startsWith('ls-remote --heads')) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });

    await assert.rejects(
      bootstrap.prepare({
        runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: HEAD, existing: planned,
      }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.BASE_DRIFT),
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('rejects an unowned local or remote branch collision before creating a workspace', async () => {
    const roots = tempRoots();
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command.startsWith('fetch ')) return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    await assert.rejects(
      bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
  });

  it('fails closed when local and remote recovery branches diverge', async () => {
    const roots = tempRoots();
    let recovering = false;
    let fetchedFeature = false;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') {
        fetchedFeature = false;
        return result();
      }
      if (command === 'rev-parse FETCH_HEAD') return result(`${fetchedFeature ? OTHER : BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', recovering ? 0 : 1);
      if (command === `rev-parse refs/heads/${BRANCH}`) return result(`${HEAD}\n`);
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) {
        return recovering ? result(`${OTHER}\trefs/heads/${BRANCH}\n`) : result();
      }
      if (command === `fetch --no-tags origin refs/heads/${BRANCH}`) {
        fetchedFeature = true;
        return result();
      }
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    recovering = true;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing: planned }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('uses a run-unique branch so another run cannot occupy the persisted recovery name', async () => {
    const roots = tempRoots();
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command.startsWith('ls-remote --heads')) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    const first = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    const second = await bootstrap.plan({ runId: 'another-run', target: TARGET, baseBranch: 'main', baseSha: BASE });

    assert.equal(first.branch, expectedBranch('run-42'));
    assert.equal(second.branch, expectedBranch('another-run'));
    assert.notEqual(first.branch, second.branch);
  });

  it('refuses mutation when the pinned workspace root is swapped for a symlink during recovery', async () => {
    const roots = tempRoots();
    let recovering = false;
    let swapped = false;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command === `cat-file -e ${BASE}^{commit}`) return result();
      if (command.startsWith('show-ref --verify --quiet')) {
        if (recovering && !swapped) {
          rmSync(roots.workspaceRoot, { recursive: true, force: true });
          symlinkSync(roots.repositoryRoot, roots.workspaceRoot, 'dir');
          swapped = true;
        }
        return result('', 1);
      }
      if (command.startsWith('ls-remote --heads')) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    recovering = true;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing: planned }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(swapped, true);
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('refuses a nested symlink inserted before repository-parent creation', async () => {
    const roots = tempRoots();
    const outside = path.join(path.dirname(roots.workspaceRoot), 'outside-before-mkdir');
    mkdirSync(outside);
    let recovering = false;
    let swapped = false;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') {
        if (recovering && !swapped) {
          symlinkSync(outside, path.join(roots.workspaceRoot, 'acme'), 'dir');
          swapped = true;
        }
        return result(`${BASE}\n`);
      }
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command.startsWith('ls-remote --heads')) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    recovering = true;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing: planned }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(swapped, true);
    assert.equal(existsSync(path.join(outside, 'widgets')), false);
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('revalidates pinned nested parents after the final awaited probe before worktree creation', async () => {
    const roots = tempRoots();
    const outside = path.join(path.dirname(roots.workspaceRoot), 'outside-before-worktree');
    mkdirSync(outside);
    let recovering = false;
    let swapped = false;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command.startsWith('ls-remote --heads')) return result();
      if (command === `cat-file -e ${BASE}^{commit}`) {
        if (recovering && !swapped) {
          rmSync(path.join(roots.workspaceRoot, 'acme'), { recursive: true, force: true });
          symlinkSync(outside, path.join(roots.workspaceRoot, 'acme'), 'dir');
          swapped = true;
        }
        return result();
      }
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    recovering = true;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing: planned }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(swapped, true);
    assert.equal(existsSync(path.join(outside, 'widgets')), false);
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('fails closed when a recovery branch does not descend from the persisted base', async () => {
    const roots = tempRoots();
    let recovering = false;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'fetch --no-tags origin refs/heads/main') return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${BASE}\n`);
      if (command.startsWith('show-ref --verify --quiet')) return result('', recovering ? 0 : 1);
      if (command === `rev-parse refs/heads/${BRANCH}`) return result(`${HEAD}\n`);
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) return result();
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result('', 1);
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const planned = await bootstrap.plan({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE });
    recovering = true;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing: planned }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.COLLISION),
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('reuses a persisted identity after restart without creating a second branch or worktree', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command.startsWith('show-ref --verify --quiet')) return result();
      if (command === `rev-parse refs/heads/${BRANCH}`) return result(`${HEAD}\n`);
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) return result();
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result();
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const existing = {
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      baseBranch: 'main',
      baseSha: BASE,
      branch: BRANCH,
      workspacePath,
    } as const;

    assert.deepEqual(
      await bootstrap.prepare({
        runId: 'run-42',
        target: TARGET,
        baseBranch: 'main',
        baseSha: HEAD,
        existing,
      }),
      existing,
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
    assert.equal(runner.calls.some((call) => call.args[0] === 'fetch'), false);
  });

  it('refuses automatic recovery from an existing dirty workspace', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command.startsWith('show-ref --verify --quiet')) return result();
      if (command === `rev-parse refs/heads/${BRANCH}`) return result(`${HEAD}\n`);
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) return result();
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result();
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result('?? scratch.txt\n');
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const existing = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;

    await assert.rejects(
      bootstrap.prepare({ runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.DIRTY_WORKSPACE),
    );
    assert.equal(runner.calls.some((call) => call.args[0] === 'worktree'), false);
  });

  it('reconstructs a missing local workspace from the persisted pushed branch after restart', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    const existing = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) {
        return result(`${HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (command === `fetch --no-tags origin refs/heads/${BRANCH}`) return result();
      if (command === 'rev-parse FETCH_HEAD') return result(`${HEAD}\n`);
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result();
      if (command === `worktree add -b ${BRANCH} ${workspacePath} ${HEAD}`) {
        mkdirSync(workspacePath, { recursive: true });
        return result();
      }
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    assert.deepEqual(await bootstrap.prepare({
      runId: 'run-42', target: TARGET, baseBranch: 'main', baseSha: BASE, existing,
    }), existing);
    assert.ok(runner.calls.some((call) => call.args[0] === 'worktree'));
  });

  it('accepts only a clean exact HEAD that is pushed on the owned branch and descends from the base', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result();
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) {
        return result(`${HEAD}\trefs/heads/${BRANCH}\n`);
      }
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    assert.deepEqual(await bootstrap.verifyDurable({ identity, expectedHeadSha: HEAD }), {
      headSha: HEAD,
      branch: BRANCH,
    });
  });

  it('rejects success backed only by uncommitted workspace state', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result(' M src/index.ts\n');
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    await assert.rejects(
      bootstrap.verifyDurable({ identity, expectedHeadSha: HEAD }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.DIRTY_WORKSPACE),
    );
  });

  it('rejects a clean pushed branch with no commit beyond the bootstrap base', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${BASE}\n`);
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    await assert.rejects(
      bootstrap.verifyDurable({ identity, expectedHeadSha: BASE }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.HEAD_MISMATCH),
    );
  });

  it('rejects a clean local success whose exact HEAD was not pushed to the owned branch', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: BRANCH, workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result(`${BRANCH}\n`);
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result();
      if (command === `ls-remote --heads origin refs/heads/${BRANCH}`) {
        return result(`${BASE}\trefs/heads/${BRANCH}\n`);
      }
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    await assert.rejects(
      bootstrap.verifyDurable({ identity, expectedHeadSha: HEAD }),
      codeIs(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE.UNPUSHED_HEAD),
    );
  });
});
