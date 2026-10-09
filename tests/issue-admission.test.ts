import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admission = require('../.github/scripts/issue-admission.cjs') as {
  readonly ADMISSION_MARKER: string;
  readonly AUTHORITY_MARKER: string;
  readonly LEGACY_AUTHORITY_MARKER: string;
  fetchAuthoritySnapshot(github: { graphql: (...args: any[]) => Promise<any> }, input: Record<string, unknown>): Promise<any>;
  field(body: string, label: string): string | undefined;
  reconcileLabels(existing: readonly string[], desired: readonly string[]): string[];
  renderAdmission(decision: any): string;
};

function implementationForm(shape: 'bounded' | 'interacting' | 'decision' = 'bounded', association = 'OWNER') {
  return {
    author_association: association,
    state: 'open',
    body: [
      '### Kind', 'implementation', '',
      '### Task shape', shape, '',
      '### Classification reason', 'The scope is bounded.', '',
      '### Goal', 'Fixture goal.', '',
      '### Scope', 'Fixture scope.', '',
      '### Non-goals', 'Fixture exclusions.', '',
      '### Acceptance criteria', 'The fixture is accepted.', '',
      '### Dependencies', 'none', '',
      '### Stop conditions', 'Stop if the fixture is unclear.',
    ].join('\n'),
  };
}

