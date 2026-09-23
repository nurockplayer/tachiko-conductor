import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { dispatchOnce, runtimeClaimFromBody } from '../src/dispatch/runner.js';
import { dispatchOnceCommand } from '../src/dispatch/command.js';
import { parseDispatchConfiguration } from '../src/dispatch/config.js';
import type { GitHubAdapter, IssueSnapshot, PullRequestSnapshot } from '../src/adapters/github.js';
import { createRun } from '../src/domain/run.js';
import type { Run } from '../src/domain/types.js';
import type { RunStore } from '../src/store/json-file-store.js';
import { JsonFileStore } from '../src/store/json-file-store.js';
import { MissionAdmissionRegistry, type AdmissionConfig } from '../src/mission-admission/registry.js';
import { runIssueCommand } from '../src/cli.js';
import type { WorkflowDependencies } from '../src/workflow/run.js';
import { LiveGitHubAdapter } from '../src/github/live-state.js';
import type { GitHubApiTransport } from '../src/github/transport.js';

const T0 = '2026-09-15T00:00:00.000Z';
const QUEUE = `${DISPATCH_QUEUE_MARKER}
ready:
  - issue: 18
    route: codex
    profile: complex
  - issue: 19
    route: codex
    profile: standard`;
const DISPATCH_AUTHORITY = { revision: 'task-shape-v1', shape: 'interacting' } as const;

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

/** Issue #19 timeline points at an unrelated open PR #33 that only mentions it. */
class IncidentalCrossReferenceTransport implements GitHubApiTransport {
  async get(path: string): Promise<unknown> {
    if (path === 'repos/acme/widgets/issues/19') {
      return {
        node_id: 'I_19', number: 19, title: 'queued', body: '', state: 'open',
        html_url: 'https://github.test/acme/widgets/issues/19', created_at: T0, updated_at: T0,
      };
    }
    if (path === 'repos/acme/widgets/pulls/33') {
      return {
        node_id: 'PR_33', number: 33, title: 'Unrelated', body: 'Discussed alongside #19.', state: 'open',
        draft: false, html_url: 'https://github.test/acme/widgets/pull/33', mergeable: true,
        mergeable_state: 'clean', updated_at: T0, merged_at: null,
        head: { sha: 'head-33' }, base: { sha: 'base-33' },
      };
    }
    if (path === 'repos/acme/widgets') return { default_branch: 'main' };
    if (path === 'repos/acme/widgets/commits/main') return { sha: 'main-head' };
    throw new Error(`No fixture for ${path}`);
  }

