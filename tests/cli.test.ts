import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
  githubSnapshotCommand,
  assertCanonicalDispatchResumeClaim,
  findRunByTarget,
  LIVE_HEAD_SYNC_DECISION,
  main,
  outcomeExitCode,
  printOutcome,
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
  runMergedTransitionCommand,
  resumeCommand,
  runShowCommand,
  runShowView,
  runTransitionCommand,
} from '../src/cli.js';
import { qualifyGovernedPublicationAdapter, type ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, ReviewResult, Run, TransitionType } from '../src/domain/types.js';
import { GitHubLiveStateError } from '../src/github/errors.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import type { WorkflowOutcome } from '../src/workflow/run.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { resolveRunOwnerReceiptPath } from '../src/mission-admission/host-registry.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt } from '../src/mission-admission/run-owner-receipt.js';
import { DispatchAdmissionWaitError } from '../src/dispatch/runner.js';
import { acquireDispatchInvocationLock, DispatchInvocationLockedError } from '../src/dispatch/invocation-lock.js';
import type { DispatchRuntimeClaim } from '../src/dispatch/queue.js';
import { T0, TARGET, TEST_VALIDATION_AUTHORITY, successResult, validationPassed } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function runMergedTransitionForTest(
  store: RunStore,
  id: string,
  github: GitHubAdapter,
  admission: MissionAdmissionRegistry,
  lock: <T>(operation: () => T | Promise<T>) => Promise<T> = async <T>(operation: () => T | Promise<T>) => await operation(),
): Promise<Run> {
  return await runMergedTransitionCommand(store, id, github, admission, lock);
}
const REPAIR_AUTHORITY = { revision: 'task-shape-v1', shape: 'bounded' as const };

describe('CLI held workflow outcomes', () => {
  it('prints unchanged durable state and exits unsuccessfully when CAS is unsupported', () => {
    const run = { ...createRun(TARGET, T0, 'unsupported-cas-cli'), state: 'CHANGES_REQUESTED' as const };
    const outcome: WorkflowOutcome = { outcome: 'unsupported_cas', run, reason: 'Run store does not support compare-and-swap.' };
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      printOutcome(outcome);
    } finally {
      console.error = originalError;
    }
    assert.match(lines.join('\n'), /HELD/);
    assert.match(lines.join('\n'), /Durable state remains CHANGES_REQUESTED; no park was written/);
    assert.equal(outcomeExitCode(outcome), 2);
  });
});

/** Mark one CLI test fake as the host-confined implementation boundary it models. */
function qualifyGovernedFake<T extends ImplementationAgent>(agent: T): T {
  qualifyGovernedPublicationAdapter(agent);
  Object.defineProperty(agent, 'prepareGovernedInvocation', {
    configurable: true,
    value: () => ({ status: 'qualified' as const, agent }),
  });
  return agent;
}

function tempStore(): { store: JsonFileStore; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-'));
  return { store: new JsonFileStore({ dir }), dir };
}

