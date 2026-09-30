import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import { ExecutionAdmissionRefusal, isExecutionAdmissionRefusal } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { WorkerRouterAdapter } from '../src/agents/worker-router.js';
import type { ContainerWorkerExecution, WorkerContainerSpec } from '../src/agents/worker-router-container.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition, type ActiveValidationConfiguration } from '../src/domain/state-machine.js';
import { activeRepairAdmission, createRepairAdmissionSnapshot, createRepairAttemptBinding } from '../src/domain/repair-admission.js';
import type { RunTelemetryCompletionEvent, RunTelemetrySpawnEvent } from '../src/domain/telemetry.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import type { AgentResult, ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import { ReviewerError } from '../src/reviewers/deepseek.js';
import { runReviewLoop, type ReviewLoopDependencies, type ReviewLoopResult } from '../src/reviewers/loop.js';
import { canonicalizeMissionEvidence, MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { operationalProjectionPath } from '../src/operational/projection.js';
import { TARGET, failureResult, successResult, validationFailed, validationPassed } from './helpers.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';
import { createGenuineLunaFixture } from './support/genuine-luna.js';

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

function persistedJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    handoff: { sourceId: 'IC_test-scope', sourceScope: 'issue', sourceUpdatedAt: T0,
      sections: { 'Accepted scope': 'Test scope for isolated worker tests.' }, freshness: 'current' },
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
    packet: ImplementationRequest['packet'];
    workspacePath: string | undefined;
    branch: string | undefined;
    workspaceGuard: ImplementationRequest['workspaceGuard'];
  }> = [];

  constructor(private readonly outcomes: AgentResult[]) {}

  prepareGovernedInvocation(request: ImplementationRequest) {
    this.preflightRequests.push(request);
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
      packet: request.packet,
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

    assert.equal(result.outcome, 'superseded');
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

    assert.equal(result.outcome, 'superseded', 'a stale approval returns the explicit CAS-winner outcome');
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

    assert.equal(result.outcome, 'superseded');
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
        agentResult: { ...successResult(HEAD), sessionId: 'thread-validation', executor: { provider: 'codex-cli', sessionId: 'thread-validation' } },
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
      assert.equal(implementation.requests[0]?.sessionId, 'thread-validation');
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

  it('plans and prepares a standalone workspace for ungoverned promoted existing-PR Luna repair planning', async () => {
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
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating', 'Luna repair packet should pass bounded admission: ' + ('reason' in result ? result.reason : ''));
    assert.equal(planned.length, 1);
    assert.deepEqual({
      runId: (planned[0] as { runId: string }).runId,
      target: (planned[0] as { target: unknown }).target,
      baseBranch: (planned[0] as { baseBranch: string }).baseBranch,
      baseSha: (planned[0] as { baseSha: string }).baseSha,
      publicationBranch: (planned[0] as { publicationBranch?: string }).publicationBranch,
    }, { runId: run.id, target: TARGET, baseBranch: 'main', baseSha: 'base', publicationBranch: 'existing-pr' });
    assert.equal(typeof (planned[0] as { beforeMutation?: unknown }).beforeMutation, 'function');
    assert.deepEqual((prepared[0] as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
    assert.equal(implementation.requests[0]?.workspacePath, identity.workspacePath);
    assert.equal(implementation.requests[0]?.branch, identity.branch);
    assert.equal(implementation.requests[0]?.packet?.kind, 'review-repair');
    assert.equal(store.read(run.id)?.bootstrap?.bootstrapKind, 'standalone-isolated');
  });

  it('refuses an oversized Luna repair packet before spending a repair attempt or preparing a workspace', async () => {
    const store = new CasMemoryStore();
    const run = repairChangesRun('luna-oversized-repair-packet');
    store.create(run);
    const luna: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
    };
    let prepared = 0;
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
      async plan() { throw new Error('oversized packet must refuse before workspace planning'); },
      async prepare() { prepared += 1; throw new Error('oversized packet must refuse before workspace preparation'); },
      guard() { return { assertValid: () => undefined }; },
      async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: 'unused' }; },
    };
    const github = githubAdapter([HEAD, HEAD]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, issue: { ...live.issue, body: 'x'.repeat(32 * 1024 + 1) } };
    };
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.history.some((record) => record.type === 'start_fix'), false);
    assert.equal(prepared, 0);
    assert.equal(implementation.requests.length, 0);
  });

  it('strengthens a workspace-less repair lane from the read-only plan before the real preparation fetch', async () => {
    const fixture = createBootstrapGitFixture();
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-plan-workspace-strengthening-'));
    try {
      const id = 'repair-plan-workspace-strengthening';
      const luna: ResolvedExecutionConfiguration = {
        profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      };
      const identityPlan = { runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'existing-pr' };
      const plannedIdentity = await new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner }).plan(identityPlan);
      const store = new CasMemoryStore();
      const expected = applyTransition({
        ...reviewingRun(fixture.baseSha, id, undefined, luna),
        repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
      }, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
      store.create(expected);
      const registry = new MissionAdmissionRegistry({
        filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: 'repair-plan-workspace-strengthening-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
      });
      const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', evidence: {
        repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id,
      } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      assert.equal(registry.readLane(admitted.token.laneId)?.evidence.workspace, undefined);

      let prepareFetches = 0;
      let completedPrepareFetches = 0;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          let index = 0;
          while (args[index] === '-c') index += 2;
          const gitArgs = args.slice(index);
          const immutableBaseFetch = file === 'git' && gitArgs[0] === 'fetch' && gitArgs.includes('origin') && gitArgs.at(-1) === fixture.baseSha;
          if (immutableBaseFetch && options.beforeSpawn !== undefined) {
            const beforeSpawn = options.beforeSpawn;
            const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: () => {
              prepareFetches += 1;
              assert.deepEqual(store.read(id)?.bootstrap, plannedIdentity, 'the exact planned identity is persisted before preparation');
              assert.equal(registry.readLane(admitted.token.laneId)?.evidence.workspace, canonicalizeMissionEvidence({
                repository: `${TARGET.owner}/${TARGET.repo}`, workspace: plannedIdentity.workspacePath,
              }).workspace,
                'the existing lane is strengthened with the canonical workspace before the actual fetch');
              registry.assertCanMutate(admitted.token);
              beforeSpawn();
            } });
            completedPrepareFetches += 1;
            return result;
          }
          return await fixture.runner.run(file, args, options);
        },
      };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const github = githubAdapter(Array.from({ length: 12 }, () => fixture.baseSha));
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      github.readLiveSnapshot = async (target) => {
        const live = await readLiveSnapshot(target);
        return { ...live, pullRequest: live.pullRequest === null ? null : {
          ...live.pullRequest, headRef: 'existing-pr', baseRef: fixture.branch, baseSha: fixture.baseSha,
          headRepository: { owner: TARGET.owner, repo: TARGET.repo },
        } };
      };
      const result = await runReviewLoop({
        store, github, implementation: new FakeImplementation([successResult(fixture.baseSha)]), reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority, bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna,
        assertCanMutate: (workspacePath) => {
          registry.strengthen(admitted.token, {
            repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id, workspace: workspacePath,
          });
          registry.assertCanMutate(admitted.token);
        },
        assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
      }, id, { maxAttempts: 2, now: () => T0 });

      assert.notEqual(result.outcome, 'failed', JSON.stringify(result));
      assert.equal(prepareFetches, 1, 'the read-only plan reached exactly one actual immutable-base preparation fetch');
      assert.equal(completedPrepareFetches, 1, 'the actual immutable-base fetch completed before repair worker entry');
      assert.deepEqual(store.read(id)?.bootstrap, plannedIdentity);
      assert.equal(registry.readLane(admitted.token.laneId)?.evidence.workspace, canonicalizeMissionEvidence({
        repository: `${TARGET.owner}/${TARGET.repo}`, workspace: plannedIdentity.workspacePath,
      }).workspace);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  for (const boundary of [
    'repair-plan-run-supersession',
    'repair-plan-admission-revocation',
    'repair-prepare-admission-revocation',
    'repair-prepare-run-supersession',
    'repair-prepare-entry-run-supersession',
    'repair-prepare-tagged-admission-callback',
    'repair-plan-cas-missing',
    'repair-plan-cas-throws',
    'repair-plan-reconciliation-cas-throws',
    'repair-plan-reconciliation-write-throws',
  ] as const) {
    it(`rechecks captured Run and current admission before the immutable-base preparation fetch at ${boundary}`, async () => {
      const fixture = createBootstrapGitFixture();
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-bootstrap-fence-'));
      const id = boundary;
      const luna: ResolvedExecutionConfiguration = {
        profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      };
      const request = { runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'existing-pr' };
      const identitySource = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await identitySource.plan(request);
      const registry = new MissionAdmissionRegistry({
        filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: 'review-bootstrap-fence-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
      });
      const admitted = registry.admit({
        laneId: `run:${id}`, role: 'production_captain',
        evidence: { repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id },
      });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      const expected: Run = applyTransition({
        ...reviewingRun(fixture.baseSha, id, undefined, luna),
        repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
        ...(boundary.startsWith('repair-prepare-') ? { bootstrap: identity } : {}),
      }, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
      const store = new CasMemoryStore();
      store.create(expected);
      const originalCas = store.updateIfUnchanged.bind(store);
      let reconciliationMode: 'available' | 'missing' | 'throws' | 'second-throws' | 'third-throws' = 'available';
      let reconciliationCalls = 0;
      const primaryCause = new Error('original final repair admission cause');
      const primaryRefusal = new ExecutionAdmissionRefusal('original final repair admission refusal', false, {
        cause: primaryCause, authorityUnknown: true,
      });
      Object.defineProperty(store, 'updateIfUnchanged', {
        configurable: true,
        get: () => reconciliationMode === 'missing'
          ? undefined
          : (prior: Run, next: Run) => {
              if (reconciliationMode === 'throws') throw new Error('strict repair Run CAS unavailable');
              if (reconciliationMode === 'second-throws' && ++reconciliationCalls === 2) throw new Error('repair refusal reconciliation CAS failed');
              if (reconciliationMode === 'third-throws' && ++reconciliationCalls === 3) throw new Error('repair refusal reconciliation write failed');
              return originalCas(prior, next);
            },
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      let blocked = false;
      const commandsBeforeFence = fixture.commands.length;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          // Planning is read-only. Both a newly planned identity and an
          // existing repair identity reach the real immutable-base fetch as
          // the first preparation effect.
          const matches = args.includes('fetch');
          if (!blocked && file === 'git' && matches) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          options.beforeSpawn?.();
          return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
        },
      };
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const github = githubAdapter(Array.from({ length: 12 }, () => fixture.baseSha));
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      github.readLiveSnapshot = async (target) => {
        const live = await readLiveSnapshot(target);
        return { ...live, pullRequest: live.pullRequest === null ? null : {
          ...live.pullRequest, headRef: 'existing-pr', baseRef: fixture.branch, baseSha: fixture.baseSha,
          headRepository: { owner: TARGET.owner, repo: TARGET.repo },
        } };
      };
      const implementation = new FakeImplementation([successResult(fixture.baseSha)]);
      let newerRun: Run | undefined;
      const pending = runReviewLoop({
        store, github, implementation, reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna,
        assertCanMutate: () => {
          registry.strengthen(admitted.token, {
            repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id, workspace: identity.workspacePath,
          });
          registry.assertCanMutate(admitted.token);
          if (boundary === 'repair-prepare-entry-run-supersession') {
            newerRun = { ...store.read(id)!, updatedAt: '2026-09-28T00:00:07.000Z' };
            store.update(newerRun);
          }
        },
        assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
      }, id, { maxAttempts: 2, now: () => T0 });
      if (boundary !== 'repair-prepare-entry-run-supersession') await entered.promise;
      const atBoundary = store.read(id)!;
      if (boundary === 'repair-plan-run-supersession') {
        newerRun = { ...atBoundary, updatedAt: '2026-09-28T00:00:03.000Z' };
        store.update(newerRun);
      } else if (boundary === 'repair-prepare-run-supersession') {
        newerRun = { ...atBoundary, updatedAt: '2026-09-28T00:00:04.000Z' };
        store.update(newerRun);
      } else if (boundary === 'repair-prepare-entry-run-supersession') {
        // The actual entry callback above changes the full Run between its
        // first exact check and the final pre-prepare check.
      } else if (boundary === 'repair-plan-cas-missing') {
        reconciliationMode = 'missing';
      } else if (boundary === 'repair-plan-cas-throws') {
        reconciliationMode = 'throws';
      } else if (boundary === 'repair-plan-reconciliation-cas-throws' || boundary === 'repair-plan-reconciliation-write-throws') {
        reconciliationMode = boundary.endsWith('write-throws') ? 'third-throws' : 'second-throws';
        reconciliationCalls = 0;
        registry.release(admitted.token, true);
      } else if (boundary === 'repair-prepare-tagged-admission-callback') {
        registry.assertCanMutate = () => { throw primaryRefusal; };
      } else {
        registry.release(admitted.token, true);
      }
      release.resolve();
      let result: ReviewLoopResult | undefined;
      if (boundary === 'repair-prepare-tagged-admission-callback') {
        await assert.rejects(pending, (error: unknown) => {
          assert.strictEqual(error, primaryRefusal);
          assert.strictEqual((error as Error).cause, primaryCause);
          assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
          assert.equal((error as { runSuperseded?: boolean }).runSuperseded, false);
          return true;
        });
      } else if (boundary === 'repair-plan-cas-missing' || boundary === 'repair-plan-cas-throws' ||
          boundary === 'repair-plan-reconciliation-cas-throws' || boundary === 'repair-plan-reconciliation-write-throws') {
        await assert.rejects(pending, (error: unknown) => {
          assert.equal(isExecutionAdmissionRefusal(error), true);
          if (boundary === 'repair-plan-cas-missing' || boundary === 'repair-plan-cas-throws') {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
            assert.match(String((error as Error).cause), /strict repair Run CAS unavailable|Strict Run compare-and-swap/);
          } else {
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, false);
            assert.match(String((error as Error).cause), /Admission generation token is stale/);
          }
          return true;
        });
      } else result = await pending;
      assert.equal(blocked, boundary !== 'repair-prepare-entry-run-supersession',
        'entry supersession is refused before the bootstrap adapter starts preparation');
      assert.equal(fixture.commands.slice(commandsBeforeFence).some(({ file, args }) => file === 'git' && args.includes('fetch')), false,
      'the held actual Git command never reaches the local Git executable');
      assert.equal(implementation.requests.length, 0, 'no repair implementation starts after the refused bootstrap boundary');
      if (boundary === 'repair-plan-run-supersession' || boundary === 'repair-prepare-run-supersession' || boundary === 'repair-prepare-entry-run-supersession') {
        assert.ok(result);
        assert.equal(result.outcome, 'superseded');
        assert.ok(newerRun);
        assert.deepEqual(store.read(id), newerRun, 'the exact newer repair Run remains intact');
      } else if (boundary === 'repair-plan-admission-revocation' || boundary === 'repair-prepare-admission-revocation') {
        assert.ok(result);
        assert.equal(result.outcome, 'needs_human');
        assert.match(result.reason, /current mission admission/);
        assert.equal(store.read(id)?.state, 'NEEDS_HUMAN');
      } else {
        assert.deepEqual(store.read(id), atBoundary, 'uncertain refusal reconciliation does not overwrite the captured Run');
      }
      rmSync(directory, { recursive: true, force: true });
      fixture.cleanup();
    });
  }

  for (const boundary of ['missing-strengthen-callback', 'missing-current-callback', 'missing-entry-cas', 'throwing-entry-cas'] as const) {
    it(`requires the captured Run and both governed callbacks before existing-identity repair preparation at ${boundary}`, async () => {
      const fixture = createBootstrapGitFixture();
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-existing-repair-entry-'));
      try {
        const id = `existing-repair-${boundary}`;
        const luna: ResolvedExecutionConfiguration = {
          profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
        };
        const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
        const identity = await bootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch,
          baseSha: fixture.baseSha, publicationBranch: 'existing-pr' });
        const expected = applyTransition({
          ...reviewingRun(fixture.baseSha, id, undefined, luna), bootstrap: identity,
          repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
        }, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
        const store = new CasMemoryStore();
        store.create(expected);
        let entryCasChecks = 0;
        let capturedActiveRun: Run | undefined;
        let adapterFactoryCalls = 0;
        const entryCasCause = new Error('existing repair Run CAS unavailable');
        let prepareCalls = 0;
        const originalPrepare = bootstrap.prepare.bind(bootstrap);
        bootstrap.prepare = async (request) => { prepareCalls += 1; return originalPrepare(request); };
        let mutationCallbackCalls = 0;
        let currentCallbackCalls = 0;
        const registry = new MissionAdmissionRegistry({
          filePath: path.join(directory, 'registry.json'),
          config: { schemaVersion: 1, revision: `existing-repair-${boundary}`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        });
        const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', evidence: {
          repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id,
        } });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') return;
        const originalLane = registry.readLane(admitted.token.laneId);
        const github = githubAdapter(Array.from({ length: 8 }, () => fixture.baseSha));
        const readLive = github.readLiveSnapshot.bind(github);
        github.readLiveSnapshot = async (target) => {
          const live = await readLive(target);
          return { ...live, pullRequest: live.pullRequest === null ? null : {
            ...live.pullRequest, headRef: 'existing-pr', baseRef: fixture.branch, baseSha: fixture.baseSha,
            headRepository: { owner: TARGET.owner, repo: TARGET.repo },
          } };
        };
        const deps: ReviewLoopDependencies = {
          store, github, implementation: new FakeImplementation([successResult(fixture.baseSha)]), reviewer: new FakeReviewer([]),
          resolveValidationAuthority: reviewAuthority, bootstrapForExecution: () => {
            adapterFactoryCalls += 1;
            capturedActiveRun = structuredClone(store.read(id)!);
            assert.equal(capturedActiveRun.state, 'IMPLEMENTING', 'the adapter is selected only after the authorized start_fix');
            assert.notEqual(activeRepairAdmission(capturedActiveRun), null, 'the captured Run has the exact active repair attempt');
            if (boundary === 'missing-entry-cas' || boundary === 'throwing-entry-cas') {
              Object.defineProperty(store, 'updateIfUnchanged', { configurable: true, get: () => {
                entryCasChecks += 1;
                if (boundary === 'missing-entry-cas') return undefined;
                return () => { throw entryCasCause; };
              } });
            }
            return bootstrap;
          }, resolveRepairExecutionProfile: () => luna,
          governedPublicationRequired: true,
          ...(boundary !== 'missing-strengthen-callback' ? { assertCanMutate: (workspacePath?: string) => {
            mutationCallbackCalls += 1;
            registry.strengthen(admitted.token, { repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber,
              run: id, ...(workspacePath === undefined ? {} : { workspace: workspacePath }) });
            registry.assertCanMutate(admitted.token);
          } } : {}),
          ...(boundary !== 'missing-current-callback'
            ? { assertCurrentMutation: () => { currentCallbackCalls += 1; registry.assertCurrentOwner(admitted.token); } }
            : {}),
        };
        const before = fixture.commands.length;
        if (boundary === 'missing-entry-cas' || boundary === 'throwing-entry-cas') {
          const expectedCause = /Strict Run compare-and-swap is unavailable/;
          await assert.rejects(runReviewLoop(deps, id, { maxAttempts: 2, now: () => T0 }), (error: unknown) => {
            assert.equal(isExecutionAdmissionRefusal(error), true);
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
            if (boundary === 'throwing-entry-cas') assert.strictEqual((error as Error).cause, entryCasCause);
            else assert.match(String((error as Error).cause), expectedCause);
            assert.equal((error as { runSuperseded?: boolean }).runSuperseded, false);
            return true;
          });
        } else {
          const result = await runReviewLoop(deps, id, { maxAttempts: 2, now: () => T0 });
          assert.equal(result.outcome, 'needs_human');
        }
        assert.equal(mutationCallbackCalls, 0, 'no workspace evidence is strengthened before both governed callbacks and the exact Run check pass');
        assert.equal(currentCallbackCalls, 0, 'the missing callback or failed initial CAS blocks before callback invocation');
        assert.equal(adapterFactoryCalls, 1, 'the capture is taken at the actual existing-identity adapter boundary');
        assert.equal(prepareCalls, 0, 'the existing identity never enters preparation');
        assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), false);
        const stored = store.read(id)!;
        if (boundary === 'missing-entry-cas' || boundary === 'throwing-entry-cas') {
          assert.equal(entryCasChecks, 1, 'the first CAS access after adapter selection is the targeted entry check');
          assert.deepEqual(stored, capturedActiveRun, 'unknown entry authority preserves the complete active Run');
        } else {
          assert.equal(stored.state, 'NEEDS_HUMAN');
          assert.ok(capturedActiveRun);
          const { state: _storedState, history: _storedHistory, interruptedFrom: _storedInterruptedFrom,
            interrupt: _storedInterrupt, ...storedEvidence } = stored;
          const { state: _capturedState, history: _capturedHistory, ...capturedEvidence } = capturedActiveRun;
          assert.deepEqual(storedEvidence, capturedEvidence, 'parking changes no other captured Run evidence');
          assert.deepEqual(stored.history.slice(0, capturedActiveRun.history.length), capturedActiveRun.history,
            'parking only appends to the exact captured active history');
          assert.equal(stored.interruptedFrom, capturedActiveRun.state);
          assert.equal(stored.interrupt?.kind, 'needs_human');
        }
        registry.assertCurrentOwner(admitted.token);
        assert.throws(() => registry.assertCanMutate(admitted.token), /canonical workspace evidence/,
          'the workspace-less lane is current but is not mutation-authorized');
        assert.deepEqual(registry.readLane(admitted.token.laneId), originalLane, 'the complete admission evidence remains unchanged');
      } finally {
        rmSync(directory, { recursive: true, force: true });
        fixture.cleanup();
      }
    });
  }

  for (const mode of ['conflicting-workspace', 'missing-governed-callback', 'tagged-refusal-preservation'] as const) {
    it(`holds real repair preparation when host workspace admission is ${mode}`, async () => {
      const fixture = createBootstrapGitFixture();
      const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-plan-establishment-'));
      try {
        const id = `repair-plan-${mode}`;
        const luna: ResolvedExecutionConfiguration = {
          profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
        };
        const identity: ImplementationBootstrapIdentity = {
          bootstrapKind: 'standalone-isolated', owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
          baseBranch: fixture.branch, baseSha: fixture.baseSha, branch: `tachiko/${id}`, publicationBranch: 'existing-pr',
          workspacePath: path.join(fixture.workspaceRoot, TARGET.owner, TARGET.repo, `${id}-issue-${TARGET.issueNumber}`),
        };
        const store = new CasMemoryStore();
        const expected = applyTransition({
          ...reviewingRun(fixture.baseSha, id, undefined, luna),
          repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
        }, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
        store.create(expected);
        const registry = new MissionAdmissionRegistry({
          filePath: path.join(directory, 'registry.json'),
          config: { schemaVersion: 1, revision: `review-plan-${mode}-v1`, limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
        });
        const admitted = registry.admit({
          laneId: `run:${id}`, role: 'production_captain',
          evidence: {
            repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id,
            ...(mode === 'conflicting-workspace' ? { workspace: path.join(directory, 'different-workspace') } : {}),
          },
        });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') return;
        const originalWorkspace = registry.snapshot().lanes.find((lane) => lane.laneId === `run:${id}`)?.evidence.workspace;
        const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
        const github = githubAdapter(Array.from({ length: 12 }, () => fixture.baseSha));
        const readLiveSnapshot = github.readLiveSnapshot.bind(github);
        github.readLiveSnapshot = async (target) => {
          const live = await readLiveSnapshot(target);
          return { ...live, pullRequest: live.pullRequest === null ? null : {
            ...live.pullRequest, headRef: 'existing-pr', baseRef: fixture.branch, baseSha: fixture.baseSha,
            headRepository: { owner: TARGET.owner, repo: TARGET.repo },
          } };
        };
        const before = fixture.commands.length;
        const primaryCause = new Error('original repair planning cause');
        const primary = new ExecutionAdmissionRefusal('original repair planning refusal', false, {
          cause: primaryCause, authorityUnknown: true,
        });
        const pending = runReviewLoop({
          store, github, implementation: new FakeImplementation([successResult(fixture.baseSha)]), reviewer: new FakeReviewer([]),
          resolveValidationAuthority: reviewAuthority, bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna,
          governedPublicationRequired: true,
          ...(mode === 'missing-governed-callback' ? {
            assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
          } : {
            assertCanMutate: () => {
              if (mode === 'tagged-refusal-preservation') throw primary;
              registry.strengthen(admitted.token, { repository: `${TARGET.owner}/${TARGET.repo}`, workspace: identity.workspacePath });
              registry.assertCanMutate(admitted.token);
            },
            assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
          }),
        }, id, { maxAttempts: 2, now: () => T0 });
        if (mode === 'tagged-refusal-preservation') {
          await assert.rejects(pending, (error: unknown) => {
            assert.strictEqual(error, primary);
            assert.strictEqual((error as Error).cause, primaryCause);
            assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
            return true;
          });
        } else {
          const result = await pending;
          assert.equal(result.outcome, 'needs_human');
          assert.match(result.reason, mode === 'conflicting-workspace'
            ? /Mission evidence conflicts on workspace/
            : /workspace admission|planning admission|host admission/i);
        }
        assert.equal(fixture.commands.slice(before).some(({ file, args }) => file === 'git' && args.includes('fetch')), false,
          'the refused repair preparation path never reaches its real immutable-base fetch');
        assert.deepEqual(registry.snapshot().lanes.find((lane) => lane.laneId === `run:${id}`)?.evidence.workspace,
          originalWorkspace,
          'refused workspace establishment leaves the original lane evidence unchanged');
      } finally {
        rmSync(directory, { recursive: true, force: true });
        fixture.cleanup();
      }
    });
  }

  it('fences standalone review-fix publication after awaited Git checks', async (t) => {
    for (const mode of ['run-changed', 'publication-stale', 'current'] as const) {
      await t.test(mode, async () => {
        const fixture = createBootstrapGitFixture();
        try {
          const id = `review-fix-publish-${mode}`;
          const store = new CasMemoryStore();
          let shouldChangeRun = false;
          let concurrent: Run | undefined;
          let actualWorkerPushSpawns = 0;
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
              if (file === 'git' && args.includes('push')) {
                if (options.beforeSpawn !== undefined) {
                  options.beforeSpawn();
                  actualWorkerPushSpawns += 1;
                }
                return fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
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
            assert.equal(result.outcome, 'superseded');
            assert.deepEqual(store.read(id), concurrent, 'the changed Run survives the pre-push CAS');
            assert.equal(published, '', 'the standalone repair is not pushed after its Run becomes stale');
            assert.equal(publicationChecks, 0, 'publication authority is not consulted after the Run CAS rejects');
          } else if (mode === 'publication-stale') {
            assert.equal(result.outcome, 'needs_human');
            assert.equal(result.run.state, 'NEEDS_HUMAN', 'stale publication authority leaves a durable safe park');
            assert.equal(store.read(id)?.state, 'NEEDS_HUMAN');
            assert.equal(published, '', 'the standalone repair is not pushed when publication admission rejects');
            assert.equal(actualWorkerPushSpawns, 0, 'publication refusal occurs before the injected runner delegates an actual worker push');
            assert.equal(publicationChecks, 1, 'publication admission is rechecked after the awaited Git work');
          } else {
            assert.equal(result.outcome, 'revalidating');
            assert.equal(store.read(id)?.headSha, repairedHead);
            assert.equal(fixture.git(fixture.remote, ['rev-parse', `refs/heads/${identity.publicationBranch ?? identity.branch}`]), repairedHead);
            assert.equal(publicationChecks, 1, 'the valid standalone repair checks publication authority immediately before push');
            assert.equal(actualWorkerPushSpawns, 1, 'the valid standalone repair delegates exactly one actual worker push');
            assert.ok(mutationChecks >= 2, 'mutation authority is checked before execution and again before push');
          }
        } finally {
          fixture.cleanup();
        }
      });
    }
  });

  it('fences the successive repair trusted-source import with the production closure and preserves a newer JSON Run', async () => {
    const fixture = createBootstrapGitFixture();
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-first-import-'));
    const entered = deferred<void>();
    const release = deferred<void>();
    let pendingSettlement: Promise<{ kind: 'resolved'; value: any } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      const id = 'repair-first-import-json-cas';
      const durableStore = new JsonFileStore({ dir: directory });
      const bootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await bootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
      fixture.git(fixture.remote, ['update-ref', `refs/heads/${identity.publicationBranch ?? identity.branch}`, fixture.baseSha]);
      let initial: Run = {
        ...reviewingRun(fixture.baseSha, id),
        repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' as const },
        bootstrap: identity,
      };
      initial = applyTransition(initial, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
      durableStore.create(initial);
      let verificationPhase = false;
      let importReached = false;
      let firstImportCompleted = false;
      let importEffects = 0;
      let publicationRefImportEffects = 0;
      let pushEffects = 0;
      const publicationRef = `refs/heads/${identity.publicationBranch ?? identity.branch}`;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          const trustedSource = file === 'git' && options.cwd === realpathSync(fixture.source);
          const importsWorkerHead = trustedSource && args.includes('fetch') && args.includes('--no-recurse-submodules');
          const importsPublicationRef = verificationPhase && trustedSource && args.includes('fetch') && args.includes('origin') && args.at(-1) === publicationRef;
          const pushes = verificationPhase && trustedSource && args.includes('push');
          if (verificationPhase && trustedSource && args.includes('ls-remote') && args.at(-1) === publicationRef && !importReached) {
            importReached = true;
            assert.equal(firstImportCompleted, true, 'the intended remote-head read occurs after the first authorized worker import');
            assert.equal(importEffects, 1, 'the real first trusted-source fetch returned successfully before authority changes');
            const result = await fixture.runner.run(file, args, options);
            entered.resolve();
            await release.promise;
            return result;
          }
          options.beforeSpawn?.();
          const result = await fixture.runner.run(file, args, { ...options, beforeSpawn: undefined });
          if (verificationPhase && importsWorkerHead) { importEffects += 1; firstImportCompleted = true; }
          if (importsPublicationRef) publicationRefImportEffects += 1;
          if (pushes) pushEffects += 1;
          return result;
        },
      };
      const guardedBootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
      const luna: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000 };
      let repairedHead: string | undefined;
      const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(request) {
        repairedHead = fixture.commit(request.workspacePath!, 'repair.txt', 'repair effect\n');
        verificationPhase = true;
        const sessionId = 'repair-successive-git-session';
        const runtimeGeneration = request.runtimeOwnership?.generation;
        assert.ok(runtimeGeneration, 'the actual repair handoff retains its captured runtime generation');
        return { ...successResult(repairedHead), sessionId, executor: { provider: 'codex-cli', sessionId, generation: runtimeGeneration } };
      } };
      const github = githubAdapter([fixture.baseSha, fixture.baseSha, fixture.baseSha, fixture.baseSha]);
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      github.readLiveSnapshot = async (target) => {
        const live = await readLiveSnapshot(target);
        return { ...live, pullRequest: live.pullRequest === null ? null : {
          ...live.pullRequest, headRef: identity.publicationBranch ?? identity.branch, baseRef: fixture.branch,
          headRepository: { owner: TARGET.owner, repo: TARGET.repo },
        } };
      };
      const pending = runReviewLoop({
        store: durableStore, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => guardedBootstrap, resolveRepairExecutionProfile: () => luna,
      }, id, { maxAttempts: 2, now: () => T0 });
      pendingSettlement = pending.then((value) => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      const gate = await Promise.race([entered.promise.then(() => ({ kind: 'entered' as const })), pendingSettlement]);
      assert.equal(gate.kind, 'entered', gate.kind === 'resolved' ? `repair settled before successive import gate: ${JSON.stringify(gate.value)}` : gate.kind === 'rejected' ? `repair rejected before successive import gate: ${String(gate.error)}` : undefined);
      const captured = new JsonFileStore({ dir: directory }).read(id)!;
      const newer = { ...captured, updatedAt: '2026-09-29T00:00:02.000Z' };
      durableStore.update(newer);
      const exactNewer = new JsonFileStore({ dir: directory }).read(id)!;
      const exactNewerRunBytes = readFileSync(path.join(directory, `${id}.json`), 'utf8');
      const exactNewerProjection = readFileSync(operationalProjectionPath(directory, id), 'utf8');
      release.resolve();
      const settled = await pendingSettlement;
      if (settled?.kind === 'rejected') throw settled.error;
      const result = settled?.kind === 'resolved' ? settled.value : await pending;
      assert.equal(result.outcome, 'superseded', JSON.stringify(result));
      assert.ok(repairedHead);
      assert.equal(importReached, true, 'the production repair producer completed the remote-head read before authority changed');
      assert.equal(importEffects, 1, 'the first authorized repair worker-head import completed and remains an earlier effect');
      assert.equal(publicationRefImportEffects, 0, 'the second trusted-source import is refused before real Git execution');
      assert.equal(pushEffects, 0, 'no repair publication follows the refused second import');
      assert.deepEqual(new JsonFileStore({ dir: directory }).read(id), exactNewer, 'a fresh store preserves the exact concurrent repair Run');
      assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8'), exactNewerRunBytes, 'the exact concurrent repair Run bytes remain unchanged');
      assert.equal(readFileSync(operationalProjectionPath(directory, id), 'utf8'), exactNewerProjection, 'the exact concurrent repair projection bytes remain untouched');
    } finally {
      release.resolve();
      await pendingSettlement;
      rmSync(directory, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('fences the repair first trusted-source import at the actual runner boundary and preserves Run and projection bytes', async () => {
    const fixture = createBootstrapGitFixture();
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-first-fetch-cas-'));
    const entered = deferred<void>();
    const release = deferred<void>();
    let pendingSettlement: Promise<{ kind: 'resolved'; value: any } | { kind: 'rejected'; error: unknown }> | undefined;
    try {
      const id = 'repair-first-fetch-json-cas';
      const durableStore = new JsonFileStore({ dir: directory });
      const setupBootstrap = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
      const identity = await setupBootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
      const publicationRef = `refs/heads/${identity.publicationBranch ?? identity.branch}`;
      fixture.git(fixture.remote, ['update-ref', publicationRef, fixture.baseSha]);
      let initial: Run = {
        ...reviewingRun(fixture.baseSha, id),
        repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
        bootstrap: identity,
      };
      initial = applyTransition(initial, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
      durableStore.create(initial);
      let verificationPhase = false;
      let importRunnerEntered = false;
      let importEffects = 0;
      let pushEffects = 0;
      const runner: ProcessRunner = {
        async run(file, args, options) {
          const trustedSource = file === 'git' && options.cwd === realpathSync(fixture.source);
          const importsWorkerHead = trustedSource && args.includes('fetch') && args.includes('--no-recurse-submodules');
          const pushes = trustedSource && args.includes('push');
          if (verificationPhase && importsWorkerHead && !importRunnerEntered) {
            importRunnerEntered = true;
            assert.ok(durableStore.read(id)?.telemetry?.events.some((event) => event.kind === 'completion'),
              'the actual first trusted fetch is reached after completion telemetry is durable');
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
      let repairedHead: string | undefined;
      const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(request) {
        repairedHead = fixture.commit(request.workspacePath!, 'repair.txt', 'repair first fetch\n');
        verificationPhase = true;
        const sessionId = 'repair-first-fetch-session';
        const runtimeGeneration = request.runtimeOwnership?.generation;
        assert.ok(runtimeGeneration, 'the actual repair handoff retains its captured runtime generation');
        return { ...successResult(repairedHead), sessionId, executor: { provider: 'codex-cli', sessionId, generation: runtimeGeneration } };
      } };
      const github = githubAdapter([fixture.baseSha, fixture.baseSha, fixture.baseSha, fixture.baseSha]);
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      github.readLiveSnapshot = async (target) => {
        const live = await readLiveSnapshot(target);
        return { ...live, pullRequest: live.pullRequest === null ? null : {
          ...live.pullRequest, headRef: publicationRef.replace(/^refs\/heads\//, ''), baseRef: fixture.branch,
          headRepository: { owner: TARGET.owner, repo: TARGET.repo },
        } };
      };
      const pending = runReviewLoop({
        store: durableStore, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => ({
          profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
        }),
      }, id, { maxAttempts: 2, now: () => T0 });
      pendingSettlement = pending.then((value) => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      const gate = await Promise.race([entered.promise.then(() => ({ kind: 'entered' as const })), pendingSettlement]);
      assert.equal(gate.kind, 'entered', gate.kind === 'resolved' ? `repair settled before first-fetch gate: ${JSON.stringify(gate.value)}` : gate.kind === 'rejected' ? `repair rejected before first-fetch gate: ${String(gate.error)}` : undefined);
      const captured = new JsonFileStore({ dir: directory }).read(id)!;
      const newer = { ...captured, updatedAt: '2026-09-29T00:00:05.000Z' };
      durableStore.update(newer);
      const exactNewer = new JsonFileStore({ dir: directory }).read(id)!;
      const exactNewerRunBytes = readFileSync(path.join(directory, `${id}.json`), 'utf8');
      const exactNewerProjection = readFileSync(operationalProjectionPath(directory, id), 'utf8');
      release.resolve();
      const settled = await pendingSettlement;
      if (settled.kind === 'rejected') throw settled.error;
      const result = settled.value;
      assert.equal(result.outcome, 'superseded', JSON.stringify(result));
      assert.ok(repairedHead);
      assert.equal(importRunnerEntered, true, 'the production durable-verification producer reached the actual fetch runner');
      assert.equal(importEffects, 0, 'authority is checked before the first worker-head import effect');
      assert.equal(pushEffects, 0, 'no repair push follows the refused first import');
      assert.deepEqual(new JsonFileStore({ dir: directory }).read(id), exactNewer, 'a fresh Run reader retains the exact concurrent winner');
      assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8'), exactNewerRunBytes, 'the exact concurrent Run bytes remain unchanged');
      assert.equal(readFileSync(operationalProjectionPath(directory, id), 'utf8'), exactNewerProjection, 'the exact concurrent projection bytes remain unchanged');
    } finally {
      release.resolve();
      await pendingSettlement;
      rmSync(directory, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('reconciles repair durable-verification refusals only after completed evidence is durable', async (t) => {
    for (const mode of ['authority-unknown', 'known-current', 'missing-cas', 'throwing-cas', 'secondary-identity-failure', 'secondary-failure', 'parking-cas-loss'] as const) {
      await t.test(mode, async () => {
        const id = `repair-durable-refusal-${mode}`;
        const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-repair-durable-${mode}-`));
        try {
          const store = new JsonFileStore({ dir: directory });
          const identity: ImplementationBootstrapIdentity = {
            bootstrapKind: 'linked-worktree', owner: TARGET.owner, repo: TARGET.repo, issueNumber: TARGET.issueNumber,
            baseBranch: 'main', baseSha: HEAD, branch: `tachiko/${id}`, workspacePath: path.join(directory, 'workspace'),
          };
          let initial: Run = { ...repairChangesRun(id), bootstrap: identity };
          store.create(initial);
          const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'),
            config: { schemaVersion: 1, revision: `repair-durable-${mode}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
          const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', evidence: {
            repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id, workspace: identity.workspacePath,
          } });
          assert.equal(admitted.outcome, 'admitted');
          if (admitted.outcome !== 'admitted') return;

          const primaryCause = new Error(`repair ${mode} cause`);
          const primary = new ExecutionAdmissionRefusal(`repair durable ${mode}`, false, {
            cause: primaryCause, ...(mode === 'authority-unknown' ? { authorityUnknown: true } : {}),
          });
          let verifying = false;
          let verificationCasCalls = 0;
          let capturedPrimary: unknown;
          let completedRun: Run | undefined;
          let completedRunBytes: string | undefined;
          let completedProjectionBytes: string | undefined;
          let winner: Run | undefined;
          let winnerRunBytes: string | undefined;
          let winnerProjectionBytes: string | undefined;
          const originalCas = store.updateIfUnchanged.bind(store);
          Object.defineProperty(store, 'updateIfUnchanged', { configurable: true, get: () => {
            if (verifying && mode === 'missing-cas') return undefined;
            return (expected: Run, next: Run) => {
              if (verifying) {
                verificationCasCalls += 1;
                if (mode === 'throwing-cas') throw new Error('repair durable strict CAS unavailable');
                if (mode === 'secondary-identity-failure' && verificationCasCalls === 2) throw new Error('repair refusal identity CAS failed');
                if (mode === 'secondary-failure' && verificationCasCalls === 3) throw new Error('repair parking write CAS failed');
                if (mode === 'parking-cas-loss' && next.state === 'NEEDS_HUMAN') {
                  winner = { ...expected, updatedAt: '2026-09-29T00:00:04.000Z' };
                  store.update(winner);
                  winnerRunBytes = readFileSync(path.join(directory, `${id}.json`), 'utf8');
                  winnerProjectionBytes = readFileSync(operationalProjectionPath(directory, id), 'utf8');
                }
              }
              return originalCas(expected, next);
            };
          } });
          const bootstrap: ImplementationBootstrapAdapter = {
            kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree',
            async plan() { return identity; },
            async prepare(request) { request.beforeMutation?.(); return identity; },
            guard() { return { assertValid() {} }; },
            async verifyDurable(request) {
              verifying = true;
              completedRun = store.read(id)!;
              assert.ok(completedRun.telemetry?.events.some((event) => event.kind === 'completion'), 'the durable producer begins after worker completion was stored');
              assert.deepEqual(completedRun.repairTaskShapeAuthority, initial.repairTaskShapeAuthority, 'the explicit task-shape authority survives into durable verification');
              assert.equal(completedRun.repairAdmissions?.at(-1)?.executionProfile, 'routine', 'the durable producer is entered under the admitted routine repair profile');
              assert.deepEqual(completedRun.repairAdmissions?.at(-1)?.execution, ROUTINE_REPAIR_EXECUTION, 'the admitted execution ledger remains exact');
              assert.ok(completedRun.history.some((event) => event.type === 'repair_executor_handoff'), 'the selected codex-cli handoff is durably recorded before verification');
              assert.equal(completedRun.agentResult?.sessionId, completedRun.executor?.sessionId, 'the top-level result session matches the persisted executor identity');
              completedRunBytes = readFileSync(path.join(directory, `${id}.json`), 'utf8');
              completedProjectionBytes = readFileSync(operationalProjectionPath(directory, id), 'utf8');
              try {
                if (mode === 'known-current' || mode === 'parking-cas-loss') registry.release(admitted.token, true);
                request.beforeMutation?.();
                request.beforePublish?.();
              } catch (error) {
                capturedPrimary = error;
                throw error;
              }
              return { headSha: HEAD2, branch: identity.branch };
            },
          };
          const implementation: ImplementationAgent = { kind: 'implementation-agent', async run(request) {
            const sessionId = `repair-session-${mode}`;
            const runtimeGeneration = request.runtimeOwnership?.generation;
            assert.ok(runtimeGeneration, 'the fault fixture returns the generation selected by repair admission');
            return { ...successResult(HEAD2), sessionId, executor: { provider: 'codex-cli', sessionId, generation: runtimeGeneration } };
          } };
          const assertCurrentMutation = () => {
            if (!verifying) return;
            if (mode === 'known-current' || mode === 'parking-cas-loss') registry.assertCanMutate(admitted.token);
            if (mode === 'authority-unknown' || mode === 'secondary-identity-failure' || mode === 'secondary-failure') throw primary;
          };
          const liveGithub = githubAdapter(Array.from({ length: 12 }, () => HEAD));
          const readLiveSnapshot = liveGithub.readLiveSnapshot.bind(liveGithub);
          let liveSnapshotReads = 0;
          liveGithub.readLiveSnapshot = async (target) => {
            const live = await readLiveSnapshot(target);
            liveSnapshotReads += 1;
            return {
              ...live,
              issue: { ...live.issue, number: TARGET.issueNumber, title: 'Fix the widget', body: 'Original bounded requirement.' },
              repository: { ...live.repository, owner: TARGET.owner, repo: TARGET.repo, defaultBranch: identity.baseBranch, defaultBranchHeadSha: HEAD },
              pullRequest: live.pullRequest === null ? null : {
                ...live.pullRequest, number: initial.pullRequest?.number ?? 7, headSha: HEAD, baseSha: HEAD,
                headRef: identity.publicationBranch ?? identity.branch, baseRef: identity.baseBranch,
                headRepository: { owner: TARGET.owner, repo: TARGET.repo },
              },
            };
          };
          const pending = runReviewLoop({
            store, github: liveGithub, implementation, reviewer: new FakeReviewer([]),
            resolveValidationAuthority: reviewAuthority, bootstrapForExecution: () => bootstrap,
            resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
            assertCurrentMutation,
          }, id, { maxAttempts: 2, now: () => T0 });

          if (mode === 'authority-unknown' || mode === 'missing-cas' || mode === 'throwing-cas' || mode === 'secondary-identity-failure' || mode === 'secondary-failure') {
            await assert.rejects(pending, (error: unknown) => {
              assert.strictEqual(error, capturedPrimary, 'the primary repair verification refusal escapes unchanged');
              if (mode === 'authority-unknown' || mode === 'secondary-identity-failure' || mode === 'secondary-failure') {
                assert.strictEqual(error, primary);
                assert.strictEqual((error as Error).cause, primaryCause);
                assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, mode === 'authority-unknown');
              } else {
                assert.equal(isExecutionAdmissionRefusal(error), true);
                assert.equal((error as { authorityUnknown?: boolean }).authorityUnknown, true);
                assert.match(String((error as Error).cause), /strict Run compare-and-swap|repair durable strict CAS unavailable/i);
              }
              return true;
            });
            const persisted = new JsonFileStore({ dir: directory }).read(id)!;
            assert.equal(persisted.state, 'IMPLEMENTING', 'a refused repair verification cannot overwrite the completed Run');
            assert.deepEqual(persisted.history, completedRun?.history, 'a failed reconciliation preserves exact completed repair history');
            assert.deepEqual(persisted.repairTaskShapeAuthority, completedRun?.repairTaskShapeAuthority, 'a failed reconciliation preserves task-shape authority');
            assert.deepEqual(persisted.repairAdmissions, completedRun?.repairAdmissions, 'a failed reconciliation preserves the admitted repair ledger');
            assert.deepEqual(persisted.telemetry, completedRun?.telemetry, 'a failed reconciliation preserves full completion and execution evidence');
            assert.equal(persisted.executor?.sessionId, completedRun?.executor?.sessionId);
            assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8'), completedRunBytes);
            assert.equal(readFileSync(operationalProjectionPath(directory, id), 'utf8'), completedProjectionBytes);
            if (mode === 'secondary-identity-failure') assert.equal(verificationCasCalls, 2, 'the primary refusal reached the secondary captured-Run comparison failure');
            if (mode === 'secondary-failure') assert.equal(verificationCasCalls, 3, 'the primary refusal reached the secondary parking-write CAS');
          } else {
            const result = await pending;
            if (mode === 'parking-cas-loss') {
              assert.equal(result.outcome, 'superseded');
              assert.ok(winner);
              assert.deepEqual(new JsonFileStore({ dir: directory }).read(id), persistedJson(winner));
              assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8'), winnerRunBytes);
              assert.equal(readFileSync(operationalProjectionPath(directory, id), 'utf8'), winnerProjectionBytes);
            } else {
              assert.equal(result.outcome, 'needs_human');
              assert.equal(result.run.state, 'NEEDS_HUMAN');
              assert.deepEqual(persistedJson(result.run.history.slice(0, completedRun?.history.length)), completedRun?.history, 'parking preserves the exact completed repair history prefix');
              assert.deepEqual(result.run.repairTaskShapeAuthority, completedRun?.repairTaskShapeAuthority, 'parking preserves task-shape authority');
              assert.deepEqual(result.run.repairAdmissions, completedRun?.repairAdmissions, 'parking preserves the admitted repair ledger');
              assert.equal(result.run.executor?.sessionId, completedRun?.executor?.sessionId, 'parking preserves the completed repair executor');
              assert.deepEqual(result.run.telemetry, completedRun?.telemetry, 'parking preserves full completion and execution evidence');
              assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released', 'the refusal is tied to the exact current admission generation');
            }
          }
          assert.ok(liveSnapshotReads >= 3, 'repair ownership was revalidated before admission, after start_fix, and after workspace preparation');
          assert.ok(verifying && completedRun !== undefined && completedRunBytes !== undefined && completedProjectionBytes !== undefined,
            'the tested refusal is raised inside durable verification after completion persistence');
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  });

  it('passes the production captured-Run and admission publication fence through a terminal WorkerRouter container', async (t) => {
    for (const mode of ['run-superseded', 'admission-revoked'] as const) {
      await t.test(mode, async () => {
        const fixture = createBootstrapGitFixture();
        const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-router-producer-fence-${mode}-`));
        const pushEntered = deferred<void>();
        const releasePush = deferred<void>();
        let pendingSettlement: Promise<{ kind: 'resolved'; value: any } | { kind: 'rejected'; error: unknown }> | undefined;
        try {
          const id = `router-producer-fence-${mode}`;
          const bootstrap = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
          const identity = await bootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
          await bootstrap.prepare({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: identity });
          fixture.git(fixture.remote, ['update-ref', `refs/heads/${identity.publicationBranch ?? identity.branch}`, fixture.baseSha]);
          let initial: Run = { ...reviewingRun(fixture.baseSha, id, undefined, ROUTINE_REPAIR_EXECUTION), bootstrap: identity };
          initial = applyTransition(initial, { type: 'changes_requested', reviewResult: requestChanges(fixture.baseSha) }, T0, reviewAuthority());
          const store = new JsonFileStore({ dir: directory });
          store.create(initial);
          const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'),
            config: { schemaVersion: 1, revision: `router-producer-${mode}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
          const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', evidence: {
            repository: `${TARGET.owner}/${TARGET.repo}`, issue: TARGET.issueNumber, run: id, workspace: identity.workspacePath,
          } });
          assert.equal(admitted.outcome, 'admitted');
          if (admitted.outcome !== 'admitted') return;
          let pushEffects = 0;
          let terminalReached = false;
          const runner: ProcessRunner = { async run(_file, args, options) {
            if (args[0] === 'rev-parse') return { stdout: `${HEAD2}\n`, stderr: '', exitCode: 0 };
            if (args[0] === 'merge-base') return { stdout: '', stderr: '', exitCode: 0 };
            if (args[0] === 'push') {
              assert.equal(typeof options.beforeSpawn, 'function', 'the production publication closure reaches the actual WorkerRouter process boundary');
              pushEntered.resolve();
              await releasePush.promise;
              options.beforeSpawn?.();
              pushEffects += 1;
              return { stdout: '', stderr: '', exitCode: 0 };
            }
            throw new Error(`unexpected router command ${args[0] ?? ''}`);
          } };
          const container: ContainerWorkerExecution = { async run(spec: WorkerContainerSpec) {
            spec.beforeExecution?.();
            terminalReached = true;
            return { containerId: 'f'.repeat(64), exitCode: 0, terminalState: 'exited' as const, restartPolicy: 'no' as const, stdout: '', stderr: '' };
          } };
          const implementation = new WorkerRouterAdapter({ runner, container, image: `tachiko/worker-router@sha256:${'a'.repeat(64)}`, env: {} });
          const github = githubAdapter([fixture.baseSha, fixture.baseSha, fixture.baseSha, fixture.baseSha]);
          const readLiveSnapshot = github.readLiveSnapshot.bind(github);
          github.readLiveSnapshot = async (target) => {
            const live = await readLiveSnapshot(target);
            return { ...live, pullRequest: live.pullRequest === null ? null : {
              ...live.pullRequest, headRef: identity.branch, baseRef: fixture.branch,
              headRepository: { owner: TARGET.owner, repo: TARGET.repo },
            } };
          };
          const pending = runReviewLoop({
            store, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
            bootstrapForExecution: () => bootstrap,
            assertCanMutate: () => registry.assertCanMutate(admitted.token),
            assertCurrentMutation: () => registry.assertCanMutate(admitted.token),
          }, id, { maxAttempts: 2, now: () => T0 });
          pendingSettlement = pending.then((value) => ({ kind: 'resolved' as const, value }), (error: unknown) => ({ kind: 'rejected' as const, error }));
          const gate = await Promise.race([pushEntered.promise.then(() => ({ kind: 'entered' as const })), pendingSettlement]);
          assert.equal(gate.kind, 'entered', gate.kind === 'resolved' ? `repair settled before WorkerRouter push gate: ${JSON.stringify(gate.value)}` : gate.kind === 'rejected' ? `repair rejected before WorkerRouter push gate: ${String(gate.error)}` : undefined);
          let winningRun: Run | undefined;
          let winningRunBytes: string | undefined;
          let winningProjectionBytes: string | undefined;
          if (mode === 'run-superseded') {
            const current = store.read(id)!;
            winningRun = applyTransition(current, { type: 'escalate', reason: 'operator superseded repair during actual push preparation',
              interrupt: { evidence: 'operator decision during actual push', choices: ['Cancel the run'] } }, T0);
            store.update(winningRun);
            winningRunBytes = readFileSync(path.join(directory, `${id}.json`), 'utf8');
            winningProjectionBytes = readFileSync(operationalProjectionPath(directory, id), 'utf8');
          } else {
            registry.release(admitted.token, true);
          }
          releasePush.resolve();
          const settled = await pendingSettlement;
          if (settled.kind === 'rejected') throw settled.error;
          const result = settled.value;
          assert.equal(terminalReached, true, 'the simulated container reaches a terminal state before publication admission');
          assert.equal(pushEffects, 0, 'the captured production closure rejects before the actual WorkerRouter push');
          if (mode === 'run-superseded') {
            assert.equal(result.outcome, 'superseded');
            assert.deepEqual(new JsonFileStore({ dir: directory }).read(id), winningRun);
            assert.equal(readFileSync(path.join(directory, `${id}.json`), 'utf8'), winningRunBytes);
            assert.equal(readFileSync(operationalProjectionPath(directory, id), 'utf8'), winningProjectionBytes);
            assert.equal(store.read(id)?.state, 'NEEDS_HUMAN');
          } else {
            assert.equal(result.outcome, 'needs_human');
            assert.equal(result.run.state, 'NEEDS_HUMAN');
            assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released');
          }
        } finally {
          releasePush.resolve();
          await pendingSettlement;
          rmSync(directory, { recursive: true, force: true });
          fixture.cleanup();
        }
      });
    }
  });

  it('holds governed repair when a durable producer callback becomes unavailable after worker completion', async (t) => {
    for (const mode of ['missing-mutation', 'missing-publication'] as const) {
      await t.test(mode, async () => {
        const id = `governed-durable-omission-${mode}`;
        const luna = await createGenuineLunaFixture(id);
        const directory = mkdtempSync(path.join(os.tmpdir(), `tachiko-governed-durable-${mode}-`));
        try {
          const store = new JsonFileStore({ dir: directory });
          const workerScript = path.join(luna.root, 'bin', 'codex');
          writeFileSync(workerScript, [
            '#!/bin/sh',
            'set -e',
            "printf 'bounded repair\\n' > governed-repair.txt",
            'git add governed-repair.txt >/dev/null 2>&1',
            'git commit -m "bounded governed fixture repair" >/dev/null 2>&1',
            `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'genuine-luna-thread' })}'`,
            `printf '%s\\n' '${JSON.stringify({ type: 'turn.started' })}'`,
            `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { id: 'genuine-luna-message', type: 'agent_message', text: 'bounded fixture result' } })}'`,
            `printf '%s\\n' '${JSON.stringify({ type: 'turn.completed' })}'`,
            '',
          ].join('\n'));
          chmodSync(workerScript, 0o700);

          const baseBootstrap = luna.bootstrap;
          let verifying = false;
          let beforeMutationReached = false;
          let beforePublishReached = false;
          let authorizedImportEffects = 0;
          let publicationEffects = 0;
          let completedRun: Run | undefined;
          const bootstrap: ImplementationBootstrapAdapter = {
            kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
            async plan(request) { return baseBootstrap.plan(request); },
            async prepare(request) { return baseBootstrap.prepare(request); },
            guard(identity) { return baseBootstrap.guard(identity); },
            async verifyDurable(request) {
              verifying = true;
              completedRun = store.read(id)!;
              assert.ok(completedRun.telemetry?.events.some((event) => event.kind === 'completion'), 'governed callback omission is injected only after worker completion is durable');
              beforeMutationReached = true;
              request.beforeMutation?.();
              authorizedImportEffects += 1;
              beforePublishReached = true;
              request.beforePublish?.();
              publicationEffects += 1;
              return { headSha: request.expectedHeadSha, branch: luna.identity.branch };
            },
          };
          const execution = luna.request.execution!;
          let initial: Run = {
            ...reviewingRun(luna.identity.baseSha, id, undefined, execution as ResolvedExecutionConfiguration),
            bootstrap: luna.identity,
            repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
          };
          initial = applyTransition(initial, { type: 'changes_requested', reviewResult: requestChanges(luna.identity.baseSha) }, T0, reviewAuthority());
          store.create(initial);
          const github = githubAdapter([luna.identity.baseSha, luna.identity.baseSha, luna.identity.baseSha]);
          const readLiveSnapshot = github.readLiveSnapshot.bind(github);
          github.readLiveSnapshot = async (target) => {
            const live = await readLiveSnapshot(target);
            return { ...live, issue: { ...live.issue, title: 'Fix the widget', body: 'Original bounded requirement.' }, pullRequest: live.pullRequest === null ? null : {
              ...live.pullRequest, headRef: luna.identity.branch, baseRef: luna.identity.baseBranch,
              baseSha: luna.identity.baseSha, headRepository: { owner: TARGET.owner, repo: TARGET.repo },
            } };
          };
          const implementation: ImplementationAgent = {
            kind: 'implementation-agent',
            prepareGovernedInvocation(request) { return luna.adapter.prepareGovernedInvocation(request); },
            async run() { throw new Error('ambient implementation fallback must not run'); },
          };
          const validMutation = () => undefined;
          const validPublication = () => undefined;
          const dependencies: ReviewLoopDependencies = {
            store, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
            bootstrapForExecution: () => bootstrap,
            resolveRepairExecutionProfile: () => execution as ResolvedExecutionConfiguration,
            governedPublicationRequired: true,
            assertCanMutate: validMutation,
            get assertCurrentMutation() { return verifying && mode === 'missing-mutation' ? undefined : validMutation; },
            get assertCanPublish() { return verifying && mode === 'missing-publication' ? undefined : validPublication; },
          };
          const result = await runReviewLoop(dependencies, id, { maxAttempts: 2, now: () => T0 });
          assert.equal(verifying, true, 'the actual durable producer reached the targeted verification callback');
          assert.equal(beforeMutationReached, true);
          assert.equal(beforePublishReached, mode === 'missing-publication', 'missing mutation admission blocks before the publication callback');
          assert.equal(authorizedImportEffects, mode === 'missing-publication' ? 1 : 0, 'only the mutation-admitted case reaches the simulated trusted import');
          assert.equal(publicationEffects, 0, 'no publication effect crosses a missing governed callback');
          assert.equal(result.outcome, 'needs_human');
          assert.equal(result.run.state, 'NEEDS_HUMAN');
          assert.ok(completedRun);
          assert.deepEqual(persistedJson(result.run.history.slice(0, completedRun.history.length)), completedRun.history, 'conditional parking retains the completed repair history');
          assert.deepEqual(result.run.telemetry, completedRun.telemetry, 'conditional parking retains completed execution uncertainty and telemetry');
          assert.deepEqual(result.run.executor, completedRun.executor, 'conditional parking retains executor identity');
          assert.deepEqual(result.run.execution, completedRun.execution, 'conditional parking retains the exact selected execution profile');
          assert.deepEqual(result.run.agentResult, completedRun.agentResult, 'conditional parking retains the completed provider result');
        } finally {
          rmSync(directory, { recursive: true, force: true });
          luna.cleanup();
        }
      });
    }
  });

  it('blocks repair effects when start_fix, the first post-capability, or final pre-worker CAS loses', async (t) => {
    for (const [label, rejectAt] of [['start_fix', 2], ['post_capability_pre_effects', 5], ['final_pre_worker', 6]] as const) {
      await t.test(label, async () => {
        const initial = repairChangesRun(`pre-worker-${label}-race`);
        const store = new SpawnRaceStore(rejectAt, (expected) => applyTransition(expected,
          { type: 'escalate', reason: `concurrent decision at ${label}`,
            interrupt: { evidence: `winner-${label}`, choices: ['Cancel the run'] } }, T0));
        store.create(initial);
        let executionMarkers = 0;
        let capabilityResolutions = 0;
        let mutationChecks = 0;
        const implementation = new FakeImplementation([successResult(HEAD2)]);
        const reviewer = new FakeReviewer([]);
        const result = await runReviewLoop({
          store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority,
          assertCanMutate: () => { mutationChecks += 1; },
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
          assert.equal(mutationChecks, 0);
        } else if (label === 'post_capability_pre_effects') {
          assert.equal(capabilityResolutions, 1, 'the capability result can resolve before this first post-await fence');
          assert.equal(executionMarkers, 0, 'the first post-await fence precedes the execution marker');
          assert.equal(mutationChecks, 0, 'the first post-await fence precedes registry/workspace mutation effects');
        } else {
          assert.equal(capabilityResolutions, 1, 'capability discovery may finish before the final fence');
          assert.equal(executionMarkers, 1, 'the execution uncertainty marker precedes the final CAS fence');
          assert.equal(mutationChecks, 1);
        }
      });
    }
  });

  it('returns superseded for a stale ordinary review CAS and preserves the winner', async () => {
    const initial = reviewingRun(HEAD, 'ordinary-review-cas-loser');
    const winner = applyTransition(initial, {
      type: 'escalate', reason: 'concurrent review owner decision',
      interrupt: { evidence: 'winner persisted before verdict', choices: ['Cancel the run'] },
    }, T0);
    const store = new SpawnRaceStore(1, () => winner);
    store.create(initial);
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const result = await runReviewLoop({
      store, github: githubAdapter([HEAD]), implementation: new FakeImplementation([]), reviewer,
      resolveValidationAuthority: reviewAuthority,
    }, initial.id, { maxAttempts: 1, now: () => T0 });
    assert.equal(result.outcome, 'superseded');
    assert.deepEqual(result.run, winner);
    assert.equal(JSON.stringify(store.read(initial.id)), JSON.stringify(winner));
    assert.equal(reviewer.requests.length, 0, 'a lost pre-review CAS blocks reviewer effects');
    assert.equal(store.casCalls, 0, 'the simulated rejecting CAS did not enter the ordinary writer');
  });

  it('preserves every valid ordinary-review winner after the pending reviewer result loses CAS', async (t) => {
    const makeWinners = (id: string): Array<[string, Run]> => {
      const initial = reviewingRun(HEAD, id);
      const waiting = applyTransition(initial, { type: 'wait_dependency', interrupt: { evidence: 'dependency pending', choices: ['Retry'] } }, T0);
      let mergeReady = applyTransition(initial, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, reviewAuthority());
      mergeReady = { ...mergeReady, state: 'MERGE_READY', history: [...mergeReady.history,
        { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
      const merged = applyTransition(mergeReady, { type: 'merged' }, T0);
      const failed = applyTransition(initial, { type: 'fail', reason: 'winner failed while review was pending' }, T0);
      let active = repairChangesRun(id);
      const admission = createRepairAdmissionSnapshot(active.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, ROUTINE_REPAIR_EXECUTION, T0);
      const binding = createRepairAttemptBinding(active, ROUTINE_REPAIR_EXECUTION);
      active = applyTransition(active, { type: 'start_fix', repairAdmission: { ...admission, attemptBinding: binding } }, T0);
      active = applyTransition(active, { type: 'repair_executor_handoff', repairAgentResult: {
        ...successResult(HEAD2), executor: { provider: 'codex-app-server', sessionId: 'winner-thread', generation: binding.runtimeGeneration }, sessionId: 'winner-thread',
      } }, T0);
      return [
        ['WAITING_DEPENDENCY', waiting], ['MERGE_READY', mergeReady], ['MERGED', merged], ['FAILED', failed],
        ['changed active repair history and executor', active],
      ];
    };
    for (const [label, winner] of makeWinners('ordinary-review-winners')) {
      await t.test(label, async () => {
        const initial = reviewingRun(HEAD, winner.id);
        const store = new CasMemoryStore();
        store.create(initial);
        const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-ordinary-review-winner-'));
        try {
          const durable = new JsonFileStore({ dir: fixtureDir });
          durable.create(winner);
          assert.equal(JSON.stringify(new JsonFileStore({ dir: fixtureDir }).read(winner.id)), JSON.stringify(winner),
            'the competing winner is a valid durable Run snapshot');
        } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
        let reviewerCalls = 0;
        const reviewer: ReviewerAdapter = {
          kind: 'reviewer',
          async review() { reviewerCalls += 1; store.update(winner); return approve(HEAD); },
        };
        const result = await runReviewLoop({
          store, github: githubAdapter([HEAD]), implementation: new FakeImplementation([]), reviewer,
          resolveValidationAuthority: reviewAuthority,
        }, initial.id, { maxAttempts: 1, now: () => T0 });
        assert.equal(result.outcome, 'superseded');
        assert.deepEqual(result.run, winner);
        assert.equal(JSON.stringify(store.read(initial.id)), JSON.stringify(winner));
        assert.equal(reviewerCalls, 1, 'the reviewer completed after the other writer stored its winner');
        assert.ok(store.casSuccesses >= 1, 'the pre-review no-op fence succeeded before the other writer changed the Run');
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

  it('rechecks the captured genuine Luna instance at review-repair invocation entry', async () => {
    const original = repairChangesRun('governed-review-luna-entry-recheck');
    const luna = await createGenuineLunaFixture(original.id);
    const store = new CasMemoryStore();
    store.create(original);
    let replacementCalls = 0;
    let fallbackCalls = 0;
    const retainedPreparation: { agent: ImplementationAgent } = { agent: luna.adapter };
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation() { return { status: 'qualified', agent: retainedPreparation.agent }; },
      async run() { fallbackCalls += 1; return successResult(HEAD2); },
    };
    try {
      const result = await runReviewLoop({
        store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
        governedPublicationRequired: true,
      }, original.id, { maxAttempts: 3, now: () => T0, onExecutionStart: () => {
        retainedPreparation.agent = { kind: 'implementation-agent', async run() { replacementCalls += 1; return successResult(HEAD2); } };
        luna.adapter.run = async () => { replacementCalls += 1; return successResult(HEAD2); };
      } });
      assert.equal(result.outcome, 'needs_human');
      assert.match(result.reason, /publication boundary changed after preflight/);
      assert.equal(replacementCalls, 0, 'neither the replacement prepared agent nor replaced method is entered');
      assert.equal(fallbackCalls, 0, 'the ambient implementation is never selected as fallback');
      assert.deepEqual(result.run.executor, original.executor);
      assert.equal(result.run.agentResult?.sessionId, original.agentResult?.sessionId);
    } finally { luna.cleanup(); }
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
    assert.equal(markers, 0, 'the first post-capability CAS loss stops before uncertainty or execution side effects');
  });

  it('rechecks the exact repair handoff after final asynchronous worker preparation', async () => {
    const original = repairChangesRun('repair-execution-boundary-run-race');
    const store = new CasMemoryStore();
    store.create(original);
    let workerReady!: () => void;
    let allowBoundary!: () => void;
    const ready = new Promise<void>((resolve) => { workerReady = resolve; });
    const barrier = new Promise<void>((resolve) => { allowBoundary = resolve; });
    let entered = 0;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request) {
        workerReady();
        await barrier;
        request.beforeExecution?.();
        entered += 1;
        return successResult(HEAD2);
      },
    };
    const operation = runReviewLoop({
      store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
      resolveValidationAuthority: reviewAuthority,
      resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
    }, original.id, { maxAttempts: 3, now: () => T0 });
    await ready;
    const winner = applyTransition(store.read(original.id)!, {
      type: 'escalate', reason: 'Concurrent cancellation after repair preparation',
      interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
    }, T0);
    store.update(winner);
    allowBoundary();
    const result = await operation;
    assert.equal(result.outcome, 'superseded');
    assert.deepEqual(store.read(original.id), winner, 'repair refusal leaves the exact concurrent Run untouched');
    assert.equal(entered, 0, 'the final synchronous boundary refuses repair provider entry after the CAS loses');
  });

  it('preserves unknown repair CAS and the primary admission refusal if reconciliation fails', async (t) => {
    for (const mode of ['missing-cas', 'throwing-cas', 'reconciliation-write-failure'] as const) await t.test(mode, async () => {
      const original = repairChangesRun(`repair-final-refusal-${mode}`);
      const backing = new MemoryStore();
      backing.create(original);
      const primary = new Error('repair mission admission generation changed');
      const secondary = new Error('repair Run-store reconciliation lock failed');
      let boundary = false;
      let failChangedWrite = false;
      let denyAdmission = false;
      let entered = 0;
      let handoff: Run | undefined;
      const store: RunStore = {
        name: `repair-final-refusal-${mode}`,
        create: (run) => backing.create(run), read: (id) => backing.read(id), update: (run) => backing.update(run),
        list: () => backing.list(), delete: (id) => backing.delete(id),
        get updateIfUnchanged() {
          if (boundary && mode === 'missing-cas') return undefined;
          if (boundary && mode === 'throwing-cas') return () => { throw primary; };
          return (expected: Run, next: Run) => {
            if (failChangedWrite && JSON.stringify(expected) !== JSON.stringify(next)) throw secondary;
            return backing.updateIfUnchanged(expected, next);
          };
        },
      };
      const implementation: ImplementationAgent = {
        kind: 'implementation-agent',
        async run(request) {
          handoff = store.read(original.id)!;
          boundary = true;
          if (mode === 'reconciliation-write-failure') {
            denyAdmission = true;
            failChangedWrite = true;
          }
          request.beforeExecution?.();
          entered += 1;
          return successResult(HEAD2);
        },
      };
      const invoke = runReviewLoop({
        store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
        resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
        assertCurrentMutation: () => { if (denyAdmission) throw primary; },
      }, original.id, { maxAttempts: 3, now: () => T0 });
      await assert.rejects(invoke, (error) => {
        assert.equal(isExecutionAdmissionRefusal(error), true);
        if (!isExecutionAdmissionRefusal(error)) return false;
        assert.equal(error.authorityUnknown, mode !== 'reconciliation-write-failure');
        if (mode === 'throwing-cas') assert.equal(error.cause, primary);
        if (mode === 'reconciliation-write-failure') {
          assert.equal(error.cause, primary, 'the original admission error remains primary');
          assert.notEqual(error.cause, secondary, 'secondary reconciliation failure does not replace the tagged refusal');
        }
        return true;
      });
      assert.equal(entered, 0, 'repair worker entry remains refused');
      assert.deepEqual(backing.read(original.id), handoff, 'failed refusal reconciliation does not write a fabricated or generic failed Run');
    });
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
