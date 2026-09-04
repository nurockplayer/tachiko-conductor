import type { GitHubLiveSnapshot } from '../adapters/github.js';
import type { Run } from '../domain/types.js';

/** Return deterministic evidence whenever live PR identity cannot prove run ownership. */
export function pullRequestIdentityConflict(run: Run, snapshot: GitHubLiveSnapshot, options: { readonly allowHeadAdvance?: boolean } = {}): string | null {
  const expected = run.bootstrap;
  const actual = snapshot.pullRequest;
  if (expected === undefined) return null;
  if (actual === null || actual.headRepository === undefined || actual.headRepository === null ||
    actual.headRef === undefined || actual.baseRef === undefined) {
    return 'Live pull request identity is unavailable for a prepared workspace.';
  }
  if (actual.headRepository.owner.toLowerCase() !== expected.owner.toLowerCase() ||
    actual.headRepository.repo.toLowerCase() !== expected.repo.toLowerCase() ||
    actual.headRef !== expected.branch || actual.baseRef !== expected.baseBranch) {
    return `Live pull request #${actual.number} does not match the persisted branch and repository identity.`;
  }
  if (run.pullRequest !== undefined && (actual.number !== run.pullRequest.number ||
    (options.allowHeadAdvance !== true && actual.headSha !== run.pullRequest.headSha))) {
    return `Live pull request #${actual.number} does not match the persisted exact PR head identity.`;
  }
  return null;
}
