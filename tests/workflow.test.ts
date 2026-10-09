import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest, McpHttpCapability } from '../src/adapters/agent.js';
import { ExecutionAdmissionRefusal, isExecutionAdmissionRefusal, WorkspaceGuardFailure } from '../src/adapters/agent.js';
import type { ImplementationBootstrapAdapter, VerifyDurableRequest } from '../src/adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import { parseAgentHandoffs } from '../src/github/handoff.js';
import type { GitHubApiTransport } from '../src/github/transport.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import type { ValidationAdapter, ValidationRequest } from '../src/adapters/validation.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import { createRepairAdmissionSnapshot, createRepairAttemptBinding } from '../src/domain/repair-admission.js';
import { projectRunEfficiency } from '../src/domain/telemetry.js';
import type { AgentResult, LocalValidationEvidence, ReviewResult, Run } from '../src/domain/types.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { EXECUTION_CONFIGURATION_ERROR_CODE, type ResolvedExecutionConfiguration } from '../src/execution-profiles.js';
import { runWorkflow } from '../src/workflow/run.js';
import { runReviewLoop } from '../src/reviewers/loop.js';
import { MissionAdmissionRegistry } from '../src/mission-admission/registry.js';
import { ImplementationAgentRegistry } from '../src/agents/implementation-router.js';
import { AppServerUnavailableError, CodexAppServerAdapter } from '../src/agents/codex-app-server.js';
import { CodexCliAdapter } from '../src/agents/codex-cli.js';
import { hasGovernedPublicationConfinement } from '../src/agents/luna-isolated.js';
import { WorkerRouterAdapter } from '../src/agents/worker-router.js';
import { TARGET, TEST_VALIDATION_AUTHORITY, failureResult, successResult, validationFailed, validationPassed } from './helpers.js';
import { createBootstrapGitFixture } from './bootstrap-fixture.js';
import { createGenuineLunaFixture } from './support/genuine-luna.js';
import { StandaloneGitBootstrap } from '../src/workspace/standalone-git-bootstrap.js';
import { GitWorktreeBootstrap } from '../src/workspace/git-worktree-bootstrap.js';
import { TOOL_OUTPUT_POLICY_MAXIMA } from '../src/evidence/tool-output.js';
import { DEFAULT_EFFICIENCY_THRESHOLDS, RUN_TELEMETRY_REVISION } from '../src/domain/telemetry.js';

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
    handoff: { sourceId: 'IC_test-scope', sourceScope: 'issue', sourceUpdatedAt: T0,
      sections: { 'Accepted scope': 'Test scope for isolated worker tests.' }, freshness: 'current' },
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
  readonly requests: ReviewRequest[] = [];

  constructor(private readonly outcomes: ReviewResult[]) {}

  async review(request: ReviewRequest): Promise<ReviewResult> {
    this.requests.push(request);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) throw new Error('No review outcome queued');
    return outcome;
  }
}

class FakeImplementation implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  readonly requests: ImplementationRequest[] = [];
  readonly preflightRequests: ImplementationRequest[] = [];

  constructor(private readonly outcomes: AgentResult[]) {}

  prepareGovernedInvocation(request: ImplementationRequest) {
    this.preflightRequests.push(request);
    return { status: 'qualified' as const, agent: this };
  }

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
    branch: 'tachiko/issue-42-test', publicationBranch: 'tachiko/issue-42-test', workspacePath: '/tmp/tachiko-workspace',
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

