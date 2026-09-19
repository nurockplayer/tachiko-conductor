import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { GitHubAdapter } from '../src/adapters/github.js';
import { OracleReviewer, OracleReviewerError } from '../src/oracle/reviewer.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import type { OracleReceipt, OracleReviewTransport } from '../src/oracle/types.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const target = { kind: 'repository' as const, owner: 'acme', repo: 'widgets', branch: 'feature' };

function github(heads: string[]): GitHubAdapter {
  let index = 0;
  return {
    kind: 'github',
    async readIssue() { throw new Error('unused'); },
    async listPullRequests() { throw new Error('unused'); },
    async readLiveSnapshot() { throw new Error('unused'); },
    async readBranch() {
      const headSha = heads[Math.min(index++, heads.length - 1)];
      if (headSha === undefined) throw new Error('missing head');
      return { target, headSha, pullRequestNumbers: [7] };
    },
  };
}

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ verdict: 'PASS', reviewed_head_sha: HEAD, blocking_findings: [], non_blocking_suggestions: [], ...overrides });
}

function transport(output: string): OracleReviewTransport { return { async consult() { return { outcome: 'success', output }; } }; }

describe('OracleReviewer', () => {
  it('returns a bounded exact-HEAD review and writes a compact receipt', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-'));
    try {
      const receipts = new JsonFileOracleReceiptStore(dir);
      const reviewer = new OracleReviewer({ github: github([HEAD, HEAD]), transport: transport(response()), receipts, now: () => '2026-09-20T00:00:00.000Z' });
      const result = await reviewer.review({ target, headSha: HEAD, instructions: 'Review safely.' });
      assert.deepEqual(result, { verdict: 'approve', reviewerName: 'oracle', headSha: HEAD, findings: [] });
      assert.deepEqual(receipts.list()[0], {
        id: 'oracle-acme-widgets-feature-aaaaaaaaaaaa-60920000000000', target, requestedHeadSha: HEAD,
        observedHeadSha: HEAD, outcome: 'approved', reviewedAt: '2026-09-20T00:00:00.000Z', blockingFindingCount: 0, nonBlockingFindingCount: 0,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('records and rejects a HEAD movement around transport', async () => {
    const records: OracleReceipt[] = [];
    const reviewer = new OracleReviewer({ github: github([HEAD, OTHER]), transport: transport(response()), receipts: { record: (receipt) => records.push(receipt), list: () => records } });
    await assert.rejects(() => reviewer.review({ target, headSha: HEAD }), (error: unknown) => error instanceof OracleReviewerError && error.code === 'ORACLE_STALE_HEAD');
    assert.equal(records[0]?.outcome, 'stale_head');
    assert.equal(records[0]?.observedHeadSha, OTHER);
  });

  it('rejects unknown output fields and never records it as an approval', async () => {
    const records: OracleReceipt[] = [];
    const reviewer = new OracleReviewer({ github: github([HEAD, HEAD]), transport: transport(response({ extra: 'secret' })), receipts: { record: (receipt) => records.push(receipt), list: () => records } });
    await assert.rejects(() => reviewer.review({ target, headSha: HEAD }), (error: unknown) => error instanceof OracleReviewerError && error.code === 'ORACLE_INVALID_OUTPUT');
    assert.equal(records.length, 0);
  });
});