async function classifyFixtureIssue(input: { issue: Record<string, any>; comments?: readonly Record<string, any>[] }) {
  const issue = input.issue;
  const ownerId = 'OWNER_USER';
  const actor = (association: unknown) => association === 'OWNER'
    ? { __typename: 'User', id: ownerId, login: 'owner' }
    : { __typename: 'User', id: 'OUTSIDE_USER', login: 'outside' };
  const createdAt = '2026-09-01T00:00:00Z';
  const graphIssue = {
      id: 'ISSUE_NODE', number: 1, body: issue.body, state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
      createdAt, updatedAt: createdAt, lastEditedAt: null,
      authorAssociation: issue.author_association ?? 'NONE', author: actor(issue.author_association), editor: null,
      repository: { id: 'REPO_NODE' },
      comments: {
        edges: (input.comments ?? []).map((comment, index) => ({ cursor: `comment:${index}`, node: {
          id: String(comment.id), body: comment.body, createdAt: comment.created_at ?? '2026-09-22T00:00:00Z',
          lastEditedAt: null, authorAssociation: comment.author_association ?? 'NONE',
          author: actor(comment.author_association), editor: null,
          issue: { id: 'ISSUE_NODE', number: 1, repository: { id: 'REPO_NODE' } }, url: 'https://example.test/comment',
        } })),
        pageInfo: { hasNextPage: false, endCursor: (input.comments ?? []).length > 0 ? `comment:${(input.comments ?? []).length - 1}` : null },
      },
      timelineItems: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const verified = await admission.fetchAuthoritySnapshot({ graphql: async () => ({ repository: {
    id: 'REPO_NODE', nameWithOwner: 'owner/repo', owner: actor('OWNER'), issue: graphIssue, pullRequest: null,
  } }) }, { owner: 'owner', repo: 'repo', number: 1, expectedRepositoryId: 'REPO_NODE' });
  return verified.decision;
}

const requiredWriterFields = [
  'Kind',
  'Task shape',
  'Classification reason',
  'Goal',
  'Scope',
  'Non-goals',
  'Acceptance criteria',
  'Dependencies',
  'Stop conditions',
];

test('trusted bounded implementation projects routine dispatch readiness', async () => {
  const decision = await classifyFixtureIssue({ issue: implementationForm() });
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

test('Issue Form edits rotate task authority revision even when shape is unchanged', async () => {
  const first = await classifyFixtureIssue({ issue: implementationForm('bounded') });
  const base = implementationForm('bounded');
  const second = await classifyFixtureIssue({
    issue: { ...base, body: `${base.body}\n\n### Scope\nExpanded` },
  });
  assert.notEqual(first.authority.revision, second.authority.revision);
  assert.equal(second.authority.executionProfile, 'routine');
});

test('implementation and repair forms require every field to be present and non-empty', async () => {
  for (const kind of ['implementation', 'repair']) {
    for (const label of requiredWriterFields) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const missingBody = implementationForm().body.replace(
        new RegExp(`(?:^|\\n\\n)### ${escapedLabel}\\n[\\s\\S]*?(?=\\n\\n### |$)`),
        '',
      );
      const absent = await classifyFixtureIssue({
        issue: { author_association: 'OWNER', state: 'open', body: missingBody.replace('implementation', kind) },
      });
      assert.equal(absent.status, 'blocked', `${kind}: missing ${label}`);
      assert.equal(absent.dispatch, 'blocked', `${kind}: missing ${label}`);
      assert.ok(absent.labels.includes('needs:classification'), `${kind}: missing ${label}`);

      for (const response of ['', '_No response_']) {
        const emptyBody = implementationForm().body
          .replace('implementation', kind)
          .replace(new RegExp(`(### ${escapedLabel}\\n)[^\\n]+`), `$1${response}`);
        const empty = await classifyFixtureIssue({
          issue: { author_association: 'OWNER', state: 'open', body: emptyBody },
        });
        assert.equal(empty.status, 'blocked', `${kind}: empty ${label}`);
        assert.equal(empty.dispatch, 'blocked', `${kind}: empty ${label}`);
        assert.ok(empty.labels.includes('needs:classification'), `${kind}: empty ${label}`);
      }
    }
  }
});

test('writer form fields accept multiline answers and CRLF Issue Form serialization', async () => {
  const body = implementationForm().body
    .replace('The scope is bounded.', 'The scope is bounded.\nIt changes one admission boundary.')
    .replace('Fixture goal.', 'First goal line.\nSecond $goal line.')
    .replace(/\n/g, '\r\n');
  const decision = await classifyFixtureIssue({ issue: { ...implementationForm(), body } });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'ready');
  assert.equal(decision.authority.shape, 'bounded');
  assert.equal(admission.field(body, 'Goal'), 'First goal line.\nSecond $goal line.');
  assert.equal(admission.field(body, 'Classification reason'), 'The scope is bounded.\nIt changes one admission boundary.');
});

function verifiedIssue(overrides: Record<string, unknown> = {}) {
  const base = implementationForm();
  return {
    id: 'ISSUE_NODE',
    number: 7,
    body: base.body,
    state: 'OPEN',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastEditedAt: null,
    authorAssociation: 'OWNER',
    author: { __typename: 'User', id: 'OWNER_USER', login: 'owner' },
    editor: null,
    repository: { id: 'REPO_NODE' },
    ...overrides,
  };
}

function verifiedSnapshot(issue: Record<string, unknown> = verifiedIssue(), comments: Record<string, unknown>[] = [], deletions: Record<string, unknown>[] = []) {
  return {
    repositoryId: 'REPO_NODE',
    repositoryOwner: { __typename: 'User', id: 'OWNER_USER', login: 'owner' },
    issue,
    comments,
    deletions,
  };
}

async function classifySnapshotFixture(snapshot: Record<string, any>) {
  const issue = snapshot.issue;
  const comments = snapshot.comments ?? [];
  const deletions = snapshot.deletions ?? [];
  const graphIssue = {
    ...issue,
    comments: { edges: comments.map((comment: any, index: number) => ({ cursor: `comment:${index}`, node: {
      id: comment.id, body: comment.body, createdAt: comment.created_at, lastEditedAt: comment.last_edited_at,
      authorAssociation: comment.author_association, author: comment.author, editor: comment.editor,
      issue: { id: issue.id, number: issue.number, repository: { id: issue.repository.id } }, url: comment.url,
    } })), pageInfo: { hasNextPage: false, endCursor: comments.length ? `comment:${comments.length - 1}` : null } },
    timelineItems: { edges: deletions.map((event: any, index: number) => ({ cursor: `deletion:${index}`, node: {
      __typename: 'CommentDeletedEvent', id: event.id, createdAt: event.created_at,
      actor: event.actor_type ? { __typename: event.actor_type } : null,
    } })), pageInfo: { hasNextPage: false, endCursor: deletions.length ? `deletion:${deletions.length - 1}` : null } },
  };
  const verified = await admission.fetchAuthoritySnapshot({ graphql: async () => ({ repository: {
    id: snapshot.repositoryId, nameWithOwner: 'owner/repo', owner: snapshot.repositoryOwner,
    issue: graphIssue, pullRequest: null,
  } }) }, { owner: 'owner', repo: 'repo', number: issue.number, expectedRepositoryId: snapshot.repositoryId });
  return verified.decision;
}

function authorityComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'COMMENT_NODE',
    body: `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
      revision: 'owner-v1', kind: 'repair', shape: 'bounded', executionProfile: 'routine', oracleRequired: false,
    })}\n\`\`\``,
    created_at: '2026-10-02T00:00:00Z',
    last_edited_at: null,
    author_association: 'OWNER',
    author: { __typename: 'User', id: 'OWNER_USER', login: 'owner' },
    editor: null,
    parent_issue_id: 'ISSUE_NODE',
    parent_issue_number: 7,
    repository_id: 'REPO_NODE',
    ...overrides,
  };
}

