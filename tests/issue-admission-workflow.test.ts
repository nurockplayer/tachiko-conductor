import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admission = require('../.github/scripts/issue-admission.cjs');
const workflow = readFileSync(new URL('../.github/workflows/issue-admission.yml', import.meta.url), 'utf8');
const OWNER_ID = 'OWNER_USER_NODE';
const REPO_ID = 'REPO_NODE';
const ISSUE_ID = 'ISSUE_NODE';

function workflowScript(): string {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '          script: |');
  assert.notEqual(start, -1, 'workflow github-script block exists');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('            ')) break;
    body.push(line.startsWith('            ') ? line.slice(12) : '');
  }
  return body.join('\n');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => Function;

function formBody(kind = 'implementation', shape = 'bounded') {
  return [
    '### Kind', kind, '', '### Task shape', shape, '',
    '### Classification reason', 'Bounded because the scope has one owner.', '',
    '### Goal', 'Reconcile admission.', '', '### Scope', 'Issue admission provenance.', '',
    '### Non-goals', 'No queue changes.', '', '### Acceptance criteria', 'Managed projection matches authority.', '',
    '### Dependencies', 'none', '', '### Stop conditions', 'Stop on ambiguity.',
  ].join('\n');
}

function ownerActor(id = OWNER_ID, login = 'owner') { return { __typename: 'User', id, login }; }
function collaboratorActor() { return ownerActor('COLLABORATOR_NODE', 'collaborator'); }

function issueSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    number: 1,
    body: formBody(),
    state: 'OPEN',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    lastEditedAt: null,
    authorAssociation: 'OWNER',
    author: ownerActor(),
    editor: null,
    repository: { id: REPO_ID },
    ...overrides,
  };
}

function ownerAuthorityComment(overrides: Record<string, unknown> = {}) {
  const body = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'owner-v1', kind: 'repair', shape: 'interacting', executionProfile: 'complex', oracleRequired: false,
  })}\n\`\`\``;
  return {
    id: 'COMMENT_NODE',
    body,
    createdAt: '2026-10-02T00:00:00Z',
    lastEditedAt: null,
    authorAssociation: 'OWNER',
    author: ownerActor(),
    editor: null,
    issue: { id: ISSUE_ID, number: 1, repository: { id: REPO_ID } },
    url: 'https://github.com/nurockplayer/tachiko-conductor/issues/1#issuecomment-2',
    ...overrides,
  };
}

