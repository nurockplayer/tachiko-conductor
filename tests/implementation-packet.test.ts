import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IMPLEMENTATION_PACKET_LIMITS,
  acceptedScopeFromHandoff,
  buildImplementationPacket,
  renderFinalCliPacket,
  type ImplementationPacketInput,
} from '../src/agents/implementation-packet.js';

const input = () => ({
  kind: 'initial' as ImplementationPacketInput['kind'],
  identity: {
    runId: 'run-48-a',
    target: { kind: 'issue', owner: 'nurockplayer', repo: 'tachiko-conductor', issueNumber: 48 },
    workspacePath: '/tmp/issue-48-worker',
    branch: 'codex/issue-48-worker',
    baseSha: 'b'.repeat(40),
    execution: { profile: 'complex', revision: 'profiles-v1', executor: 'luna-isolated', timeoutMs: 60_000, model: 'luna-high', reasoningEffort: 'high' },
  },
  authority: {
    repository: { owner: 'nurockplayer', repo: 'tachiko-conductor' },
    issue: { id: 'I_kwDO48', number: 48, updatedAt: '2026-09-30T00:00:00Z', title: 'Build bounded packets', body: 'Keep exact authority and evidence.' },
    acceptedScope: {
      sourceId: 'IC_kwDO48-A',
      sourceScope: 'issue',
      sourceUpdatedAt: '2026-09-30T00:01:00Z',
      freshness: 'current',
      text: 'Build the versioned pure packet builder and integrate all three producers.',
    },
  },
  repair: null as ImplementationPacketInput['repair'],
}) satisfies ImplementationPacketInput;

