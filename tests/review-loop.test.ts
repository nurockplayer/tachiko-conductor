import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, ReviewResult, Run } from '../src/domain/types.js';
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

function reviewingRun(headSha = HEAD, id = 'run-1'): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha }, T0);
  run = applyTransition(run, { type: 'validation_passed' }, T0);
  return run;
}

function snapshot(headSha: string | null): GitHubLiveSnapshot {
  return {
    repository: { owner: 'acme', repo: 'widgets' },
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

  constructor(private readonly outcomes: Array<ReviewResult>) {}

  async review(request: ReviewRequest): Promise<ReviewResult> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No review outcome queued');
    return outcome;
  }
}

class FakeImplementation implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  readonly requests: Array<{ baseSha: string; instructions: string | undefined }> = [];

  constructor(private readonly outcomes: AgentResult[]) {}

  async run(request: { target: unknown; baseSha: string; instructions?: string }): Promise<AgentResult> {
    this.requests.push({ baseSha: request.baseSha, instructions: request.instructions });
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
  it('advances an approved review through the final gate to MERGE_READY', async () => {
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
    assert.equal(result.run.state, 'MERGE_READY');
    const persisted = store.read('run-1');
    assert.equal(persisted?.state, 'MERGE_READY');
    assert.ok(persisted?.history.some((entry) => entry.type === 'gate_passed'));
  });

  it('routes REQUEST_CHANGES through the fix loop back to a re-review that approves', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2, 'fixed')]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'approved');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(result.run.headSha, HEAD2);
    assert.deepEqual(implementation.requests[0]?.instructions, '1. [blocking] the diff has a bug');
    assert.deepEqual(reviewer.requests.map((request) => request.headSha), [HEAD, HEAD2]);
  });

  it('escalates to NEEDS_HUMAN when the review loop exceeds maxAttempts', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD), requestChanges(HEAD2)]);
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD, HEAD2]), implementation, reviewer },
      'run-1',
      { maxAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /did not converge/);
    assert.equal(implementation.requests.length, 1);
  });

  it('fails the run when the implementation cannot fix the findings', async () => {
    const store = new MemoryStore();
    store.create(reviewingRun());
    const reviewer = new FakeReviewer([requestChanges(HEAD)]);
    const implementation = new FakeImplementation([failureResult('agent crashed')]);

    const result = await runReviewLoop(
      { store, github: githubAdapter([HEAD]), implementation, reviewer },
      'run-1',
      { maxAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'failed');
    assert.equal(result.run.state, 'FAILED');
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
    assert.match(result.reason, /No live PR HEAD/);
  });
});
