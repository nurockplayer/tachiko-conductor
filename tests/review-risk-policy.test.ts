import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyReviewRisk, type ReviewRiskEvidence } from '../src/reviewers/risk-policy.js';
import type { Target } from '../src/domain/types.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const target: Target = { kind: 'repository', owner: 'acme', repo: 'widgets', branch: 'feature' };
function evidence(overrides: Partial<ReviewRiskEvidence> = {}): ReviewRiskEvidence {
  return { target, headSha: HEAD, baseSha: BASE, changedPaths: ['src/feature.ts'], manifestComplete: true,
    deterministicValidation: { passed: true, headSha: HEAD, baseSha: BASE }, riskSignals: [], riskEvidenceComplete: true, ...overrides };
}

describe('classifyReviewRisk', () => {
  it('assigns R1 only to established tiny documentation changes', () => {
    assert.equal(classifyReviewRisk(evidence({ changedPaths: ['README.md'], establishedSafePattern: true })).outcome, 'review');
    const decision = classifyReviewRisk(evidence({ changedPaths: ['README.md'], establishedSafePattern: true }));
    assert.equal(decision.outcome === 'review' ? decision.floor : 'hold', 'R1');
    const unestablished = classifyReviewRisk(evidence({ changedPaths: ['README.md'] }));
    assert.equal(unestablished.outcome === 'review' ? unestablished.floor : 'hold', 'R2');
  });

  it('raises floors for API, concurrency, and explicit critical risk signals', () => {
    assert.equal((classifyReviewRisk(evidence({ changedPaths: ['src/api/public.ts'] })) as { floor?: string }).floor, 'R3');
    assert.equal((classifyReviewRisk(evidence({ changedPaths: ['src/concurrency/queue.ts'] })) as { floor?: string }).floor, 'R4');
    assert.equal((classifyReviewRisk(evidence({ riskSignals: ['security'] })) as { floor?: string }).floor, 'R5');
  });

  it('recognizes Conductor persistence, workflow, lock, heartbeat, admission, and Oracle policy paths', () => {
    for (const [path, floor] of [['src/store/json-file-store.ts', 'R3'], ['src/dispatch/invocation-lock.ts', 'R4'], ['src/workflow/run.ts', 'R5'], ['scripts/bootstrap-heartbeat/runner.py', 'R4'], ['src/domain/repair-admission.ts', 'R5'], ['src/mission-admission/registry.ts', 'R5'], ['src/oracle/reviewer.ts', 'R4'],
      ['src/workspace/git-worktree-bootstrap.ts', 'R5'], ['src/workspace/standalone-git-bootstrap.ts', 'R5'], ['src/agents/worker-router.ts', 'R5'], ['src/agents/worker-router-container.ts', 'R5'], ['src/agents/luna-isolated.ts', 'R5'], ['src/github/live-state.ts', 'R5'], ['src/reviewers/loop.ts', 'R5']] as const) {
      const decision = classifyReviewRisk(evidence({ changedPaths: [path] }));
      assert.equal(decision.outcome === 'review' ? decision.floor : 'hold', floor, path);
      if (floor === 'R5') assert.ok(decision.outcome === 'review' && decision.criticalReason?.includes(path));
    }
  });

  it('holds missing, stale, malformed, duplicate, or unknown evidence', () => {
    assert.equal(classifyReviewRisk(undefined).outcome, 'hold');
    assert.equal(classifyReviewRisk(evidence({ headSha: 'bad' })).outcome, 'hold');
    assert.equal(classifyReviewRisk(evidence({ changedPaths: ['../escape.ts'] })).outcome, 'hold');
    assert.equal(classifyReviewRisk(evidence({ changedPaths: ['src/a.ts', 'src/a.ts'] })).outcome, 'hold');
    assert.equal(classifyReviewRisk(evidence({ riskSignals: ['mystery'] })).outcome, 'hold');
    assert.equal(classifyReviewRisk(evidence({ deterministicValidation: { passed: true, headSha: HEAD, baseSha: 'c'.repeat(40) } })).outcome, 'hold');
    assert.equal(classifyReviewRisk({ ...evidence(), headSha: new String(HEAD) }).outcome, 'hold');
    const getterEvidence = evidence() as unknown as Record<string, unknown>;
    Object.defineProperty(getterEvidence, 'headSha', { get: () => HEAD });
    assert.equal(classifyReviewRisk(getterEvidence).outcome, 'hold');
  });

  it('does not lower a path floor and bounds critical escalation', () => {
    const decision = classifyReviewRisk(evidence({ changedPaths: ['src/api/public.ts'], riskSignals: [] }));
    assert.equal(decision.outcome === 'review' ? decision.floor : 'hold', 'R3');
    assert.equal(classifyReviewRisk(evidence({ criticalQuestion: 'What is the trust impact?' })).outcome, 'review');
    assert.equal(classifyReviewRisk(evidence({ criticalQuestion: 'x' })).outcome, 'hold');
  });
});
