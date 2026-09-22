import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  githubSnapshotCommand,
  findRunByTarget,
  LIVE_HEAD_SYNC_DECISION,
  main,
  parseIssueNumber,
  parseIssueRef,
  printDispatchResult,
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
        TACHIKO_NODE_PROGRAM: '/opt/tachiko/node/bin/node',
        TACHIKO_PNPM_PROGRAM: '/opt/tachiko/pnpm/bin/pnpm',
        TACHIKO_GIT_PROGRAM: '/opt/tachiko/git/bin/git',
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({
          revision: 'repo-v1',
          nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM',
          pnpmProgramEnvironment: 'TACHIKO_PNPM_PROGRAM',
          gitProgramEnvironment: 'TACHIKO_GIT_PROGRAM',
          terminalGeneratedIgnoredRoots: ['dist'],
          commands: [{ argv: ['pnpm', 'test'], timeoutMs: 100 }],
        }),
      }),
      {
        revision: 'repo-v1',
        nodeProgram: '/opt/tachiko/node/bin/node',
        pnpmProgram: '/opt/tachiko/pnpm/bin/pnpm',
        gitProgram: '/opt/tachiko/git/bin/git',
        terminalGeneratedIgnoredRoots: ['dist'],
        commands: [{ argv: ['/opt/tachiko/pnpm/bin/pnpm', 'test'], timeoutMs: 100 }],
      },
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({ TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({ revision: 'repo-v1', nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM', commands: [{ argv: ['pnpm'], timeoutMs: 100 }] }) }),
      /both Node and pnpm toolchain paths together/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({
          revision: 'repo-v1',
          terminalGeneratedIgnoredRoots: ['../escape'],
          commands: [{ argv: ['tool'], timeoutMs: 100 }],
        }),
      }),
      /must stay inside the validation workspace/,
    );
    assert.throws(
      () => resolveLocalValidationConfiguration({
        TACHIKO_GIT_PROGRAM: 'relative/git',
        TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify({
          revision: 'repo-v1',
          nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM',
          pnpmProgramEnvironment: 'TACHIKO_PNPM_PROGRAM',
          gitProgramEnvironment: 'TACHIKO_GIT_PROGRAM',
          commands: [{ argv: ['pnpm'], timeoutMs: 100 }],
        }),
        TACHIKO_NODE_PROGRAM: '/opt/node',
        TACHIKO_PNPM_PROGRAM: '/opt/pnpm',
      }),
      /TACHIKO_GIT_PROGRAM must be an absolute/,
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
