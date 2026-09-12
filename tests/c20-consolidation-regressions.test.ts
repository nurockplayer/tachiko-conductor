import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import type { HostedCheckPolicyConfiguration, ValidationAdapter, ValidationRequest } from '../src/adapters/validation.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { AgentResult, LocalValidationEvidence, Run } from '../src/domain/types.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { runWorkflow } from '../src/workflow/run.js';
import { T0, TARGET, successResult, validationFailed, validationPassed } from './helpers.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function liveSnapshot(headSha: string): GitHubLiveSnapshot {
  return {
    repository: { owner: TARGET.owner, repo: TARGET.repo, defaultBranch: 'main', defaultBranchHeadSha: 'base' },
    issue: { id: 'I_42', number: TARGET.issueNumber, title: 'Repair validation', body: 'Original issue instructions.', state: 'open', url: '', createdAt: T0, updatedAt: T0 },
    pullRequest: {
      id: 'PR_7', number: 7, title: 'Repair validation', url: '', state: 'open', isDraft: false,
      mergeable: true, mergeStateStatus: 'CLEAN', updatedAt: T0, headSha, baseSha: 'base',
      headRef: 'issue-42', headRepository: { owner: TARGET.owner, repo: TARGET.repo }, baseRef: 'main',
    },
    headSha,
    checks: { availability: 'available', overall: 'passing', checks: [{ id: 'ci', name: 'ci', state: 'passing', url: null, updatedAt: T0 }] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
    conversations: [], handoff: null, problems: [], observedAt: T0,
  };
}

class QueuedGitHub implements GitHubAdapter {
  readonly kind = 'github' as const;
  readonly reads: string[] = [];

  constructor(private readonly snapshots: GitHubLiveSnapshot[]) {}

  async readIssue(): Promise<never> { throw new Error('unused'); }
  async readBranch(): Promise<never> { throw new Error('unused'); }
  async listPullRequests(): Promise<never> { throw new Error('unused'); }
  async readLiveSnapshot() {
    const next = this.snapshots.shift();
    if (next === undefined) throw new Error('No queued live snapshot.');
    this.reads.push(next.headSha ?? '(none)');
    return next;
  }
}

class CapturingImplementation implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  readonly requests: ImplementationRequest[] = [];

  async run(request: ImplementationRequest): Promise<AgentResult> {
    this.requests.push(request);
    return successResult(NEXT_HEAD, 'validation repair');
  }
}

class RecordingJsonStore implements RunStore {
  readonly name = 'recording-json-file';
  readonly updates: Run[] = [];

  constructor(private readonly store: JsonFileStore) {}

  create(run: Run): void { this.store.create(run); }
  read(id: string): Run | null { return this.store.read(id); }
  update(run: Run): void { this.updates.push(run); this.store.update(run); }
  list(): Run[] { return this.store.list(); }
  delete(id: string): void { this.store.delete(id); }
}

const unusedReviewer: ReviewerAdapter = {
  kind: 'reviewer',
  async review() { throw new Error('reviewer must not run'); },
};

