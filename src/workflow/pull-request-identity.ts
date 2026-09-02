import type { GitHubLiveSnapshot } from '../adapters/github.js';
import type { Run } from '../domain/types.js';

/** Return evidence when live GitHub authority switched away from the persisted PR identity. */
export function pullRequestIdentityConflict(
  run: Run,
  snapshot: GitHubLiveSnapshot,
  options: { readonly allowHeadAdvance?: boolean } = {},
): string | null {
  const expected = run.pullRequest;
  if (expected === undefined) return null;
  const actual = snapshot.pullRequest;
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
