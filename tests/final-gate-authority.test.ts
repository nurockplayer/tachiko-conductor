import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import type { ValidationAdapter } from '../src/adapters/validation.js';
import { createRun } from '../src/domain/run.js';
import {
  InvalidTransitionError,
  allowedTransitions,
  applyTransition,
  canTransition,
} from '../src/domain/state-machine.js';
import type { Run } from '../src/domain/types.js';
import type { RunStore } from '../src/store/json-file-store.js';
import { evaluateHostedCheckPolicy } from '../src/validation/hosted-policy.js';
import { runWorkflow } from '../src/workflow/run.js';
import { TARGET, approval, successResult, validationPassed } from './helpers.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

function finalGateRun(id = 'final-gate-authority'): Run {
  let run = createRun(TARGET, T0, id);
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(
    run,
    {
      type: 'agent_succeeded', agentResult: successResult(HEAD), headSha: HEAD,
      pullRequest: { number: 7, headSha: HEAD },
    },
    T0,
  );
  run = applyTransition(run, { type: 'validation_passed', validationResult: validationPassed(HEAD) }, T0);
  return applyTransition(
    run,
    { type: 'review_approved', reviewResult: approval('sol', HEAD) },
    T0,
  );
}

function blockedPendingSnapshot(headSha: string): GitHubLiveSnapshot {
  return {
    repository: {
      owner: TARGET.owner,
      repo: TARGET.repo,
      defaultBranch: 'main',
      defaultBranchHeadSha: 'base',
    },
    issue: {
      id: 'I_42',
      number: TARGET.issueNumber,
      title: 'Fix the widget',
      body: 'DoR-ready.',
      state: 'open',
      url: '',
      createdAt: T0,
      updatedAt: T0,
    },
    pullRequest: {
      id: 'PR_7',
      number: 7,
      title: 'Fix',
      url: '',
      state: 'open',
      isDraft: false,
      mergeable: true,
      mergeStateStatus: 'BLOCKED',
      updatedAt: T0,
      headSha,
      baseSha: 'base',
      headRef: 'tachiko/issue-42-test',
      headRepository: { owner: TARGET.owner, repo: TARGET.repo },
      baseRef: 'main',
    },
    headSha,
    checks: {
      availability: 'available',
      overall: 'pending',
      checks: [{
        id: 'required-ci',
        name: 'required-ci',
        state: 'pending',
        url: null,
        updatedAt: T0,
      }],
    },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: 0 },
    conversations: [],
    handoff: null,
    problems: [],
    observedAt: T0,
  };
}

function readySnapshot(headSha: string): GitHubLiveSnapshot {
  const pending = blockedPendingSnapshot(headSha);
  return {
    ...pending,
    pullRequest: { ...pending.pullRequest!, mergeStateStatus: 'CLEAN' },
    checks: {
      availability: 'available',
      overall: 'passing',
      checks: [{ id: 'required-ci', name: 'required-ci', state: 'passing', url: null, updatedAt: T0 }],
    },
  };
}

function githubReturning(snapshot: GitHubLiveSnapshot): GitHubAdapter {
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
      return snapshot;
    },
  };
}

const unusedImplementation: ImplementationAgent = {
  kind: 'implementation-agent',
  async run() {
    throw new Error('implementation must not run from FINAL_GATE');
  },
};

const unusedReviewer: ReviewerAdapter = {
  kind: 'reviewer',
  async review() {
    throw new Error('reviewer must not run from FINAL_GATE');
  },
};

const existingValidation: ValidationAdapter = {
  kind: 'validation',
  configRevision: 'test-config-v1',
  async validate() {
    throw new Error('validation must not rerun before the pending final-gate wait');
  },
};

describe('final-gate authority', () => {
  it('does not expose a generic transition that can manufacture MERGE_READY', () => {
    // Keep this runtime probe valid even after gate_passed is removed from the
    // public TransitionType union by the architecture rebase.
    const forbidden = 'gate_passed' as never;
    assert.equal(canTransition('FINAL_GATE', forbidden), false);
    assert.equal(allowedTransitions('FINAL_GATE').includes(forbidden), false);

    const finalGate = { ...createRun(TARGET, T0, 'generic-gate'), state: 'FINAL_GATE' as const };
    assert.throws(
      () => applyTransition(finalGate, { type: forbidden }, T0),
      (error: unknown) => error instanceof InvalidTransitionError && error.code === 'unknown-transition',
    );
  });

  it('records readiness only through the reconciled workflow final-gate authority', async () => {
    const store = new MemoryStore();
    const run = finalGateRun('workflow-only-readiness');
    store.create(run);

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(readySnapshot(HEAD)),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(result.run.history.at(-1)?.type, 'final_gate_verified');
  });

  it('parks required pending checks before interpreting a BLOCKED merge state', async () => {
    const store = new MemoryStore();
    const run = finalGateRun();
    store.create(run);

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(blockedPendingSnapshot(HEAD)),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: {
          revision: 'test-hosted-policy-v1',
          policy: { mode: 'required' },
        },
      },
      run.id,
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'waiting_dependency');
    assert.equal(result.run.state, 'WAITING_DEPENDENCY');
    assert.notEqual(result.run.state, 'NEEDS_HUMAN');
    assert.match(result.reason, /waiting for required hosted checks/i);
    assert.equal(result.run.interrupt?.kind, 'waiting_dependency');
  });

  it('fails closed when final merge-state evidence is absent even if every other fact is green', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('merge-state-unavailable'));
    const ready = readySnapshot(HEAD);
    const unavailable = { ...ready, pullRequest: { ...ready.pullRequest!, mergeStateStatus: null } };

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(unavailable),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'merge-state-unavailable',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.notEqual(result.run.state, 'MERGE_READY');
    assert.match(result.reason, /merge state is unavailable/i);
  });

  it('revalidates instead of admitting readiness when policy identity changes during the final live reread', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('final-policy-change'));
    let revision = 'test-config-v1';
    const github: GitHubAdapter = {
      ...githubReturning(readySnapshot(HEAD)),
      async readLiveSnapshot() {
        revision = 'test-config-v2';
        return readySnapshot(HEAD);
      },
    };
    const changingValidation: ValidationAdapter = {
      kind: 'validation',
      get configRevision() { return revision; },
      async validate() { throw new Error('validation must not run from FINAL_GATE'); },
    };

    const result = await runWorkflow(
      {
        store, github, implementation: unusedImplementation, reviewer: unusedReviewer,
        validation: changingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'final-policy-change',
      { maxReviewAttempts: 1, now: () => T0 },
    );
    assert.notEqual(result.outcome, 'merge_ready');
    assert.ok(result.run.history.some((entry) => entry.type === 'revalidate'));
  });

  it('does not infer a hosted policy from a non-empty passing observation', () => {
    assert.equal(
      evaluateHostedCheckPolicy({
        overall: 'passing',
        observedCheckNames: ['required-ci'],
      }),
      'unknown',
    );
  });
});
