import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import type { ProcessRunner } from '../src/github/transport.js';
import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { LIVE_HEAD_SYNC_DECISION } from '../src/domain/decisions.js';
import type { AgentResult, ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { resumeCommand } from '../src/cli.js';
import { runWorkflow } from '../src/workflow/run.js';
import { TARGET, T0, successResult } from './helpers.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const dirs: string[] = [];
const fixtures: BootstrapGitFixture[] = [];

const identity: ImplementationBootstrapIdentity = {
  owner: TARGET.owner,
  repo: TARGET.repo,
  issueNumber: TARGET.issueNumber,
  baseBranch: 'main',
  baseSha: BASE,
  branch: 'tachiko/issue-42-run-1',
  workspacePath: '/tmp/tachiko-test-workspace/run-1',
};

function pr(number: number, headSha: string, extra: Record<string, unknown> = {}) {
  return {
    id: `PR_${number}`,
    number,
    title: 'implementation',
    url: `https://github.com/${TARGET.owner}/${TARGET.repo}/pull/${number}`,
    state: 'open' as const,
    isDraft: false,
    mergeable: true,
    mergeStateStatus: 'CLEAN',
    updatedAt: T0,
    headSha,
    baseSha: BASE,
    headRef: identity.branch,
    headRepository: { owner: TARGET.owner, repo: TARGET.repo },
    baseRef: identity.baseBranch,
    ...extra,
  };
}

function snapshot(headSha: string, pull: ReturnType<typeof pr> | null = pr(7, headSha), extra: Record<string, unknown> = {}): GitHubLiveSnapshot {
  return {
    repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: 'main', defaultBranchHeadSha: BASE },
    issue: { id: 'I_42', number: TARGET.issueNumber, title: 'issue', body: 'implement it', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
    pullRequest: pull as GitHubLiveSnapshot['pullRequest'],
    headSha,
    checks: { availability: 'available', overall: 'passing', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: T0,
    ...extra,
  };
}

class QueueGithub implements GitHubAdapter {
  readonly kind = 'github' as const;
  constructor(private readonly queue: Array<GitHubLiveSnapshot | (() => GitHubLiveSnapshot)>) {}
  async readIssue(): Promise<never> { throw new Error('unused'); }
  async readBranch(): Promise<never> { throw new Error('unused'); }
  async listPullRequests(): Promise<never> { throw new Error('unused'); }
  async readLiveSnapshot() {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('No live snapshot queued');
    return typeof next === 'function' ? next() : next;
  }
}

class NoopImplementation implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  readonly requests: unknown[] = [];
  async run(request: unknown): Promise<AgentResult> {
    this.requests.push(request);
    return successResult(NEW);
  }
}

class ApprovingReviewer implements ReviewerAdapter {
  readonly kind = 'reviewer' as const;
  async review(request: { headSha: string }): Promise<ReviewResult> {
    return { verdict: 'approve', reviewerName: 'test-reviewer', headSha: request.headSha, findings: [] };
  }
}

function withBootstrap(run: Run, headSha = OLD, pullRequestHeadSha = OLD): Run {
  let current = applyTransition(run, { type: 'start' }, T0);
  current = applyTransition(current, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
  current = applyTransition(current, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha, pullRequest: { number: 7, headSha: pullRequestHeadSha } }, T0);
  current = applyTransition(current, { type: 'validation_passed' }, T0);
  return current;
}

function parkedForSync(): Run {
  const reviewing = withBootstrap(createRun(TARGET, T0, 'run-1'));
  return applyTransition(reviewing, {
    type: 'escalate',
    reason: 'live HEAD advanced',
    interrupt: { choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] },
  }, T0);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('bootstrap lifecycle acceptance coverage', () => {
  it('E1 persists an offered live-head sync atomically and resumes from a fresh JsonFileStore read/list', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-'));
    dirs.push(dir);
    const store = new JsonFileStore({ dir });
    store.create(parkedForSync());
    const deps = {
      store,
      github: new QueueGithub([snapshot(NEW), snapshot(NEW), snapshot(NEW), snapshot(NEW)]),
      implementation: new NoopImplementation(),
      reviewer: new ApprovingReviewer(),
      maxReviewAttempts: 2,
    };

    const outcome = await resumeCommand(deps, 'run-1', LIVE_HEAD_SYNC_DECISION, { now: () => T0, maxReviewAttempts: 2 });
    assert.equal(outcome.outcome, 'merge_ready', JSON.stringify(outcome));
    const restarted = new JsonFileStore({ dir });
    const persisted = restarted.read('run-1');
    assert.equal(persisted?.headSha, NEW);
    assert.equal(persisted?.pullRequest?.headSha, NEW);
    assert.deepEqual(restarted.list().map((run) => run.id), ['run-1']);
  });

  it('E1 keeps the accepted H and PR tuple when a live-head failure occurs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-'));
    dirs.push(dir);
    const store = new JsonFileStore({ dir });
    store.create(withBootstrap(createRun(TARGET, T0, 'run-1')));
    const before = store.read('run-1')!;
    const outcome = await runWorkflow({
      store,
      github: new QueueGithub([snapshot(NEW)]),
      implementation: new NoopImplementation(),
      reviewer: new ApprovingReviewer(),
    }, 'run-1', { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'needs_human');
    const after = new JsonFileStore({ dir }).read('run-1')!;
    assert.equal(after.headSha, before.headSha);
    assert.equal(after.pullRequest?.headSha, before.pullRequest?.headSha);
  });

  it('E2 rejects same-SHA ownership mutation during recovery before implementation execution', async () => {
    const run = { ...withBootstrap(createRun(TARGET, T0, 'run-2')), state: 'IMPLEMENTING' as const };
    const store = { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined };
    const implementation = new NoopImplementation();
    const result = await runWorkflow({
      store,
      github: new QueueGithub([snapshot(OLD, pr(8, OLD)), snapshot(OLD, pr(8, OLD)), snapshot(OLD, pr(8, OLD))]),
      implementation,
      reviewer: new ApprovingReviewer(),
      bootstrap: { kind: 'implementation-bootstrap', plan: async () => identity, prepare: async () => identity, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: OLD, branch: identity.branch }) },
    }, 'run-2', { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(result.outcome, 'needs_human');
    assert.equal(implementation.requests.length, 0);
    assert.match(result.reason, /does not match|identity/i);
  });

  it('E1 ordinary bootstrap agent failure round-trips while retaining the accepted H and PR', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-'));
    dirs.push(dir);
    const store = new JsonFileStore({ dir });
    let run = createRun(TARGET, T0, 'failure-run');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    run = { ...run, headSha: OLD, pullRequest: { number: 7, headSha: OLD } };
    store.create(run);
    run = applyTransition(run, { type: 'agent_failed', agentResult: { exitStatus: 'failure', summary: 'provider crashed', headSha: NEW } }, T0);
    store.update(run);
    const loaded = new JsonFileStore({ dir }).read('failure-run')!;
    assert.equal(loaded.state, 'FAILED');
    assert.equal(loaded.headSha, OLD);
    assert.deepEqual(loaded.pullRequest, { number: 7, headSha: OLD });
    assert.equal(loaded.agentResult?.headSha, NEW);
    assert.deepEqual(new JsonFileStore({ dir }).list().map((item) => item.id), ['failure-run']);
  });

  it('E2 rejects same-SHA tuple drift at the final gate for each ownership field', async () => {
    const driftCases: Array<[string, Record<string, unknown>]> = [
      ['number', { number: 8 }],
      ['head repository owner', { headRepository: { owner: 'other', repo: TARGET.repo } }],
      ['head repository repo', { headRepository: { owner: TARGET.owner, repo: 'other' } }],
      ['head ref', { headRef: 'other-branch' }],
      ['base ref', { baseRef: 'other-base' }],
      ['missing head ref', { headRef: undefined }],
    ];
    for (const [label, mutation] of driftCases) {
      let run = withBootstrap(createRun(TARGET, T0, `final-${label.replace(/\W+/g, '-')}`));
      run = applyTransition(run, { type: 'review_approved', reviewResult: { verdict: 'approve', reviewerName: 'reviewer', headSha: OLD, findings: [] } }, T0);
      const result = await runWorkflow({
        store: { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined },
        github: new QueueGithub([snapshot(OLD, pr(7, OLD, mutation))]),
        implementation: new NoopImplementation(),
        reviewer: new ApprovingReviewer(),
      }, run.id, { maxReviewAttempts: 1, now: () => T0 });
      assert.equal(result.outcome, 'needs_human', label);
      assert.equal((result as { run: Run }).run.state, 'NEEDS_HUMAN', label);
    }
  });

  it('E6 runs initial no-PR bootstrap through real Git, publishes a PR, and persists restart checkpoints', async () => {
    const fixture = createBootstrapGitFixture({ branch: 'feature/stable' });
    fixtures.push(fixture);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-'));
    dirs.push(dir);
    const store = new JsonFileStore({ dir });
    const liveBase = fixture.commit(fixture.source, 'live-base.txt', 'live base\n');
    fixture.git(fixture.source, ['push', 'origin', fixture.branch]);
    fixture.git(fixture.source, ['reset', '--hard', fixture.baseSha]);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const runId = 'e6-initial';
    let implementationBranch: string | undefined;
    let implementationHead: string | undefined;
    const initial = snapshot(liveBase, null, { headSha: null, repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: liveBase } });
    const published = () => {
      const head = implementationHead ?? fixture.git(fixture.source, ['rev-parse', 'HEAD']);
      return snapshot(head, pr(7, head, { baseSha: liveBase, baseRef: fixture.branch, headRef: implementationBranch }));
    };
    // The implementation receives the deterministic branch from bootstrap; use
    // a wrapper to push to that exact branch after the commit.
    const realImplementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request: { workspacePath?: string; branch?: string }): Promise<AgentResult> {
        assert.ok(request.workspacePath && request.branch);
        assert.equal(new JsonFileStore({ dir }).read(runId)?.bootstrap?.baseSha, liveBase);
        assert.equal(fixture.git(request.workspacePath, ['rev-parse', 'HEAD']), liveBase);
        implementationBranch = request.branch;
        const head = fixture.commit(request.workspacePath, 'feature.txt', 'published\n', 'publish implementation');
        fixture.git(request.workspacePath, ['push', '-u', 'origin', request.branch]);
        implementationHead = head;
        return successResult(head);
      },
    };
    const live = new QueueGithub([
      initial,
      initial,
      () => published(),
      () => published(),
      () => published(),
      () => published(),
    ]);
    const run = createRun(TARGET, T0, runId);
    store.create(run);
    const outcome = await runWorkflow({ store, github: live, implementation: realImplementation, bootstrap, reviewer: new ApprovingReviewer() }, runId, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'merge_ready', JSON.stringify(outcome));
    const restarted = new JsonFileStore({ dir }).read(runId)!;
    assert.equal(restarted.state, 'MERGE_READY');
    assert.ok(restarted.bootstrap);
    assert.equal(restarted.headSha, fixture.git(restarted.bootstrap!.workspacePath, ['rev-parse', 'HEAD']));
  });

  for (const missing of [false, true]) it(`E6 adopts a published initial PR after crash with missing workspace=${missing}`, async () => {
    const fixture = createBootstrapGitFixture();
    fixtures.push(fixture);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-'));
    dirs.push(dir);
    const store = new JsonFileStore({ dir });
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const runId = 'e6-crash-adopt';
    const target = { kind: 'issue' as const, owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber };
    const prepared = await bootstrap.plan({ runId, target, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId, target, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: prepared });
    const head = fixture.commit(prepared.workspacePath, 'feature.txt', 'crash-published\n', 'crash before persistence');
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    let crashed = createRun(target, T0, runId);
    crashed = applyTransition(crashed, { type: 'start' }, T0);
    crashed = applyTransition(crashed, { type: 'bootstrap_prepared', bootstrap: prepared }, T0);
    store.create(crashed);
    if (missing) rmSync(prepared.workspacePath, { recursive: true, force: true });
    const live = () => snapshot(head, pr(11, head, { headRef: prepared.branch, baseRef: prepared.baseBranch, baseSha: fixture.baseSha }));
    const implementation = new NoopImplementation();
    const outcome = await runWorkflow({
      store,
      github: new QueueGithub([live, live, live, live, live]),
      implementation,
      bootstrap,
      reviewer: new ApprovingReviewer(),
    }, runId, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'merge_ready', JSON.stringify(outcome));
    assert.equal(implementation.requests.length, 0);
    const restarted = new JsonFileStore({ dir }).read(runId)!;
    assert.equal(restarted.headSha, head);
    assert.deepEqual(restarted.pullRequest, { number: 11, headSha: head });
    assert.equal(restarted.bootstrap?.branch, prepared.branch);
  });

  it('E2 rejects same-SHA tuple drift in VALIDATING, REVIEWING, and direct review-fix admission before side effects', async () => {
    for (const state of ['IMPLEMENTING', 'VALIDATING', 'REVIEWING', 'CHANGES_REQUESTED'] as const) {
      let run = withBootstrap(createRun(TARGET, T0, `tuple-${state}`));
      if (state === 'VALIDATING' || state === 'IMPLEMENTING') run = { ...run, state };
      if (state === 'CHANGES_REQUESTED') run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'reviewer', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0);
      const calls: string[] = [];
      const result = await runWorkflow({
        store: { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined },
        github: new QueueGithub([snapshot(OLD, pr(8, OLD))]),
        implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(NEW); } },
        reviewer: { kind: 'reviewer', review: async () => { calls.push('reviewer'); return { verdict: 'approve', reviewerName: 'reviewer', headSha: OLD, findings: [] }; } },
        bootstrap: { kind: 'implementation-bootstrap', plan: async () => identity, prepare: async () => { calls.push('prepare'); return identity; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: NEW, branch: identity.branch }) },
      }, run.id, { maxReviewAttempts: 1, now: () => T0 });
      assert.equal(result.outcome, 'needs_human', state);
      assert.deepEqual(calls, [], state);
    }
  });

  it('E2 offers exact live-head synchronization for same-tuple G advancement while preserving H', async () => {
    const run = withBootstrap(createRun(TARGET, T0, 'offer-advance'));
    const store = { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined };
    const result = await runWorkflow({
      store,
      github: new QueueGithub([snapshot(NEW, pr(7, NEW))]),
      implementation: new NoopImplementation(),
      reviewer: new ApprovingReviewer(),
    }, run.id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(result.outcome, 'needs_human');
    assert.ok(result.run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION));
    assert.equal(result.run.headSha, OLD);
    assert.equal(result.run.pullRequest?.headSha, OLD);
  });

  it('E6 rejects an unrelated initial crash PR before preparing or spawning', async () => {
    const fixture = createBootstrapGitFixture();
    fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const prepared = await bootstrap.plan({ runId: 'e6-unrelated', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    const run = (() => {
      let value = createRun(TARGET, T0, 'e6-unrelated');
      value = applyTransition(value, { type: 'start' }, T0);
      return applyTransition(value, { type: 'bootstrap_prepared', bootstrap: prepared }, T0);
    })();
    const calls: string[] = [];
    const result = await runWorkflow({
      store: { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined },
      github: new QueueGithub([snapshot(OLD, pr(99, OLD, { headRef: 'foreign-branch' }))]),
      implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(OLD); } },
      reviewer: new ApprovingReviewer(),
      bootstrap: { kind: 'implementation-bootstrap', plan: async () => prepared, prepare: async () => { calls.push('prepare'); return prepared; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: OLD, branch: prepared.branch }) },
    }, run.id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(calls, []);
  });

  it('E6 verifies real review-fix tree progress from H and rejects same-tree commits', async () => {
    const fixture = createBootstrapGitFixture();
    fixtures.push(fixture);
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const prepared = await bootstrap.plan({ runId: 'e6-fix-progress', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId: 'e6-fix-progress', target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: prepared });
    const reviewed = fixture.commit(prepared.workspacePath, 'reviewed.txt', 'reviewed\n');
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    const sameTree = fixture.git(prepared.workspacePath, ['commit-tree', `${reviewed}^{tree}`, '-p', reviewed, '-m', 'same tree']);
    fixture.git(prepared.workspacePath, ['update-ref', `refs/heads/${prepared.branch}`, sameTree]);
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    await assert.rejects(() => bootstrap.verifyDurable({ identity: prepared, expectedHeadSha: sameTree, progressBaseSha: reviewed }), /HEAD_MISMATCH|tree progress/);
    const advanced = fixture.commit(prepared.workspacePath, 'fix.txt', 'fixed\n', 'review fix');
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    assert.deepEqual(await bootstrap.verifyDurable({ identity: prepared, expectedHeadSha: advanced, progressBaseSha: reviewed }), { headSha: advanced, branch: prepared.branch });
  });

  it('E6 carries an accepted sync through real local-behind FF and a new durable review fix', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-')); dirs.push(dir);
    const store = new JsonFileStore({ dir });
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const runId = 'e6-sync-fix';
    const prepared = await bootstrap.plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    await bootstrap.prepare({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: prepared });
    const oldHead = fixture.commit(prepared.workspacePath, 'old.txt', 'old\n', 'old implementation');
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    const newHead = fixture.commit(prepared.workspacePath, 'new.txt', 'new\n', 'published advancement');
    fixture.git(prepared.workspacePath, ['push', '-u', 'origin', prepared.branch]);
    fixture.git(prepared.workspacePath, ['reset', '--hard', oldHead]);
    let run = createRun(TARGET, T0, runId);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: prepared }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: { ...successResult(oldHead, 'prior implementation'), executor: { provider: 'fixture', sessionId: 'executor-1' } }, headSha: oldHead, pullRequest: { number: 21, headSha: oldHead } }, T0);
    run = applyTransition(run, { type: 'validation_passed' }, T0);
    run = applyTransition(run, { type: 'review_approved', reviewResult: { verdict: 'approve', reviewerName: 'old-reviewer', headSha: oldHead, findings: [] } }, T0);
    store.create(run);
    const live = () => {
      const head = fixHead ?? newHead;
      return snapshot(head, pr(21, head, { headRef: prepared.branch, baseRef: prepared.baseBranch, baseSha: fixture.baseSha }));
    };
    let fixHead: string | undefined;
    const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(request: { workspacePath?: string; branch?: string; sessionId?: string }): Promise<AgentResult> {
      assert.ok(request.workspacePath && request.branch);
      assert.equal(fixture.git(request.workspacePath, ['rev-parse', 'HEAD']), newHead, 'preparation must FF the replica before the fix');
      fixHead = fixture.commit(request.workspacePath, 'fix.txt', 'fixed\n', 'review fix');
      fixture.git(request.workspacePath, ['push', '-u', 'origin', request.branch]);
      return { ...successResult(fixHead), sessionId: request.sessionId ?? 'executor-1', executor: { provider: 'fixture', sessionId: 'executor-1' } };
    } };
    let reviews = 0;
    const reviewedHeads: string[] = [];
    const reviewer: ReviewerAdapter = { kind: 'reviewer', async review(request: { headSha: string }): Promise<ReviewResult> {
      reviews += 1;
      reviewedHeads.push(request.headSha);
      return reviews === 1
        ? { verdict: 'request_changes', reviewerName: 'fixture-reviewer', headSha: request.headSha, findings: [{ severity: 'blocking', summary: 'fix' }] }
        : { verdict: 'approve', reviewerName: 'fixture-reviewer', headSha: request.headSha, findings: [] };
    } };
    const github = new QueueGithub(Array.from({ length: 12 }, () => live));
    const beforeRecovery = fixture.commands.length;
    const offered = await runWorkflow({ store, github, implementation, bootstrap, reviewer }, runId, { now: () => T0, maxReviewAttempts: 2 });
    assert.equal(offered.outcome, 'needs_human');
    assert.ok(offered.run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION));
    assert.equal(reviews, 0);
    const outcome = await resumeCommand({ store: new JsonFileStore({ dir }), github, implementation, bootstrap, reviewer }, runId, LIVE_HEAD_SYNC_DECISION, { now: () => T0, maxReviewAttempts: 2 });
    assert.deepEqual(reviewedHeads, [newHead, fixHead]);
    assert.deepEqual(fixture.commands.slice(beforeRecovery).filter((c) => c.args[0] === 'merge').map((c) => c.args), [['merge', '--ff-only', newHead]]);
    assert.equal(outcome.outcome, 'merge_ready', JSON.stringify(outcome));
    const persisted = new JsonFileStore({ dir }).read(runId)!;
    assert.equal(persisted.state, 'MERGE_READY');
    assert.equal(persisted.headSha, fixHead);
    assert.equal(persisted.pullRequest?.number, 21);
    assert.equal(persisted.history.filter((entry) => entry.type === 'review_approved').length, 2);
    assert.equal(persisted.history.some((entry) => entry.type === 'human_resolved' && entry.to === 'VALIDATING'), true);
    assert.equal(persisted.executor?.provider, 'fixture');
  });

  for (const checkpoint of ['identity', 'branch', 'published-checkpoint'] as const) {
    it(`E6 resumes ${checkpoint} with one durable identity, commit and PR`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-workflow-')); dirs.push(dir);
      const runId = `checkpoint-${checkpoint}`;
      const request = { runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const prepared = await bootstrap.plan(request);
      let run = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
      run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: prepared }, T0);
      new JsonFileStore({ dir }).create(run); // I precedes every worktree mutation.
      if (checkpoint !== 'identity') await bootstrap.prepare({ ...request, existing: prepared });
      if (checkpoint === 'published-checkpoint') {
        fixture.commit(prepared.workspacePath, 'feature.txt', 'checkpoint\n');
        fixture.git(prepared.workspacePath, ['push', 'origin', prepared.branch]);
        rmSync(prepared.workspacePath, { recursive: true, force: true });
      }
      let calls = 0;
      let prs = 0;
      let head: string | undefined;
      const live = () => head === undefined
        ? snapshot(fixture.baseSha, null, { headSha: null, repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha } })
        : snapshot(head, pr(31, head, { headRef: prepared.branch }));
      const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(req) {
        calls++;
        assert.equal(req.workspacePath, prepared.workspacePath);
        const prior = fixture.git(prepared.workspacePath, ['rev-parse', 'HEAD']);
        head = prior === fixture.baseSha ? fixture.commit(prepared.workspacePath, 'feature.txt', 'checkpoint\n') : prior;
        fixture.git(prepared.workspacePath, ['push', 'origin', prepared.branch]);
        prs++;
        return successResult(head);
      } };
      const store = new JsonFileStore({ dir });
      const deps = { store, github: new QueueGithub(Array.from({ length: 8 }, () => live)), implementation,
        bootstrap: new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner }), reviewer: new ApprovingReviewer() };
      const result = await runWorkflow(deps, runId, { maxReviewAttempts: 1, now: () => T0 });
      assert.equal(result.outcome, 'merge_ready', JSON.stringify(result));
      assert.equal((await runWorkflow({ ...deps, store: new JsonFileStore({ dir }) }, runId, { maxReviewAttempts: 1 })).outcome, 'merge_ready');
      assert.equal(calls, 1);
      assert.equal(prs, 1);
      assert.equal(fixture.git(prepared.workspacePath, ['rev-list', '--count', `${fixture.baseSha}..HEAD`]), '1');
      assert.deepEqual(new JsonFileStore({ dir }).read(runId)?.bootstrap, prepared);
      assert.equal(new JsonFileStore({ dir }).list().length, 1);
    });
  }
});