  async getPaginated(path: string): Promise<readonly unknown[]> {
    if (path === 'repos/acme/widgets/issues/19/timeline') {
      return [{
        event: 'cross-referenced',
        source: { issue: { number: 33, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/33' } } },
      }];
    }
    if (path === 'repos/acme/widgets/issues/19/comments') return [];
    throw new Error(`No fixture for ${path}`);
  }

  async graphql(): Promise<unknown> {
    return {
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    };
  }
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
    store.create(createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'run-18', undefined, 'claim-1'));
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

  it('refreshes a running claim while execution remains active', async () => {
    const runtime = new Comments();
    let complete: ((execution: { runId: string; state: 'IMPLEMENTING' }) => void) | undefined;
    const pending = dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store: new MemoryStore(), runtime,
      leaseDurationMs: 20, now: () => T0, createClaimId: () => 'claim-1',
      async execute() {
        return await new Promise<{ runId: string; state: 'IMPLEMENTING' }>((resolve) => { complete = resolve; });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(selectDispatchRuntime(runtime.comments)?.claim.state, 'running');
    assert.ok(runtime.updates > 1, 'expected at least one periodic heartbeat after execution started');
    complete?.({ runId: 'run-18', state: 'IMPLEMENTING' });
    await pending;
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

  it('does not treat an incidental open PR cross-reference as an active writer', async () => {
    const result = await dispatchOnce({
      queueBody: `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 19\n    route: codex\n    profile: standard`,
      owner: 'acme', repo: 'widgets', store: new MemoryStore(), runtime: new Comments(),
      github: new LiveGitHubAdapter({ transport: new IncidentalCrossReferenceTransport(), now: () => T0 }),
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'claim-1',
      async execute(entry) { return { runId: `run-${entry.issue}`, state: 'IMPLEMENTING' }; },
    });

    assert.equal(result.outcome, 'dispatched');
    if (result.outcome !== 'dispatched') throw new Error('expected Codex dispatch');
    assert.equal(result.entry.issue, 19);
  });

  it('keeps duplicate-writer protection fail-closed when association proof is unavailable', async () => {
    const base = new IncidentalCrossReferenceTransport();
    const transport: GitHubApiTransport = {
      get: (path) => base.get(path),
      getPaginated: (path) => base.getPaginated(path),
    };
    const result = await dispatchOnce({
      queueBody: `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 19\n    route: codex\n    profile: standard`,
      owner: 'acme', repo: 'widgets', store: new MemoryStore(), runtime: new Comments(),
      github: new LiveGitHubAdapter({ transport, now: () => T0 }),
      leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('must fail closed before execution'); },
    });

    assert.deepEqual(result, {
      outcome: 'no_eligible_work',
      reasons: ['#19: an associated pull request is already open'],
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
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'done', undefined, 'old-claim'), state: 'FAILED' as const };
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

  it('retires an absent terminal claim so an identical later re-dispatch creates fresh work', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'done', undefined, 'old-claim'), state: 'FAILED' as const };
    store.create(terminal);
    runtime.comments.push({
      id: 'comment-1',
      body: renderDispatchRuntime({
        issue: 18, claimId: 'old-claim', runId: terminal.id, profile: 'complex', state: 'failed',
        claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
      }),
    });
    const empty = `${DISPATCH_QUEUE_MARKER}\nready:`;
    assert.deepEqual(await dispatchOnce({
      queueBody: empty, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('terminal run must not execute'); },
    }), { outcome: 'no_eligible_work', reasons: [] });

    let existing: Run | null | undefined;
    const result = await dispatchOnce({
      queueBody: `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: complex`,
      owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime,
      leaseDurationMs: 60_000, now: () => T0, createClaimId: () => 'retry-claim',
      async execute(_entry, prior) { existing = prior; return { runId: 'retry-run', state: 'IMPLEMENTING' }; },
    });
    assert.equal(existing, null);
    assert.equal(result.outcome, 'dispatched');
    if (result.outcome !== 'dispatched') throw new Error('expected fresh re-dispatch');
    assert.equal(result.claim.claimId, 'retry-claim');
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
    const claimed = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'claimed-run', undefined, 'claim-1');
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

  it('fails closed when a retained Run ID is bound to a different dispatch claim', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const mismatched = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'mismatched', undefined, 'other-claim');
    store.create(mismatched);
    runtime.comments.push({ id: 'comment-1', body: renderDispatchRuntime({
      issue: 18, claimId: 'claim-1', runId: mismatched.id, profile: 'complex', state: 'claimed',
      claimedAt: T0, heartbeatAt: T0, leaseUntil: '2026-09-15T00:01:00.000Z',
    }) });
    await assert.rejects(dispatchOnce({
      queueBody: QUEUE, owner: 'acme', repo: 'widgets', github: new GitHub(), store, runtime, leaseDurationMs: 60_000, now: () => T0,
      async execute() { throw new Error('mismatched Run must not execute'); },
    }), /differently claimed durable run/);
  });

