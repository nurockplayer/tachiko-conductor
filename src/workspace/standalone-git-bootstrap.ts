import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, ImplementationBootstrapError, type BootstrapPlanRequest, type BootstrapPrepareRequest, type DurableImplementationSnapshot, type ImplementationBootstrapAdapter, type VerifyDurableRequest } from '../adapters/bootstrap.js';
import type { WorkspaceGuard } from '../adapters/agent.js';
import type { ImplementationBootstrapIdentity } from '../domain/types.js';
import { NodeProcessRunner, type ProcessRunner } from '../github/transport.js';

const SHA = /^[0-9a-f]{40}$/i;

/**
 * Host-owned, standalone checkout for #92 workers.  The worker checkout has
 * no remotes at all; publication is performed by the host from this checkout
 * only after the terminal clean descendant proof.
 */
export class StandaloneGitBootstrap implements ImplementationBootstrapAdapter {
  readonly kind = 'implementation-bootstrap' as const;
  private readonly source: string;
  private readonly root: string;
  private readonly runner: ProcessRunner;
  private readonly timeoutMs: number;
  private readonly preparedHeads = new Map<string, string>();
  constructor(options: { repositoryRoot: string; workspaceRoot: string; runner?: ProcessRunner; timeoutMs?: number }) {
    this.source = realpathSync(path.resolve(options.repositoryRoot));
    this.root = path.resolve(options.workspaceRoot); mkdirSync(this.root, { recursive: true });
    this.runner = options.runner ?? new NodeProcessRunner(); this.timeoutMs = options.timeoutMs ?? 30_000;
  }
  async plan(request: BootstrapPlanRequest): Promise<ImplementationBootstrapIdentity> {
    if (!SHA.test(request.baseSha)) this.fail('INVALID_REQUEST', 'Standalone bootstrap requires an exact base SHA.');
    const identity = this.identity(request);
    if (existsSync(identity.workspacePath)) this.fail('COLLISION', 'Standalone workspace path already exists.');
    await this.git(this.source, ['cat-file', '-e', `${request.baseSha}^{commit}`]);
    await this.assertPublicationRemote({ owner: request.target.owner, repo: request.target.repo });
    return identity;
  }
  async prepare(request: BootstrapPrepareRequest): Promise<ImplementationBootstrapIdentity> {
    const identity = this.identity(request);
    if (!same(identity, request.existing)) this.fail('STALE_IDENTITY', 'Persisted standalone bootstrap identity changed.');
    if (!existsSync(identity.workspacePath)) {
      await this.git(this.root, ['init', '--initial-branch', identity.branch, identity.workspacePath]);
      // Fetch exactly one immutable object from the trusted host checkout, then
      // remove the temporary local source remote before the worker can start.
      await this.git(identity.workspacePath, ['fetch', '--no-tags', this.source, identity.baseSha]);
      await this.git(identity.workspacePath, ['checkout', '--detach', 'FETCH_HEAD']);
      await this.git(identity.workspacePath, ['switch', '-C', identity.branch, identity.baseSha]);
      const remotes = (await this.git(identity.workspacePath, ['remote'])).stdout.trim();
      if (remotes !== '') this.fail('INVALID_REQUEST', 'Standalone worker checkout unexpectedly retained a remote.');
    }
    const authorized = request.recoveryAuthority?.expectedHeadSha ?? request.existing.baseSha;
    await this.assert(identity, authorized);
    this.preparedHeads.set(identity.workspacePath, authorized);
    return identity;
  }
  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard { return { assertValid: (phase) => this.assert(identity, phase === 'after-execution' ? undefined : this.preparedHeads.get(identity.workspacePath) ?? identity.baseSha) }; }
  async verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot> {
    await this.assert(request.identity);
    const head = (await this.git(request.identity.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== request.expectedHeadSha) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD differs from the reported exact HEAD.');
    const progressBase = request.progressBaseSha ?? request.identity.baseSha;
    if (head === progressBase) this.fail('HEAD_MISMATCH', 'Worker result did not advance the authorized HEAD.');
    await this.ancestor(request.identity.workspacePath, progressBase, head);
    if (await this.tree(request.identity.workspacePath, progressBase) === await this.tree(request.identity.workspacePath, head)) this.fail('HEAD_MISMATCH', 'Worker result has no tree progress from the authorized base.');
    // This command is host-owned.  The worker has no remote, credentials, or
    // source checkout authority, so it cannot publish the branch itself.
    // Import through trusted host Git state; never run a worker checkout's
    // hooks/config for publication.  Hooks are disabled on every host action.
    await this.git(this.source, ['fetch', '--no-tags', '--no-recurse-submodules', request.identity.workspacePath, head]);
    await this.assertPublicationRemote(request.identity);
    const ref = `refs/heads/${request.identity.branch}`;
    const before = await this.remoteHead(ref);
    if (before !== null) {
      await this.git(this.source, ['fetch', '--no-tags', 'origin', ref]);
      await this.ancestor(this.source, before, head);
    }
    // Normal Git push is intentionally non-force. A concurrent/diverged ref
    // therefore remains untouched even if it changes after the re-read.
    await this.git(this.source, ['push', '--no-verify', 'origin', `${head}:${ref}`]);
    await this.assertPublicationRemote(request.identity);
    const published = (await this.git(this.source, ['ls-remote', '--heads', 'origin', `refs/heads/${request.identity.branch}`])).stdout.trim().split(/\s+/)[0];
    if (published !== head) this.fail('UNPUSHED_HEAD', 'Host publication did not retain the exact standalone worker HEAD.');
    return { headSha: head, branch: request.identity.branch };
  }
  private identity(r: BootstrapPlanRequest): ImplementationBootstrapIdentity {
    const branch = `tachiko/${r.runId}`;
    const suffix = createHash('sha256').update(`${r.target.owner}/${r.target.repo}#${r.target.issueNumber}:${r.runId}`).digest('hex').slice(0, 16);
    return { owner: r.target.owner, repo: r.target.repo, issueNumber: r.target.issueNumber, baseBranch: r.baseBranch, baseSha: r.baseSha, branch, workspacePath: path.join(this.root, `luna-${suffix}`) };
  }
  private async assert(i: ImplementationBootstrapIdentity, recovery?: string, initialBase?: string): Promise<void> {
    if (!existsSync(i.workspacePath)) this.fail('STALE_IDENTITY', 'Standalone workspace disappeared.');
    const branch = (await this.git(i.workspacePath, ['branch', '--show-current'])).stdout.trim();
    if (branch !== i.branch) this.fail('STALE_IDENTITY', 'Standalone worker branch changed.');
    if ((await this.git(i.workspacePath, ['remote'])).stdout.trim() !== '') this.fail('STALE_IDENTITY', 'Standalone worker checkout has a remote.');
    if ((await this.git(i.workspacePath, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim() !== '') this.fail('DIRTY_WORKSPACE', 'Standalone worker workspace is dirty.');
    const head = (await this.git(i.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!SHA.test(head)) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD is malformed.');
    if (recovery !== undefined && head !== recovery) this.fail('STALE_IDENTITY', 'Standalone restart cannot adopt a different worker HEAD.');
    if (recovery === undefined && initialBase !== undefined && head !== initialBase) this.fail('STALE_IDENTITY', 'Unrecorded pre-PR worker progress cannot be adopted after restart.');
  }
  private async ancestor(cwd: string, base: string, head: string): Promise<void> { if ((await this.git(cwd, ['merge-base', '--is-ancestor', base, head], [0, 1])).exitCode !== 0) this.fail('HEAD_MISMATCH', 'Worker HEAD does not descend from its authorized base.'); }
  private async tree(cwd: string, ref: string): Promise<string> { return (await this.git(cwd, ['rev-parse', `${ref}^{tree}`])).stdout.trim(); }
  private async assertPublicationRemote(request: Pick<ImplementationBootstrapIdentity, 'owner' | 'repo'>): Promise<void> {
    const urls = [
      (await this.git(this.source, ['remote', 'get-url', 'origin'])).stdout.trim(),
      (await this.git(this.source, ['remote', 'get-url', '--push', 'origin'])).stdout.trim(),
    ];
    if (!urls.every((url) => githubIdentity(url) === `${request.owner}/${request.repo}`)) this.fail('REPOSITORY_MISMATCH', 'Trusted host publication remote does not exactly match the target GitHub repository.');
  }
  private async remoteHead(ref: string): Promise<string | null> { const raw = (await this.git(this.source, ['ls-remote', '--heads', 'origin', ref])).stdout.trim(); return raw === '' ? null : raw.split(/\s+/)[0] ?? null; }
  private async git(cwd: string, args: string[], allowed: number[] = [0]) {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    for (const key of Object.keys(env)) if (key.startsWith('GIT_CONFIG_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key)) delete env[key];
    const result = await this.runner.run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd, timeoutMs: this.timeoutMs, env });
    if (!allowed.includes(result.exitCode)) this.fail('COMMAND_FAILED', `git ${args[0]} failed.`); return result;
  }
  private fail(code: keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, message: string): never { throw new ImplementationBootstrapError(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE[code], message); }
}
function same(a: ImplementationBootstrapIdentity, b: ImplementationBootstrapIdentity): boolean { return a.owner === b.owner && a.repo === b.repo && a.issueNumber === b.issueNumber && a.baseBranch === b.baseBranch && a.baseSha === b.baseSha && a.branch === b.branch && path.resolve(a.workspacePath) === path.resolve(b.workspacePath); }
function githubIdentity(value: string): string | null {
  const url = value.trim(); let owner: string | undefined; let repo: string | undefined;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.username || parsed.password) return null; [owner, repo] = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/'); }
  catch { const match = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(url); if (match === null) return null; [, owner, repo] = match; }
  if (owner === undefined || repo === undefined || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo)) return null;
  return `${owner}/${repo.replace(/\.git$/, '')}`;
}
