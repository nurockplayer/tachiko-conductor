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
  private readonly preparedHeads = new Map<string, string>();

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
    await this.assertRequest(request);
    await this.assertRemote(request.target.owner, request.target.repo, this.repositoryRoot);
    await this.assertFetchedRef(request.baseBranch, request.baseSha);
    const identity = this.identityFor(request);
    if (existsSync(identity.workspacePath) || await this.localRef(identity.branch) !== null || await this.remoteRef(identity.branch) !== null) {
      fail('COLLISION', `Bootstrap identity for ${identity.branch} already has local Git state.`);
    }
    return identity;
  }

  async prepare(request: BootstrapPrepareRequest): Promise<ImplementationBootstrapIdentity> {
    await this.assertRequest(request);
    const expected = this.identityFor(request);
    if (!sameIdentity(expected, request.existing)) fail('STALE_IDENTITY', 'Persisted bootstrap identity does not match this run.');
    await this.assertRemote(expected.owner, expected.repo, this.repositoryRoot);

    const present = existsSync(expected.workspacePath);
    const local = await this.localRef(expected.branch);
    const remote = await this.remoteRef(expected.branch);
    if (present) {
      await this.assertWorkspace(expected, local ?? undefined, true);
      if (local === null) fail('STALE_IDENTITY', 'Owned workspace has no local branch.');
    } else if (this.canonicalFuturePath(expected.workspacePath) !== expected.workspacePath) {
      fail('COLLISION', 'The canonical workspace path has changed.');
    }

    const authority = request.recoveryAuthority?.expectedHeadSha;
    if (authority !== undefined && (!SHA.test(authority) || remote !== authority)) {
      fail('STALE_IDENTITY', 'Live recovery authority does not match the remote implementation branch.');
    }
    if (authority === undefined && local !== null && remote !== null && local !== remote) {
      fail('STALE_IDENTITY', 'Pre-PR local and remote checkpoints disagree.');
    }
    const candidate = authority ?? remote ?? local ?? expected.baseSha;
    if (remote !== null) await this.fetchExactBranch(expected.branch, remote);
    if (!await this.isAncestor(expected.baseSha, candidate)) {
      fail('STALE_IDENTITY', 'Recovery candidate does not descend from the immutable bootstrap base.');
    }
    if (local !== null && local !== candidate && !await this.isAncestor(local, candidate)) {
      fail('STALE_IDENTITY', 'Local implementation branch is ahead of or diverged from the authorized head.');
    }
    // Registration is an admission proof, never a check after CAS has already
    // moved a ref. Only our exact unlocked missing registration admits --force.
    const force = await this.assertRegistration(expected, local ?? candidate, !present);
    if (!present && local === null && remote === null && force) {
      fail('COLLISION', 'A stale registration without a surviving checkpoint cannot bootstrap a new branch.');
    }
    await this.assertRemote(expected.owner, expected.repo, this.repositoryRoot);
    if (await this.remoteRef(expected.branch) !== remote || await this.localRef(expected.branch) !== local) {
      fail('STALE_IDENTITY', 'Git refs changed during recovery admission.');
    }

    if (present) {
      if (local !== candidate) await this.git(['merge', '--ff-only', candidate], expected.workspacePath);
    } else {
      if (local !== candidate) {
        // Zero expected-old creates only an absent branch; neither this CAS nor
        // worktree add relies on remote-tracking guesses.
        await this.git(['update-ref', `refs/heads/${expected.branch}`, candidate, local ?? '0'.repeat(40)], this.repositoryRoot);
      }
      await this.addWorktree(expected, force);
    }
    await this.assertWorkspace(expected, candidate, true);
    if (await this.localRef(expected.branch) !== candidate || await this.remoteRef(expected.branch) !== remote) {
      fail('STALE_IDENTITY', 'Git refs changed after workspace recovery; refusing execution.');
    }
    this.preparedHeads.set(expected.workspacePath, candidate);
    return expected;
  }

  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard {
    const startingHead = this.preparedHeads.get(identity.workspacePath);
    return { assertValid: async (phase = 'before-execution') => {
      if (phase === 'before-execution' && startingHead === undefined) fail('STALE_IDENTITY', 'No successful preparation proves the execution starting HEAD.');
      await this.assertWorkspace(identity, phase === 'before-execution' ? startingHead : undefined, true);
    } };
  }

  async verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot> {
    if (!SHA.test(request.expectedHeadSha)) fail('INVALID_REQUEST', 'Durable verification requires an exact HEAD SHA.');
    await request.workspaceGuard?.assertValid('after-execution');
    await this.assertWorkspace(request.identity, request.expectedHeadSha, true);
    const remote = await this.remoteRef(request.identity.branch, request.identity.workspacePath);
    if (remote !== request.expectedHeadSha) fail('UNPUSHED_HEAD', 'Implementation HEAD is not exactly published to its expected remote branch.');
    const progressBase = request.progressBaseSha ?? request.identity.baseSha;
    if (!SHA.test(progressBase)) fail('INVALID_REQUEST', 'Durable verification requires an exact progress base SHA.');
    if (!await this.isAncestor(request.identity.baseSha, request.expectedHeadSha)) fail('HEAD_MISMATCH', 'Implementation head does not descend from the immutable bootstrap base.');
    if (!await this.isAncestor(progressBase, request.expectedHeadSha)) fail('HEAD_MISMATCH', 'Implementation head does not descend from the progress head.');
    const changed = await this.git(['diff', '--quiet', progressBase, request.expectedHeadSha, '--'], request.identity.workspacePath, [0, 1]);
    if (changed.exitCode === 0) fail('HEAD_MISMATCH', 'Implementation execution made no tree progress from the required progress base.');
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

  private async assertRequest(request: BootstrapPlanRequest): Promise<void> {
    if (!SHA.test(request.baseSha) || !COMPONENT.test(request.runId) || !COMPONENT.test(request.target.owner) || !COMPONENT.test(request.target.repo) || !Number.isSafeInteger(request.target.issueNumber) || request.target.issueNumber < 1 ||
      request.baseBranch.includes('@{')) {
      fail('INVALID_REQUEST', 'Bootstrap request has an invalid target, branch, base SHA, or run id.');
    }
    // --branch expands previous-checkout syntax; rejecting @{ above makes this
    // a literal validation. Never normalize or silently substitute another ref.
    const ref = await this.git(['check-ref-format', '--branch', request.baseBranch], this.repositoryRoot, [0, 1, 128]);
    if (ref.exitCode !== 0 || ref.stdout.replace(/\r?\n$/, '') !== request.baseBranch) {
      fail('INVALID_REQUEST', 'Bootstrap requires a literal valid Git branch name.');
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
    await this.assertRegistration(identity, head, false);
    if (clean) {
      const status = (await this.git(['status', '--porcelain=v1', '--untracked-files=all'], identity.workspacePath)).stdout;
      if (status.trim() !== '') fail('DIRTY_WORKSPACE', 'Workspace has tracked or untracked local changes.');
    }
  }

  private async addWorktree(identity: ImplementationBootstrapIdentity, force: boolean): Promise<void> {
    mkdirSync(path.dirname(identity.workspacePath), { recursive: true });
    if (existsSync(identity.workspacePath) || this.canonicalFuturePath(identity.workspacePath) !== identity.workspacePath) {
      fail('COLLISION', 'Workspace path appeared or changed before linked worktree creation.');
    }
    await this.git(['worktree', 'add', ...(force ? ['--force'] : []), identity.workspacePath, identity.branch], this.repositoryRoot);
  }

  private async assertRegistration(identity: ImplementationBootstrapIdentity, localHead: string, missing: boolean): Promise<boolean> {
    const raw = (await this.git(['worktree', 'list', '--porcelain'], this.repositoryRoot)).stdout;
    const expectedPath = path.resolve(identity.workspacePath);
    const expectedBranch = `refs/heads/${identity.branch}`;
    const records = raw.trim().split(/\n\n+/).filter(Boolean).map((block) => {
      const lines = block.split(/\r?\n/);
      return {
        path: lines.find((line) => line.startsWith('worktree '))?.slice(9),
        branch: lines.find((line) => line.startsWith('branch '))?.slice(7),
        head: lines.find((line) => line.startsWith('HEAD '))?.slice(5),
        locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')),
      };
    });
    const related = records.filter((record) => record.path === expectedPath || record.branch === expectedBranch);
    if (related.length > 1 || related.some((record) => record.path !== expectedPath || record.branch !== expectedBranch ||
      record.head !== localHead || (missing && record.locked)) || (!missing && related.length !== 1)) {
      fail('COLLISION', 'Git worktree registration is not uniquely and safely owned by this bootstrap identity.');
    }
    return missing && related.length === 1;
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
