import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  IMPLEMENTATION_BOOTSTRAP_ERROR_CODE,
  ImplementationBootstrapError,
  type BootstrapPlanRequest,
  type BootstrapPrepareRequest,
  type DurableImplementationSnapshot,
  type ImplementationBootstrapAdapter,
  type VerifyDurableRequest,
} from '../adapters/bootstrap.js';
import type { WorkspaceGuard } from '../adapters/agent.js';
import type { ImplementationBootstrapIdentity } from '../domain/types.js';
import { NodeProcessRunner, type ProcessResult, type ProcessRunner } from '../github/transport.js';

const SHA = /^[0-9a-f]{40}$/i;
const COMPONENT = /^[A-Za-z0-9._-]+$/;

export interface GitWorktreeBootstrapOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly remote?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
}

function fail(code: keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, message: string): never {
  throw new ImplementationBootstrapError(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE[code], message);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function remoteDestination(value: string): { host: string; owner: string; repo: string } | null {
  const text = value.trim();
  let host = '';
  let pathname = '';
  try {
    const parsed = new URL(text);
    host = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    const match = /^(?:[^@\s]+@)?([^:\s]+):([^\s]+)$/.exec(text);
    if (match === null) return null;
    host = match[1] ?? '';
    pathname = match[2] ?? '';
  }
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (host.toLowerCase().replace(/\.$/, '') !== 'github.com' || parts.length !== 2) return null;
  const owner = parts[0] ?? '';
  const repo = (parts[1] ?? '').replace(/\.git$/i, '');
  return owner === '' || repo === '' ? null : { host: 'github.com', owner, repo };
}

function sameIdentity(a: ImplementationBootstrapIdentity, b: ImplementationBootstrapIdentity): boolean {
  return a.owner === b.owner && a.repo === b.repo && a.issueNumber === b.issueNumber &&
    a.baseBranch === b.baseBranch && a.baseSha === b.baseSha && a.branch === b.branch &&
    path.resolve(a.workspacePath) === path.resolve(b.workspacePath);
}

/**
 * Bounded Git implementation workspace bootstrap. It only manages its
 * deterministic run path, never scans or repairs arbitrary filesystem state.
 */
export class GitWorktreeBootstrap implements ImplementationBootstrapAdapter {
  readonly kind = 'implementation-bootstrap' as const;
  private readonly repositoryRoot: string;
  private readonly workspaceRoot: string;
  private readonly remote: string;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;

  constructor(options: GitWorktreeBootstrapOptions) {
    this.repositoryRoot = realpathSync(path.resolve(options.repositoryRoot));
    this.workspaceRoot = this.canonicalFuturePath(options.workspaceRoot);
    this.remote = options.remote ?? 'origin';
    this.runner = options.runner ?? new NodeProcessRunner();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (this.repositoryRoot === this.workspaceRoot || isInside(this.repositoryRoot, this.workspaceRoot) || isInside(this.workspaceRoot, this.repositoryRoot)) {
      fail('INVALID_REQUEST', 'Implementation workspace root must be outside the source repository.');
    }
    mkdirSync(this.workspaceRoot, { recursive: true });
    if (realpathSync(this.workspaceRoot) !== this.workspaceRoot || !lstatSync(this.workspaceRoot).isDirectory()) {
      fail('INVALID_REQUEST', 'Implementation workspace root must be a canonical directory.');
    }
  }

  async plan(request: BootstrapPlanRequest): Promise<ImplementationBootstrapIdentity> {
    this.assertRequest(request);
    await this.assertRemote(request.target.owner, request.target.repo, this.repositoryRoot);
    await this.assertFetchedRef(request.baseBranch, request.baseSha);
    const identity = this.identityFor(request);
    if (existsSync(identity.workspacePath) || await this.localRef(identity.branch) !== null || await this.remoteRef(identity.branch) !== null) {
      fail('COLLISION', `Bootstrap identity for ${identity.branch} already has local Git state.`);
    }
    return identity;
  }

  async prepare(request: BootstrapPrepareRequest): Promise<ImplementationBootstrapIdentity> {
    this.assertRequest(request);
    const expected = this.identityFor(request);
    if (!sameIdentity(expected, request.existing)) fail('STALE_IDENTITY', 'Persisted bootstrap identity does not match this run.');
    await this.assertRemote(expected.owner, expected.repo, this.repositoryRoot);

    if (existsSync(expected.workspacePath)) {
      if (request.recoveryAuthority === undefined) {
        // A crash can occur after the owned workspace commits/pushes but before
        // workflow state records a PR HEAD. Keep no local mutable state hidden:
        // accept only a clean linked workspace, then workflow re-reads GitHub
        // and performs durable exact-head verification before adoption.
        await this.assertWorkspace(expected, undefined, true);
        return expected;
      }
      const recovered = request.recoveryAuthority.expectedHeadSha;
      if (!SHA.test(recovered) || await this.remoteRef(expected.branch) !== recovered) {
        fail('STALE_IDENTITY', 'Live recovery authority does not match the remote implementation branch.');
      }
      await this.assertWorkspace(expected, undefined, true);
      await this.fetchExactBranch(expected.branch, recovered);
      const local = (await this.git(['rev-parse', 'HEAD'], expected.workspacePath)).stdout.trim();
      if (local !== recovered) {
        if (!await this.isAncestor(local, recovered)) fail('STALE_IDENTITY', 'Existing workspace diverged from the authorized remote head.');
        await this.git(['merge', '--ff-only', recovered], expected.workspacePath);
      }
      await this.assertWorkspace(expected, recovered, true);
      return expected;
    }

    const local = await this.localRef(expected.branch);
    const remote = await this.remoteRef(expected.branch);
    if (request.recoveryAuthority === undefined) {
      if (local !== null || remote !== null) fail('STALE_IDENTITY', 'Bootstrap was interrupted after branch creation; live recovery authority is required.');
      await this.addWorktree(expected, expected.baseSha, true);
      await this.assertWorkspace(expected, expected.baseSha, true);
      return expected;
    }

    const recovered = request.recoveryAuthority.expectedHeadSha;
    if (!SHA.test(recovered) || remote !== recovered) fail('STALE_IDENTITY', 'Live recovery authority does not match the remote implementation branch.');
    await this.fetchExactBranch(expected.branch, recovered);
    if (local === null) {
      await this.addWorktree(expected, recovered, false);
    } else if (local !== recovered) {
      if (!await this.isAncestor(local, recovered)) fail('STALE_IDENTITY', 'Local implementation branch diverged from the authorized remote head.');
      await this.git(['update-ref', `refs/heads/${expected.branch}`, recovered, local], this.repositoryRoot);
      await this.addWorktree(expected, recovered, false);
    } else {
      await this.addWorktree(expected, recovered, false);
    }
    await this.assertWorkspace(expected, recovered, true);
    return expected;
  }

  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard {
    return { assertValid: async () => { await this.assertWorkspace(identity); } };
  }

  async verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot> {
    if (!SHA.test(request.expectedHeadSha)) fail('INVALID_REQUEST', 'Durable verification requires an exact HEAD SHA.');
    await request.workspaceGuard?.assertValid();
    await this.assertWorkspace(request.identity, request.expectedHeadSha, true);
    const remote = await this.remoteRef(request.identity.branch, request.identity.workspacePath);
    if (remote !== request.expectedHeadSha) fail('UNPUSHED_HEAD', 'Implementation HEAD is not exactly published to its expected remote branch.');
    const progressBase = request.progressBaseSha ?? request.identity.baseSha;
    if (!SHA.test(progressBase)) fail('INVALID_REQUEST', 'Durable verification requires an exact progress base SHA.');
    if (progressBase !== request.identity.baseSha) {
      if (!await this.isAncestor(progressBase, request.expectedHeadSha)) fail('HEAD_MISMATCH', 'Implementation head does not descend from the reviewed progress head.');
      const changed = await this.git(['diff', '--quiet', progressBase, request.expectedHeadSha, '--'], request.identity.workspacePath, [0, 1]);
      if (changed.exitCode === 0) fail('HEAD_MISMATCH', 'Review-fix execution made no tree progress from the reviewed head.');
    }
    return { headSha: request.expectedHeadSha, branch: request.identity.branch };
  }

  private identityFor(request: BootstrapPlanRequest): ImplementationBootstrapIdentity {
    const suffix = createHash('sha256').update(request.runId).digest('hex').slice(0, 16);
    return {
      owner: request.target.owner,
      repo: request.target.repo,
      issueNumber: request.target.issueNumber,
      baseBranch: request.baseBranch,
      baseSha: request.baseSha,
      branch: `tachiko/issue-${request.target.issueNumber}-${suffix}`,
      workspacePath: path.join(this.workspaceRoot, request.target.owner, request.target.repo, `${request.runId}-issue-${request.target.issueNumber}`),
    };
  }

  private assertRequest(request: BootstrapPlanRequest): void {
    if (!SHA.test(request.baseSha) || !COMPONENT.test(request.runId) || !COMPONENT.test(request.target.owner) || !COMPONENT.test(request.target.repo) || !COMPONENT.test(request.baseBranch) || !Number.isSafeInteger(request.target.issueNumber) || request.target.issueNumber < 1) {
      fail('INVALID_REQUEST', 'Bootstrap request has an invalid target, branch, base SHA, or run id.');
    }
  }

  private async assertRemote(owner: string, repo: string, cwd: string): Promise<void> {
    const fetch = (await this.git(['remote', 'get-url', this.remote], cwd)).stdout.trim();
    const pushOutput = (await this.git(['remote', 'get-url', '--all', '--push', this.remote], cwd)).stdout;
    const urls = pushOutput.split(/\r?\n/);
    if (urls.at(-1) === '') urls.pop();
    const valid = (url: string): boolean => {
      const parsed = remoteDestination(url);
      return parsed !== null && parsed.owner.toLowerCase() === owner.toLowerCase() && parsed.repo.toLowerCase() === repo.toLowerCase();
    };
    if (!valid(fetch) || urls.length === 0 || urls.some((url) => url.trim() === '' || !valid(url))) {
      fail('REPOSITORY_MISMATCH', `Remote ${this.remote} must have one expected GitHub fetch destination and only expected GitHub push destinations.`);
    }
  }

  private async assertFetchedRef(branch: string, expected: string): Promise<void> {
    await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${branch}`], this.repositoryRoot);
    const fetched = (await this.git(['rev-parse', 'FETCH_HEAD'], this.repositoryRoot)).stdout.trim();
    if (fetched !== expected) fail('BASE_DRIFT', `Fetched ${this.remote}/${branch} does not match the live base SHA.`);
  }

  private async assertWorkspace(identity: ImplementationBootstrapIdentity, expectedHead?: string, clean = false): Promise<void> {
    if (!existsSync(identity.workspacePath)) fail('STALE_IDENTITY', 'Prepared implementation workspace no longer exists.');
    const top = realpathSync((await this.git(['rev-parse', '--show-toplevel'], identity.workspacePath)).stdout.trim());
    const sourceCommon = await this.commonDir(this.repositoryRoot);
    const workspaceCommon = await this.commonDir(identity.workspacePath);
    const branch = (await this.git(['symbolic-ref', '--short', 'HEAD'], identity.workspacePath)).stdout.trim();
    const head = (await this.git(['rev-parse', 'HEAD'], identity.workspacePath)).stdout.trim();
    if (!isInside(this.workspaceRoot, top) || top !== path.resolve(identity.workspacePath) || sourceCommon !== workspaceCommon || branch !== identity.branch || !SHA.test(head) || (expectedHead !== undefined && head !== expectedHead)) {
      fail('STALE_IDENTITY', 'Workspace is not the expected linked source worktree, branch, and HEAD.');
    }
    await this.assertRemote(identity.owner, identity.repo, identity.workspacePath);
    if (clean) {
      const status = (await this.git(['status', '--porcelain=v1', '--untracked-files=all'], identity.workspacePath)).stdout;
      if (status.trim() !== '') fail('DIRTY_WORKSPACE', 'Workspace has tracked or untracked local changes.');
    }
  }

  private async addWorktree(identity: ImplementationBootstrapIdentity, ref: string, createBranch: boolean): Promise<void> {
    mkdirSync(path.dirname(identity.workspacePath), { recursive: true });
    if (existsSync(identity.workspacePath)) fail('COLLISION', 'Workspace path appeared before linked worktree creation.');
    const force = createBranch ? false : await this.canForceExactStaleRegistration(identity, ref);
    const args = createBranch
      ? ['worktree', 'add', '-b', identity.branch, identity.workspacePath, ref]
      : ['worktree', 'add', ...(force ? ['--force'] : []), identity.workspacePath, identity.branch];
    await this.git(args, this.repositoryRoot);
  }

  /** A narrowly scoped --force is allowed only to repair our exact unlocked stale registration. */
  private async canForceExactStaleRegistration(identity: ImplementationBootstrapIdentity, expectedHead: string): Promise<boolean> {
    const raw = (await this.git(['worktree', 'list', '--porcelain'], this.repositoryRoot)).stdout;
    const blocks = raw.trim().split(/\n\n+/).filter((block) => block !== '');
    const expectedPath = path.resolve(identity.workspacePath);
    const expectedBranch = `refs/heads/${identity.branch}`;
    const matching = blocks.filter((block) => {
      const lines = block.split(/\r?\n/);
      const registeredPath = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
      const head = lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length);
      return registeredPath !== undefined && path.resolve(registeredPath) === expectedPath && branch === expectedBranch && head === expectedHead && !lines.some((line) => line === 'locked' || line.startsWith('locked '));
    });
    const branchElsewhere = blocks.some((block) => {
      const lines = block.split(/\r?\n/);
      return lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) === expectedBranch &&
        lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) !== expectedPath;
    });
    if (branchElsewhere || matching.length > 1) fail('COLLISION', 'Git worktree registration is not uniquely owned by this bootstrap identity.');
    return matching.length === 1;
  }

  private async commonDir(cwd: string): Promise<string> {
    const raw = (await this.git(['rev-parse', '--git-common-dir'], cwd)).stdout.trim();
    if (raw === '') fail('COMMAND_FAILED', 'Git returned an empty common Git directory.');
    return realpathSync(path.resolve(cwd, raw));
  }

  private async localRef(branch: string): Promise<string | null> {
    const result = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], this.repositoryRoot, [0, 1]);
    if (result.exitCode !== 0) return null;
    return (await this.git(['rev-parse', `refs/heads/${branch}`], this.repositoryRoot)).stdout.trim();
  }

  private async remoteRef(branch: string, cwd = this.repositoryRoot): Promise<string | null> {
    const raw = (await this.git(['ls-remote', '--heads', this.remote, `refs/heads/${branch}`], cwd)).stdout.trim();
    if (raw === '') return null;
    const [sha, ref, ...rest] = raw.split(/\s+/);
    if (!SHA.test(sha ?? '') || ref !== `refs/heads/${branch}` || rest.length !== 0) fail('COMMAND_FAILED', 'Git returned malformed remote branch identity.');
    return sha ?? null;
  }

  private async fetchExactBranch(branch: string, expected: string): Promise<void> {
    await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${branch}`], this.repositoryRoot);
    const fetched = (await this.git(['rev-parse', 'FETCH_HEAD'], this.repositoryRoot)).stdout.trim();
    if (fetched !== expected) fail('STALE_IDENTITY', 'Fetched recovery branch changed from its authorized remote head.');
  }

  private async isAncestor(older: string, newer: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', older, newer], this.repositoryRoot, [0, 1])).exitCode === 0;
  }

  private canonicalFuturePath(input: string): string {
    let current = path.resolve(input);
    const absent: string[] = [];
    while (!existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) fail('INVALID_REQUEST', `No canonical ancestor exists for ${input}.`);
      absent.unshift(path.basename(current));
      current = parent;
    }
    return path.join(realpathSync(current), ...absent);
  }

  private async git(args: readonly string[], cwd: string, allowed: readonly number[] = [0]): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await this.runner.run('git', args, { cwd, timeoutMs: this.timeoutMs });
    } catch (error) {
      fail('COMMAND_FAILED', `Git command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!allowed.includes(result.exitCode)) fail('COMMAND_FAILED', `Git command ${args[0] ?? '(unknown)'} exited with ${result.exitCode}.`);
    return result;
  }
}