describe('runWorkflow', { concurrency: false }, () => {
  it('durably holds unsupported governed fresh and continuation runs before spawn telemetry or provider fallback', async (t) => {
    for (const mode of ['fresh', 'continuation', 'unknown-crash', 'forged-preparation'] as const) {
      await t.test(mode, async () => {
        const id = `publication-confinement-${mode}`;
        const store = new MemoryStore();
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-publication-confinement-'));
        const registry = new MissionAdmissionRegistry({
          filePath: path.join(directory, 'registry.json'),
          config: { schemaVersion: 1, revision: 'publication-confinement-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        });
        const admitted = registry.admit({
          laneId: `run:${id}`, role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, run: id },
        });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') return;
        let run = createRun(TARGET, T0, id);
        const codexExecution: ResolvedExecutionConfiguration = { profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 10_000 };
        if (mode === 'unknown-crash') {
          run = { ...run, state: 'IMPLEMENTING' };
        } else if (mode !== 'continuation') {
          run = { ...run, execution: codexExecution };
        } else {
          run = {
            ...run,
            state: 'IMPLEMENTING',
            headSha: HEAD,
            pullRequest: { number: 7, headSha: HEAD },
            executor: { provider: 'codex-app-server', sessionId: 'durable-thread-7', generation: 'exact-run-generation' },
            agentResult: { ...successResult(HEAD), sessionId: 'durable-thread-7' },
          };
        }
        store.create(run);
        let clientOpens = 0;
        let fallbackCalls = 0;
        let forgedInvocations = 0;
        let pullRequestCreates = 0;
        const fallback: ImplementationAgent = {
          kind: 'implementation-agent',
          async run() { fallbackCalls += 1; return successResult(HEAD); },
        };
        const implementation: ImplementationAgent = mode === 'forged-preparation'
          ? {
            kind: 'implementation-agent',
            prepareGovernedInvocation() {
              return {
                status: 'qualified',
                invoke: async () => { forgedInvocations += 1; return successResult(HEAD); },
              } as never;
            },
            async run() { fallbackCalls += 1; return successResult(HEAD); },
          }
          : new ImplementationAgentRegistry({
          defaultProvider: 'codex-cli', legacySessionProvider: 'claude-code',
          providers: {
            'codex-cli': () => new CodexAppServerAdapter({
              clientFactory: { async open() { clientOpens += 1; throw new AppServerUnavailableError('unused'); } },
              fallback,
            }),
            'codex-app-server': () => new CodexAppServerAdapter({
              clientFactory: { async open() { clientOpens += 1; throw new AppServerUnavailableError('unused'); } },
              fallback,
            }),
            'claude-code': () => fallback,
          },
          });
        const github: GitHubAdapter = {
          ...githubAdapter(mode === 'continuation' ? [HEAD] : [null]),
          async createImplementationPullRequest() { pullRequestCreates += 1; return { number: 8 }; },
        };
        const bootstrap = new FakeBootstrap();
        const beforeEvents = run.telemetry?.events.length ?? 0;
        try {
          const outcome = await runWorkflow({
            store, github, implementation, reviewer: new FakeReviewer([]), bootstrap,
          }, id, {
            maxReviewAttempts: 1, now: () => T0,
            admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: bootstrap.identity.workspacePath },
          });

          assert.equal(outcome.outcome, 'needs_human');
          assert.match(outcome.reason, /source-qualified host publication boundary|source-qualified publication preflight|prepared runtime did not present/i);
          assert.equal(clientOpens, 0, 'unsupported App Server execution never opens a child or starts a turn');
          assert.equal(fallbackCalls, 0, 'unsupported App Server does not fall back to a local CLI');
          assert.equal(forgedInvocations, 0, 'workflow never executes a callback supplied by a forged preparation');
          assert.equal(pullRequestCreates, 0, 'the model-free hold performs no host PR write');
          const persisted = store.read(id)!;
          assert.equal(persisted.state, 'NEEDS_HUMAN');
          assert.equal(persisted.telemetry?.events.length ?? 0, beforeEvents, 'hold occurs before implementation spawn telemetry');
          assert.match(persisted.interrupt?.reason ?? '', /No model turn or worker process was started/);
          if (mode === 'continuation') {
            assert.deepEqual(persisted.executor, run.executor, 'the exact persisted executor identity is retained');
            assert.equal(persisted.agentResult?.sessionId, 'durable-thread-7', 'the exact persisted session identity is retained');
          }
          if (mode === 'unknown-crash') {
            assert.equal(persisted.state, 'NEEDS_HUMAN', 'unknown pre-spawn crash becomes a durable Run hold');
            assert.equal(persisted.execution, undefined, 'the hold does not invent an execution profile');
            assert.equal(persisted.executor, undefined, 'the hold does not invent an executor');
            assert.equal(persisted.agentResult, undefined, 'the hold does not invent worker result or session evidence');
            const lane = registry.readLane(admitted.token.laneId);
            assert.equal(lane?.missionId, admitted.missionId);
            assert.equal(lane?.status, 'active');
            assert.deepEqual(lane?.evidence, {
              repository: 'acme/widgets', issue: 42, run: id,
              workspace: path.join(realpathSync('/tmp'), 'tachiko-workspace'),
            }, 'the durable admission identity remains exact while the Run is held');
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  });

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
          baseBranch: request.baseBranch, baseSha: request.baseSha, branch: 'tachiko/issue-42-test',
          ...(request.publicationBranch === undefined ? {} : { publicationBranch: request.publicationBranch }),
          workspacePath: '/tmp/luna-existing' };
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
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workflow-f06-preview-'));
    const store = new JsonFileStore({ dir: directory });
    let run = createRun(TARGET, T0, 'validation-incoherent-adapter');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = { ...run, telemetry: {
      revision: RUN_TELEMETRY_REVISION, coverage: 'partial', thresholds: DEFAULT_EFFICIENCY_THRESHOLDS,
      events: [{ id: 'f06-existing-wait', at: T0, kind: 'wait_status_wakeup', state: 'VALIDATING', headSha: HEAD }],
    } };
    store.create(run);
    const oversizedSentinel = 'OVERSIZED-FALLBACK-PREVIEW-MUST-NOT-PERSIST';
    const oversizedPreview = oversizedSentinel + 'x'.repeat(1_048_576 - oversizedSentinel.length);
    const incoherentValidation: ValidationAdapter = {
      kind: 'validation', configRevision: 'test-config-v1',
      async validate() {
        return {
          status: 'passed', configRevision: 'test-config-v1',
          commands: [{ commandIndex: 0, executable: 'test', outcome: 'passed', exitCode: 0, durationMs: 1,
            captureStatus: 'unavailable', capturePreview: {
              stdout: { bytes: Buffer.byteLength(oversizedPreview), preview: oversizedPreview,
                previewBytes: Buffer.byteLength(oversizedPreview), truncated: false },
              stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
              diagnostics: [], diagnosticsTruncated: false,
            } }],
        };
      },
    };

    try {
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
      assert.deepEqual(result.run.validationResult?.local.commands, [], 'the oversized adapter preview is replaced by unavailable local evidence');
      assert.equal(result.run.history.at(-1)?.type, 'escalate');
      const jsonHistory = (history: Run['history']): Run['history'] => JSON.parse(JSON.stringify(history)) as Run['history'];
      assert.deepEqual(jsonHistory(result.run.history.slice(0, run.history.length)), jsonHistory(run.history),
        'pre-validation history is preserved');
      assert.deepEqual(result.run.telemetry, run.telemetry, 'existing telemetry is preserved without preview content');

      const persisted = new JsonFileStore({ dir: directory }).read(run.id);
      assert.equal(persisted?.state, 'NEEDS_HUMAN');
      assert.deepEqual(persisted?.history, jsonHistory(result.run.history),
        'durable history retains the refusal transition');
      assert.deepEqual(persisted?.telemetry, run.telemetry, 'durable telemetry event and thresholds are preserved');
      assert.deepEqual(persisted?.validationResult?.local.commands, []);
      assert.equal(JSON.stringify(persisted?.validationResult).includes(oversizedSentinel), false,
        'durable refusal contains no oversized fallback preview');
      assert.ok(JSON.stringify(persisted?.validationResult).length < TOOL_OUTPUT_POLICY_MAXIMA.previewBytes,
        'only compact unavailable evidence reaches durable validation state');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed when fallback raw stream bytes exceed the preview policy without a truncation claim', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workflow-f06-truncated-flag-'));
    const store = new JsonFileStore({ dir: directory });
    let run = createRun(TARGET, T0, 'validation-false-truncation-claim');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = { ...run, telemetry: {
      revision: RUN_TELEMETRY_REVISION, coverage: 'partial', thresholds: DEFAULT_EFFICIENCY_THRESHOLDS,
      events: [{ id: 'f1-existing-wait', at: T0, kind: 'wait_status_wakeup', state: 'VALIDATING', headSha: HEAD }],
    } };
    store.create(run);
    const retainedSentinel = 'OVER-LIMIT-COMPLETE-RETAINED-PREVIEW-MUST-NOT-PERSIST';
    const incoherentValidation: ValidationAdapter = {
      kind: 'validation', configRevision: 'test-config-v1',
      async validate() {
        return {
          status: 'passed', configRevision: 'test-config-v1',
          commands: [{ commandIndex: 0, executable: 'test', outcome: 'passed', exitCode: 0, durationMs: 1,
            captureStatus: 'unavailable', capturePreview: {
              stdout: { bytes: TOOL_OUTPUT_POLICY_MAXIMA.previewBytes + 1, preview: retainedSentinel,
                previewBytes: Buffer.byteLength(retainedSentinel), truncated: false },
              stderr: { bytes: 0, preview: '', previewBytes: 0, truncated: false },
              diagnostics: [], diagnosticsTruncated: false,
            } }],
        };
      },
    };

    try {
      const result = await runWorkflow({
        store,
        github: githubAdapter([HEAD]),
        implementation: new FakeImplementation([]),
        reviewer: new FakeReviewer([]),
        validation: incoherentValidation,
        hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, run.id, { maxReviewAttempts: 1, now: () => T0 });

      assert.equal(result.outcome, 'needs_human');
      assert.equal(result.run.state, 'NEEDS_HUMAN');
      assert.equal(result.run.validationResult?.local.status, 'unknown');
      assert.deepEqual(result.run.validationResult?.local.commands, []);
      const jsonHistory = (history: Run['history']): Run['history'] => JSON.parse(JSON.stringify(history)) as Run['history'];
      assert.deepEqual(jsonHistory(result.run.history.slice(0, run.history.length)), jsonHistory(run.history),
        'pre-validation history survives the fail-closed replacement');
      assert.deepEqual(result.run.telemetry, run.telemetry, 'the existing wait event and thresholds survive the replacement');
      const persisted = new JsonFileStore({ dir: directory }).read(run.id);
      assert.equal(persisted?.state, 'NEEDS_HUMAN');
      assert.deepEqual(jsonHistory(persisted?.history ?? []), jsonHistory(result.run.history));
      assert.deepEqual(persisted?.telemetry, run.telemetry, 'durable telemetry preserves the prior event and thresholds');
      assert.equal(JSON.stringify(persisted?.validationResult).includes(retainedSentinel), false,
        'the compact retained preview is not persisted when its raw byte count lacks a truncation claim');
    } finally { rmSync(directory, { recursive: true, force: true }); }
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

  it('propagates the host publication requirement into admission-backed review repair preflight', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-review-repair-governed-'));
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'review-repair-governed-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    reviewingRun(store, 'workflow-governed-review-repair', HEAD);
    const admitted = registry.admit({ laneId: 'run:workflow-governed-review-repair', role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: 'workflow-governed-review-repair' } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') return;
    try {
      const implementation = new FakeImplementation([successResult(HEAD2, 'must not run')]);
      const result = await runWorkflow(
        { store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation, reviewer: new FakeReviewer([requestChanges(HEAD)]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrap: new FakeBootstrap() },
        'workflow-governed-review-repair',
        { maxReviewAttempts: 3, now: () => T0, admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: '/tmp/governed-review-repair' } },
      );
      assert.equal(result.outcome, 'needs_human', 'the selected fake adapter cannot claim source-owned governed confinement');
      assert.equal(implementation.preflightRequests.length, 1);
      assert.deepEqual(implementation.preflightRequests[0]?.governedPublication, { required: true, continuation: true },
        'review repair receives its explicit continuation preflight requirement');
      assert.equal(implementation.preflightRequests[0]?.runtimeOwnership?.runId, result.run.id);
      assert.equal(implementation.requests.length, 0, 'the unqualified adapter is held before any worker call');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rechecks the exact genuine Luna instance at invocation entry after synchronous callbacks', async () => {
    const id = 'workflow-luna-entry-recheck';
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-entry-recheck-'));
    const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'luna-entry-recheck-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    const sourceHead = luna.identity.baseSha;
    assert.equal(hasGovernedPublicationConfinement(luna.adapter), true, 'fixture starts with its constructor-minted source qualification');
    const initial = reviewingRun(store, id, sourceHead);
    store.update({ ...initial, execution: luna.request.execution });
    const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
      evidence: { repository: 'acme/widgets', issue: 42, run: id } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') { luna.cleanup(); rmSync(directory, { recursive: true, force: true }); return; }
    let replacementCalls = 0;
    let fallbackCalls = 0;
    let sourcePreflightHold: string | undefined;
    let sourcePreflightQualified = false;
    let invocationEntryMutationArmed = false;
    const preparation: { status: 'qualified'; agent: ImplementationAgent } = { status: 'qualified', agent: luna.adapter };
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation(request) {
        const qualified = luna.adapter.prepareGovernedInvocation(request);
        if (qualified.status !== 'qualified') { sourcePreflightHold = qualified.reason; return qualified; }
        sourcePreflightQualified = hasGovernedPublicationConfinement(qualified.agent);
        preparation.agent = qualified.agent;
        invocationEntryMutationArmed = true;
        return preparation;
      },
      async run() { fallbackCalls += 1; return successResult(HEAD); },
    };
    const github = githubAdapter([sourceHead, sourceHead, sourceHead, sourceHead]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, repository: { ...live.repository, defaultBranchHeadSha: sourceHead },
        pullRequest: live.pullRequest === null ? null : { ...live.pullRequest, headSha: sourceHead, baseSha: sourceHead,
          headRef: luna.identity.branch, baseRef: luna.identity.baseBranch, headRepository: { owner: 'acme', repo: 'widgets' } } };
    };
    try {
      const result = await runWorkflow(
        { store, github, implementation, reviewer: new FakeReviewer([requestChanges(sourceHead)]), validation: new FakeValidation(),
          hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => luna.bootstrap,
          resolveRepairExecutionProfile: () => luna.request.execution },
        id,
        {
          maxReviewAttempts: 2,
          now: () => T0,
          admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: luna.identity.workspacePath },
          onExecutionStart: () => {
            if (!invocationEntryMutationArmed) return;
            invocationEntryMutationArmed = false;
            luna.adapter.run = async () => { replacementCalls += 1; return successResult(HEAD); };
          },
        },
      );
      assert.equal(result.outcome, 'needs_human');
      assert.match(result.reason, /publication boundary changed after preflight/, `preflight hold: ${sourcePreflightHold ?? '(none)'}, qualified=${sourcePreflightQualified}`);
      assert.equal(replacementCalls, 0, 'the replaced method on the captured genuine adapter is never entered');
      assert.equal(fallbackCalls, 0, 'the original selected provider does not fall back after its instance method changes');
      assert.equal(result.run.executor, undefined);
    } finally {
      luna.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('invokes the captured genuine Luna when only the retained preparation object is redirected', async () => {
    const id = 'workflow-luna-retained-preparation';
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-retained-preparation-'));
    const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'luna-retained-preparation-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    const sourceHead = luna.identity.baseSha;
    const initial = reviewingRun(store, id, sourceHead);
    store.update({ ...initial, execution: luna.request.execution });
    const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
      evidence: { repository: 'acme/widgets', issue: 42, run: id } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') { luna.cleanup(); rmSync(directory, { recursive: true, force: true }); return; }
    let replacementCalls = 0;
    const attacker: ImplementationAgent = { kind: 'implementation-agent', async run() { replacementCalls += 1; return successResult(HEAD); } };
      const preparation: { status: 'qualified'; agent: ImplementationAgent } = { status: 'qualified', agent: luna.adapter };
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation(request) {
        const qualified = luna.adapter.prepareGovernedInvocation(request);
        if (qualified.status !== 'qualified') return qualified;
        preparation.agent = qualified.agent;
        return preparation;
      },
      async run() { throw new Error('ambient fallback must not run'); },
    };
    const workerMarker = path.join(luna.root, 'worker-invoked');
    writeFileSync(path.join(luna.root, 'bin', 'codex'), `#!/bin/sh\nprintf invoked > '${workerMarker}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"genuine-luna-thread"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"genuine-luna-message","type":"agent_message","text":"bounded fixture result"}}' '{"type":"turn.completed"}'\n`, { mode: 0o700 });
    const github = githubAdapter([sourceHead, sourceHead, sourceHead, sourceHead]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, repository: { ...live.repository, defaultBranchHeadSha: sourceHead },
        pullRequest: live.pullRequest === null ? null : { ...live.pullRequest, headSha: sourceHead, baseSha: sourceHead,
          headRef: luna.identity.branch, baseRef: luna.identity.baseBranch, headRepository: { owner: 'acme', repo: 'widgets' } } };
    };
    try {
      const result = await runWorkflow(
        { store, github, implementation, reviewer: new FakeReviewer([requestChanges(sourceHead)]), validation: new FakeValidation(),
          hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => luna.bootstrap,
          resolveRepairExecutionProfile: () => luna.request.execution },
        id,
        {
          maxReviewAttempts: 2,
          now: () => T0,
          admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: luna.identity.workspacePath },
          onExecutionStart: () => { preparation.agent = attacker; },
        },
      );
      const settled = await result;
      assert.equal(settled.outcome, 'needs_human');
      assert.equal(existsSync(workerMarker), true, 'the retained exact qualified adapter executes despite a mutable preparation object');
      assert.equal(settled.run.agentResult?.exitStatus, 'success', 'the original Luna result, not the replacement, is persisted');
      assert.equal(replacementCalls, 0, 'mutating the retained preparation object cannot redirect invocation');
      assert.equal(settled.run.executor, undefined);
    } finally {
      luna.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a nested CLI origin changed by the execution-start callback', async () => {
    const id = 'workflow-luna-cli-origin-recheck';
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-cli-origin-recheck-'));
    const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
    const originalRun = Object.getOwnPropertyDescriptor(CodexCliAdapter.prototype, 'run');
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'luna-cli-origin-recheck-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    const sourceHead = luna.identity.baseSha;
    const initial = reviewingRun(store, id, sourceHead);
    store.update({ ...initial, execution: luna.request.execution });
    const spawnMarker = path.join(luna.root, 'worker-spawned');
    writeFileSync(path.join(luna.root, 'bin', 'codex'), `#!/bin/sh\nprintf x > '${spawnMarker}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"unexpected"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"message","type":"agent_message","text":"unexpected"}}' '{"type":"turn.completed"}'\n`, { mode: 0o700 });
    const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
      evidence: { repository: 'acme/widgets', issue: 42, run: id } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') { luna.cleanup(); rmSync(directory, { recursive: true, force: true }); return; }
    let replacementCalls = 0;
    const replacement = async function () { replacementCalls += 1; return successResult(sourceHead); };
    let invocationEntryMutationArmed = false;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation(request) {
        const prepared = luna.adapter.prepareGovernedInvocation(request);
        if (prepared.status === 'qualified') invocationEntryMutationArmed = true;
        return prepared;
      },
      async run(request) { return await luna.adapter.run(request); },
    };
    const github = githubAdapter([sourceHead, sourceHead, sourceHead, sourceHead]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, repository: { ...live.repository, defaultBranchHeadSha: sourceHead },
        pullRequest: live.pullRequest === null ? null : { ...live.pullRequest, headSha: sourceHead, baseSha: sourceHead,
          headRef: luna.identity.branch, baseRef: luna.identity.baseBranch, headRepository: { owner: 'acme', repo: 'widgets' } } };
    };
    let publicationCalls = 0;
    github.createImplementationPullRequest = async () => { publicationCalls += 1; return { number: 8 }; };
    try {
      const result = await runWorkflow(
        { store, github, implementation, reviewer: new FakeReviewer([requestChanges(sourceHead)]), validation: new FakeValidation(),
          hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => luna.bootstrap,
          resolveRepairExecutionProfile: () => luna.request.execution },
        id,
        {
          maxReviewAttempts: 2,
          now: () => T0,
          admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: luna.identity.workspacePath },
          onExecutionStart: () => {
            if (!invocationEntryMutationArmed) return;
            invocationEntryMutationArmed = false;
            Object.defineProperty(CodexCliAdapter.prototype, 'run', { ...originalRun, value: replacement });
          },
        },
      );
      assert.equal(result.outcome, 'failed');
      assert.match(result.run.agentResult?.diagnostics?.join(' ') ?? '', /nested Codex CLI whose source-owned run method changed/);
      assert.equal(replacementCalls, 0, 'the changed nested CLI method is refused before invocation');
      assert.equal(existsSync(spawnMarker), false, 'the original CLI never launches a worker process');
      assert.equal(publicationCalls, 0, 'refusal precedes host PR publication');
      assert.equal(result.run.executor, undefined, 'refusal happens before a worker session is recorded');
    } finally {
      if (originalRun !== undefined) Object.defineProperty(CodexCliAdapter.prototype, 'run', originalRun);
      luna.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('captures the genuine Luna adapter on the initial IMPLEMENTING path after standalone preparation', async () => {
    const id = 'workflow-initial-luna-retained-preparation';
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-luna-retained-'));
    const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-luna-retained-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, id, luna.request.execution));
    const github = githubAdapter([null]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, repository: { ...live.repository, defaultBranchHeadSha: luna.identity.baseSha } };
    };
    const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
      evidence: { repository: 'acme/widgets', issue: 42, run: id, workspace: luna.identity.workspacePath } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') { luna.cleanup(); rmSync(directory, { recursive: true, force: true }); return; }

    const marker = path.join(luna.root, 'initial-worker-invoked');
    writeFileSync(path.join(luna.root, 'bin', 'codex'), `#!/bin/sh\nprintf invoked > '${marker}'\nprintf '%s\\n' '{"type":"thread.started","thread_id":"genuine-luna-thread"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"id":"genuine-luna-message","type":"agent_message","text":"bounded fixture result"}}' '{"type":"turn.completed"}'\n`, { mode: 0o700 });
    let redirectedAgentCalls = 0;
    let fallbackCalls = 0;
    let sourcePreflightQualified = false;
    const attacker: ImplementationAgent = { kind: 'implementation-agent', async run() { redirectedAgentCalls += 1; return successResult(luna.identity.baseSha); } };
    const preparation: { status: 'qualified'; agent: ImplementationAgent } = { status: 'qualified', agent: luna.adapter };
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation(request) {
        const prepared = luna.adapter.prepareGovernedInvocation(request);
        if (prepared.status === 'held') return prepared;
        sourcePreflightQualified = hasGovernedPublicationConfinement(prepared.agent);
        preparation.agent = prepared.agent;
        return preparation;
      },
      async run() { fallbackCalls += 1; return successResult(luna.identity.baseSha); },
    };
    try {
      const result = await runWorkflow({
        store, github, implementation,
        reviewer: new FakeReviewer([approve(luna.identity.baseSha)]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        bootstrapForExecution: () => luna.bootstrap,
      }, id, {
        maxReviewAttempts: 1, now: () => T0,
        admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId,
          executionWorkspace: luna.identity.workspacePath },
        onExecutionStart: () => { preparation.agent = attacker; },
      });

      assert.equal(sourcePreflightQualified, true, 'the exact prepared instance came from genuine source-owned qualification');
      assert.equal(existsSync(marker), true, 'the original source-qualified Luna reaches its controlled executable');
      assert.equal(redirectedAgentCalls, 0, 'the attacker installed in the retained preparation is never selected');
      assert.equal(fallbackCalls, 0, 'the ambient implementation fallback is never selected');
      assert.equal(result.run.executor, undefined, 'the initial Luna invocation records no CLI identity');
    } finally {
      luna.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rechecks the exact genuine Luna instance on the initial IMPLEMENTING path after standalone preparation', async () => {
    const id = 'workflow-initial-luna-entry-recheck';
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-initial-luna-entry-'));
    const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
    const registry = new MissionAdmissionRegistry({
      filePath: path.join(directory, 'registry.json'),
      config: { schemaVersion: 1, revision: 'initial-luna-entry-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
    });
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, id, luna.request.execution));
    const github = githubAdapter([null]);
    const readLive = github.readLiveSnapshot.bind(github);
    github.readLiveSnapshot = async (target) => {
      const live = await readLive(target);
      return { ...live, repository: { ...live.repository, defaultBranchHeadSha: luna.identity.baseSha } };
    };
    const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
      evidence: { repository: 'acme/widgets', issue: 42, run: id, workspace: luna.identity.workspacePath } });
    assert.equal(admitted.outcome, 'admitted');
    if (admitted.outcome !== 'admitted') { luna.cleanup(); rmSync(directory, { recursive: true, force: true }); return; }

    const marker = path.join(luna.root, 'must-not-spawn');
    writeFileSync(path.join(luna.root, 'bin', 'codex'), `#!/bin/sh\nprintf invoked > '${marker}'\nexit 70\n`, { mode: 0o700 });
    let invocationEntryMutationArmed = false;
    let replacementCalls = 0;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      prepareGovernedInvocation(request) {
        const prepared = luna.adapter.prepareGovernedInvocation(request);
        if (prepared.status === 'qualified') invocationEntryMutationArmed = true;
        return prepared;
      },
      async run() { replacementCalls += 1; throw new Error('ambient implementation fallback must not run'); },
    };
    const replacement = async () => { replacementCalls += 1; return successResult(luna.identity.baseSha); };
    try {
      const result = await runWorkflow({
        store, github, implementation, reviewer: new FakeReviewer([]),
        validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => luna.bootstrap,
      }, id, {
        maxReviewAttempts: 1, now: () => T0,
        admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId,
          executionWorkspace: luna.identity.workspacePath },
        onExecutionStart: () => {
          if (!invocationEntryMutationArmed) return;
          invocationEntryMutationArmed = false;
          luna.adapter.run = replacement;
        },
      });

      assert.equal(result.outcome, 'needs_human');
      assert.match(result.reason, /publication boundary changed after preflight/);
      assert.equal(existsSync(marker), false, 'the real worker executable remains unstarted');
      assert.equal(replacementCalls, 0, 'neither the instance replacement nor fallback is entered');
      assert.equal(result.run.executor, undefined);
    } finally {
      luna.cleanup();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('holds admission-backed review and validation repairs before any ambient provider or publication effect', async (t) => {
    for (const repairKind of ['review', 'validation'] as const) {
      for (const provider of ['codex-cli', 'codex-app-server', 'claude-code', 'worker-router'] as const) {
        await t.test(`${repairKind}/${provider}`, async () => {
          const id = `workflow-governed-hold-${repairKind}-${provider}`;
          const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workflow-governed-hold-'));
          const registry = new MissionAdmissionRegistry({
            filePath: path.join(directory, 'registry.json'),
            config: { schemaVersion: 1, revision: `governed-hold-${repairKind}-${provider}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
          });
          const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'profiles-v1', executor: provider, timeoutMs: 10_000 };
          const store = new MemoryStore();
          let run: Run;
          if (repairKind === 'review') {
            run = reviewingRun(store, id, HEAD);
            run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          } else {
            run = createRun(TARGET, T0, id, execution);
            run = applyTransition(run, { type: 'start' }, T0);
            run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD, pullRequest: { number: 7, headSha: HEAD } }, T0);
            run = applyTransition(run, { type: 'validation_failed', validationResult: validationFailed(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          }
          run = {
            ...run,
            execution,
            executor: { provider, sessionId: `session-${provider}`, generation: `generation-${id}` },
            agentResult: { ...run.agentResult!, sessionId: `session-${provider}` },
            repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
          };
          store.create(run);
          const admitted = registry.admit({
            laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
            evidence: { repository: 'acme/widgets', issue: 42, run: id, pullRequest: 7 },
          });
          assert.equal(admitted.outcome, 'admitted');
          if (admitted.outcome !== 'admitted') return;
          const admissionBefore = registry.snapshot();
          let modelCalls = 0;
          let processCalls = 0;
          let fallbackCalls = 0;
          let pushCalls = 0;
          let pullRequestWrites = 0;
          const ambient: ImplementationAgent = {
            kind: 'implementation-agent',
            async run(request) {
              modelCalls += 1;
              processCalls += 1;
              request.beforePublish?.();
              pushCalls += 1;
              return successResult(HEAD2);
            },
          };
          const fallback: ImplementationAgent = {
            kind: 'implementation-agent',
            async run(request) {
              fallbackCalls += 1;
              return ambient.run(request);
            },
          };
          const appServerAmbient: ImplementationAgent = {
            kind: 'implementation-agent',
            async run(request) {
              processCalls += 1;
              return fallback.run(request);
            },
          };
          const implementation = new ImplementationAgentRegistry({
            defaultProvider: 'codex-cli', legacySessionProvider: 'claude-code',
            providers: {
              'codex-cli': () => ambient,
              'codex-app-server': () => appServerAmbient,
              'claude-code': () => ambient,
              'worker-router': () => new WorkerRouterAdapter({ env: {} }),
            },
          });
          const github: GitHubAdapter = {
            ...githubAdapter([HEAD, HEAD]),
            async createImplementationPullRequest() { pullRequestWrites += 1; return { number: 8 }; },
          };
          try {
            const outcome = await runWorkflow({
              store, github, implementation, reviewer: new FakeReviewer([]), validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
              resolveRepairExecutionProfile: () => execution,
            }, id, {
              maxReviewAttempts: 2, now: () => T0,
              admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: '/tmp/governed-repair-hold' },
            });
            assert.equal(outcome.outcome, 'needs_human');
            assert.match(outcome.reason, /No model turn or worker process was started/);
            assert.equal(modelCalls, 0);
            assert.equal(processCalls, 0);
            assert.equal(fallbackCalls, 0, 'App Server fallback is not called');
            assert.equal(pushCalls, 0);
            assert.equal(pullRequestWrites, 0);
            assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
            assert.deepEqual(outcome.run.executor, run.executor);
            assert.equal(outcome.run.agentResult?.sessionId, run.agentResult?.sessionId);
            assert.deepEqual(registry.snapshot(), admissionBefore, 'the exact admission generation and evidence remain unchanged');
            assert.equal(outcome.run.repairAdmissions?.[0]?.execution.executor, provider, 'trusted repair-profile promotion is retained durably');
          } finally { rmSync(directory, { recursive: true, force: true }); }
        });
      }
    }
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

  it('rechecks the exact Run handoff after final asynchronous worker preparation', async (t) => {
    for (const phase of ['initial', 'resumed'] as const) {
      await t.test(phase, async () => {
        const store = new MemoryStore();
        let run = createRun(TARGET, T0, `execution-boundary-${phase}`);
        if (phase === 'resumed') run = applyTransition(run, { type: 'start' }, T0);
        store.create(run);
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
            return successResult(HEAD);
          },
        };
        const operation = runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) }, run.id,
          { maxReviewAttempts: 2, now: () => T0 });
        await ready;
        const winner = applyTransition(store.read(run.id)!, {
          type: 'escalate', reason: 'Concurrent cancellation after worker preparation',
          interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
        }, T0);
        store.update(winner);
        allowBoundary();
        const result = await operation;
        assert.equal(result.outcome, 'needs_human');
        assert.deepEqual(store.read(run.id), winner, 'the newer Run remains byte-for-byte authoritative');
        assert.equal(entered, 0, 'the final synchronous boundary refuses provider entry after the CAS loses');
      });
    }
  });

  it('rejects admission revoked after the real qualified Luna guard check and before child entry for initial, resumed, and repair workers', async (t) => {
    for (const phase of ['initial', 'resumed', 'repair'] as const) {
      for (const invalidation of ['run', 'admission'] as const) await t.test(`${phase}/${invalidation}`, async () => {
        const id = `workflow-luna-admission-final-boundary-${phase}`;
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-admission-final-boundary-'));
        const luna = await createGenuineLunaFixture(id, { deferPrepare: true });
        const marker = path.join(luna.root, 'codex-entered');
        writeFileSync(path.join(luna.root, 'bin', 'codex'), `#!/bin/sh\nprintf entered > '${marker}'\nexit 0\n`, { mode: 0o700 });
        const registry = new MissionAdmissionRegistry({
          filePath: path.join(directory, 'registry.json'),
          config: { schemaVersion: 1, revision: 'luna-admission-final-boundary-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        });
        try {
          const admitted = registry.admit({ laneId: `run:${id}`, role: 'production_captain', highAutonomy: true,
            evidence: { repository: 'acme/widgets', issue: 42, run: id, workspace: luna.identity.workspacePath } });
          assert.equal(admitted.outcome, 'admitted');
          if (admitted.outcome !== 'admitted') return;
          const store = new MemoryStore();
          const sourceHead = luna.identity.baseSha;
          let run: Run;
          if (phase === 'repair') {
            run = reviewingRun(store, id, sourceHead);
            run = { ...run, execution: luna.request.execution };
            store.update(run);
          } else {
            run = createRun(TARGET, T0, id, luna.request.execution);
            if (phase === 'resumed') {
              run = applyTransition(run, { type: 'start' }, T0);
              run = { ...run, executor: { provider: 'codex-cli', sessionId: 'persisted-resume-thread' } };
            }
            store.create(run);
          }
          let sourceQualified = false;
          let fallbackCalls = 0;
          const implementation: ImplementationAgent = {
            kind: 'implementation-agent',
            prepareGovernedInvocation(request) {
              const prepared = luna.adapter.prepareGovernedInvocation(request);
              sourceQualified = prepared.status === 'qualified' && prepared.agent === luna.adapter;
              return prepared;
            },
            async run() { fallbackCalls += 1; return successResult(sourceHead); },
          };
          const baseGithub = githubAdapter(phase === 'repair'
            ? [sourceHead, sourceHead, sourceHead, sourceHead]
            : [null, null, null, null]);
          const github: GitHubAdapter = {
            ...baseGithub,
            async readLiveSnapshot(target) {
              const live = await baseGithub.readLiveSnapshot(target);
              return { ...live, repository: { ...live.repository, defaultBranchHeadSha: sourceHead },
                pullRequest: live.pullRequest === null ? null : { ...live.pullRequest, headSha: sourceHead, baseSha: sourceHead,
                  headRef: luna.identity.branch, baseRef: luna.identity.baseBranch, headRepository: { owner: 'acme', repo: 'widgets' } } };
            },
          };
          let revoked = false;
          let concurrent: Run | undefined;
          const result = await runWorkflow({
            store, github, implementation,
            reviewer: new FakeReviewer(phase === 'repair' ? [requestChanges(sourceHead)] : []),
            validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
            bootstrapForExecution: () => luna.bootstrap,
            resolveRepairExecutionProfile: () => luna.request.execution,
          }, id, {
            maxReviewAttempts: 2, now: () => T0,
            admissionFence: { registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: luna.identity.workspacePath },
            onExecutionStart: () => {
              if (!sourceQualified || revoked) return;
              revoked = true;
              // After this hook the workflow rechecks the exact live token,
              // enters source-qualified Luna, and awaits its exact guard.
              // The queued retirement lands before Codex's beforeSpawn callback.
              queueMicrotask(() => {
                if (invalidation === 'admission') registry.release(admitted.token, true);
                else {
                  const current = store.read(id)!;
                  concurrent = applyTransition(current, {
                    type: 'escalate', reason: 'Concurrent operator cancellation at the final execution boundary',
                    interrupt: { evidence: 'operator cancellation', choices: ['Cancel the run'] },
                  }, T0);
                  store.update(concurrent);
                }
              });
            },
          });
          assert.equal(result.outcome, 'needs_human', `${phase}/${invalidation} is held before provider entry`);
          assert.equal(sourceQualified, true, `${phase} preflight returns the real source-qualified Luna instance`);
          assert.equal(revoked, true, `${phase} revocation is scheduled only after qualified handoff`);
          if (invalidation === 'admission') assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released');
          else assert.deepEqual(store.read(id), concurrent, `${phase} preserves the exact concurrent Run winner`);
          if (invalidation === 'admission') {
            assert.match(result.reason, /current host admission boundary/);
            assert.doesNotMatch(result.reason, /No provider process was started/);
            assert.deepEqual(result.run.executor, run.executor, `${phase} refusal preserves the recorded executor identity`);
            assert.deepEqual(result.run.agentResult, run.agentResult, `${phase} refusal preserves prior execution uncertainty and result evidence`);
          }
          assert.equal(existsSync(marker), false, `${phase} actual controlled Codex executable is never entered`);
          assert.equal(fallbackCalls, 0, `${phase}/${invalidation} ambient implementation cannot replace the qualified adapter`);
        } finally {
          luna.cleanup();
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  });

  it('preserves an unknown tagged refusal when strict Run CAS disappears at the final callback', async () => {
    const backing = new MemoryStore();
    let casAvailable = true;
    const store: RunStore = {
      name: 'temporarily-missing-cas',
      create: (run) => backing.create(run),
      read: (id) => backing.read(id),
      update: (run) => backing.update(run),
      list: () => backing.list(),
      delete: (id) => backing.delete(id),
      get updateIfUnchanged() { return casAvailable ? backing.updateIfUnchanged.bind(backing) : undefined; },
    };
    const run = createRun(TARGET, T0, 'missing-cas-at-execution-boundary');
    store.create(run);
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
        casAvailable = false;
        request.beforeExecution?.();
        entered += 1;
        return successResult(HEAD);
      },
    };
    const operation = runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) }, run.id,
      { maxReviewAttempts: 1, now: () => T0 });
    await ready;
    const handoff = store.read(run.id)!;
    allowBoundary();
    await assert.rejects(operation, (error) => {
      assert.equal(isExecutionAdmissionRefusal(error), true);
      if (!isExecutionAdmissionRefusal(error)) return false;
      assert.equal(error.authorityUnknown, true, 'missing CAS is unavailable authority, not a confirmed superseding Run');
      assert.equal(error.runSuperseded, false);
      assert.match(String(error.cause), /Strict Run compare-and-swap is unavailable/);
      return true;
    });
    assert.deepEqual(store.read(run.id), handoff, 'missing CAS cannot rewrite the persisted handoff');
    assert.equal(entered, 0, 'missing strict CAS fails closed before provider entry');
  });

  it('keeps thrown Run-store authority errors tagged and primary when refusal reconciliation also fails', async () => {
    const backing = new MemoryStore();
    const primary = new Error('test host admission authority refused entry');
    const secondary = new Error('Run store lock became unavailable during refusal reconciliation');
    let failReconciliationWrite = false;
    let actualEntries = 0;
    let runCalls = 0;
    const run = createRun(TARGET, T0, 'execution-refusal-reconciliation-failure');
    let handoff: Run | undefined;
    const store: RunStore = {
      name: 'refusal-reconciliation-failure',
      create: (value) => backing.create(value),
      read: (id) => backing.read(id),
      update: (value) => backing.update(value),
      list: () => backing.list(),
      delete: (id) => backing.delete(id),
      updateIfUnchanged(expected, next) {
        if (failReconciliationWrite && JSON.stringify(expected) !== JSON.stringify(next)) throw secondary;
        return backing.updateIfUnchanged(expected, next);
      },
    };
    store.create(run);
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request) {
        runCalls += 1;
        handoff = store.read(run.id)!;
        failReconciliationWrite = true;
        request.beforeExecution?.();
        throw new ExecutionAdmissionRefusal('Injected final host admission refusal.', false, { cause: primary });
      },
    };
    let captured: unknown;
    await assert.rejects(runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) }, run.id,
      { maxReviewAttempts: 1, now: () => T0 }), (error) => {
      captured = error;
      assert.equal(isExecutionAdmissionRefusal(error), true);
      if (!isExecutionAdmissionRefusal(error)) return false;
      assert.equal(error.authorityUnknown, false);
      assert.equal(error.cause, primary);
      assert.notEqual(error.cause, secondary);
      return true;
    });
    assert.equal(runCalls, 1);
    assert.equal(actualEntries, 0, 'the tagged boundary refusal prevents provider entry');
    assert.equal(store.read(run.id)?.agentResult, undefined, 'refusal reconciliation failure is not recorded as provider EXEC_FAILURE');
    assert.deepEqual(store.read(run.id), handoff, 'the failed reconciliation performs no unconditional or fabricated Run write');
    assert.equal(isExecutionAdmissionRefusal(captured), true, 'the tagged refusal remains the primary thrown error');
  });

  it('does not convert a thrown final Run CAS into provider failure or fallback eligibility', async () => {
    const backing = new MemoryStore();
    const ioError = new Error('Run JSON lock timed out at final CAS');
    let failBoundary = false;
    let actualEntries = 0;
    let runCalls = 0;
    const run = createRun(TARGET, T0, 'execution-cas-io-unknown');
    const store: RunStore = {
      name: 'throwing-final-cas', create: (value) => backing.create(value), read: (id) => backing.read(id),
      update: (value) => backing.update(value), list: () => backing.list(), delete: (id) => backing.delete(id),
      updateIfUnchanged(expected, next) {
        if (failBoundary) throw ioError;
        return backing.updateIfUnchanged(expected, next);
      },
    };
    store.create(run);
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request) {
        runCalls += 1;
        failBoundary = true;
        request.beforeExecution?.();
        actualEntries += 1;
        return successResult(HEAD);
      },
    };
    await assert.rejects(runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]) }, run.id,
      { maxReviewAttempts: 1, now: () => T0 }), (error) => {
      assert.equal(isExecutionAdmissionRefusal(error), true);
      if (!isExecutionAdmissionRefusal(error)) return false;
      assert.equal(error.authorityUnknown, true, 'a thrown CAS cannot prove that another Run won');
      assert.equal(error.runSuperseded, false);
      assert.equal(error.cause, ioError, 'the store I/O error remains the primary cause');
      return true;
    });
    assert.equal(runCalls, 1);
    assert.equal(actualEntries, 0);
    assert.equal(store.read(run.id)?.agentResult, undefined, 'unknown final authority is not converted to EXEC_FAILURE');
  });

  it('keeps missing and throwing validation CAS unknown and refuses validator entry', async (t) => {
    for (const mode of ['missing', 'throwing'] as const) await t.test(mode, async () => {
      const backing = new MemoryStore();
      const run = reviewingRun(backing, `validation-cas-${mode}`, HEAD);
      let finalBoundary = false;
      const ioError = new Error('validation Run-store lock read failed');
      const store: RunStore = {
        name: `validation-${mode}-cas`, create: (value) => backing.create(value), read: (id) => backing.read(id),
        update: (value) => backing.update(value), list: () => backing.list(), delete: (id) => backing.delete(id),
        get updateIfUnchanged() {
          if (finalBoundary && mode === 'missing') return undefined;
          if (finalBoundary && mode === 'throwing') return () => { throw ioError; };
          return backing.updateIfUnchanged.bind(backing);
        },
      };
      let validationCalls = 0;
      const validation: ValidationAdapter = {
        kind: 'validation', configRevision: `validation-cas-${mode}-v1`,
        async validate(request) { validationCalls += 1; return { ...validationPassed(request.headSha).local, configRevision: this.configRevision }; },
      };
      const github = githubAdapter([HEAD, HEAD, HEAD, HEAD]);
      await assert.rejects(runWorkflow({
        store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([approve(HEAD)]),
        validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
      }, run.id, {
        maxReviewAttempts: 1, now: () => T0,
        onExecutionStart: () => { if (store.read(run.id)?.state === 'VALIDATING') finalBoundary = true; },
      }), (error) => {
        assert.equal(isExecutionAdmissionRefusal(error), true);
        if (!isExecutionAdmissionRefusal(error)) return false;
        assert.equal(error.authorityUnknown, true, `${mode} validation CAS is unknown authority`);
        assert.equal(error.runSuperseded, false);
        if (mode === 'throwing') assert.equal(error.cause, ioError);
        else assert.match(String(error.cause), /Strict Run compare-and-swap is unavailable/);
        return true;
      });
      assert.equal(validationCalls, 0, 'unknown final validation authority prevents validator entry');
    });
  });

  it('settles a superseded repair from the CAS winner and never re-enters the review loop', async (t) => {
    const cases: Array<{ label: string; state: Run['state']; expected: string }> = [
      { label: 'waiting-dependency', state: 'WAITING_DEPENDENCY', expected: 'waiting_dependency' },
      { label: 'merge-ready', state: 'MERGE_READY', expected: 'merge_ready' },
      { label: 'merged', state: 'MERGED', expected: 'merged' },
      { label: 'failed', state: 'FAILED', expected: 'failed' },
      { label: 'changed-active-repair', state: 'IMPLEMENTING', expected: 'needs_human' },
    ];
    for (const { label, state, expected } of cases) {
      await t.test(label, async () => {
        const store = new MemoryStore();
        const id = `superseded-repair-${label}`;
        let run = reviewingRun(store, id, HEAD);
        run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
        store.update(run);
        let winner: Run;
        if (state === 'WAITING_DEPENDENCY') {
          winner = applyTransition(run, { type: 'wait_dependency', interrupt: { evidence: 'external dependency', choices: ['Retry'] } }, T0);
        } else if (state === 'FAILED') {
          winner = applyTransition(run, { type: 'fail', reason: 'concurrent failure' }, T0);
        } else if (state === 'IMPLEMENTING') {
          let prior = reviewingRun(new MemoryStore(), id, HEAD);
          prior = { ...prior, repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
            executor: { provider: 'claude-code', sessionId: 'prior-session' },
            agentResult: { ...prior.agentResult!, executor: { provider: 'claude-code', sessionId: 'prior-session' }, sessionId: 'prior-session' } };
          prior = applyTransition(prior, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'winner-v1', executor: 'codex-cli', timeoutMs: 60_000 };
          const receipt = createRepairAdmissionSnapshot(prior.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
          const binding = createRepairAttemptBinding(prior, execution);
          winner = applyTransition(prior, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
          winner = applyTransition(winner, { type: 'repair_executor_handoff', repairAgentResult: {
            ...successResult(HEAD2), executor: { provider: 'codex-app-server', sessionId: 'new-winner-session', generation: binding.runtimeGeneration }, sessionId: 'new-winner-session',
          } }, T0);
        } else {
          const fresh = new MemoryStore();
          winner = reviewingRun(fresh, id, HEAD);
          winner = applyTransition(winner, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          winner = { ...winner, state: 'MERGE_READY', history: [...winner.history,
            { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
          if (state === 'MERGED') winner = applyTransition(winner, { type: 'merged' }, T0);
        }
        const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-workflow-cas-winner-'));
        try {
          const fixtureStore = new JsonFileStore({ dir: fixtureDir });
          fixtureStore.create(winner);
          assert.equal(JSON.stringify(new JsonFileStore({ dir: fixtureDir }).read(id)), JSON.stringify(winner), 'race winner survives durable store replay');
        } finally { rmSync(fixtureDir, { recursive: true, force: true }); }
        let liveReads = 0;
        const github = githubAdapter([HEAD]);
        github.readLiveSnapshot = async () => { liveReads += 1; store.update(winner); return snapshot(HEAD); };
        const implementation = new FakeImplementation([]);
        const reviewer = new FakeReviewer([]);
        const result = await runWorkflow({ store, github, implementation, reviewer }, id,
          { maxReviewAttempts: 2, now: () => T0 });
        assert.equal(result.outcome, expected);
        assert.deepEqual(result.run, winner);
        assert.deepEqual(store.read(id), winner, 'the exact CAS winner remains durable');
        assert.equal(liveReads, 1, 'the outer workflow returns immediately without review-loop re-entry');
        assert.equal(implementation.requests.length, 0);
        assert.equal(reviewer.requests.length, 0);
      });
    }
  });

  it('maps ordinary pending-review CAS losses to the exact stored winner without loop re-entry', async (t) => {
    const cases: Array<{ label: string; state: Run['state']; expected: string }> = [
      { label: 'waiting-dependency', state: 'WAITING_DEPENDENCY', expected: 'waiting_dependency' },
      { label: 'merge-ready', state: 'MERGE_READY', expected: 'merge_ready' },
      { label: 'merged', state: 'MERGED', expected: 'merged' },
      { label: 'failed', state: 'FAILED', expected: 'failed' },
      { label: 'changed-active-repair', state: 'IMPLEMENTING', expected: 'needs_human' },
    ];
    for (const { label, state, expected } of cases) {
      await t.test(label, async () => {
        const store = new MemoryStore();
        const id = `ordinary-review-cas-winner-${label}`;
        const prior = reviewingRun(store, id, HEAD);
        let winner: Run;
        if (state === 'WAITING_DEPENDENCY') {
          winner = applyTransition(prior, { type: 'wait_dependency', interrupt: { evidence: 'external dependency', choices: ['Retry'] } }, T0);
        } else if (state === 'FAILED') {
          winner = applyTransition(prior, { type: 'fail', reason: 'concurrent ordinary-review failure' }, T0);
        } else if (state === 'IMPLEMENTING') {
          let repairPrior: Run = { ...prior, repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' as const },
            executor: { provider: 'claude-code', sessionId: 'prior-session' },
            agentResult: { ...prior.agentResult!, executor: { provider: 'claude-code', sessionId: 'prior-session' }, sessionId: 'prior-session' } };
          repairPrior = applyTransition(repairPrior, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'ordinary-winner-v1', executor: 'codex-cli', timeoutMs: 60_000 };
          const admission = createRepairAdmissionSnapshot(repairPrior.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
          const binding = createRepairAttemptBinding(repairPrior, execution);
          winner = applyTransition(repairPrior, { type: 'start_fix', repairAdmission: { ...admission, attemptBinding: binding } }, T0);
          winner = applyTransition(winner, { type: 'repair_executor_handoff', repairAgentResult: {
            ...successResult(HEAD2), executor: { provider: 'codex-app-server', sessionId: 'winner-session', generation: binding.runtimeGeneration }, sessionId: 'winner-session',
          } }, T0);
        } else {
          winner = applyTransition(prior, { type: 'review_approved', reviewResult: approve(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
          winner = { ...winner, state: 'MERGE_READY', history: [...winner.history,
            { type: 'final_gate_verified', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }] };
          if (state === 'MERGED') winner = applyTransition(winner, { type: 'merged' }, T0);
        }
        const reviewer = {
          kind: 'reviewer' as const,
          calls: 0,
          async review() { this.calls += 1; store.update(winner); return approve(HEAD); },
        };
        const implementation = new FakeImplementation([]);
        const result = await runWorkflow({ store, github: githubAdapter([HEAD]), implementation, reviewer,
          validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY }, id,
          { maxReviewAttempts: 2, now: () => T0 });
        assert.equal(result.outcome, expected);
        assert.deepEqual(result.run, winner, 'outer workflow returns the exact durable race winner');
        assert.deepEqual(store.read(id), winner, 'the stale reviewer result does not rewrite the winner');
        assert.equal(reviewer.calls, 1, 'the outer workflow does not re-enter review after a stale result');
        assert.equal(implementation.requests.length, 0, 'stale approval never starts another implementation');
      });
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

  it('verifies an already-published owned workspace without publishing after awaited standalone Git checks', async (t) => {
    for (const mode of ['run-changed', 'admission-stale', 'publication-stale', 'adoption-proof-stale', 'current'] as const) {
      await t.test(mode, async () => {
        const fixture = createBootstrapGitFixture();
        const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-validation-publish-fence-'));
        try {
          const id = `validation-publish-${mode}`;
          const store = new MemoryStore();
          let interleave = false;
          let armAfterPrepare = false;
          let interleaved = false;
          let concurrent: Run | undefined;
          const runner = {
            async run(file: string, args: readonly string[], options: Parameters<NonNullable<typeof fixture.runner.run>>[2]) {
              const result = await fixture.runner.run(file, args, options);
              if (interleave && file === 'git') {
                interleave = false;
                interleaved = true;
                if (mode === 'run-changed') {
                  const current = store.read(id)!;
                  concurrent = applyTransition(current, { type: 'escalate', reason: 'operator cancellation during validation publication checks' }, T0);
                  store.update(concurrent);
                } else if (mode === 'admission-stale') {
                  if (registry === undefined || admittedToken === undefined) throw new Error('Admission fence was not initialized before validation publication.');
                  registry.release(admittedToken, true);
                }
              }
              return result;
            },
          };
          const bootstrapImpl = new StandaloneGitBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner });
          const verifyRequests: VerifyDurableRequest[] = [];
          const bootstrap: ImplementationBootstrapAdapter = {
            kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
            plan: (request) => bootstrapImpl.plan(request),
            async prepare(request) {
              const prepared = await bootstrapImpl.prepare(request);
              if (armAfterPrepare) {
                armAfterPrepare = false;
                interleave = true;
              }
              return prepared;
            },
            guard: (identity) => bootstrapImpl.guard(identity),
            verifyDurable: async (request) => {
              verifyRequests.push(request);
              if (mode === 'adoption-proof-stale') {
                await bootstrapImpl.prepare({ runId: id, target: TARGET, baseBranch: identity.baseBranch, baseSha: identity.baseSha,
                  existing: identity, recoveryAuthority: { expectedHeadSha: head } });
              }
              return bootstrapImpl.verifyDurable(request);
            },
          };
          const planned = await bootstrap.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, publicationBranch: 'existing-pr' });
          const identity = await bootstrap.prepare({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: planned });
          const head = fixture.commit(identity.workspacePath, 'validated-change.txt', 'validated change\n', 'validation candidate');
          fixture.git(fixture.source, ['fetch', '--no-tags', '--no-recurse-submodules', identity.workspacePath, head]);
          fixture.git(fixture.source, ['push', 'origin', `${head}:refs/heads/existing-pr`]);
          const advancedDefaultHead = fixture.commit(fixture.source, 'advanced-default.txt', 'target advanced after PR base\n', 'advance target branch');
          fixture.git(fixture.source, ['push', 'origin', `${advancedDefaultHead}:refs/heads/${fixture.branch}`]);

          let run = createRun(TARGET, T0, id, {
            profile: 'routine', revision: 'validation-luna-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
          });
          run = applyTransition(run, { type: 'start' }, T0);
          run = applyTransition(run, { type: 'bootstrap_prepared', bootstrap: identity }, T0);
          run = applyTransition(run, {
            type: 'agent_succeeded', agentResult: successResult(head), headSha: head, pullRequest: { number: 7, headSha: head },
          }, T0);
          store.create(run);

          let registry: MissionAdmissionRegistry | undefined;
          let admittedToken: import('../src/mission-admission/registry.js').AdmissionToken | undefined;
          let productionMissionId = '';
          if (mode === 'admission-stale' || mode === 'publication-stale' || mode === 'current') {
            registry = new MissionAdmissionRegistry({
              filePath: path.join(directory, 'registry.json'),
              config: { schemaVersion: 1, revision: 'validation-publish-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
            });
            const admitted = registry.admit({
              laneId: 'captain', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, run: id },
            });
            assert.equal(admitted.outcome, 'admitted');
            if (admitted.outcome !== 'admitted') return;
            admittedToken = admitted.token;
            productionMissionId = mode === 'publication-stale' ? `${admitted.missionId}-stale` : admitted.missionId;
          }

          const github = githubAdapter([head, head, head]);
          github.readLiveSnapshot = async () => {
            const live = snapshot(head);
            return {
              ...live,
              repository: { ...live.repository, defaultBranch: fixture.branch, defaultBranchHeadSha: advancedDefaultHead },
              pullRequest: {
                ...live.pullRequest!, headSha: head, baseSha: fixture.baseSha,
                headRef: 'existing-pr', baseRef: fixture.branch, headRepository: { owner: 'acme', repo: 'widgets' },
              },
            };
          };
          let validationCalls = 0;
          const validation: ValidationAdapter = {
            kind: 'validation', configRevision: 'owned-validation-v1', requiresOwnedWorkspace: true,
            async validate(request) {
              validationCalls += 1;
              assert.equal(request.workspacePath, identity.workspacePath);
              return { ...validationPassed(request.headSha).local, configRevision: 'owned-validation-v1' };
            },
          };
          const commandsStart = fixture.commands.length;
          armAfterPrepare = true;
          const outcome = await runWorkflow(
            {
              store, github, implementation: new FakeImplementation([]), bootstrapForExecution: () => bootstrap,
              reviewer: new FakeReviewer([approve(head)]), validation, hostedCheckPolicy: TEST_HOSTED_POLICY,
            }, id,
            {
              maxReviewAttempts: 1, now: () => T0,
              ...(registry === undefined || admittedToken === undefined ? {} : {
                admissionFence: {
                  registry, token: admittedToken,
                  productionMissionId: productionMissionId || 'unneeded', executionWorkspace: identity.workspacePath,
                },
              }),
            },
          );

          const remoteHead = fixture.git(fixture.remote, ['for-each-ref', '--format=%(objectname)', 'refs/heads/existing-pr']);
          const pushes = fixture.commands.slice(commandsStart).filter((command) => command.file === 'git' && command.args.includes('push'));
          assert.equal(interleaved, mode !== 'publication-stale', 'Run/admission races occur during verification; stale publication authority is rejected before it');
          if (mode !== 'publication-stale') {
            assert.equal(verifyRequests.length, 1);
            assert.equal(verifyRequests[0]?.expectedHeadSha, head, 'verification binds to the exact published Run HEAD');
            assert.equal(verifyRequests[0]?.workspaceGuard !== undefined, true, 'verification uses a fresh physical workspace guard');
            assert.equal(verifyRequests[0]?.beforePublish, undefined, 'verification has no publication callback');
            assert.equal(verifyRequests[0]?.adoptExistingHead, true, 'the standalone verifier adopts the already-published HEAD');
            assert.equal(verifyRequests[0]?.progressBaseSha, identity.baseSha, 'the accepted identity base remains the immutable progress baseline');
            assert.notEqual(advancedDefaultHead, identity.baseSha, 'the live target branch has advanced beyond the persisted accepted base');
          } else {
            assert.equal(verifyRequests.length, 0, 'configured publication admission is checked before owned verification');
          }
          assert.equal(pushes.length, 0, 'owned validation verification never pushes');
          if (mode === 'run-changed') {
            assert.equal(outcome.outcome, 'needs_human');
            assert.deepEqual(store.read(id), concurrent, 'concurrent Run wins the pre-push CAS');
            assert.equal(remoteHead, head, 'verification leaves the existing PR ref unchanged');
            assert.equal(validationCalls, 0);
          } else if (mode === 'admission-stale' || mode === 'publication-stale') {
            assert.equal(outcome.outcome, 'needs_human');
            assert.equal(remoteHead, head, 'admission rejection leaves the existing PR ref unchanged');
            assert.equal(validationCalls, 0);
          } else if (mode === 'adoption-proof-stale') {
            assert.equal(outcome.outcome, 'needs_human', 'the stale captured source proof is rejected before validator entry');
            assert.match(outcome.reason, /STALE_IDENTITY|source-minted workspace guard/i);
            assert.equal(validationCalls, 0);
            assert.equal(remoteHead, head, 'stale proof refusal does not alter the published PR head');
          } else {
            assert.equal(outcome.outcome, 'merge_ready', outcome.outcome === 'needs_human' ? outcome.reason : undefined);
            assert.equal(remoteHead, head, 'the unchanged owner verifies and retains its exact published HEAD');
            assert.equal(remoteHead, head, 'the valid validation path keeps the exact published HEAD');
            assert.equal(validationCalls, 1);
          }
        } finally {
          fixture.cleanup();
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
  });

  it('validates linked owned workspaces with the real published-HEAD verifier and refuses no-progress heads before validator entry', async (t) => {
    for (const mode of ['progress', 'head-equals-base', 'same-tree-new-commit'] as const) await t.test(mode, async () => {
      const fixture = createBootstrapGitFixture();
      try {
        const id = `linked-owned-validation-${mode}`;
        const store = new MemoryStore();
        const bootstrapImpl = new GitWorktreeBootstrap({ repositoryRoot: fixture.source, workspaceRoot: fixture.workspaceRoot, runner: fixture.runner });
        const planned = await bootstrapImpl.plan({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha });
        const identity = await bootstrapImpl.prepare({ runId: id, target: TARGET, baseBranch: fixture.branch, baseSha: fixture.baseSha, existing: planned });
        let head = fixture.baseSha;
        if (mode === 'progress') {
          head = fixture.commit(identity.workspacePath, 'linked-validation.txt', 'validated linked change\n', 'linked validation candidate');
        } else if (mode === 'same-tree-new-commit') {
          fixture.git(identity.workspacePath, ['-c', 'user.name=Tachiko', '-c', 'user.email=tachiko@example.invalid', 'commit', '--allow-empty', '-m', 'same tree validation candidate']);
          head = fixture.git(identity.workspacePath, ['rev-parse', 'HEAD']);
        }
        fixture.git(identity.workspacePath, ['push', 'origin', `${head}:refs/heads/${identity.branch}`]);
        let run = reviewingRun(store, id, head);
        run = { ...run, bootstrap: identity };
        store.update(run);
        let verification: VerifyDurableRequest | undefined;
        const bootstrap: ImplementationBootstrapAdapter = {
          kind: 'implementation-bootstrap', bootstrapKind: 'linked-worktree',
          plan: (request) => bootstrapImpl.plan(request), prepare: (request) => bootstrapImpl.prepare(request),
          guard: (candidate) => bootstrapImpl.guard(candidate),
          async verifyDurable(request) {
            verification = request;
            return bootstrapImpl.verifyDurable(request);
          },
        };
        const github: GitHubAdapter = {
          ...githubAdapter([head, head, head, head]),
          async readLiveSnapshot() {
            const live = snapshot(head);
            return { ...live, repository: { ...live.repository, defaultBranch: fixture.branch, defaultBranchHeadSha: fixture.baseSha },
              pullRequest: { ...live.pullRequest!, headSha: head, baseSha: fixture.baseSha, headRef: identity.branch, baseRef: fixture.branch,
                headRepository: { owner: 'acme', repo: 'widgets' } } };
          },
        };
        let validationCalls = 0;
        const validation: ValidationAdapter = {
          kind: 'validation', configRevision: 'linked-owned-validation-v1', requiresOwnedWorkspace: true,
          async validate(request) {
            validationCalls += 1;
            assert.equal(request.headSha, head);
            assert.equal(request.workspacePath, identity.workspacePath);
            return { ...validationPassed(request.headSha).local, configRevision: 'linked-owned-validation-v1' };
          },
        };
        const commandsStart = fixture.commands.length;
        const result = await runWorkflow({
          store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([approve(head)]),
          validation, hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => bootstrap,
        }, id, { maxReviewAttempts: 1, now: () => T0 });
        const pushes = fixture.commands.slice(commandsStart).filter((command) => command.file === 'git' && command.args.includes('push'));
        assert.equal(verification?.expectedHeadSha, head);
        assert.ok(verification?.workspaceGuard, 'the real linked verifier receives a fresh physical guard');
        assert.equal(verification?.beforePublish, undefined);
        assert.equal(verification?.adoptExistingHead, undefined, 'linked worktrees do not use standalone adoption semantics');
        assert.equal(verification?.progressBaseSha, undefined, 'linked worktrees retain their established progress base');
        assert.equal(pushes.length, 0, 'owned linked-worktree validation performs no publication');
        if (mode === 'progress') {
          assert.equal(result.outcome, 'merge_ready', result.outcome === 'needs_human' ? result.reason : undefined);
          assert.equal(validationCalls, 1);
        } else {
          assert.equal(result.outcome, 'needs_human', 'the real verifier refuses a head without tree progress');
          assert.match(result.reason, /HEAD_MISMATCH|tree progress/);
          assert.equal(validationCalls, 0, 'a refused published head never enters the validator');
        }
      } finally { fixture.cleanup(); }
    });
  });

  it('refuses owned validation when the PR disappears or its published HEAD differs before verification', async (t) => {
    for (const mode of ['missing-pr', 'head-mismatch'] as const) await t.test(mode, async () => {
      const store = new MemoryStore();
      const id = `owned-validation-${mode}`;
      const bootstrap = new FakeBootstrap();
      let run = reviewingRun(store, id, HEAD);
      run = { ...run, bootstrap: bootstrap.identity };
      store.update(run);
      let validationCalls = 0;
      let verificationCalls = 0;
      bootstrap.verifyDurable = async (request: VerifyDurableRequest) => {
        verificationCalls += 1;
        return { headSha: request.expectedHeadSha, branch: bootstrap.identity.branch };
      };
      const validation: ValidationAdapter = {
        kind: 'validation', configRevision: `owned-validation-${mode}-v1`, requiresOwnedWorkspace: true,
        async validate(request) { validationCalls += 1; return { ...validationPassed(request.headSha).local, configRevision: this.configRevision }; },
      };
      const github: GitHubAdapter = {
        ...githubAdapter([HEAD, HEAD, HEAD, HEAD]),
        async readLiveSnapshot() {
          if (store.read(id)?.state !== 'VALIDATING') return snapshot(HEAD);
          if (mode === 'missing-pr') return { ...snapshot(HEAD), pullRequest: null, headSha: null };
          const moved = snapshot(HEAD2);
          return moved;
        },
      };
      const result = await runWorkflow({
        store, github, implementation: new FakeImplementation([]), reviewer: new FakeReviewer([approve(HEAD)]),
        validation, hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrapForExecution: () => bootstrap,
      }, id, { maxReviewAttempts: 1, now: () => T0 });
      assert.equal(result.outcome, 'needs_human');
      assert.equal(validationCalls, 0, 'live identity refusal prevents local validation entry');
      assert.equal(verificationCalls, 0, 'live identity refusal prevents owned-workspace verification');
      assert.match(result.reason, mode === 'missing-pr' ? /pull request identity is unavailable|no associated open pull request/i : /does not match the implementation HEAD/i);
    });
  });

  it('rechecks the immutable validation Run at owned-workspace preparation entry after host callbacks', async () => {
    const store = new MemoryStore();
    const id = 'owned-validation-prepare-entry-run-supersession';
    const bootstrap = new class extends FakeBootstrap {
      prepareCalls = 0;
      verifyCalls = 0;
      override async prepare(..._args: unknown[]) { this.prepareCalls += 1; return this.identity; }
      override async verifyDurable(request: { expectedHeadSha: string }) {
        this.verifyCalls += 1;
        return { headSha: request.expectedHeadSha, branch: this.identity.branch };
      }
    }();
    let run = reviewingRun(store, id, HEAD);
    run = { ...run, bootstrap: bootstrap.identity };
    store.update(run);
    let newerRun: Run | undefined;
    let validationCalls = 0;
    const validation: ValidationAdapter = {
      kind: 'validation', configRevision: 'owned-validation-entry-v1', requiresOwnedWorkspace: true,
      async validate(request) {
        validationCalls += 1;
        return { ...validationPassed(request.headSha).local, configRevision: 'owned-validation-entry-v1' };
      },
    };
    const result = await runWorkflow({
      store, github: githubAdapter([HEAD, HEAD, HEAD, HEAD]), implementation: new FakeImplementation([]),
      reviewer: new FakeReviewer([approve(HEAD)]), validation, hostedCheckPolicy: TEST_HOSTED_POLICY, bootstrap,
    }, id, { maxReviewAttempts: 1, now: () => T0, onExecutionStart: () => {
      if (store.read(id)?.state !== 'VALIDATING') return;
      newerRun = { ...store.read(id)!, updatedAt: '2026-09-28T00:00:06.000Z' };
      store.update(newerRun);
    } });

    assert.equal(result.outcome, 'needs_human', JSON.stringify(result));
    assert.ok(newerRun);
    assert.deepEqual(store.read(id), newerRun, 'the complete newer Run remains unchanged');
    assert.equal(bootstrap.prepareCalls, 0, 'owned preparation is refused before the adapter entry');
    assert.equal(bootstrap.verifyCalls, 0, 'durable verification does not run after stale entry authority');
    assert.equal(validationCalls, 0, 'the validator does not run after stale entry authority');
  });

  it('holds an unqualified implementation before governed worker or publication effects', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-worker-publish-fence-'));
    try {
      const registry = new MissionAdmissionRegistry({
        filePath: path.join(directory, 'registry.json'),
        config: { schemaVersion: 1, revision: 'worker-publish-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
      });
      const id = 'worker-publish-fence-unqualified';
      const admitted = registry.admit({
        laneId: 'captain', role: 'production_captain',
        evidence: { repository: 'acme/widgets', issue: 42, run: id },
      });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') return;
      const store = new MemoryStore();
      store.create(createRun(TARGET, T0, id));
      let providerCalls = 0;
      let pullRequestCreates = 0;
      const implementation: ImplementationAgent = {
        kind: 'implementation-agent',
        prepareGovernedInvocation() { return { status: 'qualified', agent: this }; },
        async run() { providerCalls += 1; return successResult(HEAD); },
      };
      const github = githubAdapter([null, null]);
      github.createImplementationPullRequest = async () => { pullRequestCreates += 1; return { number: 8 }; };
      const outcome = await runWorkflow(
        { store, github, implementation, bootstrap: new FakeBootstrap(), reviewer: new FakeReviewer([]) }, id,
        { maxReviewAttempts: 1, now: () => T0, admissionFence: {
          registry, token: admitted.token, productionMissionId: admitted.missionId, executionWorkspace: '/tmp/tachiko-workspace',
        } },
      );
      assert.equal(outcome.outcome, 'needs_human');
      assert.equal(providerCalls, 0, 'an injected qualified result cannot grant governed execution authority');
      assert.equal(pullRequestCreates, 0, 'held implementation cannot reach PR publication');
      assert.equal(store.read(id)?.agentResult, undefined, 'the hold does not invent a provider result');
    } finally {
      rmSync(directory, { recursive: true, force: true });
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

  it('refuses conflicting parsed identity claims before Luna bootstrap, model, or PR publication', async () => {
    const claimedHeadA = '1111111111111111111111111111111111111111';
    const claimedHeadB = '2222222222222222222222222222222222222222';
    const entry = {
      id: 'comment-conflicting-identity',
      scope: 'issue' as const,
      kind: 'comment' as const,
      author: 'steward',
      body: `<!-- agent-handoff:v1 -->\n\n## Accepted #48-A scope\n\nOnly the bounded packet builder slice.\n\n## Branch / PR\n\nHEAD: \`${claimedHeadA}\`\nOther candidate: \`${claimedHeadB}\`\nPR: #7\nPrevious PR: #8`,
      createdAt: T0,
      updatedAt: T0,
      url: 'https://github.test/issues/42#comment-conflicting-identity',
    };
    const parsed = parseAgentHandoffs([entry], { headSha: null, pullRequestNumber: null });
    const live: GitHubLiveSnapshot = {
      ...snapshot(HEAD),
      pullRequest: null,
      headSha: null,
      conversations: [entry],
      handoff: parsed.handoff,
      problems: parsed.problems,
    };
    const store = new MemoryStore();
    const execution = { profile: 'routine' as const, revision: 'luna-test', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 1, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const };
    store.create(createRun(TARGET, T0, 'ambiguous-handoff-initial', execution));

    class CountingBootstrap extends FakeBootstrap {
      planCalls = 0;
      prepareCalls = 0;
      override async plan() { this.planCalls += 1; return this.identity; }
      override async prepare(..._args: unknown[]) { this.prepareCalls += 1; return this.identity; }
    }
    const bootstrap = new CountingBootstrap();
    const implementation = new FakeImplementation([successResult(HEAD)]);
    let publications = 0;
    const github: GitHubAdapter = {
      ...githubAdapter([null]),
      async readLiveSnapshot() { return live; },
      async createImplementationPullRequest() { publications += 1; return { number: 8 }; },
    };

    const result = await runWorkflow(
      { store, github, implementation, reviewer: new FakeReviewer([]), bootstrapForExecution: () => bootstrap },
      'ambiguous-handoff-initial',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    const observedSideEffects = {
      bootstrapPlan: bootstrap.planCalls,
      bootstrapPrepare: bootstrap.prepareCalls,
      governedPreflight: implementation.preflightRequests.length,
      modelTurn: implementation.requests.length,
      publication: publications,
    };
    assert.deepEqual(observedSideEffects, {
      bootstrapPlan: 0,
      bootstrapPrepare: 0,
      governedPreflight: 0,
      modelTurn: 0,
      publication: 0,
    }, `conflicting identity must refuse before effects; outcome=${result.outcome}; reason=${'reason' in result ? result.reason : ''}`);
    assert.equal(result.outcome, 'needs_human');
    assert.match('reason' in result ? result.reason : '', /PACKET_AUTHORITY_MISSING/);
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
    assert.match(implementation.requests[0]?.instructions ?? '', /Packet: tachiko\.implementation-packet\.v1/);
    assert.match(implementation.requests[0]?.instructions ?? '', /Accepted scope and instructions:\nTest scope for isolated worker tests\./);
    assert.match(implementation.requests[0]?.instructions ?? '', /Issue requirements:\nDoR-ready\./);
    assert.equal(implementation.requests[0]?.packet?.kind, 'initial');
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
      executor: { provider: 'codex-cli', sessionId: 'thread-from-disk', generation: 'generation-from-disk' },
      agentResult: {
        ...successResult(HEAD),
        executor: { provider: 'codex-cli', sessionId: 'thread-from-disk', generation: 'generation-from-disk' },
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
      generation: 'generation-from-disk',
    });
  });

  it('resumes a persisted in-flight fix with the blocking findings instead of the issue body', async () => {
    const store = new MemoryStore();
    let run = reviewingRun(store, 'run-1', HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = { ...run, state: 'IMPLEMENTING', history: [...run.history,
      { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }] };
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

  it('restarts a Luna repair and continues only with the durably adopted codex-cli identity', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-repair-handoff-restart-'));
    try {
      const store = new JsonFileStore({ dir: directory });
      const id = 'repair-handoff-restart';
      let run = reviewingRun(store, id, HEAD);
      run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
      run = {
        ...run,
        repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'bounded' },
        executor: { provider: 'claude-code', sessionId: 'old-claude-session' },
        agentResult: { ...run.agentResult!, sessionId: 'old-claude-session', executor: { provider: 'claude-code', sessionId: 'old-claude-session' } },
      };
      const execution: ResolvedExecutionConfiguration = {
        profile: 'routine', revision: 'repair-profiles-v1', executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000,
      };
      const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
      const binding = createRepairAttemptBinding(run, execution);
      assert.equal(binding.freshExecutor, true);
      run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
      store.update(run);

      let implementationStarted = false;
      let firstPostWorkerRead = true;
      let secondInvocationStarted = false;
      let thirdInvocationStarted = false;
      let thirdWorkerCompleted = false;
      const github = githubAdapter(Array(20).fill(HEAD));
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      github.readLiveSnapshot = async (target) => {
        if (implementationStarted && firstPostWorkerRead) {
          firstPostWorkerRead = false;
          const independentlyLoaded = new JsonFileStore({ dir: directory }).read(id);
          assert.equal(independentlyLoaded?.history.at(-1)?.type, 'repair_executor_handoff');
          assert.equal(independentlyLoaded?.executor?.provider, 'codex-cli');
          assert.equal(independentlyLoaded?.executor?.sessionId, 'captured-session');
          throw new Error('simulated process interruption after durable handoff, before GitHub verification');
        }
        const live = thirdInvocationStarted
          ? snapshot(thirdWorkerCompleted ? HEAD2 : HEAD)
          : secondInvocationStarted ? snapshot(HEAD2) : await readLiveSnapshot(target);
        return { ...live, pullRequest: { ...live.pullRequest!, headRef: 'existing-pr', baseRef: 'main', headRepository: { owner: 'acme', repo: 'widgets' } } };
      };
      const implementation = new FakeImplementation([
        { ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'captured-session' }, sessionId: 'captured-session' },
        { ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'new-session-after-restart' }, sessionId: 'new-session-after-restart' },
        { ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'captured-session' }, sessionId: 'captured-session' },
      ]);
      const invoke = implementation.run.bind(implementation);
      let invocationCount = 0;
      implementation.run = async (request) => {
        invocationCount += 1;
        implementationStarted = true;
        if (invocationCount === 2) secondInvocationStarted = true;
        if (invocationCount === 3) thirdInvocationStarted = true;
        const result = await invoke(request);
        if (invocationCount === 3) thirdWorkerCompleted = true;
        return result;
      };
      const bootstrapIdentity = {
        bootstrapKind: 'standalone-isolated' as const, owner: 'acme', repo: 'widgets', issueNumber: 42,
        baseBranch: 'main', baseSha: 'base', branch: `tachiko/${id}`, publicationBranch: 'existing-pr', workspacePath: `/tmp/${id}`,
      };
      const bootstrap: ImplementationBootstrapAdapter = {
        kind: 'implementation-bootstrap', bootstrapKind: 'standalone-isolated',
        async plan() { return bootstrapIdentity; },
        async prepare() { return bootstrapIdentity; },
        guard() { return { assertValid: () => undefined }; },
        async verifyDurable(request) { return { headSha: request.expectedHeadSha, branch: bootstrapIdentity.branch }; },
      };
      const deps = {
        store, github, implementation, reviewer: new FakeReviewer([approve(HEAD2)]),
        validation: new FakeValidation(), hostedCheckPolicy: TEST_HOSTED_POLICY,
        resolveRepairExecutionProfile: () => execution,
        bootstrapForExecution: () => bootstrap,
      };
      const first = await runWorkflow(deps, id, { maxReviewAttempts: 2, now: () => T0 });
      assert.equal(first.outcome, 'needs_human');
      assert.equal(implementation.requests.length, 1, first.outcome === 'needs_human' ? first.reason : 'worker was not invoked');
      assert.equal(implementation.requests[0]?.executor, undefined);
      assert.equal(implementation.requests[0]?.sessionId, undefined);
      const parked = new JsonFileStore({ dir: directory }).read(id);
      assert.equal(parked?.state, 'NEEDS_HUMAN');
      assert.equal(parked?.history.some((event) => event.type === 'repair_executor_handoff'), true);
      const resumed = applyTransition(parked!, { type: 'human_resolved', reason: 'Retry after interrupted GitHub verification' }, T0);
      store.update(resumed);

      const restartedStore = new JsonFileStore({ dir: directory });
      const second = await runWorkflow({ ...deps, store: restartedStore }, id, { maxReviewAttempts: 2, now: () => T0 });
      assert.equal(second.outcome, 'needs_human', 'a restarted Luna worker cannot rotate the already adopted provider session');
      assert.equal(implementation.requests[1]?.executor, undefined, 'Luna remains isolated after restart');
      assert.equal(implementation.requests[1]?.sessionId, undefined, 'the prior codex-cli identity is never injected into Luna');
      assert.equal(implementation.requests[1]?.runtimeOwnership?.generation, implementation.requests[0]?.runtimeOwnership?.generation);
      assert.equal(second.run.executor?.sessionId, 'captured-session');
      assert.equal(second.run.history.filter((event) => event.type === 'repair_executor_handoff').length, 1);
      assert.equal(second.run.history.filter((event) => event.type === 'repair_executor_continued').length, 0);
      const held = new JsonFileStore({ dir: directory }).read(id)!;
      assert.equal(held.executor?.sessionId, 'captured-session', 'the last adopted executor remains authoritative after the refused result');
      assert.equal(held.history.filter((event) => event.type === 'repair_executor_handoff').length, 1);
      assert.equal(held.history.filter((event) => event.type === 'repair_executor_continued').length, 0);

      store.update(applyTransition(held, { type: 'human_resolved', reason: 'Retry with the retained executor identity' }, T0));
      secondInvocationStarted = false;
      const third = await runWorkflow({ ...deps, store: new JsonFileStore({ dir: directory }) }, id, { maxReviewAttempts: 2, now: () => T0 });
      assert.equal(third.outcome, 'merge_ready', third.outcome === 'needs_human' ? third.reason : undefined);
      assert.equal(third.run.executor?.sessionId, 'captured-session');
      assert.equal(third.run.history.filter((event) => event.type === 'repair_executor_handoff').length, 1);
      assert.equal(third.run.history.filter((event) => event.type === 'repair_executor_continued').length, 1);
      assert.equal(implementation.requests[2]?.executor, undefined, 'Luna stays isolated on the exact-identity retry');
    } finally { rmSync(directory, { recursive: true, force: true }); }
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
    run = { ...run, state: 'IMPLEMENTING', history: [...run.history,
      { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }] };
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
    assert.match(implementation.requests[0]?.instructions ?? '', /Issue requirements:\nDoR-ready\./);
    assert.match(implementation.requests[0]?.instructions ?? '', /Blocking findings:\n1\. \[blocking\] the diff has a bug/);
    assert.equal(implementation.requests[0]?.packet?.kind, 'review-repair');
    assert.equal(store.read(run.id)?.bootstrap?.bootstrapKind, 'standalone-isolated');
  });

  it('does not reuse a legacy session for a promoted provider when its original provider is unknown', async () => {
    const store = new MemoryStore();
    const id = 'legacy-session-unknown-provider';
    const execution: ResolvedExecutionConfiguration = { profile: 'complex', revision: 'legacy-repair-v1', executor: 'codex-cli', timeoutMs: 60_000 };
    let run = reviewingRun(store, id, HEAD);
    run = {
      ...run,
      repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' },
      agentResult: { ...run.agentResult!, sessionId: 'unqualified-legacy-session' },
    };
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = {
      ...run,
      repairAdmissions: [{
        authorityRevision: 'task-shape-v1', taskShape: 'interacting', taxonomyRevision: 'repair-finding-taxonomy-v1',
        finding: 'review_blocking', headSha: HEAD, pullRequestNumber: 7, executionProfile: 'complex',
        executionRevision: execution.revision, execution, admittedAt: T0,
      }],
    };
    run = { ...run, state: 'IMPLEMENTING', history: [...run.history,
      { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }] };
    store.update(run);
    const implementation = new FakeImplementation([{ ...successResult(HEAD2), executor: { provider: 'codex-cli', sessionId: 'new-session' }, sessionId: 'new-session' }]);
    const result = await runWorkflow({
      store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]),
      resolveRepairExecutionProfile: () => execution,
    }, id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(result.outcome, 'needs_human');
    assert.match(result.reason, /missing, stale, or its exact execution profile can no longer be resolved/);
    assert.equal(implementation.requests.length, 0);
    assert.equal(store.read(id)?.agentResult?.sessionId, 'unqualified-legacy-session');
  });

  it('does not treat a marked attempt with missing binding as legacy authority', async () => {
    const store = new MemoryStore();
    const id = 'marked-attempt-missing-binding';
    const execution: ResolvedExecutionConfiguration = { profile: 'complex', revision: 'legacy-repair-v1', executor: 'codex-cli', timeoutMs: 60_000 };
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const identity = { provider: 'codex-cli', sessionId: 'same-provider-session' } as const;
    run = {
      ...run,
      repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' },
      executor: identity,
      agentResult: { ...run.agentResult!, executor: identity, sessionId: identity.sessionId },
      repairAdmissions: [{
        authorityRevision: 'task-shape-v1', taskShape: 'interacting', taxonomyRevision: 'repair-finding-taxonomy-v1',
        finding: 'review_blocking', headSha: HEAD, pullRequestNumber: 7, executionProfile: 'complex',
        executionRevision: execution.revision, execution, admittedAt: T0,
      }],
      state: 'IMPLEMENTING',
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0, repairAdmissionIndex: 0 }],
    };
    store.update(run);
    let invocationEffects = 0;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run() { invocationEffects += 1; return { ...successResult(HEAD2), executor: identity, sessionId: identity.sessionId }; },
    };
    const outcome = await runWorkflow({
      store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]),
      resolveRepairExecutionProfile: () => execution,
    }, id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(invocationEffects, 0);
    assert.equal(outcome.run.executor?.sessionId, identity.sessionId);
  });

  it('holds a custom-store bound attempt missing current authority or finding evidence before execution effects', async (t) => {
    for (const missing of ['authority', 'review finding', 'validation finding'] as const) {
      await t.test(missing, async () => {
        const store = new MemoryStore();
        const id = `bound-attempt-missing-${missing.replaceAll(' ', '-')}`;
        let run = reviewingRun(store, id, HEAD);
        run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
        const authority = { revision: 'task-shape-v1', shape: 'bounded' as const };
        run = { ...run, repairTaskShapeAuthority: authority };
        if (missing === 'validation finding') {
          run = { ...run, reviewResult: approve(HEAD), validationResult: validationFailed(HEAD) };
        }
        const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 60_000 };
        const finding = missing === 'validation finding' ? 'validation_failed' : 'review_blocking';
        const receipt = createRepairAdmissionSnapshot(authority, finding, HEAD, 7, execution, T0);
        const binding = createRepairAttemptBinding(run, execution);
        run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
        run = missing === 'authority'
          ? { ...run, repairTaskShapeAuthority: undefined }
          : missing === 'validation finding'
            ? { ...run, validationResult: undefined }
          : { ...run, reviewResult: undefined };
        store.update(run);

        let publicationChecks = 0;
        const implementation = new FakeImplementation([successResult(HEAD2)]);
        const invoke = implementation.run.bind(implementation);
        implementation.run = async (request) => {
          if (request.beforePublish !== undefined) {
            publicationChecks += 1;
            request.beforePublish();
          }
          return invoke(request);
        };
        const reviewer = new FakeReviewer([approve(HEAD2)]);
        const validation = new FakeValidation();
        let bootstrapSelections = 0;
        let profileSelections = 0;
        let executionStarts = 0;
        const outcome = await runWorkflow({
          store,
          github: githubAdapter([HEAD]),
          implementation,
          reviewer,
          validation,
          hostedCheckPolicy: TEST_HOSTED_POLICY,
          resolveRepairExecutionProfile: () => { profileSelections += 1; return execution; },
          bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
        }, id, { maxReviewAttempts: 1, now: () => T0, onExecutionStart: () => { executionStarts += 1; } });

        assert.equal(outcome.outcome, 'needs_human');
        assert.match(outcome.reason, /missing, stale, or its exact execution profile can no longer be resolved/);
        assert.equal(implementation.preflightRequests.length + implementation.requests.length, 0);
        assert.equal(reviewer.requests.length + validation.requests.length, 0);
        assert.equal(bootstrapSelections + profileSelections + executionStarts + publicationChecks, 0);
        assert.deepEqual(outcome.run.executor, run.executor);
        assert.deepEqual(outcome.run.agentResult, run.agentResult);
        assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
      });
    }
  });

  it('rejects an injected generationless nonfresh App Server admission before bootstrap selection', async () => {
    const store = new MemoryStore();
    const id = 'injected-generationless-appserver-admission';
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const authority = { revision: 'task-shape-v1', shape: 'bounded' as const };
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    const execution: ResolvedExecutionConfiguration = { profile: 'routine', revision: 'repair-v1', executor: 'codex-cli', timeoutMs: 60_000 };
    run = { ...run, repairTaskShapeAuthority: authority, execution: undefined, executor: predecessor,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId } };
    const receipt = createRepairAdmissionSnapshot(authority, 'review_blocking', HEAD, 7, execution, T0);
    const attemptBinding = { admissionIndex: 0, startFixHistoryIndex: run.history.length, predecessorExecutor: predecessor,
      predecessorSessionId: predecessor.sessionId, freshExecutor: false, runtimeGeneration: 'invented-generation' };
    run = { ...run, repairAdmissions: [{ ...receipt, attemptBinding }], state: 'IMPLEMENTING',
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0, repairAdmissionIndex: 0 }] };
    store.update(run);
    let implementationCalls = 0; let bootstrapSelections = 0;
    const outcome = await runWorkflow({
      store, github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { implementationCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]), resolveRepairExecutionProfile: () => execution,
      bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
    }, id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /missing, stale, or its exact execution profile can no longer be resolved/);
    assert.equal(implementationCalls + bootstrapSelections, 0);
    assert.deepEqual(outcome.run.executor, predecessor);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('holds a legacy generationless App Server repair before bootstrap selection or provider work', async () => {
    const store = new MemoryStore();
    const id = 'legacy-generationless-appserver-repair';
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = {
      ...run,
      state: 'IMPLEMENTING',
      execution: undefined,
      executor: predecessor,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }],
    };
    store.update(run);
    let implementationCalls = 0;
    let bootstrapSelections = 0;
    const outcome = await runWorkflow({
      store,
      github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { implementationCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]),
      bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
    }, id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /App Server identity has no generation/);
    assert.equal(implementationCalls, 0);
    assert.equal(bootstrapSelections, 0);
    assert.deepEqual(outcome.run.executor, predecessor);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
    assert.equal(outcome.run.history.at(-1)?.to, 'NEEDS_HUMAN');
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('holds a result-only generationless App Server identity despite an explicit different provider', async () => {
    const store = new MemoryStore();
    const id = 'legacy-result-only-appserver-repair';
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = {
      ...run,
      state: 'IMPLEMENTING',
      execution: { profile: 'routine', revision: 'legacy-v1', executor: 'claude-code', timeoutMs: 60_000 },
      executor: undefined,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }],
    };
    store.update(run);
    let implementationCalls = 0;
    let bootstrapSelections = 0;
    const outcome = await runWorkflow({
      store,
      github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { implementationCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]),
      bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
    }, id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /App Server identity has no generation/);
    assert.equal(implementationCalls, 0);
    assert.equal(bootstrapSelections, 0);
    assert.equal(outcome.run.executor, undefined);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('holds a Run-carried generationless App Server identity despite explicit different-provider execution', async () => {
    const store = new MemoryStore();
    const id = 'legacy-run-carrier-different-provider';
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = { ...run, state: 'IMPLEMENTING', execution: { profile: 'routine', revision: 'legacy-v1', executor: 'claude-code', timeoutMs: 60_000 },
      executor: predecessor, agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }] };
    store.update(run);
    let implementationCalls = 0; let bootstrapSelections = 0;
    const outcome = await runWorkflow({
      store, github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { implementationCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]), bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
    }, id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(implementationCalls + bootstrapSelections, 0);
    assert.deepEqual(outcome.run.executor, predecessor);
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('holds a result-only generationless App Server identity when execution is absent', async () => {
    const store = new MemoryStore();
    const id = 'legacy-result-carrier-no-execution';
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    const predecessor = { provider: 'codex-app-server', sessionId: 'legacy-app-session' } as const;
    run = { ...run, state: 'IMPLEMENTING', execution: undefined, executor: undefined,
      agentResult: { ...run.agentResult!, executor: predecessor, sessionId: predecessor.sessionId },
      history: [...run.history, { type: 'start_fix', from: 'CHANGES_REQUESTED', to: 'IMPLEMENTING', at: T0 }] };
    store.update(run);
    let implementationCalls = 0; let bootstrapSelections = 0;
    const outcome = await runWorkflow({
      store, github: githubAdapter([HEAD]),
      implementation: { kind: 'implementation-agent', async run() { implementationCalls += 1; return successResult(HEAD2); } },
      reviewer: new FakeReviewer([]), bootstrapForExecution: () => { bootstrapSelections += 1; return new FakeBootstrap(); },
    }, id, { maxReviewAttempts: 1, now: () => T0 });
    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(implementationCalls + bootstrapSelections, 0);
    assert.equal(outcome.run.executor, undefined);
    assert.deepEqual(outcome.run.agentResult?.executor, predecessor);
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn' && event.role === 'worker'), false);
  });

  it('holds consumed repair evidence when the durable adopted identity no longer matches history', async () => {
    const store = new MemoryStore();
    const id = 'consumed-adopted-identity-mismatch';
    const execution: ResolvedExecutionConfiguration = { profile: 'complex', revision: 'repair-profile-v1', executor: 'codex-cli', timeoutMs: 60_000 };
    let run = reviewingRun(store, id, HEAD);
    run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
    run = {
      ...run,
      repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' },
      executor: { provider: 'codex-cli', sessionId: 'predecessor-session' },
      agentResult: { ...run.agentResult!, sessionId: 'predecessor-session', executor: { provider: 'codex-cli', sessionId: 'predecessor-session' } },
    };
    const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
    const binding = createRepairAttemptBinding(run, execution);
    run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
    const adopted = { provider: 'codex-cli', sessionId: 'predecessor-session' } as const;
    run = applyTransition(run, { type: 'repair_executor_handoff', repairAgentResult: { ...successResult(HEAD2), executor: adopted, sessionId: adopted.sessionId } }, T0);
    run = { ...run, executor: { provider: 'claude-code', sessionId: 'forged-current-session' } };
    store.create(run);
    let invocationEffects = 0;
    const implementation: ImplementationAgent = {
      kind: 'implementation-agent',
      async run() { invocationEffects += 1; return successResult(HEAD2); },
    };
    const outcome = await runWorkflow({
      store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]),
      resolveRepairExecutionProfile: () => execution,
    }, id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(outcome.outcome, 'needs_human');
    assert.equal(invocationEffects, 0);
    assert.equal(outcome.run.executor?.provider, 'claude-code');
  });

  it('holds before provider effects when bound repair provenance, predecessor, finding, or execution snapshot drifts', async (t) => {
    const cases = ['authority', 'finding', 'admission-index', 'profile-revision', 'full-execution', 'resolved-execution', 'predecessor-session', 'predecessor-executor'] as const;
    for (const scenario of cases) {
      await t.test(scenario, async () => {
        const store = new MemoryStore();
        const id = `repair-provenance-${scenario}`;
        const execution: ResolvedExecutionConfiguration = { profile: 'complex', revision: 'repair-profile-v1', executor: 'codex-cli', timeoutMs: 60_000 };
        let run = reviewingRun(store, id, HEAD);
        run = applyTransition(run, { type: 'changes_requested', reviewResult: requestChanges(HEAD) }, T0, TEST_VALIDATION_AUTHORITY);
        run = {
          ...run,
          repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' },
          executor: { provider: 'claude-code', sessionId: 'predecessor-session' },
          agentResult: { ...run.agentResult!, sessionId: 'predecessor-session', executor: { provider: 'claude-code', sessionId: 'predecessor-session' } },
        };
        const receipt = createRepairAdmissionSnapshot(run.repairTaskShapeAuthority!, 'review_blocking', HEAD, 7, execution, T0);
        const binding = createRepairAttemptBinding(run, execution);
        run = applyTransition(run, { type: 'start_fix', repairAdmission: { ...receipt, attemptBinding: binding } }, T0);
        if (scenario === 'authority') run = { ...run, repairTaskShapeAuthority: { revision: 'changed-authority', shape: 'interacting' } };
        if (scenario === 'finding') run = { ...run, validationResult: validationFailed(HEAD), reviewResult: approve(HEAD) };
        if (scenario === 'admission-index') run = { ...run, repairAdmissions: [{ ...receipt, attemptBinding: { ...binding, startFixHistoryIndex: binding.startFixHistoryIndex + 1 } }] };
        if (scenario === 'profile-revision') run = { ...run, repairAdmissions: [{ ...receipt, attemptBinding: binding, executionRevision: 'rewritten-revision' }] };
        if (scenario === 'full-execution') run = { ...run, repairAdmissions: [{ ...receipt, attemptBinding: binding, execution: { ...execution, timeoutMs: 30_000 } }] };
        if (scenario === 'predecessor-session') run = { ...run, agentResult: { ...run.agentResult!, sessionId: 'changed-current-session' } };
        if (scenario === 'predecessor-executor') run = { ...run, executor: { provider: 'codex-cli', sessionId: 'changed-current-executor' } };
        store.create(run);
        let invocationEffects = 0;
        const implementation: ImplementationAgent = {
          kind: 'implementation-agent',
          async run() { invocationEffects += 1; return successResult(HEAD2); },
        };
        const resolved = scenario === 'resolved-execution' ? { ...execution, timeoutMs: 30_000 } : execution;
        const outcome = await runWorkflow({
          store, github: githubAdapter([HEAD]), implementation, reviewer: new FakeReviewer([]),
          resolveRepairExecutionProfile: () => resolved,
        }, id, { maxReviewAttempts: 1, now: () => T0 });

        assert.equal(outcome.outcome, 'needs_human');
        assert.equal(invocationEffects, 0);
        assert.deepEqual(outcome.run.executor, run.executor);
        assert.equal(outcome.run.agentResult?.sessionId, run.agentResult?.sessionId);
      });
    }
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

  it('holds before bootstrap, worker, or readiness when the production live adapter rejects malformed PR state', async () => {
    const store = new MemoryStore();
    const run = createRun(TARGET, T0, 'workflow-invalid-pull-request-state');
    store.create(run);
    const calls: string[] = [];
    const malformedPull = {
      node_id: 'PR_7', number: 7, title: 'Fix', body: 'Closes #42',
      draft: false, html_url: 'https://github.test/acme/widgets/pull/7',
      updated_at: T0, merged_at: null,
      head: { sha: HEAD, ref: 'tachiko/issue-42-test', repo: { name: 'widgets', owner: { login: 'acme' } } },
      base: { sha: 'base', ref: 'main', repo: { name: 'widgets', owner: { login: 'acme' } } },
    };
    const transport: GitHubApiTransport = {
      async get(path) {
        calls.push(`get:${path}`);
        if (path === 'repos/acme/widgets/issues/42') {
          return {
            node_id: 'I_42', number: 42, title: 'Fix', body: 'DoR-ready.', state: 'open',
            html_url: 'https://github.test/acme/widgets/issues/42', created_at: T0, updated_at: T0,
          };
        }
        if (path === 'repos/acme/widgets/pulls/7') return malformedPull;
        throw new Error(`Unexpected GitHub route ${path}`);
      },
      async getPaginated(path) {
        calls.push(`paginated:${path}`);
        if (path === 'repos/acme/widgets/issues/42/timeline') {
          return [{ event: 'cross-referenced', source: { issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' } } } }];
        }
        throw new Error(`Unexpected GitHub collection ${path}`);
      },
    };
    const github = new LiveGitHubAdapter({ transport, now: () => T0 });
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);
    const validation = new FakeValidation();
    let bootstrapSelections = 0;
    let planCalls = 0;
    let prepareCalls = 0;
    const bootstrap = new class extends FakeBootstrap {
      override async plan() { planCalls += 1; return this.identity; }
      override async prepare(..._args: unknown[]) { prepareCalls += 1; return this.identity; }
    }();

    const outcome = await runWorkflow({
      store, github, implementation, reviewer, validation, bootstrap,
      bootstrapForExecution() { bootstrapSelections += 1; return bootstrap; },
    }, run.id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(outcome.outcome, 'needs_human');
    assert.match(outcome.reason, /GitHub live state could not be read safely/);
    assert.equal(bootstrapSelections, 0);
    assert.equal(planCalls, 0);
    assert.equal(prepareCalls, 0);
    assert.equal(implementation.requests.length, 0);
    assert.equal(reviewer.requests.length, 0);
    assert.equal(validation.requests.length, 0);
    assert.deepEqual(calls, [
      'get:repos/acme/widgets/issues/42',
      'paginated:repos/acme/widgets/issues/42/timeline',
      'get:repos/acme/widgets/pulls/7',
    ], 'the production adapter refuses the malformed authority before later workflow reads');
    assert.equal((outcome.run.telemetry?.events ?? []).some((event) => event.kind === 'spawn'), false);
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
