import type { GitHubLiveSnapshot } from '../adapters/github.js';
import type { Run } from '../domain/types.js';

/** Return evidence when live GitHub authority switched away from the persisted PR identity. */
export function pullRequestIdentityConflict(
  run: Run,
  snapshot: GitHubLiveSnapshot,
  options: { readonly allowHeadAdvance?: boolean } = {},
): string | null {
  const actual = snapshot.pullRequest;
  const bootstrap = run.bootstrap;
  if (bootstrap !== undefined && actual !== null && (actual.headRepository === null ||
    actual.headRepository.owner.toLowerCase() !== bootstrap.owner.toLowerCase() ||
    actual.headRepository.repo.toLowerCase() !== bootstrap.repo.toLowerCase() ||
    actual.headRef !== bootstrap.branch ||
    actual.baseRef !== bootstrap.baseBranch)) {
    const actualRepository = actual.headRepository === null
      ? '(unavailable)'
      : `${actual.headRepository.owner}/${actual.headRepository.repo}`;
    return `Live pull request #${actual.number} is ${actualRepository}:${actual.headRef} → ${actual.baseRef}, ` +
      `but this run owns ${bootstrap.owner}/${bootstrap.repo}:${bootstrap.branch} → ${bootstrap.baseBranch}.`;
  }
  const expected = run.pullRequest;
  if (expected === undefined) return null;
  if (actual === null) {
    return `Live GitHub no longer has persisted pull request #${expected.number}.`;
  }
  if (actual.number !== expected.number) {
    return `Live GitHub selected pull request #${actual.number}, but this run is bound to pull request #${expected.number}.`;
  }
  if (options.allowHeadAdvance !== true && actual.headSha !== expected.headSha) {
    return `Live pull request #${actual.number} HEAD ${actual.headSha} does not match its persisted HEAD ${expected.headSha}.`;
  }
  return null;
}
