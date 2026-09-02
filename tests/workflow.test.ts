import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest, McpHttpCapability } from '../src/adapters/agent.js';
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
import type { RunStore } from '../src/store/json-file-store.js';
import { runWorkflow, SYNC_LIVE_HEAD_DECISION } from '../src/workflow/run.js';
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

class FakeBootstrap implements ImplementationBootstrapAdapter {
  readonly kind: 'implementation-bootstrap' = 'implementation-bootstrap';
  readonly prepareRequests: PrepareImplementationBootstrapRequest[] = [];
  readonly planRequests: PlanImplementationBootstrapRequest[] = [];
  readonly verifyRequests: VerifyDurableImplementationRequest[] = [];

  constructor(
    private readonly verifyError?: Error,
    private readonly prepareError?: Error,
  ) {}

  async plan(request: PlanImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    this.planRequests.push(request);
    return {
      owner: request.target.owner,
      repo: request.target.repo,
      issueNumber: request.target.issueNumber,
      baseBranch: request.baseBranch,
      baseSha: request.baseSha,
      branch: `tachiko/issue-${request.target.issueNumber}`,
      workspacePath: `/tmp/tachiko-workspaces/${request.runId}`,
    };
  }

  async prepare(request: PrepareImplementationBootstrapRequest): Promise<ImplementationBootstrapIdentity> {
    this.prepareRequests.push(request);
    if (this.prepareError !== undefined) throw this.prepareError;
    if (request.existing === undefined) throw new Error('expected persisted bootstrap identity');
    return request.existing;
  }

