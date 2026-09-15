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
  private serial = 0;
  async listRuntimeComments(): Promise<readonly DispatchRuntimeComment[]> { return [...this.comments]; }
  async createRuntimeComment(body: string): Promise<DispatchRuntimeComment> {
    const comment = { id: `comment-${++this.serial}`, body };
    this.comments.push(comment);
    return comment;
  }
  async updateRuntimeComment(id: string, body: string): Promise<DispatchRuntimeComment> {
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
      runIssue: async (_ref, selected) => {
        executions.push(selected);
        return { outcome: 'needs_human', run: { ...existing, state: 'NEEDS_HUMAN' }, reason: 'parked for test' };
      },
      now: () => T0,
    });
    assert.deepEqual(executions, [undefined]);
  });
});