for (const route of ['direct', 'resumed'] as const) {
  for (const delta of ['same-head', 'same-tree', 'orphan', 'valid'] as const) {
    it(`E6 ${route} fix at H=B requires durable progress: ${delta}`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-fix-restart-')); dirs.push(dir);
      const id = `fix-${route}-${delta}`;
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
      const request = { runId: id, target: TARGET, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      f.git(i.workspacePath, ['push', 'origin', i.branch]);
      let run = applyTransition(createRun(TARGET, T0, id), { type: 'start' }, T0);
      run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: i }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', headSha: f.baseSha, pullRequest: { number: 7, headSha: f.baseSha }, agentResult: { ...successResult(f.baseSha), executor: { provider: 'fixture', sessionId: 'kept' } } }, T0);
      run = applyTransition(run, { type: 'validation_passed' }, T0);
      run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: f.baseSha, findings: [{ severity: 'blocking', summary: 'required fix' }] } }, T0);
      if (route === 'resumed') run = applyTransition(run, { type: 'start_fix' }, T0);
      new JsonFileStore({ dir }).create(run);
      let head = f.baseSha;
      let calls = 0;
      const live = () => snapshot(head, pr(7, head, { headRef: i.branch, baseRef: i.baseBranch }));
      const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(req) {
        calls++;
        assert.match(req.supplementalInstructions ?? '', /required fix/);
        assert.equal(req.executor?.sessionId, 'kept');
        await req.workspaceGuard?.assertValid();
        if (delta === 'valid') head = f.commit(i.workspacePath, 'fix.txt', 'fixed\n');
        else if (delta !== 'same-head') {
          head = f.git(i.workspacePath, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit-tree', `${f.baseSha}^{tree}`, ...(delta === 'same-tree' ? ['-p', f.baseSha] : []), '-m', delta]);
          f.git(i.workspacePath, ['reset', '--hard', head]);
        }
        if (delta === 'orphan') {
          // Install the adversarial object in the test-owned bare repository.
          f.git(i.workspacePath, ['push', 'origin', `${head}:refs/heads/orphan-fixture`]);
          f.git(f.remote, ['update-ref', `refs/heads/${i.branch}`, head]);
        } else f.git(i.workspacePath, ['push', 'origin', i.branch]);
        return successResult(head);
      } };
      const result = await runWorkflow({ store: new JsonFileStore({ dir }), bootstrap: b, github: new QueueGithub(Array.from({ length: 12 }, () => live)), implementation, reviewer: new ApprovingReviewer() }, id, { maxReviewAttempts: 3, now: () => T0 });
      assert.equal(result.outcome, delta === 'valid' ? 'merge_ready' : 'needs_human', JSON.stringify(result));
      assert.equal(calls, 1);
      const persisted = new JsonFileStore({ dir }).read(id)!;
      assert.equal(persisted.headSha, delta === 'valid' ? head : f.baseSha);
      assert.equal(persisted.pullRequest?.headSha, persisted.headSha);
      assert.deepEqual(persisted.bootstrap, i);
      assert.equal(new JsonFileStore({ dir }).list().length, 1);
    });
  }
}

