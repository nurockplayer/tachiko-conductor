import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError, type BootstrapPlanRequest, type BootstrapPrepareRequest, type DurableImplementationSnapshot, type ImplementationBootstrapAdapter, type VerifyDurableRequest } from '../adapters/bootstrap.js';
import type { ImplementationRequest, WorkspaceGuard } from '../adapters/agent.js';
import type { ImplementationBootstrapIdentity } from '../domain/types.js';
import { NodeProcessRunner, type ProcessRunner } from '../github/transport.js';

const SHA = /^[0-9a-f]{40}$/i;
interface PreparedLunaProof {
  readonly identity: Readonly<ImplementationBootstrapIdentity>;
  readonly runId: string;
  readonly authorizedHead: string;
  readonly workspaceRealPath: string;
  readonly gitRealPath: string;
  readonly workspaceStat: readonly [number, number];
  readonly gitStat: readonly [number, number];
  readonly metadataDirs: readonly { readonly path: string; readonly realPath: string; readonly dev: number; readonly ino: number }[];
}
const preparedLunaGuards = new WeakMap<object, PreparedLunaProof>();
const currentLunaProofs = new Map<string, PreparedLunaProof>();

/** Source-owned, read-only check for the exact guard minted by successful standalone prepare. */
export function hasPreparedStandaloneLunaInvocation(request: ImplementationRequest): boolean {
  const guard = request.workspaceGuard;
  if (guard === undefined || request.workspacePath === undefined || request.branch === undefined || request.runtimeOwnership === undefined) return false;
  const proof = preparedLunaGuards.get(guard as object);
  if (proof === undefined || currentLunaProofs.get(proof.identity.workspacePath) !== proof) return false;
  const target = request.target;
  return target.kind === 'issue' && target.owner === proof.identity.owner && target.repo === proof.identity.repo && target.issueNumber === proof.identity.issueNumber &&
    request.workspacePath === proof.identity.workspacePath && request.branch === proof.identity.branch && request.baseSha === proof.authorizedHead &&
    request.runtimeOwnership.runId === proof.runId;
}

/**
 * Host-owned, standalone checkout for #92 workers.  The worker checkout has
 * no remotes at all; publication is performed by the host from this checkout
 * only after the terminal clean descendant proof.
 */
