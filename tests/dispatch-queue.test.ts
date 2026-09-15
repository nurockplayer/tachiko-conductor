import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DISPATCH_QUEUE_MARKER,
  DispatchProtocolError,
  claimDispatchEntry,
  parseDispatchQueue,
  parseDispatchRuntime,
  renderDispatchRuntime,
  selectDispatchRuntime,
  type DispatchRuntimeComment,
} from '../src/dispatch/queue.js';
import { dispatchOnce } from '../src/dispatch/runner.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import type { GitHubAdapter, IssueSnapshot, PullRequestSnapshot } from '../src/adapters/github.js';
import { createRun } from '../src/domain/run.js';
import type { Run } from '../src/domain/types.js';
import type { RunStore } from '../src/store/json-file-store.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';

const T0 = '2026-09-15T00:00:00.000Z';
const QUEUE = `${DISPATCH_QUEUE_MARKER}
ready:
  - issue: 18
    route: codex
    profile: complex
  - issue: 19
    route: codex
    profile: standard`;

class Comments {
  readonly comments: DispatchRuntimeComment[] = [];
  updates = 0;
  private serial = 0;
  async listRuntimeComments(): Promise<readonly DispatchRuntimeComment[]> { return [...this.comments]; }
  async createRuntimeComment(body: string): Promise<DispatchRuntimeComment> {
    const comment = { id: `comment-${++this.serial}`, body };
    this.comments.push(comment);
    return comment;
  }
  async updateRuntimeComment(id: string, body: string): Promise<DispatchRuntimeComment> {
    this.updates += 1;
    const index = this.comments.findIndex((comment) => comment.id === id);
    if (index < 0) throw new Error('missing comment');
    const comment = { id, body };
    this.comments[index] = comment;
    return comment;
  }
}

class CommandRuntime extends Comments {
  constructor(private readonly queue: string) { super(); }
  async readQueueComment(): Promise<string> { return this.queue; }
}

class MemoryStore implements RunStore {
  readonly name = 'memory';
  readonly values: Run[] = [];
  create(run: Run): void { this.values.push(run); }
  read(id: string): Run | null { return this.values.find((run) => run.id === id) ?? null; }
  update(run: Run): void { const index = this.values.findIndex((value) => value.id === run.id); this.values[index] = run; }
  list(): Run[] { return [...this.values]; }
  delete(): void { throw new Error('unused'); }
}

class GitHub implements GitHubAdapter {
  readonly kind = 'github' as const;
  constructor(private readonly issueState: 'open' | 'closed' = 'open', private readonly pulls: readonly PullRequestSnapshot[] = []) {}
  async readIssue(target: IssueSnapshot['target']): Promise<IssueSnapshot> { return { target, title: 'queued', body: '', state: this.issueState }; }
  async readBranch(): Promise<never> { throw new Error('unused'); }
  async listPullRequests(): Promise<readonly PullRequestSnapshot[]> { return this.pulls; }
  async readLiveSnapshot(): Promise<never> { throw new Error('unused'); }
}