for (const state of ['IMPLEMENTING', 'CHANGES_REQUESTED'] as const) {
  for (const drift of ['head', 'disappeared', 'post-tuple'] as const) {
    it(`E2 ${state} admission/re-read ${drift} parks before execution`, async () => {
      let run = withBootstrap(createRun(TARGET, T0, `admission-${state}-${drift}`));
      run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0);
      if (state === 'IMPLEMENTING') run = applyTransition(run, { type: 'start_fix' }, T0);
      const calls: string[] = [];
      const live = drift === 'head' ? snapshot(NEW) : drift === 'disappeared' ? snapshot(OLD, null, { headSha: null }) : snapshot(OLD, pr(8, OLD));
      const result = await runWorkflow({
        store: { name: 'test', read: () => run, update: () => undefined, create: () => undefined, list: () => [run], delete: () => undefined },
        github: new QueueGithub(drift === 'post-tuple' ? [snapshot(OLD), live] : [live]),
        implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(NEW); } },
        reviewer: new ApprovingReviewer(),
        bootstrap: { kind: 'implementation-bootstrap', plan: async () => identity, prepare: async () => { calls.push('prepare'); return identity; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => { throw new Error('must not verify'); } },
      }, run.id, { maxReviewAttempts: 3, now: () => T0 });
      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.run.headSha, OLD);
      assert.equal(result.run.pullRequest?.headSha, OLD);
      assert.deepEqual(calls, drift === 'post-tuple' ? ['prepare'] : []);
      assert.equal(result.run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION) ?? false, drift === 'head');
    });
  }
}