function makeHarness(options: {
  snapshots?: Array<{ issue?: Record<string, unknown>; comments?: Record<string, unknown>[]; deletions?: Record<string, unknown>[] }>;
  evolveProjectionComments?: boolean;
  pageSize?: number;
  restIssue?: Record<string, unknown>;
  pullRequest?: boolean;
  repositoryGetFailure?: boolean;
  repositoryIdentity?: Record<string, unknown>;
  commentReadFailure?: boolean;
  labelReadFailure?: boolean;
  emptyLabelList?: boolean;
  labelCreateFailure?: boolean;
  removeFailures?: Set<string>;
  initialComments?: Array<Record<string, any>>;
  commentWriteFailure?: 'update-once' | 'update-always' | 'create-after-apply' | 'duplicate';
  ordinaryAddFailure?: 'apply-then-throw' | 'throw';
  finalReadyAddFailure?: boolean;
  graphqlFailure?: (read: number, variables: Record<string, unknown>, query: string) => unknown;
  malformedPage?: (response: any, read: number, variables: Record<string, unknown>) => any;
} = {}) {
  const base = options.snapshots?.[0] ?? {};
  const firstIssue = { ...issueSnapshot(), ...(base.issue ?? {}) };
  const restIssue: any = options.restIssue ? { ...options.restIssue } : {
    node_id: firstIssue.id,
    number: 1,
    body: firstIssue.body,
    state: firstIssue.state === 'OPEN' ? 'open' : 'closed',
    created_at: firstIssue.createdAt,
    updated_at: firstIssue.updatedAt,
    author_association: firstIssue.authorAssociation,
    user: { node_id: firstIssue.author?.id },
    labels: ['priority:high', 'kind:implementation', 'shape:interacting', 'profile:complex', 'dispatch:ready'],
    ...(options.pullRequest ? { pull_request: { url: 'https://api.github.com/repos/nurockplayer/tachiko-conductor/pulls/1' } } : {}),
  };
  let labels = new Set((restIssue.labels ?? []).map((label: any) => typeof label === 'string' ? label : label.name));
  const labelDefinitions = new Set(Object.keys(admission.LABEL_DEFINITIONS));
  const comments: any[] = options.initialComments ? [...options.initialComments] : [{
    id: 9,
    html_url: 'https://github.com/nurockplayer/tachiko-conductor/issues/1#issuecomment-9',
    user: { login: 'github-actions[bot]' },
    body: `${admission.ADMISSION_MARKER}\nold projection`,
  }];
  Object.defineProperty(restIssue, 'labels', { get: () => [...labels].map((name) => ({ name })) });
  const counts = {
    graphql: 0, commentsRead: 0, labelBootstrap: 0, addLabels: 0, removeLabel: 0,
    setLabels: 0, createComment: 0, updateComment: 0, createCommentWrites: 0,
  };
  const removedLabels: string[] = [];
  const events: string[] = [];
  const failures: string[] = [];
  const pageSize = options.pageSize ?? 100;
  let read = -1;
  const snapshots = options.snapshots?.length ? options.snapshots : [{}];

  function rowsPage(rows: any[], after: unknown, prefix: string) {
    const start = after === null || after === undefined ? 0 : Number(String(after).slice(prefix.length + 1)) + 1;
    const page = rows.slice(start, start + pageSize);
    const edges = page.map((node, index) => ({ cursor: `${prefix}:${start + index}`, node }));
    const hasNextPage = start + page.length < rows.length;
    return { edges, pageInfo: { hasNextPage, endCursor: edges.at(-1)?.cursor ?? null } };
  }

  const github: any = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
      counts.graphql += 1;
      if (variables.commentCursor === null && variables.deletionCursor === null) read += 1;
      const fail = options.graphqlFailure?.(read, variables, query);
      if (fail) throw fail;
      const supplied = snapshots[Math.min(read, snapshots.length - 1)] ?? {};
      const currentIssue = { ...issueSnapshot(), ...(supplied.issue ?? {}) };
      const projectionComments = options.evolveProjectionComments
        ? comments.filter((item) => item.user?.login === 'github-actions[bot]').map((item) => ({
            id: `REST_COMMENT_${item.id}`,
            body: item.body,
            createdAt: item.created_at ?? '2026-10-01T01:00:00Z',
            lastEditedAt: item.last_edited_at ?? null,
            authorAssociation: item.author_association ?? 'NONE',
            author: item.graphAuthor ?? { __typename: 'Bot' },
            editor: item.graphEditor ?? null,
          }))
        : [];
      const commentsData = [...(supplied.comments ?? []), ...projectionComments].map((item: any) => ({
        ...ownerAuthorityComment(),
        ...item,
        issue: item.issue ?? { id: currentIssue.id, number: currentIssue.number, repository: { id: currentIssue.repository.id } },
      }));
      const deletionData = supplied.deletions ?? [];
      const response: any = {
        repository: {
          id: REPO_ID,
          nameWithOwner: 'nurockplayer/tachiko-conductor',
          owner: ownerActor(),
          issue: {
            ...currentIssue,
            comments: rowsPage(commentsData, variables.commentCursor, 'comment'),
            timelineItems: rowsPage(deletionData.map((event: any) => ({ __typename: 'CommentDeletedEvent', actor: null, ...event })), variables.deletionCursor, 'deletion'),
          },
          pullRequest: null,
        },
      };
      return options.malformedPage?.(response, read, variables) ?? response;
    },
    rest: {
      repos: { get: async () => {
        if (options.repositoryGetFailure) throw new Error('repository API unavailable');
        return { data: { node_id: REPO_ID, full_name: 'nurockplayer/tachiko-conductor', ...(options.repositoryIdentity ?? {}) } };
      } },
      issues: {
        get: async () => ({ data: restIssue }),
        listComments: async () => { counts.commentsRead += 1; events.push('comments:read'); if (options.commentReadFailure) throw new Error('comments permission denied'); return { data: comments }; },
        listLabelsForRepo: async () => { if (options.labelReadFailure) throw new Error('label list unavailable'); return { data: options.emptyLabelList ? [] : [...labelDefinitions].map((name) => ({ name })) }; },
        createLabel: async ({ name }: { name: string }) => { counts.labelBootstrap += 1; if (options.labelCreateFailure) throw new Error('label create denied'); labelDefinitions.add(name); },
        addLabels: async ({ labels: additions }: { labels: string[] }) => {
          counts.addLabels += 1;
          const isFinalReady = additions.length === 1 && additions[0] === 'dispatch:ready';
          events.push('add:' + additions.join(','));
          if (!isFinalReady && options.ordinaryAddFailure === 'throw') throw new Error('ordinary label addition failed before applying');
          for (const name of additions) labels.add(name);
          labels.add('triage:concurrent');
          if (isFinalReady && options.finalReadyAddFailure) throw new Error('final dispatch add applied then failed');
          if (!isFinalReady && options.ordinaryAddFailure) {
            if (options.ordinaryAddFailure === 'throw') throw new Error('ordinary label addition failed');
            throw new Error('ordinary label addition applied then failed');
          }
          return { data: additions.map((name) => ({ name })) };
        },
        removeLabel: async ({ name }: { name: string }) => {
          counts.removeLabel += 1;
          events.push('remove:' + name);
          removedLabels.push(name);
          if (options.removeFailures?.has(name)) throw new Error(`cannot remove ${name}`);
          if (!labels.has(name)) { const error: any = new Error(`label ${name} is already absent`); error.status = 404; throw error; }
          labels.delete(name);
        },
        setLabels: async () => { counts.setLabels += 1; throw new Error('workflow must not replace the full label set'); },
        createComment: async ({ body }: { body: string }) => {
          counts.createComment += 1;
          events.push('comment:create');
          const created = { id: 10, html_url: 'https://example.test/comment/10', user: { login: 'github-actions[bot]' }, body };
          comments.push(created);
          if (options.commentWriteFailure === 'create-after-apply') throw new Error('create applied but response failed');
          return { data: created };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          counts.updateComment += 1;
          events.push('comment:update:' + comment_id);
          if (comment_id === 9 && (options.commentWriteFailure === 'update-always' ||
              (options.commentWriteFailure === 'update-once' && counts.updateComment === 1))) throw new Error('canonical update failed');
          if (comment_id !== 9 && options.commentWriteFailure === 'duplicate') throw new Error('duplicate correction failed');
          const comment = comments.find((item) => item.id === comment_id);
          assert.ok(comment);
          comment.body = body;
        },
      },
    },
    paginate: async (method: Function, args: Record<string, unknown>) => (await method(args)).data,
  };
  const context = { repo: { owner: 'nurockplayer', repo: 'tachiko-conductor' } };
  const core = { setFailed(message: string) { failures.push(message); } };
  const taskRequire = (id: string) => id === 'node:path' ? path : admission;
  const run = async () => {
    const executor = new AsyncFunction('github', 'context', 'core', 'process', 'require', workflowScript());
    await executor(github, context, core, { env: { TACHIKO_ISSUE_NUMBER: '1', GITHUB_WORKSPACE: '/workspace' } }, taskRequire);
  };
  return {
    run,
    counts,
    failures,
    removedLabels,
    events,
    comments,
    get labels() { return labels; },
    get projection() { return comments.find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(admission.ADMISSION_MARKER))?.body; },
  };
}