  async verifyDurable(request: VerifyDurableImplementationRequest): Promise<{ headSha: string; branch: string }> {
    this.verifyRequests.push(request);
    if (this.verifyError !== undefined) throw this.verifyError;
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

/** A run driven to REVIEWING at a HEAD, ready for the review loop. */
function reviewingRun(store: RunStore, id = 'run-1', headSha = HEAD): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(headSha), headSha }, T0);
  run = applyTransition(run, { type: 'validation_passed', pullRequest: { number: 7, headSha } }, T0);
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2]), implementation, reviewer },
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
        github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2]),
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
        executor: { provider: 'codex-cli', sessionId: 'thread-takeover' },
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
    assert.deepEqual(result.run.executor, { provider: 'codex-cli', sessionId: 'thread-takeover' });
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
        executor: { provider: 'codex-cli', sessionId: 'thread-fix' },
      },
      successResult(HEAD2, 'fixed after takeover'),
    ]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2]);

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
    assert.deepEqual(implementation.requests[1]?.executor, {
      provider: 'codex-cli',
      sessionId: 'thread-fix',
    });
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2]), implementation, reviewer },
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
    const bootstrap = new FakeBootstrap();

    const result = await runWorkflow(
      { store, github: githubAdapter([null, HEAD, HEAD, HEAD]), bootstrap, implementation, reviewer },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(implementation.requests[0]?.baseSha, 'base');
    assert.equal(implementation.requests[0]?.branch, 'tachiko/issue-42');
    assert.equal(implementation.requests[0]?.workspacePath, '/tmp/tachiko-workspaces/run-1');
    assert.match(implementation.requests[0]?.instructions ?? '', /prepared branch tachiko\/issue-42 from main@base/);
    assert.match(implementation.requests[0]?.instructions ?? '', /create one associated open implementation pull request/);
    assert.equal(bootstrap.prepareRequests.length, 1);
    assert.equal(bootstrap.planRequests.length, 1);
    assert.equal(bootstrap.verifyRequests.length, 1);
    assert.equal(result.run.bootstrap?.baseSha, 'base');
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD });
  });

  it('fails closed when validation reports a HEAD without an associated open PR identity', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-inconsistent-pr'));
    let reads = 0;
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => {
      reads += 1;
      if (reads === 1) return { ...snapshot(HEAD), headSha: null, pullRequest: null };
      return { ...snapshot(HEAD), pullRequest: null };
    };

    const result = await runWorkflow(
      {
        store,
        github,
        bootstrap: new FakeBootstrap(),
        implementation: new FakeImplementation([successResult(HEAD)]),
        reviewer: new FakeReviewer([]),
      },
      'run-inconsistent-pr',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /no associated open pull request/);
    assert.equal(result.run.pullRequest, undefined);
  });

  it('recovers the same persisted bootstrap after branch creation without creating a duplicate identity', async () => {
    const store = new MemoryStore();
    const bootstrap = new FakeBootstrap();
    let run = applyTransition(createRun(TARGET, T0, 'run-restart'), { type: 'start' }, T0);
    const identity = await bootstrap.plan({
      runId: run.id,
      target: TARGET,
      baseBranch: 'main',
      baseSha: 'base',
    });
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    store.create(run);
    bootstrap.prepareRequests.length = 0;
    const implementation = new FakeImplementation([successResult(HEAD)]);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([null, HEAD, HEAD, HEAD]),
        bootstrap,
        implementation,
        reviewer: new FakeReviewer([approve(HEAD)]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.deepEqual(bootstrap.prepareRequests[0]?.existing, identity);
    assert.equal(bootstrap.prepareRequests.length, 1);
    assert.deepEqual(result.run.bootstrap, identity);
  });

  it('recovers the persisted bootstrap after the commit-and-push checkpoint but before PR creation', async () => {
    const store = new MemoryStore();
    const planner = new FakeBootstrap();
    let run = applyTransition(createRun(TARGET, T0, 'run-commit-pushed'), { type: 'start' }, T0);
    const identity = await planner.plan({
      runId: run.id,
      target: TARGET,
      baseBranch: 'main',
      baseSha: 'base',
    });
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    store.create(run);
    let recoveredCommitPush = false;
    const checkpointBootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap',
      async plan() {
        throw new Error('persisted planning must be reused');
      },
      async prepare(request) {
        assert.deepEqual(request.existing, identity);
        recoveredCommitPush = true;
        return identity;
      },
      async verifyDurable(request) {
        assert.equal(recoveredCommitPush, true);
        assert.deepEqual(request.identity, identity);
        return { headSha: request.expectedHeadSha, branch: identity.branch };
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([null, HEAD, HEAD, HEAD]),
        bootstrap: checkpointBootstrap,
        implementation: new FakeImplementation([successResult(HEAD)]),
        reviewer: new FakeReviewer([approve(HEAD)]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(recoveredCommitPush, true);
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD });
  });

  it('discovers an already-created PR before retry and reuses the persisted branch/workspace', async () => {
    const store = new MemoryStore();
    const bootstrap = new FakeBootstrap();
    let run = applyTransition(createRun(TARGET, T0, 'run-pr-restart'), { type: 'start' }, T0);
    const identity = await bootstrap.plan({
      runId: run.id,
      target: TARGET,
      baseBranch: 'main',
      baseSha: 'base',
    });
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    store.create(run);
    bootstrap.prepareRequests.length = 0;
    const implementation = new FakeImplementation([successResult(HEAD)]);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD, HEAD, HEAD, HEAD]),
        bootstrap,
        implementation,
        reviewer: new FakeReviewer([approve(HEAD)]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(bootstrap.prepareRequests.length, 1);
    assert.deepEqual(bootstrap.prepareRequests[0]?.existing, identity);
    assert.equal(implementation.requests[0]?.workspacePath, identity.workspacePath);
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD });
  });

  it('uses an existing associated PR without starting bootstrap mechanics', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-existing-pr'));
    const bootstrap = new FakeBootstrap();

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD, HEAD, HEAD, HEAD]),
        bootstrap,
        implementation: new FakeImplementation([successResult(HEAD)]),
        reviewer: new FakeReviewer([approve(HEAD)]),
      },
      'run-existing-pr',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(bootstrap.prepareRequests.length, 0);
    assert.equal(bootstrap.verifyRequests.length, 0);
  });

  it('fails closed when durable verification finds only ephemeral implementation state', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-ephemeral'));
    const bootstrap = new FakeBootstrap(new Error('workspace is dirty'));

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([null]),
        bootstrap,
        implementation: new FakeImplementation([{
          ...successResult(HEAD),
          executor: { provider: 'codex-cli', sessionId: 'thread-ephemeral' },
        }]),
        reviewer: new FakeReviewer([]),
      },
      'run-ephemeral',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /workspace is dirty/);
    assert.deepEqual(result.run.executor, { provider: 'codex-cli', sessionId: 'thread-ephemeral' });
    assert.equal(result.run.agentResult, undefined);
  });

  it('does not invoke implementation when restart recovery finds a dirty workspace', async () => {
    const store = new MemoryStore();
    const planner = new FakeBootstrap();
    let run = applyTransition(createRun(TARGET, T0, 'run-dirty-recovery'), { type: 'start' }, T0);
    const identity = await planner.plan({
      runId: run.id,
      target: TARGET,
      baseBranch: 'main',
      baseSha: 'base',
    });
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
    store.create(run);
    const implementation = new FakeImplementation([]);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([null]),
        bootstrap: new FakeBootstrap(undefined, new Error('workspace has uncommitted state')),
        implementation,
        reviewer: new FakeReviewer([]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /uncommitted state/);
    assert.equal(implementation.requests.length, 0);
  });

  it('refuses to invoke implementation when live authority says the Issue is closed', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-closed'));
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      issue: { ...snapshot(HEAD).issue, state: 'closed' },
      pullRequest: null,
      headSha: null,
    });
    const implementation = new FakeImplementation([]);

    const result = await runWorkflow(
      { store, github, bootstrap: new FakeBootstrap(), implementation, reviewer: new FakeReviewer([]) },
      'run-closed',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /no longer open/);
    assert.equal(implementation.requests.length, 0);
  });

  it('restores the persisted provider-neutral executor after a restart', async () => {
    const store = new MemoryStore();
    let run = applyTransition(createRun(TARGET, T0, 'run-1'), { type: 'start' }, T0);
    run = {
      ...run,
      headSha: HEAD,
      executor: { provider: 'codex-cli', sessionId: 'thread-from-disk' },
      agentResult: {
        ...successResult(HEAD),
        executor: { provider: 'codex-cli', sessionId: 'thread-from-disk' },
      },
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
    assert.deepEqual(implementation.requests[0]?.executor, {
      provider: 'codex-cli',
      sessionId: 'thread-from-disk',
    });
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
      SYNC_LIVE_HEAD_DECISION,
      'Cancel the run',
    ]);
  });

  it('syncs and freshly re-reviews a same-PR HEAD advance from the final gate', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-final-sync', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const parked = await runWorkflow(
      { store, github: githubAdapter([HEAD2]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );
    assert.equal(parked.outcome, 'needs_human');
    const resumed = applyTransition(
      parked.run,
      { type: 'human_resolved', reason: SYNC_LIVE_HEAD_DECISION, headSha: HEAD2 },
      T0,
    );
    store.update(resumed);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD2, HEAD2, HEAD2]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([approve(HEAD2)]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD2 });
  });

  it('syncs and freshly reviews a same-PR HEAD advance observed before review', async () => {
    const store = new MemoryStore();
    const run = reviewingRun(store, 'run-review-sync', HEAD);
    const parked = await runWorkflow(
      { store, github: githubAdapter([HEAD2]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );
    assert.equal(parked.outcome, 'needs_human');
    assert.deepEqual(parked.run.interrupt?.choices, [SYNC_LIVE_HEAD_DECISION, 'Cancel the run']);
    const resumed = applyTransition(
      parked.run,
      { type: 'human_resolved', reason: SYNC_LIVE_HEAD_DECISION, headSha: HEAD2 },
      T0,
    );
    store.update(resumed);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD2, HEAD2, HEAD2]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([approve(HEAD2)]),
      },
      run.id,
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.deepEqual(result.run.pullRequest, { number: 7, headSha: HEAD2 });
  });

  it('never passes the final gate when live authority switches PR number at the approved HEAD', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-pr-switch', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0);
    store.update(run);
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      pullRequest: { ...snapshot(HEAD).pullRequest!, id: 'PR_8', number: 8 },
    });

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      'run-pr-switch',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /pull request #8.*pull request #7/i);
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