function validationRepairRun(id: string): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(run, {
    type: 'agent_succeeded', headSha: HEAD,
    agentResult: { ...successResult(HEAD), sessionId: 'validation-session', executor: { provider: 'codex-cli', sessionId: 'validation-thread' } },
    pullRequest: { number: 7, headSha: HEAD },
  }, T0);
  run = applyTransition(run, {
    type: 'validation_failed', validationResult: validationFailed(HEAD),
  }, T0);
  return applyTransition(run, { type: 'start_fix' }, T0);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('C20 consolidation regressions', () => {
  it('F02 does not treat read-compatible legacy gate_passed state as current merge readiness', async () => {
    const dir = tempDir('tachiko-c20-f02-');
    const legacy: Run = {
      ...createRun(TARGET, T0, 'legacy-gate'), state: 'MERGE_READY',
      history: [{ type: 'gate_passed', from: 'FINAL_GATE', to: 'MERGE_READY', at: T0 }],
    };
    const file = path.join(dir, 'legacy-gate.json');
    const bytes = `${JSON.stringify(legacy)}\n`;
    writeFileSync(file, bytes, 'utf8');
    const store = new JsonFileStore({ dir });
    assert.deepEqual(store.read(legacy.id), legacy);
    assert.equal(readFileSync(file, 'utf8'), bytes);

    const result = await runWorkflow(
      { store, github: new QueuedGitHub([]), implementation: new CapturingImplementation(), reviewer: unusedReviewer },
      legacy.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.notEqual(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
  });

  it('F03 resumes a validation-failure repair from a fresh JsonFileStore at the failing HEAD with repair intent', async () => {
    const dir = tempDir('tachiko-c20-f03-');
    new JsonFileStore({ dir }).create(validationRepairRun('validation-restart'));
    const implementation = new CapturingImplementation();

    const result = await runWorkflow(
      {
        store: new JsonFileStore({ dir }), github: new QueuedGitHub([liveSnapshot(HEAD), liveSnapshot(NEXT_HEAD), liveSnapshot(NEXT_HEAD)]),
        implementation, reviewer: unusedReviewer,
      },
      'validation-restart',
      { maxReviewAttempts: 2, now: () => T0 },
    );

    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(implementation.requests.length, 1);
    assert.equal(implementation.requests[0]?.baseSha, HEAD);
    assert.match(implementation.requests[0]?.instructions ?? '', /Exact-HEAD validation failed/);
    assert.doesNotMatch(implementation.requests[0]?.instructions ?? '', /Original issue instructions/);
    assert.equal(implementation.requests[0]?.sessionId, 'validation-session');
    assert.deepEqual(implementation.requests[0]?.executor, { provider: 'codex-cli', sessionId: 'validation-thread' });
    const persisted = new JsonFileStore({ dir }).read('validation-restart');
    assert.equal(persisted?.history.filter((entry) => entry.type === 'start_fix').length, 1);
    assert.deepEqual(persisted?.pullRequest, { number: 7, headSha: NEXT_HEAD });
  });

  it('F06 rereads changed live authority after awaited validation before admitting evidence', async () => {
    const dir = tempDir('tachiko-c20-f06-');
    let run = createRun(TARGET, T0, 'validation-authority-drift');
    run = applyTransition(run, { type: 'start' }, T0);
    run = applyTransition(run, {
      type: 'agent_succeeded', headSha: HEAD, agentResult: successResult(HEAD), pullRequest: { number: 7, headSha: HEAD },
    }, T0);
    new JsonFileStore({ dir }).create(run);

    let localRevision = 'local-v1';
    const validation: ValidationAdapter = {
      kind: 'validation',
      get configRevision() { return localRevision; },
      async validate(request: ValidationRequest): Promise<LocalValidationEvidence> {
        await Promise.resolve();
        localRevision = 'local-v2';
        return { ...validationPassed(request.headSha).local, configRevision: 'local-v1' };
      },
    };
    const hostedCheckPolicy: HostedCheckPolicyConfiguration = { revision: 'hosted-v1', policy: { mode: 'required' } };
    const github = new QueuedGitHub([liveSnapshot(HEAD), liveSnapshot(HEAD)]);
    const store = new RecordingJsonStore(new JsonFileStore({ dir }));

    const result = await runWorkflow(
      { store, github, implementation: new CapturingImplementation(), reviewer: unusedReviewer, validation, hostedCheckPolicy },
      'validation-authority-drift',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.notEqual(result.run.state, 'REVIEWING');
    assert.equal(result.run.state, 'NEEDS_HUMAN');
    assert.equal(github.reads.length, 1);
    assert.equal(store.updates.some((run) => run.state === 'REVIEWING'), false);
    assert.equal(new JsonFileStore({ dir }).read('validation-authority-drift')?.state, 'NEEDS_HUMAN');
  });
});
