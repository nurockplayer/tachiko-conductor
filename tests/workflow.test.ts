import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest, McpHttpCapability } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, ReviewResult, Run } from '../src/domain/types.js';
import type { RunStore } from '../src/store/json-file-store.js';
import { runWorkflow } from '../src/workflow/run.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { TARGET, failureResult, successResult } from './helpers.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

function snapshot(headSha: string, baseSha = 'base'): GitHubLiveSnapshot {
  return {
    repository: { owner: 'acme', repo: 'widgets', defaultBranch: 'main', defaultBranchHeadSha: baseSha },
    issue: {
      id: 'I_42',
      number: 42,
      title: 'Fix the widget',
      body: 'DoR-ready.',
      state: 'open',
      url: '',
      createdAt: T0,
      updatedAt: T0,
    },
    pullRequest: { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: '', headSha, baseSha },
    headSha,
    checks: { availability: 'available', overall: 'passing', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
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
      if (head === null) return { ...snapshot(HEAD), headSha: null, pullRequest: null };
      return snapshot(head);
    },
  };
}

class FakeReviewer implements ReviewerAdapter {
  readonly kind: 'reviewer' = 'reviewer';

  constructor(private readonly outcomes: ReviewResult[]) {}

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No review outcome queued');
    return outcome;
  }
}

class FakeImplementation implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  readonly requests: ImplementationRequest[] = [];

  constructor(private readonly outcomes: AgentResult[]) {}

  async run(request: ImplementationRequest): Promise<AgentResult> {
    this.requests.push(request);
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

/** A run driven to REVIEWING at a HEAD, ready for the review loop. */
function reviewingRun(store: RunStore, id = 'run-1', headSha = HEAD): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha }, T0);
  run = applyTransition(run, { type: 'validation_passed' }, T0);
  store.create(run);
  return run;
}

