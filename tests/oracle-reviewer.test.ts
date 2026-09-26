import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { GitHubAdapter, GitHubLiveSnapshot, PullRequestSnapshot } from '../src/adapters/github.js';
import { OracleReviewer, OracleReviewerError } from '../src/oracle/reviewer.js';
import { JsonFileOracleReceiptStore } from '../src/oracle/receipt-store.js';
import type { OracleReceipt, OracleReviewTransport, OracleTransportRequest, OracleTransportResult } from '../src/oracle/types.js';
import { canonicalReviewTarget, type ReviewRiskEvidence } from '../src/reviewers/risk-policy.js';

const HEAD = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_BASE = 'd'.repeat(40);
const target = { kind: 'repository' as const, owner: 'acme', repo: 'widgets', branch: 'feature' };
const issueTarget = { kind: 'issue' as const, owner: 'acme', repo: 'widgets', issueNumber: 42 };
const changedPaths = ['src/feature.ts'];
const binding = { bindingId: 'oracle-test-v1', model: 'oracle-reviewed-model', supportedEfforts: ['Medium', 'High', 'Extra High'] as const, independentReadOnly: true as const, available: true as const };

function evidence(overrides: Partial<ReviewRiskEvidence> = {}): ReviewRiskEvidence {
  return { target, headSha: HEAD, baseSha: BASE, changedPaths, manifestComplete: true, deterministicValidation: { passed: true, headSha: HEAD, baseSha: BASE }, riskSignals: [], riskEvidenceComplete: true, ...overrides };
}

function github(heads: string[], bases: string[] = [BASE], branchTarget: typeof target = target): GitHubAdapter {
  let index = 0;
  const pr = (headSha: string, baseSha: string): PullRequestSnapshot => ({ number: 7, headSha, baseSha, state: 'open' });
  return {
    kind: 'github', async readIssue() { throw new Error('unused'); },
    async listPullRequests() { const n = Math.min(Math.max(0, index - 1), heads.length - 1); return [pr(heads[n]!, bases[Math.min(n, bases.length - 1)]!)]; },
    async readLiveSnapshot() { throw new Error('unused'); },
    async readBranch() { const n = Math.min(index++, heads.length - 1); return { target: branchTarget, headSha: heads[n]!, pullRequestNumbers: [7] }; },
  };
}

function githubAssociations(numbers: number[], pullRequests: PullRequestSnapshot[], branchTarget: typeof target = target): GitHubAdapter {
  return { kind: 'github', async readIssue() { throw new Error('unused'); }, async listPullRequests() { return pullRequests; }, async readLiveSnapshot() { throw new Error('unused'); }, async readBranch() { return { target: branchTarget, headSha: HEAD, pullRequestNumbers: numbers }; } };
}