export class StandaloneGitBootstrap implements ImplementationBootstrapAdapter {
  readonly kind = 'implementation-bootstrap' as const;
  readonly bootstrapKind = 'standalone-isolated' as const;
  private readonly source: string;
  private readonly root: string;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;
  constructor(options: { repositoryRoot: string; workspaceRoot: string; runner?: ProcessRunner; timeoutMs?: number }) {
    this.source = realpathSync(path.resolve(options.repositoryRoot));
    this.root = path.resolve(options.workspaceRoot); mkdirSync(this.root, { recursive: true });
    this.runner = options.runner ?? new NodeProcessRunner(); this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  async plan(request: BootstrapPlanRequest): Promise<ImplementationBootstrapIdentity> {
    if (!SHA.test(request.baseSha)) this.fail('INVALID_REQUEST', 'Standalone bootstrap requires an exact base SHA.');
    await this.assertBranchName(request);
    const identity = this.identity(request);
    if (existsSync(identity.workspacePath)) this.fail('COLLISION', 'Standalone workspace path already exists.');
    await this.assertPublicationRemote({ owner: request.target.owner, repo: request.target.repo });
    // The live snapshot's base must be imported from the authenticated remote,
    // rather than assumed to exist in a long-lived host checkout.
    await this.assertRemoteBase(request.baseBranch, request.baseSha);
    return identity;
  }
  async prepare(request: BootstrapPrepareRequest): Promise<ImplementationBootstrapIdentity> {
    // A retry cannot inherit a prior invocation's proof, even if preparation fails.
    currentLunaProofs.delete(path.resolve(request.existing.workspacePath));
    await this.assertBranchName(request);
    const identity = { ...this.identity(request), ...(request.existing.publicationBranch === undefined ? {} : { publicationBranch: request.existing.publicationBranch }) };
    if (!same(identity, request.existing)) this.fail('STALE_IDENTITY', 'Persisted standalone bootstrap identity changed.');
    const authorized = request.recoveryAuthority?.expectedHeadSha ?? request.existing.baseSha;
    if (!SHA.test(authorized)) this.fail('INVALID_REQUEST', 'Standalone recovery requires an exact authorized HEAD.');
    // Preparation may happen after a read-only plan was persisted or after a
    // restart. Revalidate the configured publication remote before even the
    // immutable-base fetch; the earlier plan check cannot authorize this later
    // invocation's trusted Git effects.
    await this.assertPublicationRemote(identity);
    // Import the immutable planned object into the trusted source before
    // initializing or changing the worker checkout. The named branch may
    // have advanced or been renamed since planning; identity.baseSha remains
    // the authorized immutable source.
    await this.fetchExactSourceSha(identity.baseSha, request.beforeMutation);
    if (!existsSync(identity.workspacePath)) {
      await this.git(this.root, ['init', '--initial-branch', identity.branch, identity.workspacePath], [0], request.beforeMutation);
      // Fetch exactly one immutable object from the trusted host checkout, then
      // remove the temporary local source remote before the worker can start.
      await this.git(identity.workspacePath, ['fetch', '--no-tags', this.source, identity.baseSha], [0], request.beforeMutation);
      if (authorized !== identity.baseSha) {
        // Existing-PR adoption starts at the PR's separately authenticated
        // head, never at a cached default branch or an ancestor artifact.
        await this.assertPublicationRemote(identity);
        await this.git(this.source, ['fetch', '--no-tags', 'origin', authorized], [0], request.beforeMutation);
        const fetched = (await this.git(this.source, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
        if (fetched !== authorized) this.fail('STALE_IDENTITY', 'Trusted host could not fetch the authoritative PR HEAD.');
        await this.git(identity.workspacePath, ['fetch', '--no-tags', this.source, authorized], [0], request.beforeMutation);
      }
      await this.git(identity.workspacePath, ['checkout', '--detach', authorized], [0], request.beforeMutation);
      await this.git(identity.workspacePath, ['switch', '-C', identity.branch, authorized], [0], request.beforeMutation);
      const remotes = (await this.git(identity.workspacePath, ['remote'])).stdout.trim();
      if (remotes !== '') this.fail('INVALID_REQUEST', 'Standalone worker checkout unexpectedly retained a remote.');
    }
    await this.assert(identity, authorized);
    const frozenIdentity = Object.freeze({ ...identity });
    const workspaceRealPath = realpathSync(identity.workspacePath);
    const gitPath = path.join(workspaceRealPath, '.git');
    const gitRealPath = realpathSync(gitPath);
    const workspaceStat = lstatSync(identity.workspacePath);
    const gitStat = lstatSync(gitPath);
    const proof: PreparedLunaProof = Object.freeze({
      identity: frozenIdentity, runId: request.runId, authorizedHead: authorized,
      workspaceRealPath, gitRealPath,
      workspaceStat: Object.freeze([workspaceStat.dev, workspaceStat.ino] as const),
      gitStat: Object.freeze([gitStat.dev, gitStat.ino] as const),
      metadataDirs: capturePrivateGitDirectories(gitPath),
    });
    currentLunaProofs.set(frozenIdentity.workspacePath, proof);
    // Return an immutable persisted identity; the separate repair authority stays in the proof.
    return frozenIdentity;
  }
  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard {
    const proof = currentLunaProofs.get(path.resolve(identity.workspacePath));
    if (proof === undefined || !same(proof.identity, identity)) return Object.freeze({ assertValid: () => this.fail('STALE_IDENTITY', 'Standalone invocation has no current source-minted preparation proof.') });
    const guard: WorkspaceGuard = Object.freeze({ assertValid: (phase?: 'before-execution' | 'after-execution') => {
      if (currentLunaProofs.get(proof.identity.workspacePath) !== proof) this.fail('STALE_IDENTITY', 'Standalone invocation preparation proof was superseded.');
      return this.assert(proof.identity, phase === 'after-execution' ? undefined : proof.authorizedHead, proof);
    } });
    preparedLunaGuards.set(guard, proof);
    return guard;
  }
  async verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot> {
    // Resolve the source-minted proof exactly once, before any Git operation
    // can yield. A later guard for the same workspace must never be borrowed.
    const identity = request.identity;
    const expectedHead = request.expectedHeadSha;
    const adoptionBase = request.progressBaseSha;
    const beforeMutation = request.beforeMutation;
    const beforePublish = request.beforePublish;
    const guard = request.workspaceGuard;
    const proof = guard === undefined ? undefined : preparedLunaGuards.get(guard as object);
    if (proof === undefined || currentLunaProofs.get(path.resolve(identity.workspacePath)) !== proof || !same(proof.identity, identity)) {
      this.fail('STALE_IDENTITY', 'Standalone durable verification requires the exact current source-minted workspace guard.');
    }
    const adoptingExistingHead = request.adoptExistingHead === true;
    const progressBase = adoptionBase ?? identity.baseSha;
    if (adoptingExistingHead) {
      if (proof.authorizedHead !== expectedHead) this.fail('STALE_IDENTITY', 'Existing PR adoption does not match its source-authorized HEAD.');
    } else if (proof.authorizedHead !== progressBase) {
      this.fail('STALE_IDENTITY', 'Standalone publication base differs from its source-authorized HEAD.');
    }
    await this.assert(identity, undefined, proof);
    const head = (await this.git(identity.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== expectedHead) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD differs from the reported exact HEAD.');
    if (adoptingExistingHead) {
      if (adoptionBase === undefined || adoptionBase === head) this.fail('HEAD_MISMATCH', 'Existing PR adoption requires a distinct authoritative PR base.');
      await this.ancestor(identity.workspacePath, adoptionBase, head);
      if (await this.tree(identity.workspacePath, adoptionBase) === await this.tree(identity.workspacePath, head)) {
        this.fail('HEAD_MISMATCH', 'Existing PR adoption has no tree progress from the authoritative PR base.');
      }
      // Adoption returns a read-only proof after asynchronous ancestry/tree
      // checks. Revalidate the same captured proof at that final acceptance
      // point so a successful reprepare during either await supersedes it.
      this.assertCurrentProof(identity, proof, expectedHead);
      return { headSha: head, branch: identity.branch };
    }
    if (typeof beforeMutation !== 'function') this.fail('INVALID_REQUEST', 'Standalone publication requires a synchronous host-owned beforeMutation fence.');
    if (typeof beforePublish !== 'function') this.fail('INVALID_REQUEST', 'Standalone publication requires a synchronous host-owned beforePublish fence.');
    if (head === progressBase) this.fail('HEAD_MISMATCH', 'Worker result did not advance the authorized HEAD.');
    await this.ancestor(identity.workspacePath, progressBase, head);
    if (await this.tree(identity.workspacePath, progressBase) === await this.tree(identity.workspacePath, head)) this.fail('HEAD_MISMATCH', 'Worker result has no tree progress from the authorized base.');
    // This command is host-owned.  The worker has no remote, credentials, or
    // source checkout authority, so it cannot publish the branch itself.
    // Import through trusted host Git state; never run a worker checkout's
    // hooks/config for publication.  Hooks are disabled on every host action.
    await this.git(this.source, ['fetch', '--no-tags', '--no-recurse-submodules', identity.workspacePath, head], [0], beforeMutation);
    // Re-prove ancestry in trusted source state after import. Worker-local
    // ancestry is insufficient to authorize a publication fence or push.
    await this.ancestor(this.source, progressBase, head);
    await this.assertPublicationRemote(identity);
    const ref = `refs/heads/${identity.publicationBranch ?? identity.branch}`;
    const before = await this.remoteHead(ref);
    if (before !== null) {
      await this.git(this.source, ['fetch', '--no-tags', 'origin', ref], [0], beforeMutation);
      await this.ancestor(this.source, before, head);
    }
    // Normal Git push is intentionally non-force. A concurrent/diverged ref
    // therefore remains untouched even if it changes after the re-read.
    await this.git(this.source, ['push', '--no-verify', 'origin', `${head}:${ref}`], [0], () => {
      beforePublish();
      this.assertCurrentProof(identity, proof, progressBase);
    });
    await this.assertPublicationRemote(identity);
    const published = (await this.git(this.source, ['ls-remote', '--heads', 'origin', ref])).stdout.trim().split(/\s+/)[0];
    if (published !== head) this.fail('UNPUSHED_HEAD', 'Host publication did not retain the exact standalone worker HEAD.');
    return { headSha: head, branch: identity.branch };
  }
  private identity(r: BootstrapPlanRequest): ImplementationBootstrapIdentity {
    const branch = `tachiko/${r.runId}`;
    const suffix = createHash('sha256').update(`${r.target.owner}/${r.target.repo}#${r.target.issueNumber}:${r.runId}`).digest('hex').slice(0, 16);
    return { bootstrapKind: 'standalone-isolated', owner: r.target.owner, repo: r.target.repo, issueNumber: r.target.issueNumber, baseBranch: r.baseBranch, baseSha: r.baseSha, branch, ...(r.publicationBranch === undefined ? {} : { publicationBranch: r.publicationBranch }), workspacePath: path.join(this.root, `luna-${suffix}`) };
  }
  private async assertBranchName(request: BootstrapPlanRequest): Promise<void> {
    const result = await this.git(this.root, ['check-ref-format', '--branch', `tachiko/${request.runId}`], [0, 1, 128]);
    if (result.exitCode !== 0) this.fail('INVALID_REQUEST', 'Standalone bootstrap generated an invalid Git branch name.');
  }
  private async assert(i: ImplementationBootstrapIdentity, recovery?: string, proof?: PreparedLunaProof): Promise<void> {
    if (proof !== undefined && currentLunaProofs.get(proof.identity.workspacePath) !== proof) this.fail('STALE_IDENTITY', 'Standalone invocation preparation proof was superseded.');
    if (!existsSync(i.workspacePath)) this.fail('STALE_IDENTITY', 'Standalone workspace disappeared.');
    const workspaceStat = lstatSync(i.workspacePath);
    const workspaceRealPath = realpathSync(i.workspacePath);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() || (proof !== undefined &&
        (workspaceRealPath !== proof.workspaceRealPath || workspaceStat.dev !== proof.workspaceStat[0] || workspaceStat.ino !== proof.workspaceStat[1]))) {
      this.fail('STALE_IDENTITY', 'Standalone workspace physical identity changed.');
    }
    this.assertWorkerGitSurface(i.workspacePath);
    if (proof !== undefined) {
      const gitPath = path.join(i.workspacePath, '.git');
      const gitStat = lstatSync(gitPath);
      if (realpathSync(gitPath) !== proof.gitRealPath || gitStat.dev !== proof.gitStat[0] || gitStat.ino !== proof.gitStat[1]) {
        this.fail('STALE_IDENTITY', 'Standalone Git metadata physical identity changed.');
      }
      for (const captured of proof.metadataDirs) {
        const stat = lstatSync(captured.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(captured.path) !== captured.realPath || stat.dev !== captured.dev || stat.ino !== captured.ino) {
          this.fail('STALE_IDENTITY', 'Standalone Git metadata directory physical identity changed.');
        }
      }
    }
    await this.assertNoWorkerIndexFlags(i.workspacePath);
    const branch = (await this.git(i.workspacePath, ['branch', '--show-current'])).stdout.trim();
    if (branch !== i.branch) this.fail('STALE_IDENTITY', 'Standalone worker branch changed.');
    if ((await this.git(i.workspacePath, ['remote'])).stdout.trim() !== '') this.fail('STALE_IDENTITY', 'Standalone worker checkout has a remote.');
    if ((await this.git(i.workspacePath, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim() !== '') this.fail('DIRTY_WORKSPACE', 'Standalone worker workspace is dirty.');
    const head = (await this.git(i.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!SHA.test(head)) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD is malformed.');
    if (recovery !== undefined && head !== recovery) this.fail('STALE_IDENTITY', 'Standalone restart cannot adopt a different worker HEAD.');
    if (proof !== undefined) {
      // Git checks await external processes. Revalidate all filesystem identity
      // evidence after the final await so a replacement during those checks
      // cannot be accepted by the worker boundary.
      this.assertWorkerGitSurface(i.workspacePath);
      const workspaceStat = lstatSync(i.workspacePath);
      const gitPath = path.join(i.workspacePath, '.git');
      const gitStat = lstatSync(gitPath);
      if (realpathSync(i.workspacePath) !== proof.workspaceRealPath || workspaceStat.dev !== proof.workspaceStat[0] || workspaceStat.ino !== proof.workspaceStat[1]) {
        this.fail('STALE_IDENTITY', 'Standalone workspace physical identity changed.');
      }
      if (realpathSync(gitPath) !== proof.gitRealPath || gitStat.dev !== proof.gitStat[0] || gitStat.ino !== proof.gitStat[1]) {
        this.fail('STALE_IDENTITY', 'Standalone Git metadata physical identity changed.');
      }
      for (const captured of proof.metadataDirs) {
        const stat = lstatSync(captured.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(captured.path) !== captured.realPath || stat.dev !== captured.dev || stat.ino !== captured.ino) {
          this.fail('STALE_IDENTITY', 'Standalone Git metadata directory physical identity changed.');
        }
      }
      if (currentLunaProofs.get(proof.identity.workspacePath) !== proof) this.fail('STALE_IDENTITY', 'Standalone invocation preparation proof was superseded.');
    }
  }
  /** Index flags can hide worker edits from porcelain cleanliness checks. */
  private async assertNoWorkerIndexFlags(workspace: string): Promise<void> {
    const entries = (await this.git(workspace, ['ls-files', '-v', '-z'])).stdout.split('\0');
    for (const entry of entries) {
      if (entry === '') continue;
      // Lowercase tags are assume-unchanged; uppercase S is skip-worktree.
      if (/^[a-zS] /.test(entry)) this.fail('DIRTY_WORKSPACE', 'Standalone worker index contains hidden-worktree flags.');
    }
  }
  private async ancestor(cwd: string, base: string, head: string): Promise<void> { if ((await this.git(cwd, ['merge-base', '--is-ancestor', base, head], [0, 1])).exitCode !== 0) this.fail('HEAD_MISMATCH', 'Worker HEAD does not descend from its authorized base.'); }
  private async tree(cwd: string, ref: string): Promise<string> { return (await this.git(cwd, ['rev-parse', `${ref}^{tree}`])).stdout.trim(); }
  private async assertRemoteBase(branch: string, expected: string): Promise<void> {
    const ref = `refs/heads/${branch}`;
    const actual = await this.remoteHead(ref);
    if (actual !== expected) this.fail('BASE_DRIFT', 'Named remote base does not match the live base SHA.');
  }
  private async fetchExactSourceSha(expected: string, beforeMutation?: () => void): Promise<void> {
    await this.git(this.source, ['fetch', '--no-tags', '--refetch', 'origin', expected], [0], beforeMutation);
    const fetched = (await this.git(this.source, ['rev-parse', 'FETCH_HEAD'])).stdout.trim();
    if (fetched !== expected) this.fail('BASE_DRIFT', 'Trusted host fetch does not match the immutable planned base SHA.');
  }
  private async assertPublicationRemote(request: Pick<ImplementationBootstrapIdentity, 'owner' | 'repo'>): Promise<void> {
    const urls = [...(await this.git(this.source, ['remote', 'get-url', '--all', 'origin'])).stdout.trim().split(/\r?\n/), ...(await this.git(this.source, ['remote', 'get-url', '--all', '--push', 'origin'])).stdout.trim().split(/\r?\n/)];
    const expected = `${request.owner}/${request.repo}`.toLowerCase();
    if (!urls.every((url) => githubIdentity(url)?.toLowerCase() === expected)) this.fail('REPOSITORY_MISMATCH', 'Trusted host publication remote does not exactly match the target GitHub repository.');
  }
  private assertWorkerGitSurface(workspace: string): void {
    const gitDir = path.join(workspace, '.git');
    if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) this.fail('STALE_IDENTITY', 'Standalone worker Git directory changed.');
    // A standalone checkout owns its complete Git directory. A worker-created
    // common-dir indirection would move config, refs, objects and grafts out
    // of the sealed surface below, so reject it before any host Git command.
    if (existsSync(path.join(gitDir, 'commondir'))) {
      this.fail('STALE_IDENTITY', 'Standalone worker Git directory redirects its common metadata.');
    }
    if (existsSync(path.join(gitDir, 'objects', 'info', 'alternates'))) {
      this.fail('STALE_IDENTITY', 'Standalone worker Git directory redirects object storage through alternates.');
    }
    assertPrivateGitMetadata(gitDir);
    // Git still honors legacy graft files even when replacement refs are
    // disabled. Reject this alternate ancestry authority before a host-owned
    // Git command can use it to certify an unrelated worker commit.
    if (existsSync(path.join(gitDir, 'info', 'grafts'))) {
      this.fail('STALE_IDENTITY', 'Standalone worker Git directory contains legacy graft ancestry.');
    }
    const config = path.join(gitDir, 'config');
    if (!existsSync(config) || !lstatSync(config).isFile()) this.fail('STALE_IDENTITY', 'Standalone worker Git config changed.');
    // extensions.worktreeConfig activates this additional worktree-local
    // source. Inspect it as inert text before any host Git invocation.
    for (const candidate of [config, path.join(gitDir, 'config.worktree')]) {
      if (!existsSync(candidate)) continue;
      if (!lstatSync(candidate).isFile() || hasExecutableGitConfig(readFileSync(candidate, 'utf8'))) {
        this.fail('STALE_IDENTITY', 'Worker Git config requests executable behavior.');
      }
    }
    const attributeFiles = [...findAttributeFiles(workspace), path.join(gitDir, 'info', 'attributes')];
    for (const file of attributeFiles) {
      if (!existsSync(file)) continue;
      if (!lstatSync(file).isFile() || hasFilterAttribute(readFileSync(file, 'utf8'))) {
        this.fail('STALE_IDENTITY', 'Worker Git attributes request filter behavior.');
      }
    }
  }
  private async remoteHead(ref: string): Promise<string | null> {
    const raw = (await this.git(this.source, ['ls-remote', '--heads', 'origin', ref])).stdout.trim();
    if (raw === '') return null;
    const [sha, returnedRef, ...rest] = raw.split(/\s+/);
    if (!SHA.test(sha ?? '') || returnedRef !== ref || rest.length !== 0) this.fail('COMMAND_FAILED', 'Git returned malformed remote ref identity.');
    return sha ?? null;
  }
  private assertCurrentProof(identity: ImplementationBootstrapIdentity, proof: PreparedLunaProof, authorizedHead: string): void {
    if (currentLunaProofs.get(path.resolve(identity.workspacePath)) !== proof || !same(proof.identity, identity) || proof.authorizedHead !== authorizedHead) {
      this.fail('STALE_IDENTITY', 'Standalone invocation preparation proof changed before final acceptance.');
    }
  }
  private async git(cwd: string, args: string[], allowed: number[] = [0], beforeSpawn?: () => void) {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_NO_REPLACE_OBJECTS = '1';
    const result = await this.runner.run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.useReplaceRefs=false', '-c', 'core.commitGraph=false', ...args], { cwd, timeoutMs: this.timeoutMs, env, ...(beforeSpawn === undefined ? {} : { beforeSpawn }) });
    if (!allowed.includes(result.exitCode)) this.fail('COMMAND_FAILED', `git ${args[0]} failed.`); return result;
  }
  private fail(code: keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, message: string): never { throw new ImplementationBootstrapError(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE[code], message); }
}
function same(a: ImplementationBootstrapIdentity, b: ImplementationBootstrapIdentity): boolean { return a.bootstrapKind === b.bootstrapKind && a.owner === b.owner && a.repo === b.repo && a.issueNumber === b.issueNumber && a.baseBranch === b.baseBranch && a.baseSha === b.baseSha && a.branch === b.branch && a.publicationBranch === b.publicationBranch && path.resolve(a.workspacePath) === path.resolve(b.workspacePath); }
function capturePrivateGitDirectories(root: string): PreparedLunaProof['metadataDirs'] {
  const dirs = ['objects', 'refs'].map((name) => {
    const candidate = path.join(root, name);
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Standalone worker Git metadata directory must be private and physical.');
    return Object.freeze({ path: candidate, realPath: realpathSync(candidate), dev: stat.dev, ino: stat.ino });
  });
  for (const name of ['info', 'hooks']) {
    const candidate = path.join(root, name);
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Standalone worker Git metadata directory must be private and physical.');
    dirs.push(Object.freeze({ path: candidate, realPath: realpathSync(candidate), dev: stat.dev, ino: stat.ino }));
  }
  return Object.freeze(dirs);
}

function assertPrivateGitMetadata(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error('Standalone worker Git metadata must not contain symbolic links.');
      if (stat.isDirectory()) visit(candidate);
      else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Standalone worker Git metadata must contain only private regular files and directories.');
    }
  };
  visit(root);
}
function githubIdentity(value: string): string | null {
  const url = value.trim(); let owner: string | undefined; let repo: string | undefined;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password) return null; [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/'); }
  catch { const match = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(url); if (match === null) return null; [, owner, repo] = match; }
  if (owner === undefined || repo === undefined || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo)) return null;
  return `${owner}/${repo.replace(/\.git$/, '')}`;
}

/**
 * Read attributes as inert text.  Asking Git to interpret a worker tree would
 * re-open the very filter surface this boundary is intended to close.
 */
function findAttributeFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const candidate = path.join(directory, entry.name);
      // Ordinary repository symlinks are inert to this scan. A symlink named
      // .gitattributes is rejected below only when it is attribute authority.
      if (entry.isSymbolicLink()) {
        if (entry.name === '.gitattributes') throw new Error('Standalone worker attribute authority must not be symbolic links.');
        continue;
      }
      if (entry.isDirectory()) {
        // A nested Git directory/worktree can carry its own config, hooks,
        // filters and replacement refs. Host verification never recurses into
        // worker-controlled Git repositories or submodules.
        if (existsSync(path.join(candidate, '.git'))) throw new Error('Standalone worker checkout must not contain nested Git repositories.');
        visit(candidate);
      }
      else if (entry.isFile() && entry.name === '.gitattributes') found.push(candidate);
    }
  };
  visit(root);
  return found;
}

