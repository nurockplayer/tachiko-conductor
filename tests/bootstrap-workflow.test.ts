import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import { ExecutionAdmissionRefusal, isExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import type { ProcessRunner } from '../src/github/transport.js';
import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import type { ValidationAdapter, ValidationRequest } from '../src/adapters/validation.js';
import { ConfiguredLocalValidationAdapter } from '../src/validation/local-command.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { LIVE_HEAD_SYNC_DECISION } from '../src/domain/decisions.js';
import type { AgentResult, ImplementationBootstrapIdentity, LocalValidationEvidence, ReviewResult, Run } from '../src/domain/types.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { operationalProjectionPath } from '../src/operational/projection.js';
import { resumeCommand } from '../src/cli.js';
import { runWorkflow } from '../src/workflow/run.js';
import type { ImplementationBootstrapAdapter } from '../src/adapters/bootstrap.js';
import { TARGET, T0, TEST_VALIDATION_AUTHORITY, successResult, validationPassed } from './helpers.js';
import { createBootstrapGitFixture, type BootstrapGitFixture } from './bootstrap-fixture.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { canonicalizeMissionEvidence, MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { createGenuineLunaFixture } from './support/genuine-luna.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const TEST_HOSTED_POLICY = { revision: 'test-hosted-policy-v1', policy: { mode: 'required' as const } };
const dirs: string[] = [];
const fixtures: BootstrapGitFixture[] = [];

const identity: ImplementationBootstrapIdentity = {
  bootstrapKind: 'linked-worktree',
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
    checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
    conversations: [],
    handoff: { sourceId: 'IC_test-accepted-scope', sourceScope: 'issue', sourceUpdatedAt: T0,
      sections: { 'Accepted #48-A scope': 'Test accepted implementation scope.' }, freshness: 'current' },
    problems: [],
    observedAt: T0,
    ...extra,
  };
}

function memoryStore(initial: Run) {
  let current: Run | null = initial;
  return {
    name: 'test',
    read: (id: string) => current?.id === id ? current : null,
    update: (next: Run) => { current = next; },
    updateIfUnchanged: (expected: Run, next: Run) => {
      if (current === null || current.id !== expected.id || JSON.stringify(current) !== JSON.stringify(expected)) return false;
      current = next;
      return true;
    },
    create: (next: Run) => { current = next; },
    list: () => current === null ? [] : [current],
    delete: (id: string) => { if (current?.id === id) current = null; },
  };
}

class QueueGithub implements GitHubAdapter {
  readonly kind = 'github' as const;
  private latest: GitHubLiveSnapshot | undefined;
  constructor(private readonly queue: Array<GitHubLiveSnapshot | (() => GitHubLiveSnapshot)>) {}
  async readIssue(): Promise<never> { throw new Error('unused'); }
  async readBranch(): Promise<never> { throw new Error('unused'); }
  async listPullRequests(): Promise<never> { throw new Error('unused'); }
  async readLiveSnapshot() {
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.latest === undefined) throw new Error('No live snapshot queued');
      return this.latest;
    }
    this.latest = typeof next === 'function' ? next() : next;
    return this.latest;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function gatedBootstrapRunner(
  base: ProcessRunner,
  matches: (args: readonly string[]) => boolean,
  beforeSpawn?: () => void,
  afterRefusal?: (error: unknown) => void,
) {
  const entered = deferred<void>();
  const release = deferred<void>();
  let blocked = false;
  const runner: ProcessRunner = {
    async run(file, args, options) {
      let reachedTarget = false;
      if (!blocked && file === 'git' && matches(args)) {
        blocked = true;
        reachedTarget = true;
        entered.resolve();
        await release.promise;
      }
      if (reachedTarget) beforeSpawn?.();
      try {
        options.beforeSpawn?.();
      } catch (error) {
        afterRefusal?.(error);
        throw error;
      }
      return base.run(file, args, { ...options, beforeSpawn: undefined });
    },
  };
  return { runner, entered: entered.promise, release: () => release.resolve(), blocked: () => blocked };
}

class ApprovingReviewer implements ReviewerAdapter {
  readonly kind = 'reviewer' as const;
  async review(request: { headSha: string }): Promise<ReviewResult> {
    return { verdict: 'approve', reviewerName: 'test-reviewer', headSha: request.headSha, findings: [] };
  }
}

class PassingValidation implements ValidationAdapter {
  readonly kind = 'validation' as const;
  readonly configRevision = 'test-config-v1';
  readonly requests: ValidationRequest[] = [];
  async validate(request: ValidationRequest): Promise<LocalValidationEvidence> {
    this.requests.push(request);
    return validationPassed(request.headSha).local;
  }
}

function withBootstrap(run: Run, headSha = OLD, pullRequestHeadSha = OLD): Run {
  let current = applyTransition(run, { type: 'start' }, T0);
  current = applyTransition(current, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
  current = applyTransition(current, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha, pullRequest: { number: 7, headSha: pullRequestHeadSha } }, T0);
  current = applyTransition(current, { type: 'validation_passed', validationResult: validationPassed(headSha) }, T0);
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
      github: new QueueGithub([snapshot(NEW), snapshot(NEW), snapshot(NEW), snapshot(NEW), snapshot(NEW)]),
      implementation: new NoopImplementation(),
      reviewer: new ApprovingReviewer(),
      validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
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
    const store = memoryStore(run);
    const implementation = new NoopImplementation();
    const result = await runWorkflow({
      store,
      github: new QueueGithub([snapshot(OLD, pr(8, OLD)), snapshot(OLD, pr(8, OLD)), snapshot(OLD, pr(8, OLD))]),
      implementation,
      reviewer: new ApprovingReviewer(),
      bootstrap: { kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree', plan: async () => identity, prepare: async () => identity, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: OLD, branch: identity.branch }) },
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
      run = applyTransition(run, { type: 'review_approved', reviewResult: { verdict: 'approve', reviewerName: 'reviewer', headSha: OLD, findings: [] } }, T0, TEST_VALIDATION_AUTHORITY);
      const result = await runWorkflow({
        store: memoryStore(run),
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
      () => published(),
    ]);
    const run = createRun(TARGET, T0, runId);
    store.create(run);
    const outcome = await runWorkflow({ store, github: live, implementation: realImplementation, bootstrap, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, { maxReviewAttempts: 1, now: () => T0 });
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
      github: new QueueGithub([live, live, live, live, live, live]),
      implementation,
      bootstrap,
      reviewer: new ApprovingReviewer(),
      validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
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
      if (state === 'CHANGES_REQUESTED') run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'reviewer', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0, TEST_VALIDATION_AUTHORITY);
      const calls: string[] = [];
      const result = await runWorkflow({
        store: memoryStore(run),
        github: new QueueGithub([snapshot(OLD, pr(8, OLD))]),
        implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(NEW); } },
        reviewer: { kind: 'reviewer', review: async () => { calls.push('reviewer'); return { verdict: 'approve', reviewerName: 'reviewer', headSha: OLD, findings: [] }; } },
        validation: new PassingValidation(),
        hostedCheckPolicy: TEST_HOSTED_POLICY,
        bootstrap: { kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree', plan: async () => identity, prepare: async () => { calls.push('prepare'); return identity; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: NEW, branch: identity.branch }) },
      }, run.id, { maxReviewAttempts: 1, now: () => T0 });
      assert.equal(result.outcome, 'needs_human', state);
      assert.deepEqual(calls, [], state);
    }
  });

  it('E2 offers exact live-head synchronization for same-tuple G advancement while preserving H', async () => {
    const run = withBootstrap(createRun(TARGET, T0, 'offer-advance'));
    const store = memoryStore(run);
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
      store: memoryStore(run),
      github: new QueueGithub([snapshot(OLD, pr(99, OLD, { headRef: 'foreign-branch' }))]),
      implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(OLD); } },
      reviewer: new ApprovingReviewer(),
      bootstrap: { kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree', plan: async () => prepared, prepare: async () => { calls.push('prepare'); return prepared; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => ({ headSha: OLD, branch: prepared.branch }) },
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
    run = applyTransition(run, {
      type: 'validation_passed',
      validationResult: {
        ...validationPassed(oldHead),
        hosted: { ...validationPassed(oldHead).hosted, pullRequestNumber: 21 },
      },
    }, T0);
    run = applyTransition(run, { type: 'review_approved', reviewResult: { verdict: 'approve', reviewerName: 'old-reviewer', headSha: oldHead, findings: [] } }, T0, TEST_VALIDATION_AUTHORITY);
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
    const validation = new ConfiguredLocalValidationAdapter({
      revision: 'fixture-owned-worktree-v1',
      commands: [{ argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 5_000 }],
    });
    const beforeRecovery = fixture.commands.length;
    const offered = await runWorkflow({ store, github, implementation, bootstrap, reviewer, validation, hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, { now: () => T0, maxReviewAttempts: 2 });
    assert.equal(offered.outcome, 'needs_human');
    assert.ok(offered.run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION));
    assert.equal(reviews, 0);
    const outcome = await resumeCommand({ store: new JsonFileStore({ dir }), github, implementation, bootstrap, reviewer, validation, hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, LIVE_HEAD_SYNC_DECISION, { now: () => T0, maxReviewAttempts: 2 });
    assert.equal(outcome.outcome, 'merge_ready', JSON.stringify(outcome));
    assert.deepEqual(reviewedHeads, [newHead, fixHead]);
    assert.deepEqual(fixture.commands.slice(beforeRecovery).filter((c) => c.args[0] === 'merge').map((c) => c.args), [['merge', '--ff-only', newHead]]);
    const persisted = new JsonFileStore({ dir }).read(runId)!;
    assert.equal(persisted.state, 'MERGE_READY');
    assert.equal(persisted.headSha, fixHead);
    assert.equal(persisted.pullRequest?.number, 21);
    assert.equal(persisted.history.filter((entry) => entry.type === 'review_approved').length, 2);
    assert.equal(persisted.history.some((entry) => entry.type === 'human_resolved' && entry.to === 'VALIDATING'), true);
    assert.equal(persisted.executor?.provider, 'fixture');
    assert.equal(persisted.validationResult?.local.configRevision, 'fixture-owned-worktree-v1');
    assert.equal(persisted.validationResult?.local.commands[0]?.outcome, 'passed');
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
        bootstrap: new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner }), reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY };
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

