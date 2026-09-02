import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      branch: 'tachiko/issue-42',
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
      if (command.startsWith('worktree add -b tachiko/issue-42 ')) {
        workspacePath = args[4] ?? '';
        mkdirSync(workspacePath, { recursive: true });
        return result();
      }
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
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

    assert.equal(identity.branch, 'tachiko/issue-42');
    assert.equal(identity.baseSha, BASE);
    assert.equal(identity.workspacePath, path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42'));
    assert.deepEqual(
      runner.calls.find((call) => call.args[0] === 'worktree')?.args,
      ['worktree', 'add', '-b', 'tachiko/issue-42', identity.workspacePath, BASE],
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

  it('reuses a persisted identity after restart without creating a second branch or worktree', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });
    const existing = {
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
      baseBranch: 'main',
      baseSha: BASE,
      branch: 'tachiko/issue-42',
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

  it('reconstructs a missing local workspace from the persisted pushed branch after restart', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    const existing = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: 'tachiko/issue-42', workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command.startsWith('show-ref --verify --quiet')) return result('', 1);
      if (command === 'ls-remote --heads origin refs/heads/tachiko/issue-42') {
        return result(`${HEAD}\trefs/heads/tachiko/issue-42\n`);
      }
      if (command === `worktree add -b tachiko/issue-42 ${workspacePath} origin/tachiko/issue-42`) {
        mkdirSync(workspacePath, { recursive: true });
        return result();
      }
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
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
      branch: 'tachiko/issue-42', workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result();
      if (command === 'ls-remote --heads origin refs/heads/tachiko/issue-42') {
        return result(`${HEAD}\trefs/heads/tachiko/issue-42\n`);
      }
      if (command === `merge-base --is-ancestor ${BASE} ${HEAD}`) return result();
      throw new Error(`Unexpected git call: ${command}`);
    });
    const bootstrap = new GitWorktreeBootstrap({ ...roots, runner });

    assert.deepEqual(await bootstrap.verifyDurable({ identity, expectedHeadSha: HEAD }), {
      headSha: HEAD,
      branch: 'tachiko/issue-42',
    });
  });

  it('rejects success backed only by uncommitted workspace state', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: 'tachiko/issue-42', workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
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

  it('rejects a clean local success whose exact HEAD was not pushed to the owned branch', async () => {
    const roots = tempRoots();
    const workspacePath = path.join(roots.workspaceRoot, 'acme', 'widgets', 'run-42-issue-42');
    mkdirSync(workspacePath, { recursive: true });
    const identity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: BASE,
      branch: 'tachiko/issue-42', workspacePath,
    } as const;
    const runner = new FakeGitRunner((args) => {
      const command = args.join(' ');
      if (command === 'remote get-url origin') return result('git@github.com:acme/widgets.git\n');
      if (command === 'rev-parse --show-toplevel') return result(`${workspacePath}\n`);
      if (command === 'symbolic-ref --short HEAD') return result('tachiko/issue-42\n');
      if (command === 'rev-parse HEAD') return result(`${HEAD}\n`);
      if (command === 'status --porcelain=v1 --untracked-files=all') return result();
      if (command === 'ls-remote --heads origin refs/heads/tachiko/issue-42') {
        return result(`${BASE}\trefs/heads/tachiko/issue-42\n`);
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
