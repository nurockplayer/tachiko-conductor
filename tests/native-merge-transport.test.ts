import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import { GhCliTransport, type GitHubWriteTransport, type ProcessRunner } from '../src/github/transport.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import { resolveNativeMergeHost, type NativeMergePolicy } from '../src/workflow/merge.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), tree = 'c'.repeat(40), merge = 'd'.repeat(40);
const policy: NativeMergePolicy = { enabled: true, revision: 'merge-v1', releaseId: 'accepted-release', campaign: 'bounded', dispatchRevision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, baseBranch: 'main', method: 'squash', integrationPolicy: 'bootstrap-base-tree-v1', reviewPolicyRevision: 'review-v1', localValidationRevision: 'local-v1', hostedValidationRevision: 'hosted-v1' };
it('uses documented expected-HEAD squash PUT and independent direct commit/default/ancestry read APIs', async () => {
  const calls: unknown[] = [];
  const transport: GitHubWriteTransport = {
    async get(path) {
      calls.push(path);
      if (path.endsWith(`/git/commits/${merge}`)) return { sha: merge, tree: { sha: tree }, parents: [{ sha: base }] };
      if (path.includes('/compare/')) return { status: 'ahead', merge_base_commit: { sha: merge } };
      if (path.endsWith('/commits/main')) return { sha: merge };
      return { default_branch: 'main' };
    }, async getPaginated() { return []; },
    async write(path, method, body) { calls.push({ path, method, body }); return { merged: true, sha: merge }; },
  };
  const github = new LiveGitHubAdapter({ transport });
  await github.squashPullRequest('acme', 'widgets', 7, head);
  assert.deepEqual(calls[0], { path: 'repos/acme/widgets/pulls/7/merge', method: 'PUT', body: { sha: head, merge_method: 'squash' } });
  assert.deepEqual(await github.readDefaultBranch('acme', 'widgets'), { branch: 'main', headSha: merge });
  assert.deepEqual(await github.readCommit('acme', 'widgets', merge), { sha: merge, treeSha: tree, parents: [base] });
  assert.equal(await github.isAncestor('acme', 'widgets', merge, head), true);
  await assert.rejects(github.squashPullRequest('acme', 'widgets', 7, 'branch-name'), /exact/);
});
it('preserves PUT and literal SHA in the ordinary gh write transport', async () => {
  let args: readonly string[] = [];
  const runner: ProcessRunner = { async run(file, supplied) { assert.equal(file, 'gh'); args = supplied; return { exitCode: 0, stdout: '{"merged":true}', stderr: '' }; } };
  await new GhCliTransport({ runner }).write('repos/acme/widgets/pulls/7/merge', 'PUT', { sha: head, merge_method: 'squash' });
  assert.equal(args[args.indexOf('--method') + 1], 'PUT'); assert.ok(args.includes(`sha=${head}`)); assert.ok(args.includes('merge_method=squash'));
});
it('requires an exact descriptor and separate trusted host, snapshots process policy, and rejects contradictory or unknown enabled fields', () => {
  const config = { revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 };
  assert.equal(parseDispatchConfiguration(JSON.stringify(config)).merge, undefined);
  assert.deepEqual(parseDispatchConfiguration(JSON.stringify({ ...config, merge: policy })).merge, policy);
  assert.equal(resolveNativeMergeHost(), undefined);
  for (const mutation of [{ enabled: false }, { method: 'merge' }, { force: true }, { releaseId: '' }, { dispatchRevision: 'foreign' }, { controlIssue: 999 }]) assert.throws(() => parseDispatchConfiguration(JSON.stringify({ ...config, merge: { ...policy, ...mutation } })), /merge/);
  const supplied = { policy: structuredClone(policy), candidate: () => ({ treeSha: tree, baseIsAncestor: true }) };
  const resolved = resolveNativeMergeHost(supplied)!;
  (supplied.policy as { revision: string }).revision = 'mutated';
  assert.equal(resolved.policy.revision, policy.revision); assert.equal(Object.isFrozen(resolved.policy), true);
  assert.equal(resolveNativeMergeHost({ ...supplied, enabled: true } as never), undefined);
});