for (const route of ['initial', 'direct', 'resumed'] as const) {
  for (const phase of ['pre', 'post'] as const) {
    it(`E4 real provider guard ${route}/${phase} parks and resumes from JSON`, async () => {
      const f = createBootstrapGitFixture(); fixtures.push(f);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-guard-json-')); dirs.push(dir);
      const id = `guard-${route}-${phase}`;
      const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
      const request = { runId: id, target: TARGET, baseBranch: f.branch, baseSha: f.baseSha };
      const i = await b.plan(request); await b.prepare({ ...request, existing: i });
      let head: string | undefined;
      let run = applyTransition(createRun(TARGET, T0, id), { type: 'start' }, T0);
      run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: i }, T0);
      if (route !== 'initial') {
        head = f.commit(i.workspacePath, 'prior.txt', 'prior implementation\n');
        f.git(i.workspacePath, ['push', 'origin', i.branch]);
        run = applyTransition(run, { type: 'agent_succeeded', headSha: head, pullRequest: { number: 7, headSha: head }, agentResult: successResult(head) }, T0);
        run = applyTransition(run, { type: 'validation_passed' }, T0);
        run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: head, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0);
        if (route === 'resumed') run = applyTransition(run, { type: 'start_fix' }, T0);
      }
      const store = new JsonFileStore({ dir }); store.create(run);
      const accepted = head;
      let failing = true;
      let spawns = 0;
      const provider = route === 'resumed' ? 'codex' : 'claude';
      const runner: ProcessRunner = { run: async (file, args, options) => {
        if (file === 'git') return f.runner.run(file, args, options);
        assert.equal(file, provider); spawns++;
        if (failing) writeFileSync(`${i.workspacePath}/dirty.txt`, 'interrupted\n');
        else {
          head = f.commit(i.workspacePath, 'fixed.txt', 'durable fix\n');
          f.git(i.workspacePath, ['push', 'origin', i.branch]);
        }
        return provider === 'claude'
          ? { stdout: JSON.stringify({ type: 'result', result: 'done', is_error: false }), stderr: '', exitCode: 0 }
          : { stdout: [{ type: 'thread.started', thread_id: 'stub-thread' }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, { type: 'turn.completed' }].map((event) => JSON.stringify(event)).join('\n') + '\n', stderr: '', exitCode: 0 };
      } };
      const live = () => head === undefined
        ? snapshot(f.baseSha, null, { headSha: null, repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: f.branch, defaultBranchHeadSha: f.baseSha } })
        : snapshot(head, pr(7, head, { headRef: i.branch, baseRef: i.baseBranch }));
      const deps = { store, bootstrap: b, github: new QueueGithub(Array.from({ length: 20 }, () => live)),
        implementation: provider === 'claude' ? new ClaudeCodeAdapter({ runner }) : new CodexCliAdapter({ runner }),
        reviewer: new ApprovingReviewer(), resolveImplementationCapabilities: async () => {
          if (failing && phase === 'pre') writeFileSync(`${i.workspacePath}/dirty.txt`, 'capability-time race\n');
          return [];
        } };
      const parked = await runWorkflow(deps, id, { maxReviewAttempts: 3, now: () => T0 });
      assert.equal(parked.outcome, 'needs_human', JSON.stringify(parked));
      assert.equal(spawns, phase === 'pre' ? 0 : 1);
      const fresh = new JsonFileStore({ dir });
      assert.equal(fresh.read(id)?.headSha, accepted);
      assert.deepEqual(fresh.read(id)?.bootstrap, i);
      assert.equal(fresh.list().length, 1);
      rmSync(`${i.workspacePath}/dirty.txt`); failing = false;
      const choice = parked.run.interrupt?.choices?.[0]; assert.ok(choice);
      const result = await resumeCommand({ ...deps, store: fresh }, id, choice, { maxReviewAttempts: 3, now: () => T0 });
      assert.equal(result.outcome, 'merge_ready', JSON.stringify(result));
      assert.equal(new JsonFileStore({ dir }).read(id)?.pullRequest?.headSha, head);
    });
  }
}