/** Remove Git-config comments without treating quoted punctuation as syntax. */
function uncommentConfig(line: string): string {
  let quote = false;
  let escaped = false;
  let result = '';
  for (const char of line) {
    if (escaped) { result += char; escaped = false; continue; }
    if (char === '\\' && quote) { result += char; escaped = true; continue; }
    if (char === '"') { quote = !quote; result += char; continue; }
    if (!quote && (char === '#' || char === ';')) break;
    result += char;
  }
  return result.trim();
}

function logicalConfigLines(raw: string): readonly string[] {
  const lines: string[] = [];
  let pending = '';
  for (const physical of raw.split(/\r?\n/)) {
    let slashCount = 0;
    for (let index = physical.length - 1; index >= 0 && physical[index] === '\\'; index -= 1) slashCount += 1;
    if (slashCount % 2 === 1) { pending += physical.slice(0, -1); continue; }
    lines.push(`${pending}${physical}`); pending = '';
  }
  if (pending !== '') lines.push(pending);
  return lines;
}

/** Conservative Git-config parser for the executable configuration surface. */
function hasExecutableGitConfig(raw: string): boolean {
  let section = '';
  for (const physical of logicalConfigLines(raw)) {
    const line = uncommentConfig(physical);
    if (line === '') continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const header = line.slice(1, -1).trim();
      const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\.[A-Za-z0-9-]+|\s+"(?:[^"\\]|\\.)*")?$/.exec(header);
      if (match === null) return true; // malformed config is not safe to inspect
      section = match[1]!.toLowerCase();
      if (section === 'filter' || section === 'include' || section === 'includeif') return true;
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9.-]*)(?:\s*=\s*(.*)|\s*)$/.exec(line);
    if (assignment === null) return true;
    const key = assignment[1]!.toLowerCase();
    const value = assignment[2]?.trim().toLowerCase();
    if (section === 'filter' || key === 'filter' || key.startsWith('filter.') ||
      (section === 'core' && ['hookspath', 'fsmonitor', 'sshcommand', 'attributesfile', 'worktree', 'trustctime', 'checkstat'].includes(key)) ||
      (section === 'core' && ['filemode', 'symlinks'].includes(key) && !['true', 'yes', 'on', '1'].includes(value ?? '')) ||
      (section === 'include' && key === 'path') || section === 'includeif') return true;
  }
  return false;
}

function attributeTokens(line: string): readonly string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote = false;
  let escaped = false;
  const flush = () => { if (token !== '') { tokens.push(token); token = ''; } };
  for (const char of line) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote) { escaped = true; continue; }
    if (char === '"') { quote = !quote; continue; }
    if (!quote && /\s/.test(char)) { flush(); continue; }
    token += char;
  }
  if (quote || escaped) return null;
  flush();
  return tokens;
}

/** Git attribute parser which rejects every spelling of a filter attribute. */
function hasFilterAttribute(raw: string): boolean {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const tokens = attributeTokens(line);
    if (tokens === null || tokens.length < 2) return true;
    for (const token of tokens.slice(1)) {
      const name = token.replace(/^[!-]/, '').split('=', 1)[0]!.toLowerCase();
      if (name === 'filter' || name.startsWith('filter.')) return true;
    }
  }
  return false;
}
