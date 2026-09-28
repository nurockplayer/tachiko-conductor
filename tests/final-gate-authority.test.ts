import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ImplementationAgent } from '../src/adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from '../src/adapters/github.js';
import type { ReviewerAdapter } from '../src/adapters/reviewer.js';
import type { ValidationAdapter } from '../src/adapters/validation.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import type { GitHubApiTransport } from '../src/github/transport.js';
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
import { TARGET, TEST_VALIDATION_AUTHORITY, approval, successResult, validationPassed } from './helpers.js';

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
    TEST_VALIDATION_AUTHORITY,
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

function rawGitHubTransport(options: { readonly reviews?: readonly unknown[]; readonly draft?: unknown; readonly omitDraft?: boolean }): GitHubApiTransport {
  let pullReads = 0;
  const pull = {
    node_id: 'PR_7', number: 7, title: 'Fix', body: 'Closes #42', state: 'open',
    ...(options.omitDraft ? {} : { draft: Object.hasOwn(options, 'draft') ? options.draft : false }),
    html_url: 'https://github.test/acme/widgets/pull/7', mergeable: true, mergeable_state: 'clean',
    updated_at: T0, merged_at: null, head: { sha: HEAD }, base: { sha: 'base' },
  };
  return {
    async get(path) {
      if (path === 'repos/acme/widgets/issues/42') return {
        node_id: 'I_42', number: 42, title: 'Fix', body: 'DoR-ready.', state: 'open',
        html_url: 'https://github.test/acme/widgets/issues/42', created_at: T0, updated_at: T0,
      };
      if (path === 'repos/acme/widgets/pulls/7') { pullReads += 1; return pull; }
      if (path.endsWith('/status')) return { state: 'success', statuses: [] };
      if (path.endsWith('/check-runs')) return { total_count: 1, check_runs: [{ id: 1, name: 'required-ci', status: 'completed', conclusion: 'success', html_url: 'https://github.test/checks/1', completed_at: T0 }] };
      throw new Error(`Unexpected raw GitHub GET ${path} (PR reads ${pullReads})`);
    },
    async getPaginated(path) {
      if (path === 'repos/acme/widgets/issues/42/timeline') return [{
        event: 'cross-referenced', source: { issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/7' } } },
      }];
      if (path === 'repos/acme/widgets/pulls/7/reviews') return options.reviews ?? [];
      if (path.endsWith('/comments')) return [];
      throw new Error(`Unexpected raw GitHub collection ${path}`);
    },
    async graphql() {
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } };
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

  it('passes a raw LiveGitHubAdapter final gate with valid draft and named approval evidence', async () => {
    const store = new MemoryStore();
    const run = finalGateRun('raw-github-valid-final-gate');
    store.create(run);
    const result = await runWorkflow({
      store,
      github: new LiveGitHubAdapter({ transport: rawGitHubTransport({ reviews: [{
        node_id: 'R_RAW_APPROVED', user: { login: 'sol' }, state: 'APPROVED', commit_id: HEAD,
        submitted_at: '2026-08-14T02:00:00.000Z', html_url: 'https://github.test/reviews/approved',
      }] }), now: () => T0 }),
      implementation: unusedImplementation,
      reviewer: unusedReviewer,
      validation: existingValidation,
      hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
    }, run.id, { maxReviewAttempts: 1, now: () => T0 });

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(result.run.history.at(-1)?.type, 'final_gate_verified');
  });

  it('never records final-gate readiness from raw unidentified or malformed GitHub review evidence', async (t) => {
    const nullAuthorChanges = {
      node_id: 'R_NULL_CHANGES', user: null, state: 'CHANGES_REQUESTED', commit_id: HEAD,
      submitted_at: '2026-08-14T01:00:00.000Z', html_url: 'https://github.test/reviews/null-changes',
    };
    const nullAuthorApproval = {
      node_id: 'R_NULL_APPROVED', user: null, state: 'APPROVED', commit_id: HEAD,
      submitted_at: '2026-08-14T02:00:00.000Z', html_url: 'https://github.test/reviews/null-approved',
    };
    const cases: Array<{ readonly name: string; readonly transport: GitHubApiTransport }> = [
      { name: 'null-author changes then approval', transport: rawGitHubTransport({ reviews: [nullAuthorChanges, nullAuthorApproval] }) },
      { name: 'null-author approval then changes', transport: rawGitHubTransport({ reviews: [nullAuthorApproval, nullAuthorChanges] }) },
      { name: 'missing draft', transport: rawGitHubTransport({ omitDraft: true }) },
      { name: 'null draft', transport: rawGitHubTransport({ draft: null }) },
      { name: 'string draft', transport: rawGitHubTransport({ draft: 'false' }) },
      { name: 'number draft', transport: rawGitHubTransport({ draft: 0 }) },
      ...[
        { name: 'missing', value: undefined, omit: true },
        { name: 'null', value: null },
        { name: 'empty', value: '' },
        { name: 'whitespace', value: '   ' },
        { name: 'non-string', value: 123 },
      ].map(({ name, value, omit }) => {
        const review: Record<string, unknown> = {
          node_id: `R_BAD_TIME_${name}`, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', commit_id: HEAD,
          html_url: 'https://github.test/reviews/bad-time',
        };
        if (!omit) review.submitted_at = value;
        return { name: `${name} submitted_at`, transport: rawGitHubTransport({ reviews: [review] }) };
      }),
    ];
    for (const { name, transport } of cases) {
      await t.test(name, async () => {
        const store = new MemoryStore();
        const run = finalGateRun(`raw-github-final-gate-${name.replaceAll(' ', '-')}`);
        store.create(run);
        const result = await runWorkflow({
          store,
          github: new LiveGitHubAdapter({ transport, now: () => T0 }),
          implementation: unusedImplementation,
          reviewer: unusedReviewer,
          validation: existingValidation,
          hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
        }, run.id, { maxReviewAttempts: 1, now: () => T0 });
        assert.notEqual(result.outcome, 'merge_ready');
        assert.notEqual(result.run.state, 'MERGE_READY');
        assert.equal(result.run.history.some((entry) => entry.type === 'final_gate_verified'), false);
      });
    }
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

  it('F06 gives policy revalidation a fresh independent-review attempt', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('final-policy-fresh-review'));
    let revision = 'test-config-v1';
    const github: GitHubAdapter = {
      ...githubReturning(readySnapshot(HEAD)),
      async readLiveSnapshot() {
        revision = 'test-config-v2';
        return readySnapshot(HEAD);
      },
    };
    const validation: ValidationAdapter = {
      kind: 'validation',
      get configRevision() { return revision; },
      async validate(request) {
        return { ...validationPassed(request.headSha).local, configRevision: 'test-config-v2' };
      },
    };
    let reviewerCalls = 0;
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review(request) {
        reviewerCalls += 1;
        return approval('fresh-policy-review', request.headSha);
      },
    };

    const result = await runWorkflow(
      {
        store,
        github,
        implementation: unusedImplementation,
        reviewer,
        validation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'final-policy-fresh-review',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
    assert.equal(reviewerCalls, 1);
    assert.equal(result.run.history.filter((entry) => entry.type === 'revalidate').length, 1);
  });

  it('fails closed on a current-HEAD GitHub change request even when no review thread is unresolved', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('current-head-change-request'));
    const ready = readySnapshot(HEAD);
    const blocked: GitHubLiveSnapshot = {
      ...ready,
      reviews: {
        decision: 'changes_requested',
        latestByAuthor: [{
          id: 'R_BLOCK',
          author: 'review-bot',
          state: 'changes_requested',
          commitSha: HEAD,
          submittedAt: T0,
          url: 'https://github.test/reviews/block',
          fresh: true,
        }],
        unresolvedThreads: 0,
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(blocked),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'current-head-change-request',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.notEqual(result.run.state, 'MERGE_READY');
    assert.match(result.reason, /current HEAD explicitly requests changes/i);
  });

  it('fails closed when a GitHub change request has unknown commit provenance', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('unknown-provenance-change-request'));
    const ready = readySnapshot(HEAD);
    const blocked: GitHubLiveSnapshot = {
      ...ready,
      reviews: {
        decision: 'changes_requested',
        latestByAuthor: [{
          id: 'R_UNKNOWN',
          author: 'review-bot',
          state: 'changes_requested',
          commitSha: null,
          submittedAt: T0,
          url: 'https://github.test/reviews/unknown',
          fresh: false,
        }],
        unresolvedThreads: 0,
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(blocked),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'unknown-provenance-change-request',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'needs_human');
    assert.notEqual(result.run.state, 'MERGE_READY');
    assert.match(result.reason, /commit provenance is unavailable/i);
  });

  it('does not let a stale GitHub change request on an older HEAD block a valid current candidate', async () => {
    const store = new MemoryStore();
    store.create(finalGateRun('stale-change-request'));
    const ready = readySnapshot(HEAD);
    const stale: GitHubLiveSnapshot = {
      ...ready,
      reviews: {
        decision: 'changes_requested',
        latestByAuthor: [{
          id: 'R_STALE',
          author: 'review-bot',
          state: 'changes_requested',
          commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          submittedAt: T0,
          url: 'https://github.test/reviews/stale',
          fresh: false,
        }],
        unresolvedThreads: 0,
      },
    };

    const result = await runWorkflow(
      {
        store,
        github: githubReturning(stale),
        implementation: unusedImplementation,
        reviewer: unusedReviewer,
        validation: existingValidation,
        hostedCheckPolicy: { revision: 'test-hosted-policy-v1', policy: { mode: 'required' } },
      },
      'stale-change-request',
      { maxReviewAttempts: 1, now: () => T0 },
    );

    assert.equal(result.outcome, 'merge_ready');
    assert.equal(result.run.state, 'MERGE_READY');
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