test('ordinary Issue provenance does not request a nonexistent same-number PullRequest', async () => {
  const queries: string[] = [];
  const harness = makeHarness({
    graphqlFailure(_read, variables, query) {
      queries.push(query);
      // GitHub returns a resolver error for this wrong-type lookup, not merely
      // pullRequest: null. Octokit rejects the whole request despite Issue data.
      if (/\bpullRequest\s*\(/.test(query)) {
        return Object.assign(new Error(`Request failed due to following response errors:\n - Could not resolve to a PullRequest with the number of ${variables.number}.`), {
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }],
        });
      }
    },
    malformedPage(response) {
      delete response.repository.pullRequest;
      return response;
    },
  });
  await harness.run();
  assert.ok(harness.labels.has('dispatch:ready'), harness.projection);
  assert.equal(harness.failures.length, 0);
  assert.ok(queries.length >= 2, 'complete provenance is rechecked before projection');
  assert.ok(queries.every((query) => /\bissue\s*\(number:\s*\$number\)/.test(query)));
  assert.ok(queries.every((query) => !/\bpullRequest\s*\(/.test(query)));
});

test('Issue-only lookup still fails closed on missing target and real GraphQL errors', async () => {
  for (const malformedPage of [
    (response: any) => { response.repository.issue = null; return response; },
    (response: any) => { delete response.repository.issue; return response; },
    (response: any) => ({ ...response, errors: [{ type: 'FORBIDDEN', path: ['repository', 'issue', 'timelineItems'] }] }),
  ]) {
    const harness = makeHarness({ malformedPage });
    await harness.run();
    assert.equal(harness.labels.has('dispatch:ready'), false);
    assert.ok(harness.labels.has('dispatch:blocked'));
    assert.match(harness.projection, /provenance is unavailable/i);
  }
});

test('workflow authenticates an unedited OWNER form, preserves concurrent labels, records hashes and is idempotent', async () => {
  const harness = makeHarness();
  await harness.run();
  assert.equal(harness.failures.length, 0);
  assert.ok(harness.labels.has('priority:high'));
  assert.ok(harness.labels.has('triage:concurrent'));
  assert.ok(harness.labels.has('shape:bounded'));
  assert.ok(harness.labels.has('profile:routine'));
  assert.ok(harness.labels.has('dispatch:ready'));
  assert.equal(harness.labels.has('shape:interacting'), false);
  assert.equal(harness.labels.has('profile:complex'), false);
  assert.equal(harness.counts.setLabels, 0);
  assert.equal(harness.counts.removeLabel, 3);
  assert.equal(harness.counts.updateComment, 1);
  assert.match(harness.projection, /"issueBodySha256":\s*"[a-f0-9]{64}"/);
  assert.match(harness.projection, new RegExp(`"issueId":\\s*"${ISSUE_ID}"`));

  const firstProjection = harness.projection;
  await harness.run();
  assert.equal(harness.projection, firstProjection);
  assert.equal(harness.counts.updateComment, 1);
  assert.equal(harness.counts.removeLabel, 3);
  assert.ok(harness.labels.has('triage:concurrent'));
});

test('workflow stays byte-stable as canonical and duplicate projections reappear in later full snapshots', async () => {
  const harness = makeHarness({
    evolveProjectionComments: true,
    initialComments: [
      { id: 9, created_at: '2026-10-01T01:00:00Z', html_url: 'https://example.test/canonical', user: { login: 'github-actions[bot]' }, body: `${admission.ADMISSION_MARKER}\nold canonical` },
      { id: 10, created_at: '2026-10-01T01:01:00Z', html_url: 'https://example.test/duplicate', user: { login: 'github-actions[bot]' }, body: `${admission.ADMISSION_MARKER}\nold duplicate` },
    ],
  });
  await harness.run();
  const firstProjection = harness.projection;
  assert.match(firstProjection, /"authorityInputsSha256":\s*"[a-f0-9]{64}"/);
  assert.equal(harness.counts.updateComment, 2, 'the initial pass updates the canonical comment and duplicate');

  for (const pass of [2, 3]) {
    const eventOffset = harness.events.length;
    await harness.run();
    assert.equal(harness.projection, firstProjection, `rendered canonical bytes are stable on pass ${pass}`);
    assert.equal(harness.counts.updateComment, 2, `no canonical or duplicate update on pass ${pass}`);
    assert.deepEqual(harness.events.slice(eventOffset).filter((event) => /^(add:|remove:|comment:)/.test(event)), [], `no projection writes on pass ${pass}`);
  }
});