describe('implementation packet builder', () => {
  it('selects the current accepted #48-A scope section with source provenance', () => {
    const scope = acceptedScopeFromHandoff({
      sourceId: 'IC_kwDO48-A', sourceScope: 'issue', sourceUpdatedAt: '2026-09-30T00:01:00Z',
      sections: { 'ACCEPTED #48-A SCOPE': 'Only the bounded packet builder slice.' }, freshness: 'current',
    });
    assert.deepEqual(scope, {
      sourceId: 'IC_kwDO48-A', sourceScope: 'issue', sourceUpdatedAt: '2026-09-30T00:01:00Z',
      freshness: 'current', text: 'Only the bounded packet builder slice.',
    });
  });

  it('accepts a claimless issue-scoped initial handoff only when explicitly enabled and refuses retrieval ambiguity', () => {
    const unclaimed = {
      sourceId: 'IC_kwDO48-A', sourceScope: 'issue' as const, sourceUpdatedAt: '2026-09-30T00:01:00Z',
      sections: { 'ACCEPTED #48-A SCOPE': 'Only the bounded packet builder slice.' }, freshness: 'unknown' as const,
    };
    assert.equal(acceptedScopeFromHandoff(unclaimed, [], true)?.freshness, 'unknown');
    assert.equal(acceptedScopeFromHandoff(unclaimed, [], false), null);
    assert.equal(acceptedScopeFromHandoff(unclaimed, [{ code: 'MALFORMED_HANDOFF_NEWER_THAN_SELECTED', message: 'newer malformed authority' }]), null);
  });

  it('renders a versioned packet with issue, accepted-scope, and execution provenance', () => {
    const result = buildImplementationPacket(input());
    assert.equal(result.kind, 'packet');
    if (result.kind !== 'packet') return;
    assert.equal(result.packet.version, 'tachiko.implementation-packet.v1');
    assert.match(result.packet.rendered, /IC_kwDO48-A/);
    assert.match(result.packet.rendered, /run-48-a/);
    assert.match(result.packet.rendered, /luna-high/);
    assert.equal(Buffer.byteLength(result.packet.rendered, 'utf8') <= IMPLEMENTATION_PACKET_LIMITS.renderedBytes, true);
    assert.deepEqual(renderFinalCliPacket(result.packet), { kind: 'packet', text: result.packet.finalCliText });
  });

  it('refuses missing exact authority and never fabricates or truncates it', () => {
    const missing = input();
    missing.authority.acceptedScope.text = '';
    const result = buildImplementationPacket(missing);
    assert.equal(result.kind, 'refusal');
    if (result.kind === 'refusal') assert.equal(result.code, 'PACKET_AUTHORITY_MISSING');
  });

  it('refuses oversize issue, repair evidence, title, final CLI, and blocker count', () => {
    const issue = input();
    issue.authority.issue.body = 'x'.repeat(IMPLEMENTATION_PACKET_LIMITS.issueBodyBytes + 1);
    assert.equal(buildImplementationPacket(issue).kind, 'refusal');

    const evidence = input();
    evidence.kind = 'review-repair';
    evidence.identity.baseSha = 'c'.repeat(40);
    evidence.repair = { headSha: 'c'.repeat(40), pullRequestNumber: 121, evidenceRef: 'validation:head', evidence: JSON.stringify({ verdict: 'request_changes', headSha: 'c'.repeat(40), pullRequestNumber: 121, padding: 'x'.repeat(IMPLEMENTATION_PACKET_LIMITS.repairEvidenceBytes + 1) }), evidenceKind: 'review', evidenceHeadSha: 'c'.repeat(40), evidencePullRequestNumber: 121, evidenceStatus: 'request_changes', blockingFindings: [] };
    assert.equal(buildImplementationPacket(evidence).kind, 'refusal');

    const aggregateEvidence = input();
    aggregateEvidence.kind = 'review-repair';
    aggregateEvidence.identity.baseSha = 'c'.repeat(40);
    aggregateEvidence.repair = { headSha: 'c'.repeat(40), pullRequestNumber: 121, evidenceRef: 'review:head', evidence: JSON.stringify({ verdict: 'request_changes', headSha: 'c'.repeat(40), pullRequestNumber: 121 }), evidenceKind: 'review', evidenceHeadSha: 'c'.repeat(40), evidencePullRequestNumber: 121, evidenceStatus: 'request_changes', blockingFindings: ['x'.repeat(IMPLEMENTATION_PACKET_LIMITS.repairEvidenceBytes)] };
    assert.equal(buildImplementationPacket(aggregateEvidence).kind, 'refusal');

    const title = input();
    title.authority.issue.title = '☃'.repeat(Math.floor(IMPLEMENTATION_PACKET_LIMITS.titleBytes / 3) + 1);
    assert.equal(buildImplementationPacket(title).kind, 'refusal');

    const scope = input();
    scope.authority.acceptedScope.text = 'x'.repeat(IMPLEMENTATION_PACKET_LIMITS.renderedBytes);
    assert.equal(buildImplementationPacket(scope).kind, 'refusal');

    const blockers = input();
    blockers.kind = 'review-repair';
    blockers.identity.baseSha = 'c'.repeat(40);
    blockers.repair = { headSha: 'c'.repeat(40), pullRequestNumber: 121, evidenceRef: 'review:head', evidence: JSON.stringify({ verdict: 'request_changes', headSha: 'c'.repeat(40), pullRequestNumber: 121 }), evidenceKind: 'review', evidenceHeadSha: 'c'.repeat(40), evidencePullRequestNumber: 121, evidenceStatus: 'request_changes', blockingFindings: Array.from({ length: IMPLEMENTATION_PACKET_LIMITS.blockingFindings + 1 }, (_, i) => `${i + 1}. [blocking] finding`) };
    assert.equal(buildImplementationPacket(blockers).kind, 'refusal');
  });

  it('rechecks the final CLI byte limit at the adapter boundary', () => {
    const built = buildImplementationPacket(input());
    assert.equal(built.kind, 'packet');
    if (built.kind !== 'packet') return;
    const oversized = { ...built.packet, finalCliText: '☃'.repeat(IMPLEMENTATION_PACKET_LIMITS.finalCliBytes) };
    const result = renderFinalCliPacket(oversized);
    assert.equal(result.kind, 'refusal');
    if (result.kind === 'refusal') assert.equal(result.code, 'PACKET_FINAL_CLI_OVERSIZE');
  });

  it('requires exact repair HEAD and PR evidence for both repair producer kinds', () => {
    for (const kind of ['validation-repair', 'review-repair'] as const) {
      const incomplete = input();
      incomplete.kind = kind;
      incomplete.repair = null;
      const result = buildImplementationPacket(incomplete);
      assert.equal(result.kind, 'refusal');
      if (result.kind === 'refusal') assert.equal(result.code, 'PACKET_REPAIR_EVIDENCE_MISSING');
    }
  });

  it('renders a validation repair only with exact failed-HEAD evidence and PR identity', () => {
    const validation = input();
    validation.kind = 'validation-repair';
    validation.identity.baseSha = 'c'.repeat(40);
    validation.repair = {
      headSha: 'c'.repeat(40),
      pullRequestNumber: 121,
      evidenceRef: 'run:run-48-a:validation:cccccccccccccccccccccccccccccccccccccccc',
      evidence: JSON.stringify({
        headSha: 'c'.repeat(40),
        status: 'failed',
        local: {
          status: 'failed', configRevision: 'local-v1',
          commands: [{ commandIndex: 0, executable: 'pnpm test', outcome: 'failed', exitCode: 1, durationMs: 10 }],
        },
        hosted: {
          status: 'not_required', observedAt: '2026-09-30T00:02:00Z', pullRequestNumber: 121,
          availability: 'available', overall: 'passing', policyRevision: null, policyMode: 'not_required',
          requiredCheckNames: [], observedCheckNames: [],
        },
      }),
      evidenceKind: 'validation',
      evidenceHeadSha: 'c'.repeat(40),
      evidencePullRequestNumber: 121,
      evidenceStatus: 'failed',
      blockingFindings: [],
    };
    const result = buildImplementationPacket(validation);
    assert.equal(result.kind, 'packet');
    if (result.kind === 'packet') {
      assert.equal(result.packet.kind, 'validation-repair');
      assert.match(result.packet.rendered, /PR #121 at exact HEAD c{40}/);
      assert.match(result.packet.rendered, /run:run-48-a:validation:/);
    }
  });

  it('refuses repair evidence whose exact HEAD or accepted PR does not match the packet repair identity', () => {
    const validation = input();
    validation.kind = 'validation-repair';
    validation.identity.baseSha = 'c'.repeat(40);
    validation.repair = {
      headSha: 'c'.repeat(40), pullRequestNumber: 121, evidenceRef: 'run:validation', evidence: 'failed',
      evidenceKind: 'validation', evidenceHeadSha: 'd'.repeat(40), evidencePullRequestNumber: 120,
      evidenceStatus: 'failed', blockingFindings: [],
    };
    assert.equal(buildImplementationPacket(validation).kind, 'refusal');
  });
});