function issueSnapshot(overrides: Record<string, unknown> = {}): GitHubLiveSnapshot {
  return {
    repository: { owner: issueTarget.owner, repo: issueTarget.repo, defaultBranch: 'main', defaultBranchHeadSha: BASE },
    issue: { id: 'issue-node-id', number: issueTarget.issueNumber, title: 'Issue', body: '', state: 'open', url: 'https://example.invalid/issues/42', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    pullRequest: { id: 'pr-node-id', number: 7, headSha: HEAD, baseSha: BASE, state: 'open', title: 'PR', url: 'https://example.invalid/pull/7', isDraft: false, mergeable: true, mergeStateStatus: 'clean', updatedAt: '2026-01-01T00:00:00Z' },
    headSha: HEAD, checks: { availability: 'unavailable', overall: 'unavailable', checks: [] },
    reviews: { decision: 'none', latestByAuthor: [], unresolvedThreads: null }, conversations: [], handoff: null,
    problems: [], observedAt: '2026-01-01T00:00:00Z', ...overrides,
  } as unknown as GitHubLiveSnapshot;
}

function issueGithub(snapshots: readonly GitHubLiveSnapshot[]): GitHubAdapter {
  let index = 0;
  return {
    kind: 'github', async readIssue() { throw new Error('unused'); }, async readBranch() { throw new Error('unused'); },
    async listPullRequests() { throw new Error('unused'); },
    async readLiveSnapshot() { return snapshots[Math.min(index++, snapshots.length - 1)]!; },
  };
}

function issueReviewer(githubAdapter: GitHubAdapter, transport: OracleReviewTransport = verifiedTransport(), receipts?: { record(receipt: OracleReceipt): void; list(): readonly OracleReceipt[] }) {
  return new OracleReviewer({ github: githubAdapter, transport, receipts, candidateEvidence: () => evidence({ target: issueTarget }), binding });
}

function output(verdict: 'PASS' | 'REQUEST_CHANGES' = 'PASS'): string {
  return JSON.stringify({ verdict, reviewed_head_sha: HEAD, blocking_findings: verdict === 'PASS' ? [] : [{ summary: 'A blocking issue' }], non_blocking_suggestions: [] });
}

function verifiedTransport(raw = output(), overrides: Record<string, unknown> = {}): OracleReviewTransport {
  return { async consult(request: OracleTransportRequest): Promise<OracleTransportResult> {
    return { outcome: 'success', output: raw, observation: {
      verified: true, bindingId: request.binding.bindingId, effectiveModel: request.binding.model,
      effectiveEffort: request.requestedEffort, requestCorrelationId: request.requestCorrelationId,
      targetKey: canonicalReviewTarget(request.target)?.key ?? '', pullRequestNumber: request.pullRequest.number,
      headSha: request.headSha, baseSha: request.pullRequest.baseSha, coverageComplete: true,
      changedPaths: [...request.policy.changedPaths], ...overrides,
    } };
  } };
}

function reviewer(options: { heads?: string[]; bases?: string[]; requestTarget?: typeof target; githubAdapter?: GitHubAdapter; transport?: OracleReviewTransport; receipts?: { record(receipt: OracleReceipt): void; list(): readonly OracleReceipt[] }; candidateMissing?: boolean; evidence?: unknown; supported?: readonly ('Medium' | 'High' | 'Extra High')[]; now?: () => string } = {}) {
  return new OracleReviewer({ github: options.githubAdapter ?? github(options.heads ?? [HEAD, HEAD], options.bases, options.requestTarget), transport: options.transport ?? verifiedTransport(), receipts: options.receipts, now: options.now,
    ...(options.candidateMissing ? {} : { candidateEvidence: () => options.evidence ?? evidence() }), binding: { ...binding, supportedEfforts: options.supported ?? binding.supportedEfforts } });
}

describe('OracleReviewer policy binding', () => {
  it('approves only with exact candidate, base, effort, and verified full-coverage observation', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-'));
    try {
      const receipts = new JsonFileOracleReceiptStore(dir);
      const result = await reviewer({ receipts }).review({ target, headSha: HEAD, instructions: 'Review safely.' });
      assert.deepEqual(result, { verdict: 'approve', reviewerName: 'oracle', headSha: HEAD, findings: [] });
      const receipt = receipts.list()[0]!;
      assert.equal(receipt.outcome, 'approved');
      assert.deepEqual(receipt.policy, { version: 'risk-policy/v1', floor: 'R2', selectedSemanticTier: 'R3', requestedEffort: 'Medium', effectiveEffort: 'Medium', reasons: ['ordinary_implementation'], criticalReason: null, baseSha: BASE, pullRequestNumber: 7, changedPathCount: 1,
        coverageSha256: createHash('sha256').update(JSON.stringify(changedPaths)).digest('hex'), requestCorrelationId: receipt.policy?.requestCorrelationId, requestedModel: binding.model, effectiveModel: binding.model, bindingId: binding.bindingId, coverageComplete: true });
      assert.equal(receipt.policyQualified, true);
      assert.match(receipt.id, /[0-9a-f-]{36}$/i);
      receipts.record({ ...receipt, id: 'legacy', policy: undefined, policyQualified: undefined });
      assert.equal(receipts.list().find((item) => item.id === 'legacy')?.policyQualified, false);
      writeFileSync(path.join(dir, 'malformed.json'), JSON.stringify({ ...receipt, id: 'malformed', policy: { ...receipt.policy, version: 'unknown' } }));
      assert.throws(() => receipts.list(), /Invalid Oracle receipt/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('holds before transport when evidence, binding, or required effort is unavailable', async () => {
    let consults = 0;
    const countingTransport: OracleReviewTransport = { async consult() { consults++; return { outcome: 'failure', code: 'unavailable', retryable: false }; } };
    await assert.rejects(() => reviewer({ candidateMissing: true, transport: countingTransport }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    await assert.rejects(() => reviewer({ evidence: evidence({ riskSignals: ['security'] }), supported: ['Medium', 'High'], transport: countingTransport }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    const getterBinding = Object.defineProperty({ bindingId: 'x', supportedEfforts: ['Medium'], independentReadOnly: true, available: true }, 'model', { get: () => binding.model });
    const malformed = new OracleReviewer({ github: github([HEAD, HEAD]), transport: countingTransport, candidateEvidence: () => evidence(), binding: getterBinding as unknown as typeof binding });
    await assert.rejects(() => malformed.review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    assert.equal(consults, 0);
  });

  it('records semantic R5 and its concrete reason while requiring Extra High only for that floor', async () => {
    const records: OracleReceipt[] = [];
    const result = await reviewer({ evidence: evidence({ changedPaths: ['src/domain/repair-admission.ts'] }), receipts: { record: (r) => records.push(r), list: () => records } }).review({ target, headSha: HEAD });
    assert.equal(result.verdict, 'approve');
    assert.equal(records[0]?.policy?.floor, 'R5');
    assert.equal(records[0]?.policy?.selectedSemanticTier, 'R5');
    assert.equal(records[0]?.policy?.requestedEffort, 'Extra High');
    assert.equal(records[0]?.policy?.effectiveEffort, 'Extra High');
    assert.match(records[0]?.policy?.criticalReason ?? '', /repair-admission/);
  });

  it('requests High for R4 and durably holds when the observed effort differs', async () => {
    const highReceipts = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-r4-'));
    const mismatchReceipts = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-effort-'));
    try {
      const highStore = new JsonFileOracleReceiptStore(highReceipts);
      const approved = await reviewer({ evidence: evidence({ changedPaths: ['src/workflow/recovery.ts'] }), receipts: highStore }).review({ target, headSha: HEAD });
      const highReceipt = highStore.list()[0]!;
      assert.equal(approved.verdict, 'approve');
      assert.equal(highReceipt.policy?.floor, 'R4');
      assert.equal(highReceipt.policy?.requestedEffort, 'High');
      assert.equal(highReceipt.policy?.effectiveEffort, 'High');
      assert.equal(highReceipt.policyQualified, true);

      const mismatchStore = new JsonFileOracleReceiptStore(mismatchReceipts);
      await assert.rejects(() => reviewer({ evidence: evidence({ changedPaths: ['src/workflow/recovery.ts'] }), transport: verifiedTransport(output(), { effectiveEffort: 'Medium' }), receipts: mismatchStore }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
      const failed = mismatchStore.list()[0]!;
      assert.equal(failed.outcome, 'failed');
      assert.equal(failed.failureCode, 'invalid_response');
      assert.equal(failed.policyQualified, false);
      assert.equal(failed.policy?.requestedEffort, 'High');
      assert.equal(failed.policy?.effectiveEffort, 'Medium');
      assert.equal(failed.observedHeadSha, HEAD);
    } finally {
      rmSync(highReceipts, { recursive: true, force: true });
      rmSync(mismatchReceipts, { recursive: true, force: true });
    }
  });

  it('rejects an unknown output field despite a qualified transport observation', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-unknown-field-'));
    try {
      const receipts = new JsonFileOracleReceiptStore(dir);
      const raw = JSON.stringify({ verdict: 'PASS', reviewed_head_sha: HEAD, blocking_findings: [], non_blocking_suggestions: [], unexpected: true });
      await assert.rejects(() => reviewer({ transport: verifiedTransport(raw), receipts }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_INVALID_OUTPUT');
      const failed = receipts.list()[0]!;
      assert.equal(failed.outcome, 'failed');
      assert.equal(failed.failureCode, 'invalid_response');
      assert.equal(failed.policyQualified, false);
      assert.equal(failed.policy?.coverageComplete, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects restored receipts with inconsistent HEAD, counts, verdict, or policy binding', async () => {
    const records: OracleReceipt[] = [];
    await reviewer({ receipts: { record: (r) => records.push(r), list: () => records } }).review({ target, headSha: HEAD });
    const approved = records[0]!;
    const policy = approved.policy!;
    const invalid: OracleReceipt[] = [
      { ...approved, id: 'wronghead', requestedHeadSha: OTHER },
      { ...approved, id: 'negative', blockingFindingCount: -1 },
      { ...approved, id: 'excess', nonBlockingFindingCount: 21 },
      { ...approved, id: 'effort', policy: { ...policy, requestedEffort: 'High' } },
      { ...approved, id: 'model', policy: { ...policy, effectiveModel: 'other-model' } },
      { ...approved, id: 'failure-flag', failureCode: 'invalid_response' },
      { ...approved, id: 'r5-reason', policy: { ...policy, floor: 'R5', selectedSemanticTier: 'R5', requestedEffort: 'Extra High', effectiveEffort: 'Extra High', criticalReason: null } },
      { ...approved, id: 'unknown-reason', policy: { ...policy, reasons: ['future_unrecognized_reason'] } as unknown as OracleReceipt['policy'] },
      { ...approved, id: 'duplicate-reason', policy: { ...policy, reasons: ['ordinary_implementation', 'ordinary_implementation'] } as unknown as OracleReceipt['policy'] },
      { ...approved, id: 'blank-critical-reason', policy: { ...policy, criticalReason: ' \t ' } },
      { ...approved, id: 'noncanonical-target', target: { ...approved.target, unexpected: true } as unknown as OracleReceipt['target'] },
    ];
    for (const receipt of invalid) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-invalid-'));
      try {
        writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt));
        assert.throws(() => new JsonFileOracleReceiptStore(dir).list(), /Invalid Oracle receipt/);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('holds when the transport observation reports another model, correlation, target, or partial coverage', async () => {
    for (const observation of [{ effectiveModel: 'unconfigured-model' }, { requestCorrelationId: 'foreign' }, { targetKey: 'foreign/repo@main' }, { changedPaths: [] }, { coverageComplete: false }]) {
      await assert.rejects(() => reviewer({ transport: verifiedTransport(output(), observation) }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    }
  });

  it('marks failure receipt coverage complete only when the observed manifest matches', async () => {
    for (const [overrides, expected] of [[{ changedPaths: [] }, false], [{ coverageComplete: false }, false], [{ effectiveEffort: 'High' }, true]] as const) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-coverage-'));
      try {
        const receipts = new JsonFileOracleReceiptStore(dir);
        await assert.rejects(() => reviewer({ transport: verifiedTransport(output(), overrides), receipts }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
        assert.equal(receipts.list()[0]?.policy?.coverageComplete, expected);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('rejects base movement, stale HEAD, and forged model output identity', async () => {
    await assert.rejects(() => reviewer({ bases: [BASE, OTHER_BASE] }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    await assert.rejects(() => reviewer({ heads: [HEAD, OTHER] }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    await assert.rejects(() => reviewer({ transport: verifiedTransport(JSON.stringify({ verdict: 'PASS', reviewed_head_sha: OTHER, blocking_findings: [], non_blocking_suggestions: [] })) }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
  });

  it('holds on wrong-target candidate evidence before transport', async () => {
    let consults = 0;
    const noConsult: OracleReviewTransport = { async consult() { consults++; return { outcome: 'failure', code: 'unavailable', retryable: false }; } };
    await assert.rejects(() => reviewer({ evidence: evidence({ target: { ...target, repo: 'other' } }), transport: noConsult }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    assert.equal(consults, 0);
  });

  it('separates delimiter-colliding structured targets before transport', async () => {
    let consults = 0;
    const requested = { ...target, branch: 'feature#publication=release' };
    const collidingCandidate = { ...target, publicationBranch: 'release' };
    assert.notEqual(canonicalReviewTarget(requested)?.key, canonicalReviewTarget(collidingCandidate)?.key);
    const noConsult: OracleReviewTransport = { async consult() { consults++; return { outcome: 'failure', code: 'unavailable', retryable: false }; } };
    await assert.rejects(() => reviewer({ requestTarget: requested, evidence: evidence({ target: collidingCandidate }), transport: noConsult }).review({ target: requested, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_POLICY_HOLD');
    assert.equal(consults, 0);
  });

  it('persists bounded unique receipts for maximum-size targets at a fixed time', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tachiko-oracle-max-target-'));
    try {
      const maxTarget = { kind: 'repository' as const, owner: 'o'.repeat(100), repo: 'r'.repeat(100), branch: 'b'.repeat(240), publicationBranch: 'p'.repeat(240) };
      const receipts = new JsonFileOracleReceiptStore(dir);
      const now = () => '2026-09-26T12:34:56.000Z';
      const successful = reviewer({ requestTarget: maxTarget, evidence: evidence({ target: maxTarget }), receipts, now });
      await successful.review({ target: maxTarget, headSha: HEAD });
      await successful.review({ target: maxTarget, headSha: HEAD });
      const failed = reviewer({ requestTarget: maxTarget, evidence: evidence({ target: maxTarget }), receipts, now, transport: { async consult() { return { outcome: 'failure', code: 'unavailable', retryable: false }; } } });
      await assert.rejects(() => failed.review({ target: maxTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_TRANSPORT_FAILED');
      const stored = receipts.list();
      assert.equal(stored.length, 3);
      assert.equal(new Set(stored.map((receipt) => receipt.id)).size, 3);
      assert.ok(stored.every((receipt) => receipt.id.length <= 120));
      assert.ok(stored.every((receipt) => `${receipt.id}.json`.length < 255));
      assert.equal(stored.filter((receipt) => receipt.outcome === 'approved').length, 2);
      assert.equal(stored.filter((receipt) => receipt.outcome === 'failed').length, 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('holds ambiguous open PR associations, including a second PR with another HEAD and a replaced PR number', async () => {
    let consults = 0;
    const noConsult: OracleReviewTransport = { async consult() { consults++; return { outcome: 'failure', code: 'unavailable', retryable: false }; } };
    const second = { number: 8, headSha: OTHER, baseSha: BASE, state: 'open' as const };
    await assert.rejects(() => reviewer({ githubAdapter: githubAssociations([7, 8], [{ number: 7, headSha: HEAD, baseSha: BASE, state: 'open' }, second]), transport: noConsult }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    await assert.rejects(() => reviewer({ githubAdapter: githubAssociations([7], [{ number: 8, headSha: HEAD, baseSha: BASE, state: 'open' }]), transport: noConsult }).review({ target, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    assert.equal(consults, 0);
  });

  it('uses exact live Issue identity while ignoring only known handoff, review, and check diagnostics', async () => {
    const diagnosticSnapshot = issueSnapshot({ problems: [
      { code: 'STALE_HANDOFF', message: 'The handoff is old.' },
      { code: 'STALE_REVIEW', message: 'A review is old.' },
      { code: 'CHECKS_UNAVAILABLE', message: 'Checks could not be read. '.repeat(300), details: { stderr: 'bounded by the adapter, but irrelevant to review identity' } },
    ] });
    const result = await issueReviewer(issueGithub([diagnosticSnapshot, diagnosticSnapshot])).review({ target: issueTarget, headSha: HEAD });
    assert.equal(result.verdict, 'approve');
  });

  it('holds contradictory, malformed, and unknown Issue diagnostics and mismatched Issue or PR fields', async () => {
    let consults = 0;
    const noConsult: OracleReviewTransport = { async consult() { consults++; return { outcome: 'failure', code: 'unavailable', retryable: false }; } };
    const diagnostics = [
      [{ code: 'CONTRADICTORY_STATE', message: 'Live state conflicts.' }],
      [{ message: 'Missing diagnostic code.' }],
      [{ code: 'FUTURE_DIAGNOSTIC', message: 'Unknown code.' }],
      null,
    ];
    for (const problems of diagnostics) {
      await assert.rejects(() => issueReviewer(issueGithub([issueSnapshot({ problems } as Record<string, unknown>)]), noConsult).review({ target: issueTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    }
    const original = issueSnapshot();
    const originalIssue = original.issue;
    const originalPullRequest = original.pullRequest!;
    const mismatches = [
      { repository: { ...original.repository, repo: 'other' } },
      { issue: { ...originalIssue, number: 43 } },
      { issue: { ...originalIssue, state: 'closed' } },
      { pullRequest: null },
      { pullRequest: { ...originalPullRequest, number: 0 } },
      { pullRequest: { ...originalPullRequest, state: 'closed' } },
      { headSha: 'malformed' },
      { pullRequest: { ...originalPullRequest, headSha: OTHER } },
      { pullRequest: { ...originalPullRequest, baseSha: 'malformed' } },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(() => issueReviewer(issueGithub([issueSnapshot(mismatch)]), noConsult).review({ target: issueTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    }
    assert.equal(consults, 0);
  });

  it('detects Issue PR number, HEAD, or base movement across consultation', async () => {
    const original = issueSnapshot();
    const originalPullRequest = original.pullRequest!;
    const moved = [
      { pullRequest: { ...originalPullRequest, number: 8 } },
      { headSha: OTHER, pullRequest: { ...originalPullRequest, headSha: OTHER } },
      { pullRequest: { ...originalPullRequest, baseSha: OTHER_BASE } },
    ];
    for (const movement of moved) {
      const receipts: OracleReceipt[] = [];
      await assert.rejects(() => issueReviewer(issueGithub([original, issueSnapshot(movement)]), verifiedTransport(), { record: (receipt) => receipts.push(receipt), list: () => receipts }).review({ target: issueTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
      assert.equal(receipts[0]?.outcome, 'stale_head');
      assert.equal(receipts[0]?.failureCode, 'stale_head');
      assert.equal(receipts[0]?.observedHeadSha, movement.headSha === OTHER ? OTHER : HEAD);
      assert.equal(receipts[0]?.policyQualified, false);
    }
  });

  it('detects repository and Issue target movement across consultation', async () => {
    const original = issueSnapshot();
    const movements = [
      issueSnapshot({ repository: { ...original.repository, owner: 'other' } }),
      issueSnapshot({ repository: { ...original.repository, repo: 'other' } }),
      issueSnapshot({ issue: { ...original.issue, number: issueTarget.issueNumber + 1 } }),
    ];
    for (const after of movements) {
      const receipts: OracleReceipt[] = [];
      await assert.rejects(() => issueReviewer(issueGithub([original, after]), verifiedTransport(), { record: (receipt) => receipts.push(receipt), list: () => receipts }).review({ target: issueTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
      assert.equal(receipts[0]?.outcome, 'stale_head');
      assert.equal(receipts[0]?.observedHeadSha, null);
      assert.equal(receipts[0]?.policyQualified, false);
    }
  });

  it('rechecks live Issue identity after malformed transport and records movement accurately', async () => {
    const receipts: OracleReceipt[] = [];
    const malformed: OracleReviewTransport = { async consult() { return { outcome: 'success', output: 'malformed' } as unknown as OracleTransportResult; } };
    const original = issueSnapshot();
    const moved = issueSnapshot({ headSha: OTHER, pullRequest: { ...original.pullRequest!, headSha: OTHER } });
    await assert.rejects(() => issueReviewer(issueGithub([original, moved]), malformed, { record: (receipt) => receipts.push(receipt), list: () => receipts }).review({ target: issueTarget, headSha: HEAD }), (e: unknown) => e instanceof OracleReviewerError && e.code === 'ORACLE_STALE_HEAD');
    assert.equal(receipts[0]?.outcome, 'stale_head');
    assert.equal(receipts[0]?.failureCode, 'stale_head');
    assert.equal(receipts[0]?.observedHeadSha, OTHER);
    assert.equal(receipts[0]?.policyQualified, false);
  });

  it('pins caller request and binding before the first await, and snapshots observation before postcheck awaits', async () => {
    const mutableBinding = { ...binding };
    const rawObservation: Record<string, unknown> = {};
    let branchReads = 0;
    const githubAdapter: GitHubAdapter = {
      kind: 'github', async readIssue() { throw new Error('unused'); }, async listPullRequests() { return [{ number: 7, headSha: HEAD, baseSha: BASE, state: 'open' }]; }, async readLiveSnapshot() { throw new Error('unused'); },
      async readBranch() { branchReads++; if (branchReads > 1) rawObservation.effectiveModel = 'changed-after-return'; return { target, headSha: HEAD, pullRequestNumbers: [7] }; },
    };
    const transport: OracleReviewTransport = { async consult(request) {
      assert.ok(Object.isFrozen(request) && Object.isFrozen(request.policy) && Object.isFrozen(request.binding) && Object.isFrozen(request.pullRequest));
      const valid = await verifiedTransport().consult(request);
      if (valid.outcome === 'success') { Object.assign(rawObservation, valid.observation); return { ...valid, observation: rawObservation as unknown as typeof valid.observation }; }
      return valid;
    } };
    const oracle = new OracleReviewer({ github: githubAdapter, transport, candidateEvidence: () => evidence(), binding: mutableBinding });
    mutableBinding.model = 'mutated-after-construction';
    const mutableRequest = { target: { ...target }, headSha: HEAD };
    const pending = oracle.review(mutableRequest);
    mutableRequest.headSha = OTHER;
    mutableRequest.target.branch = 'mutated-branch';
    const result = await pending;
    assert.equal(result.headSha, HEAD);
    assert.equal(rawObservation.effectiveModel, 'changed-after-return');
  });

  it('binds request-changes reviews to the same policy and candidate identity', async () => {
    const records: OracleReceipt[] = [];
    const result = await reviewer({ transport: verifiedTransport(output('REQUEST_CHANGES')), receipts: { record: (r) => records.push(r), list: () => records } }).review({ target, headSha: HEAD });
    assert.equal(result.verdict, 'request_changes');
    assert.equal(records[0]?.policy?.coverageComplete, true);
    assert.equal(records[0]?.policy?.floor, 'R2');
  });
});