test('verified source accepts current owner content and binds provenance hashes and IDs', async () => {
  const form = await classifySnapshotFixture(verifiedSnapshot());
  assert.equal(form.status, 'ready');
  assert.equal(form.dispatch, 'ready');
  assert.equal(form.provenance.issueId, 'ISSUE_NODE');
  assert.match(form.provenance.issueBodySha256, /^[a-f0-9]{64}$/);
  assert.equal(form.provenance.authorityContentTime, '2026-10-01T00:00:00Z');

  const approvedExternalProposal = await classifySnapshotFixture(verifiedSnapshot(
    verifiedIssue({ authorAssociation: 'NONE', author: { __typename: 'User', id: 'OUTSIDE_USER', login: 'outside' } }),
    [authorityComment()],
  ));
  assert.equal(approvedExternalProposal.status, 'ready');
  assert.equal(approvedExternalProposal.source, 'steward-comment');
  assert.equal(approvedExternalProposal.provenance.authorityCommentId, 'COMMENT_NODE');
  assert.match(approvedExternalProposal.provenance.authorityBodySha256, /^[a-f0-9]{64}$/);
});

test('edited non-owner content and stale or tampered OWNER comments fail closed', async () => {
  const collaborator = { __typename: 'User', id: 'COLLAB_USER', login: 'collaborator' };
  const editedForm = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue({
    lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaborator,
  })));
  assert.equal(editedForm.dispatch, 'blocked');
  assert.ok(editedForm.labels.includes('needs:steward'));

  const bodyChangedAfterAuthority = await classifySnapshotFixture(verifiedSnapshot(
    verifiedIssue({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaborator }),
    [authorityComment()],
  ));
  assert.equal(bodyChangedAfterAuthority.dispatch, 'blocked');

  const editedByCollaborator = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [authorityComment({
    last_edited_at: '2026-10-04T00:00:00Z', editor: collaborator,
  })]));
  assert.equal(editedByCollaborator.dispatch, 'blocked');

  const removedMarker = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [authorityComment({
    body: 'The authority marker was removed by an edit.',
    last_edited_at: '2026-10-04T00:00:00Z', editor: collaborator,
  })]));
  assert.equal(removedMarker.dispatch, 'blocked');
});

