import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import {
  IMPLEMENTATION_BOOTSTRAP_ERROR_CODE,
  ImplementationBootstrapError,
  type DurableImplementationSnapshot,
  type ImplementationBootstrapAdapter,
  type PlanImplementationBootstrapRequest,
  type PrepareImplementationBootstrapRequest,
  type VerifyDurableImplementationRequest,
} from '../adapters/bootstrap.js';
import type { WorkspaceGuard } from '../adapters/agent.js';
import type { ImplementationBootstrapIdentity } from '../domain/types.js';
import {
  NodeProcessRunner,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunner,
} from '../github/transport.js';

const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const OWNED_BRANCH = /^tachiko\/issue-[1-9][0-9]*-[0-9a-f]{16}$/;

export interface GitWorktreeBootstrapOptions {
  readonly repositoryRoot: string;
  readonly workspaceRoot: string;
  readonly remote?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
}

interface DirectoryPin {
  readonly path: string;
  readonly identity: string;
}

function bootstrapError(
  code: keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ImplementationBootstrapError {
  return new ImplementationBootstrapError(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE[code], message, details);
}

function repositoryFromRemote(raw: string): { owner: string; repo: string } | null {
  const value = raw.trim();
  let repositoryPath: string;
  try {
    const url = new URL(value);
    repositoryPath = url.pathname;
  } catch {
    const scp = /^(?:[^@\s]+@)?[^:\s]+:(.+)$/.exec(value);
    if (scp === null) return null;
    repositoryPath = scp[1] ?? '';
  }
  const parts = repositoryPath.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) return null;
  const owner = parts.at(-2) ?? '';
  const repo = (parts.at(-1) ?? '').replace(/\.git$/i, '');
  return owner === '' || repo === '' ? null : { owner, repo };
}

function identityMatches(
  actual: ImplementationBootstrapIdentity,
  expected: ImplementationBootstrapIdentity,
): boolean {
  return actual.owner === expected.owner &&
    actual.repo === expected.repo &&
    actual.issueNumber === expected.issueNumber &&
    actual.baseBranch === expected.baseBranch &&
    actual.baseSha === expected.baseSha &&
    actual.branch === expected.branch &&
    canonicalizeFuturePath(actual.workspacePath) === canonicalizeFuturePath(expected.workspacePath);
}

function canonicalizeFuturePath(input: string): string {
  let existing = path.resolve(input);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw bootstrapError('INVALID_REQUEST', `Cannot resolve a canonical ancestor for ${input}.`);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

function implementationBranch(issueNumber: number, runId: string): string {
  const runKey = createHash('sha256').update(runId).digest('hex').slice(0, 16);
  return `tachiko/issue-${issueNumber}-${runKey}`;
}

function materializeCanonicalDirectory(directory: string): void {
  let existing = directory;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw bootstrapError('INVALID_REQUEST', `Cannot materialize workspace root ${directory}.`);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  existing = realpathSync(existing);
  let parentStat = lstatSync(existing, { bigint: true });
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw bootstrapError('INVALID_REQUEST', `Workspace-root ancestor ${existing} is not a canonical directory.`);
  }
  let parentIdentity = `${parentStat.dev}:${parentStat.ino}`;
  for (const component of missing) {
    const currentParent = lstatSync(existing, { bigint: true });
    if (`${currentParent.dev}:${currentParent.ino}` !== parentIdentity || currentParent.isSymbolicLink()) {
      throw bootstrapError('COLLISION', `Workspace-root ancestor ${existing} changed during creation.`);
    }
    const child = path.join(existing, component);
    try {
      mkdirSync(child);
    } catch {
      throw bootstrapError('COLLISION', `Cannot safely create workspace-root directory ${child}.`);
    }
    const childStat = lstatSync(child, { bigint: true });
    if (childStat.isSymbolicLink() || !childStat.isDirectory() || realpathSync(child) !== child) {
      throw bootstrapError('COLLISION', `Workspace-root directory ${child} is not canonical.`);
    }
    existing = child;
    parentStat = childStat;
    parentIdentity = `${childStat.dev}:${childStat.ino}`;
  }
  if (existing !== directory) {
    throw bootstrapError('INVALID_REQUEST', `Workspace root ${directory} did not materialize canonically.`);
  }
}

