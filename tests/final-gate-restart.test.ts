import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import type { ValidationAdapter } from '../src/adapters/validation.js';
import { createRun } from '../src/domain/run.js';
import { applyTransition } from '../src/domain/state-machine.js';
import type { IssueTarget, Run } from '../src/domain/types.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { runWorkflow } from '../src/workflow/run.js';
import { TARGET, approval, successResult, validationPassed } from './helpers.js';

const T0 = '2026-08-14T00:00:00.000Z';
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PR_NUMBER = 7;
const LOCAL_POLICY_REVISION = 'test-config-v1';
const HOSTED_POLICY_REVISION = 'test-hosted-policy-v1';
const REQUIRED_CHECK = 'required-ci';

function liveSnapshot(
  mergeStateStatus: string,
  checkState: 'pending' | 'passing',
  overall: 'pending' | 'passing',
): GitHubLiveSnapshot {
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
      number: PR_NUMBER,
      title: 'Fix',
      url: '',
      state: 'open',
      isDraft: false,
      mergeable: true,
      mergeStateStatus,
      updatedAt: T0,
      headSha: HEAD,
      baseSha: 'base',
      headRef: 'tachiko/issue-42-test',
      headRepository: { owner: TARGET.owner, repo: TARGET.repo },
      baseRef: 'main',
    },
    headSha: HEAD,
    checks: {
      availability: 'available',
      overall,
      checks: [{
        id: REQUIRED_CHECK,
        name: REQUIRED_CHECK,
        state: checkState,
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

class RestartGithub implements GitHubAdapter {
  readonly kind = 'github' as const;
  readonly targets: IssueTarget[] = [];
  private readonly snapshots: GitHubLiveSnapshot[];

  constructor(...snapshots: GitHubLiveSnapshot[]) {
    this.snapshots = [...snapshots];
  }

  async readIssue(): Promise<never> {
    throw new Error('readIssue is not used by FINAL_GATE');
  }

  async readBranch(): Promise<never> {
    throw new Error('readBranch is not used by FINAL_GATE');
  }

  async listPullRequests(): Promise<never> {
    throw new Error('listPullRequests is not used by FINAL_GATE');
  }

  async readLiveSnapshot(target: IssueTarget): Promise<GitHubLiveSnapshot> {
    this.targets.push({ ...target });
    const snapshot = this.snapshots.shift();
    if (snapshot === undefined) throw new Error('No live snapshot queued');
    return snapshot;
  }
}

const noOpImplementation: ImplementationAgent = {
  kind: 'implementation-agent',
  async run() {
    throw new Error('implementation must not run from FINAL_GATE');
  },
};

const noOpReviewer: ReviewerAdapter = {
  kind: 'reviewer',
  async review() {
    throw new Error('reviewer must not run from FINAL_GATE');
  },
};

const configuredValidation: ValidationAdapter = {
  kind: 'validation',
  configRevision: LOCAL_POLICY_REVISION,
  async validate() {
    throw new Error('local validation must not rerun for fresh persisted evidence');
  },
};

function finalGateRun(): Run {
  const validated = validationPassed(HEAD);
  const validation = {
    ...validated,
    local: { ...validated.local, configRevision: LOCAL_POLICY_REVISION },
    hosted: {
      ...validated.hosted,
      policyRevision: HOSTED_POLICY_REVISION,
      policyMode: 'required' as const,
      requiredCheckNames: [REQUIRED_CHECK],
      observedCheckNames: [REQUIRED_CHECK],
    },
  };

  let run = createRun(TARGET, T0, 'final-gate-restart');
  run = applyTransition(run, { type: 'start' }, T0);
  run = applyTransition(
    run,
    {
      type: 'agent_succeeded',
      agentResult: successResult(HEAD),
      headSha: HEAD,
      pullRequest: { number: PR_NUMBER, headSha: HEAD },
    },
    T0,
  );
  run = applyTransition(run, { type: 'validation_passed', validationResult: validation }, T0);
  return applyTransition(run, { type: 'review_approved', reviewResult: approval('sol', HEAD) }, T0);
}

describe('final-gate durable restart proof', () => {
  it('waits durably before BLOCKED merge interpretation, then re-reads the same PR/head/policy and becomes ready', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-final-gate-restart-'));
    try {
      const initialStore = new JsonFileStore({ dir });
      initialStore.create(finalGateRun());

      const github = new RestartGithub(
        liveSnapshot('BLOCKED', 'pending', 'pending'),
        liveSnapshot('CLEAN', 'passing', 'passing'),
      );
      const dependencies = {
        store: initialStore,
        github,
        implementation: noOpImplementation,
        reviewer: noOpReviewer,
        validation: configuredValidation,
        hostedCheckPolicy: {
          revision: HOSTED_POLICY_REVISION,
          policy: { mode: 'required' as const, requiredCheckNames: [REQUIRED_CHECK] },
        },
      };

      const waiting = await runWorkflow(
        dependencies,
        'final-gate-restart',
        { maxReviewAttempts: 1, now: () => T0 },
      );

      assert.equal(waiting.outcome, 'waiting_dependency');
      assert.equal(waiting.run.state, 'WAITING_DEPENDENCY');
      assert.equal(waiting.run.interruptedFrom, 'FINAL_GATE');
      assert.match(waiting.reason, /waiting for required hosted checks/i);
      // The required check is pending, so mergeStateStatus BLOCKED must not be
      // interpreted as a human-facing merge blocker yet.
      assert.notEqual(waiting.run.state, 'NEEDS_HUMAN');
      assert.equal(waiting.run.validationResult?.headSha, HEAD);
      assert.equal(waiting.run.validationResult?.hosted.pullRequestNumber, PR_NUMBER);
      assert.equal(waiting.run.validationResult?.hosted.policyRevision, HOSTED_POLICY_REVISION);
      assert.equal(waiting.run.validationResult?.hosted.policyMode, 'required');

      // process 2: restart from the durable WAITING_DEPENDENCY snapshot,
      // explicitly satisfy the dependency, and persist the resumable state.
      const restartedStore = new JsonFileStore({ dir });
      const persisted = restartedStore.read('final-gate-restart');
      assert.equal(persisted?.state, 'WAITING_DEPENDENCY');
      assert.equal(persisted?.interruptedFrom, 'FINAL_GATE');
      const resumed = applyTransition(
        persisted!,
        { type: 'dependency_satisfied', reason: 'Retry readiness checks' },
        T0,
      );
      assert.equal(resumed.state, 'FINAL_GATE');
      assert.equal(resumed.interruptedFrom, undefined);
      restartedStore.update(resumed);

      // process 3: the fresh store re-reads the exact persisted identities;
      // only then may the dedicated workflow final gate inspect settled checks.
      const finalStore = new JsonFileStore({ dir });
      const finalRun = finalStore.read('final-gate-restart');
      assert.equal(finalRun?.state, 'FINAL_GATE');
      assert.equal(finalRun?.headSha, HEAD);
      assert.equal(finalRun?.validationResult?.headSha, HEAD);
      assert.equal(finalRun?.validationResult?.hosted.pullRequestNumber, PR_NUMBER);
      assert.equal(finalRun?.validationResult?.hosted.policyRevision, HOSTED_POLICY_REVISION);

      const result = await runWorkflow(
        { ...dependencies, store: finalStore },
        'final-gate-restart',
        { maxReviewAttempts: 1, now: () => T0 },
      );

      assert.equal(result.outcome, 'merge_ready');
      assert.equal(result.run.state, 'MERGE_READY');
      assert.equal(result.run.headSha, HEAD);
      assert.equal(result.run.validationResult?.hosted.pullRequestNumber, PR_NUMBER);
      assert.equal(result.run.validationResult?.hosted.policyRevision, HOSTED_POLICY_REVISION);
      assert.equal(result.run.history.at(-1)?.type, 'final_gate_verified');
      assert.equal(github.targets.length, 2);
      assert.deepEqual(github.targets.map((target) => target.issueNumber), [TARGET.issueNumber, TARGET.issueNumber]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