for (const resultKind of ['no-delta', 'orphan'] as const) {
  it(`E1 initial crash adoption rejects ${resultKind} without writing H or PR`, async () => {
    const f = createBootstrapGitFixture(); fixtures.push(f);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-adoption-negative-')); dirs.push(dir);
    const runId = `adopt-${resultKind}`;
    const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
    const request = { runId, target: TARGET, baseBranch: f.branch, baseSha: f.baseSha };
    const i = await b.plan(request); await b.prepare({ ...request, existing: i });
    const head = resultKind === 'no-delta' ? f.baseSha : f.git(i.workspacePath, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit-tree', `${f.baseSha}^{tree}`, '-m', 'orphan']);
    f.git(i.workspacePath, ['reset', '--hard', head]);
    f.git(i.workspacePath, ['push', 'origin', i.branch]);
    const run = applyTransition(applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0), { type: 'bootstrap_prepared', bootstrap: i }, T0);
    const store = new JsonFileStore({ dir }); store.create(run);
    const implementation = new NoopImplementation();
    const live = () => snapshot(head, pr(7, head, { headRef: i.branch }));
    const result = await runWorkflow({ store, bootstrap: b, github: new QueueGithub([live, live]), implementation, reviewer: new ApprovingReviewer() }, runId, { now: () => T0, maxReviewAttempts: 2 });
    assert.equal(result.outcome, 'needs_human');
    assert.equal(implementation.requests.length, 0);
    const persisted = new JsonFileStore({ dir }).read(runId)!;
    assert.equal(persisted.headSha, undefined);
    assert.equal(persisted.pullRequest, undefined);
    assert.deepEqual(persisted.bootstrap, i);
  });
}

