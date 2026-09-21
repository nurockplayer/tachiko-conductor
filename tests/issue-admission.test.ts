import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admission = require('../.github/scripts/issue-admission.cjs') as {
  readonly ADMISSION_MARKER: string;
  readonly AUTHORITY_MARKER: string;
  readonly LEGACY_AUTHORITY_MARKER: string;
  classifyIssue(input: { issue: Record<string, unknown>; comments?: readonly Record<string, unknown>[] }): any;
  reconcileLabels(existing: readonly string[], desired: readonly string[]): string[];
  renderAdmission(decision: any): string;
};

function implementationForm(shape: 'bounded' | 'interacting' | 'decision' = 'bounded', association = 'OWNER') {
  return {
    author_association: association,
    state: 'open',
    body: `### Kind\nimplementation\n\n### Task shape\n${shape}\n\n### Goal\nFixture`,
  };
}

test('trusted bounded implementation projects routine dispatch readiness', () => {
  const decision = admission.classifyIssue({ issue: implementationForm() });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'ready');
  assert.equal(decision.authority.executionProfile, 'routine');
  assert.deepEqual(decision.conductor, {
    executionProfile: 'routine',
    taskShapeAuthority: { revision: decision.authority.revision, shape: 'bounded' },
  });
  assert.ok(decision.labels.includes('kind:implementation'));
  assert.ok(decision.labels.includes('shape:bounded'));
  assert.ok(decision.labels.includes('profile:routine'));
  assert.ok(decision.labels.includes('dispatch:ready'));
});

test('trusted interacting implementation projects complex dispatch readiness', () => {
  const decision = admission.classifyIssue({ issue: implementationForm('interacting') });
  assert.equal(decision.authority.executionProfile, 'complex');
  assert.equal(decision.dispatch, 'ready');
  assert.ok(decision.labels.includes('profile:complex'));
});

test('decision-shaped implementation starts zero implementation writers', () => {
  const decision = admission.classifyIssue({ issue: implementationForm('decision') });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.authority.executionProfile, null);
  assert.equal(decision.authority.oracleRequired, true);
  assert.equal(decision.conductor, null);
  assert.ok(decision.labels.includes('shape:decision'));
  assert.ok(decision.labels.includes('oracle:required'));
  assert.equal(decision.labels.some((label: string) => label.startsWith('profile:')), false);
});

test('research and operational/meta kinds never enter implementation dispatch', () => {
  for (const kind of ['research', 'operational', 'coordination', 'tracking']) {
    const decision = admission.classifyIssue({
      issue: { author_association: 'OWNER', state: 'open', body: `### Kind\n${kind}` },
    });
    assert.equal(decision.status, 'ready');
    assert.equal(decision.dispatch, 'blocked');
    assert.equal(decision.authority.shape, null);
    assert.equal(decision.authority.executionProfile, null);
    assert.equal(decision.authority.oracleRequired, false);
    assert.equal(decision.conductor, null);
  }
});

test('decision kind requires Oracle and zero writer', () => {
  const decision = admission.classifyIssue({
    issue: { author_association: 'OWNER', state: 'open', body: '### Kind\ndecision' },
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.authority.shape, 'decision');
  assert.equal(decision.authority.executionProfile, null);
  assert.equal(decision.authority.oracleRequired, true);
  assert.ok(decision.labels.includes('oracle:required'));
});

test('untrusted Issue Form is only a proposal and cannot obtain writer authority', () => {
  const decision = admission.classifyIssue({ issue: implementationForm('bounded', 'NONE') });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.trusted, false);
  assert.ok(decision.labels.includes('needs:steward'));
  assert.equal(decision.labels.some((label: string) => label.startsWith('kind:')), false);
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('latest trusted explicit authority overrides Issue Form projection', () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'steward-v2',
    kind: 'repair',
    shape: 'interacting',
    executionProfile: 'complex',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = admission.classifyIssue({
    issue: implementationForm('bounded'),
    comments: [{ id: 10, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.source, 'steward-comment');
  assert.equal(decision.authority.revision, 'steward-v2');
  assert.equal(decision.authority.kind, 'repair');
  assert.equal(decision.authority.executionProfile, 'complex');
});

test('invalid trusted authority fails closed instead of falling back to older/form state', () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'bad-v1',
    kind: 'implementation',
    shape: 'bounded',
    executionProfile: 'complex',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = admission.classifyIssue({
    issue: implementationForm('bounded'),
    comments: [{ id: 11, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.status, 'blocked');
  assert.ok(decision.labels.includes('needs:classification'));
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('legacy task-shape authority remains read-compatible', () => {
  const body = `${admission.LEGACY_AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({ revision: 'legacy-v1', shape: 'interacting' })}\n\`\`\``;
  const decision = admission.classifyIssue({
    issue: { author_association: 'OWNER', state: 'open', body: '' },
    comments: [{ id: 12, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.authority.kind, 'implementation');
  assert.equal(decision.authority.executionProfile, 'complex');
});

test('closed Issue keeps classification but loses implementation dispatch readiness', () => {
  const decision = admission.classifyIssue({ issue: { ...implementationForm(), state: 'closed' } });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.conductor, null);
  assert.ok(decision.labels.includes('dispatch:blocked'));
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('managed-label reconciliation preserves unrelated labels and removes stale projections', () => {
  const labels = admission.reconcileLabels(
    ['priority:high', 'shape:bounded', 'profile:routine', 'dispatch:ready'],
    ['kind:research', 'classification:ready', 'oracle:not-required', 'dispatch:blocked'],
  );
  assert.ok(labels.includes('priority:high'));
  assert.ok(labels.includes('kind:research'));
  assert.ok(labels.includes('dispatch:blocked'));
  assert.equal(labels.includes('shape:bounded'), false);
  assert.equal(labels.includes('profile:routine'), false);
  assert.equal(labels.includes('dispatch:ready'), false);
});

test('admission comment rendering is stable and carries the managed marker', () => {
  const decision = admission.classifyIssue({ issue: implementationForm() });
  const first = admission.renderAdmission(decision);
  const second = admission.renderAdmission(decision);
  assert.equal(first, second);
  assert.ok(first.includes(admission.ADMISSION_MARKER));
  assert.ok(first.includes('"executionProfile": "routine"'));
});