test('verified snapshots reject impossible and causally inconsistent timestamps', async () => {
  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-10-01T24:00:00Z', '2026-10-01T00:60:00Z', '2026-10-01T00:00:60Z']) {
    await assert.rejects(classifySnapshotFixture(verifiedSnapshot(verifiedIssue({ createdAt: timestamp, updatedAt: timestamp }))));
  }

  for (const issue of [
    verifiedIssue({ updatedAt: '2026-09-30T00:00:00Z' }),
    verifiedIssue({ lastEditedAt: '2026-09-30T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', editor: { __typename: 'User', id: 'OWNER_USER', login: 'owner' } }),
    verifiedIssue({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', editor: { __typename: 'User', id: 'OWNER_USER', login: 'owner' } }),
  ]) {
    await assert.rejects(classifySnapshotFixture(verifiedSnapshot(issue)));
  }

  await assert.rejects(classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [authorityComment({ created_at: '2026-09-30T23:59:59Z' })])));
  await assert.rejects(classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [authorityComment({
    created_at: '2026-10-02T00:00:00Z', last_edited_at: '2026-10-01T23:59:59Z', editor: { __typename: 'User', id: 'OWNER_USER', login: 'owner' },
  })])));
  await assert.rejects(classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [], [
    { id: 'DELETE_BEFORE_ISSUE', created_at: '2026-09-30T23:59:59Z' },
  ])));
});

test('body edits, deletion equality, and later OWNER reaffirmation use strict content-time order', async () => {
  const oldApproval = authorityComment({ created_at: '2026-10-01T06:00:00Z' });
  const old = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue({
    lastEditedAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z',
    editor: { __typename: 'User', id: 'OWNER_USER', login: 'owner' },
  }), [oldApproval]));
  assert.equal(old.dispatch, 'blocked');

  const equal = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [authorityComment()], [
    { id: 'DELETED_EQUAL', created_at: '2026-10-02T00:00:00Z' },
  ]));
  assert.equal(equal.dispatch, 'blocked');
  assert.match(equal.errors[0], /deleted at or after/);

  const later = await classifySnapshotFixture(verifiedSnapshot(verifiedIssue(), [
    authorityComment({ created_at: '2026-10-03T00:00:00Z' }),
  ], [{ id: 'DELETED_OLD', created_at: '2026-10-02T00:00:00Z' }]));
  assert.equal(later.dispatch, 'ready');
});

test('trusted interacting implementation projects complex dispatch readiness', async () => {
  const decision = await classifyFixtureIssue({ issue: implementationForm('interacting') });
  assert.equal(decision.authority.executionProfile, 'complex');
  assert.equal(decision.dispatch, 'ready');
  assert.ok(decision.labels.includes('profile:complex'));
});

test('decision-shaped implementation starts zero implementation writers', async () => {
  const decision = await classifyFixtureIssue({ issue: implementationForm('decision') });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.authority.executionProfile, null);
  assert.equal(decision.authority.oracleRequired, true);
  assert.equal(decision.conductor, null);
  assert.ok(decision.labels.includes('shape:decision'));
  assert.ok(decision.labels.includes('oracle:required'));
  assert.equal(decision.labels.some((label: string) => label.startsWith('profile:')), false);
});