test('full internal drift witness still holds on a non-OWNER projection change between reads', async () => {
  const projectionComment = (body: string) => ({
    id: 'BOT_PROJECTION', body, createdAt: '2026-10-01T01:00:00Z', lastEditedAt: null,
    authorAssociation: 'NONE', author: { __typename: 'Bot' }, editor: null,
  });
  const harness = makeHarness({ snapshots: [
    { issue: issueSnapshot(), comments: [projectionComment(`${admission.ADMISSION_MARKER}\nfirst projection`)] },
    { issue: issueSnapshot(), comments: [projectionComment(`${admission.ADMISSION_MARKER}\nchanged between reads`)] },
  ] });
  await harness.run();
  assert.equal(harness.labels.has('dispatch:ready'), false);
  assert.ok(harness.labels.has('dispatch:blocked'));
  const payload = JSON.parse(harness.projection.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '{}');
  assert.equal(payload.provenance.status, 'unavailable');
  assert.match(payload.provenance.observedAuthorityInputsSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(payload.provenance, 'observedSnapshotSha256'), false);
  assert.equal(Object.hasOwn(payload.provenance, 'snapshotSha256'), false);
  assert.equal(harness.failures.length, 0, 'a successfully written blocked projection is a clean HOLD');
});

test('workflow accepts edited OWNER content and a later OWNER comment approval', async () => {
  const ownerEditedIssue = issueSnapshot({
    lastEditedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', editor: ownerActor(),
  });
  const edited = makeHarness({ snapshots: [{ issue: ownerEditedIssue }] });
  await edited.run();
  assert.ok(edited.labels.has('dispatch:ready'));

  const approved = makeHarness({ snapshots: [{
    issue: issueSnapshot({ authorAssociation: 'NONE', author: ownerActor('OUTSIDE_USER', 'outside') }),
    comments: [ownerAuthorityComment()],
  }] });
  await approved.run();
  assert.ok(approved.labels.has('dispatch:ready'));
  assert.match(approved.projection, /"authorityCommentId":\s*"COMMENT_NODE"/);

  const ownerEditedBodyAuthority = `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({
    revision: 'edited-body-v1', kind: 'repair', shape: 'bounded', executionProfile: 'routine', oracleRequired: false,
  })}\n\`\`\``;
  const editedBody = makeHarness({ snapshots: [{ issue: issueSnapshot({
    body: ownerEditedBodyAuthority, lastEditedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', editor: ownerActor(),
  }) }] });
  await editedBody.run();
  assert.ok(editedBody.labels.has('dispatch:ready'));
  assert.match(editedBody.projection, /"source":\s*"steward-body"/);

  const editedOwnerComment = makeHarness({ snapshots: [{ issue: issueSnapshot({
    lastEditedAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z', editor: ownerActor(),
  }), comments: [ownerAuthorityComment({ lastEditedAt: '2026-10-02T00:00:00Z', editor: ownerActor() })] }] });
  await editedOwnerComment.run();
  assert.ok(editedOwnerComment.labels.has('dispatch:ready'));

  const legacyBody = `${admission.LEGACY_AUTHORITY_MARKER}\n\n\`\`\`json\n${JSON.stringify({ revision: 'legacy-live', shape: 'bounded' })}\n\`\`\``;
  const legacyOwner = makeHarness({ snapshots: [{ issue: issueSnapshot(), comments: [ownerAuthorityComment({ body: legacyBody })] }] });
  await legacyOwner.run();
  assert.ok(legacyOwner.labels.has('dispatch:ready'));

  const reaffirmedAfterCollaboratorEdit = makeHarness({ snapshots: [{
    issue: issueSnapshot({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaboratorActor() }),
    comments: [ownerAuthorityComment({ createdAt: '2026-10-04T00:00:00Z' })],
  }] });
  await reaffirmedAfterCollaboratorEdit.run();
  assert.ok(reaffirmedAfterCollaboratorEdit.labels.has('dispatch:ready'));
});

test('collaborator edits, stale comments, tampered markers and invalid latest authority remove readiness without fallback', async () => {
  const collaborator = collaboratorActor();
  const cases = [
    { issue: issueSnapshot({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaborator }) },
    { issue: issueSnapshot({ body: `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n{"revision":"x","kind":"implementation","shape":"bounded","executionProfile":"routine","oracleRequired":false}\n\`\`\``,
      lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaborator }) },
    { issue: issueSnapshot(), comments: [ownerAuthorityComment({ lastEditedAt: '2026-10-04T00:00:00Z', editor: collaborator })] },
    { issue: issueSnapshot(), comments: [ownerAuthorityComment({ body: 'marker removed', lastEditedAt: '2026-10-04T00:00:00Z', editor: collaborator })] },
    { issue: issueSnapshot(), comments: [ownerAuthorityComment({ body: `${admission.LEGACY_AUTHORITY_MARKER}\n\n\`\`\`json\n{"revision":"legacy","shape":"bounded"}\n\`\`\``, lastEditedAt: '2026-10-04T00:00:00Z', editor: collaborator })] },
  ];
  for (const snapshot of cases) {
    const harness = makeHarness({ snapshots: [snapshot] });
    await harness.run();
    assert.equal(harness.labels.has('dispatch:ready'), false);
    assert.ok(harness.labels.has('dispatch:blocked'));
    assert.match(harness.projection, /"conductor":\s*null/);
  }

  const valid = ownerAuthorityComment({ createdAt: '2026-10-03T00:00:00Z' });
  const invalidLatest = ownerAuthorityComment({
    id: 'COMMENT_INVALID_LATEST', createdAt: '2026-10-04T00:00:00Z',
    body: `${admission.AUTHORITY_MARKER}\n\n\`\`\`json\n{"revision":"bad","kind":"repair","shape":"bounded","executionProfile":"complex","oracleRequired":false}\n\`\`\``,
  });
  const latest = makeHarness({ snapshots: [{ issue: issueSnapshot(), comments: [valid, invalidLatest] }] });
  await latest.run();
  assert.equal(latest.labels.has('dispatch:ready'), false);
});