it('E1 rejects unproved HEAD-writing payloads and keeps JSON invariant on other transitions', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-ledger-invariance-')); dirs.push(dir);
  let r = withBootstrap(createRun(TARGET, T0, 'ledger-invariance'));
  const store = new JsonFileStore({ dir }); store.create(r);
  for (const input of [
    { type: 'escalate' as const, reason: 'park', headSha: NEW },
    { type: 'validation_passed' as const, headSha: NEW },
    { type: 'start_fix' as const, pullRequest: { number: 8, headSha: OLD } },
  ]) assert.throws(() => applyTransition(r, input, T0));
  r = applyTransition(r, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0);
  r = applyTransition(r, { type: 'start_fix' }, T0); store.update(r);
  assert.throws(() => applyTransition(r, { type: 'agent_succeeded', agentResult: successResult(NEW), headSha: NEW }, T0), /verified pull request identity/);
  assert.throws(() => applyTransition(r, { type: 'agent_succeeded', agentResult: successResult(NEW), headSha: NEW, pullRequest: { number: 8, headSha: NEW } }, T0), /Pull request identity/);
  const persisted = new JsonFileStore({ dir }).read(r.id)!;
  assert.equal(persisted.headSha, OLD); assert.deepEqual(persisted.pullRequest, { number: 7, headSha: OLD }); assert.deepEqual(persisted.bootstrap, identity);
});