test('research and operational/meta kinds never enter implementation dispatch', async () => {
  for (const kind of ['research', 'operational', 'coordination', 'tracking']) {
    const decision = await classifyFixtureIssue({
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

test('decision kind requires Oracle and zero writer', async () => {
  const decision = await classifyFixtureIssue({
    issue: { author_association: 'OWNER', state: 'open', body: '### Kind\ndecision' },
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.authority.shape, 'decision');
  assert.equal(decision.authority.executionProfile, null);
  assert.equal(decision.authority.oracleRequired, true);
  assert.ok(decision.labels.includes('oracle:required'));
});

test('untrusted Issue Form is only a proposal and cannot obtain writer authority', async () => {
  const decision = await classifyFixtureIssue({ issue: implementationForm('bounded', 'NONE') });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.trusted, false);
  assert.ok(decision.labels.includes('needs:steward'));
  assert.equal(decision.labels.some((label: string) => label.startsWith('kind:')), false);
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('member and collaborator Issue Forms still require explicit Steward authority', async () => {
  for (const association of ['MEMBER', 'COLLABORATOR']) {
    const decision = await classifyFixtureIssue({ issue: implementationForm('bounded', association) });
    assert.equal(decision.status, 'blocked');
    assert.ok(decision.labels.includes('needs:steward'));
    assert.equal(decision.labels.includes('dispatch:ready'), false);
  }
});

test('trusted API-created Issue body authority is accepted without Issue Form fields', async () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'api-v1',
    kind: 'implementation',
    shape: 'bounded',
    executionProfile: 'routine',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = await classifyFixtureIssue({ issue: { author_association: 'OWNER', state: 'open', body } });
  assert.equal(decision.source, 'steward-body');
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'ready');
  assert.equal(decision.authority.revision, 'api-v1');
});

test('untrusted authority comments cannot override trusted Issue Form authority', async () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'untrusted-v1',
    kind: 'implementation',
    shape: 'interacting',
    executionProfile: 'complex',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = await classifyFixtureIssue({
    issue: implementationForm('bounded'),
    comments: [{ id: 9, author_association: 'NONE', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.source, 'issue-form');
  assert.equal(decision.authority.shape, 'bounded');
  assert.equal(decision.authority.executionProfile, 'routine');
});

test('latest trusted explicit authority overrides Issue Form projection', async () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'steward-v2',
    kind: 'repair',
    shape: 'interacting',
    executionProfile: 'complex',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = await classifyFixtureIssue({
    issue: implementationForm('bounded'),
    comments: [{ id: 10, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.source, 'steward-comment');
  assert.equal(decision.authority.revision, 'steward-v2');
  assert.equal(decision.authority.kind, 'repair');
  assert.equal(decision.authority.executionProfile, 'complex');
});

test('invalid trusted authority fails closed instead of falling back to older/form state', async () => {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'bad-v1',
    kind: 'implementation',
    shape: 'bounded',
    executionProfile: 'complex',
    oracleRequired: false,
  })}\n\`\`\``;
  const decision = await classifyFixtureIssue({
    issue: implementationForm('bounded'),
    comments: [{ id: 11, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.status, 'blocked');
  assert.ok(decision.labels.includes('needs:classification'));
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('legacy task-shape authority remains read-compatible', async () => {
  const body = `${admission.LEGACY_AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({ revision: 'legacy-v1', shape: 'interacting' })}\n\`\`\``;
  const decision = await classifyFixtureIssue({
    issue: { author_association: 'OWNER', state: 'open', body: '' },
    comments: [{ id: 12, author_association: 'OWNER', created_at: '2026-09-22T00:00:00Z', body }],
  });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.authority.kind, 'implementation');
  assert.equal(decision.authority.executionProfile, 'complex');
});

test('closed Issue keeps classification but loses implementation dispatch readiness', async () => {
  const decision = await classifyFixtureIssue({ issue: { ...implementationForm(), state: 'closed' } });
  assert.equal(decision.status, 'ready');
  assert.equal(decision.dispatch, 'blocked');
  assert.equal(decision.conductor, null);
  assert.ok(decision.labels.includes('dispatch:blocked'));
  assert.equal(decision.labels.includes('dispatch:ready'), false);
});

test('managed-label reconciliation preserves unrelated labels and removes stale projections', async () => {
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

test('admission comment rendering is stable and carries the managed marker', async () => {
  const decision = await classifyFixtureIssue({ issue: implementationForm() });
  const first = admission.renderAdmission(decision);
  const second = admission.renderAdmission(decision);
  assert.equal(first, second);
  assert.ok(first.includes(admission.ADMISSION_MARKER));
  assert.ok(first.includes('"executionProfile": "routine"'));
});