test('workflow paginates controlling comments and deletion events and requires a later reaffirmation', async () => {
  const unrelatedComments = Array.from({ length: 100 }, (_, index) => ownerAuthorityComment({
    id: `OTHER_${index}`, body: `ordinary owner comment ${index}`, createdAt: '2026-10-01T01:00:00Z',
  }));
  const controlling = ownerAuthorityComment({ id: 'LATER_PAGE_OWNER', createdAt: '2026-10-02T00:00:00Z' });
  const laterPage = makeHarness({ snapshots: [{ issue: issueSnapshot(), comments: [...unrelatedComments, controlling] }] });
  await laterPage.run();
  assert.ok(laterPage.labels.has('dispatch:ready'));
  assert.ok(laterPage.counts.graphql >= 4);

  const deletions = Array.from({ length: 101 }, (_, index) => ({
    id: `DELETE_${index}`, createdAt: index === 100 ? '2026-10-02T00:00:00Z' : '2026-10-01T01:00:00Z',
  }));
  const equality = makeHarness({ snapshots: [{ issue: issueSnapshot(), comments: [controlling], deletions }] });
  await equality.run();
  assert.equal(equality.labels.has('dispatch:ready'), false);
  assert.match(equality.projection, /deleted at or after/);

  const reaffirmed = makeHarness({ snapshots: [{
    issue: issueSnapshot(),
    comments: [controlling, ownerAuthorityComment({ id: 'OWNER_REAFFIRMATION', createdAt: '2026-10-03T00:00:00Z' })],
    deletions,
  }] });
  await reaffirmed.run();
  assert.ok(reaffirmed.labels.has('dispatch:ready'));

  const formFallbackDeleted = makeHarness({ snapshots: [{
    issue: issueSnapshot(), deletions: [{ id: 'DELETE_FORM', createdAt: '2026-10-01T00:00:00Z', actor: { __typename: 'User' } }],
  }] });
  await formFallbackDeleted.run();
  assert.equal(formFallbackDeleted.labels.has('dispatch:ready'), false);
  assert.equal(formFallbackDeleted.counts.graphql >= 2, true);
});

test('workflow holds unavailable, incomplete, mismatched, or drifting provenance and clears stale readiness', async () => {
  const unavailable = makeHarness({ graphqlFailure: () => new Error('GraphQL permission denied') });
  await unavailable.run();
  assert.equal(unavailable.labels.has('dispatch:ready'), false);
  assert.ok(unavailable.labels.has('dispatch:blocked'));
  assert.match(unavailable.projection, /provenance is unavailable/i);

  const partial = makeHarness({ malformedPage(response) {
    response.repository.issue.timelineItems = undefined;
    return response;
  } });
  await partial.run();
  assert.equal(partial.labels.has('dispatch:ready'), false);

  const missingEditProvenance = makeHarness({ malformedPage(response) {
    delete response.repository.issue.lastEditedAt;
    return response;
  } });
  await missingEditProvenance.run();
  assert.equal(missingEditProvenance.labels.has('dispatch:ready'), false);

  const partialGraphql = makeHarness({ malformedPage(response) { return { ...response, errors: [{ message: 'partial data' }] }; } });
  await partialGraphql.run();
  assert.equal(partialGraphql.labels.has('dispatch:ready'), false);

  const parentMismatch = makeHarness({ snapshots: [{ issue: issueSnapshot(), comments: [
    ownerAuthorityComment({ issue: { id: 'OTHER_ISSUE', number: 1, repository: { id: REPO_ID } } }),
  ] }] });
  await parentMismatch.run();
  assert.equal(parentMismatch.labels.has('dispatch:ready'), false);

  const nonAdvancing = makeHarness({ pageSize: 1, snapshots: [{ issue: issueSnapshot(), comments: [
    ownerAuthorityComment({ id: 'PAGE_A', body: 'ordinary A', createdAt: '2026-10-01T01:00:00Z' }),
    ownerAuthorityComment({ id: 'PAGE_B', body: 'ordinary B', createdAt: '2026-10-01T01:00:00Z' }),
  ] }], malformedPage(response) {
    response.repository.issue.comments.pageInfo.hasNextPage = true;
    response.repository.issue.comments.pageInfo.endCursor = 'comment:0';
    return response;
  } });
  await nonAdvancing.run();
  assert.equal(nonAdvancing.labels.has('dispatch:ready'), false);

  const duplicateIds = makeHarness({ pageSize: 1, snapshots: [{ issue: issueSnapshot(), comments: [
    ownerAuthorityComment({ id: 'DUPLICATE', body: 'ordinary A', createdAt: '2026-10-01T01:00:00Z' }),
    ownerAuthorityComment({ id: 'DUPLICATE', body: 'ordinary B', createdAt: '2026-10-01T01:00:00Z' }),
  ] }] });
  await duplicateIds.run();
  assert.equal(duplicateIds.labels.has('dispatch:ready'), false);

  const brokenDeletionPage = makeHarness({ pageSize: 1, snapshots: [{ issue: issueSnapshot(), deletions: [
    { id: 'DELETE_A', createdAt: '2026-10-01T01:00:00Z' },
    { id: 'DELETE_B', createdAt: '2026-10-01T01:00:00Z' },
  ] }], malformedPage(response) {
    response.repository.issue.timelineItems.pageInfo.hasNextPage = true;
    response.repository.issue.timelineItems.pageInfo.endCursor = 'deletion:0';
    return response;
  } });
  await brokenDeletionPage.run();
  assert.equal(brokenDeletionPage.labels.has('dispatch:ready'), false);

  const drift = makeHarness({ snapshots: [
    { issue: issueSnapshot() },
    { issue: issueSnapshot({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaboratorActor() }) },
  ] });
  await drift.run();
  assert.equal(drift.labels.has('dispatch:ready'), false);
  assert.match(drift.projection, /changed before projection/);

  const targetMismatch = makeHarness({
    snapshots: [{ issue: issueSnapshot({ id: 'OTHER_ISSUE_NODE' }) }],
    restIssue: {
      node_id: ISSUE_ID, number: 1, body: formBody(), state: 'open',
      created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
      author_association: 'OWNER', user: { node_id: OWNER_ID }, labels: ['dispatch:ready'],
    },
  });
  await targetMismatch.run();
  assert.equal(targetMismatch.counts.commentsRead, 0);
  assert.equal(targetMismatch.counts.labelBootstrap, 0);
  assert.equal(targetMismatch.counts.addLabels + targetMismatch.counts.removeLabel + targetMismatch.counts.updateComment, 0);
});

