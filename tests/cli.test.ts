import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  githubSnapshotCommand,
  assertCanonicalDispatchResumeClaim,
  findRunByTarget,
  LIVE_HEAD_SYNC_DECISION,
  main,
  parseIssueNumber,
  parseIssueRef,
  printDispatchResult,
  recoverRunAdmission,
  resolveCodexExecutionConfig,
  resolveSelectedExecutionProfile,
  resolveHostedCheckPolicyConfiguration,
  resolveLocalValidationConfiguration,
  resolveImplementationProvider,
  resolveRunsDir,
  runCreateCommand,
  runIssueCommand,
  resumeCommand,
  runShowCommand,
  runShowView,
  runTransitionCommand,
} from '../src/cli.js';
import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, ReviewResult, Run, TransitionType } from '../src/domain/types.js';
import { GitHubLiveStateError } from '../src/github/errors.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { DispatchAdmissionWaitError } from '../src/dispatch/runner.js';
import { acquireDispatchInvocationLock, DispatchInvocationLockedError } from '../src/dispatch/invocation-lock.js';
import type { DispatchRuntimeClaim } from '../src/dispatch/queue.js';
import { T0, TARGET, TEST_VALIDATION_AUTHORITY, successResult, validationPassed } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPAIR_AUTHORITY = { revision: 'task-shape-v1', shape: 'bounded' as const };

function tempStore(): { store: JsonFileStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-'));
  return { store: new JsonFileStore({ dir }), dir };
}

