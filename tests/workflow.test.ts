import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest, McpHttpCapability } from '../src/adapters/agent.js';
import { WorkspaceGuardFailure } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter, VerifyDurableRequest } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import type { ValidationAdapter, ValidationRequest } from '../src/adapters/validation.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { projectRunEfficiency } from '../src/domain/telemetry.js';
import type { AgentResult, LocalValidationEvidence, ReviewResult, Run } from '../src/domain/types.js';
import type { RunStore } from '../src/store/json-file-store.js';
import { EXECUTION_CONFIGURATION_ERROR_CODE, type ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { runWorkflow } from '../src/workflow/run.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { TARGET, TEST_VALIDATION_AUTHORITY, failureResult, successResult, validationFailed, validationPassed } from './helpers.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_HOSTED_POLICY = { revision: 'test-hosted-policy-v1', policy: { mode: 'required' as const } };

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
    pullRequest: { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: '', headSha, baseSha, headRef: 'tachiko/issue-42-test', headRepository: { owner: 'acme', repo: 'widgets' }, baseRef: 'main' },
    headSha,
    checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: T0,
  };
}

function githubAdapter(liveHeads: Array<string | null>): GitHubAdapter {
  let latest: string | null | undefined;
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
      const queued = liveHeads.shift();
      if (queued !== undefined) latest = queued;
      const head = queued ?? latest;
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

class FakeValidation implements ValidationAdapter {
  readonly kind = 'validation' as const;
  readonly configRevision: string;
  readonly requests: ValidationRequest[] = [];

  constructor(private readonly outcomes: LocalValidationEvidence[] = [], revision = 'test-config-v1') {
    this.configRevision = revision;
  }

  async validate(request: ValidationRequest): Promise<LocalValidationEvidence> {
    this.requests.push(request);
    return this.outcomes.shift() ?? { ...validationPassed(request.headSha).local, configRevision: this.configRevision };
  }
}

class FakeBootstrap implements ImplementationBootstrapAdapter {
  readonly kind = 'implementation-bootstrap' as const;
  readonly bootstrapKind = 'linked-worktree' as const;
  readonly identity = {
    bootstrapKind: 'linked-worktree' as const,
    owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: 'base',
    branch: 'tachiko/issue-42-test', workspacePath: '/tmp/tachiko-workspace',
  };
  async plan() { return this.identity; }
  async prepare(..._args: unknown[]) { return this.identity; }
  guard() { return { assertValid: () => undefined }; }
  async verifyDurable(request: { expectedHeadSha: string }) { return { headSha: request.expectedHeadSha, branch: this.identity.branch }; }
}

class GuardFailingImplementation implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  calls = 0;
  async run(): Promise<AgentResult> {
    this.calls += 1;
    throw new WorkspaceGuardFailure(new Error('common Git directory changed'));
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
  run = applyTransition(run, {
    type: 'validation_passed',
    validationResult: validationPassed(headSha),
    pullRequest: { number: 7, headSha },
  }, T0);
  store.create(run);
  return run;
}

describe('runWorkflow', () => {
  it('adopts an existing Luna PR from its authoritative base and head when default-branch fields are unavailable', async () => {
    const store = new MemoryStore();
    const execution: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'profiles-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const,
    };
    const planned: Array<{ baseBranch: string; baseSha: string }> = [];
    const verified: Array<Record<string, unknown>> = [];
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
      async plan(request) {
        planned.push({ baseBranch: request.baseBranch, baseSha: request.baseSha });
        return { bootstrapKind: 'standalone-isolated', owner: 'acme', repo: 'widgets', issueNumber: 42,
          baseBranch: request.baseBranch, baseSha: request.baseSha, branch: 'tachiko/issue-42-test', workspacePath: '/tmp/luna-existing' };
      },
      async prepare(request) { return request.existing; },
      guard() { return { assertValid: () => undefined }; },
      async verifyDurable(request) { verified.push(request as unknown as Record<string, unknown>); return { headSha: request.expectedHeadSha, branch: 'tachiko/issue-42-test' }; },
    };
    const github: GitHubAdapter = githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD]);
    const originalRead = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await originalRead(target);
      return { ...live, repository: { ...live.repository, defaultBranch: null, defaultBranchHeadSha: null } };
    };
    const run = createRun(TARGET, T0, 'luna-existing-pr', execution);
    store.create(run);
    const implementation = new FakeImplementation([]);
    const outcome = await runWorkflow(
      { store, github, implementation, bootstrapForExecution: () => bootstrap, reviewer: new FakeReviewer([approve(HEAD)]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id, { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(outcome.outcome, 'merge_ready');
    assert.deepEqual(planned, [{ baseBranch: 'main', baseSha: 'base' }]);
    assert.equal(implementation.requests.length, 0);
    assert.equal(verified[0]?.adoptExistingHead, true);
    assert.equal(verified[0]?.progressBaseSha, 'base');
  });

  it('fails closed in VALIDATING when no explicit local validation adapter is configured', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-missing');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);

    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      checks: { availability: 'available', overall: 'pending', checks: [] },
    });
    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]) },
      run.id, { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(result.run.validationResult?.status, 'unknown');
    assert.equal(result.run.validationResult?.hosted.status, 'unknown');
  });

  it('F06 persists incoherent local validation evidence as a durable fail-closed interrupt', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-incoherent-adapter');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const incoherentValidation: ValidationAdapter = {
      kind: 'validation', configRevision: 'test-config-v1',
      async validate() {
        return { status: 'passed', configRevision: 'test-config-v1', commands: [] } as unknown as LocalValidationEvidence;
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([]),
        validation: incoherentValidation,
        hostedCheckPolicy: TEST_HOSTED_POLICY,
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(result.run.validationResult?.status, 'unknown');
    assert.equal(result.run.validationResult?.local.status, 'unknown');
    assert.equal(result.run.history.at(-1)?.type, 'escalate');
  });

  it('F06 rejects failed local evidence that contradicts its zero exit code', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-failed-zero-exit');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const incoherentValidation: ValidationAdapter = {
      kind: 'validation', configRevision: 'test-config-v1',
      async validate() {
        return {
          status: 'failed', configRevision: 'test-config-v1',
          commands: [{ commandIndex: 0, executable: 'test', outcome: 'failed', exitCode: 0, durationMs: 1 }],
        } as unknown as LocalValidationEvidence;
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([]),
        validation: incoherentValidation,
        hostedCheckPolicy: TEST_HOSTED_POLICY,
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(result.run.validationResult?.status, 'unknown');
    assert.equal(result.run.validationResult?.local.status, 'unknown');
  });

  it('F06 revalidates stale persisted failed evidence before any implementation repair', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-failure-policy-drift');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, {
      type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD,
      pullRequest: { number: 7, headSha: HEAD },
    }, T0);
    run = applyTransition(run, { type: 'validation_failed', validationResult: validationFailed(HEAD) }, T0);
    store.create(run);
    const implementation = new FakeImplementation([]);

    const result = await runWorkflow(
      {
        store,
        github: githubAdapter([HEAD]),
        implementation,
        reviewer: new FakeReviewer([approve(HEAD)]),
        validation: new FakeValidation([], 'test-config-v2'),
        hostedCheckPolicy: TEST_HOSTED_POLICY,
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests.length, 0);
    assert.equal(result.run.history.some((entry) => entry.type === 'revalidate'), true);
    assert.equal(result.run.validationResult?.local.configRevision, 'test-config-v2');
  });

  it('persists local evidence while hosted checks wait, then resumes with a fresh hosted pass', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-wait');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const validation = new FakeValidation();
    const pending = { ...snapshot(HEAD), checks: { availability: 'available' as const, overall: 'pending' as const, checks: [] } };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => pending;

    const waiting = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation, hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id, { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(waiting.run.state, 'WAITING_DEPENDENCY');
    assert.equal(waiting.run.validationResult?.status, 'waiting');
    assert.equal(validation.requests.length, 1);

    store.update(applyTransition(waiting.run, { type: 'dependency_satisfied', reason: 'Retry readiness checks' }, T0));
    const revisedValidation = new FakeValidation([], 'test-config-v2');
    const resumed = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([approve(HEAD)]), validation: revisedValidation, hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id, { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(resumed.outcome, 'merge_ready');
    assert.equal(resumed.run.validationResult?.status, 'passed');
    assert.equal(validation.requests.length, 1);
    assert.equal(revisedValidation.requests.length, 1);
  });

  it('routes same-PR exact-HEAD hosted failures observed during local validation through repair without reviewer admission', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-post-await-hosted-failure');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);

    let hostedFailed = false;
    const github: GitHubAdapter = {
      kind: 'github',
      async readIssue() { throw new Error('unused'); },
      async readBranch() { throw new Error('unused'); },
      async listPullRequests() { throw new Error('unused'); },
      async readLiveSnapshot() {
        const state = hostedFailed ? 'failing' as const : 'passing' as const;
        return {
          ...snapshot(HEAD),
          checks: { availability: 'available', overall: state, checks: [{ id: 'ci', name: 'ci', state, url: null, updatedAt: T0 }] },
        };
      },
    };
    const validation: ValidationAdapter = {
      kind: 'validation',
      configRevision: 'test-config-v1',
      async validate(request) {
        await Promise.resolve();
        hostedFailed = true;
        return { ...validationPassed(request.headSha).local, configRevision: 'test-config-v1' };
      },
    };
    let reviewerCalls = 0;
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review(request) {
        reviewerCalls += 1;
        return approve(request.headSha);
      },
    };

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer, validation, hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.validationResult?.status, 'failed');
    assert.equal(result.run.validationResult?.hosted.status, 'failed');
    assert.equal(reviewerCalls, 0);
    assert.ok(result.run.history.some((entry) => entry.type === 'validation_failed'));
  });

  it('does not treat unavailable hosted checks as a passing validation source', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-hosted-unavailable');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      checks: { availability: 'unavailable', overall: 'passing', checks: [] },
    });

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id, { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.validationResult?.status, 'unknown');
    assert.equal(result.run.validationResult?.hosted.status, 'unknown');
  });

  it('keeps an explicit not-required hosted policy neutral when its observation endpoint is unavailable', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-hosted-neutral');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => ({
      ...snapshot(HEAD),
      checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
    });

    const result = await runWorkflow(
      {
        store,
        github,
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([approve(HEAD)]),
        validation: new FakeValidation(),
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'not_required' } },
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.validationResult?.hosted.status, 'not_required');
  });

  it('parks an anonymous configured validation adapter before it can execute or enter review', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-anonymous');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    let calls = 0;
    const anonymous = {
      kind: 'validation' as const,
      async validate() {
        calls += 1;
        return validationPassed(HEAD).local;
      },
    } as unknown as ValidationAdapter;

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: anonymous, hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(calls, 0);
    assert.match(result.reason, /no usable stable revision/i);
  });

  it('does not re-review a persisted run after its configured validation authority loses identity', async () => {
    const store = new MemoryStore();
    reviewingRun(store, 'review-anonymous', HEAD);
    let reviewCalls = 0;
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review() {
        reviewCalls += 1;
        return approve(HEAD);
      },
    };
    const anonymous = {
      kind: 'validation' as const,
      async validate() { return validationPassed(HEAD).local; },
    } as unknown as ValidationAdapter;

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation: new FakeImplementation([]), reviewer, validation: anonymous, hostedCheckPolicy: TEST_HOSTED_POLICY },
      'review-anonymous',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(reviewCalls, 0);
  });

  it('routes a failed validation through a bounded implementation repair instead of terminal failure', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'validation-failure-repair');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    store.create(run);
    const implementation = new FakeImplementation([successResult(HEAD2, 'repair failed validation')]);
    const result = await runWorkflow(
      {
        store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation,
        reviewer: new FakeReviewer([approve(HEAD2)]),
        validation: new FakeValidation([validationFailed(HEAD).local]), hostedCheckPolicy: TEST_HOSTED_POLICY,
      },
      run.id, { maxReviewAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests.length, 1);
    assert.equal(result.run.headSha, HEAD2);
  });

  it('drives READY → implementation → review changes → fix → PASS → MERGE_READY', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    const implementation = new FakeImplementation([successResult(HEAD), successResult(HEAD2, 'fixed')]);
    const reviewer = new FakeReviewer([requestChanges(HEAD), approve(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(result.run.headSha, HEAD2);
    assert.ok(store.read('run-1')?.history.some((entry) => entry.type === 'final_gate_verified'));
  });

  it('persists structured run telemetry and does not double-count on terminal re-entry', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-telemetry'));
    const implementation = new FakeImplementation([{
      ...successResult(HEAD),
      telemetry: {
        provider: 'codex-app-server',
        model: 'configured-model',
        reasoningEffort: 'high',
        turns: 3,
        usage: { inputTokens: 1_000, cachedInputTokens: 900, outputTokens: 50, reasoningTokens: 10 },
        context: { initialTokens: 300, peakTokens: 1_000 },
        largestToolResultBytes: 4_096,
        capability: { source: 'runtime-discovery', revision: 'codex-app-server:model/list', verified: true },
      },
    }]);
    const reviewer = new FakeReviewer([{
      ...approve(HEAD),
      telemetry: {
        provider: 'deepseek-reviewer',
        model: 'reviewer-model',
        turns: 1,
        usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 25 },
      },
    }]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-telemetry',
      { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.agentResult?.telemetry, undefined, 'provider details live only in the run telemetry ledger');
    assert.equal(result.run.reviewResult?.telemetry, undefined, 'reviewer details live only in the run telemetry ledger');
    const projection = projectRunEfficiency(result.run);
    assert.deepEqual(projection.metrics.modelTurns, { status: 'observed', value: 4 });
    assert.deepEqual(projection.metrics.inputTokens, { status: 'observed', value: 1_500 });
    assert.deepEqual(projection.metrics.cachedInputTokens, { status: 'observed', value: 900 });
    assert.deepEqual(projection.metrics.workerStarts, { status: 'observed', value: 1 });
    assert.equal(projection.invocations[0]?.provider, 'codex-app-server');
    assert.equal(projection.invocations[0]?.model, 'configured-model');
    assert.equal(projection.invocations[0]?.reasoningEffort, 'high');
    assert.deepEqual(projection.metrics.reviewerStarts, { status: 'observed', value: 1 });
    assert.equal(projection.metrics.largestToolResultBytes.status, 'partial');
    assert.deepEqual(
      result.run.telemetry?.events.filter((event) => event.kind === 'completion').map((event) => event.capability?.source),
      ['runtime-discovery', undefined],
    );

    const eventCount = result.run.telemetry?.events.length;
    const rerun = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-telemetry',
      { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(rerun.outcome, 'merge_ready');
    assert.equal(rerun.run.telemetry?.events.length, eventCount);
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
        github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]),
        implementation,
        reviewer,
        validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        resolveImplementationCapabilities: async () => [capabilities[capabilityIndex++]!],
      },
      'run-capability',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(capabilityIndex, 2);
    assert.deepEqual(implementation.requests.map((request) => request.capabilities), [[capabilities[0]], [capabilities[1]]]);
  });

  it('CAS-fences initial and resumed workers after capabilities resolve against concurrent human and HEAD/PR changes', async (t) => {
    for (const phase of ['initial', 'resumed'] as const) {
      for (const change of ['human', 'head_pr'] as const) {
        await t.test(`${phase}/${change}`, async () => {
          const store = new MemoryStore();
          let run = createRun(TARGET, T0, `capability-${phase}-${change}`);
          if (phase === 'resumed') run = applyTransition(run, { type: 'start' }, T0);
          store.create(run);
          const implementation = new FakeImplementation([successResult(HEAD)]);
          let concurrent: Run | undefined;
          const result = await runWorkflow({
            store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]),
            resolveImplementationCapabilities: async () => {
              const current = store.read(run.id)!;
              concurrent = change === 'human'
                ? applyTransition(current, { type: 'escalate', reason: 'Concurrent cancel decision', interrupt: { evidence: 'cancel', choices: ['Cancel the run'] } }, T0)
                : { ...current, headSha: HEAD2, pullRequest: { number: 8, headSha: HEAD2 } };
              store.update(concurrent);
              return [];
            },
          }, run.id, { maxReviewAttempts: 2, now: () => T0 });
          assert.equal(result.outcome, 'needs_human');
          assert.equal(implementation.requests.length, 0, 'capability resolver yielded after the initial/resume worker snapshot became stale');
          assert.deepEqual(store.read(run.id), concurrent, 'stale worker admission preserves concurrent Run state');
        });
      }
    }
  });

  it('CAS-fences success and failure completion against concurrent Run changes during the worker', async (t) => {
    for (const mode of ['success', 'failure'] as const) {
      await t.test(mode, async () => {
        const store = new MemoryStore();
        const initial = createRun(TARGET, T0, `completion-${mode}-race`);
        store.create(initial);
        let concurrent: Run | undefined;
        const implementation = {
          kind: 'implementation-agent' as const,
          async run() {
            const current = store.read(initial.id)!;
            concurrent = applyTransition(current, {
              type: 'escalate', reason: `Concurrent decision during worker ${mode}`,
              interrupt: { evidence: `concurrent-${mode}`, choices: ['Cancel the run'] },
            }, T0);
            store.update(concurrent);
            if (mode === 'failure') throw new Error('synthetic worker failure');
            return successResult(HEAD);
          },
        };
        const result = await runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) }, initial.id, { maxReviewAttempts: 2, now: () => T0 });
        assert.equal(result.outcome, 'needs_human');
        assert.deepEqual(store.read(initial.id), concurrent, 'worker completion/failure telemetry must not overwrite the concurrent decision');
      });
    }
  });

  it('CAS-fences result-derived Run writes after the post-worker GitHub await', async () => {
    const store = new MemoryStore();
    const initial = createRun(TARGET, T0, 'post-worker-github-race');
    store.create(initial);
    let workerCompleted = false;
    let concurrent: Run | undefined;
    const implementation = {
      kind: 'implementation-agent' as const,
      async run() { workerCompleted = true; return successResult(HEAD); },
    };
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD]);
    const readLiveSnapshot = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const result = await readLiveSnapshot(target);
      if (workerCompleted && concurrent === undefined) {
        const current = store.read(initial.id)!;
        concurrent = applyTransition(current, {
          type: 'escalate', reason: 'Concurrent cancellation while validating worker output',
          interrupt: { evidence: 'cancel-after-worker', choices: ['Cancel the run'] },
        }, T0);
        store.update(concurrent);
      }
      return result;
    };
    const result = await runWorkflow({ store, github, implementation, reviewer: new FakeReviewer([]) }, initial.id, { maxReviewAttempts: 2, now: () => T0 });
    assert.equal(result.outcome, 'needs_human');
    assert.deepEqual(store.read(initial.id), concurrent, 'the final result-to-Run association uses CAS after GitHub resolution');
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

  it('records a configuration preflight rejection distinctly from an executed runtime failure', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-preflight'));
    const implementation = new FakeImplementation([{
      exitStatus: 'failure',
      summary: 'Reasoning effort "medium" is unsupported by codex-app-server model "deepseek-flash".',
      diagnostics: [
        `${EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT}: Reasoning effort "medium" is unsupported by codex-app-server model "deepseek-flash"; the provider reports low, high, max.`,
      ],
      durationMs: 0,
    }]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) },
      'run-preflight',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.run.state, 'FAILED');
    // The durable evidence keeps the configuration code, so a preflight
    // rejection is countable apart from an executed model/runtime failure.
    assert.ok(
      result.run.agentResult?.diagnostics?.[0]?.startsWith(EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT),
      `expected a typed configuration code, got ${JSON.stringify(result.run.agentResult?.diagnostics)}`,
    );
    assert.equal(result.run.agentResult?.durationMs, 0);
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
    const github = githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]);

    const parked = await runReviewLoop(
      {
        store,
        github,
        implementation,
        reviewer,
        resolveValidationAuthority: () => ({
          local: { kind: 'configured' as const, revision: 'test-config-v1' },
          hosted: { kind: 'configured' as const, revision: 'test-hosted-policy-v1', mode: 'required' as const },
        }),
      },
      'run-resume-fix',
      { maxAttempts: 3, now: () => T0 },
    );
    assert.equal(parked.outcome, 'needs_human');
    const resumed = applyTransition(parked.run, { type: 'human_resolved', reason: '2FA complete' }, T0);
    store.update(resumed);

    const result = await runWorkflow(
      { store, github, implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
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
      { store, github: githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
  });

  it('passes the final gate for a persisted run already parked in FINAL_GATE', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    store.update(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
  });

  it('preserves a concurrent Run change made while the FINAL_GATE live read is pending', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'final-gate-run-cas', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    store.update(run);
    let entered!: () => void;
    let finish!: (live: GitHubLiveSnapshot) => void;
    const readEntered = new Promise<void>((resolve) => { entered = resolve; });
    const liveRead = new Promise<GitHubLiveSnapshot>((resolve) => { finish = resolve; });
    const base = githubAdapter([]);
    const github: GitHubAdapter = { ...base, async readLiveSnapshot() { entered(); return liveRead; } };

    const pending = runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );
    await readEntered;
    const concurrent = store.read(run.id)!;
    store.update(applyTransition(concurrent, { type: 'escalate', reason: 'operator cancellation won during live read' }, T0));
    finish(snapshot(HEAD));

    const outcome = await pending;
    assert.equal(outcome.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.history.some((entry) => entry.type === 'final_gate_verified'), false);
  });

  it('does not proceed to a worker when the Run changes during awaited bootstrap planning', async () => {
    const store = new MemoryStore();
    const execution: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-cas-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      sandboxMode: 'workspace-write', approvalPolicy: 'never',
    };
    const run = createRun(TARGET, T0, 'bootstrap-plan-run-cas', execution);
    store.create(run);
    let entered!: () => void;
    let finish!: () => void;
    const planEntered = new Promise<void>((resolve) => { entered = resolve; });
    const planRelease = new Promise<void>((resolve) => { finish = resolve; });
    const bootstrap = new class extends FakeBootstrap {
      override async plan() { entered(); await planRelease; return this.identity; }
    }();
    const implementation = new FakeImplementation([]);
    const pending = runWorkflow(
      { store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );
    await planEntered;
    const concurrent = store.read(run.id)!;
    store.update(applyTransition(concurrent, { type: 'escalate', reason: 'operator cancellation won during plan' }, T0));
    finish();

    const outcome = await pending;
    assert.equal(outcome.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.bootstrap, undefined);
    assert.equal(implementation.requests.length, 0);
  });

  it('does not proceed to a worker when the Run changes during awaited bootstrap preparation', async () => {
    const store = new MemoryStore();
    const execution: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-prepare-cas-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      sandboxMode: 'workspace-write', approvalPolicy: 'never',
    };
    const run = createRun(TARGET, T0, 'bootstrap-prepare-run-cas', execution);
    store.create(run);
    let entered!: () => void;
    let finish!: () => void;
    const prepareEntered = new Promise<void>((resolve) => { entered = resolve; });
    const prepareRelease = new Promise<void>((resolve) => { finish = resolve; });
    const bootstrap = new class extends FakeBootstrap {
      override async prepare() { entered(); await prepareRelease; return this.identity; }
    }();
    const implementation = new FakeImplementation([]);
    const pending = runWorkflow(
      { store, github: githubAdapter([null, null]), implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );
    await prepareEntered;
    const concurrent = store.read(run.id)!;
    store.update(applyTransition(concurrent, { type: 'escalate', reason: 'operator cancellation won during prepare' }, T0));
    finish();

    const outcome = await pending;
    assert.equal(outcome.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.state, 'NEEDS_HUMAN');
    assert.equal(implementation.requests.length, 0);
  });

  it('does not record recovered durable output when the Run changes during awaited recovery verification', async () => {
    const store = new MemoryStore();
    const execution: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-recovery-cas-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      sandboxMode: 'workspace-write', approvalPolicy: 'never',
    };
    let run = createRun(TARGET, T0, 'bootstrap-recovery-run-cas', execution);
    run = applyTransition(run, { type: 'start' }, T0);
    const baseBootstrap = new FakeBootstrap();
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: baseBootstrap.identity }, T0);
    store.create(run);
    let entered!: () => void;
    let finish!: () => void;
    const verifyEntered = new Promise<void>((resolve) => { entered = resolve; });
    const verifyRelease = new Promise<void>((resolve) => { finish = resolve; });
    const bootstrap = new class extends FakeBootstrap {
      override async verifyDurable(request: VerifyDurableRequest) {
        entered(); await verifyRelease;
        return { headSha: request.expectedHeadSha, branch: this.identity.branch };
      }
    }();
    const implementation = new FakeImplementation([]);
    const pending = runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD]), implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );
    await verifyEntered;
    const concurrent = store.read(run.id)!;
    store.update(applyTransition(concurrent, { type: 'escalate', reason: 'operator cancellation won during recovery' }, T0));
    finish();

    const outcome = await pending;
    assert.equal(outcome.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.headSha, undefined);
    assert.equal(implementation.requests.length, 0);
  });

  it('rechecks the exact durable Run immediately before standalone publication', async () => {
    const store = new MemoryStore();
    const run = createRun(TARGET, T0, 'pre-push-run-cas');
    store.create(run);
    let publicationAttempts = 0;
    const bootstrap = new class extends FakeBootstrap {
      override async verifyDurable(request: VerifyDurableRequest) {
        const concurrent = store.read(run.id)!;
        store.update(applyTransition(concurrent, { type: 'escalate', reason: 'operator cancellation won before push' }, T0));
        request.beforePublish?.();
        publicationAttempts += 1;
        return { headSha: request.expectedHeadSha, branch: this.identity.branch };
      }
    }();
    const outcome = await runWorkflow(
      { store, github: githubAdapter([null, null, HEAD]), implementation: new FakeImplementation([successResult(HEAD)]), reviewer: new FakeReviewer([]), bootstrap },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(outcome.run.state, 'NEEDS_HUMAN');
    assert.equal(store.read(run.id)?.state, 'NEEDS_HUMAN');
    assert.equal(publicationAttempts, 0);
  });

  it('passes a synchronous worker publication fence that rejects stale Run and admission authority', async (t) => {
    for (const mode of ['run-changed', 'admission-stale'] as const) {
      await t.test(mode, async () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-worker-publish-fence-'));
        const registry = new MissionAdmissionRegistry({
          filePath: path.join(directory, 'registry.json'),
          config: { schemaVersion: 1, revision: 'worker-publish-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        });
        const id = `worker-publish-fence-${mode}`;
        const admitted = registry.admit({
          laneId: 'captain', role: 'production_captain',
          evidence: { repository: 'acme/widgets', issue: 42, run: id },
        });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') return;
        try {
          const store = new MemoryStore();
          const run = createRun(TARGET, T0, id);
          store.create(run);
          let callbackCalls = 0;
          let implementationCalls = 0;
          let escapedFailure: Error | undefined;
          const implementation: ImplementationAgent = {
            kind: 'implementation-agent',
            async run(request) {
              implementationCalls += 1;
              assert.equal(typeof request.beforePublish, 'function', 'runWorkflow passes a host-only synchronous publication fence');
              if (mode === 'run-changed') {
                const current = store.read(id)!;
                store.update(applyTransition(current, { type: 'escalate', reason: 'operator cancellation while worker is running' }, T0));
              } else {
                registry.release(admitted.token, true);
              }
              try {
                request.beforePublish!();
                callbackCalls += 1;
                return successResult(HEAD);
              } catch (error) {
                escapedFailure = error instanceof Error ? error : new Error(String(error));
                return failureResult('worker publication authority rejected');
              }
            },
          };
          const github = githubAdapter([null, null]);
          let pullRequestCreates = 0;
          github.createImplementationPullRequest = async () => { pullRequestCreates += 1; return { number: 8 }; };
          const outcome = await runWorkflow(
            { store, github, implementation, bootstrap: new FakeBootstrap(), reviewer: new FakeReviewer([]) }, id,
            {
              maxReviewAttempts: 1, now: () => T0,
              admissionFence: {
                registry, token: admitted.token, productionMissionId: admitted.missionId,
                executionWorkspace: '/tmp/tachiko-workspace',
              },
            },
          );

          assert.equal(callbackCalls, 0, 'a rejected fence cannot pass control to publication');
          assert.ok(escapedFailure?.message.includes(mode === 'run-changed' ? 'Run changed' : 'Admission generation token is stale'),
            `callback refusal should reach the worker: calls=${implementationCalls}, outcome=${JSON.stringify(outcome)}`);
          assert.equal(pullRequestCreates, 0, 'no PR publication follows a refused worker publication fence');
          if (mode === 'run-changed') {
            assert.equal(outcome.outcome, 'needs_human');
            assert.equal(store.read(id)?.state, 'NEEDS_HUMAN', 'the concurrent durable Run remains authoritative');
          } else {
            assert.equal(outcome.outcome, 'failed');
            assert.equal(registry.snapshot().lanes.find((lane) => lane.laneId === admitted.token.laneId)?.status, 'released');
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  });

  it('rechecks publication admission after live review and before readiness is published', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-final-gate-fence-'));
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'final-gate-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const admitted = registry.admit({ laneId: 'captain', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42 } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') return;
    try {
      const store = new MemoryStore();
      let run = reviewingRun(store, 'stale-final-gate-fence', HEAD);
      run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
      store.update(run);
      const baseGithub = githubAdapter([HEAD]);
      let livePublicationCalls = 0;
      const github: GitHubAdapter = {
        ...baseGithub,
        async readLiveSnapshot(target) {
          const live = await baseGithub.readLiveSnapshot(target);
          registry.release(admitted.token, true);
          return live;
        },
        async createImplementationPullRequest() { livePublicationCalls += 1; return { number: 8 }; },
      };

      await assert.rejects(runWorkflow(
        {
          store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]),
          validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        },
        run.id,
        {
          maxReviewAttempts: 1,
          now: () => T0,
          admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId },
        },
      ), /Admission generation token is stale/);

      const persisted = store.read(run.id)!;
      assert.equal(persisted.state, 'FINAL_GATE');
      assert.equal(persisted.history.some((entry) => entry.type === 'final_gate_verified'), false);
      assert.equal(livePublicationCalls, 0, 'stale generation cannot publish merge readiness or an implementation PR');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('strengthens from the reconciled live PR before a second Issue can start bootstrap or a worker', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-live-pr-overlap-'));
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'live-pr-overlap-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } },
    });
    const store = new MemoryStore();
    const run = createRun(TARGET, T0, 'live-pr-candidate');
    store.create(run);
    const candidate = registry.admit({ laneId: 'run:live-pr-candidate', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, run: run.id }, highAutonomy: true });
    const existing = registry.admit({ laneId: 'other-issue-pr-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 41, pullRequest: 7, run: 'other-run' }, highAutonomy: true });
    assert.equal(candidate.outcome, 'admitted');
    assert.equal(existing.outcome, 'admitted');
    if (candidate.outcome !== 'admitted') return;
    try {
      const implementation = new FakeImplementation([]);
      let publications = 0;
      const github: GitHubAdapter = {
        ...githubAdapter([HEAD]),
        async createImplementationPullRequest() { publications += 1; return { number: 8 }; },
      };
      await assert.rejects(runWorkflow(
        {
          store, github, implementation, reviewer: new FakeReviewer([]),
          bootstrap: new FakeBootstrap(), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        },
        run.id,
        { maxReviewAttempts: 1, now: () => T0, admissionFence: { registry, token: candidate.token, productionMissionId: candidate.missionId, executionWorkspace: '/tmp/tachiko-ambient' } },
      ), /Strengthened ownership evidence overlaps reserved lane "other-issue-pr-owner"/);
      assert.equal(implementation.requests.length, 0);
      assert.equal(publications, 0);
      assert.equal(store.read(run.id)?.bootstrap, undefined, 'the PR overlap is rejected before workspace planning or prepare');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('returns a terminal outcome for a run already in MERGED without looping', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = { ...run, state: 'MERGE_READY', history: [...run.history, { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
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
      { store, github: githubAdapter([null, null, HEAD, HEAD, HEAD, HEAD, HEAD]), implementation, reviewer, bootstrap: new FakeBootstrap(), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(implementation.requests[0]?.baseSha, 'base');
    assert.match(implementation.requests[0]?.instructions ?? '', /start from main@base/);
    assert.match(implementation.requests[0]?.instructions ?? '', /create and associate an open implementation pull request/);
  });

  it('binds an existing Luna PR head as recovery authority before standalone prepare', async () => {
    class RecordingBootstrap extends FakeBootstrap {
      prepareRequest: unknown;
      override async prepare(request: unknown) { this.prepareRequest = request; return this.identity; }
    }
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'existing-luna', execution));
    const bootstrap = new RecordingBootstrap();
    await runWorkflow({ store, github: githubAdapter([HEAD, HEAD]), implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap }, 'existing-luna', { maxReviewAttempts: 1, now: () => T0 });
    assert.deepEqual((bootstrap.prepareRequest as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
  });

  it('keeps Luna packets host-bounded and never resolves browser or MCP capabilities', async () => {
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'luna-no-capabilities', execution));
    const implementation = new FakeImplementation([failureResult('bounded failure')]);
    let resolved = 0;
    await runWorkflow(
      { store, github: githubAdapter([null, null]), implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => new FakeBootstrap(),
        resolveImplementationCapabilities: async () => { resolved += 1; return [{ kind: 'mcp-http', name: 'tachiko_browser', endpoint: 'http://127.0.0.1:1/mcp' }]; } },
      'luna-no-capabilities', { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.equal(resolved, 0);
    assert.equal(implementation.requests[0]?.capabilities, undefined);
    assert.equal(implementation.requests[0]?.instructions,
      'Task title: Fix the widget\n\nTask requirements:\nDoR-ready.\n\nIsolated Luna contract: implement only the host-bounded task and its tests; run the required tests; commit one clean exact HEAD. Do not push and do not create or associate a pull request; the trusted host owns publication and pull-request actions.');
    assert.doesNotMatch(implementation.requests[0]?.instructions ?? '', /create and associate an open implementation pull request/);
    assert.equal(implementation.requests[0]?.supplementalInstructions, undefined);
  });

  it('accepts case-only same-repository identity for an existing Luna PR', async () => {
    class RecordingBootstrap extends FakeBootstrap {
      prepareRequest: unknown;
      override async prepare(request: unknown) { this.prepareRequest = request; return this.identity; }
    }
    const github = githubAdapter([HEAD, HEAD]);
    const original = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await original(target);
      return { ...live, pullRequest: { ...live.pullRequest!, headRepository: { owner: 'ACME', repo: 'WIDGETS' } } };
    };
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'luna-case-repository', execution));
    const bootstrap = new RecordingBootstrap();
    await runWorkflow({ store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap }, 'luna-case-repository', { maxReviewAttempts: 1, now: () => T0 });
    assert.deepEqual((bootstrap.prepareRequest as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
  });

  it('parks an existing Luna run when its authoritative PR tuple drifts after prepare', async () => {
    class RecordingBootstrap extends FakeBootstrap {
      prepareRequest: unknown;
      override async prepare(request: unknown) { this.prepareRequest = request; return this.identity; }
    }
    const stable = snapshot(HEAD);
    const drifted: GitHubLiveSnapshot = {
      ...snapshot(HEAD),
      pullRequest: {
        ...snapshot(HEAD).pullRequest!,
        number: 8,
        baseRef: 'release',
        headRef: 'tachiko/unexpected-branch',
      },
    };
    let reads = 0;
    const github: GitHubAdapter = {
      kind: 'github',
      async readIssue() { throw new Error('unused'); },
      async readBranch() { throw new Error('unused'); },
      async listPullRequests() { throw new Error('unused'); },
      async readLiveSnapshot() { return reads++ === 0 ? stable : drifted; },
    };
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'existing-luna-drift', execution));
    const bootstrap = new RecordingBootstrap();
    const implementation = new FakeImplementation([]);

    const result = await runWorkflow(
      { store, github, implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap },
      'existing-luna-drift', { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.deepEqual((bootstrap.prepareRequest as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /does not match the persisted branch and repository identity|Initial recovery PR or HEAD changed/);
    assert.equal(implementation.requests.length, 0);
  });

  it('parks an existing Luna run when only its authoritative PR base SHA drifts after prepare', async () => {
    class RecordingBootstrap extends FakeBootstrap {
      override async prepare(request: unknown) { return this.identity; }
    }
    const stable = snapshot(HEAD);
    const drifted: GitHubLiveSnapshot = {
      ...snapshot(HEAD),
      pullRequest: { ...snapshot(HEAD).pullRequest!, baseSha: 'c'.repeat(40) },
    };
    let reads = 0;
    const github: GitHubAdapter = {
      kind: 'github',
      async readIssue() { throw new Error('unused'); },
      async readBranch() { throw new Error('unused'); },
      async listPullRequests() { throw new Error('unused'); },
      async readLiveSnapshot() { return reads++ === 0 ? stable : drifted; },
    };
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'existing-luna-base-sha-drift', execution));
    const implementation = new FakeImplementation([]);

    const result = await runWorkflow(
      { store, github, implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => new RecordingBootstrap() },
      'existing-luna-base-sha-drift', { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /Initial recovery PR or HEAD changed/);
    assert.equal(implementation.requests.length, 0);
  });

  it('parks a provider-neutral workspace guard failure instead of terminal agent failure', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-guard'));
    const implementation = new GuardFailingImplementation();
    const result = await runWorkflow(
      { store, github: githubAdapter([null, null]), implementation, reviewer: new FakeReviewer([]), bootstrap: new FakeBootstrap() },
      'run-guard', { maxReviewAttempts: 3, now: () => T0 },
    );
    assert.equal(result.outcome, 'needs_human');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /WORKSPACE_GUARD_FAILURE/);
    assert.equal(implementation.calls, 1);
  });

  it('recovers a crash after a durable PR exists but before the run recorded its HEAD', async () => {
    const store = new MemoryStore();
    let run = applyTransition(createRun(TARGET, T0, 'run-crash-window'), { type: 'start' }, T0);
    run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: new FakeBootstrap().identity }, T0);
    store.create(run);
    const implementation = new FakeImplementation([]);
    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([approve(HEAD)]), bootstrap: new FakeBootstrap(), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-crash-window', { maxReviewAttempts: 3, now: () => T0 },
    );
    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.headSha, HEAD);
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
      { store, github: githubAdapter([HEAD2, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
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
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = applyTransition(run, { type: 'start_fix' }, T0);
    store.update(run);
    const implementation = new FakeImplementation([successResult(HEAD2, 'fixed after restart')]);
    const reviewer = new FakeReviewer([approve(HEAD2)]);

    const result = await runWorkflow(
      { store, github: githubAdapter([HEAD, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation, reviewer, validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(implementation.requests[0]?.baseSha, HEAD);
    assert.equal(implementation.requests[0]?.instructions, '1. [blocking] the diff has a bug');
  });

  it('reconstructs a standalone workspace before resuming a promoted Luna repair', async () => {
    const store = new MemoryStore();
    const luna: ResolvedExecutionConfiguration = {
      profile: 'routine', revision: 'luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
    };
    let run = reviewingRun(store, 'resume-promoted-luna', HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = {
      ...run,
      repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
      repairAdmissions: [{
        authorityRevision: 'task-shape-v1', taskShape: 'bounded', taxonomyRevision: 'repair-finding-taxonomy-v1',
        finding: 'review_blocking', headSha: HEAD, pullRequestNumber: 7, executionProfile: 'routine',
        executionRevision: 'luna-v1', execution: luna, admittedAt: T0,
      }],
    };
    run = applyTransition(run, { type: 'start_fix' }, T0);
    store.update(run);
    const identity = {
      bootstrapKind: 'standalone-isolated' as const, owner: 'acme', repo: 'widgets', issueNumber: 42,
      baseBranch: 'main', baseSha: 'base', branch: 'tachiko/resume-promoted-luna', publicationBranch: 'existing-pr', workspacePath: '/tmp/resume-promoted-luna',
    };
    const prepared: unknown[] = [];
    const bootstrap: ImplementationBootstrapAdapter = {
      kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
      async plan() { return identity; },
      async prepare(request) { prepared.push(request); return identity; },
      guard() { return { assertValid: () => undefined }; },
      async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: identity.branch }; },
    };
    const linked = new FakeBootstrap();
    const github = githubAdapter([HEAD, HEAD, HEAD2, HEAD2, HEAD2, HEAD2]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, pullRequest: { ...live.pullRequest!, headRef: 'existing-pr', baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' } } };
    };
    const implementation = new FakeImplementation([successResult(HEAD2)]);

    const result = await runWorkflow(
      { store, github, implementation, reviewer: new FakeReviewer([approve(HEAD2)]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        bootstrapForExecution: (execution) => execution?.executor === 'luna-isolated' ? bootstrap : linked, resolveRepairExecutionProfile: () => luna },
      run.id, { maxReviewAttempts: 2, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready', result.outcome === 'needs_human' ? result.reason : undefined);
    assert.deepEqual((prepared[0] as { recoveryAuthority?: unknown }).recoveryAuthority, { expectedHeadSha: HEAD });
    assert.equal(implementation.requests[0]?.workspacePath, identity.workspacePath);
    assert.match(implementation.requests[0]?.instructions ?? '', /Task title: Fix the widget/);
    assert.match(implementation.requests[0]?.instructions ?? '', /Task requirements:\nDoR-ready\./);
    assert.match(implementation.requests[0]?.instructions ?? '', /Repair requirements:\n1\. \[blocking\] the diff has a bug/);
    assert.equal(store.read(run.id)?.bootstrap?.bootstrapKind, 'standalone-isolated');
  });

  it('never passes the final gate when live HEAD drifted after approval', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
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
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    store.update(run);
    const pending = { ...snapshot(HEAD), checks: { availability: 'available' as const, overall: 'pending' as const, checks: [] } };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => pending;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'waiting_dependency');
    assert.equal(result.run.state, 'WAITING_DEPENDENCY');
    assert.deepEqual(result.run.interrupt?.choices, ['Retry readiness checks', 'Cancel the run']);
  });

  it('fails closed when review-thread state is unavailable at the final gate', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    store.update(run);
    const unavailable = {
      ...snapshot(HEAD),
      reviews: { ...snapshot(HEAD).reviews, unresolvedThreads: null },
    };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => unavailable;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /review thread state is unavailable/);
  });

  it('blocks a non-clean REST mergeable state at the final gate', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    store.update(run);
    const blocked = {
      ...snapshot(HEAD),
      pullRequest: { ...snapshot(HEAD).pullRequest!, mergeStateStatus: 'blocked' },
    };
    const github = githubAdapter([]);
    github.readLiveSnapshot = async () => blocked;

    const result = await runWorkflow(
      { store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY },
      'run-1',
      { maxReviewAttempts: 3, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /merge state is BLOCKED/);
  });
});
