import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import type {
  ImplementationBootstrapAdapter,
  PlanImplementationBootstrapRequest,
  PrepareImplementationBootstrapRequest,
  VerifyDurableImplementationRequest,
} from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, ImplementationBootstrapIdentity, ReviewResult, Run } from '../src/domain/types.js';
import { ReviewerError } from '../src/reviewers/deepseek.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import type { RunStore } from '../src/store/json-file-store.js';
import { TARGET, failureResult, successResult } from './helpers.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HEAD3 = 'cccccccccccccccccccccccccccccccccccccccc';

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

  list(): Run[] {
    return [...this.runs.values()];
  }

  delete(id: string): void {
    this.runs.delete(id);
  }
}

function reviewingRun(headSha = HEAD, id = 'run-1', sessionId?: string): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  const agentResult = { ...successResult(headSha), ...(sessionId === undefined ? {} : { sessionId }) };
  run = applyTransition(run, { type: 'agent_succeeded', agentResult, headSha }, T0);
  run = applyTransition(run, { type: 'validation_passed', pullRequest: { number: 7, headSha } }, T0);
  return run;
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
      workspacePath: request.workspacePath,
      branch: request.branch,
    });
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No implementation outcome queued');
    return outcome;
  }
}

class FakeBootstrap implements ImplementationBootstrapAdapter {
  readonly kind: 'implementation-bootstrap' = 'implementation-bootstrap';
  readonly prepareRequests: PrepareImplementationBootstrapRequest[] = [];
  readonly verifyRequests: VerifyDurableImplementationRequest[] = [];

  async plan(_request: PlanImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    throw new Error('plan is not used for an existing review fix');
  }

  async prepare(request: PrepareImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    this.prepareRequests.push(request);
    if (request.existing === undefined) throw new Error('expected persisted bootstrap identity');
    return request.existing;
  }

  async verifyDurable(request: VerifyDurableImplementationRequest): Promise<{ headSha: string; branch: string }> {
    this.verifyRequests.push(request);
    return { headSha: request.expectedHeadSha, branch: request.identity.branch };
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
  it('refuses to review a different pull request even when it has the same HEAD', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      pullRequest: { ...snapshot(HEAD).pullRequest!, id: 'PR_8', number: 8 },
    });
    const reviewer = new FakeReviewer([approve(HEAD)]);

    const outcome = await runReviewLoop(
      { store, github, implementation: new FakeImplementation([]), reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /pull request #8.*pull request #7/i);
    assert.equal(reviewer.requests.length, 0);
  });

  it('refuses a PR-number switch before invoking a review fix', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    let reads = 0;
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => {
      reads += 1;
      if (reads === 1) return snapshot(HEAD);
      return {
        ...snapshot(HEAD2),
        pullRequest: { ...snapshot(HEAD2).pullRequest!, id: 'PR_8', number: 8 },
      };
    };
    const reviewer = new FakeReviewer([requestChanges(HEAD)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const outcome = await runReviewLoop(
      { store, github, implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /pull request #8.*pull request #7/i);
    assert.equal(reviewer.requests.length, 1);
    assert.equal(implementation.requests.length, 0);
  });

  it('persists an approved review at FINAL_GATE for the final-gate workflow', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([approve(HEAD)]);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'FINAL_GATE');
    const persisted = store.read('run-1');
    assert.equal(persisted?.state, 'FINAL_GATE');
    assert.equal(persisted?.history.some((entry) => entry.type === 'gate_passed'), false);
  });

  it('routes REQUEST_CHANGES through the fix loop back to a re-review that approves', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2, 'fixed')]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'FINAL_GATE');
    assert.equal(result.run.headSha, HEAD2);
    assert.deepEqual(implementation.requests[0]?.instructions, '1. [blocking] the diff has a bug');
    assert.deepEqual(reviewer.requests.map((request) => request.headSha), [HEAD, HEAD2]);
  });

  it('reconstructs and verifies the persisted bootstrap workspace for review fixes', async () => {
    const store = new MemoryStore();
    const bootstrapIdentity = {
      owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: 'd'.repeat(40),
      branch: 'tachiko/issue-42', workspacePath: '/tmp/tachiko/run-1',
    } as const;
    store.create({ ...reviewingRun(), bootstrap: bootstrapIdentity });
    const bootstrap = new FakeBootstrap();
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      {
        store,
        github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]),
        bootstrap,
        implementation,
        reviewer: new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]),
      },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.deepEqual(bootstrap.prepareRequests[0]?.existing, bootstrapIdentity);
    assert.equal(bootstrap.verifyRequests[0]?.expectedHeadSha, HEAD2);
    assert.equal(implementation.requests[0]?.workspacePath, bootstrapIdentity.workspacePath);
    assert.equal(implementation.requests[0]?.branch, bootstrapIdentity.branch);
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD2 });
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.deepEqual(implementation.requests[0]?.executor, {
      provider: 'codex-cli',
      sessionId: 'thread-42',
    });
  });

  it('escalates to NEEDS_HUMAN when the review loop exceeds maxAttempts', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), requestChanges(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /did not converge/);
    assert.equal(implementation.requests.length, 1);
  });

  it('derives the attempt budget from persisted history after re-entry', async () => {
    const store = new MemoryStore();
    const requested = requestChanges(HEAD);
    const interrupted = applyTransition(
      reviewingRun(),
      { type: 'changes_requested', reviewResult: requested },
      T0,
    );
    store.create(interrupted);
    const reviewer = new FakeReviewer([]);
    const implementation = new FakeImplementation([]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([]), implementation, reviewer },
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
      { store, github: githubAdapter([HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'FINAL_GATE');
    assert.equal(implementation.requests.length, 1);
  });

  it('resumes a persisted CHANGES_REQUESTED run by fixing before re-reviewing', async () => {
    const store = new MemoryStore();
    const requested = requestChanges(HEAD);
    store.create(applyTransition(reviewingRun(), { type: 'changes_requested', reviewResult: requested }, T0));
    const reviewer = new FakeReviewer([approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'FINAL_GATE');
    assert.equal(implementation.requests[0]?.baseSha, HEAD);
    assert.deepEqual(reviewer.requests.map((reviewRequest) => reviewRequest.headSha), [HEAD2]);
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
      },
      'fatal-run',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(fatalResult.outcome, 'failed');
    assert.equal(fatalResult.run.state, 'FAILED');
    assert.match(fatalResult.reason, /REVIEW_INVALID_OUTPUT/);
  });

  it('fails the run when the implementation cannot fix the findings', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD)]);
    const implementation = new FakeImplementation([failureResult('agent crashed')]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'failed');
    assert.equal(result.run.state, 'FAILED');
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
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer },
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
      { store, github: githubAdapter([HEAD2]), implementation, reviewer },
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
      { store, github: githubAdapter([null]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /no longer has persisted pull request #7/i);
    assert.deepEqual(result.run.interrupt?.choices, [
      'Resolve the pull request identity conflict and retry',
      'Cancel the run',
    ]);
  });
});