describe('runWorkflow', () => {
  it('drives READY → implementation → review changes → fix → PASS → MERGE_READY', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    const implementation = new FakeImplementation([successResult(HEAD), successResult(HEAD2, 'fixed')]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(result.run.headSha, HEAD2);
    assert.ok(store.read('run-1')?.history.some((entry) => entry.type === 'gate_passed'));
  });

  it('resolves a fresh ephemeral MCP capability before initial implementation and every review fix', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-capability'));
    const implementation = new FakeImplementation([successResult(HEAD), successResult(HEAD2, 'fixed')]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const capabilities: McpHttpCapability[] = [{
      kind: 'mcp-http',
      name: 'tachiko_browser',
      endpoint: 'http://127.0.0.1:8931/mcp',
    }, {
      kind: 'mcp-http',
      name: 'tachiko_browser',
      endpoint: 'http://127.0.0.1:8932/mcp',
    }];
    let capabilityIndex = 0;

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2]),
        implementation,
        reviewer,
        resolveImplementationCapabilities: async () => [capabilities[capabilityIndex++]!],
      },
      'run-capability',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(capabilityIndex, 2);
    assert.deepEqual(implementation.requests.map((request) => request.capabilities), [[capabilities[0]], [capabilities[1]]]);
  });

  it('fails the run when the implementation agent fails', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    const implementation = new FakeImplementation([failureResult('agent crashed')]);
    const reviewer = new FakeReviewer([]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'failed');
    assert.equal(result.run.state, 'FAILED');
    assert.match(result.reason, /Implementation failed/);
  });

  it('parks in NEEDS_HUMAN when the implementation agent emits the explicit takeover protocol', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-takeover'));
    const implementation = new FakeImplementation([
      {
        exitStatus: 'failure',
        summary: 'login expired',
        diagnostics: ['TACHIKO_NEEDS_HUMAN: login expired'],
      },
    ]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) },
      'run-takeover',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(result.run.interrupt?.reason, 'login expired');
    assert.deepEqual(result.run.interrupt?.choices, ['Complete human bootstrap/takeover and resume', 'Cancel the run']);
  });

  it('resumes an interrupted review fix with the original blocking findings and current HEAD', async () => {
    const store = new MemoryStore();
    reviewingRun(store, 'run-resume-fix');
    const implementation = new FakeImplementation([
      {
        exitStatus: 'failure',
        summary: '2FA required',
        diagnostics: ['TACHIKO_NEEDS_HUMAN: 2FA required'],
      },
      successResult(HEAD2, 'fixed after takeover'),
    ]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const github = githubAdapter([HEAD, HEAD, HEAD2, HEAD2, HEAD2]);

    const parked = await runReviewLoop(
      { store, github, implementation, reviewer },
      'run-resume-fix',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(parked.outcome, 'needs_human');
    const resumed = applyTransition(parked.run, { type: 'human_resolved', reason: '2FA complete' }, T0);
    store.update(resumed);

    const result = await runWorkflow(
      { store, github, implementation, reviewer },
      'run-resume-fix',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests[1]?.baseSha, HEAD);
    assert.match(implementation.requests[1]?.instructions ?? '', /the diff has a bug/);
    assert.doesNotMatch(implementation.requests[1]?.instructions ?? '', /DoR-ready/);
  });

  it('parks in NEEDS_HUMAN with structured context when the review loop cannot converge', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    const implementation = new FakeImplementation([successResult(HEAD), successResult(HEAD2)]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), requestChanges(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /did not converge/);
    assert.ok(result.run.interrupt?.evidence);
    assert.ok((result.run.interrupt?.choices?.length ?? 0) > 0);
  });

  it('resumes a persisted run parked in REVIEWING after a process restart', async () => {
    const store = new MemoryStore();
    reviewingRun(store, 'run-1', HEAD);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([approve(HEAD)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
  });

  it('passes the final gate for a persisted run already parked in FINAL_GATE', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
  });

  it('returns a terminal outcome for a run already in MERGED without looping', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    run = applyTransition(run, { type: 'gate_passed' }, T0);
    run = applyTransition(run, { type: 'merged' }, T0);
    store.update(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const result = await runWorkflow(
      { store, github: githubAdapter([]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merged');
    assert.equal(result.run.state, 'MERGED');
  });

  it('starts from a DoR-ready issue without a pre-existing PR', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    const implementation = new FakeImplementation([successResult(HEAD)]);
    const reviewer = new FakeReviewer([approve(HEAD)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([null, HEAD, HEAD, HEAD]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(implementation.requests[0]?.baseSha, 'base');
    assert.match(implementation.requests[0]?.instructions ?? '', /start from main@base/);
    assert.match(implementation.requests[0]?.instructions ?? '', /create and associate an open implementation pull request/);
  });

  it('restores the persisted implementation session after a restart', async () => {
    const store = new MemoryStore();
    let run = applyTransition(createRun(TARGET, T0, 'run-1'), { type: 'start' }, T0);
    run = {
      ...run,
      headSha: HEAD,
      agentResult: { ...successResult(HEAD), sessionId: 'session-from-disk' },
    };
    store.create(run);
    const implementation = new FakeImplementation([successResult(HEAD2)]);
    const reviewer = new FakeReviewer([approve(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD2, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests[0]?.sessionId, 'session-from-disk');
  });

  it('resumes a persisted in-flight fix with the blocking findings instead of the issue body', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0);
    run = applyTransition(run, { type: 'start_fix' }, T0);
    store.update(run);
    const implementation = new FakeImplementation([successResult(HEAD2, 'fixed after restart')]);
    const reviewer = new FakeReviewer([approve(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD2, HEAD2, HEAD2]), implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests[0]?.baseSha, HEAD);
    assert.equal(implementation.requests[0]?.instructions, '1. [blocking] the diff has a bug');
  });

  it('never passes the final gate when live HEAD drifted after approval', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD2]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.deepEqual(result.run.interrupt?.choices, [
      'Sync the run to the live HEAD and continue',
      'Cancel the run',
    ]);
  });

  it('waits instead of declaring readiness while exact-HEAD checks are pending', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const pending = { ...snapshot(HEAD), checks: { availability: 'available' as const, overall: 'pending' as const, checks: [] } };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => pending;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'WAITING_DEPENDENCY');
    assert.deepEqual(result.run.interrupt?.choices, ['Retry readiness checks', 'Cancel the run']);
  });

  it('fails closed when review-thread state is unavailable at the final gate', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const unavailable = {
      ...snapshot(HEAD),
      reviews: { ...snapshot(HEAD).reviews, unresolvedThreads: null },
    };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => unavailable;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /review thread state is unavailable/);
  });

  it('blocks a non-clean REST mergeable state at the final gate', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const blocked = {
      ...snapshot(HEAD),
      pullRequest: { ...snapshot(HEAD).pullRequest!, mergeStateStatus: 'blocked' },
    };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => blocked;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /merge state is BLOCKED/);
  });
});