  it('reconciles a terminal durable Run to its retained runtime claim after a crash window', async () => {
    const runtime = new Comments();
    const store = new MemoryStore();
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'terminal', undefined, 'claim-1'), state: 'FAILED' as const };
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
    const terminal = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'terminal', undefined, 'claim-1'), state: 'FAILED' as const };
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
      const settled = { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, `settled-${state.toLowerCase()}`, undefined, 'claim-1'), state };
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
    const existing = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'existing', execution, 'claim-1');
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
    const runtime = new CommandRuntime(`${DISPATCH_QUEUE_MARKER}
ready:
  - issue: 18
    route: codex
    profile: complex
    task-shape-revision: task-shape-v1
    task-shape: interacting`);
    const store = new MemoryStore();
    const selected = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const received: Array<{ ref: string; profile: string; claimId: string; authority: unknown }> = [];
    await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
      workflow: { store, github: new GitHub() } as unknown as WorkflowDependencies,
      runtime,
      resolveExecutionProfile: (profile) => {
        assert.equal(profile, 'complex');
        return selected;
      },
      runIssue: async (ref, execution, claimId, authority) => {
        received.push({ ref, profile: execution?.profile ?? '', claimId, authority });
        return { outcome: 'needs_human', run: { ...createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'new-run', selected, claimId), state: 'NEEDS_HUMAN' as const }, reason: 'parked for test' };
      },
      resumeClaimedRun: async () => { throw new Error('must create, not resume'); },
      now: () => T0,
    });
    assert.equal(received.length, 1);
    assert.equal(received[0]?.ref, 'acme/widgets#18');
    assert.equal(received[0]?.profile, 'complex');
    assert.equal(received[0]?.claimId, parseDispatchRuntime(runtime.comments[0]!.body)?.claimId);
    assert.deepEqual(received[0]?.authority, { revision: 'task-shape-v1', shape: 'interacting' });
  });

  it('keeps one claim-bound READY Run through capacity denial and restart, then admits that exact Run after capacity frees', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-admission-'));
    const queue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: complex\n    task-shape-revision: task-shape-v1\n    task-shape: interacting`;
    const execution = { profile: 'complex' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const admissionConfig: AdmissionConfig = { schemaVersion: 1, revision: 'dispatch-admission-v1', limits: { maxCaptains: 1, maxWriters: 1, maxHighAutonomy: 1 } };
    const storeDir = path.join(directory, 'runs');
    const registryPath = path.join(directory, 'host', 'admission.json');
    const claimRegistry = () => new MissionAdmissionRegistry({ filePath: registryPath, config: admissionConfig });
    try {
      const store = new JsonFileStore({ dir: storeDir });
      const admission = claimRegistry();
      const capacityHolder = admission.admit({ laneId: 'capacity-holder', role: 'production_captain', evidence: { repository: 'acme/widgets', issue: 19 } });
      assert.equal(capacityHolder.outcome, 'admitted');
      if (capacityHolder.outcome !== 'admitted') throw new Error('expected capacity holder');

      let modelCalls = 0;
      const workflow = {
        store,
        github: new GitHub(),
        implementation: { provider: 'codex-cli', async run() { modelCalls += 1; throw new Error('model must not run in the capacity wait'); } },
        reviewer: { name: 'reviewer', async review() { throw new Error('review must not run'); } },
      } as unknown as WorkflowDependencies;
      const runtime = new CommandRuntime(queue);
      const first = await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
        workflow, runtime, admission,
        resolveExecutionProfile: () => execution,
        runIssue: async (ref, selected, claimId, authority, registry) => await runIssueCommand(workflow, ref, { execution: selected, dispatchClaimId: claimId, repairTaskShapeAuthority: authority, admission: registry }),
        resumeClaimedRun: async (run, claimId, registry) => {
          if (run.target.kind !== 'issue') throw new Error('expected issue run');
          return await runIssueCommand(workflow, `acme/widgets#${run.target.issueNumber}`, {
            ...(run.execution === undefined ? {} : { execution: run.execution }), dispatchClaimId: claimId,
            ...(run.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: run.repairTaskShapeAuthority }), admission: registry,
          });
        },
        now: () => T0,
      });
      assert.equal(first.outcome, 'admission_wait');
      if (first.outcome !== 'admission_wait') throw new Error('expected typed capacity wait');
      assert.equal(first.waitKind, 'capacity');
      assert.equal(first.admission?.revision, admission.snapshot().revision);
      assert.equal(first.admission?.role, 'production_captain');
      assert.equal(first.admission?.result, 'parked');
      assert.deepEqual(first.admission?.counts, { captains: 1, writers: 1, highAutonomy: 0, parked: 1 });
      assert.equal(JSON.stringify(first.admission).includes('token'), false, 'admission wait telemetry must not contain capability tokens');
      assert.equal(JSON.stringify(first.admission).includes('workspace'), false, 'admission wait telemetry must not contain physical paths');
      assert.equal(first.claim.state, 'claimed');
      assert.ok(first.claim.runId);
      assert.equal(store.list().length, 1);
      const firstRun = store.read(first.claim.runId!)!;
      assert.equal(firstRun.state, 'READY');
      assert.equal(firstRun.dispatchClaimId, first.claim.claimId);
      assert.deepEqual(firstRun.execution, execution);
      assert.deepEqual(firstRun.repairTaskShapeAuthority, DISPATCH_AUTHORITY);
      assert.equal(modelCalls, 0);

      const serializedClaim = runtime.comments[0]!.body;
      const restartedRuntime = new CommandRuntime(queue);
      restartedRuntime.comments.push({ ...runtime.comments[0]! });
      const restartedStore = new JsonFileStore({ dir: storeDir });
      const restartedAdmission = claimRegistry();
      const parkedRevision = restartedAdmission.snapshot().revision;
      const repeated = await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
        workflow: { ...workflow, store: restartedStore }, runtime: restartedRuntime, admission: restartedAdmission,
        resolveExecutionProfile: () => { throw new Error('must use durable execution snapshot'); },
        runIssue: async () => { throw new Error('claim has a durable Run'); },
        resumeClaimedRun: async (run, claimId, registry) => {
          if (run.target.kind !== 'issue') throw new Error('expected issue run');
          return await runIssueCommand({ ...workflow, store: restartedStore }, `acme/widgets#${run.target.issueNumber}`, {
            ...(run.execution === undefined ? {} : { execution: run.execution }), dispatchClaimId: claimId,
            ...(run.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: run.repairTaskShapeAuthority }), admission: registry,
          });
        },
        now: () => T0,
      });
      assert.equal(repeated.outcome, 'admission_wait');
      if (repeated.outcome !== 'admission_wait') throw new Error('expected typed repeat wait');
      assert.equal(repeated.runId, firstRun.id);
      assert.equal(repeated.claim.claimId, first.claim.claimId);
      assert.equal(restartedStore.list().length, 1);
      assert.equal(restartedStore.read(firstRun.id)?.state, 'READY');
      assert.equal(restartedAdmission.snapshot().revision, parkedRevision);
      assert.equal(runtimeClaimFromBody(serializedClaim)?.runId, firstRun.id);
      assert.equal(modelCalls, 0);

      restartedAdmission.release(capacityHolder.token, true);
      const admitted = await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
        workflow: { ...workflow, store: restartedStore }, runtime: restartedRuntime, admission: restartedAdmission,
        resolveExecutionProfile: () => { throw new Error('must use durable execution snapshot'); },
        runIssue: async () => { throw new Error('must resume the existing claim-bound Run'); },
        resumeClaimedRun: async (run, claimId, registry) => {
          if (run.target.kind !== 'issue') throw new Error('expected issue run');
          return await runIssueCommand({ ...workflow, store: restartedStore }, `acme/widgets#${run.target.issueNumber}`, {
            ...(run.execution === undefined ? {} : { execution: run.execution }), dispatchClaimId: claimId,
            ...(run.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: run.repairTaskShapeAuthority }), admission: registry,
          });
        },
        now: () => T0,
      });
      assert.equal(admitted.outcome, 'dispatched');
      if (admitted.outcome !== 'dispatched') throw new Error('expected admitted execution');
      assert.equal(admitted.claim.runId, firstRun.id);
      assert.equal(admitted.claim.claimId, first.claim.claimId);
      assert.equal(restartedStore.list().length, 1);
      assert.equal(restartedStore.read(firstRun.id)?.state, 'NEEDS_HUMAN');
      assert.equal(restartedAdmission.readLane(`run:${firstRun.id}`)?.status, 'parked');
      assert.equal(modelCalls, 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('returns typed owner wait for a known repository-wide manual owner without invoking workflow providers', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-dispatch-manual-owner-'));
    const queue = `${DISPATCH_QUEUE_MARKER}\nready:\n  - issue: 18\n    route: codex\n    profile: complex\n    task-shape-revision: task-shape-v1\n    task-shape: interacting`;
    const config: AdmissionConfig = { schemaVersion: 1, revision: 'manual-owner-wait-v1', limits: { maxCaptains: 2, maxWriters: 1, maxHighAutonomy: 1 } };
    try {
      const store = new JsonFileStore({ dir: path.join(directory, 'runs') });
      const admission = new MissionAdmissionRegistry({ filePath: path.join(directory, 'host', 'admission.json'), config });
      const owner = admission.admit({ laneId: 'manual:owner', role: 'production_captain', evidence: { repository: 'acme/widgets', repositoryScope: true, workspace: path.join(directory, 'manual') } });
      assert.equal(owner.outcome, 'admitted');
      const workflow = { store, github: new GitHub(), implementation: { async run() { throw new Error('implementation must not run'); } }, reviewer: {} } as unknown as WorkflowDependencies;
      const runtime = new CommandRuntime(queue);
      const waiting = await dispatchOnceCommand({ revision: 'dispatch-v1', owner: 'acme', repo: 'widgets', controlIssue: 1, queueCommentId: 2, leaseDurationMs: 60_000 }, {
        workflow, runtime, admission,
        resolveExecutionProfile: () => ({ profile: 'complex', revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 }),
        runIssue: async (ref, execution, claimId, authority, registry) => await runIssueCommand(workflow, ref, { execution, dispatchClaimId: claimId, repairTaskShapeAuthority: authority, admission: registry }),
        resumeClaimedRun: async (run, claimId, registry) => {
          if (run.target.kind !== 'issue') throw new Error('expected issue run');
          return await runIssueCommand(workflow, `acme/widgets#${run.target.issueNumber}`, {
            ...(run.execution === undefined ? {} : { execution: run.execution }), dispatchClaimId: claimId,
            ...(run.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: run.repairTaskShapeAuthority }), admission: registry,
          });
        },
        now: () => T0,
      });
      assert.equal(waiting.outcome, 'admission_wait');
      if (waiting.outcome !== 'admission_wait') throw new Error('expected typed owner wait');
      assert.equal(waiting.waitKind, 'owner');
      assert.equal(waiting.claim.runId, store.list()[0]?.id);
      assert.equal(store.list()[0]?.state, 'READY');
      assert.equal(admission.readLane('manual:owner')?.status, 'active');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects recovery when the durable profile and retained claim disagree', async () => {
    const runtime = new CommandRuntime(QUEUE);
    const store = new MemoryStore();
    const execution = { profile: 'standard' as const, revision: 'profiles-v1', executor: 'codex-cli', timeoutMs: 1 };
    const existing = createRun({ kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 18 }, T0, 'existing', execution, 'claim-1');
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