describe('CLI command layer', () => {
  it('prints the heartbeat settlement marker as the final line for every settled dispatch boundary', () => {
    const printed: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => { printed.push(String(value)); };
    try {
      printDispatchResult({ outcome: 'no_eligible_work', reasons: ['#18: Issue is closed'] });
      printDispatchResult({
        outcome: 'existing_claim',
        claim: {
          issue: 18, claimId: 'claim-1', runId: 'run-1', profile: 'complex', state: 'merge_ready',
          claimedAt: T0, heartbeatAt: T0, leaseUntil: T0,
        },
      });
      printDispatchResult({
        outcome: 'dispatched', entry: { issue: 18, route: 'codex', profile: 'complex' },
        claim: {
          issue: 18, claimId: 'claim-2', runId: 'run-2', profile: 'complex', state: 'failed',
          claimedAt: T0, heartbeatAt: T0, leaseUntil: T0,
        },
        execution: { runId: 'run-2', state: 'FAILED' },
      });
    } finally {
      console.log = original;
    }
    assert.equal(printed.filter((line) => line === 'TACHIKO_HEARTBEAT_SETTLED_V1').length, 3);
    assert.equal(printed.at(-1), 'TACHIKO_HEARTBEAT_SETTLED_V1');
  });

  it('creates, shows, and transitions a run through the command functions', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42, repairTaskShapeAuthority: REPAIR_AUTHORITY });
      assert.equal(created.state, 'READY');
      assert.deepEqual(created.target, TARGET);

      const view = runShowView(runShowCommand(store, created.id));
      assert.equal(view.state, 'READY');
      assert.equal(view.telemetry.recorded, true);
      assert.equal(view.telemetry.metrics.inputTokens.status, 'unknown');
      assert.ok(view.telemetry.summary.some((line) => line.startsWith('model turns')));

      const next = runTransitionCommand(store, created.id, 'start');
      assert.equal(next.state, 'IMPLEMENTING');
      assert.equal(runShowCommand(store, created.id).state, 'IMPLEMENTING');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires an execution profile when terminal history means run starts fresh', async () => {
    const { store, dir } = tempStore();
    const previousRunsDir = process.env.TACHIKO_DATA_DIR;
    try {
      const terminal = { ...createRun(TARGET, T0, 'terminal'), state: 'FAILED' as const };
      store.create(terminal);
      assert.equal(findRunByTarget(store, TARGET), null);
      process.env.TACHIKO_DATA_DIR = dir;
      await assert.rejects(
        main(['run', 'acme/widgets#42']),
        /requires --execution-profile <routine\|standard\|complex\|critical> for a new run/,
      );
      const active = createRun(TARGET, T0, 'active');
      store.create(active);
      assert.equal(findRunByTarget(store, TARGET)?.id, active.id);
    } finally {
      if (previousRunsDir === undefined) delete process.env.TACHIKO_DATA_DIR;
      else process.env.TACHIKO_DATA_DIR = previousRunsDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly for an unknown run and for an invalid transition', () => {
    const { store, dir } = tempStore();
    try {
      assert.throws(() => runShowCommand(store, 'missing'), /No run with id "missing"/);

      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 1, repairTaskShapeAuthority: REPAIR_AUTHORITY });
      assert.throws(() => runTransitionCommand(store, created.id, 'merged'), /Invalid transition "merged" from state READY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly one target form on run create', () => {
    const { store, dir } = tempStore();
    try {
      assert.throws(
        () => runCreateCommand(store, 'acme', 'widgets', { issue: 42, branch: 'main', repairTaskShapeAuthority: REPAIR_AUTHORITY }),
        /exactly one of --issue <n> or --branch <branch>/,
      );
      assert.throws(() => runCreateCommand(store, 'acme', 'widgets', { repairTaskShapeAuthority: REPAIR_AUTHORITY }), /exactly one of/);
      // the valid branch path is preserved
      const branchRun = runCreateCommand(store, 'acme', 'widgets', { branch: 'main', repairTaskShapeAuthority: REPAIR_AUTHORITY });
      assert.deepEqual(branchRun.target, { kind: 'repository', owner: 'acme', repo: 'widgets', branch: 'main' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires explicit revisioned repair authority for unattended run creation', () => {
    const { store, dir } = tempStore();
    try {
      assert.throws(
        () => runCreateCommand(store, 'acme', 'widgets', { issue: 42 }),
        /explicit revisioned repair task-shape authority/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses payload-requiring transitions with an explicit message and leaves the run unchanged', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42, repairTaskShapeAuthority: REPAIR_AUTHORITY });
      for (const type of ['bootstrap_prepared', 'agent_succeeded', 'agent_failed', 'review_approved', 'changes_requested'] as const) {
        assert.throws(
          () => runTransitionCommand(store, created.id, type as TransitionType),
          /requires (durable bootstrap identity|an (agent|review)Result payload)/,
        );
      }
      assert.equal(runShowCommand(store, created.id).state, 'READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the data dir from TACHIKO_DATA_DIR or the home default', () => {
    assert.equal(resolveRunsDir({ TACHIKO_DATA_DIR: '/tmp/x' }), '/tmp/x');
    assert.match(resolveRunsDir({}), /\.tachiko-conductor/);
  });

  it('resolves the implementation provider and explicit Codex execution config without choosing a model', () => {
    assert.equal(resolveImplementationProvider({}), 'worker-router');
    assert.equal(resolveImplementationProvider({ TACHIKO_IMPLEMENTATION_AGENT: 'codex-cli' }), 'codex-cli');
    assert.deepEqual(resolveCodexExecutionConfig({}), {});
    assert.deepEqual(resolveCodexExecutionConfig({
      TACHIKO_CODEX_MODEL: 'resolved-model',
      TACHIKO_CODEX_REASONING_EFFORT: 'high',
      TACHIKO_CODEX_SANDBOX_MODE: 'workspace-write',
      TACHIKO_CODEX_APPROVAL_POLICY: 'never',
      TACHIKO_CODEX_TIMEOUT_MS: '12345',
    }), {
      model: 'resolved-model',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      timeoutMs: 12_345,
    });
    // Operator aliases/case resolve to the canonical runtime value before spawn.
    assert.deepEqual(
      resolveCodexExecutionConfig({ TACHIKO_CODEX_REASONING_EFFORT: 'High' }),
      { reasoningEffort: 'high' },
    );
    assert.deepEqual(
      resolveCodexExecutionConfig({ TACHIKO_CODEX_REASONING_EFFORT: 'XHigh' }),
      { reasoningEffort: 'xhigh' },
    );
    assert.throws(
      () => resolveCodexExecutionConfig({ TACHIKO_CODEX_REASONING_EFFORT: 'highest' }),
      /Reasoning effort "highest" is unsupported/,
    );
    assert.throws(
      () => resolveImplementationProvider({ TACHIKO_IMPLEMENTATION_AGENT: 'unknown' }),
      /TACHIKO_IMPLEMENTATION_AGENT/,
    );
    assert.throws(
      () => resolveCodexExecutionConfig({ TACHIKO_CODEX_TIMEOUT_MS: '0' }),
      /TACHIKO_CODEX_TIMEOUT_MS/,
    );
    assert.equal(resolveLocalValidationConfiguration({}), undefined);
    assert.deepEqual(
      resolveLocalValidationConfiguration({
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', commands: [{ argv: ['tool', 'test'], timeoutMs: 5_000 }] }),
      }),
      { revision: 'repo-v1', commands: [{ argv: ['tool', 'test'], timeoutMs: 5_000 }] },
    );
    assert.deepEqual(
      resolveLocalValidationConfiguration({
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({
          revision: 'pre-existing-v1', workspacePath: '/tmp/tachiko-existing-pr',
          commands: [{ argv: ['tool', 'test'], timeoutMs: 5_000 }],
        }),
      }),
      { revision: 'pre-existing-v1', workspacePath: '/tmp/tachiko-existing-pr', commands: [{ argv: ['tool', 'test'], timeoutMs: 5_000 }] },
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: '{bad json' }),
      /must be valid JSON/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', commands: [{ argv: [], timeoutMs: 0 }] }) }),
      /argv must be a non-empty string array/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', commands: [] }) }),
      /must contain at least one command/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', workspacePath: 'relative', commands: [{ argv: ['tool'], timeoutMs: 100 }] }) }),
      /workspacePath must be an absolute non-empty path/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', trustedIgnoredBaselinePath: 'relative', commands: [{ argv: ['tool'], timeoutMs: 100 }] }) }),
      /trustedIgnoredBaselinePath must be an absolute non-empty path/,
    );
    assert.deepEqual(
      resolveLocalValidationConfiguration({
        TACHIKO_PLAYWRIGHT_BROWSERS_PATH: '/var/lib/tachiko/playwright',
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', playwrightBrowsersPathEnvironment: 'TACHIKO_PLAYWRIGHT_BROWSERS_PATH', commands: [{ argv: ['tool'], timeoutMs: 100 }] }),
      }),
      { revision: 'repo-v1', playwrightBrowsersPath: '/var/lib/tachiko/playwright', commands: [{ argv: ['tool'], timeoutMs: 100 }] },
    );
    assert.deepEqual(
      resolveLocalValidationConfiguration({
        TACHIKO_NODE_PROGRAM: '/opt/tachiko/node/bin/node', TACHIKO_PNPM_PROGRAM: '/opt/tachiko/pnpm/bin/pnpm',
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM', pnpmProgramEnvironment: 'TACHIKO_PNPM_PROGRAM', commands: [{ argv: ['pnpm', 'test'], timeoutMs: 100 }] }),
      }),
      { revision: 'repo-v1', nodeProgram: '/opt/tachiko/node/bin/node', pnpmProgram: '/opt/tachiko/pnpm/bin/pnpm', commands: [{ argv: ['/opt/tachiko/pnpm/bin/pnpm', 'test'], timeoutMs: 100 }] },
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM', commands: [{ argv: ['pnpm'], timeoutMs: 100 }] }) }),
      /both Node and pnpm toolchain paths together/,
    );
    assert.throws(
      () => resolveHostedCheckPolicyConfiguration({
        TACHIKO_HOSTED_CHECK_POLICY_CONFIG: JSON.stringify({ revision: 'repo-v1', mode: 'required', requiredCheckNames: [] }),
      }),
      /requiredCheckNames must be a non-empty string array/,
    );
  });

  it('requires one revisioned execution-profile config to resolve a new-run selection', () => {
    const profiles = {
      revision: 'profiles-v1',
      profiles: {
        routine: { executor: 'codex-cli', timeoutMs: 1, reasoningEffort: 'low' },
        standard: { executor: 'codex-cli', timeoutMs: 2, reasoningEffort: 'medium' },
        complex: { executor: 'codex-cli', timeoutMs: 3, reasoningEffort: 'high' },
        critical: { executor: 'claude-code', timeoutMs: 4 },
      },
    };
    assert.deepEqual(resolveSelectedExecutionProfile('standard', {
      TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify(profiles),
    }), {
      profile: 'standard', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 2, reasoningEffort: 'medium',
    });
    assert.throws(() => resolveSelectedExecutionProfile('standard', {}), /TACHIKO_EXECUTION_PROFILE_CONFIG is required/);
    assert.throws(
      () => resolveSelectedExecutionProfile('critical', {
        TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify({
          ...profiles,
          profiles: {
            ...profiles.profiles,
            critical: { executor: 'claude-code', timeoutMs: 4, reasoningEffort: 'high' },
          },
        }),
      }),
      /unsupported by executor/,
    );
  });

  it('parses issue numbers strictly without partial parses or unsafe integers', () => {
    assert.equal(parseIssueNumber('42'), 42);
    assert.equal(parseIssueNumber('9007199254740991'), 9007199254740991); // Number.MAX_SAFE_INTEGER
    assert.throws(() => parseIssueNumber('42oops'), /Invalid --issue "42oops"/);
    assert.throws(() => parseIssueNumber('3.5'), /Invalid --issue "3.5"/);
    assert.throws(() => parseIssueNumber('0'), /safe integer >= 1/);
    assert.throws(() => parseIssueNumber('-1'), /Invalid --issue "-1"/);
    // 2^53 + 1: silently rounds to 9007199254740992, which is not safe
    assert.throws(() => parseIssueNumber('9007199254740993'), /safe integer >= 1/);
    // long digit-only input overflows to Infinity
    assert.throws(() => parseIssueNumber('999999999999999999999999999999999999'), /safe integer >= 1/);
  });

  it('shows an unresolved interrupt and hides a resolved one in run show', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42, repairTaskShapeAuthority: REPAIR_AUTHORITY });

      // unresolved interrupt displays normally
      runTransitionCommand(store, created.id, 'escalate', 'product decision needed');
      let run = runShowCommand(store, created.id);
      assert.deepEqual(runShowView(run).interrupt, { kind: 'needs_human', reason: 'product decision needed' });

      // human_resolved hides the interrupt in the projection but keeps the history
      runTransitionCommand(store, created.id, 'human_resolved', 'decided');
      run = runShowCommand(store, created.id);
      assert.equal(runShowView(run).interrupt, null);
      assert.equal(run.interrupt?.kind, 'needs_human');
      assert.ok(run.interrupt?.resolvedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hides a resolved dependency interrupt from run show', () => {
    const { store, dir } = tempStore();
    try {
      const created = runCreateCommand(store, 'acme', 'widgets', { issue: 42, repairTaskShapeAuthority: REPAIR_AUTHORITY });
      runTransitionCommand(store, created.id, 'wait_dependency', 'upstream API');
      runTransitionCommand(store, created.id, 'dependency_satisfied');
      const run = runShowCommand(store, created.id);
      assert.equal(runShowView(run).interrupt, null);
      assert.ok(run.interrupt?.resolvedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('github snapshot command', () => {
  function liveSnapshot(): GitHubLiveSnapshot {
    return {
      repository: { owner: 'acme', repo: 'widgets', defaultBranch: null, defaultBranchHeadSha: null },
      issue: {
        id: 'I_42',
        number: 42,
        title: 'Fix the widget',
        body: 'DoR-ready.',
        state: 'open',
        url: 'https://github.test/acme/widgets/issues/42',
        createdAt: '2026-08-14T00:00:00.000Z',
        updatedAt: '2026-08-14T00:00:00.000Z',
      },
      pullRequest: null,
      headSha: null,
      checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
      reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null },
      conversations: [],
      handoff: null,
      problems: [],
      observedAt: '2026-08-14T03:00:00.000Z',
    };
  }

  it('parses a strict owner/repo#123 reference into an issue target', () => {
    assert.deepEqual(parseIssueRef('acme/widgets#42'), { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 42 });
    assert.throws(() => parseIssueRef('acme/widgets'), /expected owner\/repo#123/);
    assert.throws(() => parseIssueRef('acme/widgets#42oops'), /expected owner\/repo#123/);
    assert.throws(() => parseIssueRef('acme/widgets#0'), /safe integer >= 1/);
    assert.throws(() => parseIssueRef('acme/widgets#9007199254740993'), /safe integer >= 1/);
  });

  it('wraps a successful live snapshot in a machine-readable ok envelope', async () => {
    const adapter: GitHubAdapter = {
      kind: 'github',
      async readIssue() {
        return { target: TARGET, title: 'Fix', body: '', state: 'open' };
      },
      async readBranch(target) {
        return { target, headSha: 'sha', pullRequestNumbers: [] };
      },
      async listPullRequests() {
        return [];
      },
      async readLiveSnapshot(target) {
        assert.deepEqual(target, TARGET);
        return liveSnapshot();
      },
    };

    const outcome = await githubSnapshotCommand(adapter, 'acme/widgets#42');
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.snapshot.issue.number, 42);
  });

  it('serializes a fatal GitHub live-state error with its code and retryable flag', async () => {
    const adapter: GitHubAdapter = {
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
        throw new GitHubLiveStateError('GH_RATE_LIMITED', 'rate limited', { retryable: true, details: { path: 'x' } });
      },
    };

    const outcome = await githubSnapshotCommand(adapter, 'acme/widgets#42');
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, 'GH_RATE_LIMITED');
      assert.equal(outcome.error.retryable, true);
      assert.deepEqual(outcome.error.details, { path: 'x' });
    }
  });

  it('collapses unexpected failures into an UNKNOWN machine-readable error', async () => {
    const adapter: GitHubAdapter = {
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
        throw new Error('boom');
      },
    };

    const outcome = await githubSnapshotCommand(adapter, 'acme/widgets#42');
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.error.code, 'UNKNOWN');
      assert.equal(outcome.error.message, 'boom');
    }
  });
});

describe('workflow run and resume commands', () => {
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

  function snapshot(headSha: string): GitHubLiveSnapshot {
    return {
      repository: { owner: 'acme', repo: 'widgets', defaultBranch: null, defaultBranchHeadSha: null },
      issue: { id: 'I_42', number: 42, title: 'Fix the widget', body: 'DoR-ready.', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
      pullRequest: { id: 'PR_7', number: 7, title: 'Fix', url: '', state: 'open', isDraft: false, mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: '', headSha, baseSha: 'base' },
      headSha,
      checks: { availability: 'available', overall: 'passing', checks: [{ id: 'test', name: 'test', state: 'passing', url: null, updatedAt: T0 }] },
      reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
      conversations: [],
      handoff: null,
      problems: [],
      observedAt: T0,
    };
  }

  function githubAdapter(liveHeads: string[]): GitHubAdapter {
    let latest: string | undefined;
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
        return snapshot(head);
      },
    };
  }

  class FakeReviewer implements ReviewerAdapter {
    readonly kind: 'reviewer' = 'reviewer';
    calls = 0;

    constructor(private readonly outcomes: ReviewResult[]) {}

    async review(request: ReviewRequest): Promise<ReviewResult> {
      this.calls += 1;
      const outcome = this.outcomes.shift();
      if (outcome === undefined) throw new Error('No review outcome queued');
      return outcome;
    }
  }

  class FakeImplementation implements ImplementationAgent {
    readonly kind: 'implementation-agent' = 'implementation-agent';
    calls = 0;

    constructor(private readonly outcomes: AgentResult[]) {}

    async run(): Promise<AgentResult> {
      this.calls += 1;
      const outcome = this.outcomes.shift();
      if (outcome === undefined) throw new Error('No implementation outcome queued');
      return outcome;
    }
  }

  function deps(
    store: RunStore,
    github: GitHubAdapter,
    implementation: ImplementationAgent,
    reviewer: ReviewerAdapter,
  ): WorkflowDependencies {
    return {
      store, github, implementation, reviewer,
      validation: { kind: 'validation', configRevision: 'test-config-v1', async validate(request) { return validationPassed(request.headSha).local; } },
      hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
    };
  }

  it('starts an issue end-to-end and reaches MERGE_READY through the fake adapters', async () => {
    const store = new MemoryStore();
    const implementation = new FakeImplementation([successResult(HEAD)]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }]);

    const outcome = await runIssueCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD]), implementation, reviewer),
      'acme/widgets#42',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.state, 'MERGE_READY');
    assert.equal(store.list().length, 1);
  });

  it('reuses an existing persisted run instead of creating a second one', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }]);

    const outcome = await runIssueCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer),
      'acme/widgets#42',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(store.list().length, 1);
    assert.equal(outcome.run.id, 'run-1');
  });

  it('includes a persisted PR in initial admission so different Issues cannot share one PR', async () => {
    const store = new MemoryStore();
    let run = createRun({ ...TARGET, issueNumber: 43 }, T0, 'run-43');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    store.create(run);
    const config: AdmissionConfig = { schemaVersion: 1, revision: 'same-pr-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
    const { dir } = tempStore();
    try {
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config });
      const owner = admission.admit({ laneId: 'other-issue', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, pullRequest: 7, run: 'run-42' } });
      assert.equal(owner.outcome, 'admitted');
      const implementation = new FakeImplementation([]);
      await assert.rejects(
        runIssueCommand(deps(store, githubAdapter([HEAD]), implementation, new FakeReviewer([])), 'acme/widgets#43', { admission, runOwnerReceiptPath: path.join(dir, 'run-owner-43.json') }),
        /overlaps active or parked lane "other-issue"/,
      );
      assert.equal(implementation.calls, 0);
      assert.equal(admission.readLane('run:run-43'), null, 'conflicting persisted PR evidence is rejected before a new lane is recorded');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('strengthens an unbootstrapped lane with the actual ambient cwd before its provider call', async () => {
    const store = new MemoryStore();
    const config: AdmissionConfig = { schemaVersion: 1, revision: 'same-cwd-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
    const { dir } = tempStore();
    try {
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config });
      const owner = admission.admit({ laneId: 'ambient-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 40, workspace: process.cwd() } });
      assert.equal(owner.outcome, 'admitted');
      const implementation = new FakeImplementation([successResult(HEAD)]);
      await assert.rejects(
        runIssueCommand(deps(store, githubAdapter([HEAD]), implementation, new FakeReviewer([])), 'acme/widgets#44', { admission, admissionWorkspace: process.cwd(), runOwnerReceiptPath: path.join(dir, 'run-owner-44.json'), now: () => T0 }),
        /overlaps active or parked lane "ambient-owner"/,
      );
      assert.equal(implementation.calls, 0, 'ambient workspace conflict is detected before model execution');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a supplied repair authority that differs from an active durable run', async () => {
    const store = new MemoryStore();
    const run = createRun(TARGET, T0, 'run-1', undefined, undefined, REPAIR_AUTHORITY);
    store.create(run);

    await assert.rejects(
      runIssueCommand(
        deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])),
        'acme/widgets#42',
        { repairTaskShapeAuthority: { revision: 'task-shape-v1', shape: 'interacting' } },
      ),
      /immutable repair task-shape authority/,
    );
    assert.deepEqual(store.read('run-1'), run);
  });

  it('refuses a supplied repair authority for an active legacy run', async () => {
    const store = new MemoryStore();
    const run = createRun(TARGET, T0, 'legacy-run');
    store.create(run);

    await assert.rejects(
      runIssueCommand(
        deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])),
        'acme/widgets#42',
        { repairTaskShapeAuthority: REPAIR_AUTHORITY },
      ),
      /immutable repair task-shape authority/,
    );
    assert.deepEqual(store.read('legacy-run'), run);
  });

  it('accepts a supplied repair authority that exactly matches an active durable run', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1', undefined, undefined, REPAIR_AUTHORITY);
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    store.create(run);

    const outcome = await runIssueCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD]), new FakeImplementation([]), new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }])),
      'acme/widgets#42',
      { repairTaskShapeAuthority: REPAIR_AUTHORITY, now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.id, 'run-1');
  });

  it('creates fresh durable work without replacing terminal history for an explicitly re-dispatched Issue', async () => {
    const store = new MemoryStore();
    store.create({ ...createRun(TARGET, T0, 'old-terminal'), state: 'FAILED' });
    const implementation = new FakeImplementation([successResult(HEAD)]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }]);

    const outcome = await runIssueCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD]), implementation, reviewer),
      'acme/widgets#42',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(store.read('old-terminal')?.state, 'FAILED');
    assert.equal(store.list().length, 2);
    assert.notEqual(outcome.run.id, 'old-terminal');
  });

  it('resumes a parked NEEDS_HUMAN run after a supplied human decision', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(
      run,
      { type: 'escalate', reason: 'architecture decision', interrupt: { evidence: 'two designs', choices: ['A', 'B'] } },
      T0,
    );
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }]);

    const outcome = await resumeCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer),
      'run-1',
      'A',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.state, 'MERGE_READY');
    const persisted = store.read('run-1');
    assert.equal(persisted?.interrupt?.resolvedAt, T0);
  });

  it('accepts only the exact live dispatch claim and lets one of two human decisions win the Run CAS', async () => {
    const store = new MemoryStore();
    const execution = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    let run = createRun(TARGET, T0, 'dispatch-human-run', execution, 'dispatch-claim-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, { type: 'escalate', reason: 'operator input', interrupt: { evidence: 'needs decision', choices: ['A', 'B'] } }, T0);
    store.create(run);
    const config = { revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 };
    const liveClaim: DispatchRuntimeClaim = { issue: 42, claimId: 'dispatch-claim-1', runId: run.id, profile: 'complex', state: 'needs_human', claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z' };
    assert.doesNotThrow(() => assertCanonicalDispatchResumeClaim(run, liveClaim, config));
    assert.throws(() => assertCanonicalDispatchResumeClaim(run, { ...liveClaim, runId: null }, config), /missing, stale, replaced, or differently bound/);
    assert.doesNotThrow(() => assertCanonicalDispatchResumeClaim(run, { ...liveClaim, runId: null }, config, run), 'a null runtime Run id may be recovered only with separate unique claim-to-Run proof');
    for (const stale of [null, { ...liveClaim, claimId: 'replaced' }, { ...liveClaim, state: 'retired' as const }, { ...liveClaim, runId: 'other-run' }]) {
      assert.throws(() => assertCanonicalDispatchResumeClaim(run, stale, config), /missing, stale, replaced, or differently bound/);
    }

    let rendezvous!: () => void;
    const bothDecisionsReady = new Promise<void>((resolve) => { rendezvous = resolve; });
    let participants = 0;
    const commitDispatchResumeTransition: NonNullable<NonNullable<Parameters<typeof resumeCommand>[3]>['commitDispatchResumeTransition']> = async (_expected, _next, commitRun) => {
      participants += 1;
      if (participants === 2) rendezvous();
      await bothDecisionsReady;
      commitRun();
    };
    const implementation = new FakeImplementation([successResult(HEAD)]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'oracle', headSha: HEAD, findings: [] }]);
    const workflow = deps(store, githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer);
    const decide = (choice: string) => resumeCommand(workflow, run.id, choice, { dispatchClaimId: liveClaim.claimId, commitDispatchResumeTransition, now: () => T0 });
    const results = await Promise.allSettled([decide('A'), decide('B')]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(reviewer.calls, 1, `CAS loser does not start a second worker: ${results.map((result) => result.status === 'rejected' ? String(result.reason) : result.value.outcome).join('; ')}`);
  });

  it('keeps the active Run fence if claim publication fails after the parked Run CAS', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-resume-claim-crash-'));
    try {
      const store = new MemoryStore();
      const execution = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
      let run = createRun(TARGET, T0, 'dispatch-resume-crash', execution, 'dispatch-claim-crash');
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
      run = applyTransition(run, { type: 'escalate', reason: 'operator input', interrupt: { evidence: 'decision required', choices: ['A'] } }, T0);
      store.create(run);
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'resume-crash-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const receiptPath = path.join(directory, 'run-owner.json');
      let releaseCount = 0;
      const outcomePromise = resumeCommand(deps(store, githubAdapter([HEAD, HEAD, HEAD]), new FakeImplementation([]), new FakeReviewer([])), run.id, 'A', {
        dispatchClaimId: run.dispatchClaimId,
        admission: registry,
        admissionWorkspace: directory,
        runOwnerReceiptPath: receiptPath,
        releaseDispatchAdmissionLock: () => { releaseCount += 1; },
        commitDispatchResumeTransition: async (_expected, _next, commitRun) => {
          commitRun();
          throw new Error('injected process failure after Run CAS and before claim publication');
        },
      });
      await assert.rejects(outcomePromise, /injected process failure/);
      assert.equal(store.read(run.id)?.state, 'REVIEWING', 'Run decision is durably recorded before claim publication');
      assert.equal(registry.readLane(`run:${run.id}`)?.status, 'active', 'uncertain post-CAS state retains admission fence');
      assert.ok(readRunOwnerReceipt(receiptPath)?.token, 'owner receipt remains recoverable');
      assert.equal(releaseCount, 0, 'workflow lock release callback is not reached before workflow execution');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases the exact pre-execution generation after a dispatch resume Run CAS loss', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-resume-cas-loss-'));
    const lockPath = path.join(directory, 'dispatch.admission');
    const prepareLock = acquireDispatchInvocationLock({ lockPath });
    let prepareReleased = false;
    const releasePrepare = () => { if (!prepareReleased) { prepareReleased = true; prepareLock.release(); } };
    try {
      const store = new MemoryStore();
      const execution = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
      let run = createRun(TARGET, T0, 'dispatch-resume-cas-loss', execution, 'dispatch-claim-cas-loss');
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
      run = applyTransition(run, { type: 'escalate', reason: 'operator input', interrupt: { evidence: 'decision required', choices: ['A'] } }, T0);
      store.create(run);
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'resume-cas-loss-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const withDispatchAdmissionLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
        for (;;) {
          try {
            const lock = acquireDispatchInvocationLock({ lockPath });
            try { return await operation(); } finally { lock.release(); }
          } catch (error) {
            if (!(error instanceof DispatchInvocationLockedError)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      };
      let timeout: NodeJS.Timeout | undefined;
      const outcome = resumeCommand(deps(store, githubAdapter([HEAD, HEAD, HEAD]), new FakeImplementation([]), new FakeReviewer([])), run.id, 'A', {
        dispatchClaimId: run.dispatchClaimId,
        admission: registry,
        admissionWorkspace: directory,
        runOwnerReceiptPath: path.join(directory, 'run-owner.json'),
        releaseDispatchAdmissionLock: releasePrepare,
        withDispatchAdmissionLock,
        commitDispatchResumeTransition: async (_expected, _next, commitRun) => {
          store.update({ ...run, updatedAt: '2026-09-15T00:00:00.010Z' });
          commitRun();
        },
      });
      await assert.rejects(Promise.race([
        outcome,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('CAS-loss settlement deadlocked on the prepare lock')), 2_000); }),
      ]), /changed while the decision was being prepared/);
      if (timeout !== undefined) clearTimeout(timeout);
      const released = registry.readLane(`run:${run.id}`);
      assert.equal(released?.status, 'released', 'failed CAS releases the exact generation that never authorized execution');
      assert.equal(released?.generation, 2, 'the original generation is fenced by one release transition');
      assert.equal(store.read(run.id)?.state, 'NEEDS_HUMAN', 'the competing Run snapshot is preserved');
      assert.ok(prepareReleased, 'outer short lock was released before exact-generation settlement');
    } finally {
      releasePrepare();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases prepare lock before settling a pre-execution Run-store failure', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-run-create-lock-failure-'));
    const lockPath = path.join(directory, 'dispatch.admission');
    const prepareLock = acquireDispatchInvocationLock({ lockPath });
    const releasePrepare = () => { try { prepareLock.release(); } catch { /* idempotent test cleanup */ } };
    try {
      const store = new MemoryStore();
      store.create = () => { throw new Error('injected Run persistence failure'); };
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'create-failure-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const withDispatchAdmissionLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
        for (;;) {
          try {
            const lock = acquireDispatchInvocationLock({ lockPath });
            try { return await operation(); } finally { lock.release(); }
          } catch (error) {
            if (!(error instanceof DispatchInvocationLockedError)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      };
      let timeout: NodeJS.Timeout | undefined;
      const bounded = Promise.race([
        runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42', {
          admission: registry,
          admissionWorkspace: directory,
          runOwnerReceiptPath: path.join(directory, 'run-owner.json'),
          releaseDispatchAdmissionLock: releasePrepare,
          withDispatchAdmissionLock,
        }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('pre-execution cleanup deadlocked on prepare lock')), 2_000); }),
      ]);
      await assert.rejects(bounded, /injected Run persistence failure/);
      if (timeout !== undefined) clearTimeout(timeout);
      assert.equal(registry.readLane('run:run-1'), null);
    } finally {
      releasePrepare();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('terminates a parked run when the advertised cancel choice is selected', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-cancel');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'browser takeover required',
        interrupt: { evidence: '2FA required', choices: ['Complete human bootstrap/takeover and resume', 'Cancel the run'] },
      },
      T0,
    );
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([]);

    const outcome = await resumeCommand(
      deps(store, githubAdapter([]), implementation, reviewer),
      'run-cancel',
      'Cancel the run',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.run.state, 'FAILED');
    assert.equal(outcome.run.history.at(-1)?.type, 'fail');
    assert.equal(implementation.calls, 0);
    assert.equal(reviewer.calls, 0);
  });

  it('resumes a WAITING_DEPENDENCY run via dependency_satisfied after a supplied decision', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, { type: 'wait_dependency', reason: 'upstream API', interrupt: { evidence: 'waiting on API' } }, T0);
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }]);

    const outcome = await resumeCommand(
      deps(store, githubAdapter([HEAD, HEAD, HEAD]), implementation, reviewer),
      'run-1',
      'dependency available now',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.state, 'MERGE_READY');
    const persisted = store.read('run-1');
    assert.ok(persisted?.history.some((entry) => entry.type === 'dependency_satisfied'));
  });

  it('applies an advertised live-HEAD sync decision before continuing an interrupted review fix', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-sync');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(
      run,
      {
        type: 'changes_requested',
        reviewResult: {
          verdict: 'request_changes',
          reviewerName: 'deepseek',
          headSha: HEAD,
          findings: [{ severity: 'blocking', summary: 'fix the browser flow' }],
        },
      },
      T0,
      TEST_VALIDATION_AUTHORITY,
    );
    run = applyTransition(run, { type: 'start_fix' }, T0);
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'live HEAD changed',
        interrupt: { evidence: 'new commit', choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] },
      },
      T0,
    );
    store.create(run);
    const implementation = new FakeImplementation([]);
    const reviewer = new FakeReviewer([
      { verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD2, findings: [] },
    ]);

    const outcome = await resumeCommand(
      deps(store, githubAdapter([HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), implementation, reviewer),
      'run-sync',
      LIVE_HEAD_SYNC_DECISION,
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.headSha, HEAD2);
    assert.equal(outcome.run.history.some((entry) => entry.type === 'human_resolved' && entry.to === 'VALIDATING'), true);
  });

  it('releases a pre-execution sync failure so the same parked run can retry', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      let run = createRun(TARGET, T0, 'run-sync-retry');
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
      run = applyTransition(run, { type: 'changes_requested', reviewResult: { verdict: 'request_changes', reviewerName: 'deepseek', headSha: HEAD, findings: [{ severity: 'blocking', summary: 'fix browser flow' }] } }, T0, TEST_VALIDATION_AUTHORITY);
      run = applyTransition(run, { type: 'start_fix' }, T0);
      run = applyTransition(run, { type: 'escalate', reason: 'live HEAD changed', interrupt: { evidence: 'new commit', choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] } }, T0);
      store.create(run);
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'preflight-retry-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      const github = githubAdapter([HEAD2, HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]);
      let failFirstSync = true;
      const flakyGithub: GitHubAdapter = {
        ...github,
        async readLiveSnapshot(target) {
          if (failFirstSync) {
            failFirstSync = false;
            throw new Error('temporary GitHub sync preflight failure');
          }
          return github.readLiveSnapshot(target);
        },
      };
      const workflowDeps = deps(store, flakyGithub, new FakeImplementation([]), new FakeReviewer([{ verdict: 'approve', reviewerName: 'oracle', headSha: HEAD2, findings: [] }]));
      const receiptPath = path.join(dir, 'run-owner-sync-retry.json');
      await assert.rejects(resumeCommand(workflowDeps, run.id, LIVE_HEAD_SYNC_DECISION, { admission, runOwnerReceiptPath: receiptPath }), /temporary GitHub sync preflight failure/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'released');
      const retried = await resumeCommand(workflowDeps, run.id, LIVE_HEAD_SYNC_DECISION, { admission, runOwnerReceiptPath: receiptPath, now: () => T0 });
      assert.equal(retried.outcome, 'merge_ready');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('labels a concurrent release separately from the earlier admission denial revision', async () => {
    const { dir } = tempStore();
    try {
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'observation-race-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      const owner = admission.admit({ laneId: 'holder', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 1 } });
      assert.equal(owner.outcome, 'admitted');
      if (owner.outcome !== 'admitted') throw new Error('expected holder admission');
      const snapshot = admission.snapshot.bind(admission);
      let released = false;
      admission.snapshot = () => {
        if (!released) {
          released = true;
          admission.release(owner.token, true);
        }
        return snapshot();
      };
      const store = new MemoryStore();
      await assert.rejects(
        runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42', {
          dispatchClaimId: 'claim-race',
          admission,
          runOwnerReceiptPath: path.join(dir, 'run-owner-race.json'),
        }),
        (error: unknown) => {
          assert.ok(error instanceof DispatchAdmissionWaitError);
          assert.equal(error.admission?.result, 'parked');
          assert.equal(error.admission?.decisionRevision, 2);
          assert.equal(error.admission?.revision, 3);
          assert.equal(error.admission?.counts.captains, 0);
          assert.equal(error.admission?.lastTransition?.kind, 'released');
          return true;
        },
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects direct execution and resume of Runs still bound to a dispatch claim', async () => {
    const store = new MemoryStore();
    const claimed = createRun(TARGET, T0, 'claimed-run', undefined, 'claim-live');
    store.create(claimed);
    await assert.rejects(
      runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42'),
      /bound to dispatch claim "undefined"/,
    );

    let parked = applyTransition(claimed, { type: 'start' }, T0);
    parked = applyTransition(parked, { type: 'escalate', reason: 'decision', interrupt: { choices: ['retry'] } }, T0);
    store.update(parked);
    await assert.rejects(
      resumeCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'claimed-run', 'retry'),
      /matching dispatch ownership is required/,
    );
  });

  it('releases direct admission when durable Run creation fails before workflow execution', async () => {
    const { dir } = tempStore();
    try {
      class FailingCreateStore extends MemoryStore {
        createdId: string | undefined;
        override create(run: Run): void {
          this.createdId = run.id;
          throw new Error('injected durable create failure');
        }
      }
      const store = new FailingCreateStore();
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'create-failure-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      await assert.rejects(
        runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42', { admission, runOwnerReceiptPath: path.join(dir, 'run-owner-create-failure.json') }),
        /injected durable create failure/,
      );
      assert.equal(admission.readLane(`run:${store.createdId}`)?.status, 'released');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains active admission after an implementation invocation throws with uncertain child settlement', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'uncertain-child-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      class UncertainImplementation extends FakeImplementation {
        override async run(): Promise<AgentResult> { throw new Error('provider invocation settlement is uncertain'); }
      }
      await assert.rejects(
        runIssueCommand(deps(store, githubAdapter([HEAD]), new UncertainImplementation([]), new FakeReviewer([])), 'acme/widgets#42', { admission, admissionWorkspace: process.cwd(), runOwnerReceiptPath: path.join(dir, 'run-owner-uncertain.json') }),
        /provider invocation settlement is uncertain/,
      );
      const run = store.list()[0];
      assert.ok(run);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'active');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers uncertain Run ownership only with exact private receipt generation and stopped attestation', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: { schemaVersion: 1, revision: 'run-recovery-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const receiptPath = path.join(dir, 'owner-receipt.json');
      class UncertainImplementation extends FakeImplementation { override async run(): Promise<AgentResult> { throw new Error('worker settlement uncertain'); } }
      await assert.rejects(runIssueCommand(deps(store, githubAdapter([HEAD]), new UncertainImplementation([]), new FakeReviewer([])), 'acme/widgets#42', {
        admission, admissionWorkspace: process.cwd(), runOwnerReceiptPath: receiptPath,
      }), /worker settlement uncertain/);
      const run = store.list()[0]!;
      const receipt = readRunOwnerReceipt(receiptPath)!;
      assert.equal(receipt.phase, 'execution_possible');
      assert.ok(receipt.token);
      assert.equal(admission.readLane(`run:${run.id}`)?.generation, receipt.generation);
      writeRunOwnerReceipt(receiptPath, { ...receipt, phase: 'pre_execution' });
      assert.throws(() => recoverRunAdmission(store, admission, run.id, receipt.generation, false, receiptPath), /receipt phase alone cannot prove supervisor death/);
      writeRunOwnerReceipt(receiptPath, receipt);
      assert.throws(() => recoverRunAdmission(store, admission, run.id, receipt.generation, false, receiptPath), /explicit --stopped/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'active');
      const originalRelease = admission.release.bind(admission);
      admission.release = (token, stopped, beforePublish) => { beforePublish?.(); throw new Error('simulated crash before registry publication'); };
      assert.throws(() => recoverRunAdmission(store, admission, run.id, receipt.generation, true, receiptPath), /simulated crash before registry publication/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'active');
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'release_transition', 'prepublish crash retains the active capability in the private receipt');
      admission.release = (token, stopped, beforePublish) => { originalRelease(token, stopped, beforePublish); throw new Error('simulated crash after registry publication'); };
      assert.throws(() => recoverRunAdmission(store, admission, run.id, receipt.generation, true, receiptPath), /simulated crash after registry publication/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'released');
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'release_transition', 'postpublish crash leaves a reconcilable transition receipt');
      admission.release = originalRelease;
      assert.equal(recoverRunAdmission(store, admission, run.id, receipt.generation, true, receiptPath), 'released', 'exact-generation recovery reconciles a postpublish crash');
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'released');
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'released');
      assert.equal(recoverRunAdmission(store, admission, run.id, receipt.generation, true, receiptPath), 'released', 'exact-generation recovery retry is idempotent');

      const successor = admission.admit({ laneId: `run:${run.id}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: run.id, workspace: process.cwd() } });
      assert.equal(successor.outcome, 'admitted');
      if (successor.outcome !== 'admitted') throw new Error('expected successor generation');
      assert.throws(() => recoverRunAdmission(store, admission, run.id, receipt.generation, true, receiptPath), /does not match expected generation|do not identify the exact recoverable active generation/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'active', 'stale recovery cannot release a successor generation');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retires a parked Run after receipt prepublication wins but re-admission registry publication fails', async () => {
    const { dir } = tempStore();
    try {
      const runId = 'parked-readmit-crash';
      const run = createRun(TARGET, T0, runId);
      const store = new MemoryStore();
      store.create(run);
      const receiptPath = path.join(dir, 'owner-receipt.json');
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: { schemaVersion: 1, revision: 'parked-readmit-crash-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const admitted = admission.admit({ laneId: `run:${runId}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace: dir } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') throw new Error('expected initial Run admission');
      const parkedReceipt = { schemaVersion: 1 as const, laneId: admitted.token.laneId, missionId: admitted.missionId, repository: 'acme/widgets', runId, issue: 42, workspace: dir, token: admitted.token, generation: admitted.token.generation, phase: 'park_transition' as const };
      admission.park(admitted.token, 'workflow_wait', () => writeRunOwnerReceipt(receiptPath, parkedReceipt));
      writeRunOwnerReceipt(receiptPath, { schemaVersion: 1, laneId: admitted.token.laneId, missionId: admitted.missionId, repository: 'acme/widgets', runId, issue: 42, workspace: dir, generation: admitted.token.generation + 1, phase: 'parked' });
      const parkedGeneration = admission.readLane(admitted.token.laneId)?.generation;
      assert.ok(parkedGeneration);

      const actualAdmit = admission.admit.bind(admission);
      admission.admit = (request, options) => actualAdmit(request, {
        ...options,
        beforePublish: (candidate) => {
          options?.beforePublish?.(candidate);
          throw new Error('injected registry publication failure after candidate receipt write');
        },
      });
      await assert.rejects(runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42', {
        admission,
        admissionWorkspace: dir,
        runOwnerReceiptPath: receiptPath,
      }), /injected registry publication failure/);
      const candidateReceipt = readRunOwnerReceipt(receiptPath);
      assert.equal(candidateReceipt?.phase, 'pre_execution');
      assert.equal(candidateReceipt?.generation, parkedGeneration + 1);
      assert.equal(admission.readLane(admitted.token.laneId)?.status, 'parked', 'failed re-admission leaves the old parked ownership in force');

      assert.equal(recoverRunAdmission(store, admission, runId, parkedGeneration, true, receiptPath), 'released', 'the exact old parked owner can be operator-stopped and retired using its public registry generation');
      const releasedLane = admission.readLane(admitted.token.laneId);
      assert.equal(releasedLane?.status, 'released');
      assert.equal(releasedLane?.generation, parkedGeneration + 1);
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'released');
      assert.equal(recoverRunAdmission(store, admission, runId, parkedGeneration, true, receiptPath), 'released', 'exact recovery is idempotent after publication');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rechecks the admission generation immediately before implementation mutation', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'mutation-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      let token: { laneId: string; generation: number; token: string } | undefined;
      const originalAdmit = admission.admit.bind(admission);
      admission.admit = ((request, options) => {
        const result = originalAdmit(request, options);
        if (result.outcome === 'admitted') token = result.token;
        return result;
      }) as typeof admission.admit;
      const github = githubAdapter([HEAD]);
      const readLiveSnapshot = github.readLiveSnapshot.bind(github);
      const expiringGithub: GitHubAdapter = {
        ...github,
        async readLiveSnapshot(target) {
          const live = await readLiveSnapshot(target);
          if (token !== undefined) {
            admission.release(token, true);
            token = undefined;
          }
          return live;
        },
      };
      const implementation = new FakeImplementation([successResult(HEAD)]);
      await assert.rejects(
        runIssueCommand(deps(store, expiringGithub, implementation, new FakeReviewer([])), 'acme/widgets#42', { admission, runOwnerReceiptPath: path.join(dir, 'run-owner-mutation-fence.json') }),
        /Admission generation token is stale/,
      );
      assert.equal(implementation.calls, 0);
      assert.equal(admission.readLane(`run:${store.list()[0]!.id}`)?.status, 'released');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('applies the same advertised sync after ordinary review-state drift instead of parking again', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-review-sync');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(
      run,
      {
        type: 'escalate',
        reason: 'live review HEAD changed',
        interrupt: { evidence: 'new commit', choices: [LIVE_HEAD_SYNC_DECISION, 'Cancel the run'] },
      },
      T0,
    );
    store.create(run);

    const outcome = await resumeCommand(
      deps(
        store,
        githubAdapter([HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]),
        new FakeImplementation([]),
        new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD2, findings: [] }]),
      ),
      'run-review-sync',
      LIVE_HEAD_SYNC_DECISION,
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.headSha, HEAD2);
    assert.equal(outcome.run.history.some((entry) => entry.type === 'human_resolved' && entry.to === 'VALIDATING'), true);
  });

  it('rejects resuming a run that is not parked for a decision', async () => {
    const store = new MemoryStore();
    store.create(createRun(TARGET, T0, 'run-1'));
    await assert.rejects(
      resumeCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'run-1', 'go'),
      /not parked for a decision/,
    );
  });

  it('rejects a decision outside the interrupt choices and makes cancel terminal', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, {
      type: 'escalate',
      reason: 'choose',
      interrupt: { choices: ['Retry', 'Cancel the run'] },
    }, T0);
    store.create(run);
    const workflowDeps = deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([]));

    await assert.rejects(resumeCommand(workflowDeps, 'run-1', 'anything'), /Invalid decision/);
    const outcome = await resumeCommand(workflowDeps, 'run-1', 'Cancel the run', { now: () => T0 });

    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.run.state, 'FAILED');
  });

  it('adopts the exact live HEAD only for the explicit sync decision', async () => {
    const store = new MemoryStore();
    let run = createRun(TARGET, T0, 'run-1');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
    run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
    run = applyTransition(run, {
      type: 'escalate',
      reason: 'drift',
      interrupt: { choices: ['Sync the run to the live HEAD and continue', 'Cancel the run'] },
    }, T0);
    store.create(run);
    const reviewer = new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD2, findings: [] }]);

    const outcome = await resumeCommand(
      deps(store, githubAdapter([HEAD2, HEAD2, HEAD2, HEAD2, HEAD2]), new FakeImplementation([]), reviewer),
      'run-1',
      'Sync the run to the live HEAD and continue',
      { now: () => T0 },
    );

    assert.equal(outcome.outcome, 'merge_ready');
    assert.equal(outcome.run.headSha, HEAD2);
  });

  it('rejects a malformed issue reference on run', async () => {
    const store = new MemoryStore();
    await assert.rejects(
      runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'not-a-ref'),
      /expected owner\/repo#123/,
    );
  });
});