/** Git worktree implementation of the provider-neutral bootstrap boundary. */
export class GitWorktreeBootstrap implements ImplementationBootstrapAdapter {
  readonly kind: 'implementation-bootstrap' = 'implementation-bootstrap';
  private readonly repositoryRoot: string;
  private readonly workspaceRoot: string;
  private readonly remote: string;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly workspaceRootIdentity: string;

  constructor(options: GitWorktreeBootstrapOptions) {
    this.repositoryRoot = realpathSync(path.resolve(options.repositoryRoot));
    this.workspaceRoot = canonicalizeFuturePath(options.workspaceRoot);
    this.remote = options.remote ?? 'origin';
    this.runner = options.runner ?? new NodeProcessRunner();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      this.repositoryRoot === this.workspaceRoot ||
      this.isWithin(this.repositoryRoot, this.workspaceRoot) ||
      this.isWithin(this.workspaceRoot, this.repositoryRoot)
    ) {
      throw bootstrapError('INVALID_REQUEST', 'Implementation workspace root must be outside the source repository.');
    }
    materializeCanonicalDirectory(this.workspaceRoot);
    const workspaceRootStat = lstatSync(this.workspaceRoot, { bigint: true });
    if (workspaceRootStat.isSymbolicLink() || realpathSync(this.workspaceRoot) !== this.workspaceRoot) {
      throw bootstrapError('INVALID_REQUEST', 'Implementation workspace root must be a pinned canonical directory.');
    }
    this.workspaceRootIdentity = `${workspaceRootStat.dev}:${workspaceRootStat.ino}`;
  }

  async plan(request: PlanImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    this.assertRequest(request);
    await this.assertRepository(request.target.owner, request.target.repo);

    const expected = this.expectedIdentity(request);
    this.assertIdentity(expected);
    await this.assertLiveBase(request.baseBranch, request.baseSha);
    if (existsSync(expected.workspacePath)) {
      throw bootstrapError('COLLISION', `Implementation workspace already exists at ${expected.workspacePath}.`);
    }
    if (await this.localBranchExists(expected.branch) || await this.remoteBranchSha(expected.branch) !== null) {
      throw bootstrapError(
        'COLLISION',
        `Implementation branch ${expected.branch} already exists without persisted Issue #${request.target.issueNumber} ownership.`,
      );
    }

    return expected;
  }

  async prepare(request: PrepareImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    this.assertRequest(request);
    if (request.existing === undefined) {
      throw bootstrapError('INVALID_REQUEST', 'Bootstrap identity must be planned and persisted before Git state is created.');
    }
    const expected = this.expectedIdentity(request);
    if (!identityMatches(request.existing, expected)) {
      throw bootstrapError(
        'STALE_IDENTITY',
        'Persisted bootstrap identity does not match the target, branch, base, or workspace for this run.',
      );
    }
    const entryPins = this.pinPresentWorkspacePath(request.existing);
    await this.assertRepository(request.target.owner, request.target.repo);
    this.assertWorkspacePathSnapshot(request.existing, entryPins);
    await this.restoreExisting(request.existing, request.baseSha, entryPins);
    return request.existing;
  }

  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard {
    const pins = this.pinExistingWorkspace(identity);
    return { assertValid: () => this.assertWorkspaceParents(pins) };
  }

  async verifyDurable(request: VerifyDurableImplementationRequest): Promise<DurableImplementationSnapshot> {
    if (!FULL_SHA.test(request.expectedHeadSha)) {
      throw bootstrapError('INVALID_REQUEST', 'Durable implementation verification requires an exact 40-hex HEAD SHA.');
    }
    const identity = request.identity;
    request.workspaceGuard?.assertValid();
    this.assertIdentity(identity);
    const workspaceGuard = request.workspaceGuard ?? this.guard(identity);
    workspaceGuard.assertValid();
    await this.assertRepository(identity.owner, identity.repo);
    workspaceGuard.assertValid();
    await this.assertWorkspace(identity);
    workspaceGuard.assertValid();

    const headSha = (await this.git(['rev-parse', 'HEAD'], identity.workspacePath)).stdout.trim();
    workspaceGuard.assertValid();
    if (!FULL_SHA.test(headSha) || headSha !== request.expectedHeadSha) {
      throw bootstrapError(
        'HEAD_MISMATCH',
        `Implementation workspace HEAD ${headSha || '(none)'} does not match reported HEAD ${request.expectedHeadSha}.`,
      );
    }
    if (headSha === identity.baseSha) {
      throw bootstrapError(
        'HEAD_MISMATCH',
        `Implementation branch ${identity.branch} contains no committed progress beyond bootstrap base ${identity.baseSha}.`,
      );
    }
    const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], identity.workspacePath);
    workspaceGuard.assertValid();
    if (status.stdout.trim() !== '') {
      throw bootstrapError(
        'DIRTY_WORKSPACE',
        'Implementation reported success with uncommitted or untracked workspace changes.',
      );
    }
    const remoteHead = await this.remoteBranchSha(identity.branch);
    workspaceGuard.assertValid();
    if (remoteHead !== headSha) {
      throw bootstrapError(
        'UNPUSHED_HEAD',
        `Implementation HEAD ${headSha} is not durably published at ${this.remote}/${identity.branch}.`,
      );
    }
    const ancestry = await this.git(
      ['merge-base', '--is-ancestor', identity.baseSha, headSha],
      identity.workspacePath,
      [0, 1],
    );
    workspaceGuard.assertValid();
    if (ancestry.exitCode !== 0) {
      throw bootstrapError(
        'HEAD_MISMATCH',
        `Implementation HEAD ${headSha} does not descend from bootstrap base ${identity.baseSha}.`,
      );
    }
    const treeDiff = await this.git(
      ['diff', '--quiet', identity.baseSha, headSha, '--'],
      identity.workspacePath,
      [0, 1],
    );
    workspaceGuard.assertValid();
    if (treeDiff.exitCode === 0) {
      throw bootstrapError(
        'HEAD_MISMATCH',
        `Implementation HEAD ${headSha} has no tree changes from bootstrap base ${identity.baseSha}.`,
      );
    }
    return { headSha, branch: identity.branch };
  }

  private expectedIdentity(
    request: PrepareImplementationBootstrapRequest | PlanImplementationBootstrapRequest,
  ): ImplementationBootstrapIdentity {
    const branch = implementationBranch(request.target.issueNumber, request.runId);
    const workspacePath = path.join(
      this.workspaceRoot,
      request.target.owner,
      request.target.repo,
      `${request.runId}-issue-${request.target.issueNumber}`,
    );
    return {
      owner: request.target.owner,
      repo: request.target.repo,
      issueNumber: request.target.issueNumber,
      baseBranch: request.baseBranch,
      baseSha: 'existing' in request && request.existing !== undefined ? request.existing.baseSha : request.baseSha,
      branch,
      workspacePath,
    };
  }

  private assertRequest(request: PrepareImplementationBootstrapRequest | PlanImplementationBootstrapRequest): void {
    if (!SAFE_RUN_ID.test(request.runId) ||
      !SAFE_COMPONENT.test(request.target.owner) ||
      !SAFE_COMPONENT.test(request.target.repo) ||
      !Number.isSafeInteger(request.target.issueNumber) ||
      request.target.issueNumber < 1 ||
      request.baseBranch.trim() === '' ||
      !FULL_SHA.test(request.baseSha)) {
      throw bootstrapError('INVALID_REQUEST', 'Bootstrap request contains an unsafe target, run id, branch, or base SHA.');
    }
  }

  private assertIdentity(identity: ImplementationBootstrapIdentity): void {
    const rootRelative = path.relative(this.workspaceRoot, canonicalizeFuturePath(identity.workspacePath));
    if (!SAFE_COMPONENT.test(identity.owner) ||
      !SAFE_COMPONENT.test(identity.repo) ||
      !Number.isSafeInteger(identity.issueNumber) ||
      identity.issueNumber < 1 ||
      !OWNED_BRANCH.test(identity.branch) ||
      identity.baseBranch.trim() === '' ||
      !FULL_SHA.test(identity.baseSha) ||
      rootRelative === '' ||
      rootRelative.startsWith('..') ||
      path.isAbsolute(rootRelative)) {
      throw bootstrapError('STALE_IDENTITY', 'Persisted bootstrap identity is unsafe or outside the configured workspace root.');
    }
  }

  private async assertRepository(owner: string, repo: string): Promise<void> {
    const remoteUrl = (await this.git(['remote', 'get-url', this.remote], this.repositoryRoot)).stdout;
    const actual = repositoryFromRemote(remoteUrl);
    if (actual === null || actual.owner.toLowerCase() !== owner.toLowerCase() || actual.repo.toLowerCase() !== repo.toLowerCase()) {
      throw bootstrapError(
        'REPOSITORY_MISMATCH',
        `Source repository remote ${this.remote} does not match ${owner}/${repo}; refusing to bootstrap another repository.`,
      );
    }
  }

  private async assertLiveBase(branch: string, expectedSha: string): Promise<void> {
    await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${branch}`], this.repositoryRoot);
    const fetched = (await this.git(['rev-parse', 'FETCH_HEAD'], this.repositoryRoot)).stdout.trim();
    if (fetched !== expectedSha) {
      throw bootstrapError(
        'BASE_DRIFT',
        `Fetched ${this.remote}/${branch} at ${fetched || '(none)'}, expected live GitHub base ${expectedSha}.`,
      );
    }
  }

  private async restoreExisting(
    identity: ImplementationBootstrapIdentity,
    liveBaseSha: string,
    initialPins: readonly DirectoryPin[],
  ): Promise<void> {
    this.assertIdentity(identity);
    this.assertWorkspacePathSnapshot(identity, initialPins);
    const hasWorkspace = existsSync(identity.workspacePath);
    const localSha = await this.localBranchSha(identity.branch);
    this.assertWorkspacePathSnapshot(identity, initialPins);
    const remoteSha = await this.remoteBranchSha(identity.branch);
    this.assertWorkspacePathSnapshot(identity, initialPins);
    if (!hasWorkspace && localSha === null && remoteSha === null) {
      if (identity.baseSha !== liveBaseSha) {
        throw bootstrapError(
          'BASE_DRIFT',
          `Persisted bootstrap base ${identity.baseSha} is stale; live ${identity.baseBranch} is ${liveBaseSha} and no durable implementation state exists.`,
        );
      }
      await this.assertLiveBase(identity.baseBranch, liveBaseSha);
      this.assertWorkspacePathSnapshot(identity, initialPins);
      const parentPins = this.ensureWorkspaceParents(identity);
      await this.git(['cat-file', '-e', `${identity.baseSha}^{commit}`], this.repositoryRoot);
      this.assertWorkspaceParents(parentPins);
      this.assertIdentity(identity);
      await this.git(
        ['worktree', 'add', '-b', identity.branch, identity.workspacePath, identity.baseSha],
        this.repositoryRoot,
      );
      await this.assertWorkspace(identity);
      return;
    }

    if (remoteSha !== null) {
      await this.fetchRemoteBranch(identity.branch, remoteSha);
      this.assertWorkspacePathSnapshot(identity, initialPins);
    }
    if (localSha !== null && remoteSha !== null && localSha !== remoteSha) {
      throw bootstrapError(
        'COLLISION',
        `Local ${identity.branch} at ${localSha} diverges from ${this.remote}/${identity.branch} at ${remoteSha}.`,
      );
    }
    const recoveredSha = localSha ?? remoteSha;
    if (recoveredSha === null) {
      throw bootstrapError('STALE_IDENTITY', `Workspace ${identity.workspacePath} has no recoverable branch identity.`);
    }
    const parentPins = hasWorkspace ? undefined : this.ensureWorkspaceParents(identity);
    await this.assertDescendsFromBase(identity, recoveredSha);
    if (parentPins === undefined) this.assertWorkspacePathSnapshot(identity, initialPins);
    else this.assertWorkspaceParents(parentPins);

    if (hasWorkspace) {
      await this.assertWorkspace(identity, recoveredSha, true);
      return;
    }
    if (parentPins === undefined) {
      throw bootstrapError('STALE_IDENTITY', 'Recovery workspace parents were not pinned before mutation.');
    }
    this.assertWorkspaceParents(parentPins);
    this.assertIdentity(identity);
    if (localSha !== null) {
      await this.git(['worktree', 'add', identity.workspacePath, identity.branch], this.repositoryRoot);
    } else {
      await this.git(
        ['worktree', 'add', '-b', identity.branch, identity.workspacePath, recoveredSha],
        this.repositoryRoot,
      );
    }
    await this.assertWorkspace(identity, recoveredSha);
  }

  private async assertWorkspace(
    identity: ImplementationBootstrapIdentity,
    expectedHeadSha?: string,
    requireClean = false,
  ): Promise<void> {
    this.assertIdentity(identity);
    const pins = this.pinExistingWorkspace(identity);
    const expectedTop = pins.at(-1)?.path;
    if (expectedTop === undefined) {
      throw bootstrapError('STALE_IDENTITY', 'Implementation workspace could not be pinned.');
    }
    const top = realpathSync(path.resolve((await this.git(['rev-parse', '--show-toplevel'], identity.workspacePath)).stdout.trim()));
    this.assertWorkspaceParents(pins);
    const branch = (await this.git(['symbolic-ref', '--short', 'HEAD'], identity.workspacePath)).stdout.trim();
    this.assertWorkspaceParents(pins);
    const headSha = expectedHeadSha === undefined
      ? undefined
      : (await this.git(['rev-parse', 'HEAD'], identity.workspacePath)).stdout.trim();
    this.assertWorkspaceParents(pins);
    if (!this.isWithin(this.workspaceRoot, expectedTop) || top !== expectedTop || branch !== identity.branch ||
      (expectedHeadSha !== undefined && headSha !== expectedHeadSha)) {
      throw bootstrapError(
        'STALE_IDENTITY',
        `Workspace ${identity.workspacePath} is not the expected ${identity.branch} worktree.`,
      );
    }
    if (requireClean) {
      const status = await this.git(['status', '--porcelain=v1', '--untracked-files=all'], identity.workspacePath);
      this.assertWorkspaceParents(pins);
      if (status.stdout.trim() !== '') {
        throw bootstrapError(
          'DIRTY_WORKSPACE',
          `Workspace ${identity.workspacePath} has uncommitted or untracked state; refusing automatic recovery.`,
        );
      }
    }
  }

  private ensureWorkspaceParents(identity: ImplementationBootstrapIdentity): readonly DirectoryPin[] {
    this.assertPinnedWorkspaceRoot();
    const pins: DirectoryPin[] = [];
    let parent = this.workspaceRoot;
    for (const component of [identity.owner, identity.repo]) {
      const child = path.join(parent, component);
      if (!existsSync(child)) {
        try {
          mkdirSync(child);
        } catch {
          throw bootstrapError('COLLISION', `Cannot safely create implementation workspace directory ${child}.`);
        }
      }
      const pin = this.pinCanonicalDirectory(child);
      pins.push(pin);
      parent = child;
    }
    if (canonicalizeFuturePath(path.dirname(identity.workspacePath)) !== parent) {
      throw bootstrapError('STALE_IDENTITY', 'Persisted workspace parent does not match the configured repository path.');
    }
    this.assertWorkspaceParents(pins);
    return pins;
  }

  private pinExistingWorkspace(identity: ImplementationBootstrapIdentity): readonly DirectoryPin[] {
    this.assertIdentity(identity);
    this.assertPinnedWorkspaceRoot();
    const ownerPath = path.join(this.workspaceRoot, identity.owner);
    const repoPath = path.join(ownerPath, identity.repo);
    const workspacePath = path.join(repoPath, path.basename(identity.workspacePath));
    if (canonicalizeFuturePath(identity.workspacePath) !== workspacePath) {
      throw bootstrapError('STALE_IDENTITY', 'Persisted workspace path is not the configured canonical run directory.');
    }
    const pins = [ownerPath, repoPath, workspacePath].map((directory) => this.pinCanonicalDirectory(directory));
    this.assertWorkspaceParents(pins);
    return pins;
  }

  private pinPresentWorkspacePath(identity: ImplementationBootstrapIdentity): readonly DirectoryPin[] {
    this.assertPinnedWorkspaceRoot();
    const pins: DirectoryPin[] = [];
    const ownerPath = path.join(this.workspaceRoot, identity.owner);
    const repoPath = path.join(ownerPath, identity.repo);
    const workspacePath = path.join(repoPath, path.basename(identity.workspacePath));
    for (const directory of [
      ownerPath,
      repoPath,
      workspacePath,
    ]) {
      if (!existsSync(directory)) break;
      pins.push(this.pinCanonicalDirectory(directory));
    }
    this.assertWorkspaceParents(pins);
    return pins;
  }

  private assertWorkspacePathSnapshot(
    identity: ImplementationBootstrapIdentity,
    expectedPins: readonly DirectoryPin[],
  ): void {
    this.assertWorkspaceParents(expectedPins);
    const currentPins = this.pinPresentWorkspacePath(identity);
    if (currentPins.length !== expectedPins.length || currentPins.some((pin, index) =>
      pin.path !== expectedPins[index]?.path || pin.identity !== expectedPins[index]?.identity)) {
      throw bootstrapError(
        'COLLISION',
        `Implementation workspace path ${identity.workspacePath} appeared or changed during recovery.`,
      );
    }
  }

  private pinCanonicalDirectory(directory: string): DirectoryPin {
    try {
      const stat = lstatSync(directory, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== directory) {
        throw new Error('not a canonical directory');
      }
      return { path: directory, identity: `${stat.dev}:${stat.ino}` };
    } catch {
      throw bootstrapError('COLLISION', `Implementation workspace directory ${directory} is not a pinned canonical directory.`);
    }
  }

  private assertWorkspaceParents(pins: readonly DirectoryPin[]): void {
    this.assertPinnedWorkspaceRoot();
    for (const pin of pins) {
      const current = this.pinCanonicalDirectory(pin.path);
      if (current.identity !== pin.identity) {
        throw bootstrapError(
          'COLLISION',
          `Implementation workspace directory ${pin.path} changed during recovery.`,
        );
      }
    }
  }

  private assertPinnedWorkspaceRoot(): void {
    try {
      const rootStat = lstatSync(this.workspaceRoot, { bigint: true });
      const identity = `${rootStat.dev}:${rootStat.ino}`;
      if (rootStat.isSymbolicLink() || identity !== this.workspaceRootIdentity ||
        realpathSync(this.workspaceRoot) !== this.workspaceRoot) {
        throw new Error('identity changed');
      }
    } catch {
      throw bootstrapError(
        'COLLISION',
        `Implementation workspace root ${this.workspaceRoot} changed after it was pinned; refusing filesystem mutation.`,
      );
    }
  }

  private async localBranchExists(branch: string): Promise<boolean> {
    const result = await this.git(
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      this.repositoryRoot,
      [0, 1],
    );
    return result.exitCode === 0;
  }

  private async localBranchSha(branch: string): Promise<string | null> {
    if (!await this.localBranchExists(branch)) return null;
    const sha = (await this.git(['rev-parse', `refs/heads/${branch}`], this.repositoryRoot)).stdout.trim();
    if (!FULL_SHA.test(sha)) {
      throw bootstrapError('COMMAND_FAILED', `Git returned malformed local branch identity for ${branch}.`);
    }
    return sha;
  }

  private async fetchRemoteBranch(branch: string, expectedSha: string): Promise<void> {
    await this.git(['fetch', '--no-tags', this.remote, `refs/heads/${branch}`], this.repositoryRoot);
    const fetched = (await this.git(['rev-parse', 'FETCH_HEAD'], this.repositoryRoot)).stdout.trim();
    if (fetched !== expectedSha) {
      throw bootstrapError(
        'COLLISION',
        `Remote branch ${this.remote}/${branch} changed from ${expectedSha} to ${fetched || '(none)'} during recovery.`,
      );
    }
  }

  private async assertDescendsFromBase(identity: ImplementationBootstrapIdentity, headSha: string): Promise<void> {
    const ancestry = await this.git(
      ['merge-base', '--is-ancestor', identity.baseSha, headSha],
      this.repositoryRoot,
      [0, 1],
    );
    if (ancestry.exitCode !== 0) {
      throw bootstrapError(
        'COLLISION',
        `Recovered branch ${identity.branch} at ${headSha} does not descend from persisted base ${identity.baseSha}.`,
      );
    }
  }

  private async remoteBranchSha(branch: string): Promise<string | null> {
    const result = await this.git(
      ['ls-remote', '--heads', this.remote, `refs/heads/${branch}`],
      this.repositoryRoot,
    );
    const line = result.stdout.trim();
    if (line === '') return null;
    const [sha, ref, ...extra] = line.split(/\s+/);
    if (extra.length !== 0 || ref !== `refs/heads/${branch}` || sha === undefined || !FULL_SHA.test(sha)) {
      throw bootstrapError(
        'COMMAND_FAILED',
        `Git returned malformed remote branch identity for ${this.remote}/${branch}.`,
      );
    }
    return sha;
  }

  private async git(
    args: readonly string[],
    cwd: string,
    allowedExitCodes: readonly number[] = [0],
  ): Promise<ProcessResult> {
    let result: ProcessResult;
    const options: ProcessRunOptions = { cwd, timeoutMs: this.timeoutMs };
    try {
      result = await this.runner.run('git', args, options);
    } catch (error) {
      throw bootstrapError(
        'COMMAND_FAILED',
        `Git command failed while preparing implementation state: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw bootstrapError(
        'COMMAND_FAILED',
        `Git command ${args[0] ?? '(unknown)'} exited with status ${result.exitCode}.`,
        { exitCode: result.exitCode },
      );
    }
    return result;
  }

  private isWithin(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  }
}