function startSuccessorAdmission(filePath: string, receiptPath: string, laneId: string, runId: string, workspace: string, marker: string, config: AdmissionConfig): Promise<void> {
  const registryModule = pathToFileURL(path.join(REPO_ROOT, 'src/mission-admission/registry.ts')).href;
  const receiptModule = pathToFileURL(path.join(REPO_ROOT, 'src/mission-admission/run-owner-receipt.ts')).href;
  const source = `import { writeFileSync } from 'node:fs'; import { MissionAdmissionRegistry } from ${JSON.stringify(registryModule)}; import { readRunOwnerReceipt, writeRunOwnerReceipt } from ${JSON.stringify(receiptModule)}; writeFileSync(${JSON.stringify(marker)}, 'ready'); const registry = new MissionAdmissionRegistry({ filePath: ${JSON.stringify(filePath)}, config: ${JSON.stringify(config)}, lockTimeoutMs: 10000 }); const prior = readRunOwnerReceipt(${JSON.stringify(receiptPath)}); if (!prior) throw new Error('missing prior receipt'); const { token: _oldToken, ...base } = prior; const result = registry.admit({ laneId: ${JSON.stringify(laneId)}, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: ${JSON.stringify(runId)}, workspace: ${JSON.stringify(workspace)} } }, { beforePublish: (candidate) => writeRunOwnerReceipt(${JSON.stringify(receiptPath)}, { ...base, token: candidate.token, generation: candidate.token.generation, phase: 'pre_execution' }) }); if (result.outcome !== 'admitted') throw new Error('successor was not admitted');`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Successor admission child exited ${code}: ${stderr}`)));
  });
}

function waitForMarker(marker: string): void {
  const deadline = Date.now() + 5_000;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(marker) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 10);
  assert.ok(existsSync(marker), 'successor process reached its admission attempt');
  Atomics.wait(cell, 0, 0, 75);
}

function admitSuccessorWithReceipt(registry: MissionAdmissionRegistry, receiptPath: string, runId: string, workspace: string): void {
  const prior = readRunOwnerReceipt(receiptPath);
  assert.ok(prior);
  const result = registry.admit({ laneId: `run:${runId}`, role: 'production_captain', highAutonomy: true,
    evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace } }, {
    beforePublish: (candidate) => writeRunOwnerReceipt(receiptPath, { ...prior, token: candidate.token, generation: candidate.token.generation, phase: 'pre_execution' }),
  });
  assert.equal(result.outcome, 'admitted');
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

  it('fences public transitions while a Run admission lane is active or parked', () => {
    const { store, dir } = tempStore();
    const admissionDir = path.join(dir, 'admission');
    mkdirSync(admissionDir);
    const registry = new MissionAdmissionRegistry({ filePath: path.join(admissionDir, 'registry.json'), config: { schemaVersion: 1, revision: 'transition-fence-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
    try {
      const activeRun = createRun(TARGET, T0, 'transition-active');
      store.create(activeRun);
      const activeReceiptPath = path.join(dir, 'run-owner.json');
      const active = registry.admit({ laneId: `run:${activeRun.id}`, role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 42, run: activeRun.id } }, {
        beforePublish: (candidate) => writeRunOwnerReceipt(activeReceiptPath, {
          schemaVersion: 1, laneId: candidate.token.laneId, missionId: candidate.missionId, repository: 'acme/widgets', runId: activeRun.id,
          issue: 42, token: candidate.token, generation: candidate.token.generation, phase: 'pre_execution',
        }),
      });
      assert.equal(active.outcome, 'admitted');
      const activeBefore = runShowCommand(store, activeRun.id);
      const activeRegistryBefore = registry.snapshot();
      const activeReceiptBefore = readFileSync(activeReceiptPath, 'utf8');
      assert.throws(() => runTransitionCommand(store, activeRun.id, 'start', undefined, registry), /active mission admission ownership/);
      assert.deepEqual(runShowCommand(store, activeRun.id), activeBefore);
      assert.deepEqual(registry.snapshot(), activeRegistryBefore);
      assert.equal(readFileSync(activeReceiptPath, 'utf8'), activeReceiptBefore);

      const parkedRun = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 43 }, T0, 'transition-parked');
      store.create(parkedRun);
      const blocker = registry.admit({ laneId: 'transition-capacity-blocker', role: 'production_captain', evidence: { repository: 'other/repo', issue: 9 } });
      assert.equal(blocker.outcome, 'parked');
      const parked = registry.admit({ laneId: `run:${parkedRun.id}`, role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 43, run: parkedRun.id } });
      assert.equal(parked.outcome, 'parked');
      const parkedBefore = runShowCommand(store, parkedRun.id);
      const parkedRegistryBefore = registry.snapshot();
      const parkedReceiptPath = path.join(dir, 'parked-run-owner.json');
      assert.throws(() => runTransitionCommand(store, parkedRun.id, 'fail', 'manual override', registry), /parked mission admission ownership/);
      assert.deepEqual(runShowCommand(store, parkedRun.id), parkedBefore);
      assert.deepEqual(registry.snapshot(), parkedRegistryBefore);
      assert.equal(existsSync(parkedReceiptPath), false, 'receiptless capacity reservation remains intact');

      const unadmitted = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 44 }, T0, 'transition-unadmitted');
      store.create(unadmitted);
      assert.equal(runTransitionCommand(store, unadmitted.id, 'start', undefined, registry).state, 'IMPLEMENTING');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('holds the registry fence across the Run CAS so a concurrent admission waits', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-transition-race-'));
    const marker = path.join(dir, 'admission-attempted');
    const completed = path.join(dir, 'admission-completed');
    const admissionPath = path.join(dir, 'registry.json');
    const registry = new MissionAdmissionRegistry({ filePath: admissionPath, config: { schemaVersion: 1, revision: 'transition-race-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } }, lockTimeoutMs: 10_000 });
    const run = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 45 }, T0, 'transition-race');
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const store = new JsonFileStore({ dir: path.join(dir, 'runs'), beforeConditionalWrite: () => {
        const module = pathToFileURL(path.join(REPO_ROOT, 'src/mission-admission/registry.ts')).href;
        const source = `import { writeFileSync } from 'node:fs'; import { MissionAdmissionRegistry } from ${JSON.stringify(module)}; writeFileSync(${JSON.stringify(marker)}, 'attempted'); const registry = new MissionAdmissionRegistry({ filePath: ${JSON.stringify(admissionPath)}, config: { schemaVersion: 1, revision: 'transition-race-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } }, lockTimeoutMs: 10000 }); registry.admit({ laneId: ${JSON.stringify(`run:${run.id}`)}, role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 45, run: ${JSON.stringify(run.id)} } }); writeFileSync(${JSON.stringify(completed)}, 'done');`;
        child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
        waitForMarker(marker);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
        assert.equal(existsSync(completed), false, 'concurrent admission remains blocked while Run CAS executes');
      } });
      store.create(run);
      assert.equal(runTransitionCommand(store, run.id, 'start', undefined, registry).state, 'IMPLEMENTING');
      assert.ok(child);
      await new Promise<void>((resolve, reject) => {
        let stderr = '';
        child!.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child!.on('error', reject);
        child!.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Concurrent admission exited ${code}: ${stderr}`)));
      });
      assert.equal(existsSync(completed), true);
    } finally { child?.kill(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts only canonical physical dispatch lock aliases before a Run transition', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-canonical-dispatch-lock-'));
    const store = new JsonFileStore({ dir: path.join(dir, 'runs') });
    const accountHome = path.join(dir, 'account-home');
    const dispatchDir = path.join(accountHome, '.tachiko-conductor', 'dispatch');
    const dispatchAlias = path.join(dir, 'dispatch-alias');
    mkdirSync(dispatchDir, { recursive: true });
    symlinkSync(dispatchDir, dispatchAlias, 'dir');
    const run = createRun(TARGET, T0, 'canonical-lock-alias');
    store.create(run);
    const previousEnv = { data: process.env.TACHIKO_DATA_DIR, once: process.env.TACHIKO_DISPATCH_LOCK_PATH, admission: process.env.TACHIKO_DISPATCH_ADMISSION_LOCK_PATH };
    const originalUserInfo = os.userInfo;
    try {
      Object.defineProperty(os, 'userInfo', { configurable: true, value: (...args: Parameters<typeof originalUserInfo>) => ({ ...originalUserInfo(...args), homedir: accountHome }) });
      process.env.TACHIKO_DATA_DIR = path.join(dir, 'runs');
      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(dispatchAlias, 'once.lock');
      process.env.TACHIKO_DISPATCH_ADMISSION_LOCK_PATH = path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock.admission');
      assert.equal(await main(['run', 'transition', run.id, 'start']), 0, 'physical directory alias resolves to the account-owned canonical lock');
      assert.equal(runShowCommand(store, run.id).state, 'IMPLEMENTING');

      const rejectedRun = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 46 }, T0, 'noncanonical-lock');
      store.create(rejectedRun);
      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(dir, 'unrelated.lock');
      const before = runShowCommand(store, rejectedRun.id);
      await assert.rejects(main(['run', 'transition', rejectedRun.id, 'start']), /TACHIKO_DISPATCH_LOCK_PATH must resolve to the canonical/);
      assert.deepEqual(runShowCommand(store, rejectedRun.id), before, 'noncanonical alias is rejected before Run write');

      process.env.TACHIKO_DISPATCH_LOCK_PATH = path.join(dispatchAlias, 'once.lock');
      process.env.TACHIKO_DISPATCH_ADMISSION_LOCK_PATH = path.join(dir, 'unrelated-admission.lock');
      await assert.rejects(main(['run', 'transition', rejectedRun.id, 'start']), /TACHIKO_DISPATCH_ADMISSION_LOCK_PATH must resolve to the canonical/);
      assert.deepEqual(runShowCommand(store, rejectedRun.id), before, 'divergent admission-lock alias is rejected before Run write');
    } finally {
      Object.defineProperty(os, 'userInfo', { configurable: true, value: originalUserInfo });
      for (const [name, value] of Object.entries(previousEnv)) {
        const key = name === 'data' ? 'TACHIKO_DATA_DIR' : name === 'once' ? 'TACHIKO_DISPATCH_LOCK_PATH' : 'TACHIKO_DISPATCH_ADMISSION_LOCK_PATH';
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
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

  const MERGE_HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
  const MERGE_BASE = 'dddddddddddddddddddddddddddddddddddddddd';
  const MERGE_BOOTSTRAP = (workspacePath: string) => ({
    bootstrapKind: 'linked-worktree' as const,
    owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: MERGE_BASE,
    branch: 'tachiko/issue-42-merge', workspacePath,
  });

  function mergeReadyRun(id: string, workspacePath: string, dispatchClaimId?: string): Run {
    const workspace = path.join(workspacePath, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const run = createRun(TARGET, T0, id);
    return {
      ...run,
      state: 'MERGE_READY',
      ...(dispatchClaimId === undefined ? {} : { dispatchClaimId }),
      bootstrap: MERGE_BOOTSTRAP(workspace),
      pullRequest: { number: 7, headSha: MERGE_HEAD },
      headSha: MERGE_HEAD,
    };
  }

  function mergedPullRequest(overrides: Partial<NonNullable<GitHubLiveSnapshot['pullRequest']>> = {}): NonNullable<GitHubLiveSnapshot['pullRequest']> {
    return {
      id: 'PR_7', number: 7, title: 'Merge test', url: 'https://github.test/acme/widgets/pull/7',
      state: 'merged', isDraft: false, mergeable: true, mergeStateStatus: 'clean', updatedAt: T0,
      headSha: MERGE_HEAD, baseSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      headRef: 'tachiko/issue-42-merge', headRepository: { owner: 'acme', repo: 'widgets' },
      baseRef: 'main', baseRepository: { owner: 'acme', repo: 'widgets' },
      ...overrides,
    };
  }

  function mergeProofAdapter(pullRequest = mergedPullRequest()): GitHubAdapter {
    return { kind: 'github', readPullRequest: async () => pullRequest } as unknown as GitHubAdapter;
  }

  function isolateMergeReceiptRoot(dir: string): () => void {
    const oldReceiptRoot = process.env.TACHIKO_RUN_OWNER_RECEIPTS_DIR;
    const oldRunsDir = process.env.TACHIKO_DATA_DIR;
    const oldUserInfo = os.userInfo;
    os.userInfo = (() => ({ ...oldUserInfo(), homedir: dir })) as typeof os.userInfo;
    process.env.TACHIKO_RUN_OWNER_RECEIPTS_DIR = path.join(dir, '.tachiko-conductor', 'mission-admission', 'run-receipts');
    process.env.TACHIKO_DATA_DIR = path.join(dir, 'run-data');
    return () => {
      os.userInfo = oldUserInfo;
      if (oldReceiptRoot === undefined) delete process.env.TACHIKO_RUN_OWNER_RECEIPTS_DIR;
      else process.env.TACHIKO_RUN_OWNER_RECEIPTS_DIR = oldReceiptRoot;
      if (oldRunsDir === undefined) delete process.env.TACHIKO_DATA_DIR;
      else process.env.TACHIKO_DATA_DIR = oldRunsDir;
    };
  }

  function setupParkedMerge(dir: string, store: RunStore, run: Run, reason: 'workflow_settled' | 'workflow_wait' = 'workflow_settled', registryOptions: Partial<ConstructorParameters<typeof MissionAdmissionRegistry>[0]> = {}) {
    const config: AdmissionConfig = { schemaVersion: 1, revision: `merge-${run.id}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
    const registryPath = path.join(dir, `merge-${run.id}.json`);
    const registry = new MissionAdmissionRegistry({ filePath: registryPath, config, ...registryOptions });
    const repository = `${run.target.owner}/${run.target.repo}`.toLowerCase();
    const workspace = realpathSync(run.bootstrap!.workspacePath);
    const evidence = { repository, ...(run.target.kind === 'issue' ? { issue: run.target.issueNumber } : {}), ...(run.dispatchClaimId === undefined ? {} : { claim: run.dispatchClaimId }), run: run.id, pullRequest: run.pullRequest!.number, workspace };
    const admission = registry.admit({ laneId: `run:${run.id}`, role: 'production_captain', highAutonomy: true, evidence });
    assert.equal(admission.outcome, 'admitted');
    if (admission.outcome !== 'admitted') throw new Error('expected merge test admission');
    const receiptPath = resolveRunOwnerReceiptPath(repository, run.id, evidence);
    const initialReceipt = {
      schemaVersion: 1 as const, laneId: admission.token.laneId, missionId: admission.missionId,
      repository, runId: run.id, issue: run.target.kind === 'issue' ? run.target.issueNumber : undefined,
      ...(run.dispatchClaimId === undefined ? {} : { claimId: run.dispatchClaimId }),
      workspace, token: admission.token, generation: admission.token.generation, phase: 'park_transition' as const,
    };
    registry.park(admission.token, reason,
      () => writeRunOwnerReceipt(receiptPath, initialReceipt),
      () => writeRunOwnerReceipt(receiptPath, { ...initialReceipt, token: undefined, generation: admission.token.generation + 1, phase: 'parked' }));
    store.create(run);
    return { registry, receiptPath, workspace, generation: admission.token.generation + 1 };
  }

  it('requires exact live merged PR proof before any Run, registry, or receipt write', async () => {
    const invalidProofs = [
      mergedPullRequest({ state: 'open' as const }),
      mergedPullRequest({ state: 'closed' as const }),
      mergedPullRequest({ number: 8 }),
      mergedPullRequest({ headSha: 'ffffffffffffffffffffffffffffffffffffffff' }),
      mergedPullRequest({ headRef: 'other-branch' }),
      mergedPullRequest({ baseRef: 'develop' }),
      mergedPullRequest({ headRepository: { owner: 'forker', repo: 'widgets' } }),
      mergedPullRequest({ baseRepository: { owner: 'acme', repo: 'other' } }),
    ];
    for (let index = 0; index < invalidProofs.length; index += 1) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-proof-'));
      const restoreEnv = isolateMergeReceiptRoot(dir);
      try {
        const store = new MemoryStore();
        const run = mergeReadyRun(`merge-proof-${index}`, dir);
        const { registry, receiptPath } = setupParkedMerge(dir, store, run);
        const beforeRun = store.read(run.id);
        const beforeReceipt = readFileSync(receiptPath, 'utf8');
      const beforeRegistry = readFileSync(path.join(dir, `merge-${run.id}.json`), 'utf8');
        await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(invalidProofs[index]!), registry), /does not match|not merged/);
        assert.deepEqual(store.read(run.id), beforeRun);
        assert.equal(readFileSync(receiptPath, 'utf8'), beforeReceipt);
        assert.equal(readFileSync(path.join(dir, `merge-${run.id}.json`), 'utf8'), beforeRegistry);
      } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-unavailable-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-proof-unavailable', dir);
      const { registry, receiptPath } = setupParkedMerge(dir, store, run);
      const before = readFileSync(receiptPath, 'utf8');
      const unavailable = { kind: 'github', readPullRequest: async () => { throw new Error('GitHub unavailable'); } } as unknown as GitHubAdapter;
      await assert.rejects(runMergedTransitionForTest(store, run.id, unavailable, registry), /GitHub unavailable/);
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(receiptPath, 'utf8'), before);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reconciles workflow_settled merge and accepts squash/main advancement without comparing the old base SHA', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-success-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-success', dir);
      const { registry, receiptPath, generation } = setupParkedMerge(dir, store, run);
      const parkedReceipt = readRunOwnerReceipt(receiptPath)!;
      assert.throws(() => writeRunOwnerReceipt(receiptPath, { ...parkedReceipt, settlementReason: 'workflow_settled' }), /invalid/);
      const result = await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), registry);
      assert.equal(result.state, 'MERGED');
      assert.equal(store.read(run.id)?.state, 'MERGED');
      const lane = registry.readLane(`run:${run.id}`);
      assert.equal(lane?.status, 'released');
      assert.equal(lane?.generation, generation + 1);
      const receipt = readRunOwnerReceipt(receiptPath);
      assert.equal(receipt?.phase, 'released');
      assert.equal(receipt?.generation, generation + 1);
      assert.equal(receipt?.settlementReason, 'workflow_settled');
      const registryBytes = readFileSync(path.join(dir, 'merge-merge-success.json'), 'utf8');
      const receiptBytes = readFileSync(receiptPath, 'utf8');
      assert.equal((await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), registry)).state, 'MERGED');
      assert.equal(readFileSync(path.join(dir, 'merge-merge-success.json'), 'utf8'), registryBytes);
      assert.equal(readFileSync(receiptPath, 'utf8'), receiptBytes);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('recovers both Run-CAS-before-registry and registry-before-final-receipt merge crashes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-crash-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      let failPublish = false;
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-crash', dir);
      const setup = setupParkedMerge(dir, store, run, 'workflow_settled', {
        filePath: path.join(dir, 'merge-crash.json'),
        config: { schemaVersion: 1, revision: 'merge-crash-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        beforePublish: () => { if (failPublish) throw new Error('injected registry publication failure'); },
      });
      failPublish = true;
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry), /injected registry publication failure/);
      assert.equal(store.read(run.id)?.state, 'MERGED');
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.status, 'parked');
      assert.equal(readRunOwnerReceipt(setup.receiptPath)?.phase, 'parked_release_transition');
      failPublish = false;
      await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry);
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.status, 'released');

      const releasedBeforeRun = mergeReadyRun('merge-run-cas-after-release', dir);
      const releasedBeforeRunSetup = setupParkedMerge(dir, store, releasedBeforeRun);
      const beforeReleaseReceipt = readRunOwnerReceipt(releasedBeforeRunSetup.receiptPath)!;
      const { token: _parkToken, ...tokenlessReceipt } = beforeReleaseReceipt;
      writeRunOwnerReceipt(releasedBeforeRunSetup.receiptPath, {
        ...tokenlessReceipt,
        phase: 'parked_release_transition',
        generation: releasedBeforeRunSetup.generation,
        settlementReason: 'workflow_settled',
      });
      releasedBeforeRunSetup.registry.releaseParked(`run:${releasedBeforeRun.id}`, releasedBeforeRunSetup.generation, true);
      assert.equal(store.read(releasedBeforeRun.id)?.state, 'MERGE_READY');
      assert.equal(releasedBeforeRunSetup.registry.readLane(`run:${releasedBeforeRun.id}`)?.status, 'released');
      await runMergedTransitionForTest(store, releasedBeforeRun.id, mergeProofAdapter(), releasedBeforeRunSetup.registry);
      assert.equal(store.read(releasedBeforeRun.id)?.state, 'MERGED');
      assert.equal(readRunOwnerReceipt(releasedBeforeRunSetup.receiptPath)?.phase, 'released');


      let sabotageReceipt = false;
      let receiptPath = '';
      let savedTransition: ReturnType<typeof readRunOwnerReceipt> = null;
      const finalReceiptRun = mergeReadyRun('merge-final-receipt-crash', dir);
      const finalReceiptSetup = setupParkedMerge(dir, store, finalReceiptRun, 'workflow_settled', {
        filePath: path.join(dir, 'merge-final-receipt-crash.json'),
        config: { schemaVersion: 1, revision: 'merge-final-receipt-crash-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } },
        beforePublish: () => {
          if (!sabotageReceipt) return;
          savedTransition = readRunOwnerReceipt(receiptPath);
          if (savedTransition === null) throw new Error('expected transition receipt before registry publication');
          rmSync(receiptPath, { force: true });
          symlinkSync('missing-receipt-target', receiptPath);
        },
      });
      receiptPath = finalReceiptSetup.receiptPath;
      sabotageReceipt = true;
      await assert.rejects(runMergedTransitionForTest(store, finalReceiptRun.id, mergeProofAdapter(), finalReceiptSetup.registry), /private owner-owned|symbolic link/);
      assert.equal(finalReceiptSetup.registry.readLane(`run:${finalReceiptRun.id}`)?.status, 'released');
      assert.equal(store.read(finalReceiptRun.id)?.state, 'MERGED');
      assert.ok(savedTransition);
      rmSync(receiptPath, { force: true });
      writeRunOwnerReceipt(receiptPath, savedTransition!);
      sabotageReceipt = false;
      await runMergedTransitionForTest(store, finalReceiptRun.id, mergeProofAdapter(), finalReceiptSetup.registry);
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'released');
      assert.equal(readRunOwnerReceipt(receiptPath)?.generation, finalReceiptSetup.generation + 1);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('permits only the exact workflow_settled released retry, never a different parked reason', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-fence-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-wrong-park', dir);
      const setup = setupParkedMerge(dir, store, run, 'workflow_wait');
      const beforeRun = store.read(run.id);
      const beforeReceipt = readFileSync(setup.receiptPath, 'utf8');
      const beforeRegistry = readFileSync(path.join(dir, 'merge-merge-wrong-park.json'), 'utf8');
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry), /requires workflow_settled/);
      assert.deepEqual(store.read(run.id), beforeRun);
      assert.equal(readFileSync(setup.receiptPath, 'utf8'), beforeReceipt);
      assert.equal(readFileSync(path.join(dir, 'merge-merge-wrong-park.json'), 'utf8'), beforeRegistry);

      const interruptedRun = mergeReadyRun('merge-interrupted-park', dir);
      const interruptedSetup = setupParkedMerge(dir, store, interruptedRun);
      const parkedReceipt = readRunOwnerReceipt(interruptedSetup.receiptPath)!;
      writeRunOwnerReceipt(interruptedSetup.receiptPath, {
        ...parkedReceipt,
        token: { laneId: parkedReceipt.laneId, generation: interruptedSetup.generation - 1, token: 'prior-capability' },
        generation: interruptedSetup.generation - 1,
        phase: 'park_transition',
      });
      const beforeInterrupted = readFileSync(interruptedSetup.receiptPath, 'utf8');
      await assert.rejects(runMergedTransitionForTest(store, interruptedRun.id, mergeProofAdapter(), interruptedSetup.registry), /phase and generation do not match/);
      assert.equal(store.read(interruptedRun.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(interruptedSetup.receiptPath, 'utf8'), beforeInterrupted);
      assert.equal(interruptedSetup.registry.readLane(`run:${interruptedRun.id}`)?.status, 'parked');

      const wrongIdentityRun = mergeReadyRun('merge-wrong-receipt-identity', dir);
      const wrongIdentitySetup = setupParkedMerge(dir, store, wrongIdentityRun);
      const validReceipt = readRunOwnerReceipt(wrongIdentitySetup.receiptPath)!;
      writeRunOwnerReceipt(wrongIdentitySetup.receiptPath, { ...validReceipt, issue: 43 });
      const mismatchedReceipt = readFileSync(wrongIdentitySetup.receiptPath, 'utf8');
      const mismatchedRegistry = readFileSync(path.join(dir, 'merge-merge-wrong-receipt-identity.json'), 'utf8');
      await assert.rejects(runMergedTransitionForTest(store, wrongIdentityRun.id, mergeProofAdapter(), wrongIdentitySetup.registry), /receipt does not match exact merge lane identity/);
      assert.equal(store.read(wrongIdentityRun.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(wrongIdentitySetup.receiptPath, 'utf8'), mismatchedReceipt);
      assert.equal(readFileSync(path.join(dir, 'merge-merge-wrong-receipt-identity.json'), 'utf8'), mismatchedRegistry);

      const releasedRun = mergeReadyRun('merge-released-no-marker', dir);
      const releasedSetup = setupParkedMerge(dir, store, releasedRun);
      const receipt = readRunOwnerReceipt(releasedSetup.receiptPath)!;
      releasedSetup.registry.releaseParked(`run:${releasedRun.id}`, releasedSetup.generation, true);
      const { token: _parkedToken, ...receiptBase } = receipt;
      writeRunOwnerReceipt(releasedSetup.receiptPath, { ...receiptBase, phase: 'parked_release_transition', generation: releasedSetup.generation, token: undefined });
      await assert.rejects(runMergedTransitionForTest(store, releasedRun.id, mergeProofAdapter(), releasedSetup.registry), /exact workflow_settled merge transition receipt/);
      assert.equal(store.read(releasedRun.id)?.state, 'MERGE_READY');

      const wrongGenerationRun = mergeReadyRun('merge-released-wrong-generation', dir);
      const wrongGenerationSetup = setupParkedMerge(dir, store, wrongGenerationRun);
      const parkedForWrongGeneration = readRunOwnerReceipt(wrongGenerationSetup.receiptPath)!;
      const { token: _wrongGenerationToken, ...wrongGenerationBase } = parkedForWrongGeneration;
      writeRunOwnerReceipt(wrongGenerationSetup.receiptPath, {
        ...wrongGenerationBase,
        phase: 'parked_release_transition',
        generation: wrongGenerationSetup.generation - 1,
        settlementReason: 'workflow_settled',
      });
      wrongGenerationSetup.registry.releaseParked(`run:${wrongGenerationRun.id}`, wrongGenerationSetup.generation, true);
      const badGenerationReceipt = readFileSync(wrongGenerationSetup.receiptPath, 'utf8');
      await assert.rejects(runMergedTransitionForTest(store, wrongGenerationRun.id, mergeProofAdapter(), wrongGenerationSetup.registry), /exact workflow_settled merge transition receipt/);
      assert.equal(store.read(wrongGenerationRun.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(wrongGenerationSetup.receiptPath, 'utf8'), badGenerationReceipt);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reconciles MERGE_READY after stopped recovery finalized the marked merge receipt', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-stopped-recovery-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-stopped-recovery-finalized', dir);
      const setup = setupParkedMerge(dir, store, run);
      const cas = store.updateIfUnchanged.bind(store);
      let race = true;
      store.updateIfUnchanged = (expected, next) => {
        if (race) {
          race = false;
          store.update({ ...expected, updatedAt: '2026-08-14T04:30:00.000Z' });
          return false;
        }
        return cas(expected, next);
      };
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry), /changed concurrently/);
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.status, 'parked');
      const interrupted = readRunOwnerReceipt(setup.receiptPath);
      assert.equal(interrupted?.phase, 'parked_release_transition');
      assert.equal(interrupted?.generation, setup.generation);
      assert.equal(interrupted?.settlementReason, 'workflow_settled');
      store.updateIfUnchanged = cas;

      assert.equal(recoverRunAdmission(store, setup.registry, run.id, setup.generation, true, setup.receiptPath), 'released');
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.generation, setup.generation + 1);
      const finalized = readRunOwnerReceipt(setup.receiptPath);
      assert.equal(finalized?.phase, 'released');
      assert.equal(finalized?.generation, setup.generation + 1);
      assert.equal(finalized?.settlementReason, 'workflow_settled');

      const registryBytes = readFileSync(path.join(dir, `merge-${run.id}.json`), 'utf8');
      const receiptBytes = readFileSync(setup.receiptPath, 'utf8');
      assert.equal((await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry)).state, 'MERGED');
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.generation, setup.generation + 1);
      assert.equal(readFileSync(path.join(dir, `merge-${run.id}.json`), 'utf8'), registryBytes);
      assert.equal(readFileSync(setup.receiptPath, 'utf8'), receiptBytes);
      assert.equal((await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry)).state, 'MERGED');
      assert.equal(readFileSync(path.join(dir, `merge-${run.id}.json`), 'utf8'), registryBytes);
      assert.equal(readFileSync(setup.receiptPath, 'utf8'), receiptBytes);

      const unmarkedRun = mergeReadyRun('merge-stopped-recovery-unmarked', dir);
      const unmarkedSetup = setupParkedMerge(dir, store, unmarkedRun);
      recoverRunAdmission(store, unmarkedSetup.registry, unmarkedRun.id, unmarkedSetup.generation, true, unmarkedSetup.receiptPath);
      const settledReceipt = readRunOwnerReceipt(unmarkedSetup.receiptPath)!;
      assert.equal(settledReceipt.settlementReason, 'workflow_settled', 'locked stopped recovery preserves the actual parked origin');
      const { settlementReason: _settlementReason, ...legacyUnmarkedReceipt } = settledReceipt;
      writeRunOwnerReceipt(unmarkedSetup.receiptPath, legacyUnmarkedReceipt);
      const unmarkedReceipt = readFileSync(unmarkedSetup.receiptPath, 'utf8');
      await assert.rejects(runMergedTransitionForTest(store, unmarkedRun.id, mergeProofAdapter(), unmarkedSetup.registry), /exact workflow_settled merge transition receipt/);
      assert.equal(store.read(unmarkedRun.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(unmarkedSetup.receiptPath, 'utf8'), unmarkedReceipt);
      assert.equal(unmarkedSetup.registry.readLane(`run:${unmarkedRun.id}`)?.status, 'released');

      const dispatchBoundRun = mergeReadyRun('merge-stopped-recovery-dispatch-bound', dir, 'claim-stopped-recovery-bound');
      const dispatchBoundSetup = setupParkedMerge(dir, store, dispatchBoundRun);
      assert.equal(readRunOwnerReceipt(dispatchBoundSetup.receiptPath)?.settlementReason, undefined);
      assert.equal(recoverRunAdmission(store, dispatchBoundSetup.registry, dispatchBoundRun.id, dispatchBoundSetup.generation, true, dispatchBoundSetup.receiptPath), 'released');
      const dispatchBoundReceipt = readRunOwnerReceipt(dispatchBoundSetup.receiptPath);
      assert.equal(dispatchBoundReceipt?.claimId, dispatchBoundRun.dispatchClaimId);
      assert.equal(dispatchBoundReceipt?.settlementReason, 'workflow_settled');
      const settledRegistryBytes = readFileSync(path.join(dir, `merge-${dispatchBoundRun.id}.json`), 'utf8');
      assert.equal((await runMergedTransitionForTest(store, dispatchBoundRun.id, mergeProofAdapter(), dispatchBoundSetup.registry)).state, 'MERGED');
      assert.equal(dispatchBoundSetup.registry.readLane(`run:${dispatchBoundRun.id}`)?.generation, dispatchBoundSetup.generation + 1);
      assert.equal(readFileSync(path.join(dir, `merge-${dispatchBoundRun.id}.json`), 'utf8'), settledRegistryBytes, 'merge retry consumes the exact released generation without another registry transition');

      const conflictingRun = { ...mergeReadyRun('merge-stopped-recovery-conflicting-marker', dir), state: 'NEEDS_HUMAN' as const };
      const conflictingSetup = setupParkedMerge(dir, store, conflictingRun, 'workflow_wait');
      const parked = readRunOwnerReceipt(conflictingSetup.receiptPath)!;
      writeRunOwnerReceipt(conflictingSetup.receiptPath, {
        ...parked,
        token: undefined,
        phase: 'parked_release_transition',
        generation: conflictingSetup.generation,
        settlementReason: 'workflow_settled',
      });
      const beforeConflict = readFileSync(conflictingSetup.receiptPath, 'utf8');
      assert.throws(() => recoverRunAdmission(store, conflictingSetup.registry, conflictingRun.id, conflictingSetup.generation, true, conflictingSetup.receiptPath), /settlement provenance conflicts/);
      assert.equal(conflictingSetup.registry.readLane(`run:${conflictingRun.id}`)?.status, 'parked');
      assert.equal(readFileSync(conflictingSetup.receiptPath, 'utf8'), beforeConflict);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves a workflow parked receipt across denied re-admission and recovers its exact generation after restart', () => {
    for (const reason of ['workflow_wait', 'workflow_settled'] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-capacity-parked-recovery-'));
      const restoreEnv = isolateMergeReceiptRoot(dir);
      try {
        const runsDirectory = path.join(dir, 'runs');
        const store = new JsonFileStore({ dir: runsDirectory });
        const run = mergeReadyRun(`capacity-parked-${reason}`, dir);
        const setup = setupParkedMerge(dir, store, run, reason);
        const registryFile = path.join(dir, `merge-${run.id}.json`);
        const beforeLane = setup.registry.readLane(`run:${run.id}`)!;
        const beforeReceipt = readFileSync(setup.receiptPath, 'utf8');
        const holder = setup.registry.admit({ laneId: `capacity-holder-${reason}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'elsewhere/widgets', issue: 9 } });
        assert.equal(holder.outcome, 'admitted');
        if (holder.outcome !== 'admitted') continue;
        const beforeDenied = readFileSync(registryFile, 'utf8');
        const request = {
          laneId: beforeLane.laneId, role: 'production_captain' as const, highAutonomy: true,
          evidence: { ...beforeLane.evidence, stateSurface: `${setup.workspace}/stronger-state` },
        };
        const firstDenied = setup.registry.admit(request);
        assert.equal(firstDenied.outcome, 'parked');
        assert.equal(firstDenied.outcome === 'parked' ? firstDenied.reason : null, 'capacity_captains');
        assert.equal(readFileSync(registryFile, 'utf8'), beforeDenied, 'capacity denial does not replace the parked lane generation or evidence');
        assert.equal(readFileSync(setup.receiptPath, 'utf8'), beforeReceipt, 'capacity denial does not rewrite the finalized parked receipt');
        const repeated = setup.registry.admit(request);
        assert.equal(repeated.outcome, 'parked');
        assert.equal(readFileSync(registryFile, 'utf8'), beforeDenied);
        assert.equal(readFileSync(setup.receiptPath, 'utf8'), beforeReceipt);

        const restarted = new MissionAdmissionRegistry({ filePath: registryFile, config: { schemaVersion: 1, revision: `merge-${run.id}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
        assert.deepEqual(restarted.readLane(beforeLane.laneId), beforeLane);
        const restartedStore = new JsonFileStore({ dir: runsDirectory });
        assert.deepEqual(restartedStore.read(run.id), run, 'fresh Run-store instance reloads the exact durable Run before recovery');
        assert.equal(recoverRunAdmission(restartedStore, restarted, run.id, setup.generation, true, setup.receiptPath), 'released', 'operator-stopped recovery accepts the exact original parked generation after both stores restart');
        assert.equal(restarted.readLane(holder.token.laneId)?.status, 'active', 'recovery leaves the unrelated capacity holder active');
        assert.equal(readRunOwnerReceipt(setup.receiptPath)?.phase, 'released');

        restarted.release(holder.token, true);
        const reentryPrior = readRunOwnerReceipt(setup.receiptPath)!;
        const { settlementReason: _settlementReason, ...reentryReceipt } = reentryPrior;
        const readmitted = restarted.admit(request, {
          beforePublish: (candidate) => writeRunOwnerReceipt(setup.receiptPath, {
            ...reentryReceipt, token: candidate.token, generation: candidate.token.generation, phase: 'pre_execution',
          }),
        });
        assert.equal(readmitted.outcome, 'admitted');
        if (readmitted.outcome === 'admitted') {
          assert.equal(readmitted.token.generation, setup.generation + 2, 'successful re-entry advances beyond exact stopped recovery monotonically');
          assert.equal(restarted.readLane(beforeLane.laneId)?.evidence.stateSurface, `${setup.workspace}/stronger-state`);
          assert.equal(readRunOwnerReceipt(setup.receiptPath)?.generation, readmitted.token.generation);
        }
      } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('does not release on Run CAS races and does not overwrite a successor receipt on stale retry', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-cas-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-cas-race', dir);
      const setup = setupParkedMerge(dir, store, run);
      const cas = store.updateIfUnchanged.bind(store);
      let race = true;
      store.updateIfUnchanged = (expected, next) => {
        if (race) {
          race = false;
          store.update({ ...expected, updatedAt: '2026-08-14T04:00:00.000Z' });
          return false;
        }
        return cas(expected, next);
      };
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry), /changed concurrently/);
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.status, 'parked');
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      assert.equal(readRunOwnerReceipt(setup.receiptPath)?.phase, 'parked_release_transition');
      store.updateIfUnchanged = cas;
      await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry);

      const prior = readRunOwnerReceipt(setup.receiptPath)!;
      const successor = setup.registry.admit({ laneId: `run:${run.id}`, role: 'production_captain', highAutonomy: true,
        evidence: { repository: 'acme/widgets', issue: 42, run: run.id, pullRequest: 7, workspace: setup.workspace } }, {
        beforePublish: (candidate) => writeRunOwnerReceipt(setup.receiptPath, { ...prior, token: candidate.token, generation: candidate.token.generation, phase: 'pre_execution', settlementReason: undefined }),
      });
      assert.equal(successor.outcome, 'admitted');
      const successorReceipt = readRunOwnerReceipt(setup.receiptPath);
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(), setup.registry), /active mission admission ownership/);
      assert.deepEqual(readRunOwnerReceipt(setup.receiptPath), successorReceipt);
      assert.equal(setup.registry.readLane(`run:${run.id}`)?.status, 'active');
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires live proof for admission-free merged transitions and blocks direct operator claims', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-legacy-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-no-admission', dir);
      store.create(run);
      const admission = new MissionAdmissionRegistry({ filePath: path.join(dir, 'registry.json'), config: { schemaVersion: 1, revision: 'merge-no-admission-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      assert.throws(() => runTransitionCommand(store, run.id, 'merged', undefined, admission), /exact live GitHub merged/);
      await assert.rejects(runMergedTransitionForTest(store, run.id, mergeProofAdapter(mergedPullRequest({ state: 'closed' as const })), admission), /not merged/);
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      const result = await runMergedTransitionForTest(store, run.id, mergeProofAdapter(), admission);
      assert.equal(result.state, 'MERGED');

      const legacyRun = mergeReadyRun('merge-released-legacy', dir);
      const legacySetup = setupParkedMerge(dir, store, legacyRun);
      const legacyMerged = applyTransition(legacyRun, { type: 'merged' }, T0);
      store.update(legacyMerged);
      legacySetup.registry.releaseParked(`run:${legacyRun.id}`, legacySetup.generation, true);
      rmSync(legacySetup.receiptPath, { force: true });
      const legacyResult = await runMergedTransitionForTest(store, legacyRun.id, mergeProofAdapter(), legacySetup.registry);
      assert.equal(legacyResult.state, 'MERGED');
      assert.equal(existsSync(legacySetup.receiptPath), false, 'a live-proven released legacy run remains a no-op without inventing a receipt');
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('fetches live proof before the short dispatch lock and rejects Run drift before locked writes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-cli-merge-lock-order-'));
    const restoreEnv = isolateMergeReceiptRoot(dir);
    try {
      const store = new MemoryStore();
      const run = mergeReadyRun('merge-lock-drift', dir);
      const setup = setupParkedMerge(dir, store, run);
      const beforeReceipt = readFileSync(setup.receiptPath, 'utf8');
      const beforeRegistry = readFileSync(path.join(dir, 'merge-merge-lock-drift.json'), 'utf8');
      let held = false;
      const github = {
        kind: 'github' as const,
        async readPullRequest() {
          assert.equal(held, false, 'GitHub I/O stays outside the short lock');
          return mergedPullRequest();
        },
      } as unknown as GitHubAdapter;
      const withLock = async <T>(operation: () => T | Promise<T>): Promise<T> => {
        held = true;
        store.update({ ...run, updatedAt: '2026-08-14T05:00:00.000Z' });
        try { return await operation(); } finally { held = false; }
      };
      await assert.rejects(runMergedTransitionForTest(store, run.id, github, setup.registry, withLock), /changed after live merge proof/);
      assert.equal(store.read(run.id)?.state, 'MERGE_READY');
      assert.equal(readFileSync(setup.receiptPath, 'utf8'), beforeReceipt);
      assert.equal(readFileSync(path.join(dir, 'merge-merge-lock-drift.json'), 'utf8'), beforeRegistry);
    } finally { restoreEnv(); rmSync(dir, { recursive: true, force: true }); }
  });

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

  it('serializes concurrent direct Run intent creation and releases the short lock before provider work', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      const registry = new MissionAdmissionRegistry({ filePath: path.join(dir, 'registry.json'), config: { schemaVersion: 1, revision: 'direct-run-lock-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      let tail = Promise.resolve();
      let admissionLockHeld = false;
      const withRunAdmissionLock = async <T>(operation: (release: () => void) => T | Promise<T>): Promise<T> => {
        const previous = tail;
        let unlock!: () => void;
        tail = new Promise<void>((resolve) => { unlock = resolve; });
        await previous;
        admissionLockHeld = true;
        let released = false;
        const release = () => { if (!released) { released = true; admissionLockHeld = false; unlock(); } };
        try { return await operation(release); } finally { release(); }
      };
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => { markEntered = resolve; });
      let allowFailure!: () => void;
      const failureGate = new Promise<void>((resolve) => { allowFailure = resolve; });
      let providerSawReleasedLock = false;
      class BlockingImplementation implements ImplementationAgent {
        readonly kind = 'implementation-agent' as const;
        async run(): Promise<AgentResult> {
          providerSawReleasedLock = !admissionLockHeld;
          markEntered();
          await failureGate;
          throw new Error('injected uncertain workflow stop');
        }
      }
      const options = {
        admission: registry,
        admissionWorkspace: dir,
        runOwnerReceiptPath: path.join(dir, 'owner.json'),
        withRunAdmissionLock,
      };
      const workflowDeps = deps(store, githubAdapter([HEAD]), qualifyGovernedFake(new BlockingImplementation()), new FakeReviewer([]));
      const first = runIssueCommand(workflowDeps, 'acme/widgets#42', options);
      await entered;
      await assert.rejects(runIssueCommand(workflowDeps, 'acme/widgets#42', options), /Lane already has active ownership|active or parked lane/);
      assert.equal(store.list().length, 1, 'concurrent callers share the persisted READY Run id');
      assert.equal(providerSawReleasedLock, true, 'provider execution begins only after the direct admission lock is released');
      allowFailure();
      await assert.rejects(first, /injected uncertain workflow stop/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists direct capacity-wait Run before admission and retries the same id after capacity release', async () => {
    const { dir } = tempStore();
    try {
      const store = new MemoryStore();
      const registry = new MissionAdmissionRegistry({ filePath: path.join(dir, 'registry.json'), config: { schemaVersion: 1, revision: 'direct-capacity-retry-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const holder = registry.admit({ laneId: 'other-mission', role: 'production_captain', highAutonomy: true, evidence: { repository: 'other/repo', issue: 9 } });
      assert.equal(holder.outcome, 'admitted');
      await assert.rejects(runIssueCommand(deps(store, githubAdapter([]), new FakeImplementation([]), new FakeReviewer([])), 'acme/widgets#42', {
        admission: registry, runOwnerReceiptPath: path.join(dir, 'owner.json'), now: () => T0,
      }), /cannot enter mission admission: Run .*waiting for mission admission capacity/);
      const persisted = store.list();
      assert.equal(persisted.length, 1, 'capacity denial leaves the exact READY Run durable');
      assert.equal(persisted[0]?.state, 'READY');
      const parked = registry.readLane(`run:${persisted[0]!.id}`);
      assert.equal(parked?.status, 'parked');
      if (holder.outcome !== 'admitted') return;
      registry.release(holder.token, true);
      class StopAfterAdmission implements ImplementationAgent {
        readonly kind = 'implementation-agent' as const;
        async run(): Promise<AgentResult> { throw new Error('stopped after retry admission'); }
      }
      await assert.rejects(runIssueCommand(deps(store, githubAdapter([HEAD]), qualifyGovernedFake(new StopAfterAdmission()), new FakeReviewer([])), 'acme/widgets#42', {
        admission: registry, admissionWorkspace: dir, runOwnerReceiptPath: path.join(dir, 'owner.json'), now: () => T0,
      }), /stopped after retry admission/);
      assert.equal(store.list().length, 1, 'retry does not construct a second random Run id');
      assert.equal(store.list()[0]?.id, persisted[0]?.id);
      assert.equal(registry.readLane(`run:${persisted[0]!.id}`)?.status, 'active');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps initial admission logical until a workspace is actually prepared', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-logical-admission-'));
    try {
      const store = new MemoryStore();
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'logical-admission-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
      registry.admit({ laneId: 'ambient-cwd-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 99, workspace: process.cwd() } });
      const implementation = qualifyGovernedFake(new FakeImplementation([]));
      await assert.rejects(runIssueCommand(
        deps(store, githubAdapter([HEAD]), implementation, new FakeReviewer([])),
        'acme/widgets#42',
        { admission: registry, runOwnerReceiptPath: path.join(directory, 'owner.json'), now: () => T0 },
      ), /explicit execution workspace/);
      const run = store.list()[0]!;
      const lane = registry.readLane(`run:${run.id}`)!;
      assert.equal(lane.evidence.workspace, undefined, 'initial logical reservation does not capture ambient cwd');
      assert.equal(implementation.calls, 0, 'the mutation fence still requires a physical workspace');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('binds initial admission to the prepared worktree instead of conflicting ambient cwd', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-prepared-admission-'));
    try {
      const store = new MemoryStore();
      const canonicalWorkspace = path.join(directory, 'prepared-worktree');
      mkdirSync(canonicalWorkspace);
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'prepared-admission-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } } });
      registry.admit({ laneId: 'ambient-cwd-owner', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 99, workspace: process.cwd() } });
      const identity = { bootstrapKind: 'linked-worktree' as const, owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: HEAD, branch: 'codex/run-42', workspacePath: canonicalWorkspace };
      let prepareCalls = 0;
      const bootstrap = {
        kind: 'implementation-bootstrap' as const,
        bootstrapKind: 'linked-worktree' as const,
        async plan() { return identity; },
        async prepare() { prepareCalls += 1; return identity; },
        guard() { return { assertValid() {} }; },
        async verifyDurable() { return { headSha: HEAD, branch: identity.branch }; },
      };
      class UncertainImplementation implements ImplementationAgent {
        readonly kind = 'implementation-agent' as const;
        observedWorkspace: string | undefined;
        async run(request: Parameters<ImplementationAgent['run']>[0]): Promise<AgentResult> {
          this.observedWorkspace = request.workspacePath;
          throw new Error('stop after observing prepared workspace');
        }
      }
      const implementation = qualifyGovernedFake(new UncertainImplementation());
      const live = githubAdapter([HEAD, HEAD]);
      const noPullRequestGithub: GitHubAdapter = {
        ...live,
        async readLiveSnapshot(target) {
          const snapshot = await live.readLiveSnapshot(target);
          return {
            ...snapshot,
            repository: { ...snapshot.repository, defaultBranch: 'main', defaultBranchHeadSha: HEAD },
            pullRequest: null,
            headSha: null,
          };
        },
      };
      const workflow = { ...deps(store, noPullRequestGithub, implementation, new FakeReviewer([])), bootstrap };
      await assert.rejects(runIssueCommand(workflow, 'acme/widgets#42', {
        admission: registry,
        runOwnerReceiptPath: path.join(directory, 'owner.json'),
        now: () => T0,
      }), /stop after observing prepared workspace/);
      const run = store.list()[0]!;
      const lane = registry.readLane(`run:${run.id}`)!;
      assert.equal(prepareCalls, 1);
      assert.equal(implementation.observedWorkspace, canonicalWorkspace);
      assert.equal(lane.evidence.workspace, realpathSync(canonicalWorkspace));
      assert.notEqual(lane.evidence.workspace, process.cwd());
      assert.equal(lane.status, 'active', 'uncertain worker execution keeps the exact bound workspace fenced');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('binds a missing logical Run receipt workspace during exact parked recovery after prepared-worktree settlement', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-logical-park-recovery-'));
    try {
      const store = new MemoryStore();
      const canonicalWorkspace = path.join(directory, 'prepared-worktree');
      const workspace = path.join(directory, 'prepared-worktree-alias');
      mkdirSync(canonicalWorkspace);
      symlinkSync(canonicalWorkspace, workspace, 'dir');
      const receiptPath = path.join(directory, 'owner.json');
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'logical-park-recovery-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: admissionConfig });
      const identity = { bootstrapKind: 'linked-worktree' as const, owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: HEAD, branch: 'codex/run-42', workspacePath: workspace };
      let logicalReservationSeen = false;
      let prepareCalls = 0;
      const bootstrap = {
        kind: 'implementation-bootstrap' as const,
        bootstrapKind: 'linked-worktree' as const,
        async plan() {
          const lane = registry.snapshot().lanes.find((candidate) => candidate.laneId.startsWith('run:'));
          assert.ok(lane);
          assert.equal(lane.evidence.workspace, undefined, 'admission is logical before bootstrap planning binds its workspace');
          logicalReservationSeen = true;
          return identity;
        },
        async prepare() {
          prepareCalls += 1;
          return identity;
        },
        guard() { return { assertValid() {} }; },
        async verifyDurable() { return { headSha: HEAD, branch: identity.branch }; },
      };
      const live = githubAdapter([HEAD, HEAD, HEAD, HEAD, HEAD, HEAD, HEAD]);
      const noPullRequestGithub: GitHubAdapter = {
        ...live,
        async readLiveSnapshot(target) {
          const snapshot = await live.readLiveSnapshot(target);
          return { ...snapshot, repository: { ...snapshot.repository, defaultBranch: 'main', defaultBranchHeadSha: HEAD }, pullRequest: null, headSha: null };
        },
      };
      const originalPark = registry.park.bind(registry);
      registry.park = (token, reason, beforePublish) => {
        originalPark(token, reason, beforePublish);
        throw new Error('simulated crash after prepared-workspace park publication');
      };
      const workflow = { ...deps(store, noPullRequestGithub, new FakeImplementation([successResult(HEAD)]), new FakeReviewer([{ verdict: 'approve', reviewerName: 'deepseek', headSha: HEAD, findings: [] }])), bootstrap };
      await assert.rejects(runIssueCommand(workflow, 'acme/widgets#42', { admission: registry, runOwnerReceiptPath: receiptPath, now: () => T0 }), /simulated crash after prepared-workspace park publication/);
      registry.park = originalPark;

      const run = store.list()[0]!;
      const lane = registry.readLane(`run:${run.id}`)!;
      const parkReceipt = readRunOwnerReceipt(receiptPath)!;
      assert.equal(logicalReservationSeen, true, JSON.stringify({ state: run.state, reason: run.interrupt?.evidence, bootstrap: run.bootstrap, receipt: parkReceipt }));
      assert.equal(prepareCalls, 1, JSON.stringify({ state: run.state, reason: run.interrupt?.evidence }));
      assert.equal(run.bootstrap?.workspacePath, workspace);
      assert.equal(lane.evidence.workspace, realpathSync(canonicalWorkspace), 'prepared workspace strengthened the registry lane');
      assert.equal(lane.status, 'parked');
      assert.equal(parkReceipt.phase, 'park_transition', 'the injected crash left the normal park publication receipt');
      assert.equal(parkReceipt.workspace, undefined, 'the logical pre-execution receipt has not yet recorded the later workspace');
      const parkedGeneration = lane.generation;

      writeRunOwnerReceipt(receiptPath, { ...parkReceipt, workspace: path.join(directory, 'wrong-worktree') });
      assert.throws(() => recoverRunAdmission(store, registry, run.id, parkedGeneration, true, receiptPath), /phase and generation/,
        'a receipt that names a conflicting workspace cannot recover this parked lane');
      writeRunOwnerReceipt(receiptPath, { ...parkReceipt, missionId: 'different-mission' });
      assert.throws(() => recoverRunAdmission(store, registry, run.id, parkedGeneration, true, receiptPath), /canonical registry owner/,
        'a receipt with a different mission identity cannot authorize workspace binding');
      writeRunOwnerReceipt(receiptPath, parkReceipt);

      assert.throws(() => recoverRunAdmission(store, registry, run.id, parkedGeneration, true, receiptPath, {
        parkReceiptNormalization: () => { throw new Error('simulated crash after locked workspace binding'); },
      }), /simulated crash after locked workspace binding/);
      assert.equal(registry.readLane(`run:${run.id}`)?.status, 'parked');
      const transitionReceipt = readRunOwnerReceipt(receiptPath)!;
      assert.equal(transitionReceipt.phase, 'parked_release_transition');
      assert.equal(transitionReceipt.workspace, realpathSync(canonicalWorkspace), 'the transition receipt binds canonical W under the exact parked-lane lock');

      const releaseParked = registry.releaseParked.bind(registry);
      registry.releaseParked = (laneId, generation, stopped, beforePublish) => {
        releaseParked(laneId, generation, stopped, beforePublish);
        throw new Error('simulated crash after parked release publication');
      };
      assert.throws(() => recoverRunAdmission(store, registry, run.id, parkedGeneration, true, receiptPath), /simulated crash after parked release publication/);
      registry.releaseParked = releaseParked;
      assert.equal(registry.readLane(`run:${run.id}`)?.status, 'released');
      assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'parked_release_transition');
      assert.equal(recoverRunAdmission(store, registry, run.id, parkedGeneration, true, receiptPath), 'released', 'exact retry finalizes the postpublication receipt');
      const finalReceipt = readRunOwnerReceipt(receiptPath);
      assert.equal(finalReceipt?.phase, 'released');
      assert.equal(finalReceipt?.workspace, realpathSync(canonicalWorkspace));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('binds a missing logical Run workspace on exact active-release retry after publication crash', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-logical-release-recovery-'));
    try {
      const store = new MemoryStore();
      const workspace = path.join(directory, 'prepared-worktree');
      mkdirSync(workspace);
      const receiptPath = path.join(directory, 'owner.json');
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'logical-release-recovery-v1', limits: { maxCaptains: 2, maxWriters: 2, maxHighAutonomy: 2 } };
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: admissionConfig });
      const identity = { bootstrapKind: 'linked-worktree' as const, owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: HEAD, branch: 'codex/run-42', workspacePath: workspace };
      let logicalReservationSeen = false;
      const bootstrap = {
        kind: 'implementation-bootstrap' as const,
        bootstrapKind: 'linked-worktree' as const,
        async plan() {
          const lane = registry.snapshot().lanes.find((candidate) => candidate.laneId.startsWith('run:'));
          assert.ok(lane);
          assert.equal(lane.evidence.workspace, undefined);
          logicalReservationSeen = true;
          return identity;
        },
        async prepare() { return identity; },
        guard() { return { assertValid() {} }; },
        async verifyDurable() { return { headSha: HEAD, branch: identity.branch }; },
      };
      const live = githubAdapter([HEAD, HEAD]);
      const noPullRequestGithub: GitHubAdapter = {
        ...live,
        async readLiveSnapshot(target) {
          const snapshot = await live.readLiveSnapshot(target);
          return { ...snapshot, repository: { ...snapshot.repository, defaultBranch: 'main', defaultBranchHeadSha: HEAD }, pullRequest: null, headSha: null };
        },
      };
      class UncertainImplementation implements ImplementationAgent {
        readonly kind = 'implementation-agent' as const;
        async run(): Promise<AgentResult> { throw new Error('worker stopped with uncertain execution'); }
      }
      await assert.rejects(runIssueCommand({ ...deps(store, noPullRequestGithub, qualifyGovernedFake(new UncertainImplementation()), new FakeReviewer([])), bootstrap },
        'acme/widgets#42', { admission: registry, runOwnerReceiptPath: receiptPath, now: () => T0 }), /worker stopped with uncertain execution/);
      const run = store.list()[0]!;
      const lane = registry.readLane(`run:${run.id}`)!;
      const activeReceipt = readRunOwnerReceipt(receiptPath)!;
      assert.equal(logicalReservationSeen, true);
      assert.equal(run.bootstrap?.workspacePath, workspace);
      assert.equal(lane.status, 'active');
      assert.equal(lane.evidence.workspace, realpathSync(workspace));
      assert.equal(activeReceipt.phase, 'execution_possible');
      assert.equal(activeReceipt.workspace, undefined, 'the execution receipt predates workspace strengthening');

      const originalRelease = registry.release.bind(registry);
      registry.release = (token, stopped, beforePublish) => {
        originalRelease(token, stopped, beforePublish);
        throw new Error('simulated crash after active release publication');
      };
      assert.throws(() => recoverRunAdmission(store, registry, run.id, activeReceipt.generation, true, receiptPath), /simulated crash after active release publication/);
      registry.release = originalRelease;
      assert.equal(registry.readLane(`run:${run.id}`)?.status, 'released');
      const transition = readRunOwnerReceipt(receiptPath)!;
      assert.equal(transition.phase, 'release_transition');
      assert.equal(transition.workspace, undefined, 'the simulated postpublication crash retains the old logical receipt');

      assert.equal(recoverRunAdmission(store, registry, run.id, activeReceipt.generation, true, receiptPath), 'released');
      const finalReceipt = readRunOwnerReceipt(receiptPath);
      assert.equal(finalReceipt?.phase, 'released');
      assert.equal(finalReceipt?.workspace, realpathSync(workspace), 'exact released retry binds persisted canonical W under the registry lock');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('resumes against the persisted workspace instead of the current caller workspace', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-persisted-admission-'));
    try {
      const store = new MemoryStore();
      const canonicalWorkspace = path.join(directory, 'prepared-worktree');
      mkdirSync(canonicalWorkspace);
      let run = createRun(TARGET, T0, 'resume-persisted-workspace');
      run = applyTransition(run, { type: 'start' }, T0);
      run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
      run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
      run = applyTransition(run, { type: 'escalate', reason: 'operator input', interrupt: { evidence: 'decision required', choices: ['A'] } }, T0);
      run = { ...run, bootstrap: { bootstrapKind: 'linked-worktree', owner: 'acme', repo: 'widgets', issueNumber: 42, baseBranch: 'main', baseSha: HEAD, branch: 'codex/run-resume', workspacePath: canonicalWorkspace } };
      store.create(run);
      const registry = new MissionAdmissionRegistry({ filePath: path.join(directory, 'registry.json'), config: { schemaVersion: 1, revision: 'persisted-admission-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } } });
      const receiptPath = path.join(directory, 'owner.json');
      await resumeCommand(deps(store, githubAdapter([HEAD]), new FakeImplementation([]), new FakeReviewer([])), run.id, 'A', {
        admission: registry,
        runOwnerReceiptPath: receiptPath,
        now: () => T0,
      });
      const lane = registry.readLane(`run:${run.id}`)!;
      assert.equal(lane.evidence.workspace, realpathSync(canonicalWorkspace));
      assert.notEqual(lane.evidence.workspace, process.cwd());
    } finally { rmSync(directory, { recursive: true, force: true }); }
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
      await assert.rejects(resumeCommand(workflowDeps, run.id, LIVE_HEAD_SYNC_DECISION, { admission, admissionWorkspace: dir, runOwnerReceiptPath: receiptPath }), /temporary GitHub sync preflight failure/);
      assert.equal(admission.readLane(`run:${run.id}`)?.status, 'released');
      const retried = await resumeCommand(workflowDeps, run.id, LIVE_HEAD_SYNC_DECISION, { admission, admissionWorkspace: dir, runOwnerReceiptPath: receiptPath, now: () => T0 });
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
      assert.equal(admission.readLane(`run:${store.createdId}`), null, 'durable intent failure happens before any reservation');
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
        runIssueCommand(deps(store, githubAdapter([HEAD]), qualifyGovernedFake(new UncertainImplementation([])), new FakeReviewer([])), 'acme/widgets#42', { admission, admissionWorkspace: process.cwd(), runOwnerReceiptPath: path.join(dir, 'run-owner-uncertain.json') }),
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
      await assert.rejects(runIssueCommand(deps(store, githubAdapter([HEAD]), qualifyGovernedFake(new UncertainImplementation([])), new FakeReviewer([])), 'acme/widgets#42', {
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

  it('does not finalize an already-released receipt after a same-lane successor has published', () => {
    const { dir } = tempStore();
    try {
      const runId = 'released-retry-successor';
      const run = createRun(TARGET, T0, runId);
      const store = new MemoryStore(); store.create(run);
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'released-retry-successor-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const registry = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      const receiptPath = path.join(dir, 'owner-receipt.json');
      const workspace = realpathSync(dir);
      const admitted = registry.admit({ laneId: `run:${runId}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') throw new Error('expected Run admission');
      const transition = { schemaVersion: 1 as const, laneId: admitted.token.laneId, missionId: admitted.missionId, repository: 'acme/widgets', runId, issue: 42, workspace, token: admitted.token, generation: admitted.token.generation, phase: 'release_transition' as const };
      writeRunOwnerReceipt(receiptPath, transition);
      registry.release(admitted.token, true);

      const withExactReleasedLane = registry.withExactReleasedLane.bind(registry);
      registry.withExactReleasedLane = (laneId, generation, reconcile) => {
        admitSuccessorWithReceipt(registry, receiptPath, runId, workspace);
        return withExactReleasedLane(laneId, generation, reconcile);
      };
      assert.throws(() => recoverRunAdmission(store, registry, runId, admitted.token.generation, true, receiptPath), /exact released generation/);
      const successorReceipt = readRunOwnerReceipt(receiptPath);
      assert.equal(successorReceipt?.phase, 'pre_execution');
      assert.equal(successorReceipt?.generation, admitted.token.generation + 2);
      assert.equal(registry.readLane(admitted.token.laneId)?.status, 'active');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a competing stale parked recovery from overwriting a successor receipt', () => {
    const { dir } = tempStore();
    try {
      const runId = 'parked-retry-successor';
      const run = createRun(TARGET, T0, runId);
      const store = new MemoryStore(); store.create(run);
      const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'parked-retry-successor-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
      const registry = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
      const receiptPath = path.join(dir, 'owner-receipt.json');
      const workspace = realpathSync(dir);
      const admitted = registry.admit({ laneId: `run:${runId}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace } });
      assert.equal(admitted.outcome, 'admitted');
      if (admitted.outcome !== 'admitted') throw new Error('expected Run admission');
      const parkReceipt = { schemaVersion: 1 as const, laneId: admitted.token.laneId, missionId: admitted.missionId, repository: 'acme/widgets', runId, issue: 42, workspace, token: admitted.token, generation: admitted.token.generation, phase: 'park_transition' as const };
      writeRunOwnerReceipt(receiptPath, parkReceipt);
      registry.park(admitted.token, 'workflow_settled');
      const parkedGeneration = admitted.token.generation + 1;

      const releaseParked = registry.releaseParked.bind(registry);
      registry.releaseParked = (laneId, generation, stopped, beforePublish, afterPublish) => {
        // An earlier recovery wins after this caller's unlocked branch reads,
        // then the lane is readmitted before the stale caller reaches its fence.
        releaseParked(laneId, generation, stopped, () => {
          const { token: _token, ...withoutToken } = parkReceipt;
          writeRunOwnerReceipt(receiptPath, { ...withoutToken, phase: 'parked_release_transition', generation: parkedGeneration });
        });
        admitSuccessorWithReceipt(registry, receiptPath, runId, workspace);
        return releaseParked(laneId, generation, stopped, beforePublish, afterPublish);
      };
      assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), /stale|expected production Run generation/);
      const successorReceipt = readRunOwnerReceipt(receiptPath);
      assert.equal(successorReceipt?.phase, 'pre_execution');
      assert.equal(successorReceipt?.generation, parkedGeneration + 2);
      assert.equal(registry.readLane(admitted.token.laneId)?.status, 'active');
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

  it('recovers a parked Run across each private park-release receipt crash boundary and serializes successor receipts', async () => {
    for (const crashPoint of ['normalize', 'before', 'after', 'finalize', 'successor'] as const) {
      const { dir } = tempStore();
      try {
        const runId = `park-publish-${crashPoint}`;
        let run = createRun(TARGET, T0, runId);
        run = applyTransition(run, { type: 'start' }, T0);
        run = applyTransition(run, { type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD }, T0);
        run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD), pullRequest: { number: 7, headSha: HEAD } }, T0);
        run = applyTransition(run, { type: 'escalate', reason: 'operator input', interrupt: { evidence: 'decision required', choices: ['A'] } }, T0);
        const store = new MemoryStore();
        store.create(run);
        const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: `park-publish-${crashPoint}-v1`, limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
        const registry = new MissionAdmissionRegistry({ filePath: path.join(dir, 'admission.json'), config: admissionConfig });
        const receiptPath = path.join(dir, 'owner-receipt.json');
        const canonicalWorkspace = realpathSync(dir);
        const admitted = registry.admit({ laneId: `run:${runId}`, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace: canonicalWorkspace } });
        assert.equal(admitted.outcome, 'admitted');
        if (admitted.outcome !== 'admitted') throw new Error('expected Run admission');
        const parkReceipt = { schemaVersion: 1 as const, laneId: admitted.token.laneId, missionId: admitted.missionId, repository: 'acme/widgets', runId, issue: 42, workspace: canonicalWorkspace, token: admitted.token, generation: admitted.token.generation, phase: 'park_transition' as const };
        registry.park(admitted.token, 'workflow_wait', () => writeRunOwnerReceipt(receiptPath, parkReceipt));
        const parkedGeneration = admitted.token.generation + 1;
        assert.equal(registry.readLane(admitted.token.laneId)?.generation, parkedGeneration);
        assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'park_transition', 'fixture is the exact postpublication/pre-finalization crash state');
        assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, false, receiptPath), /explicit --stopped/);
        assert.throws(() => recoverRunAdmission(store, registry, runId, admitted.token.generation, true, receiptPath), /phase and generation/,
          'the prior active generation is not the public parked generation');
        const { token: _token, ...tokenlessParkReceipt } = parkReceipt;
        writeRunOwnerReceipt(receiptPath, { ...tokenlessParkReceipt, phase: 'parked', generation: admitted.token.generation });
        assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), /generation/,
          'a tokenless parked receipt at the wrong generation cannot authorize recovery');
        writeRunOwnerReceipt(receiptPath, parkReceipt);

        const releaseParked = registry.releaseParked.bind(registry);
        if (crashPoint === 'before' || crashPoint === 'after') {
          registry.releaseParked = (laneId, generation, stopped, beforePublish) => {
            beforePublish?.(registry.readLane(laneId)!);
            if (crashPoint === 'before') throw new Error('injected crash before parked release publication');
            const result = releaseParked(laneId, generation, stopped);
            throw new Error(`injected crash after parked release publication ${result}`);
          };
        }
        let successorAdmission: Promise<void> | undefined;
        if (crashPoint === 'successor') {
          registry.releaseParked = (laneId, generation, stopped, beforePublish, afterPublish) => releaseParked(laneId, generation, stopped, beforePublish, () => {
            const marker = path.join(dir, 'successor-ready');
            successorAdmission = startSuccessorAdmission(path.join(dir, 'admission.json'), receiptPath, laneId, runId, canonicalWorkspace, marker, admissionConfig);
            waitForMarker(marker);
            afterPublish?.();
          });
        }
        if (crashPoint === 'normalize') {
          assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath, {
            parkReceiptNormalization: () => { throw new Error('injected crash after park receipt normalization'); },
          }), /injected crash after park receipt normalization/);
          assert.equal(registry.readLane(admitted.token.laneId)?.status, 'parked');
          assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'parked_release_transition', 'park receipt normalization and release transition are one locked write');
          assert.equal(readRunOwnerReceipt(receiptPath)?.generation, parkedGeneration);
        } else if (crashPoint === 'finalize') {
          assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath, {
            parkReceiptFinalization: () => { throw new Error('injected crash after park receipt finalization'); },
          }), /injected crash after park receipt finalization/);
          assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released');
          assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'released');
          assert.equal(readRunOwnerReceipt(receiptPath)?.generation, parkedGeneration + 1);
        } else if (crashPoint === 'successor') {
          assert.equal(recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), 'released');
        } else {
          assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), /injected crash/);
        }
        if (crashPoint === 'before') {
          assert.equal(registry.readLane(admitted.token.laneId)?.status, 'parked');
          assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'parked_release_transition');
        } else if (crashPoint === 'after') {
          assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released');
          assert.equal(registry.readLane(admitted.token.laneId)?.generation, parkedGeneration + 1);
          assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'parked_release_transition');
        }
        registry.releaseParked = releaseParked;
        if (successorAdmission !== undefined) await successorAdmission;
        if (crashPoint === 'successor') {
          assert.equal(registry.readLane(admitted.token.laneId)?.status, 'active', 'same-lane successor admits after settlement releases its transaction lock');
          assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'pre_execution', 'the old parked finalizer cannot overwrite the successor receipt');
          assert.equal(readRunOwnerReceipt(receiptPath)?.generation, parkedGeneration + 2);
          continue;
        }
        assert.equal(recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), 'released');
        assert.equal(readRunOwnerReceipt(receiptPath)?.phase, 'released');
        assert.equal(registry.readLane(admitted.token.laneId)?.status, 'released');
        const successor = registry.admit({ laneId: admitted.token.laneId, role: 'production_captain', highAutonomy: true, evidence: { repository: 'acme/widgets', issue: 42, run: runId, workspace: canonicalWorkspace } });
        assert.equal(successor.outcome, 'admitted');
        assert.throws(() => recoverRunAdmission(store, registry, runId, parkedGeneration, true, receiptPath), /does not match expected generation|do not identify the exact recoverable active generation/);
        assert.equal(registry.readLane(admitted.token.laneId)?.status, 'active', 'old recovery cannot release a successor generation');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
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
      assert.match(bad.stderr, /error: Run .* is IMPLEMENTING; only MERGE_READY or an exact merged retry may be reconciled/);
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

  it('retries only a capacity-parked manual lane and preserves the manual checkpoint fence', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-manual-capacity-'));
    const accountHome = path.join(dir, 'account-home');
    const runs = path.join(dir, 'runs');
    mkdirSync(accountHome);
    const preload = path.join(dir, 'account-home-preload.mjs');
    writeFileSync(preload, [
      "import os from 'node:os';",
      'const original = os.userInfo.bind(os);',
      "Object.defineProperty(os, 'userInfo', { configurable: true, value: (...args) => ({ ...original(...args), homedir: process.env.TACHIKO_TEST_ACCOUNT_HOME }) });",
      '',
    ].join('\n'));
    const helper = path.join(dir, 'registry-fixture.mjs');
    const hostRegistryUrl = pathToFileURL(path.join(REPO_ROOT, 'src/mission-admission/host-registry.js')).href;
    writeFileSync(helper, [
      "import { readFileSync, readdirSync, writeFileSync } from 'node:fs';",
      `import { createHostAdmissionRegistry } from ${JSON.stringify(hostRegistryUrl)};`,
      "const registry = createHostAdmissionRegistry();",
      "if (process.argv[2] === 'hold') { const result = registry.admit({ laneId: 'manual-test-capacity-holder', role: 'production_captain', evidence: { repository: 'other/repo', issue: 9 }, highAutonomy: true }); if (result.outcome !== 'admitted') throw new Error('could not create capacity holder'); writeFileSync(process.env.TACHIKO_TEST_TOKEN_PATH, JSON.stringify(result.token)); }",
      "if (process.argv[2] === 'release') { const token = JSON.parse(readFileSync(process.env.TACHIKO_TEST_TOKEN_PATH, 'utf8')); registry.release(token, true); }",
      "if (process.argv[2] === 'checkpoint') { const files = readdirSync(process.env.TACHIKO_MANUAL_OWNER_RECEIPTS_DIR); const receipt = JSON.parse(readFileSync(process.env.TACHIKO_MANUAL_OWNER_RECEIPTS_DIR + '/' + files[0], 'utf8')); registry.parkManual(receipt.token, { worktree: process.cwd(), branch: process.env.TACHIKO_TEST_BRANCH, checkpointSha: process.env.TACHIKO_TEST_HEAD, clean: true, stopped: true }); }",
      '',
    ].join('\n'));
    const admissionConfig = JSON.stringify({ schemaVersion: 1, revision: 'manual-capacity-test-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } });
    const env = {
      ...process.env,
      HOME: path.join(dir, 'ambient-home'),
      TACHIKO_TEST_ACCOUNT_HOME: accountHome,
      TACHIKO_DATA_DIR: runs,
      TACHIKO_MISSION_ADMISSION_CONFIG: admissionConfig,
      TACHIKO_MANUAL_OWNER_RECEIPTS_DIR: path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'manual-receipts'),
      TACHIKO_DISPATCH_LOCK_PATH: path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock'),
      TACHIKO_DISPATCH_ADMISSION_LOCK_PATH: path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock.admission'),
      TACHIKO_TEST_BRANCH: spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(),
      TACHIKO_TEST_HEAD: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(),
      TACHIKO_TEST_TOKEN_PATH: path.join(dir, 'holder-token.json'),
    };
    const invoke = (args: string[]): Promise<CliResult> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
    const fixture = (action: string) => spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', helper, action], { cwd: REPO_ROOT, env, encoding: 'utf8' });
    const registryFile = path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'registry.json');
    const manualArgs = ['dispatch', 'manual', 'register'];
    try {
      assert.equal(fixture('hold').status, 0);
      const firstWait = await invoke(manualArgs);
      assert.equal(firstWait.status, 1);
      assert.match(firstWait.stderr, /parked by capacity_captains/);
      const revisionAfterFirstWait = JSON.parse(readFileSync(registryFile, 'utf8')).revision;
      const secondWait = await invoke(manualArgs);
      assert.equal(secondWait.status, 1);
      assert.match(secondWait.stderr, /parked by capacity_captains/);
      const stateWhileBlocked = JSON.parse(readFileSync(registryFile, 'utf8'));
      assert.equal(stateWhileBlocked.revision, revisionAfterFirstWait, 'repeated capacity denial does not churn the exact parked lane');
      const parkedManual = stateWhileBlocked.lanes.find((lane: { laneId: string }) => lane.laneId.startsWith('manual:'));
      assert.equal(parkedManual.status, 'parked');
      assert.equal(parkedManual.generation, 1);

      const releasedHolder = fixture('release');
      assert.equal(releasedHolder.status, 0, releasedHolder.stderr || releasedHolder.stdout);
      const racing = await Promise.all([invoke(manualArgs), invoke(manualArgs)]);
      assert.equal(racing.filter((result) => result.status === 0).length, 1, 'the admission lock and registry transaction allow one promotion');
      assert.equal(racing.filter((result) => result.status === 1).length, 1);
      const activeState = JSON.parse(readFileSync(registryFile, 'utf8'));
      const activeManual = activeState.lanes.find((lane: { laneId: string }) => lane.laneId.startsWith('manual:'));
      assert.equal(activeManual.status, 'active');
      assert.equal(activeManual.generation, 2);
      assert.ok(existsSync(path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'manual-receipts')));

      assert.equal(fixture('checkpoint').status, 0);
      const checkpointRetry = await invoke(manualArgs);
      assert.equal(checkpointRetry.status, 1);
      assert.match(checkpointRetry.stderr, /manual_checkpoint/);
      const checkpointState = JSON.parse(readFileSync(registryFile, 'utf8'));
      const checkpointManual = checkpointState.lanes.find((lane: { laneId: string }) => lane.laneId.startsWith('manual:'));
      assert.equal(checkpointManual.parkedReason, 'manual_checkpoint');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('production direct CLI serializes concurrent lookup, profile validation, READY create, and capacity reservation', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-direct-cli-admission-'));
    const accountHome = path.join(dir, 'account-home');
    mkdirSync(accountHome);
    const preload = path.join(dir, 'account-home-preload.mjs');
    writeFileSync(preload, [
      "import os from 'node:os';",
      'const original = os.userInfo.bind(os);',
      "Object.defineProperty(os, 'userInfo', { configurable: true, value: (...args) => ({ ...original(...args), homedir: process.env.TACHIKO_TEST_ACCOUNT_HOME }) });",
      '',
    ].join('\n'));
    const helper = path.join(dir, 'registry-fixture.mjs');
    const hostRegistryUrl = pathToFileURL(path.join(REPO_ROOT, 'src/mission-admission/host-registry.js')).href;
    writeFileSync(helper, [
      `import { createHostAdmissionRegistry } from ${JSON.stringify(hostRegistryUrl)};`,
      "const result = createHostAdmissionRegistry().admit({ laneId: 'direct-cli-capacity-holder', role: 'production_captain', evidence: { repository: 'other/repo', issue: 8 }, highAutonomy: true });",
      "if (result.outcome !== 'admitted') throw new Error('could not seed capacity holder');",
      '',
    ].join('\n'));
    const env = {
      ...process.env,
      HOME: path.join(dir, 'ambient-home'),
      TACHIKO_TEST_ACCOUNT_HOME: accountHome,
      TACHIKO_DATA_DIR: path.join(dir, 'runs'),
      TACHIKO_RUN_OWNER_RECEIPTS_DIR: path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'run-receipts'),
      TACHIKO_MISSION_ADMISSION_CONFIG: JSON.stringify({ schemaVersion: 1, revision: 'direct-cli-capacity-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } }),
      TACHIKO_DISPATCH_LOCK_PATH: path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock'),
      TACHIKO_DISPATCH_ADMISSION_LOCK_PATH: path.join(accountHome, '.tachiko-conductor', 'dispatch', 'once.lock.admission'),
      TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify({ revision: 'direct-cli-profile-v1', profiles: { routine: { executor: 'codex-cli', timeoutMs: 1 }, standard: { executor: 'codex-cli', timeoutMs: 2 }, complex: { executor: 'codex-cli', timeoutMs: 3 }, critical: { executor: 'claude-code', timeoutMs: 4 } } }),
    };
    const invoke = (args: string[]): Promise<CliResult> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, '--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
    try {
      const holder = spawnSync(process.execPath, ['--import', preload, '--import', 'tsx', helper], { cwd: REPO_ROOT, env, encoding: 'utf8' });
      assert.equal(holder.status, 0, holder.stderr);
      const args = ['run', 'acme/widgets#42', '--execution-profile', 'standard', '--repair-task-shape-authority', '{"revision":"test-shape-v1","shape":"bounded"}'];
      const callers = await Promise.all([invoke(args), invoke(args)]);
      assert.deepEqual(callers.map((result) => result.status), [1, 1]);
      assert.ok(callers.every((result) => /waiting for mission admission capacity/.test(result.stderr)));
      const listing = await invoke(['run', 'list']);
      assert.equal(listing.status, 0, listing.stderr);
      const rows = listing.stdout.trim().split('\n').filter(Boolean);
      assert.equal(rows.length, 1, 'production CLI lock keeps concurrent callers on one durable Run id');
      assert.match(rows[0]!, /^[a-f0-9-]+\tREADY\t/);

      const registryFile = path.join(accountHome, '.tachiko-conductor', 'mission-admission', 'registry.json');
      const registryBefore = readFileSync(registryFile, 'utf8');
      const divergentReceiptRoot = path.join(dir, 'divergent-run-receipts');
      env.TACHIKO_RUN_OWNER_RECEIPTS_DIR = divergentReceiptRoot;
      const rejected = await invoke(['run', 'acme/widgets#43', '--execution-profile', 'standard', '--repair-task-shape-authority', '{"revision":"test-shape-v1","shape":"bounded"}']);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /TACHIKO_RUN_OWNER_RECEIPTS_DIR must resolve to its canonical per-user private receipt directory/);
      assert.equal(readFileSync(registryFile, 'utf8'), registryBefore, 'divergent receipt root is rejected before registry admission');
      assert.equal(existsSync(divergentReceiptRoot), false);
      const afterReject = await invoke(['run', 'list']);
      assert.equal(afterReject.status, 0, afterReject.stderr);
      assert.equal(afterReject.stdout.trim().split('\n').filter(Boolean).length, 1, 'divergent receipt root is rejected before admission-backed Run creation');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