it('E2 sync admission rejects same-SHA ownership drift without updating the ledger', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-sync-admission-')); dirs.push(dir);
  const store = new JsonFileStore({ dir }); store.create(parkedForSync());
  await assert.rejects(() => resumeCommand({ store, github: new QueueGithub([snapshot(NEW, pr(8, NEW))]), implementation: new NoopImplementation(), reviewer: new ApprovingReviewer() }, 'run-1', LIVE_HEAD_SYNC_DECISION, { now: () => T0, maxReviewAttempts: 2 }), /Cannot synchronize/);
  const persisted = new JsonFileStore({ dir }).read('run-1')!;
  assert.equal(persisted.state, 'NEEDS_HUMAN'); assert.equal(persisted.headSha, OLD); assert.equal(persisted.pullRequest?.headSha, OLD);
});

for (const drift of ['head', 'number'] as const) {
  it(`E2 initial crash candidate ${drift} drift after preparation preserves absent H/PR`, async () => {
    const f = createBootstrapGitFixture(); fixtures.push(f);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-candidate-drift-')); dirs.push(dir);
    const runId = `candidate-${drift}`;
    const b = new GitWorktreeBootstrap({ repositoryRoot: f.source, workspaceRoot: f.workspaceRoot, runner: f.runner });
    const request = { runId, target: TARGET, baseBranch: f.branch, baseSha: f.baseSha };
    const i = await b.plan(request); await b.prepare({ ...request, existing: i });
    const original = f.commit(i.workspacePath, 'initial.txt', 'initial durable result\n');
    f.git(i.workspacePath, ['push', 'origin', i.branch]);
    const run = applyTransition(applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0), { type: 'bootstrap_prepared', bootstrap: i }, T0);
    const store = new JsonFileStore({ dir }); store.create(run);
    let head = original;
    let number = 11;
    let reads = 0;
    let implementations = 0;
    let reviews = 0;
    const live = () => {
      if (++reads === 2) {
        if (drift === 'head') {
          head = f.commit(i.workspacePath, 'advanced.txt', 'external advancement\n');
          f.git(i.workspacePath, ['push', 'origin', i.branch]);
        } else number = 12;
      }
      return snapshot(head, pr(number, head, { headRef: i.branch, baseRef: i.baseBranch }));
    };
    const before = f.commands.length;
    const result = await runWorkflow({ store, bootstrap: b, github: new QueueGithub(Array.from({ length: 8 }, () => live)),
      implementation: { kind: 'implementation-agent', run: async () => { implementations++; return successResult(head); } },
      reviewer: { kind: 'reviewer', review: async (req) => { reviews++; return { verdict: 'approve', reviewerName: 'fixture', headSha: req.headSha, findings: [] }; } },
    }, runId, { maxReviewAttempts: 2, now: () => T0 });
    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.equal(implementations, 0); assert.equal(reviews, 0);
    const fresh = new JsonFileStore({ dir });
    assert.equal(fresh.read(runId)?.headSha, undefined);
    assert.equal(fresh.read(runId)?.pullRequest, undefined);
    assert.equal(fresh.list().length, 1);
    assert.deepEqual(fresh.read(runId)?.bootstrap, i);
    assert.equal(f.git(i.workspacePath, ['rev-parse', 'HEAD']), head);
    assert.match(f.git(f.source, ['ls-remote', 'origin', `refs/heads/${i.branch}`]), new RegExp(`^${head}`));
    assert.equal(f.commands.slice(before).some((c) => ['reset', 'push', 'update-ref', 'merge'].includes(c.args[0]!)), false);
  });
}