describe('bootstrap actual-spawn admission fences', () => {
  for (const mode of ['missing-cas', 'throwing-cas', 'known-park', 'secondary-read-failure', 'secondary-transition-failure', 'secondary-write-failure', 'parking-cas-loss'] as const) {
    it(`reconciles a durable verification refusal after completion telemetry: ${mode}`, async (t) => {
      const fixture = await createGenuineLunaFixture(`verify-refusal-${mode}`, { deferPrepare: true });
      t.after(() => fixture.cleanup());
      const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-verify-refusal-${mode}-`)); dirs.push(directory);
      const runId = `verify-refusal-${mode}`;
      const store = new JsonFileStore({ dir: directory });
      store.create(createRun(TARGET, T0, runId, fixture.request.execution));
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: `verify-refusal-${mode}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
        repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId, workspace: fixture.identity.workspacePath,
      } });
      assert.equal(admission.outcome, 'admitted');
      if (admission.outcome !== 'admitted') return;
      const originalCas = store.updateIfUnchanged.bind(store);
      const originalRead = store.read.bind(store);
      let casBehavior: 'available' | 'missing' | 'throwing' = 'available';
      let casCalls = 0;
      let returnFalseAt: number | undefined;
      let failRead = false;
      let failTransition = false;
      let newerWinner: Run | undefined;
      let newerRunBytes: string | undefined;
      let newerProjectionBytes: string | undefined;
      let completedRun: Run | undefined;
      let completedRunBytes: string | undefined;
      let completedProjectionBytes: string | undefined;
      let verifying = false;
      let preparationSucceeded = false;
      let preparedIdentity: ImplementationBootstrapIdentity | undefined;
      const secondary = new Error('durable refusal parking write failed');
      Object.defineProperty(store, 'updateIfUnchanged', { configurable: true, get: () => {
        if (casBehavior === 'missing') return undefined;
        return (expected: Run, next: Run) => {
          if (casBehavior === 'throwing') throw new Error('durable verification strict CAS failed');
          casCalls += 1;
          if (mode === 'secondary-write-failure' && verifying && next.state === 'NEEDS_HUMAN') throw secondary;
          if (mode === 'parking-cas-loss' && verifying && next.state === 'NEEDS_HUMAN') {
            newerWinner = { ...expected, updatedAt: '2026-09-29T00:00:03.000Z' };
            store.update(newerWinner);
            newerRunBytes = readFileSync(path.join(directory, `${runId}.json`), 'utf8');
            newerProjectionBytes = readFileSync(operationalProjectionPath(directory, runId), 'utf8');
          }
          if (casCalls === returnFalseAt) return false;
          return originalCas(expected, next);
        };
      } });
      Object.defineProperty(store, 'read', { configurable: true, get: () => (id: string) => {
        if (failRead) throw new Error('durable refusal reconciliation read failed');
        return originalRead(id);
      } });
      let primary: unknown;
      const bootstrap: ImplementationBootstrapAdapter = {
        kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
        async plan(request) { return fixture.bootstrap.plan(request); },
        async prepare(request) {
          const prepared = await fixture.bootstrap.prepare(request);
          assert.equal(existsSync(prepared.workspacePath), true, 'the delegated workflow preparation created the planned workspace');
          preparedIdentity = prepared;
          preparationSucceeded = true;
          return prepared;
        },
        guard(prepared) { return fixture.bootstrap.guard(prepared); },
        async verifyDurable(request) {
          verifying = true;
          completedRun = originalRead(runId)!;
          assert.ok(completedRun.telemetry?.events.some((event) => event.kind === 'completion'), 'durable verification starts after completion telemetry is persisted');
          completedRunBytes = readFileSync(path.join(directory, `${runId}.json`), 'utf8');
          completedProjectionBytes = readFileSync(operationalProjectionPath(directory, runId), 'utf8');
          assert.equal(completedRun.execution?.executor, 'luna-isolated');
          assert.equal(completedRun.telemetry?.events.some((event) => event.kind === 'completion'), true);
          assert.equal(preparationSucceeded, true, 'real workflow preparation completed before durable verification');
          assert.ok(preparedIdentity);
          assert.deepEqual(request.identity, preparedIdentity, 'durable verification receives the identity returned by delegated preparation');
          if (mode === 'missing-cas') casBehavior = 'missing';
          if (mode === 'throwing-cas') casBehavior = 'throwing';
          const wrapped = { ...request, beforeMutation: () => {
            try {
              if (mode === 'known-park' || mode.startsWith('secondary-') || mode === 'parking-cas-loss') {
                registry.release(admission.token, true);
                casCalls = 0;
                if (mode === 'secondary-read-failure') returnFalseAt = 3;
              }
              request.beforeMutation?.();
            } catch (error) {
              primary = error;
              if (mode === 'secondary-read-failure') failRead = true;
              if (mode === 'secondary-transition-failure') failTransition = true;
              throw error;
            }
          } };
          return fixture.bootstrap.verifyDurable(wrapped);
        },
      };
      const headFile = path.join(fixture.root, 'worker-head');
      const workerScript = path.join(fixture.root, 'bin', 'codex');
      writeFileSync(workerScript, [
        '#!/bin/sh', 'set -e', "printf 'durable result\\n' > durable.txt", 'git add durable.txt >/dev/null 2>&1',
        'git commit -m "durable fixture result" >/dev/null 2>&1', `git rev-parse HEAD > '${headFile}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'verify-refusal-thread' })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'turn.started' })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { id: 'verify-refusal-message', type: 'agent_message', text: 'durable result' } })}'`,
        `printf '%s\\n' '${JSON.stringify({ type: 'turn.completed' })}'`, '',
      ].join('\n'));
      chmodSync(workerScript, 0o700);
      let head: string | undefined;
      const github = new QueueGithub(Array.from({ length: 12 }, () => () => {
        if (!existsSync(headFile)) return snapshot(fixture.identity.baseSha, null, { headSha: null, repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.identity.baseBranch, defaultBranchHeadSha: fixture.identity.baseSha } });
        head = readFileSync(headFile, 'utf8').trim();
        return snapshot(head, pr(74, head, { headRef: fixture.identity.branch, baseRef: fixture.identity.baseBranch, baseSha: fixture.identity.baseSha }));
      }));
      assert.equal(existsSync(fixture.identity.workspacePath), false, 'the genuine planned workspace is absent before workflow entry');
      const pending = runWorkflow({ store, github, bootstrap, implementation: fixture.adapter, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, {
        maxReviewAttempts: 1, now: () => { if (failTransition) throw new Error('durable refusal transition construction failed'); return T0; }, admissionFence: { registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: fixture.identity.workspacePath },
      });
      if (mode === 'missing-cas' || mode === 'throwing-cas' || mode === 'secondary-read-failure' || mode === 'secondary-transition-failure' || mode === 'secondary-write-failure') {
        await assert.rejects(pending, (error: unknown) => {
          assert.strictEqual(error, primary, 'the original durable-verification refusal remains primary');
          assert.equal(isExecutionAdmissionRefusal(error), true);
          if (mode === 'missing-cas' || mode === 'throwing-cas') {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
            assert.match(String((error as Error).cause), /Strict Run compare-and-swap|durable verification strict CAS/);
          }
          else {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, false);
            assert.notStrictEqual((error as Error).cause, secondary);
          }
          return true;
        });
      } else {
        const result = await pending;
        if (mode === 'parking-cas-loss') {
          assert.equal(result.outcome, 'needs_human');
          assert.ok(newerWinner);
          assert.ok(verifying && completedRun !== undefined && completedRunBytes !== undefined && completedProjectionBytes !== undefined,
            'the parking CAS race follows completed durable verification');
          assert.deepEqual(new JsonFileStore({ dir: directory }).read(runId), JSON.parse(JSON.stringify(newerWinner)), 'a lost exact parking CAS preserves the persisted concurrent winner');
          assert.equal(readFileSync(path.join(directory, `${runId}.json`), 'utf8'), newerRunBytes, 'the final parking-write race preserves exact winner Run bytes');
          assert.equal(readFileSync(operationalProjectionPath(directory, runId), 'utf8'), newerProjectionBytes, 'the final parking-write race preserves exact winner projection bytes');
          return;
        }
        assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
        assert.equal(result.run.state, 'NEEDS_HUMAN');
        assert.equal(store.read(runId)?.state, 'NEEDS_HUMAN');
        assert.deepEqual(JSON.parse(JSON.stringify(result.run.history.slice(0, completedRun?.history.length))), completedRun?.history, 'strict conditional parking retains the completed history prefix');
        assert.deepEqual(result.run.executor === undefined ? undefined : JSON.parse(JSON.stringify(result.run.executor)), completedRun?.executor, 'parking retains the captured executor identity');
        assert.deepEqual(result.run.agentResult === undefined ? undefined : JSON.parse(JSON.stringify(result.run.agentResult)), completedRun?.agentResult, 'parking retains the captured provider result');
        assert.deepEqual(result.run.telemetry, completedRun?.telemetry, 'parking retains all completed telemetry without resetting execution markers');
      }
      assert.ok(verifying && completedRun !== undefined && completedRunBytes !== undefined && completedProjectionBytes !== undefined,
        'the refusal was armed only inside completed durable verification');
      const persisted = new JsonFileStore({ dir: directory }).read(runId)!;
      if (mode === 'known-park') {
        assert.deepEqual(persisted.history.slice(0, completedRun!.history.length), completedRun!.history,
          'a successful conditional park retains the completed history prefix');
      } else {
        assert.deepEqual(persisted.history, completedRun?.history, 'a failed secondary reconciliation preserves the exact completed history');
      }
      assert.deepEqual(persisted.telemetry, completedRun?.telemetry, 'a failed secondary reconciliation preserves the exact completion and execution evidence');
      if (mode !== 'known-park') {
        assert.equal(persisted.state, 'IMPLEMENTING', 'failed reconciliation leaves the completed primary Run untouched');
        assert.equal(readFileSync(path.join(directory, `${runId}.json`), 'utf8'), completedRunBytes, 'failed reconciliation does not rewrite completed Run bytes');
        assert.equal(readFileSync(operationalProjectionPath(directory, runId), 'utf8'), completedProjectionBytes, 'failed reconciliation does not rewrite completed projection bytes');
        assert.deepEqual(persisted.executor, completedRun?.executor, 'failed reconciliation preserves captured executor identity');
        assert.deepEqual(persisted.agentResult, completedRun?.agentResult, 'failed reconciliation preserves captured provider result');
      }
    });
  }

  it('refuses initial durable publication at the actual first import spawn and preserves the concurrent JSON Run', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-durable-first-import-cas-')); dirs.push(directory);
    const runId = 'durable-first-import-cas';
    const store = new JsonFileStore({ dir: directory });
    store.create(createRun(TARGET, T0, runId));
    const entered = deferred<void>();
    const release = deferred<void>();
    let verificationPhase = false;
    let importRunnerEntered = false;
    let importEffects = 0;
    let pushEffects = 0;
    let newerRun: Run | undefined;
    const runner: ProcessRunner = {
      async run(file, args, options) {
        const trustedSource = file === 'git' && options.cwd === realpathSync(fixture.source);
        const importsWorkerHead = trustedSource && args.includes('fetch') && args.includes('--no-recurse-submodules');
        const pushes = trustedSource && args.includes('push');
        if (verificationPhase && importsWorkerHead && !importRunnerEntered) {
          importRunnerEntered = true;
          assert.ok(new JsonFileStore({ dir: directory }).read(runId)?.telemetry?.events.some((event) => event.kind === 'completion'),
            'the actual initial verification fence follows durable completion telemetry');
          entered.resolve();
          await release.promise;
        }
        options.beforeSpawn?.();
        const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
        if (verificationPhase && importsWorkerHead) importEffects += 1;
        if (verificationPhase && pushes) pushEffects += 1;
        return result;
      },
    };
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
    let head: string | undefined;
    const github = new QueueGithub(Array.from({ length: 12 }, () => () => head === undefined
      ? snapshot(fixture.baseSha, null, { headSha: null, repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha } })
      : snapshot(head, pr(74, head, { headRef: `tachiko/${runId}` }))));
    const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(request) {
      head = fixture.commit(request.workspacePath!, 'durable.txt', 'real durable result\n');
      verificationPhase = true;
      return successResult(head);
    } };
    const pending = runWorkflow({ store, github, bootstrap, implementation, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, { maxReviewAttempts: 1, now: () => T0 });
    const settlement = pending.then((outcome) => ({ kind: 'settled' as const, outcome }), (error: unknown) => ({ kind: 'rejected' as const, error }));
    const gate = await Promise.race([entered.promise.then(() => ({ kind: 'entered' as const })), settlement]);
    assert.equal(gate.kind, 'entered', gate.kind === 'settled' ? `workflow settled before first import gate: ${JSON.stringify(gate.outcome)}` : gate.kind === 'rejected' ? `workflow rejected before first import gate: ${String(gate.error)}` : undefined);
    try {
    const captured = new JsonFileStore({ dir: directory }).read(runId)!;
    newerRun = { ...captured, updatedAt: '2026-09-29T00:00:01.000Z' };
    store.update(newerRun);
    const exactNewer = new JsonFileStore({ dir: directory }).read(runId)!;
    const exactNewerRunBytes = readFileSync(path.join(directory, `${runId}.json`), 'utf8');
    const exactNewerProjection = readFileSync(operationalProjectionPath(directory, runId), 'utf8');
    release.resolve();
    const outcome = await settlement.then((result) => { if (result.kind === 'rejected') throw result.error; return result.outcome; });
    assert.equal(outcome.outcome, 'needs_human', JSON.stringify(outcome));
    assert.ok(importRunnerEntered, 'the actual trusted Git runner reached its asynchronous preparation boundary');
    assert.equal(importEffects, 0, 'the first trusted-source worker import never crossed beforeSpawn');
    assert.equal(pushEffects, 0, 'no push follows the refused first import');
    assert.deepEqual(new JsonFileStore({ dir: directory }).read(runId), exactNewer, 'a fresh JsonFileStore preserves the exact concurrent Run');
    assert.equal(readFileSync(path.join(directory, `${runId}.json`), 'utf8'), exactNewerRunBytes, 'the exact concurrent Run bytes are preserved');
    assert.equal(readFileSync(operationalProjectionPath(directory, runId), 'utf8'), exactNewerProjection, 'the concurrent Run projection bytes are preserved');
    } finally {
      release.resolve();
      await settlement;
    }
  });

  it('establishes explicit initial workspace authority before the real immutable-base preparation fetch', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-plan-admission-')); dirs.push(directory);
    const runId = 'initial-plan-admission-establishment';
    const workspace = path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`);
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-plan-admission-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const initialRun = createRun(TARGET, T0, runId);
    const store = memoryStore(initialRun);
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const implementation = new NoopImplementation();
    const before = fixture.commands.length;
    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 12 }, () => live)), bootstrap, implementation,
      reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: workspace,
    } });
    assert.notEqual(result.outcome, 'failed', JSON.stringify(result));
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), true,
      'the read-only plan is followed by a real trusted-base fetch after host admission establishment');
    assert.equal(registry.snapshot().lanes.find((lane) => lane.laneId === runId)?.evidence.workspace, realpathSync.native(workspace),
      'the initially workspace-less lane is strengthened with the explicit host workspace before planning');
  });

  it('binds the exact initial Run while preserving an already-admitted workspace before the real preparation fetch', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-plan-existing-workspace-')); dirs.push(directory);
    const runId = 'initial-plan-existing-workspace';
    const workspace = path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`);
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-plan-existing-workspace-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, workspace,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const initialRun = createRun(TARGET, T0, runId);
    const store = memoryStore(initialRun);
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const before = fixture.commands.length;
    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 12 }, () => live)), bootstrap, implementation: new NoopImplementation(),
      reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId,
    } });
    assert.notEqual(result.outcome, 'failed', JSON.stringify(result));
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), true,
      'the existing workspace evidence authorizes the real preparation fetch only after expected-Run strengthening');
    assert.equal(registry.snapshot().lanes.find((lane) => lane.laneId === runId)?.evidence.workspace,
      realpathSync.native(workspace), 'expected repository/issue/Run evidence is added without replacing the existing workspace');
    const lane = registry.snapshot().lanes.find((candidate) => candidate.laneId === runId);
    assert.equal(lane?.evidence.issue, TARGET.issueNumber);
    assert.equal(lane?.evidence.run, runId);
  });

  it('refuses existing-identity preparation when persisted workspace conflicts with the explicit host workspace', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-existing-identity-workspace-conflict-')); dirs.push(directory);
    const runId = 'existing-identity-workspace-conflict';
    const request = { runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
    const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const persistedIdentity = await bootstrap.plan(request);
    let run = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: persistedIdentity }, T0);
    const store = memoryStore(run);
    const explicitWorkspace = path.join(directory, 'host-selected-workspace');
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'existing-identity-workspace-conflict-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId, workspace: explicitWorkspace,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const originalEvidence = registry.readLane(runId)?.evidence;
    const before = fixture.commands.length;
    const implementation = new NoopImplementation();
    const validation = new PassingValidation();
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });

    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 8 }, () => live)), bootstrap, implementation,
      reviewer: new ApprovingReviewer(), validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: explicitWorkspace,
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' &&
      (args.includes('fetch') || args.includes('init') || args.includes('worktree'))), false,
    'the persisted identity is checked against explicit host workspace before any prepare effect');
    assert.equal(implementation.requests.length, 0);
    assert.equal(validation.requests.length, 0);
    assert.deepEqual(store.read(runId)?.bootstrap, persistedIdentity);
    assert.deepEqual(registry.readLane(runId)?.evidence, originalEvidence,
      'a conflicting persisted identity cannot replace or rewrite the already-bound host workspace');
  });

  it('preserves explicit host workspace through the workflow-owned repair callback before preparation', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workflow-repair-workspace-conflict-')); dirs.push(directory);
    const runId = 'workflow-repair-workspace-conflict';
    const execution = { profile: 'routine' as const, revision: 'luna-v1', executor: 'luna-isolated' as const, timeoutMs: 60_000 };
    let run = createRun(TARGET, T0, runId, execution);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, {
      type: 'agent_succeeded', agentResult: successResult(fixture.baseSha), headSha: fixture.baseSha,
      pullRequest: { number: 7, headSha: fixture.baseSha },
    }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(fixture.baseSha) }, T0);
    const repairAuthority = { revision: 'task-shape-v1', shape: 'bounded' as const };
    run = { ...run, repairTaskShapeAuthority: repairAuthority };
    run = applyTransition(run, { type: 'changes_requested', reviewResult: {
      verdict: 'request_changes', reviewerName: 'fixture-reviewer', headSha: fixture.baseSha,
      findings: [{ severity: 'blocking', summary: 'repair required' }],
    } }, T0, TEST_VALIDATION_AUTHORITY);
    const repairExecution = { profile: 'routine' as const, revision: 'luna-v1', executor: 'luna-isolated' as const, timeoutMs: 60_000 };
    const store = memoryStore(run);
    const explicitWorkspace = path.join(directory, 'host-selected-repair-workspace');
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'workflow-repair-workspace-conflict-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId,
      pullRequest: 7, workspace: explicitWorkspace,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const originalEvidence = registry.readLane(runId)?.evidence;
    let plannedIdentity: ImplementationBootstrapIdentity | undefined;
    const originalStrengthen = registry.strengthen.bind(registry);
    let strengthenAfterPlanPersistence = 0;
    registry.strengthen = (token, evidence) => {
      if (plannedIdentity !== undefined && JSON.stringify(store.read(runId)?.bootstrap) === JSON.stringify(plannedIdentity)) {
        strengthenAfterPlanPersistence += 1;
      }
      return originalStrengthen(token, evidence);
    };
    const before = fixture.commands.length;
    const implementation = new NoopImplementation();
    const validation = new PassingValidation();
    const live = snapshot(fixture.baseSha, pr(7, fixture.baseSha, {
      headRef: 'existing-pr', baseRef: fixture.branch, baseSha: fixture.baseSha,
      headRepository: { owner: TARGET.owner, repo: TARGET.repo },
    }), { repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha } });
    const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    let planCalls = 0;
    let prepareCalls = 0;
    const realPlan = bootstrap.plan.bind(bootstrap);
    const realPrepare = bootstrap.prepare.bind(bootstrap);
    bootstrap.plan = async (request) => {
      planCalls += 1;
      plannedIdentity = await realPlan(request);
      return plannedIdentity;
    };
    bootstrap.prepare = async (request) => { prepareCalls += 1; return realPrepare(request); };

    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 12 }, () => live)), bootstrap, implementation,
      reviewer: new ApprovingReviewer(), validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
      resolveRepairExecutionProfile: () => repairExecution,
    }, runId, { maxReviewAttempts: 2, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: explicitWorkspace,
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.equal(planCalls, 1, 'the valid repair reaches the actual read-only standalone plan');
    assert.ok(plannedIdentity, 'the real standalone plan returns its exact identity');
    assert.deepEqual(store.read(runId)?.bootstrap, plannedIdentity,
      'the exact planned identity is durably retained before host workspace conflict handling');
    assert.ok(strengthenAfterPlanPersistence > 0,
      'the real workflow-owned review callback strengthens only after the exact plan identity is durable');
    assert.equal(prepareCalls, 0, 'the workflow-owned repair callback refuses before prepare');
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' &&
      (args.includes('fetch') || args.includes('init') || args.includes('worktree'))), false,
    'the refusal blocks every preparation mutation while preserving earlier read-only planning');
    assert.equal(implementation.requests.length, 0);
    assert.equal(validation.requests.length, 0);
    assert.deepEqual(registry.readLane(runId)?.evidence, originalEvidence,
      'the repair plan cannot substitute its workspace for the host-bound lane evidence');
  });

  it('holds when the real plan returns a different workspace than host admission, preserving earlier plan effects and authority', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-plan-workspace-mismatch-')); dirs.push(directory);
    const runId = 'initial-plan-workspace-mismatch';
    const workspace = path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`);
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-plan-workspace-mismatch-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;

    const gitBootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const mismatchedWorkspace = path.join(workspace, 'plan-returned-different-workspace');
    let planCalls = 0;
    let prepareCalls = 0;
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap',
      bootstrapKind: 'linked-worktree',
      async plan(request) {
        planCalls += 1;
        const planned = await gitBootstrap.plan(request);
        return { ...planned, workspacePath: mismatchedWorkspace };
      },
      async prepare() {
        prepareCalls += 1;
        throw new Error('prepare must not run after the plan conflicts with host admission');
      },
      guard: (planned) => gitBootstrap.guard(planned),
      verifyDurable: (request) => gitBootstrap.verifyDurable(request),
    };
    const store = memoryStore(createRun(TARGET, T0, runId));
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const implementation = new NoopImplementation();
    const validation = new PassingValidation();
    const before = fixture.commands.length;
    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 12 }, () => live)), bootstrap, implementation,
      reviewer: new ApprovingReviewer(), validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: workspace,
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /workspace|admission|ownership/i);
    assert.equal(planCalls, 1);
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), false,
      'planning is read-only and the mismatched identity is refused before prepare');
    assert.equal(prepareCalls, 0, 'the mismatched plan never enters prepare');
    assert.equal(implementation.requests.length, 0, 'no worker starts after workspace evidence conflicts');
    assert.equal(validation.requests.length, 0, 'validation does not run after the workspace conflict');
    const lane = registry.snapshot().lanes.find((candidate) => candidate.laneId === runId);
    const canonicalWorkspace = canonicalizeMissionEvidence({ repository: `${TARGET.owner}/${TARGET.repo}`, workspace }).workspace;
    const canonicalMismatchedWorkspace = canonicalizeMissionEvidence({ repository: `${TARGET.owner}/${TARGET.repo}`, workspace: mismatchedWorkspace }).workspace;
    assert.equal(lane?.evidence.workspace, canonicalWorkspace, 'the explicit host workspace is bound before comparing the returned plan');
    assert.notEqual(lane?.evidence.workspace, canonicalMismatchedWorkspace);
  });

  it('refuses existing-workspace preparation when the exact Run changes at the final entry callback', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const runId = 'prepare-entry-run-supersession';
    const gitBootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const planned = await gitBootstrap.plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    let initial = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
    initial = applyTransition(initial, { type: 'bootstrap_prepared', bootstrap: planned }, T0);
    const store = memoryStore(initial);
    let newerRun: Run | undefined;
    let prepareCalls = 0;
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree',
      async plan(request) { return gitBootstrap.plan(request); },
      async prepare(request) { prepareCalls += 1; return gitBootstrap.prepare(request); },
      guard: (identity) => gitBootstrap.guard(identity),
      verifyDurable: (request) => gitBootstrap.verifyDurable(request),
    };
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const before = fixture.commands.length;
    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 8 }, () => live)), bootstrap,
      implementation: new NoopImplementation(), reviewer: new ApprovingReviewer(), validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, onExecutionStart: () => {
      newerRun = { ...store.read(runId)!, updatedAt: '2026-09-28T00:00:05.000Z' };
      store.update(newerRun);
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.ok(newerRun);
    assert.deepEqual(store.read(runId), newerRun, 'the exact newer Run survives the refused prepare entry');
    assert.equal(prepareCalls, 0, 'the bootstrap adapter is not entered after the final Run check fails');
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), false);
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('worktree')), false);
  });

  it('does not strengthen admission when the exact Run changes before the first prepare-entry check', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-prepare-first-cas-')); dirs.push(directory);
    const runId = 'prepare-first-cas-run-supersession';
    const gitBootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const identity = await gitBootstrap.plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    let initial = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
    initial = applyTransition(initial, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    const store = memoryStore(initial);
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'prepare-first-cas-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const originalLane = structuredClone(registry.readLane(runId));
    let capturedRun: Run | undefined;
    let capturedRunSnapshot: Run | undefined;
    let newerRun: Run | undefined;
    let newerRunSnapshot: Run | undefined;
    let adapterBoundaryReads = 0;
    const casInvocationTrace: Array<{ expected: Run; next: Run; result: boolean }> = [];
    let strengthenCalls = 0;
    let prepareCalls = 0;
    const originalStrengthen = registry.strengthen.bind(registry);
    registry.strengthen = (token, evidence) => {
      strengthenCalls += 1;
      return originalStrengthen(token, evidence);
    };
    const storeWithFirstEntrySupersession = Object.create(store) as typeof store;
    Object.defineProperty(storeWithFirstEntrySupersession, 'updateIfUnchanged', {
      configurable: true,
      get: () => {
        if (newerRun === undefined) return store.updateIfUnchanged;
        return (expected: Run, next: Run) => {
          const expectedSnapshot = structuredClone(expected);
          const nextSnapshot = structuredClone(next);
          const result = store.updateIfUnchanged(expected, next);
          casInvocationTrace.push({ expected: expectedSnapshot, next: nextSnapshot, result });
          return result;
        };
      },
    });
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap',
      get bootstrapKind(): 'linked-worktree' {
        adapterBoundaryReads += 1;
        capturedRun = store.read(runId)!;
        capturedRunSnapshot = structuredClone(capturedRun);
        newerRun = { ...capturedRun, updatedAt: '2026-09-28T00:00:08.000Z' };
        store.update(newerRun);
        newerRunSnapshot = structuredClone(newerRun);
        return 'linked-worktree';
      },
      async plan(request) { return gitBootstrap.plan(request); },
      async prepare(request) { prepareCalls += 1; return gitBootstrap.prepare(request); },
      guard: (candidate) => gitBootstrap.guard(candidate),
      verifyDurable: (request) => gitBootstrap.verifyDurable(request),
    };
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const before = fixture.commands.length;
    const result = await runWorkflow({
      store: storeWithFirstEntrySupersession, github: new QueueGithub(Array.from({ length: 8 }, () => live)), bootstrap,
      implementation: new NoopImplementation(), reviewer: new ApprovingReviewer(), validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: identity.workspacePath,
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.ok(newerRun);
    assert.ok(capturedRun, 'the complete durable Run is captured at the adapter boundary');
    assert.ok(capturedRunSnapshot, 'the complete captured Run is snapshotted independently');
    assert.equal(adapterBoundaryReads, 1, 'the non-persisted adapter hook ran at the existing-bootstrap identity boundary');
    assert.equal(casInvocationTrace.length, 2, 'the strict entry CAS and refusal-reconciliation CAS both run after the adapter boundary');
    assert.deepEqual(casInvocationTrace.map(({ expected }) => expected), [capturedRunSnapshot, capturedRunSnapshot],
      'both ordered CAS invocations compare against the full captured Run');
    assert.deepEqual(casInvocationTrace.map(({ next }) => next), [capturedRunSnapshot, capturedRunSnapshot],
      'both ordered CAS invocations propose the full captured Run unchanged');
    assert.deepEqual(casInvocationTrace.map(({ result }) => result), [false, false],
      'the strict entry CAS and refusal-reconciliation CAS both observe the superseding Run');
    assert.deepEqual(store.read(runId), newerRunSnapshot, 'the complete newer Run remains intact after both failed CAS invocations');
    assert.equal(strengthenCalls, 0, 'the first entry refusal does not strengthen registry admission');
    assert.deepEqual(registry.readLane(runId), originalLane, 'the complete original lane remains unchanged before admission strengthening');
    assert.equal(prepareCalls, 0);
    assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && (args.includes('fetch') || args.includes('init') || args.includes('worktree'))), false,
      'no fetch, initialization, or worktree effect follows the failed first-entry CAS');
  });

  it('preserves a real newer Run when a persisted field changes before production prepare entry', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-prepare-real-store-cas-')); dirs.push(directory);
    const runId = 'prepare-real-store-cas-run-supersession';
    const gitBootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
    const planned = await gitBootstrap.plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
    let initial = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
    initial = applyTransition(initial, { type: 'bootstrap_prepared', bootstrap: planned }, T0);
    const store = new JsonFileStore({ dir: directory });
    store.create(initial);

    let newerRun: Run | undefined;
    let newerRunBytes: string | undefined;
    let newerProjectionBytes: string | undefined;
    let prepareCalls = 0;
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree',
      async plan(request) { return gitBootstrap.plan(request); },
      async prepare(request) { prepareCalls += 1; return gitBootstrap.prepare(request); },
      guard: (candidate) => gitBootstrap.guard(candidate),
      verifyDurable: (request) => gitBootstrap.verifyDurable(request),
    };
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    const fixtureCommandsBefore = fixture.commands.length;
    const implementation = new NoopImplementation();
    const result = await runWorkflow({
      store, github: new QueueGithub(Array.from({ length: 8 }, () => live)), bootstrap,
      implementation, reviewer: new ApprovingReviewer(), validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, onExecutionStart: () => {
      const current = store.read(runId);
      assert.ok(current);
      newerRun = { ...current, dispatchClaimId: 'superseding-durable-dispatch-claim' };
      store.update(newerRun);
      newerRunBytes = readFileSync(path.join(directory, `${runId}.json`), 'utf8');
      newerProjectionBytes = readFileSync(operationalProjectionPath(directory, runId), 'utf8');
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.ok(newerRun);
    assert.ok(newerRunBytes);
    assert.ok(newerProjectionBytes);
    assert.deepEqual(store.read(runId), newerRun, 'the exact newer durable Run remains after production prepare-entry refusal');
    assert.equal(readFileSync(path.join(directory, `${runId}.json`), 'utf8'), newerRunBytes,
      'no refusal reconciliation rewrites the newer durable Run');
    assert.equal(readFileSync(operationalProjectionPath(directory, runId), 'utf8'), newerProjectionBytes,
      'no refusal reconciliation rewrites the newer projection');
    assert.equal(prepareCalls, 0, 'the production bootstrap prepare closure is never entered');
    assert.equal(fixture.commands.length, fixtureCommandsBefore,
      'the fixture runner records no Git or child-process calls after the superseding store update');
    assert.equal(implementation.requests.length, 0, 'no worker starts after prepare-entry refusal');
  });

  for (const mode of ['missing', 'throws'] as const) {
    it(`refuses first prepare entry when strict Run CAS is ${mode}`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-prepare-entry-strict-cas-')); dirs.push(directory);
      const runId = `prepare-entry-strict-cas-${mode}`;
      const gitBootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await gitBootstrap.plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
      let initial = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
      initial = applyTransition(initial, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
      const store = memoryStore(initial);
      let armed = false;
      let boundaryReads = 0;
      let entryCasReads = 0;
      let prepareCalls = 0;
      let capturedRun: Run | undefined;
      let capturedRunBytes: string | undefined;
      const unavailable = new Error('first prepare-entry CAS threw');
      const storeWithSwitchableCas = Object.create(store) as typeof store;
      Object.defineProperty(storeWithSwitchableCas, 'updateIfUnchanged', {
        configurable: true,
        get: () => {
          if (!armed) return store.updateIfUnchanged;
          entryCasReads += 1;
          if (mode === 'missing') return undefined;
          return () => { throw unavailable; };
        },
      });
      const bootstrap: ImplementationBootstrapAdapter = {
        kind: 'implementation-bootstrap',
        get bootstrapKind(): 'linked-worktree' {
          boundaryReads += 1;
          capturedRun = store.read(runId)!;
          capturedRunBytes = JSON.stringify(capturedRun);
          armed = true;
          return 'linked-worktree';
        },
        async plan(request) { return gitBootstrap.plan(request); },
        async prepare(request) { prepareCalls += 1; return gitBootstrap.prepare(request); },
        guard: (candidate) => gitBootstrap.guard(candidate),
        verifyDurable: (request) => gitBootstrap.verifyDurable(request),
      };
      const registry = new MissionAdmissionRegistry({
        filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: `prepare-entry-strict-cas-${mode}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
      });
      const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
        repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId, workspace: identity.workspacePath,
      } });
      assert.equal(admission.outcome, 'admitted');
      if (admission.outcome !== 'admitted') return;
      const originalEvidence = registry.readLane(runId)?.evidence;
      let strengthenCalls = 0;
      const originalStrengthen = registry.strengthen.bind(registry);
      registry.strengthen = (token, evidence) => {
        strengthenCalls += 1;
        return originalStrengthen(token, evidence);
      };
      const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
        owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
      } });

      await assert.rejects(() => runWorkflow({
        store: storeWithSwitchableCas, github: new QueueGithub(Array.from({ length: 8 }, () => live)), bootstrap,
        implementation: new NoopImplementation(), reviewer: new ApprovingReviewer(), validation: new PassingValidation(),
        hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
        registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: identity.workspacePath,
      } }), (error: unknown) => {
        assert.equal(isExecutionAdmissionRefusal(error), true);
        assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
        assert.equal((error as { runSuperseded?: boolean }).runSuperseded, false);
        if (mode === 'throws') assert.strictEqual((error as Error).cause, unavailable);
        else assert.match(String((error as Error).cause), /Strict Run compare-and-swap is unavailable/);
        return true;
      });

      assert.equal(boundaryReads, 1, 'the non-persisted adapter hook ran at the existing-bootstrap identity boundary');
      assert.ok(armed, 'the existing-bootstrap identity boundary activated the first-entry injection');
      assert.equal(entryCasReads, 1, 'the missing/thrown strict CAS was observed at the first prepare-entry check');
      assert.equal(strengthenCalls, 0, 'first-entry uncertainty is discovered before admission strengthening');
      assert.ok(capturedRun);
      assert.equal(JSON.stringify(store.read(runId)), capturedRunBytes, 'the complete captured Run remains unchanged');
      assert.deepEqual(store.read(runId), capturedRun, 'all captured Run fields remain unchanged');
      assert.deepEqual(registry.readLane(runId)?.evidence, originalEvidence, 'lane evidence is unchanged before entry authority is confirmed');
      assert.equal(prepareCalls, 0, 'the bootstrap prepare entry is never called');
      assert.equal(fixture.commands.some(({ file, args }) => file === 'git' && (args.includes('fetch') || args.includes('init') || args.includes('worktree'))), false,
        'no fetch, initialization, or worktree effect follows the failed first-entry CAS');
    });
  }

  for (const mode of ['conflicting-workspace', 'conflicting-run-evidence'] as const) {
    it(`refuses initial preparation when existing workspace admission is ${mode}`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-plan-admission-refusal-')); dirs.push(directory);
      const runId = `initial-plan-${mode}`;
      const workspace = path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`);
      const registry = new MissionAdmissionRegistry({
        filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: `initial-plan-${mode}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
      });
      const conflictingWorkspace = path.join(directory, 'different-workspace');
      const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
        repository: `${TARGET.owner}/${TARGET.repo}`,
        issue: TARGET.issueNumber,
        run: mode === 'conflicting-run-evidence' ? `${runId}-other` : runId,
        ...(mode === 'conflicting-workspace'
          ? { workspace: conflictingWorkspace }
          : mode === 'conflicting-run-evidence' ? { workspace } : {}),
      } });
      assert.equal(admission.outcome, 'admitted');
      if (admission.outcome !== 'admitted') return;
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const store = memoryStore(createRun(TARGET, T0, runId));
      const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
        owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
      } });
      const before = fixture.commands.length;
      const originalEvidence = registry.snapshot().lanes.find((lane) => lane.laneId === runId)?.evidence;
      const result = await runWorkflow({
        store, github: new QueueGithub(Array.from({ length: 12 }, () => live)), bootstrap, implementation: new NoopImplementation(),
        reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
        registry, token: admission.token, productionMissionId: admission.missionId,
        ...(mode === 'conflicting-workspace' ? { executionWorkspace: workspace } : {}),
      } });
      assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
      assert.match(result.reason, mode === 'conflicting-workspace'
        ? /Mission evidence conflicts on workspace/
        : /Mission evidence conflicts on run/);
      assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), false,
        'conflicting host workspace or Run evidence refuses before the real prepare fetch');
      assert.deepEqual(registry.snapshot().lanes.find((lane) => lane.laneId === runId)?.evidence,
        originalEvidence, 'failed establishment leaves the full original admission evidence unchanged');
    });
  }

  it('preserves the exact tagged refusal raised after read-only initial planning', async () => {
    const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-plan-tagged-refusal-')); dirs.push(directory);
    const runId = 'initial-plan-tagged-refusal';
    const workspace = path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`);
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-plan-tagged-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
      repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId,
    } });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') return;
    const primaryCause = new Error('original planning authority cause');
    const primary = new ExecutionAdmissionRefusal('original planning admission refusal', false, {
      cause: primaryCause, authorityUnknown: true,
    });
    let taggedInjectionReached = 0;
    registry.strengthen = () => { taggedInjectionReached += 1; throw primary; };
    const fixtureCommandsBefore = fixture.commands.length;
    const run = createRun(TARGET, T0, runId);
    const live = snapshot(fixture.baseSha, null, { headSha: null, repository: {
      owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha,
    } });
    await assert.rejects(runWorkflow({
      store: memoryStore(run), github: new QueueGithub(Array.from({ length: 12 }, () => live)),
      bootstrap: new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner }),
      implementation: new NoopImplementation(), reviewer: new ApprovingReviewer(), validation: new PassingValidation(),
      hostedCheckPolicy: TEST_HOSTED_POLICY,
    }, runId, { maxReviewAttempts: 1, now: () => T0, admissionFence: {
      registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: workspace,
    } }), (error: unknown) => {
      assert.strictEqual(error, primary);
      assert.strictEqual((error as Error).cause, primaryCause);
      assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
      return true;
    });
    assert.equal(taggedInjectionReached, 1, 'the fixture reaches the host admission-strengthening boundary after a valid plan');
    assert.equal(fixture.commands.slice(fixtureCommandsBefore).some(({ file, args }) => file === 'git' && args.includes('fetch')), false);
    assert.equal(registry.snapshot().lanes.find((lane) => lane.laneId === runId)?.evidence.workspace, undefined,
      'the tagged planning refusal prevents workspace publication');
  });

  for (const boundary of [
    'prepare-fetch',
    'initial-worktree-add',
    'prepare-admission-revocation',
    'initial-worktree-add-admission-revocation',
    'prepare-tagged-admission-callback',
    'prepare-missing-cas',
    'prepare-thrown-cas',
    'prepare-reconciliation-cas-throws',
    'prepare-reconciliation-read-throws',
    'prepare-reconciliation-write-throws',
  ] as const) {
    it(`rechecks captured Run and current admission after runner preparation at ${boundary}`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-bootstrap-spawn-fence-')); dirs.push(dir);
      const runId = `spawn-fence-${boundary}`;
      const mutationIdentity = boundary === 'initial-worktree-add-admission-revocation'
        ? await new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner })
            .plan({ runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha })
        : undefined;
      const isWorktreeAdd = boundary.includes('worktree-add');
      const match = isWorktreeAdd
        ? (args: readonly string[]) => args[0] === 'worktree' && args[1] === 'add'
        : (args: readonly string[]) => args[0] === 'fetch';
      let registry: MissionAdmissionRegistry | undefined;
      let admission: ReturnType<MissionAdmissionRegistry['admit']> | undefined;
      const gate = gatedBootstrapRunner(fixture.runner, match, boundary === 'initial-worktree-add-admission-revocation'
        ? () => {
            assert.ok(registry !== undefined && admission?.outcome === 'admitted');
            registry.release(admission.token, true);
          }
        : boundary === 'prepare-tagged-admission-callback'
        ? () => {
            assert.ok(registry !== undefined);
            registry.assertCanMutate = () => { throw primaryRefusal; };
          }
        : undefined);
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: gate.runner });
      const initialRun = createRun(TARGET, T0, runId);
      const executionWorkspace = mutationIdentity?.workspacePath ?? path.join(
        fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${runId}-issue-${TARGET.issueNumber}`,
      );
      const store = memoryStore(initialRun);
      const live = snapshot(fixture.baseSha, null, {
        headSha: null,
        repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha },
      });
      const implementation = new NoopImplementation();
      if (boundary.includes('admission-revocation') || boundary.includes('reconciliation') || boundary.includes('tagged-admission')) {
        registry = new MissionAdmissionRegistry({
          filePath: path.join(dir, 'registry.json'),
          config: { schemaVersion: 1, revision: 'bootstrap-fence-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
        });
        admission = registry.admit({ laneId: runId, role: 'production_captain', evidence: {
          repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber,
          ...(mutationIdentity === undefined ? {} : { workspace: mutationIdentity.workspacePath }),
        } });
        assert.equal(admission.outcome, 'admitted');
      }
      let strictCasMode: 'available' | 'missing' | 'throws' | 'second-throws' | 'second-false' | 'third-throws' = 'available';
      let strictCasCallsAfterBoundary = 0;
      let failReconciliationRead = false;
      const primaryCause = new Error('original final execution admission refusal cause');
      const primaryRefusal = new ExecutionAdmissionRefusal('original final execution admission refusal', false, {
        cause: primaryCause, authorityUnknown: true,
      });
      const storeWithSwitchableCas = Object.create(store) as typeof store;
      Object.defineProperty(storeWithSwitchableCas, 'read', {
        configurable: true,
        get: () => failReconciliationRead ? () => { throw new Error('bootstrap refusal reconciliation read failed'); } : store.read,
      });
      Object.defineProperty(storeWithSwitchableCas, 'updateIfUnchanged', {
        configurable: true,
        get: () => strictCasMode === 'missing'
          ? undefined
          : (expected: Run, next: Run) => {
              if (strictCasMode === 'throws') throw new Error('strict Run comparison unavailable');
              if (strictCasMode === 'second-throws' && ++strictCasCallsAfterBoundary === 2) throw new Error('bootstrap refusal reconciliation CAS failed');
              if (strictCasMode === 'second-false' && ++strictCasCallsAfterBoundary === 2) return false;
              if (strictCasMode === 'third-throws' && ++strictCasCallsAfterBoundary === 3) throw new Error('bootstrap refusal reconciliation write failed');
              return store.updateIfUnchanged(expected, next);
            },
      });
      const options = { maxReviewAttempts: 1, now: () => T0,
        ...(registry !== undefined && admission?.outcome === 'admitted'
          ? { admissionFence: { registry, token: admission.token, productionMissionId: admission.missionId, executionWorkspace } }
          : {}) };
      const pending = runWorkflow({
        store: storeWithSwitchableCas, github: new QueueGithub(Array.from({ length: 12 }, () => live)), implementation,
        bootstrap, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, runId, options);
      await gate.entered;
      const atBoundary = store.read(runId)!;
      let newerRun: Run | undefined;
      if (boundary === 'initial-worktree-add-admission-revocation') {
        gate.release();
      } else if (boundary.includes('reconciliation')) {
        assert.ok(registry !== undefined && admission?.outcome === 'admitted');
        strictCasMode = boundary.endsWith('write-throws') ? 'third-throws'
          : boundary.endsWith('read-throws') ? 'second-false' : 'second-throws';
        strictCasCallsAfterBoundary = 0;
        failReconciliationRead = boundary.endsWith('read-throws');
        registry.release(admission.token, true);
      } else if (boundary.includes('admission-revocation')) {
        assert.ok(registry !== undefined && admission?.outcome === 'admitted');
        registry.release(admission.token, true);
      } else if (boundary === 'prepare-missing-cas' || boundary === 'prepare-thrown-cas') {
        strictCasMode = boundary === 'prepare-missing-cas' ? 'missing' : 'throws';
      } else if (boundary === 'prepare-tagged-admission-callback') {
        // Keep the exact Run and active lane current so the tagged refusal is
        // raised by the real final mutation callback after its successful CAS.
      } else {
        newerRun = { ...atBoundary, updatedAt: '2026-09-28T00:00:01.000Z' };
        store.update(newerRun);
      }
      gate.release();
      if (boundary === 'prepare-tagged-admission-callback') {
        await assert.rejects(pending, (error: unknown) => {
          assert.strictEqual(error, primaryRefusal);
          assert.strictEqual((error as Error).cause, primaryCause);
          assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
          assert.equal((error as { runSuperseded?: boolean }).runSuperseded, false);
          return true;
        });
      } else if (boundary === 'prepare-missing-cas' || boundary === 'prepare-thrown-cas' || boundary.includes('reconciliation')) {
        await assert.rejects(pending, (error: unknown) => {
          assert.equal(isExecutionAdmissionRefusal(error), true);
          if (boundary.includes('reconciliation')) {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, false);
            assert.match(String((error as Error).cause), /Admission generation token is stale/);
          } else {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
            assert.match(String((error as Error).cause), /strict Run comparison unavailable|Strict Run compare-and-swap/);
          }
          return true;
        });
      }
      const outcome = boundary === 'prepare-missing-cas' || boundary === 'prepare-thrown-cas' || boundary.includes('reconciliation') || boundary === 'prepare-tagged-admission-callback' ? undefined : await pending;
      assert.equal(gate.blocked(), true);
      const blockedCommandWasExecuted = fixture.commands.some(({ file, args }) => file === 'git' && match(args));
      assert.equal(blockedCommandWasExecuted, false, 'the intercepted mutating command never reaches real Git');
      assert.equal(implementation.requests.length, 0, 'no worker or later validation starts after refusal');
      if (outcome === undefined) {
        assert.deepEqual(store.read(runId), atBoundary, 'strict-CAS uncertainty preserves the complete Run value');
        return;
      }
      if (boundary.includes('admission-revocation')) {
        assert.equal(outcome.outcome, 'needs_human', JSON.stringify(outcome));
        assert.match(outcome.reason, /EXECUTION_ADMISSION_REFUSED/);
        assert.match(outcome.reason, /could not confirm current mission admission/);
        assert.equal(store.read(runId)?.state, 'NEEDS_HUMAN');
      } else if (boundary === 'prepare-missing-cas' || boundary === 'prepare-thrown-cas') {
        assert.deepEqual(store.read(runId), atBoundary, 'unknown preparation authority preserves the exact persisted identity Run');
      } else {
        assert.ok(newerRun);
        assert.deepEqual(store.read(runId), newerRun, 'the complete newer Run value survives reconciliation');
      }
      if (isWorktreeAdd) {
        const planned = atBoundary.bootstrap;
        assert.ok(planned);
        assert.equal(existsSync(planned.workspacePath), false, 'the workspace is absent at the blocked worktree-add boundary');
      }
    });
  }

  for (const mode of ['run-superseded', 'admission-revoked', 'reconciliation-cas-missing', 'reconciliation-cas-throws', 'reconciliation-read-throws', 'reconciliation-write-throws'] as const) {
    it(`rechecks validation Run and admission after runner preparation at the owned-workspace fetch (${mode})`, async () => {
      const fixture = createBootstrapGitFixture(); fixtures.push(fixture);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-spawn-fence-')); dirs.push(dir);
      const runId = `validation-spawn-fence-${mode}`;
      const setup = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const request = { runId, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha };
      const bootstrapIdentity = await setup.plan(request);
      await setup.prepare({ ...request, existing: bootstrapIdentity });
      fixture.git(bootstrapIdentity.workspacePath, ['push', 'origin', bootstrapIdentity.branch]);
      let casMode: 'available' | 'missing' | 'second-throws' | 'second-false' | 'third-throws' = 'available';
      let primaryRefusal: unknown;
      let primaryCause: unknown;
      const gated = gatedBootstrapRunner(fixture.runner, (args) => args[0] === 'fetch', undefined, (error) => {
        primaryRefusal = error;
        primaryCause = (error as Error).cause;
        if (mode === 'reconciliation-cas-missing') casMode = 'missing';
      });
      const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: gated.runner });
      let run = applyTransition(createRun(TARGET, T0, runId), { type: 'start' }, T0);
      run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: bootstrapIdentity }, T0);
      run = applyTransition(run, {
        type: 'agent_succeeded', headSha: fixture.baseSha,
        pullRequest: { number: 7, headSha: fixture.baseSha }, agentResult: successResult(fixture.baseSha),
      }, T0);
      const store = memoryStore(run);
      const originalCas = store.updateIfUnchanged.bind(store);
      let casCallsAfterBoundary = 0;
      let failFollowupRead = false;
      const storeWithSwitchableCas = Object.create(store) as typeof store;
      Object.defineProperty(storeWithSwitchableCas, 'read', {
        configurable: true,
        get: () => failFollowupRead ? () => { throw new Error('validation refusal reconciliation read failed'); } : store.read,
      });
      Object.defineProperty(storeWithSwitchableCas, 'updateIfUnchanged', {
        configurable: true,
        get: () => casMode === 'missing' ? undefined : (expected: Run, next: Run) => {
          if (casMode === 'second-throws' && ++casCallsAfterBoundary === 2) throw new Error('validation refusal reconciliation CAS failed');
          if (casMode === 'second-false' && ++casCallsAfterBoundary === 2) return false;
          if (casMode === 'third-throws' && ++casCallsAfterBoundary === 3) throw new Error('validation refusal reconciliation write failed');
          return originalCas(expected, next);
        },
      });
      const currentAdmission = mode !== 'run-superseded'
        ? new MissionAdmissionRegistry({
            filePath: path.join(dir, 'validation-registry.json'),
            config: { schemaVersion: 1, revision: 'validation-fence-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
          })
        : undefined;
      const admission = currentAdmission?.admit({
        laneId: runId,
        role: 'production_captain',
        evidence: { repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: runId, workspace: bootstrapIdentity.workspacePath },
      });
      if (admission !== undefined) assert.equal(admission.outcome, 'admitted');
      const live = snapshot(fixture.baseSha, pr(7, fixture.baseSha, { headRef: bootstrapIdentity.branch, baseRef: fixture.branch, baseSha: fixture.baseSha }), {
        repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha },
      });
      let validations = 0;
      const validation: ValidationAdapter = {
        kind: 'validation', configRevision: 'owned-workspace-fence-v1', requiresOwnedWorkspace: true,
        async validate(input) { validations += 1; return validationPassed(input.headSha).local; },
      };
      const implementation = new NoopImplementation();
      const pending = runWorkflow({
        store: storeWithSwitchableCas, bootstrap, github: new QueueGithub(Array.from({ length: 8 }, () => live)),
        implementation, reviewer: new ApprovingReviewer(), validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, runId, {
        maxReviewAttempts: 1, now: () => T0,
        ...(currentAdmission !== undefined && admission?.outcome === 'admitted'
          ? { admissionFence: { registry: currentAdmission, token: admission.token, productionMissionId: admission.missionId, executionWorkspace: bootstrapIdentity.workspacePath } }
          : {}),
      });
      const commandsBeforeFence = fixture.commands.length;
      await gated.entered;
      const atBoundary = store.read(runId)!;
      let newerRun: Run | undefined;
      if (mode === 'run-superseded') {
        newerRun = { ...atBoundary, updatedAt: '2026-09-28T00:00:02.000Z' };
        store.update(newerRun);
      }
      else {
        if (mode.startsWith('reconciliation-')) {
          if (mode !== 'reconciliation-cas-missing') {
            casMode = mode === 'reconciliation-cas-throws' ? 'second-throws'
              : mode === 'reconciliation-read-throws' ? 'second-false' : 'third-throws';
          }
          casCallsAfterBoundary = 0;
          failFollowupRead = mode === 'reconciliation-read-throws';
        }
        assert.ok(currentAdmission !== undefined && admission?.outcome === 'admitted');
        currentAdmission.release(admission.token, true);
      }
      gated.release();
      let outcome: Awaited<typeof pending> | undefined;
      if (mode.startsWith('reconciliation-')) {
        await assert.rejects(pending, (error: unknown) => {
          assert.strictEqual(error, primaryRefusal, 'reconciliation uncertainty retains the exact original refusal');
          assert.equal(isExecutionAdmissionRefusal(error), true);
          assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, false);
          assert.strictEqual((error as Error).cause, primaryCause);
          assert.match(String(primaryCause), /Admission generation token is stale/);
          return true;
        });
      } else outcome = await pending;
      assert.equal(gated.blocked(), true);
      assert.equal(fixture.commands.slice(commandsBeforeFence).some(({ file, args }) => file === 'git' && args[0] === 'fetch'), false,
        'the held owned-workspace fetch never reaches real Git');
      assert.equal(validations, 0, 'local validation does not start after admission refusal');
      assert.equal(implementation.requests.length, 0, 'no implementation worker starts after admission refusal');
      if (mode === 'run-superseded') {
        assert.ok(outcome);
        assert.ok(newerRun);
        assert.deepEqual(store.read(runId), newerRun, 'the complete newer Run value survives validation reconciliation');
        assert.notDeepEqual(outcome.run, atBoundary);
      } else if (mode === 'admission-revoked') {
        assert.ok(outcome);
        assert.equal(outcome.outcome, 'needs_human', JSON.stringify(outcome));
        assert.match(outcome.reason, /Owned-workspace validation entry was refused by its host admission boundary/);
        assert.match(outcome.reason, /could not confirm current mission admission/);
        assert.equal(isExecutionAdmissionRefusal(primaryRefusal), true, 'the runner callback captured the actual tagged validation refusal');
        assert.equal((primaryRefusal as { authorityUnknown?: boolean }).authorityUnknown, false, 'revocation is known at this boundary');
        assert.equal((primaryRefusal as { runSuperseded?: boolean }).runSuperseded, false);
        assert.match(String(primaryCause), /Admission generation token is stale/);
        assert.equal(outcome.run.state, 'NEEDS_HUMAN');
        assert.deepEqual(store.read(runId), outcome.run, 'the memory store contains the full parked Run returned by validation reconciliation');
      } else {
        assert.deepEqual(store.read(runId), atBoundary, 'failed reconciliation preserves the complete pre-effect Run value');
      }
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
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(f.baseSha) }, T0);
      run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: f.baseSha, findings: [{ severity: 'blocking', summary: 'required fix' }] } }, T0, TEST_VALIDATION_AUTHORITY);
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
      const result = await runWorkflow({ store: new JsonFileStore({ dir }), bootstrap: b, github: new QueueGithub(Array.from({ length: 12 }, () => live)), implementation, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, id, { maxReviewAttempts: 3, now: () => T0 });
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
      run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0, TEST_VALIDATION_AUTHORITY);
      if (state === 'IMPLEMENTING') run = applyTransition(run, { type: 'start_fix' }, T0);
      const calls: string[] = [];
      const live = drift === 'head' ? snapshot(NEW) : drift === 'disappeared' ? snapshot(OLD, null, { headSha: null }) : snapshot(OLD, pr(8, OLD));
      const result = await runWorkflow({
        store: memoryStore(run),
        github: new QueueGithub(drift === 'post-tuple' ? [snapshot(OLD), live] : [live]),
        implementation: { kind: 'implementation-agent', run: async () => { calls.push('agent'); return successResult(NEW); } },
        reviewer: new ApprovingReviewer(),
        bootstrap: { kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree', plan: async () => identity, prepare: async () => { calls.push('prepare'); return identity; }, guard: () => ({ assertValid: async () => undefined }), verifyDurable: async () => { throw new Error('must not verify'); } },
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
        run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(head) }, T0);
        run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: head, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0, TEST_VALIDATION_AUTHORITY);
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
        reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY, resolveImplementationCapabilities: async () => {
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
    const result = await runWorkflow({ store, bootstrap: b, github: new QueueGithub([live, live]), implementation, reviewer: new ApprovingReviewer(), validation: new PassingValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, runId, { now: () => T0, maxReviewAttempts: 2 });
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
  r = applyTransition(r, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'fixture', headSha: OLD, findings: [{ severity: 'blocking', summary: 'fix' }] } }, T0, TEST_VALIDATION_AUTHORITY);
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