test('workflow blocks impossible and causally inconsistent snapshot timestamps and clears readiness', async () => {
  const contradictoryIssue = makeHarness({ snapshots: [{ issue: issueSnapshot({
    lastEditedAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    editor: ownerActor(),
  }) }] });
  await contradictoryIssue.run();
  assert.equal(contradictoryIssue.labels.has('dispatch:ready'), false);
  assert.ok(contradictoryIssue.labels.has('dispatch:blocked'));
  assert.match(contradictoryIssue.projection, /chronologically inconsistent/);

  const invalidCalendar = makeHarness({ snapshots: [{ issue: issueSnapshot({
    createdAt: '2026-02-30T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  }) }] });
  await invalidCalendar.run();
  assert.equal(invalidCalendar.labels.has('dispatch:ready'), false);

  const commentBeforeIssue = makeHarness({ snapshots: [{
    issue: issueSnapshot(), comments: [ownerAuthorityComment({ createdAt: '2026-09-30T23:59:59Z' })],
  }] });
  await commentBeforeIssue.run();
  assert.equal(commentBeforeIssue.labels.has('dispatch:ready'), false);

  const deletionBeforeIssue = makeHarness({ snapshots: [{
    issue: issueSnapshot(), deletions: [{ id: 'DELETE_BEFORE_ISSUE', createdAt: '2026-09-30T23:59:59Z' }],
  }] });
  await deletionBeforeIssue.run();
  assert.equal(deletionBeforeIssue.labels.has('dispatch:ready'), false);
});

test('blocked readiness revocation precedes comment and label discovery failures', async () => {
  const readyIssue = issueSnapshot();
  const commentReadFailure = makeHarness({
    snapshots: [{ issue: readyIssue }], commentReadFailure: true,
    restIssue: { ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: readyIssue.body, state: 'open',
      created_at: readyIssue.createdAt, updated_at: readyIssue.updatedAt, author_association: readyIssue.authorAssociation,
      user: { node_id: OWNER_ID }, labels: ['dispatch:ready', 'classification:ready', 'priority:high'] },
  });
  await commentReadFailure.run();
  assert.ok(commentReadFailure.removedLabels.includes('dispatch:ready'));
  assert.ok(commentReadFailure.removedLabels.includes('classification:ready'));
  assert.equal(commentReadFailure.labels.has('dispatch:ready'), false);
  assert.equal(commentReadFailure.labels.has('classification:ready'), false);
  assert.ok(commentReadFailure.labels.has('dispatch:blocked'));
  assert.equal(commentReadFailure.counts.createComment + commentReadFailure.counts.updateComment, 0);
  assert.ok(commentReadFailure.failures.some((message: string) => /Comment discovery failed/.test(message)));

  const labelBootstrapFailure = makeHarness({
    snapshots: [{ issue: readyIssue }], emptyLabelList: true, labelCreateFailure: true,
    restIssue: { ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: readyIssue.body, state: 'open',
      created_at: readyIssue.createdAt, updated_at: readyIssue.updatedAt, author_association: readyIssue.authorAssociation,
      user: { node_id: OWNER_ID }, labels: ['dispatch:ready', 'priority:high'] },
  });
  await labelBootstrapFailure.run();
  assert.ok(labelBootstrapFailure.removedLabels.includes('dispatch:ready'));
  assert.equal(labelBootstrapFailure.labels.has('dispatch:ready'), false);
  assert.ok(labelBootstrapFailure.labels.has('dispatch:blocked'));
  assert.match(labelBootstrapFailure.projection, /"conductor":\s*null/);
  assert.ok(labelBootstrapFailure.failures.some((message: string) => /Could not install managed label/.test(message)));
});

test('readiness cleanup attempts are independent and repository identity failure writes nothing', async () => {
  const staleReadyIssue = issueSnapshot({ lastEditedAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', editor: collaboratorActor() });
  const partialCleanup = makeHarness({
    snapshots: [{ issue: staleReadyIssue }], removeFailures: new Set(['dispatch:ready']),
    restIssue: { ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: staleReadyIssue.body, state: 'open',
      created_at: staleReadyIssue.createdAt, updated_at: staleReadyIssue.updatedAt, author_association: staleReadyIssue.authorAssociation,
      user: { node_id: OWNER_ID }, labels: ['dispatch:ready', 'classification:ready', 'priority:high'] },
  });
  await partialCleanup.run();
  assert.ok(partialCleanup.removedLabels.includes('dispatch:ready'));
  assert.ok(partialCleanup.removedLabels.includes('classification:ready'));
  assert.equal(partialCleanup.labels.has('classification:ready'), false);
  assert.ok(partialCleanup.labels.has('dispatch:ready'));
  assert.ok(partialCleanup.labels.has('dispatch:blocked'));
  assert.match(partialCleanup.projection, /"conductor":\s*null/);
  assert.ok(partialCleanup.failures.some((message: string) => /Could not revoke dispatch:ready/.test(message)));

  assert.equal(partialCleanup.removedLabels.filter((name: string) => name === 'dispatch:ready').length, 1);
  assert.equal(partialCleanup.removedLabels.filter((name: string) => name === 'classification:ready').length, 1);

  const classificationReadyCases = [
    issueSnapshot({ state: 'CLOSED' }),
    issueSnapshot({ body: formBody('research') }),
    issueSnapshot({ body: formBody('decision') }),
    issueSnapshot({ body: formBody('implementation', 'decision') }),
  ];
  for (const issue of classificationReadyCases) {
    const harness = makeHarness({ snapshots: [{ issue }], restIssue: {
      ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: issue.body,
      state: issue.state === 'CLOSED' ? 'closed' : 'open', created_at: issue.createdAt, updated_at: issue.updatedAt,
      author_association: issue.authorAssociation, user: { node_id: OWNER_ID },
      labels: ['classification:ready', 'dispatch:ready', 'priority:high'],
    } });
    await harness.run();
    assert.ok(harness.labels.has('classification:ready'));
    assert.ok(harness.labels.has('dispatch:blocked'));
    assert.equal(harness.labels.has('dispatch:ready'), false);
    assert.match(harness.projection, /"conductor":\s*null/);
    assert.equal(harness.removedLabels.filter((name: string) => name === 'classification:ready').length, 0);
    assert.equal(harness.removedLabels.filter((name: string) => name === 'dispatch:ready').length, 1);
    assert.equal(harness.failures.length, 0);
    assert.ok(harness.events.indexOf('remove:dispatch:ready') < harness.events.indexOf('comments:read'));
  }

  for (const options of [
    { repositoryGetFailure: true },
    { repositoryIdentity: { full_name: 'someone/else' } },
    { repositoryIdentity: { node_id: '' } },
  ]) {
    const unidentified = makeHarness(options);
    await unidentified.run();
    assert.equal(unidentified.counts.commentsRead + unidentified.counts.labelBootstrap + unidentified.counts.addLabels + unidentified.counts.removeLabel + unidentified.counts.createComment + unidentified.counts.updateComment, 0);
    assert.equal(unidentified.labels.has('dispatch:ready'), true);
    assert.ok(unidentified.failures.length > 0);
  }
});

test('ready projection writes are ordered and failure paths hold without granting dispatch', async () => {
  const changed = issueSnapshot({
    body: formBody('repair'),
    lastEditedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', editor: ownerActor(),
  });
  const restChanged = {
    ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: changed.body, state: 'open',
    created_at: changed.createdAt, updated_at: changed.updatedAt, author_association: changed.authorAssociation,
    user: { node_id: OWNER_ID }, labels: ['dispatch:ready', 'dispatch:blocked', 'classification:ready', 'kind:implementation', 'shape:interacting', 'profile:complex', 'oracle:not-required'],
  };
  const ordered = makeHarness({ snapshots: [{ issue: changed }], restIssue: restChanged });
  await ordered.run();
  const revokeAt = ordered.events.indexOf('remove:dispatch:ready');
  const canonicalAt = ordered.events.indexOf('comment:update:9');
  const finalReadyAt = ordered.events.lastIndexOf('add:dispatch:ready');
  assert.ok(revokeAt >= 0 && revokeAt < canonicalAt);
  assert.ok(canonicalAt >= 0 && canonicalAt < finalReadyAt);
  assert.ok(ordered.events.indexOf('remove:dispatch:blocked') >= 0 && ordered.events.indexOf('remove:dispatch:blocked') < finalReadyAt);
  assert.equal(ordered.events.at(-1), 'add:dispatch:ready', 'readiness is the final projection write');
  assert.equal(ordered.failures.length, 0);

  const updateFailed = makeHarness({ snapshots: [{ issue: changed }], restIssue: restChanged, commentWriteFailure: 'update-once' });
  await updateFailed.run();
  assert.ok(updateFailed.events.indexOf('remove:dispatch:ready') < updateFailed.events.indexOf('comment:update:9'));
  assert.equal(updateFailed.events.includes('add:dispatch:ready'), false);
  assert.equal(updateFailed.labels.has('dispatch:ready'), false);
  assert.match(updateFailed.projection, /"conductor":\s*null/);
  assert.equal(updateFailed.counts.updateComment, 2, 'known canonical ID receives one bounded blocked correction');
  assert.ok(updateFailed.failures.some((message: string) => /Canonical comment update failed/.test(message)));

  const createFailedUnknown = makeHarness({
    snapshots: [{ issue: changed }], restIssue: restChanged, initialComments: [], commentWriteFailure: 'create-after-apply',
  });
  await createFailedUnknown.run();
  assert.equal(createFailedUnknown.counts.createComment, 1, 'unknown failed-create ID is never blindly retried');
  assert.equal(createFailedUnknown.labels.has('dispatch:ready'), false);
  assert.ok(createFailedUnknown.failures.some((message: string) => /unknown outcome/.test(message)));

  const duplicateComments = [
    { id: 9, html_url: 'https://example.test/canonical', user: { login: 'github-actions[bot]' }, body: `${admission.ADMISSION_MARKER}\nold projection` },
    { id: 10, html_url: 'https://example.test/duplicate', user: { login: 'github-actions[bot]' }, body: `${admission.ADMISSION_MARKER}\nold duplicate` },
  ];
  const duplicateFailed = makeHarness({
    snapshots: [{ issue: changed }], restIssue: restChanged, initialComments: duplicateComments, commentWriteFailure: 'duplicate',
  });
  await duplicateFailed.run();
  assert.ok(duplicateFailed.events.indexOf('comment:update:9') < duplicateFailed.events.indexOf('comment:update:10'), JSON.stringify(duplicateFailed.events));
  assert.ok(duplicateFailed.events.indexOf('comment:update:10') < duplicateFailed.events.lastIndexOf('comment:update:9'));
  assert.equal(duplicateFailed.labels.has('dispatch:ready'), false);
  assert.match(duplicateFailed.projection, /"conductor":\s*null/);
  assert.ok(duplicateFailed.failures.some((message: string) => /duplicate comment/.test(message)));

  const ordinaryAddFailed = makeHarness({ snapshots: [{ issue: changed }], restIssue: restChanged, ordinaryAddFailure: 'apply-then-throw' });
  await ordinaryAddFailed.run();
  assert.equal(ordinaryAddFailed.labels.has('dispatch:ready'), false);
  assert.match(ordinaryAddFailed.projection, /"conductor":\s*null/);
  assert.ok(ordinaryAddFailed.failures.some((message: string) => /Managed label addition failed/.test(message)));

  const initiallyMissingClassification = {
    ...restChanged,
    labels: ['dispatch:ready', 'kind:implementation', 'shape:interacting', 'profile:complex', 'oracle:not-required'],
  };
  const classificationAddFailed = makeHarness({
    snapshots: [{ issue: changed }], restIssue: initiallyMissingClassification, ordinaryAddFailure: 'apply-then-throw',
  });
  await classificationAddFailed.run();
  assert.equal(classificationAddFailed.labels.has('classification:ready'), false);
  assert.equal(classificationAddFailed.removedLabels.filter((name: string) => name === 'classification:ready').length, 1);
  assert.ok(classificationAddFailed.failures.some((message: string) => /Managed label addition failed/.test(message)));
  assert.ok(classificationAddFailed.labels.has('dispatch:blocked'));

  const refusedClassificationCleanup = makeHarness({
    snapshots: [{ issue: changed }], restIssue: initiallyMissingClassification,
    ordinaryAddFailure: 'apply-then-throw', removeFailures: new Set(['classification:ready']),
  });
  await refusedClassificationCleanup.run();
  assert.equal(refusedClassificationCleanup.labels.has('classification:ready'), true);
  assert.equal(refusedClassificationCleanup.removedLabels.filter((name: string) => name === 'classification:ready').length, 1);
  assert.ok(refusedClassificationCleanup.failures.some((message: string) => /Could not revoke classification:ready exposure/.test(message)));
  assert.ok(refusedClassificationCleanup.failures.some((message: string) => /Managed label addition failed/.test(message)));

  const addDidNotApply = makeHarness({
    snapshots: [{ issue: changed }], restIssue: initiallyMissingClassification, ordinaryAddFailure: 'throw',
  });
  await addDidNotApply.run();
  assert.equal(addDidNotApply.labels.has('classification:ready'), false);
  assert.equal(addDidNotApply.removedLabels.filter((name: string) => name === 'classification:ready').length, 1);
  assert.ok(addDidNotApply.failures.some((message: string) => /already absent/.test(message)), 'HTTP 404 is retained as an unconfirmed cleanup failure');

  const staleRemoveFailed = makeHarness({ snapshots: [{ issue: changed }], restIssue: restChanged, removeFailures: new Set(['profile:complex']) });
  await staleRemoveFailed.run();
  assert.equal(staleRemoveFailed.labels.has('dispatch:ready'), false, JSON.stringify(staleRemoveFailed.events));
  assert.match(staleRemoveFailed.projection, /"conductor":\s*null/);
  assert.ok(staleRemoveFailed.failures.some((message: string) => /Could not revoke profile:complex/.test(message)));
});

test('final dispatch publication error cleans a distinct possible readiness exposure once', async () => {
  const readyIssue = issueSnapshot({ body: formBody('repair') });
  for (const initiallyReady of [false, true]) {
    const projectedLabels = ['classification:ready', 'kind:implementation', 'shape:interacting', 'profile:complex', 'oracle:not-required'];
    if (initiallyReady) projectedLabels.unshift('dispatch:ready');
    const restIssue = {
      ...issueSnapshot(), node_id: ISSUE_ID, number: 1, body: readyIssue.body, state: 'open',
      created_at: readyIssue.createdAt, updated_at: readyIssue.updatedAt, author_association: readyIssue.authorAssociation,
      user: { node_id: OWNER_ID }, labels: projectedLabels,
    };
    const harness = makeHarness({ snapshots: [{ issue: readyIssue }], restIssue, finalReadyAddFailure: true });
    await harness.run();
    assert.equal(harness.labels.has('dispatch:ready'), false);
    assert.ok(harness.labels.has('dispatch:blocked'));
    assert.match(harness.projection, /"conductor":\s*null/);
    assert.equal(harness.removedLabels.filter((name: string) => name === 'dispatch:ready').length, initiallyReady ? 2 : 1,
      'the uncertain final grant gets a distinct single cleanup attempt, whether or not ready existed initially');
    assert.equal(harness.events.filter((event: string) => event === 'add:dispatch:ready').length, 1);
    assert.ok(harness.failures.some((message: string) => /possible new exposure/.test(message)));
  }
});

test('manual workflow dispatch with a pull request number performs no reads or writes after target fetch', async () => {
  const harness = makeHarness({ pullRequest: true });
  await harness.run();
  assert.equal(harness.counts.graphql, 0);
  assert.equal(harness.counts.commentsRead, 0);
  assert.equal(harness.counts.labelBootstrap, 0);
  assert.equal(harness.counts.addLabels + harness.counts.removeLabel + harness.counts.createComment + harness.counts.updateComment, 0);
});