describe('dispatch queue protocol', () => {
  it('requires one explicit, revisioned control location and lease', () => {
    const raw = JSON.stringify({
      revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 9, queueCommentId: 10, leaseDurationMs: 60_000,
    });
    assert.deepEqual(parseDispatchConfiguration(raw), {
      revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 9, queueCommentId: 10, leaseDurationMs: 60_000,
    });
    assert.throws(() => parseDispatchConfiguration(JSON.stringify({ owner: 'acme' })), /exactly/);
    assert.throws(() => parseDispatchConfiguration(JSON.stringify({
      revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 0, queueCommentId: 10, leaseDurationMs: 60_000,
    })), /controlIssue/);
  });

  it('parses only complete, uniquely identified Codex queue records', () => {
    assert.deepEqual(parseDispatchQueue(QUEUE), [
      { issue: 18, route: 'codex', profile: 'complex' },
      { issue: 19, route: 'codex', profile: 'standard' },
    ]);
    assert.deepEqual(parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: human\n    profile: standard`), [
      { issue: 18, route: 'human', profile: 'standard' },
    ]);
    assert.throws(() => parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: unknown\n    profile: standard`), DispatchProtocolError);
    assert.throws(() => parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex`), DispatchProtocolError);
    assert.throws(() => parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: standard\n    profile: complex`), DispatchProtocolError);
    assert.throws(() => parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: standard\n  - issue: 18\n    route: codex\n    profile: complex`), DispatchProtocolError);
    assert.throws(() => parseDispatchQueue(`${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: complexx`), /unsupported execution profile/);
  });

  it('round-trips only the complete runtime schema', () => {
    const body = renderDispatchRuntime({
      issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
      claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
    });
    assert.deepEqual(parseDispatchRuntime(body), {
      issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
      claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
    });
    assert.throws(() => parseDispatchRuntime(body.replace('"state": "claimed"', '"state": "claimed", "unsafe": true')), DispatchProtocolError);
  });

  it('writes then rereads the exact sole claim before returning ownership', async () => {
    const comments = new Comments();
    const claimed = await claimDispatchEntry(comments, parseDispatchQueue(QUEUE)[0]!, {
      now: () => T0, leaseDurationMs: 60_000, createClaimId: () => 'claim-1',
    });
    assert.equal(claimed.commentId, 'comment-1');
    assert.deepEqual(claimed.claim, {
      issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
      claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
    });
    await assert.rejects(
      claimDispatchEntry(comments, parseDispatchQueue(QUEUE)[1]!, { now: () => T0, leaseDurationMs: 60_000 }),
      DispatchProtocolError,
    );
  });

  it('fails closed on duplicate or malformed marked runtime comments', () => {
    assert.throws(() => selectDispatchRuntime([
      { id: 'one', body: '<!-- issue-dispatch-runtime:v1 --> bad' },
    ]), DispatchProtocolError);
    assert.throws(() => selectDispatchRuntime([
      { id: 'one', body: '<!-- issue-dispatch-runtime:v1 --> bad' },
      { id: 'two', body: '<!-- issue-dispatch-runtime:v1 --> bad' },
    ]), DispatchProtocolError);
  });

  it('checks live Issue, open PR, and persisted Run identity before claiming only the first eligible item', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const result = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'claim-1',
      async execute(entry) { return { runId: `run-${entry.issue}`, state: 'IMPLEMENTING' }; },
    });
    assert.deepEqual(result, {
      outcome: 'dispatched', entry: { issue: 18, route: 'codex', profile: 'complex' },
      claim: {
        issue: 18, claimId: 'claim-1', runId: 'run-18', profile: 'complex', state: 'running',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      },
      execution: { runId: 'run-18', state: 'IMPLEMENTING' },
    });
    store.create(createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'run-18'));
    const alreadyClaimed = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0, async execute(entry) { return { runId: `run-${entry.issue}`, state: 'VALIDATING' }; },
    });
    assert.equal(alreadyClaimed.outcome, 'dispatched');
    if (alreadyClaimed.outcome !== 'dispatched') throw new Error('expected resumed dispatch');
    assert.equal(alreadyClaimed.claim.state, 'running');

    const blocked = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub('closed'), store: new MemoryStore(), runtime: new Comments(),
      leaseDurationMs: 60_000, now: () => T0, async execute() { throw new Error('must not execute'); },
    });
    assert.deepEqual(blocked, { outcome: 'no_eligible_work', reasons: ['#18: Issue is closed', '#19: Issue is closed'] });
  });

  it('does not claim a queued Issue with an active durable run or pull request', async () => {
    const store = new MemoryStore();
    store.create(createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'existing'));
    const result = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', store, runtime: new Comments(), github: new GitHub('open', [{ number: 99, headSha: 'head', baseSha: 'base', state: 'open' }]),
      leaseDurationMs: 60_000, now: () => T0, async execute() { throw new Error('must not execute'); },
    });
    assert.deepEqual(result, {
      outcome: 'no_eligible_work',
      reasons: ['#18: existing durable run existing is READY', '#19: an associated pull request is already open'],
    });
  });

  it('leaves human, Work, and ChatGPT entries unclaimed while continuing to a later Codex entry', async () => {
    const result = await dispatchOnce({
      queueBody: `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 7\n    route: human\n    profile: standard\n  - issue: 8\n    route: work\n    profile: standard\n  - issue: 9\n    route: chatgpt\n    profile: standard\n  - issue: 18\n    route: codex\n    profile: complex`,
      owner: 'acme', repo: 'widgets', store: new MemoryStore(), runtime: new Comments(), github: new GitHub(),
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'claim-1',
      async execute(entry) { return { runId: `run-${entry.issue}`, state: 'IMPLEMENTING' }; },
    });
    assert.equal(result.outcome, 'dispatched');
    if (result.outcome !== 'dispatched') throw new Error('expected Codex dispatch');
    assert.equal(result.entry.issue, 18);
  });

  it('never re-executes a terminal claim and safely supersedes it after its queue entry is removed', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'done'), state: 'FAILED' as const };
    store.create(terminal);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'old-claim', runId: terminal.id, profile: 'complex', state: 'failed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    const queue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 19\n    route: codex\n    profile: standard`;
    const result = await dispatchOnce({
      queueBody: queue, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'new-claim',
      async execute(entry) { return { runId: `run-${entry.issue}`, state: 'IMPLEMENTING' }; },
    });
    assert.deepEqual(result, {
      outcome: 'dispatched', entry: { issue: 19, route: 'codex', profile: 'standard' },
      claim: {
        issue: 19, claimId: 'new-claim', runId: 'run-19', profile: 'standard', state: 'running',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      },
      execution: { runId: 'run-19', state: 'IMPLEMENTING' },
    });
  });

  it('creates fresh durable work when a terminal Issue is explicitly re-dispatched', async () => {
    const store = new MemoryStore();
    store.create({ ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'old-terminal'), state: 'FAILED' });
    let received: Run | null | undefined;
    await dispatchOnce({
      queueBody: `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: complex`,
      owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime: new Comments(),
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'fresh-claim',
      async execute(_entry, existing) { received = existing; return { runId: 'fresh-run', state: 'IMPLEMENTING' }; },
    });
    assert.equal(received, null);
    assert.equal(store.read('old-terminal')?.state, 'FAILED');
  });

  it('recovers only the durable Run named by a retained claim', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    store.create({ ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'old-terminal'), state: 'FAILED' });
    const claimed = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'claimed-run');
    store.create(claimed);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: claimed.id, profile: 'complex', state: 'running',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    let received: Run | null | undefined;
    await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0,
      async execute(_entry, existing) { received = existing; return { runId: claimed.id, state: 'IMPLEMENTING' }; },
    });
    assert.equal(received?.id, claimed.id);
  });

  it('reconciles a terminal durable Run to its retained runtime claim after a crash window', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'terminal'), state: 'FAILED' as const };
    store.create(terminal);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: terminal.id, profile: 'complex', state: 'running',
        claimedAt: T0, heartbeatAt: '2026-09-14T23:59:00.000Z', leaseUntil: T0,
      }),
    });
    const result = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('terminal run must not execute'); },
    });
    assert.deepEqual(result, {
      outcome: 'existing_claim',
      claim: {
        issue: 18, claimId: 'claim-1', runId: terminal.id, profile: 'complex', state: 'failed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      },
    });
  });

  it('fails closed when an unbound claim names multiple durable Runs', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    store.create({ ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'first', undefined, 'claim-1'), state: 'FAILED' });
    const duringClaim = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'second', undefined, 'claim-1'), state: 'FAILED' as const };
    store.create(duringClaim);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    await assert.rejects(
      dispatchOnce({
        queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
        leaseDurationMs: 60_000, now: () => T0,
        async execute() { throw new Error('unbound terminal run must not execute'); },
      }),
      /names multiple durable runs/,
    );
  });

  it('reconciles the one claim-bound terminal Run without re-executing it', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, '2026-09-15T00:00:00.001Z', 'during-claim', undefined, 'claim-1'), state: 'FAILED' as const };
    store.create(terminal);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    const result = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('unbound terminal run must not execute'); },
    });
    assert.deepEqual(result, {
      outcome: 'existing_claim',
      claim: {
        issue: 18, claimId: 'claim-1', runId: terminal.id, profile: 'complex', state: 'failed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      },
    });
  });

  it('refuses to adopt a later unrelated terminal Run for an unbound claim', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    store.create({ ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, '2026-09-15T00:00:00.001Z', 'manual-terminal'), state: 'FAILED' });
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: null, profile: 'complex', state: 'claimed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    await assert.rejects(
      dispatchOnce({
        queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
        leaseDurationMs: 60_000, now: () => T0,
        async execute() { throw new Error('must not adopt an unrelated terminal run'); },
      }),
      /cannot prove ownership of a later durable run/,
    );
  });

  it('does not rewrite an already reconciled terminal claim on a settled wake', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'terminal'), state: 'FAILED' as const };
    store.create(terminal);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: terminal.id, profile: 'complex', state: 'failed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    const result = await dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('terminal run must not execute'); },
    });
    assert.equal(result.outcome, 'existing_claim');
    assert.equal(runtime.updates, 0);
  });

  for (const state of ['MERGE_READY', 'NEEDS_HUMAN', 'WAITING_DEPENDENCY'] as const) {
    it(`does not rewrite an already reconciled ${state} claim on a settled wake`, async () => {
      const runtime = new Comments();
      const store = new MemoryStore();
      const settled = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, `settled-${state.toLowerCase()}`), state };
      store.create(settled);
      runtime.comments.push({
        id: 'comment-1',
        body: renderDispatchRuntime({
          issue: 18, claimId: 'claim-1', runId: settled.id, profile: 'complex',
          state: state === 'MERGE_READY' ? 'merge_ready' : 'needs_human',
          claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
        }),
      });
      const result = await dispatchOnce({
        queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
        leaseDurationMs: 60_000, now: () => T0,
        async execute() { throw new Error('settled run must not execute'); },
      });
      assert.equal(result.outcome, 'existing_claim');
      assert.equal(runtime.updates, 0);
    });
  }

  it('resumes a claimed run from its durable profile when current profile config is unavailable', async () => {
    const runtime = new CommandRuntime(QUEUE);
    const store = new MemoryStore();
    const execution = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const existing = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'existing', execution);
    store.create(existing);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: existing.id, profile: 'complex', state: 'running',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    const executions: unknown[] = [];
    await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
      workflow: { store, github: new GitHub() } as unknown as WorkflowDependencies,
      runtime,
      resolveExecutionProfile: () => { throw new Error('must not resolve current profile configuration'); },
      runIssue: async () => { throw new Error('must not start a new claimed run'); },
      resumeClaimedRun: async (run) => {
        assert.equal(run.id, existing.id);
        executions.push(undefined);
        return { outcome: 'needs_human', run: { ...existing, state: 'NEEDS_HUMAN' }, reason: 'parked for test' };
      },
      now: () => T0,
    });
    assert.deepEqual(executions, [undefined]);
  });

  it('passes the immutable claim id when creating a new dispatched run', async () => {
    const runtime = new CommandRuntime(QUEUE);
    const store = new MemoryStore();
    const selected = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const received: Array<{ ref: string; profile: string; claimId: string }> = [];
    await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
      workflow: { store, github: new GitHub() } as unknown as WorkflowDependencies,
      runtime,
      resolveExecutionProfile: (profile) => {
        assert.equal(profile, 'complex');
        return selected;
      },
      runIssue: async (ref, execution, claimId) => {
        received.push({ ref, profile: execution?.profile ?? '', claimId });
        return { outcome: 'needs_human', run: { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'new-run', selected, claimId), state: 'NEEDS_HUMAN' as const }, reason: 'parked for test' };
      },
      resumeClaimedRun: async () => { throw new Error('must create, not resume'); },
      now: () => T0,
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.ref, 'acme/widgets#18');
    assert.equal(received[0]?.profile, 'complex');
    assert.equal(received[0]?.claimId, parseDispatchRuntime(runtime.comments[0]!.body)?.claimId);
  });

  it('rejects recovery when the durable profile and retained claim disagree', async () => {
    const runtime = new CommandRuntime(QUEUE);
    const store = new MemoryStore();
    const execution = { profile: 'standard' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const existing = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'existing', execution);
    store.create(existing);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'claim-1', runId: existing.id, profile: 'complex', state: 'running',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    await assert.rejects(
      dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
        workflow: { store, github: new GitHub() } as unknown as WorkflowDependencies,
        runtime,
        resolveExecutionProfile: () => { throw new Error('must not resolve current profile configuration'); },
        runIssue: async () => { throw new Error('must not resume an inconsistent claim'); },
        resumeClaimedRun: async () => { throw new Error('must not resume an inconsistent claim'); },
        now: () => T0,
      }),
      /profile does not match the retained dispatch claim/,
    );
  });
});
