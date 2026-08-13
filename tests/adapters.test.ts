import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { GitHubAdapter, IssueSnapshot, PullRequestSnapshot } from '../src/adapters/github.js';
import type { ImplementationAgent, ImplementationRequest } from '../src/adapters/agent.js';
import type { ReviewerAdapter, ReviewRequest } from '../src/adapters/reviewer.js';
import { JsonFileStore, type RunStore } from '../src/store/json-file-store.js';
import { TARGET, approval, newRun } from './helpers.js';

describe('adapter boundaries are typed and testable', () => {
  it('accepts a stub GitHub adapter implementing the interface', async () => {
    const github: GitHubAdapter = {
      kind: 'github',
      async readIssue(target) {
        const snapshot: IssueSnapshot = {
          target,
          title: 'Fix the widget',
          body: 'DoR-ready.',
          state: 'open',
        };
        return snapshot;
      },
      async listPullRequests() {
        const prs: readonly PullRequestSnapshot[] = [];
        return prs;
      },
    };
    const snapshot = await github.readIssue(TARGET);
    assert.equal(snapshot.title, 'Fix the widget');
    assert.equal(snapshot.state, 'open');
    assert.deepEqual(await github.listPullRequests(TARGET), []);
  });

  it('accepts a stub implementation agent', async () => {
    const agent: ImplementationAgent = {
      kind: 'implementation-agent',
      async run(request: ImplementationRequest) {
        return { exitStatus: 'success', summary: 'done', headSha: request.baseSha };
      },
    };
    const result = await agent.run({ target: TARGET, baseSha: 'sha-1' });
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.headSha, 'sha-1');
  });

  it('accepts a stub reviewer bound to an exact HEAD SHA', async () => {
    const reviewer: ReviewerAdapter = {
      kind: 'reviewer',
      async review(request: ReviewRequest) {
        return approval('reviewer-1', request.headSha);
      },
    };
    const result = await reviewer.review({ target: TARGET, headSha: 'sha-2' });
    assert.equal(result.headSha, 'sha-2');
    assert.equal(result.verdict, 'approve');
  });

  it('exposes JsonFileStore as a RunStore', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-adapters-'));
    try {
      const store: RunStore = new JsonFileStore({ dir });
      assert.equal(store.name, 'json-file');
      store.create(newRun('a1'));
      assert.equal(store.read('a1')?.state, 'READY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
