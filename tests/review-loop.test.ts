import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { qualifyGovernedPublicationAdapter, type ImplementationAgent, type ImplementationRequest } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { WorkerRouterAdapter } from '../src/agents/worker-router.js';
import type { ContainerWorkerExecution } from '../src/agents/worker-router-container.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition, type ActiveValidationConfiguration } from '../src/domain/state-machine.js';
import { createRepairAdmissionSnapshot, createRepairAttemptBinding } from '../src/domain/repair-admission.js';
import type { RunTelemetryCompletionEvent, RunTelemetrySpawnEvent } from '../src/domain/telemetry.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import type { AgentResult, ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import { ReviewerError } from '../src/reviewers/deepseek.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { TARGET, failureResult, successResult, validationFailed, validationPassed } from './helpers.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD3 = 'cccccccccccccccccccccccccccccccccccccccc';
const ROUTINE_REPAIR_EXECUTION: ResolvedExecutionConfiguration = {
  profile: 'routine', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 60_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function reviewAuthority() {
  return {
    local: { kind: 'configured' as const, revision: 'test-config-v1' },
    hosted: { kind: 'configured' as const, revision: 'test-hosted-policy-v1', mode: 'required' as const },
  };
}

class MemoryStore implements RunStore {
  readonly name = 'memory';
  private readonly runs = new Map<string, Run>();

  create(run: Run): void {
    this.runs.set(run.id, run);
  }

  read(id: string): Run | null {
    return this.runs.get(id) ?? null;
  }

  update(run: Run): void {
    this.runs.set(run.id, run);
  }

  updateIfUnchanged(expected: Run, next: Run): boolean {
    const current = this.read(expected.id);
    if (current === null || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.update(next);
    return true;
  }

  list(): Run[] {
    return [...this.runs.values()];
  }

  delete(id: string): void {
    this.runs.delete(id);
  }
}

function reviewingRun(headSha = HEAD, id = 'run-1', sessionId?: string, execution?: ResolvedExecutionConfiguration): Run {
  let run = createRun(TARGET, T0, id, execution);
  run = applyTransition(run, { type: 'start' }, T0);
  const agentResult = { ...successResult(headSha), ...(sessionId === undefined ? {} : { sessionId }) };
  run = applyTransition(run, { type: 'agent_succeeded', agentResult, headSha }, T0);
  run = applyTransition(run, {
    type: 'validation_passed',
    validationResult: validationPassed(headSha),
    pullRequest: { number: 7, headSha },
  }, T0);
  return run;
}

function repairChangesRun(id: string): Run {
  const admitted = {
    ...reviewingRun(HEAD, id),
    repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' as const },
  };
  return applyTransition(admitted, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, reviewAuthority());
}

class CasMemoryStore extends MemoryStore {
  casCalls = 0;
  casSuccesses = 0;

  override updateIfUnchanged(expected: Run, next: Run): boolean {
    this.casCalls += 1;
    const current = this.read(expected.id);
    if (current === null || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.update(next);
    this.casSuccesses += 1;
    return true;
  }
}

class SpawnRaceStore extends CasMemoryStore {
  private attempts = 0;
  constructor(private readonly rejectAt: number, private readonly concurrent: (expected: Run) => Run) { super(); }

  override updateIfUnchanged(expected: Run, next: Run): boolean {
    this.attempts += 1;
    if (this.attempts === this.rejectAt) {
      this.update(this.concurrent(expected));
      return false;
    }
    return super.updateIfUnchanged(expected, next);
  }
}

function snapshot(headSha: string | null): GitHubLiveSnapshot {
  return {
    repository: { owner: 'acme', repo: 'widgets', defaultBranch: null, defaultBranchHeadSha: null },
    issue: {
      id: 'I_42',
      number: 42,
      title: 'Fix the widget',
      body: '',
      state: 'open',
      url: '',
      createdAt: T0,
      updatedAt: T0,
    },
    pullRequest:
      headSha === null
        ? null
        : { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: null, updatedAt: '', headSha, baseSha: 'base' },
    headSha,
    checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: T0,
  };
}

function githubAdapter(liveHeads: Array<string | null>): GitHubAdapter {
  return {
    kind: 'github',
    async readIssue() {
      throw new Error('unused');
    },
    async readBranch() {
      throw new Error('unused');
    },
    async listPullRequests() {
      throw new Error('unused');
    },
    async readLiveSnapshot() {
      const head = liveHeads.shift();
      if (head === undefined) throw new Error('No live snapshot queued');
      return snapshot(head);
    },
  };
}

class FakeReviewer implements ReviewerAdapter {
  readonly kind: 'reviewer' = 'reviewer';
  readonly requests: ReviewRequest[] = [];

  constructor(private readonly outcomes: Array<ReviewResult | Error>) {}

  async review(request: ReviewRequest): Promise<ReviewResult> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No review outcome queued');
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

class FakeImplementation implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  readonly preflightRequests: ImplementationRequest[] = [];
  readonly requests: Array<{
    baseSha: string;
    instructions: string | undefined;
    sessionId: string | undefined;
    executor: ImplementationRequest['executor'];
    execution: ImplementationRequest['execution'];
    capabilities: ImplementationRequest['capabilities'];
    workspacePath: string | undefined;
    branch: string | undefined;
    workspaceGuard: ImplementationRequest['workspaceGuard'];
  }> = [];

  constructor(private readonly outcomes: AgentResult[]) {}

  prepareGovernedInvocation(request: ImplementationRequest) {
    this.preflightRequests.push(request);
    qualifyGovernedPublicationAdapter(this);
    return { status: 'qualified' as const, agent: this };
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    this.requests.push({
      baseSha: request.baseSha,
      instructions: request.instructions,
      sessionId: request.sessionId,
      executor: request.executor,
      execution: request.execution,
      capabilities: request.capabilities,
      workspacePath: request.workspacePath,
      branch: request.branch,
      workspaceGuard: request.workspaceGuard,
    });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No implementation outcome queued');
    return outcome;
  }
}

function requestChanges(headSha: string): ReviewResult {
  return {
    verdict: 'request_changes',
    reviewerName: 'deepseek',
    headSha,
    findings: [{ severity: 'blocking', summary: 'the diff has a bug' }],
  };
}

function approve(headSha: string): ReviewResult {
  return { verdict: 'approve', reviewerName: 'deepseek', headSha, findings: [] };
}

describe('runReviewLoop', () => {
  it('persists an approved review at FINAL_GATE for the final-gate workflow', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'FINAL_GATE');
    const persisted = store.read('run-1');
    assert.equal(persisted?.state, 'FINAL_GATE');
    assert.equal(persisted?.history.some((entry) => entry.type === 'final_gate_verified'), false);
  });

  it('preserves a concurrent durable Run change while the live GitHub snapshot is pending', async () => {
    const initial = reviewingRun(HEAD, 'review-snapshot-race');
    const concurrent = applyTransition(initial, {
      type: 'escalate', reason: 'Operator cancellation during reviewer snapshot',
      interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
    }, T0);
    const store = new CasMemoryStore();
    store.create(initial);
    const entered = deferred<void>();
    const resultSnapshot = deferred<GitHubLiveSnapshot>();
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => { entered.resolve(undefined); return resultSnapshot.promise; };
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const pending = runReviewLoop({ store, github, implementation: new FakeImplementation([]), reviewer, resolveValidationAuthority: reviewAuthority }, initial.id, { maxAttempts: 3, now: () => T0 });

    await entered.promise;
    store.update(concurrent);
    resultSnapshot.resolve(snapshot(HEAD));
    const result = await pending;

    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(store.read(initial.id), concurrent, 'a stale snapshot result cannot overwrite the newer Run');
    assert.equal(reviewer.requests.length, 0, 'the reviewer is not invoked after its Run snapshot becomes stale');
  });

  it('preserves a concurrent durable Run change while the reviewer is pending', async () => {
    const initial = reviewingRun(HEAD, 'review-result-race');
    const store = new CasMemoryStore();
    store.create(initial);
    const entered = deferred<void>();
    const reviewResult = deferred<ReviewResult>();
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review() { entered.resolve(undefined); return reviewResult.promise; },
    };
    const pending = runReviewLoop({ store, github: githubAdapter([HEAD, HEAD]), implementation: new FakeImplementation([]), reviewer, resolveValidationAuthority: reviewAuthority }, initial.id, { maxAttempts: 3, now: () => T0 });

    await entered.promise;
    const current = store.read(initial.id)!;
    const concurrent = applyTransition(current, {
      type: 'escalate', reason: 'Operator cancellation during independent review',
      interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
    }, T0);
    store.update(concurrent);
    reviewResult.resolve(approve(HEAD));
    const result = await pending;

    assert.equal(result.outcome, 'needs_human', 'a stale approval is never returned as approved');
    assert.deepEqual(store.read(initial.id), concurrent, 'review completion telemetry and verdict cannot overwrite the newer Run');
  });

  it('does not persist stale reviewer failure telemetry over a concurrent Run change', async () => {
    const initial = reviewingRun(HEAD, 'review-failure-race');
    const store = new CasMemoryStore();
    store.create(initial);
    const entered = deferred<void>();
    const finish = deferred<void>();
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review() { entered.resolve(undefined); await finish.promise; throw new Error('review service failed'); },
    };
    const pending = runReviewLoop({ store, github: githubAdapter([HEAD, HEAD]), implementation: new FakeImplementation([]), reviewer, resolveValidationAuthority: reviewAuthority }, initial.id, { maxAttempts: 3, now: () => T0 });

    await entered.promise;
    const current = store.read(initial.id)!;
    const concurrent = applyTransition(current, {
      type: 'escalate', reason: 'Operator cancellation during failed review',
      interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
    }, T0);
    store.update(concurrent);
    finish.resolve(undefined);
    const result = await pending;

    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(store.read(initial.id), concurrent, 'failure telemetry and escalation cannot overwrite the newer Run');
  });

  it('requires an authority resolver for direct public review-loop entry', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());

    await assert.rejects(
      runReviewLoop(
        {
          store,
          github: githubAdapter([HEAD]),
          implementation: new FakeImplementation([]),
          reviewer: new FakeReviewer([]),
        } as unknown as Parameters<typeof runReviewLoop>[0],
        'run-1',
        { maxAttempts: 3, now: () => T0 },
      ),
      /requires a current validation-authority resolver/,
    );
  });

  it('does not invoke a reviewer when fresh policy identity differs or is removed', async () => {
    const authorities: ReadonlyArray<{ readonly id: string; readonly resolve: () => ActiveValidationConfiguration }> = [
      { id: 'policy-revision', resolve: () => ({
        local: { kind: 'configured' as const, revision: 'test-config-v2' },
        hosted: { kind: 'configured' as const, revision: 'test-hosted-policy-v1', mode: 'required' as const },
      }) },
      { id: 'policy-removed', resolve: () => ({ local: { kind: 'absent' as const }, hosted: { kind: 'absent' as const } }) },
    ];
    for (const { id, resolve } of authorities) {
      const store = new MemoryStore();
      store.create(reviewingRun(HEAD, id));
      const reviewer = new FakeReviewer([approve(HEAD)]);
      const result = await runReviewLoop(
        {
          store,
          github: githubAdapter([HEAD]),
          implementation: new FakeImplementation([]),
          reviewer,
          resolveValidationAuthority: resolve,
        },
        store.list()[0]!.id,
        { maxAttempts: 3, now: () => T0 },
      );
      assert.equal(result.outcome, 'revalidating');
      assert.equal(result.run.state, 'VALIDATING');
      assert.equal(result.run.reviewResult, undefined);
      assert.equal(reviewer.requests.length, 0);
    }
  });

  it('F06 persists REVIEWING, then a fresh JsonFileStore revalidates changed policy before any reviewer call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-reviewing-restart-'));
    try {
      const first = new JsonFileStore({ dir });
      first.create(reviewingRun(HEAD, 'reviewing-policy-restart'));
      const restarted = new JsonFileStore({ dir });
      const reviewer = new FakeReviewer([approve(HEAD)]);

      const result = await runReviewLoop(
        {
          store: restarted,
          github: githubAdapter([HEAD]),
          implementation: new FakeImplementation([]),
          reviewer,
          resolveValidationAuthority: () => ({
            local: { kind: 'configured', revision: 'changed-local-v2' },
            hosted: { kind: 'configured', revision: 'test-hosted-policy-v1', mode: 'required' },
          }),
        },
        'reviewing-policy-restart',
        { maxAttempts: 3, now: () => T0 },
      );

      assert.equal(result.outcome, 'revalidating');
      assert.equal(result.run.state, 'VALIDATING');
      assert.equal(reviewer.requests.length, 0);
      const persisted = new JsonFileStore({ dir }).read('reviewing-policy-restart');
      assert.equal(persisted?.state, 'VALIDATING');
      assert.equal(persisted?.reviewResult, undefined);
      assert.equal(persisted?.history.at(-1)?.type, 'revalidate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F03 carries a validation-failure repair through a fresh store with the accepted PR and executor session', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-repair-'));
    try {
      let run = createRun(TARGET, T0, 'validation-repair');
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, {
        type: 'agent_succeeded', headSha: HEAD,
        agentResult: { ...successResult(HEAD), sessionId: 'session-validation', executor: { provider: 'codex-cli', sessionId: 'thread-validation' } },
      }, T0);
      run = applyTransition(run, {
        type: 'validation_failed', validationResult: {
          ...validationPassed(HEAD), status: 'failed',
          local: { ...validationPassed(HEAD).local, status: 'failed', commands: [{ commandIndex: 0, executable: 'test', outcome: 'failed', exitCode: 1, durationMs: 1 }] },
        }, pullRequest: { number: 7, headSha: HEAD },
      }, T0);
      new JsonFileStore({ dir }).create(run);

      const implementation = new FakeImplementation([successResult(HEAD2, 'validation repair')]);
      const result = await runReviewLoop(
        {
          store: new JsonFileStore({ dir }),
          github: githubAdapter([HEAD, HEAD2]),
          implementation,
          reviewer: new FakeReviewer([]),
          resolveValidationAuthority: reviewAuthority,
        },
        'validation-repair',
        { maxAttempts: 3, now: () => T0 },
      );

      assert.equal(result.outcome, 'revalidating');
      assert.equal(result.run.state, 'VALIDATING');
      assert.equal(result.run.headSha, HEAD2);
      assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD2 });
      assert.equal(implementation.requests[0]?.sessionId, 'session-validation');
      assert.deepEqual(implementation.requests[0]?.executor, { provider: 'codex-cli', sessionId: 'thread-validation' });
      const persisted = new JsonFileStore({ dir }).read('validation-repair');
      assert.equal(persisted?.history.filter((entry) => entry.type === 'start_fix').length, 1);
      assert.deepEqual(persisted?.pullRequest, { number: 7, headSha: HEAD2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops an awaited review when authority changes before result persistence', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    let revision = 'test-config-v1';
    class ChangingReviewer extends FakeReviewer {
      override async review(request: ReviewRequest): Promise<ReviewResult> {
        const result = await super.review(request);
        revision = 'test-config-v2';
        return result;
      }
    }
    const reviewer = new ChangingReviewer([approve(HEAD)]);
    const result = await runReviewLoop(
      {
        store,
        github: githubAdapter([HEAD, HEAD]),
        implementation: new FakeImplementation([]),
        reviewer,
        resolveValidationAuthority: () => ({
          local: { kind: 'configured', revision },
          hosted: { kind: 'configured', revision: 'test-hosted-policy-v1', mode: 'required' },
        }),
      },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(result.outcome, 'revalidating', result.outcome === 'needs_human' ? result.reason : '');
    assert.equal(result.run.state, 'VALIDATING');
    assert.equal(result.run.reviewResult, undefined);
    assert.equal(reviewer.requests.length, 1);
  });

  it('returns a new fix HEAD to VALIDATING instead of bypassing fresh validation', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2, 'fixed')]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.equal(result.run.state, 'VALIDATING');
    assert.equal(result.run.headSha, HEAD2);
    assert.deepEqual(implementation.requests[0]?.instructions, '1. [blocking] the diff has a bug');
    assert.deepEqual(reviewer.requests.map((request) => request.headSha), [HEAD]);
  });

  it('keeps an ordinary linked worktree on its linked transport even when its path contains /luna-', async () => {
    const store = new MemoryStore();
    const execution = ROUTINE_REPAIR_EXECUTION;
    const identity: ImplementationBootstrapIdentity = {
      bootstrapKind: 'linked-worktree', owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: 'base',
      branch: 'tachiko/ordinary', workspacePath: '/tmp/luna-looking/ordinary-worktree',
    };
    let run = createRun(TARGET, T0, 'linked-luna-looking', execution);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD, pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD) }, T0);
    store.create(run);
    const selected: Array<string | undefined> = [];
    const linked: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree',
      async plan() { return identity; }, async prepare() { return identity; }, guard() { return { assertValid: () => undefined }; },
      async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: identity.branch }; },
    };
    const implementation = new FakeImplementation([successResult(HEAD2)]);
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, pullRequest: { ...live.pullRequest!, headRef: identity.branch, baseRef: identity.baseBranch,
        headRepository: { owner: identity.owner, repo: identity.repo } } };
    };
    const result = await runReviewLoop(
      { store, github, implementation, reviewer: new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]),
        resolveValidationAuthority: reviewAuthority, bootstrapForExecution: (candidate) => { selected.push(candidate?.executor); return linked; } },
      run.id, { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(result.outcome, 'revalidating');
    assert.deepEqual(selected, ['codex-cli']);
    assert.equal(implementation.requests[0]?.execution?.executor, 'codex-cli');
  });

  it('fails closed when a standalone Luna workspace is assigned a non-Luna repair transport', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'standalone-transition', ROUTINE_REPAIR_EXECUTION);
    const identity: ImplementationBootstrapIdentity = {
      bootstrapKind: 'standalone-isolated', owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: 'base',
      branch: 'tachiko/luna', workspacePath: '/tmp/not-a-signal',
    };
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD, pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD) }, T0);
    store.create(run);
    const implementation = new FakeImplementation([successResult(HEAD2)]);
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, pullRequest: { ...live.pullRequest!, headRef: identity.branch, baseRef: identity.baseBranch,
        headRepository: { owner: identity.owner, repo: identity.repo } } };
    };
    const result = await runReviewLoop(
      { store, github, implementation, reviewer: new FakeReviewer([requestChanges(HEAD)]), resolveValidationAuthority: reviewAuthority },
      run.id, { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /cannot transition/);
    assert.equal(implementation.requests.length, 0);
  });

  it('does not resolve browser or MCP capabilities for an isolated Luna review repair', async () => {
    const luna: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' };
    const identity: ImplementationBootstrapIdentity = { bootstrapKind: 'standalone-isolated', owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: 'base', branch: 'tachiko/luna', workspacePath: '/tmp/luna-review' };
    const store = new MemoryStore();
    let run = reviewingRun(HEAD, 'luna-capabilities', undefined, luna);
    run = { ...run, bootstrap: identity };
    store.create(run);
    const bootstrap: ImplementationBootstrapAdapter = { kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated', async plan() { return identity; }, async prepare() { return identity; }, guard() { return { assertValid: () => undefined }; }, async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: identity.branch }; } };
    const implementation = new FakeImplementation([successResult(HEAD2)]);
    let resolved = 0;
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, issue: { ...live.issue, body: 'Original bounded requirement.' }, pullRequest: { ...live.pullRequest!, headRef: identity.branch, baseRef: identity.baseBranch, headRepository: { owner: identity.owner, repo: identity.repo } } };
    };
    const result = await runReviewLoop({ store, github, implementation, reviewer: new FakeReviewer([requestChanges(HEAD)]), resolveValidationAuthority: reviewAuthority, bootstrapForExecution: () => bootstrap, resolveImplementationCapabilities: async () => { resolved += 1; return [{ kind: 'mcp-http', name: 'browser', endpoint: 'http://127.0.0.1:1/mcp' }]; } }, run.id, { maxAttempts: 3, now: () => T0 });
    assert.equal(result.outcome, 'revalidating');
    assert.equal(resolved, 0);
    assert.equal(implementation.requests[0]?.capabilities, undefined);
    assert.match(implementation.requests[0]?.instructions ?? '', /Task title: Fix the widget/);
    assert.match(implementation.requests[0]?.instructions ?? '', /Original bounded requirement\./);
    assert.match(implementation.requests[0]?.instructions ?? '', /\[blocking\] the diff has a bug/);
  });

  it('routes only blocking findings to implementation', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const requested: ReviewResult = {
      ...requestChanges(HEAD),
      findings: [
        { severity: 'blocking', summary: 'fix this' },
        { severity: 'non_blocking', summary: 'optional rename' },
      ],
    };
    const reviewer = new FakeReviewer([requested, approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(implementation.requests[0]?.instructions, '1. [blocking] fix this');
  });

  it('resumes the persisted implementation session while fixing review findings', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun(HEAD, 'run-1', 'session-42'));
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(implementation.requests[0]?.sessionId, 'session-42');
  });

  it('resumes the persisted provider-neutral executor while fixing review findings', async () => {
    const store = new MemoryStore();
    let run = reviewingRun();
    run = {
      ...run,
      executor: { provider: 'codex-cli', sessionId: 'thread-42' },
      agentResult: {
        ...run.agentResult!,
        executor: { provider: 'codex-cli', sessionId: 'thread-42' },
      },
    };
    store.create(run);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.deepEqual(implementation.requests[0]?.executor, {
      provider: 'codex-cli',
      sessionId: 'thread-42',
    });
  });

  it('starts an authority-promoted repair with a fresh executor when providers differ', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('fresh-promoted-executor');
    run = {
      ...run,
      repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' },
      executor: { provider: 'worker-router', sessionId: 'legacy-session' },
      agentResult: { ...run.agentResult!, sessionId: 'legacy-session', executor: { provider: 'worker-router', sessionId: 'legacy-session' } },
    };
    store.create(run);
    const implementation = new FakeImplementation([{ ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'promoted-thread' }, sessionId: 'promoted-thread' }]);
    const complex = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 60_000 };

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD2]), implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => complex },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.equal(implementation.requests[0]?.executor, undefined);
    assert.equal(implementation.requests[0]?.sessionId, undefined);
    assert.deepEqual(implementation.requests[0]?.execution, complex);
  });

  it('holds a generationless App Server predecessor before start_fix or worker effects', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('generationless-appserver-admission');
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = { ...run, executor: predecessor, agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId } };
    store.create(run);
    let workerCalls = 0;
    let bootstrapSelections = 0;
    const implementation = new FakeImplementation([{ ...successResult(HEAD2), executor: predecessor, sessionId: predecessor.sessionId }]);
    const outcome = await runReviewLoop({
      store,
      github: githubAdapter([HEAD, HEAD]),
      implementation: {
        kind: 'implementation-agent',
        async run() { workerCalls += 1; return successResult(HEAD2); },
      },
      reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      resolveRepairExecutionProfile: () => ({ ...ROUTINE_REPAIR_EXECUTION, executor: 'codex-cli' }),
      bootstrapForExecution: () => { bootstrapSelections += 1; return undefined; },
    }, run.id, { maxAttempts: 3, now: () => T0 });

    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /App Server identity has no generation/);
    assert.equal(workerCalls, 0);
    assert.equal(bootstrapSelections, 0);
    assert.equal(outcome.run.history.some((event) => event.type === 'start_fix'), false);
    assert.deepEqual(outcome.run.executor, predecessor);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
    assert.equal(implementation.requests.length, 0);
  });

  it('holds a legacy generationless App Server repair when no execution route is persisted', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('legacy-generationless-appserver-review');
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = {
      ...run,
      repairTaskShapeAuthority: undefined,
      execution: undefined,
      executor: predecessor,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
    };
    store.create(run);
    let workerCalls = 0;
    let bootstrapCalls = 0;
    let spawnMarkers = 0;
    const outcome = await runReviewLoop({
      store,
      github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { workerCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      bootstrapForExecution: () => { bootstrapCalls += 1; return undefined; },
    }, run.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { spawnMarkers += 1; } });
    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /App Server identity has no generation/);
    assert.equal(workerCalls, 0);
    assert.equal(bootstrapCalls, 0);
    assert.equal(spawnMarkers, 0);
    assert.equal(outcome.run.history.some((event) => event.type === 'start_fix'), false);
    assert.deepEqual(outcome.run.executor, predecessor);
  });

  it('does not treat an explicit different provider as fresh authority for a result-only App Server identity', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('legacy-result-only-appserver-review');
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = {
      ...run,
      repairTaskShapeAuthority: undefined,
      execution: { ...ROUTINE_REPAIR_EXECUTION, executor: 'claude-code' },
      executor: undefined,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
    };
    store.create(run);
    let workerCalls = 0;
    let bootstrapCalls = 0;
    let spawnMarkers = 0;
    const outcome = await runReviewLoop({
      store,
      github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { workerCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      bootstrapForExecution: () => { bootstrapCalls += 1; return undefined; },
    }, run.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { spawnMarkers += 1; } });
    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /App Server identity has no generation/);
    assert.equal(workerCalls, 0);
    assert.equal(bootstrapCalls, 0);
    assert.equal(spawnMarkers, 0);
    assert.equal(outcome.run.executor, undefined, 'the legacy result-only carrier is preserved without fabricating Run.executor');
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
  });

  it('holds a Run-carried generationless App Server identity despite explicit different-provider execution', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('legacy-run-carrier-different-provider');
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = { ...run, repairTaskShapeAuthority: undefined, execution: { ...ROUTINE_REPAIR_EXECUTION, executor: 'claude-code' }, executor: predecessor,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId } };
    store.create(run);
    let workerCalls = 0; let bootstrapCalls = 0; let spawnMarkers = 0;
    const outcome = await runReviewLoop({
      store, github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { workerCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
      bootstrapForExecution: () => { bootstrapCalls += 1; return undefined; },
    }, run.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { spawnMarkers += 1; } });
    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(workerCalls + bootstrapCalls + spawnMarkers, 0);
    assert.deepEqual(outcome.run.executor, predecessor);
  });

  it('holds a result-only generationless App Server identity when execution is absent', async () => {
    const store = new CasMemoryStore();
    let run = repairChangesRun('legacy-result-carrier-no-execution');
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = { ...run, repairTaskShapeAuthority: undefined, execution: undefined, executor: undefined,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId } };
    store.create(run);
    let workerCalls = 0; let bootstrapCalls = 0; let spawnMarkers = 0;
    const outcome = await runReviewLoop({
      store, github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { workerCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
      bootstrapForExecution: () => { bootstrapCalls += 1; return undefined; },
    }, run.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { spawnMarkers += 1; } });
    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(workerCalls + bootstrapCalls + spawnMarkers, 0);
    assert.equal(outcome.run.executor, undefined);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
  });

  it('requires the exact App Server identity through a logical codex-cli continuation', () => {
    let run = repairChangesRun('same-provider-continuation');
    const prior = { provider: 'codex-app-server', sessionId: 'old-session', generation: 'run-generation' } as const;
    run = { ...run, executor: prior, agentResult: { ...run.agentResult!, sessionId: prior.sessionId, executor: prior } };
    const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: 'codex-cli' };
    const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    assert.equal(binding.freshExecutor, false, 'the established App Server-to-CLI transport remains a compatible continuation');
    assert.equal(binding.runtimeGeneration, prior.generation);
    run = applyTransition(run, {
      type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding },
    }, T0);
    const initialResult: AgentResult = { ...successResult(HEAD2), executor: prior, sessionId: prior.sessionId };
    assert.throws(() => applyTransition(run, {
      type: 'repair_executor_handoff',
      repairAgentResult: { ...initialResult, executor: { ...initialResult.executor!, generation: '' } },
    }, T0), /Repair executor result does not prove the admitted provider identity/);
    run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: initialResult }, T0);
    const continued = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: initialResult }, T0);
    assert.deepEqual(continued.executor, prior);
    assert.equal(continued.history.at(-1)?.type, 'repair_executor_continued');
    const invalidResults: AgentResult[] = [
      { ...initialResult, executor: { provider: 'codex-app-server', sessionId: 'rotated-session', generation: prior.generation }, sessionId: 'rotated-session' },
      { ...initialResult, executor: { provider: 'codex-app-server', sessionId: prior.sessionId }, sessionId: prior.sessionId },
      { ...initialResult, executor: { provider: 'codex-app-server', sessionId: prior.sessionId, generation: 'other-generation' } },
      { ...initialResult, executor: { provider: 'codex-cli', sessionId: prior.sessionId }, sessionId: prior.sessionId },
      { ...initialResult, sessionId: 'legacy-session-drift' },
    ];
    for (const invalid of invalidResults) {
      assert.throws(() => applyTransition(continued, { type: 'repair_executor_continued', repairAgentResult: invalid }, T0),
        /Repair executor result does not prove the admitted provider identity/);
      assert.equal(continued.history.at(-1)?.type, 'repair_executor_continued', 'rejection leaves durable history unchanged');
      assert.deepEqual(continued.executor, prior, 'rejection leaves the predecessor identity unchanged');
    }
    const laterStartFix = {
      ...continued,
      history: [...continued.history, { type: 'start_fix' as const, from: 'CHANGES_REQUESTED' as const, to: 'IMPLEMENTING' as const, at: T0 }],
    };
    assert.throws(() => applyTransition(laterStartFix, { type: 'repair_executor_continued', repairAgentResult: initialResult }, T0),
      /Repair executor result does not prove the admitted provider identity/,
    'same HEAD/PR and timestamp on an older receipt cannot authorize a newer start_fix');
    assert.throws(() => applyTransition({ ...run, repairTaskShapeAuthority: { revision: 'new-authority', shape: 'bounded' } }, {
      type: 'repair_executor_handoff', repairAgentResult: initialResult,
    }, T0), /Repair executor result does not prove the admitted provider identity/);
    assert.throws(() => applyTransition({
      ...run, validationResult: validationFailed(HEAD),
    }, { type: 'repair_executor_handoff', repairAgentResult: initialResult }, T0),
    /Repair executor result does not prove the admitted provider identity/,
    'a review-blocking receipt cannot be replayed for the current validation finding');
    const badRevision = { ...run, repairAdmissions: [{ ...receipt, attemptBinding: binding, executionRevision: 'rewritten' }] };
    assert.throws(() => applyTransition(badRevision, { type: 'repair_executor_handoff', repairAgentResult: initialResult }, T0),
      /Repair executor result does not prove the admitted provider identity/);
  });

  it('accepts a genuinely predecessor-free initial adoption and keeps fresh Luna continuation exact', () => {
    {
      let run = repairChangesRun('repair-without-predecessor');
      const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: 'codex-cli' };
      const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
      const binding = createRepairAttemptBinding(run, execution);
      assert.equal(binding.freshExecutor, false);
      assert.equal(binding.predecessorExecutor, undefined);
      assert.equal(binding.predecessorSessionId, undefined);
      run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
      const adopted: AgentResult = { ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'initial-session' }, sessionId: 'initial-session' };
      run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: adopted }, T0);
      assert.equal(run.executor?.sessionId, 'initial-session');
    }
    {
      let run = repairChangesRun('fresh-luna-continuation-identity');
      const prior = { provider: 'claude-code', sessionId: 'prior-session' } as const;
      run = { ...run, executor: prior, agentResult: { ...run.agentResult!, executor: prior, sessionId: prior.sessionId } };
      const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: 'luna-isolated' };
      const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
      const binding = createRepairAttemptBinding(run, execution);
      assert.equal(binding.freshExecutor, true);
      run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
      const adopted: AgentResult = { ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'luna-session' }, sessionId: 'luna-session' };
      run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: adopted }, T0);
      const rotated: AgentResult = { ...adopted, executor: { provider: 'codex-cli', sessionId: 'restarted-session' }, sessionId: 'restarted-session' };
      assert.throws(() => applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: rotated }, T0),
        /Repair executor result does not prove the admitted provider identity/);
      const continued = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: adopted }, T0);
      assert.equal(continued.executor?.sessionId, 'luna-session');
    }
    {
      let run = repairChangesRun('worker-router-sessionless-repair');
      const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: 'worker-router' };
      const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
      const binding = createRepairAttemptBinding(run, execution);
      run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
      const result = successResult(HEAD2);
      run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: result }, T0);
      const continued = applyTransition(run, { type: 'repair_executor_continued', repairAgentResult: result }, T0);
      assert.equal(continued.executor, undefined);
      assert.equal(continued.history.at(-1)?.repairHandoff?.outcome.kind, 'sessionless');
    }
  });

  it('requires a nonfresh predecessor generation to remain absent when it was absent at admission', () => {
    let run = repairChangesRun('repair-generation-presence');
    const prior = { provider: 'claude-code', sessionId: 'same-session' } as const;
    run = { ...run, executor: prior, agentResult: { ...run.agentResult!, executor: prior, sessionId: prior.sessionId } };
    const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: 'claude-code' };
    const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
    const addedGeneration: AgentResult = {
      ...successResult(HEAD2), executor: { ...prior, generation: 'introduced-generation' }, sessionId: prior.sessionId,
    };
    assert.throws(() => applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: addedGeneration }, T0),
      /Repair executor result does not prove the admitted provider identity/);
    assert.equal(run.executor?.generation, undefined);
    assert.equal(run.history.at(-1)?.type, 'start_fix');
  });

  it('rejects a forged or missing captured predecessor before authorizing start_fix', () => {
    for (const alter of [
      (binding: NonNullable<ReturnType<typeof createRepairAttemptBinding>>) => ({ ...binding, predecessorExecutor: { provider: 'codex-cli', sessionId: 'forged' } }),
      (binding: NonNullable<ReturnType<typeof createRepairAttemptBinding>>) => ({ ...binding, predecessorExecutor: undefined }),
      (binding: NonNullable<ReturnType<typeof createRepairAttemptBinding>>) => ({ ...binding, predecessorSessionId: 'forged-session' }),
      (binding: NonNullable<ReturnType<typeof createRepairAttemptBinding>>) => ({ ...binding, predecessorSessionId: undefined }),
    ]) {
      let run = repairChangesRun('forged-repair-predecessor');
      const prior = { provider: 'claude-code', sessionId: 'durable-predecessor' } as const;
      run = { ...run, executor: prior, agentResult: { ...run.agentResult!, executor: prior, sessionId: prior.sessionId } };
      const execution = ROUTINE_REPAIR_EXECUTION;
      const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
      const binding = alter(createRepairAttemptBinding(run, execution));
      assert.throws(() => applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0),
        /Repair admission must match current authority/);
    }
  });

  it('plans and prepares a standalone workspace for a promoted existing-PR Luna repair', async () => {
    const store = new CasMemoryStore();
    const run = repairChangesRun('promoted-luna-existing-pr');
    store.create(run);
    const luna: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
    };
    const identity: ImplementationBootstrapIdentity = {
      bootstrapKind: 'standalone-isolated', owner: 'acme', repo: 'widgets', issueNumber: 42,
      baseBranch: 'main', baseSha: 'base', branch: 'tachiko/promoted-luna-existing-pr', publicationBranch: 'existing-pr', workspacePath: '/tmp/promoted-luna',
    };
    const planned: unknown[] = [];
    const prepared: unknown[] = [];
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
      async plan(request) { planned.push(request); return identity; },
      async prepare(request) { prepared.push(request); return identity; },
      guard() { return { assertValid: () => undefined }; },
      async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: identity.branch }; },
    };
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD2]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, pullRequest: { ...live.pullRequest!, headRef: 'existing-pr', baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' } } };
    };
    const implementation = new FakeImplementation([{ ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'fresh-luna-thread' }, sessionId: 'fresh-luna-thread' }]);

    const result = await runReviewLoop(
      { store, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna, governedPublicationRequired: true },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.deepEqual(planned, [{ runId: run.id, target: TARGET, baseBranch: 'main', baseSha: 'base', publicationBranch: 'existing-pr' }]);
    assert.deepEqual((prepared[0] as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
    assert.equal(implementation.requests[0]?.workspacePath, identity.workspacePath);
    assert.equal(implementation.requests[0]?.branch, identity.branch);
    assert.equal(implementation.preflightRequests[0]?.workspacePath, implementation.requests[0]?.workspacePath);
    assert.equal(implementation.preflightRequests[0]?.branch, implementation.requests[0]?.branch);
    assert.equal(implementation.preflightRequests[0]?.workspaceGuard, implementation.requests[0]?.workspaceGuard,
      'repair preflight and implementation share the same prepared guard object');
    assert.equal(store.read(run.id)?.bootstrap?.bootstrapKind, 'standalone-isolated');
  });

  it('fences standalone review-fix publication after awaited Git checks', async (t) => {
    for (const mode of ['run-changed', 'publication-stale', 'current'] as const) {
      await t.test(mode, async () => {
        const fixture = createBootstrapGitFixture();
        try {
          const id = `review-fix-publish-${mode}`;
          const store = new CasMemoryStore();
          let shouldChangeRun = false;
          let concurrent: Run | undefined;
          const runner: ProcessRunner = {
            async run(file, args, options) {
              if (shouldChangeRun && args.includes('ls-remote') && args.includes('--heads')) {
                shouldChangeRun = false;
                const before = store.read(id)!;
                concurrent = applyTransition(before, {
                  type: 'escalate', reason: 'Operator cancellation during standalone pre-push Git checks',
                  interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
                }, T0);
                store.update(concurrent);
              }
              return fixture.runner.run(file, args, options);
            },
          };
          const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
          const luna: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000 };
          const identity = await bootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
          const initial = { ...reviewingRun(fixture.baseSha, id, undefined, luna), bootstrap: identity };
          store.create(initial);
          let repairedHead: string | undefined;
          const implementation: ImplementationAgent = {
            kind: 'implementation-agent',
            async run(request) {
              repairedHead = fixture.commit(request.workspacePath!, 'review-fix.txt', 'review repair\n');
              shouldChangeRun = mode === 'run-changed';
              return successResult(repairedHead);
            },
          };
          const heads = [fixture.baseSha, fixture.baseSha, fixture.baseSha, fixture.baseSha];
          const github = githubAdapter(heads);
          github.readLiveSnapshot = async () => {
            const live = snapshot(heads.shift() ?? repairedHead ?? fixture.baseSha);
            return {
              ...live,
              pullRequest: live.pullRequest === null ? null : {
                ...live.pullRequest,
                headRef: identity.publicationBranch ?? identity.branch,
                baseRef: fixture.branch,
                headRepository: { owner: 'acme', repo: 'widgets' },
              },
            };
          };
          const reviewer = new FakeReviewer([requestChanges(fixture.baseSha)]);
          let mutationChecks = 0;
          let publicationChecks = 0;
          const commandStart = fixture.commands.length;
          const result = await runReviewLoop({
            store, github, implementation, reviewer, resolveValidationAuthority: reviewAuthority,
            bootstrapForExecution: () => bootstrap,
            assertCurrentMutation: () => { mutationChecks += 1; },
            assertCanPublish: () => {
              publicationChecks += 1;
              if (mode === 'publication-stale') throw new Error('publication admission became stale');
            },
          }, id, { maxAttempts: 3, now: () => T0 });

          const published = fixture.git(fixture.remote, ['for-each-ref', `refs/heads/${identity.publicationBranch ?? identity.branch}`]);
          if (mode === 'run-changed') {
            assert.equal(result.outcome, 'needs_human');
            assert.deepEqual(store.read(id), concurrent, 'the changed Run survives the pre-push CAS');
            assert.equal(published, '', 'the standalone repair is not pushed after its Run becomes stale');
            assert.equal(publicationChecks, 0, 'publication authority is not consulted after the Run CAS rejects');
          } else if (mode === 'publication-stale') {
            assert.equal(result.outcome, 'needs_human');
            assert.equal(result.run.state, 'NEEDS_HUMAN', 'stale publication authority leaves a durable safe park');
            assert.equal(store.read(id)?.state, 'NEEDS_HUMAN');
            assert.equal(published, '', 'the standalone repair is not pushed when publication admission rejects');
            assert.equal(fixture.commands.slice(commandStart).filter((command) => command.args.includes('push')).length, 0, 'no host push runs after publication admission rejects');
            assert.equal(publicationChecks, 1, 'publication admission is rechecked after the awaited Git work');
          } else {
            assert.equal(result.outcome, 'revalidating');
            assert.equal(store.read(id)?.headSha, repairedHead);
            assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.publicationBranch ?? identity.branch}`]), repairedHead);
            assert.equal(publicationChecks, 1, 'the valid standalone repair checks publication authority immediately before push');
            assert.ok(mutationChecks >= 2, 'mutation authority is checked before execution and again before push');
          }
        } finally {
          fixture.cleanup();
        }
      });
    }
  });

  it('blocks repair invocation when start_fix or the final pre-worker CAS loses', async (t) => {
    for (const [label, rejectAt] of [['start_fix', 2], ['final_pre_worker', 5]] as const) {
      await t.test(label, async () => {
        const initial = repairChangesRun(`pre-worker-${label}-race`);
        const store = new SpawnRaceStore(rejectAt, (expected) => applyTransition(expected,
          { type: 'escalate', reason: `concurrent decision at ${label}`,
            interrupt: { evidence: `winner-${label}`, choices: ['Cancel the run'] } }, T0));
        store.create(initial);
        let executionMarkers = 0;
        let capabilityResolutions = 0;
        const implementation = new FakeImplementation([successResult(HEAD2)]);
        const reviewer = new FakeReviewer([]);
        const result = await runReviewLoop({
          store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority,
          resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
          resolveImplementationCapabilities: async () => { capabilityResolutions += 1; return []; },
        }, initial.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { executionMarkers += 1; } });

        assert.equal(result.outcome, 'superseded');
        assert.deepEqual(store.read(initial.id), result.run);
        assert.equal(result.run.state, 'NEEDS_HUMAN');
        assert.equal(implementation.requests.length, 0);
        assert.equal(reviewer.requests.length, 0);
        if (label === 'start_fix') {
          assert.equal(capabilityResolutions, 0, 'a lost start_fix CAS blocks all later preflight');
          assert.equal(executionMarkers, 0);
        } else {
          assert.equal(capabilityResolutions, 1, 'capability discovery may finish before the final fence');
          assert.equal(executionMarkers, 1, 'the execution uncertainty marker precedes the final CAS fence');
        }
      });
    }
  });

  it('durably holds governed review repairs before worker telemetry or ambient provider execution', async () => {
    for (const repairKind of ['review', 'validation'] as const) {
      for (const provider of ['codex-cli', 'codex-app-server', 'claude-code', 'worker-router'] as const) {
      const id = `governed-${repairKind}-${provider}`;
      const base = repairKind === 'review'
        ? repairChangesRun(id)
        : (() => {
          let run = createRun(TARGET, T0, id);
          run = applyTransition(run, { type: 'start' }, T0);
          run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD, pullRequest: { number: 7, headSha: HEAD } }, T0);
          return applyTransition(run, { type: 'validation_failed', validationResult: validationFailed(HEAD) }, T0, reviewAuthority());
        })();
      const execution: ResolvedExecutionConfiguration = { ...ROUTINE_REPAIR_EXECUTION, executor: provider };
      const sessionId = `session-${provider}`;
      const original: Run = {
        ...base,
        executor: { provider, sessionId: `thread-${provider}` },
        agentResult: { ...base.agentResult!, sessionId },
      };
      const store = new CasMemoryStore();
      store.create(original);
      let childOrModelCalls = 0;
      let fallbackCalls = 0;
      const ambient: ImplementationAgent = {
        kind: 'implementation-agent',
        async run() { childOrModelCalls += 1; fallbackCalls += provider === 'codex-app-server' ? 1 : 0; return successResult(HEAD2); },
      };
      const implementation = new ImplementationAgentRegistry({
        defaultProvider: 'codex-cli',
        legacySessionProvider: 'claude-code',
        providers: { [provider]: () => provider === 'worker-router' ? new WorkerRouterAdapter({ env: {} }) : ambient },
      });
      let capabilityResolutions = 0;
      let spawnMarkers = 0;
      const result = await runReviewLoop({
        store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority,
        resolveImplementationCapabilities: async () => { capabilityResolutions += 1; return []; },
        resolveRepairExecutionProfile: () => execution,
        governedPublicationRequired: true,
      }, id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { spawnMarkers += 1; } });

      assert.equal(result.outcome, 'needs_human', `${provider} must fail closed before a model or child process`);
      assert.match(result.reason, /No model turn or worker process was started/);
      assert.match(result.run.interrupt?.reason ?? '', /source-qualified publication boundary/);
      assert.equal(childOrModelCalls, 0);
      assert.equal(fallbackCalls, 0, 'App Server fallback is not entered during governed preflight');
      assert.equal(capabilityResolutions, 0, 'preflight precedes capability lookup');
      assert.equal(spawnMarkers, 0, 'preflight hold precedes worker uncertainty telemetry');
      assert.deepEqual(result.run.executor, original.executor, 'the exact executor remains on the held Run');
      assert.equal(result.run.agentResult?.sessionId, sessionId, 'the exact session remains on the held Run');
      assert.equal(store.read(id)?.id, original.id, 'the same durable Run remains parked');
      assert.equal((result.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
      }
    }
  });

  it('rejects a forged qualified repair adapter before spawn telemetry', async () => {
    const original = repairChangesRun('governed-review-forged-preflight');
    const store = new CasMemoryStore();
    store.create(original);
    let modelCalls = 0;
    let markers = 0;
    const forged: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation() {
        return { status: 'qualified', agent: { kind: 'implementation-agent', async run() { modelCalls += 1; return successResult(HEAD2); } } as ImplementationAgent };
      },
      async run() { modelCalls += 1; return successResult(HEAD2); },
    };
    const result = await runReviewLoop({
      store, github: githubAdapter([HEAD, HEAD]), implementation: forged, reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
      governedPublicationRequired: true,
    }, original.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { markers += 1; } });
    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /source-qualified publication boundary/);
    assert.equal(modelCalls, 0);
    assert.equal(markers, 0);
    assert.equal((result.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('rechecks mutation admission after capability resolution and before a repair worker starts', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-repair-fence-'));
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'review-repair-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const workspace = path.join(directory, 'workspace');
    mkdirSync(workspace);
    const admitted = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, workspace } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') return;
    try {
      const run = repairChangesRun('stale-repair-fence');
      const store = new CasMemoryStore();
      store.create(run);
      const implementation = new FakeImplementation([successResult(HEAD2)]);
      const reviewer = new FakeReviewer([]);
      let capabilityResolutions = 0;
      let executionMarkers = 0;
      let publications = 0;
      const github: GitHubAdapter = {
        ...githubAdapter([HEAD, HEAD, HEAD]),
        async createImplementationPullRequest() { publications += 1; return { number: 8 }; },
      };

      await assert.rejects(runReviewLoop(
        {
          store, github, implementation, reviewer, resolveValidationAuthority: reviewAuthority,
          resolveImplementationCapabilities: async () => { capabilityResolutions += 1; return []; },
          resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
          assertCanMutate: () => registry.assertCanMutate(admitted.token),
          assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
        },
        run.id,
        {
          maxAttempts: 3,
          now: () => T0,
          // Simulate the host losing this generation after the persisted
          // initial implementation/review, at the uncertainty marker.
          onExecutionStart: () => { executionMarkers += 1; registry.release(admitted.token, true); },
        },
      ), /Admission generation token is stale/);
      assert.equal(capabilityResolutions, 1, 'non-mutating capability resolution precedes the final fence');
      assert.equal(executionMarkers, 1, 'the marker does not itself grant authority');
      assert.equal(implementation.requests.length, 0, 'stale ownership prevents the repair worker from starting');
      assert.equal(reviewer.requests.length, 0);
      assert.equal(publications, 0, 'no repair publication can follow the rejected worker boundary');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves a concurrent NEEDS_HUMAN Run written while repair capabilities resolve', async () => {
    const original = repairChangesRun('repair-capability-run-race');
    const store = new CasMemoryStore();
    store.create(original);
    const implementation = new FakeImplementation([successResult(HEAD2)]);
    const concurrent = applyTransition(original, {
      type: 'escalate', reason: 'Concurrent cancellation review',
      interrupt: { evidence: 'Cancel the Run', choices: ['Cancel the run'] },
    }, T0);
    let markers = 0;
    const result = await runReviewLoop({
      store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      resolveImplementationCapabilities: async () => {
        store.update(concurrent);
        return [];
      },
      resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
    }, original.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { markers += 1; } });
    assert.equal(result.outcome, 'superseded');
    assert.equal(implementation.requests.length, 0);
    assert.equal(result.run.interrupt?.reason, concurrent.interrupt?.reason);
    assert.equal(JSON.stringify(store.read(original.id)), JSON.stringify(concurrent), 'stale reconciliation must preserve the concurrent cancel decision');
    assert.equal(markers, 1, 'the uncertainty marker occurs after preflight but before final Run CAS');
  });

  it('releases a preflight-overlap repair lane when no worker or uncertainty marker began', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-overlap-release-'));
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'review-overlap-release-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
    });
    const blocker = registry.admit({ laneId: 'workspace-blocker', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 9, workspace: '/tmp/review-overlap' } });
    const owner = registry.admit({ laneId: 'repair-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42 } });
    assert.equal(blocker.outcome, 'admitted');
    assert.equal(owner.outcome, 'admitted');
    if (owner.outcome !== 'admitted') return;
    try {
      const original = repairChangesRun('repair-overlap-preflight');
      const store = new CasMemoryStore();
      store.create(original);
      const implementation = new FakeImplementation([]);
      let markers = 0;
      await assert.rejects(runReviewLoop({
        store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority,
        resolveImplementationCapabilities: async () => [],
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
        assertCanMutate: () => registry.strengthen(owner.token, { repository: 'acme/widgets', issue: 42, workspace: '/tmp/review-overlap' }),
        assertCurrentMutation: () => registry.assertCanMutate(owner.token),
      }, original.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => { markers += 1; } }), /overlaps reserved lane/);
      assert.equal(implementation.requests.length, 0);
      assert.equal(markers, 0, 'overlap is detected before execution uncertainty is recorded');
      assert.equal(registry.readLane(owner.token.laneId)?.status, 'active');
      registry.release(owner.token, true);
      assert.equal(registry.readLane(owner.token.laneId)?.status, 'released', 'the host can release a provably pre-execution lane');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves the exact CAS winner after repair worker success, throw, or publication fence and stops later verification', async (t) => {
    for (const mode of ['success', 'failure', 'publication'] as const) {
      await t.test(mode, async () => {
        const original = repairChangesRun(`repair-worker-${mode}-race`);
        const store = new CasMemoryStore();
        store.create(original);
        let concurrent: Run | undefined;
        let pushes = 0;
        const github = githubAdapter([HEAD, HEAD, HEAD, HEAD]);
        let liveReads = 0;
        const readLiveSnapshot = github.readLiveSnapshot.bind(github);
        github.readLiveSnapshot = async (target) => { liveReads += 1; return readLiveSnapshot(target); };
        const implementation = {
          kind: 'implementation-agent' as const,
          async run(request: ImplementationRequest) {
            const current = store.read(original.id)!;
            concurrent = applyTransition(current, {
              type: 'escalate', reason: `Concurrent human decision during ${mode} worker`,
              interrupt: { evidence: `concurrent-${mode}`, choices: ['Cancel the run'] },
            }, T0);
            store.update(concurrent);
            if (mode === 'failure') throw new Error('synthetic worker invocation failure');
            if (mode === 'publication') {
              request.beforePublish?.();
              pushes += 1;
            }
            return successResult(HEAD2);
          },
        };
        const result = await runReviewLoop({
          store, github, implementation, reviewer: new FakeReviewer([]),
          resolveValidationAuthority: reviewAuthority,
          resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
        }, original.id, { maxAttempts: 3, now: () => T0 });
        assert.equal(result.outcome, 'superseded');
        assert.deepEqual(result.run, concurrent);
        assert.equal(JSON.stringify(store.read(original.id)), JSON.stringify(concurrent), 'worker spawn telemetry and the concurrent decision remain unchanged');
        assert.equal(concurrent?.telemetry?.events.filter((event) => event.kind === 'spawn' && event.role === 'worker').length, 1);
        assert.equal(concurrent?.telemetry?.events.filter((event) => event.kind === 'completion').length, 0, 'completion telemetry from a stale worker is not persisted');
        assert.equal(pushes, 0, 'publication is rejected before the simulated push');
        assert.equal(liveReads, 2, 'the repair loop does not proceed to post-worker GitHub verification');
      });
    }
  });

  it('parks decision-shaped authority with only a terminal choice', async () => {
    const store = new MemoryStore();
    const run = { ...repairChangesRun('decision-authority'), repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'decision' as const } };
    store.create(run);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(result.run.interrupt?.choices, ['Cancel the run']);
    assert.equal(implementation.requests.length, 0);
  });

  it('returns the fixed HEAD to VALIDATING before a second review can consume the attempt budget', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), requestChanges(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.equal(result.run.state, 'VALIDATING');
    assert.equal(implementation.requests.length, 1);
  });

  it('derives the attempt budget from persisted history after re-entry', async () => {
    const store = new MemoryStore();
    const requested = requestChanges(HEAD);
    const interrupted = applyTransition(
      reviewingRun(),
      { type: 'changes_requested', reviewResult: requested },
      T0,
      reviewAuthority(),
    );
    store.create(interrupted);
    const reviewer = new FakeReviewer([]);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /did not converge after 1 attempt/);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(implementation.requests.length, 0);
  });

  it('starts a fresh bounded attempt window after an explicit human retry', async () => {
    const store = new MemoryStore();
    let run = applyTransition(
      reviewingRun(),
      { type: 'changes_requested', reviewResult: requestChanges(HEAD) },
      T0,
      reviewAuthority(),
    );
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'attempt limit',
        interrupt: { choices: ['Provide more GitHub context and retry', 'Cancel the run'] },
      },
      T0,
    );
    run = applyTransition(run, { type: 'human_resolved', reason: 'Provide more GitHub context and retry' }, T0);
    store.create(run);
    const reviewer = new FakeReviewer([approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.equal(result.run.state, 'VALIDATING');
    assert.equal(implementation.requests.length, 1);
  });

  it('resumes a persisted CHANGES_REQUESTED run by fixing before re-reviewing', async () => {
    const store = new MemoryStore();
    const execution: ResolvedExecutionConfiguration = {
      profile: 'standard', revision: 'profiles-v1', executor: 'worker-router', timeoutMs: 60_000,
    };
    const requested = requestChanges(HEAD);
    store.create(applyTransition(reviewingRun(HEAD, 'run-1', undefined, execution), { type: 'changes_requested', reviewResult: requested }, T0, reviewAuthority()));
    const reviewer = new FakeReviewer([approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.equal(result.run.state, 'VALIDATING');
    assert.equal(implementation.requests[0]?.baseSha, HEAD);
    assert.deepEqual(implementation.requests[0]?.execution, execution);
    assert.deepEqual(reviewer.requests.map((reviewRequest) => reviewRequest.headSha), []);
  });

  it('reports unsupported CAS without writing or calling a writer or reviewer', async () => {
    const backing = new MemoryStore();
    let explicitWrites = 0;
    const store: RunStore = {
      name: 'no-cas', create: (run) => backing.create(run), read: (id) => backing.read(id),
      update: (run) => { explicitWrites += 1; backing.update(run); }, list: () => backing.list(), delete: (id) => backing.delete(id),
    };
    const run = repairChangesRun('repair-no-cas');
    store.create(run);
    const writesBeforeAdmission = explicitWrites;
    const concurrent = applyTransition(run, {
      type: 'escalate', reason: 'concurrent human hold',
      interrupt: { evidence: 'concurrent human hold', choices: ['Resolve identity'] },
    }, T0);
    let liveReads = 0;
    const github = githubAdapter([HEAD]);
    github.readLiveSnapshot = async (target) => {
      liveReads += 1;
      backing.update(concurrent); // Simulate a concurrent durable writer while preflight is awaited.
      return await githubAdapter([HEAD]).readLiveSnapshot(target);
    };
    let workerEffects = 0;
    let publicationEffects = 0;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request) {
        workerEffects += 1;
        if (request.beforePublish !== undefined) { request.beforePublish(); publicationEffects += 1; }
        return successResult(HEAD2);
      },
    };
    const reviewer = new FakeReviewer([]);

    const result = await runReviewLoop(
      { store, github, implementation, reviewer, resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'unsupported_cas');
    assert.deepEqual(result.run, concurrent);
    assert.deepEqual(store.read(run.id), concurrent);
    assert.equal(concurrent.state, 'NEEDS_HUMAN');
    assert.equal(liveReads, 1);
    assert.equal(explicitWrites, writesBeforeAdmission, 'unsupported CAS performs no write through the adapter');
    assert.match(result.reason, /compare-and-swap is unavailable/);
    assert.equal(workerEffects, 0);
    assert.equal(publicationEffects, 0);
    assert.equal(reviewer.requests.length, 0);
  });

  it('returns a bounded superseded result for concurrent repair admission winners without changing them', async (t) => {
    const makeWinners = (id: string): Array<[string, Run]> => {
      const base = repairChangesRun(id);
      const waiting = applyTransition(base, { type: 'wait_dependency', interrupt: { evidence: 'external dependency', choices: ['Retry'] } }, T0);
      let mergeReady = reviewingRun(HEAD, id);
      mergeReady = applyTransition(mergeReady, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, reviewAuthority());
      mergeReady = { ...mergeReady, state: 'MERGE_READY', history: [...mergeReady.history,
        { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
      const merged = applyTransition(mergeReady, { type: 'merged' }, T0);
      const failed = applyTransition(base, { type: 'fail', reason: 'concurrent failure' }, T0);
      const admission = createRepairAdmissionSnapshot(base.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, ROUTINE_REPAIR_EXECUTION, T0);
      const binding = createRepairAttemptBinding(base, ROUTINE_REPAIR_EXECUTION);
      let active = applyTransition(base, { type: 'start_fix', repairAdmission: { ...admission, attemptBinding: binding } }, T0);
      const activeResult = { ...successResult(HEAD2), executor: { provider: 'codex-app-server', sessionId: 'winner-session', generation: binding.runtimeGeneration }, sessionId: 'winner-session' };
      active = applyTransition(active, { type: 'repair_executor_handoff', repairAgentResult: activeResult }, T0);
      return [
        ['waiting dependency', waiting],
        ['merge ready', mergeReady],
        ['merged', merged],
        ['failed', failed],
        ['changed active repair attempt, executor, and history', active],
      ];
    };
    for (const [label] of makeWinners('repair-cas-winner')) {
      await t.test(label, async () => {
        const id = `repair-cas-${label.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`;
        const run = repairChangesRun(id);
        const [, concurrent] = makeWinners(run.id).find(([candidate]) => candidate === label)!;
        const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-cas-winner-'));
        try {
          const fixtureStore = new JsonFileStore({ dir: fixtureDir });
          fixtureStore.create(concurrent);
          assert.equal(JSON.stringify(new JsonFileStore({ dir: fixtureDir }).read(id)), JSON.stringify(concurrent),
            'the synthetic race winner is a valid durable Run fixture');
        } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
        const store = new CasMemoryStore();
        store.create(run);
        const implementation = new FakeImplementation([]);
        const reviewer = new FakeReviewer([]);
        const github = githubAdapter([HEAD]);
        github.readLiveSnapshot = async () => {
          store.update(concurrent);
          return snapshot(HEAD);
        };

        const result = await runReviewLoop(
          { store, github, implementation, reviewer, resolveValidationAuthority: reviewAuthority,
            resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
          run.id, { maxAttempts: 3, now: () => T0 },
        );

        assert.equal(result.outcome, 'superseded');
        assert.match(result.reason, /preserved/);
        assert.deepEqual(result.run, concurrent);
        assert.equal(JSON.stringify(store.read(run.id)), JSON.stringify(concurrent), 'the newer winner remains structurally unchanged');
        assert.equal(store.casCalls, 1, 'the pending GitHub read causes one failed CAS and no retry');
        assert.equal(store.casSuccesses, 0);
        assert.equal(implementation.requests.length, 0);
        assert.equal(reviewer.requests.length, 0);
      });
    }
  });

  it('terminates an always-rejecting repair CAS without writes or effects', async () => {
    const run = repairChangesRun('repair-cas-always-reject');
    let casCalls = 0;
    let updateCalls = 0;
    const store: RunStore = {
      name: 'always-reject-cas',
      create() {},
      read: () => run,
      update() { updateCalls += 1; },
      updateIfUnchanged() { casCalls += 1; return false; },
      list: () => [run], delete() {},
    };
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);
    const result = await runReviewLoop({ store, github: githubAdapter([HEAD]), implementation, reviewer,
      resolveValidationAuthority: reviewAuthority, resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
    run.id, { maxAttempts: 3, now: () => T0 });
    assert.equal(result.outcome, 'superseded');
    assert.equal(casCalls, 1);
    assert.equal(updateCalls, 0);
    assert.deepEqual(result.run, run);
    assert.equal(implementation.requests.length, 0);
    assert.equal(reviewer.requests.length, 0);
  });

  it('turns retryable and fatal reviewer failures into durable outcomes', async () => {
    const retryStore = new MemoryStore();
    retryStore.create(reviewingRun(HEAD, 'retry-run'));
    const retryable = new ReviewerError('REVIEW_API_FAILED', 'rate limited', { retryable: true });
    const retryResult = await runReviewLoop(
      {
        store: retryStore,
        github: githubAdapter([HEAD]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([retryable]),
        resolveValidationAuthority: reviewAuthority,
      },
      'retry-run',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(retryResult.outcome, 'needs_human');
    assert.equal(retryResult.run.state, 'NEEDS_HUMAN');
    assert.match(retryResult.reason, /REVIEW_API_FAILED/);

    const fatalStore = new MemoryStore();
    fatalStore.create(reviewingRun(HEAD, 'fatal-run'));
    const fatal = new ReviewerError('REVIEW_INVALID_OUTPUT', 'bad JSON');
    const fatalResult = await runReviewLoop(
      {
        store: fatalStore,
        github: githubAdapter([HEAD]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([fatal]),
        resolveValidationAuthority: reviewAuthority,
      },
      'fatal-run',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(fatalResult.outcome, 'failed');
    assert.equal(fatalResult.run.state, 'FAILED');
    assert.match(fatalResult.reason, /REVIEW_INVALID_OUTPUT/);
  });

  it('fails the run when the implementation cannot fix the findings', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-failure-'));
    try {
      const store = new JsonFileStore({ dir });
      const run = reviewingRun();
      store.create(run);
      const reviewer = new FakeReviewer([requestChanges(HEAD)]);
      const implementation = new FakeImplementation([{ ...failureResult('agent crashed'), headSha: HEAD2 }]);

      const result = await runReviewLoop(
        { store, github: githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
        run.id,
        { maxAttempts: 3, now: () => T0 },
      );

      assert.equal(result.outcome, 'failed');
      assert.equal(result.run.state, 'FAILED');
      assert.equal(result.run.headSha, HEAD);
      assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD });
      const persisted = new JsonFileStore({ dir }).read(run.id);
      assert.equal(persisted?.state, 'FAILED');
      assert.equal(persisted?.headSha, HEAD);
      assert.deepEqual(persisted?.pullRequest, { number: 7, headSha: HEAD });
      assert.equal(persisted?.agentResult?.headSha, HEAD2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parks in NEEDS_HUMAN when a review fix emits the explicit takeover protocol', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD)]);
    const implementation = new FakeImplementation([
      {
        exitStatus: 'failure',
        summary: '2FA required',
        diagnostics: ['TACHIKO_NEEDS_HUMAN: 2FA required'],
        executor: { provider: 'codex-cli', sessionId: 'thread-fix' },
      },
    ]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(result.run.interrupt?.reason, '2FA required');
    assert.deepEqual(result.run.executor, { provider: 'codex-cli', sessionId: 'thread-fix' });
  });

  it('escalates to NEEDS_HUMAN when the live GitHub HEAD drifts from the run HEAD', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD2]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /does not match the run HEAD/);
    assert.equal(reviewer.requests.length, 0);
  });

  it('escalates to NEEDS_HUMAN when no live PR HEAD exists', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([null]), implementation, reviewer, resolveValidationAuthority: reviewAuthority },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /No live PR HEAD/);
    assert.deepEqual(result.run.interrupt?.choices, [
      'Open the implementation pull request and retry',
      'Cancel the run',
    ]);
  });
});
