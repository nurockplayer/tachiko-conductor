import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import type { ProcessRunner } from '../src/github/transport.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition, type ActiveValidationConfiguration } from '../src/domain/state-machine.js';
import type { ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import type { AgentResult, ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import { ReviewerError } from '../src/reviewers/deepseek.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { TARGET, failureResult, successResult, validationPassed } from './helpers.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';

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

class ConcurrentAdmissionStore extends MemoryStore {
  private attempts = 0;

  constructor(private readonly concurrent: Run) { super(); }

  override updateIfUnchanged(expected: Run, next: Run): boolean {
    this.attempts += 1;
    if (this.attempts === 1) {
      this.update(this.concurrent);
      return false;
    }
    this.update(next);
    return true;
  }
}

class CasMemoryStore extends MemoryStore {
  override updateIfUnchanged(expected: Run, next: Run): boolean {
    const current = this.read(expected.id);
    if (current === null || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.update(next);
    return true;
  }
}

class SpawnRaceStore extends CasMemoryStore {
  private attempts = 0;
  constructor(private readonly concurrent: Run) { super(); }

  override updateIfUnchanged(expected: Run, next: Run): boolean {
    this.attempts += 1;
    if (this.attempts === 2) {
      this.update(this.concurrent);
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
  readonly requests: Array<{
    baseSha: string;
    instructions: string | undefined;
    sessionId: string | undefined;
    executor: ImplementationRequest['executor'];
    execution: ImplementationRequest['execution'];
    capabilities: ImplementationRequest['capabilities'];
    workspacePath: string | undefined;
    branch: string | undefined;
  }> = [];

  constructor(private readonly outcomes: AgentResult[]) {}

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
    const implementation = new FakeImplementation([]);

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
    const implementation = new FakeImplementation([]);
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
    const implementation = new FakeImplementation([successResult(HEAD2)]);
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
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github, implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        bootstrapForExecution: () => bootstrap, resolveRepairExecutionProfile: () => luna },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'revalidating');
    assert.deepEqual(planned, [{ runId: run.id, target: TARGET, baseBranch: 'main', baseSha: 'base', publicationBranch: 'existing-pr' }]);
    assert.deepEqual((prepared[0] as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
    assert.equal(implementation.requests[0]?.workspacePath, identity.workspacePath);
    assert.equal(implementation.requests[0]?.branch, identity.branch);
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

  it('does not spawn after a concurrent transition wins the post-admission telemetry fence', async () => {
    const initial = repairChangesRun('post-admission-race');
    const started = applyTransition(initial, { type: 'start_fix' }, T0);
    const concurrent = applyTransition(started, { type: 'escalate', reason: 'concurrent cancellation' }, T0);
    const store = new SpawnRaceStore(concurrent);
    store.create(initial);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]), resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
      initial.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(store.read(initial.id)?.state, 'NEEDS_HUMAN');
    assert.equal(implementation.requests.length, 0);
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
    assert.equal(result.outcome, 'needs_human');
    assert.equal(implementation.requests.length, 0);
    assert.equal(result.run.interrupt?.reason, concurrent.interrupt?.reason);
    assert.deepEqual(store.read(original.id), concurrent, 'stale reconciliation must preserve the concurrent cancel decision byte-for-byte');
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

  it('does not overwrite a concurrent Run when a repair worker completes or throws', async (t) => {
    for (const mode of ['success', 'failure'] as const) {
      await t.test(mode, async () => {
        const original = repairChangesRun(`repair-worker-${mode}-race`);
        const store = new CasMemoryStore();
        store.create(original);
        const concurrent = applyTransition(original, {
          type: 'escalate', reason: `Concurrent human decision during ${mode} worker`,
          interrupt: { evidence: `concurrent-${mode}`, choices: ['Cancel the run'] },
        }, T0);
        const implementation = {
          kind: 'implementation-agent' as const,
          async run() {
            store.update(concurrent);
            if (mode === 'failure') throw new Error('synthetic worker invocation failure');
            return successResult(HEAD2);
          },
        };
        const result = await runReviewLoop({
          store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]),
          resolveValidationAuthority: reviewAuthority,
          resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION,
        }, original.id, { maxAttempts: 3, now: () => T0 });
        assert.equal(result.outcome, 'needs_human');
        assert.equal(result.run.interrupt?.reason, concurrent.interrupt?.reason);
        assert.deepEqual(store.read(original.id), concurrent, 'completion or failure telemetry must use CAS and preserve concurrent Run state');
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

  it('durably parks stale repair admission when CAS is unavailable without calling a writer or reviewer', async () => {
    const backing = new MemoryStore();
    const store: RunStore = {
      name: 'no-cas', create: (run) => backing.create(run), read: (id) => backing.read(id),
      update: (run) => backing.update(run), list: () => backing.list(), delete: (id) => backing.delete(id),
    };
    const run = repairChangesRun('repair-no-cas');
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.interrupt?.reason, 'Repair admission parked: admission_stale.');
    assert.equal(implementation.requests.length, 0);
    assert.equal(reviewer.requests.length, 0);
  });

  it('retries stale admission parking from a concurrent nonterminal snapshot without calling a writer or reviewer', async () => {
    const run = repairChangesRun('repair-cas-race');
    const concurrent = applyTransition(run, { type: 'start_fix' }, T0);
    const store = new ConcurrentAdmissionStore(concurrent);
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority,
        resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
      run.id, { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.interruptedFrom, 'IMPLEMENTING');
    assert.equal(implementation.requests.length, 0);
    assert.equal(reviewer.requests.length, 0);
  });

  it('preserves an already parked or terminal concurrent admission snapshot without writer or reviewer calls', async () => {
    for (const state of ['parked', 'terminal'] as const) {
      const run = repairChangesRun(`repair-${state}`);
      const concurrent = state === 'parked'
        ? applyTransition(run, { type: 'escalate', reason: 'concurrent human decision' }, T0)
        : applyTransition(run, { type: 'fail', reason: 'concurrent failure' }, T0);
      const store = new ConcurrentAdmissionStore(concurrent);
      store.create(run);
      const implementation = new FakeImplementation([]);
      const reviewer = new FakeReviewer([]);

      const result = await runReviewLoop(
        { store, github: githubAdapter([HEAD]), implementation, reviewer, resolveValidationAuthority: reviewAuthority,
          resolveRepairExecutionProfile: () => ROUTINE_REPAIR_EXECUTION },
        run.id, { maxAttempts: 3, now: () => T0 },
      );

      assert.equal(result.run.state, concurrent.state, state);
      assert.equal(store.read(run.id)?.state, concurrent.state, state);
      assert.equal(implementation.requests.length, 0, state);
      assert.equal(reviewer.requests.length, 0, state);
    }
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
