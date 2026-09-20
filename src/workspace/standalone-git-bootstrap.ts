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
    await this.assert(identity, request.recoveryAuthority?.expectedHeadSha);
    return identity;
  }
  guard(identity: ImplementationBootstrapIdentity): WorkspaceGuard { return { assertValid: () => this.assert(identity) }; }
  async verifyDurable(request: VerifyDurableRequest): Promise<DurableImplementationSnapshot> {
    await this.assert(request.identity);
    const head = (await this.git(request.identity.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== request.expectedHeadSha) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD differs from the reported exact HEAD.');
    if (request.progressBaseSha !== undefined) await this.ancestor(request.identity.workspacePath, request.progressBaseSha, head);
    else await this.ancestor(request.identity.workspacePath, request.identity.baseSha, head);
    // This command is host-owned.  The worker has no remote, credentials, or
    // source checkout authority, so it cannot publish the branch itself.
    await this.git(request.identity.workspacePath, ['push', this.source, `${head}:refs/heads/${request.identity.branch}`]);
    const published = (await this.git(this.source, ['rev-parse', `refs/heads/${request.identity.branch}`])).stdout.trim();
    if (published !== head) this.fail('UNPUSHED_HEAD', 'Host publication did not retain the exact standalone worker HEAD.');
    return { headSha: head, branch: request.identity.branch };
  }
  private identity(r: BootstrapPlanRequest): ImplementationBootstrapIdentity {
    const branch = `tachiko/${r.runId}`;
    const suffix = createHash('sha256').update(`${r.target.owner}/${r.target.repo}#${r.target.issueNumber}:${r.runId}`).digest('hex').slice(0, 16);
    return { owner: r.target.owner, repo: r.target.repo, issueNumber: r.target.issueNumber, baseBranch: r.baseBranch, baseSha: r.baseSha, branch, workspacePath: path.join(this.root, `luna-${suffix}`) };
  }
  private async assert(i: ImplementationBootstrapIdentity, recovery?: string): Promise<void> {
    if (!existsSync(i.workspacePath)) this.fail('STALE_IDENTITY', 'Standalone workspace disappeared.');
    const branch = (await this.git(i.workspacePath, ['branch', '--show-current'])).stdout.trim();
    if (branch !== i.branch) this.fail('STALE_IDENTITY', 'Standalone worker branch changed.');
    if ((await this.git(i.workspacePath, ['remote'])).stdout.trim() !== '') this.fail('STALE_IDENTITY', 'Standalone worker checkout has a remote.');
    if ((await this.git(i.workspacePath, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim() !== '') this.fail('DIRTY_WORKSPACE', 'Standalone worker workspace is dirty.');
    const head = (await this.git(i.workspacePath, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!SHA.test(head)) this.fail('HEAD_MISMATCH', 'Standalone worker HEAD is malformed.');
    if (recovery !== undefined && head !== recovery) this.fail('STALE_IDENTITY', 'Standalone restart cannot adopt a different worker HEAD.');
  }
  private async ancestor(cwd: string, base: string, head: string): Promise<void> { if ((await this.git(cwd, ['merge-base', '--is-ancestor', base, head], [0, 1])).exitCode !== 0) this.fail('HEAD_MISMATCH', 'Worker HEAD does not descend from its authorized base.'); }
  private async git(cwd: string, args: string[], allowed: number[] = [0]) { const result = await this.runner.run('git', args, { cwd, timeoutMs: this.timeoutMs }); if (!allowed.includes(result.exitCode)) this.fail('COMMAND_FAILED', `git ${args[0]} failed.`); return result; }
  private fail(code: keyof typeof IMPLEMENTATION_BOOTSTRAP_ERROR_CODE, message: string): never { throw new ImplementationBootstrapError(IMPLEMENTATION_BOOTSTRAP_ERROR_CODE[code], message); }
}
function same(a: ImplementationBootstrapIdentity, b: ImplementationBootstrapIdentity): boolean { return a.owner === b.owner && a.repo === b.repo && a.issueNumber === b.issueNumber && a.baseBranch === b.baseBranch && a.baseSha === b.baseSha && a.branch === b.branch && path.resolve(a.workspacePath) === path.resolve(b.workspacePath); }