describe('CLI end-to-end across processes', () => {
  interface CliResult {
    stdout: string;
    stderr: string;
    status: number | null;
  }

  it('creates a run in one process, then reads and advances it in fresh processes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-e2e-'));
    try {
      const env = {
        ...process.env,
        TACHIKO_DATA_DIR: dir,
        TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify({
          revision: 'profiles-v1',
          profiles: {
            routine: { executor: 'codex-cli', timeoutMs: 1, reasoningEffort: 'low' },
            standard: { executor: 'codex-cli', timeoutMs: 2, reasoningEffort: 'medium' },
            complex: { executor: 'codex-cli', timeoutMs: 3, reasoningEffort: 'high' },
            critical: { executor: 'claude-code', timeoutMs: 4 },
          },
        }),
      };
      const runCli = (args: string[]): CliResult => {
        const result = spawnSync(
          process.execPath,
          ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args],
          { cwd: REPO_ROOT, env, encoding: 'utf8' },
        );
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
      };

      const help = runCli(['--help']);
      assert.equal(help.status, 0);
      assert.match(
        help.stdout,
        /run create --owner <owner> --repo <repo> \(--issue <n> \| --branch <branch>\) --execution-profile <routine\|standard\|complex\|critical>/,
      );
      assert.match(help.stdout, /New runs require a revisioned TACHIKO_EXECUTION_PROFILE_CONFIG JSON value/);

      const create = runCli(['run', 'create', '--owner', 'acme', '--repo', 'widgets', '--issue', '42', '--execution-profile', 'standard', '--repair-task-shape-authority', '{"revision":"task-shape-v1","shape":"bounded"}']);
      const id = /Created run ([a-f0-9-]+)/.exec(create.stdout)?.[1];
      assert.ok(id, `expected a run id in output: ${create.stdout}`);
      assert.match(create.stdout, /"state": "READY"/);
      assert.match(create.stdout, /"profile": "standard"/);

      // Supplying both --issue and --branch is rejected.
      const both = runCli(['run', 'create', '--owner', 'acme', '--repo', 'widgets', '--issue', '42', '--branch', 'main', '--execution-profile', 'standard', '--repair-task-shape-authority', '{"revision":"task-shape-v1","shape":"bounded"}']);
      assert.equal(both.status, 1);
      assert.match(both.stderr, /error: run create requires exactly one of/);

      const show1 = runCli(['run', 'show', id]);
      assert.match(show1.stdout, /"state": "READY"/);

      const transition = runCli(['run', 'transition', id, 'start']);
      assert.match(transition.stdout, /"state": "IMPLEMENTING"/);

      const show2 = runCli(['run', 'show', id]);
      assert.match(show2.stdout, /"state": "IMPLEMENTING"/);

      // Payload-requiring transitions are rejected explicitly by the CLI.
      const payload = runCli(['run', 'transition', id, 'agent_succeeded']);
      assert.equal(payload.status, 1);
      assert.match(payload.stderr, /error: Transition "agent_succeeded" requires an agentResult payload/);
      const show3 = runCli(['run', 'show', id]);
      assert.match(show3.stdout, /"state": "IMPLEMENTING"/);

      // Invalid transition across a fresh process fails loudly and keeps state.
      const bad = runCli(['run', 'transition', id, 'merged']);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /error: Invalid transition "merged" from state IMPLEMENTING/);
      const show4 = runCli(['run', 'show', id]);
      assert.match(show4.stdout, /"state": "IMPLEMENTING"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps non-browser run and resume paths independent of Git-root discovery', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-no-git-'));
    try {
      const env = { ...process.env, TACHIKO_DATA_DIR: path.join(dir, 'runs') };
      const runCli = (args: string[]): CliResult => {
        const result = spawnSync(
          process.execPath,
          ['--import', path.join(REPO_ROOT, 'node_modules/tsx/dist/loader.mjs'), path.join(REPO_ROOT, 'src/cli.ts'), ...args],
          { cwd: dir, env, encoding: 'utf8' },
        );
        return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
      };

      const run = runCli(['run', 'not-an-issue-ref']);
      assert.equal(run.status, 1);
      assert.match(run.stderr, /expected owner\/repo#123/);
      assert.doesNotMatch(run.stderr, /Cannot establish the Git repository top-level/);

      const resume = runCli(['run', 'resume', 'missing', '--decision', 'retry']);
      assert.equal(resume.status, 1);
      assert.match(resume.stderr, /No run with id "missing" found/);
      assert.doesNotMatch(resume.stderr, /Cannot establish the Git repository top-level/);

      const browserRun = runCli(['run', 'not-an-issue-ref', '--browser-profile', 'work']);
      assert.equal(browserRun.status, 1);
      assert.match(browserRun.stderr, /Cannot establish the Git repository top-level/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
