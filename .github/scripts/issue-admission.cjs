'use strict';

const crypto = require('node:crypto');

const AUTHORITY_SNAPSHOT_QUERY = `
  query TachikoIssueAdmission($owner: String!, $repo: String!, $number: Int!, $commentCursor: String, $deletionCursor: String) {
    repository(owner: $owner, name: $repo) {
      id
      nameWithOwner
      owner {
        __typename
        ... on User { id login }
      }
      issue(number: $number) {
        id
        number
        body
        state
        createdAt
        updatedAt
        lastEditedAt
        authorAssociation
        author { __typename ... on User { id login } }
        editor { __typename ... on User { id login } }
        repository { id }
        comments(first: 100, after: $commentCursor) {
          edges {
            cursor
            node {
              id
              body
              createdAt
              lastEditedAt
              authorAssociation
              author { __typename ... on User { id login } }
              editor { __typename ... on User { id login } }
              issue { id number repository { id } }
              url
            }
          }
          pageInfo { hasNextPage endCursor }
        }
        timelineItems(first: 100, after: $deletionCursor, itemTypes: [COMMENT_DELETED_EVENT]) {
          edges {
            cursor
            node { __typename ... on CommentDeletedEvent { id createdAt actor { __typename } } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pullRequest(number: $number) { id number }
    }
  }
`;

const AUTHORITY_MARKER = '<!-- steward-task-authority:v1 -->';
const LEGACY_AUTHORITY_MARKER = '<!-- steward-task-shape-authority:v1 -->';
const ADMISSION_MARKER = '<!-- tachiko-issue-admission:v1 -->';

const TASK_KINDS = Object.freeze([
  'implementation',
  'repair',
  'research',
  'decision',
  'operational',
  'coordination',
  'tracking',
]);
const TASK_SHAPES = Object.freeze(['bounded', 'interacting', 'decision']);
const WRITER_KINDS = new Set(['implementation', 'repair']);
const TRUSTED_ASSOCIATIONS = new Set(['OWNER']);

const LABEL_DEFINITIONS = Object.freeze({
  'kind:implementation': { color: '1f6feb', description: 'Repository implementation work.' },
  'kind:repair': { color: '388bfd', description: 'Repository implementation repair work.' },
  'kind:research': { color: '8250df', description: 'Read-only research/evidence work.' },
  'kind:decision': { color: 'a371f7', description: 'Steward/Oracle decision boundary; zero implementation writer.' },
  'kind:operational': { color: 'fb8f44', description: 'Operational/runtime action; not implementation dispatch.' },
  'kind:coordination': { color: 'd29922', description: 'Roadmap/dependency/state coordination work.' },
  'kind:tracking': { color: '8c959f', description: 'Tracking/source-of-truth issue; no implementation writer.' },
  'shape:bounded': { color: '2da44e', description: 'Task shape admits the routine execution profile.' },
  'shape:interacting': { color: 'bf8700', description: 'Task shape requires the complex execution profile.' },
  'shape:decision': { color: 'a371f7', description: 'Task shape requires a decision boundary and zero writer.' },
  'profile:routine': { color: '2da44e', description: 'Provider-neutral routine implementation profile.' },
  'profile:complex': { color: 'd97706', description: 'Provider-neutral complex implementation profile.' },
  'oracle:required': { color: 'a371f7', description: 'Steward/Oracle decision required before implementation.' },
  'oracle:not-required': { color: '6e7781', description: 'No pre-implementation Oracle decision required.' },
  'classification:ready': { color: '2da44e', description: 'Trusted task classification is complete.' },
  'needs:classification': { color: 'cf222e', description: 'Task classification is missing, invalid, or conflicting.' },
  'needs:steward': { color: 'bf8700', description: 'Valid proposal exists but trusted Steward authority is still required.' },
  'dispatch:ready': { color: '1a7f37', description: 'Eligible for implementation queue admission; does not enqueue by itself.' },
  'dispatch:blocked': { color: 'cf222e', description: 'Not eligible for implementation dispatch.' },
});
const MANAGED_LABELS = new Set(Object.keys(LABEL_DEFINITIONS));

function trustedAssociation(value) {
  return typeof value === 'string' && TRUSTED_ASSOCIATIONS.has(value.toUpperCase());
}

function parseJsonAfterMarker(text, marker) {
  if (typeof text !== 'string') return { found: false };
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return { found: false };
  const tail = text.slice(markerIndex + marker.length);
  const fenced = /```json\s*([\s\S]*?)```/i.exec(tail);
  if (fenced === null) return { found: true, error: `Marker ${marker} must be followed by a JSON code block.` };
  try {
    return { found: true, value: JSON.parse(fenced[1]) };
  } catch {
    return { found: true, error: `Marker ${marker} contains invalid JSON.` };
  }
}

function field(body, label) {
  if (typeof body !== 'string') return undefined;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // GitHub Issue Forms serialize each answer between blank-line-delimited
  // headings. Normalize line endings first so CRLF bodies use the same
  // boundaries, and require a complete heading line to avoid matching a
  // heading-like line embedded in another answer.
  const normalizedBody = body.replace(/\r\n?/g, '\n');
  const match = new RegExp(`(?:^|\\n\\n)### ${escaped}\\n([\\s\\S]*?)(?=\\n\\n### [^\\n]+\\n|$)`).exec(normalizedBody);
  if (match === null) return undefined;
  const value = match[1].trim();
  if (value === '' || /^_No response_$/i.test(value)) return undefined;
  return value;
}

const REQUIRED_WRITER_FORM_FIELDS = Object.freeze([
  'Kind',
  'Task shape',
  'Classification reason',
  'Goal',
  'Scope',
  'Non-goals',
  'Acceptance criteria',
  'Dependencies',
  'Stop conditions',
]);

function normalizeKind(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return TASK_KINDS.includes(normalized) ? normalized : undefined;
}

function normalizeShape(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return TASK_SHAPES.includes(normalized) ? normalized : undefined;
}

function expectedProfile(kind, shape) {
  if (!WRITER_KINDS.has(kind)) return null;
  if (shape === 'bounded') return 'routine';
  if (shape === 'interacting') return 'complex';
  return null;
}

function validateNormalizedAuthority(authority) {
  const errors = [];
  if (!TASK_KINDS.includes(authority.kind)) errors.push(`Unsupported task kind ${JSON.stringify(authority.kind)}.`);

  if (WRITER_KINDS.has(authority.kind)) {
    if (!TASK_SHAPES.includes(authority.shape)) errors.push('Implementation/repair requires shape bounded, interacting, or decision.');
    const expected = expectedProfile(authority.kind, authority.shape);
    if (authority.executionProfile !== expected) {
      errors.push(`Task shape ${JSON.stringify(authority.shape)} requires executionProfile ${JSON.stringify(expected)}.`);
    }
    const expectedOracle = authority.shape === 'decision';
    if (authority.oracleRequired !== expectedOracle) {
      errors.push(`Task shape ${JSON.stringify(authority.shape)} requires oracleRequired=${expectedOracle}.`);
    }
  } else if (authority.kind === 'decision') {
    if (authority.shape !== 'decision') errors.push('Decision issues require shape="decision".');
    if (authority.executionProfile !== null) errors.push('Decision issues must not select an implementation execution profile.');
    if (authority.oracleRequired !== true) errors.push('Decision issues require oracleRequired=true.');
  } else {
    if (authority.shape !== null) errors.push(`${authority.kind} issues must not select an implementation task shape.`);
    if (authority.executionProfile !== null) errors.push(`${authority.kind} issues must not select an implementation execution profile.`);
    if (authority.oracleRequired !== false) errors.push(`${authority.kind} issues require oracleRequired=false; use a decision issue for a decision boundary.`);
  }
  return errors;
}

function normalizeExplicitAuthority(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'Steward task authority must be a JSON object.' };
  }
  const allowed = new Set(['revision', 'kind', 'shape', 'executionProfile', 'oracleRequired']);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { error: `Steward task authority contains unsupported fields: ${unknown.join(', ')}.` };
  const revision = typeof raw.revision === 'string' ? raw.revision.trim() : '';
  if (revision === '') return { error: 'Steward task authority requires a non-empty revision.' };
  const kind = normalizeKind(raw.kind);
  if (kind === undefined) return { error: 'Steward task authority requires a supported kind.' };
  const shape = normalizeShape(raw.shape);
  if (shape === undefined) return { error: 'Steward task authority requires shape bounded/interacting/decision or null.' };
  const executionProfile = raw.executionProfile === null
    ? null
    : (raw.executionProfile === 'routine' || raw.executionProfile === 'complex' ? raw.executionProfile : undefined);
  if (executionProfile === undefined) return { error: 'Steward task authority requires executionProfile routine/complex or null.' };
  if (typeof raw.oracleRequired !== 'boolean') return { error: 'Steward task authority requires boolean oracleRequired.' };
  const authority = { revision, kind, shape, executionProfile, oracleRequired: raw.oracleRequired };
  const errors = validateNormalizedAuthority(authority);
  return errors.length === 0 ? { authority } : { error: errors.join(' ') };
}

function normalizeLegacyShapeAuthority(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'Legacy task-shape authority must be a JSON object.' };
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== 'revision,shape') return { error: 'Legacy task-shape authority must contain only revision and shape.' };
  const revision = typeof raw.revision === 'string' ? raw.revision.trim() : '';
  const shape = normalizeShape(raw.shape);
  if (revision === '' || shape === undefined || shape === null) return { error: 'Legacy task-shape authority requires non-empty revision and bounded/interacting/decision shape.' };
  const authority = {
    revision,
    kind: 'implementation',
    shape,
    executionProfile: expectedProfile('implementation', shape),
    oracleRequired: shape === 'decision',
  };
  const errors = validateNormalizedAuthority(authority);
  return errors.length === 0 ? { authority } : { error: errors.join(' ') };
}

function formProposal(issue) {
  const kind = normalizeKind(field(issue.body, 'Kind'));
  if (kind === undefined) return { error: 'Issue Form field "Kind" is missing or unsupported.' };
  let shape = null;
  let executionProfile = null;
  let oracleRequired = false;
  if (WRITER_KINDS.has(kind)) {
    const missing = REQUIRED_WRITER_FORM_FIELDS.filter((label) => field(issue.body, label) === undefined);
    if (missing.length > 0) {
      return { error: `Implementation/repair Issue Form requires non-empty fields: ${missing.join(', ')}.` };
    }
    shape = normalizeShape(field(issue.body, 'Task shape'));
    if (shape === undefined || shape === null) return { error: 'Implementation/repair Issue Form requires "Task shape".' };
    executionProfile = expectedProfile(kind, shape);
    oracleRequired = shape === 'decision';
  } else if (kind === 'decision') {
    shape = 'decision';
    executionProfile = null;
    oracleRequired = true;
  }
  const seed = { kind, shape, executionProfile, oracleRequired };
  const sourceBody = typeof issue.body === 'string' ? issue.body : '';
  const digest = crypto.createHash('sha256').update(JSON.stringify({ ...seed, sourceBody })).digest('hex').slice(0, 12);
  return { authority: { revision: `issue-form-v1:${digest}`, ...seed } };
}

function authorityFromTrustedComment(comment) {
  if (comment === undefined) return undefined;
  const explicit = parseJsonAfterMarker(comment.body, AUTHORITY_MARKER);
  const legacy = parseJsonAfterMarker(comment.body, LEGACY_AUTHORITY_MARKER);
  if (explicit.found && legacy.found) return { error: 'Trusted authority comment contains both v1 and legacy authority markers.' };
  if (explicit.found) {
    if (explicit.error) return { error: explicit.error };
    return normalizeExplicitAuthority(explicit.value);
  }
  if (legacy.found) {
    if (legacy.error) return { error: legacy.error };
    return normalizeLegacyShapeAuthority(legacy.value);
  }
  return undefined;
}

function authorityFromTrustedBody(issue) {
  if (!trustedAssociation(issue.author_association)) return undefined;
  const explicit = parseJsonAfterMarker(issue.body, AUTHORITY_MARKER);
  if (!explicit.found) return undefined;
  if (explicit.error) return { error: explicit.error };
  return normalizeExplicitAuthority(explicit.value);
}

function readyDecision(authority, source, issueState = 'open') {
  const labels = [`kind:${authority.kind}`, 'classification:ready'];
  if (authority.shape !== null) labels.push(`shape:${authority.shape}`);
  if (authority.executionProfile !== null) labels.push(`profile:${authority.executionProfile}`);
  labels.push(authority.oracleRequired ? 'oracle:required' : 'oracle:not-required');
  const dispatchReady = issueState === 'open' && WRITER_KINDS.has(authority.kind) && (authority.shape === 'bounded' || authority.shape === 'interacting');
  labels.push(dispatchReady ? 'dispatch:ready' : 'dispatch:blocked');
  const conductor = dispatchReady
    ? {
        executionProfile: authority.executionProfile,
        taskShapeAuthority: { revision: authority.revision, shape: authority.shape },
      }
    : null;
  return {
    status: 'ready',
    trusted: true,
    source,
    dispatch: dispatchReady ? 'ready' : 'blocked',
    authority,
    conductor,
    errors: [],
    labels,
  };
}

function blockedDecision({ source, authority = null, error, needsSteward = false }) {
  const labels = [needsSteward ? 'needs:steward' : 'needs:classification', 'dispatch:blocked'];
  return {
    status: 'blocked',
    trusted: false,
    source,
    dispatch: 'blocked',
    authority,
    conductor: null,
    errors: [error],
    labels,
  };
}

function snapshotError(message, targetMismatch = false) {
  const error = new Error(message);
  error.name = 'AdmissionSnapshotError';
  error.targetMismatch = targetMismatch;
  return error;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (month < 1 || month > 12 || day < 1 || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHourText !== undefined && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function canonicalTime(value) {
  return validTimestamp(value) ? Date.parse(value) : undefined;
}

function actorIsOwner(actor, ownerId) {
  return actor !== null && typeof actor === 'object' && actor.__typename === 'User' &&
    typeof actor.id === 'string' && actor.id === ownerId;
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw snapshotError(`${label} is missing or malformed.`);
  return value;
}

function assertField(object, key, label) {
  if (!Object.prototype.hasOwnProperty.call(object, key)) throw snapshotError(`${label}.${key} was not returned by GitHub.`);
  return object[key];
}

function connectionPage(connection, label, afterCursor) {
  assertObject(connection, label);
  const edges = assertField(connection, 'edges', label);
  const pageInfo = assertObject(assertField(connection, 'pageInfo', label), `${label}.pageInfo`);
  if (!Array.isArray(edges)) throw snapshotError(`${label}.edges is malformed.`);
  const hasNextPage = assertField(pageInfo, 'hasNextPage', `${label}.pageInfo`);
  const endCursor = assertField(pageInfo, 'endCursor', `${label}.pageInfo`);
  if (typeof hasNextPage !== 'boolean') throw snapshotError(`${label}.hasNextPage is malformed.`);
  if (endCursor !== null && (typeof endCursor !== 'string' || endCursor === '')) throw snapshotError(`${label}.endCursor is malformed.`);
  if (edges.length > 0 && (typeof endCursor !== 'string' || edges[edges.length - 1]?.cursor !== endCursor)) {
    throw snapshotError(`${label} end cursor does not match its last edge.`);
  }
  if (hasNextPage && (typeof endCursor !== 'string' || endCursor === '' || endCursor === afterCursor || edges.length === 0)) {
    throw snapshotError(`${label} pagination did not advance.`);
  }
  return { edges, hasNextPage, endCursor };
}

function issueCore(repository, issue, pullRequest, expected) {
  assertObject(repository, 'repository');
  if (typeof repository.id !== 'string' || repository.id === '' ||
      (expected.repositoryId && repository.id !== expected.repositoryId)) {
    throw snapshotError('Repository identity does not match the requested repository.', true);
  }
  if (typeof repository.nameWithOwner !== 'string' || repository.nameWithOwner.toLowerCase() !== `${expected.owner}/${expected.repo}`.toLowerCase()) {
    throw snapshotError('Repository name does not match the requested repository.', true);
  }
  const owner = assertObject(assertField(repository, 'owner', 'repository'), 'repository.owner');
  if (owner.__typename !== 'User' || typeof owner.id !== 'string' || owner.id === '' || typeof owner.login !== 'string') {
    throw snapshotError('Repository owner is not a supported personal User.');
  }
  if (issue === null) {
    if (pullRequest !== null && typeof pullRequest === 'object' && pullRequest.number === expected.number) return { pullRequest: true, owner };
    throw snapshotError('The target is not a positively identified Issue.');
  }
  assertObject(issue, 'issue');
  if (issue.number !== expected.number || issue.repository?.id !== repository.id || typeof issue.id !== 'string' || issue.id === '') {
    throw snapshotError('Issue identity does not match the requested repository and number.', true);
  }
  if (typeof issue.body !== 'string' || !['OPEN', 'CLOSED'].includes(issue.state) || !validTimestamp(issue.createdAt) || !validTimestamp(issue.updatedAt)) {
    throw snapshotError('Issue body, state, or timestamps are missing or malformed.');
  }
  if (!Object.prototype.hasOwnProperty.call(issue, 'lastEditedAt') || !Object.prototype.hasOwnProperty.call(issue, 'editor')) {
    throw snapshotError('Issue edit provenance was not returned.');
  }
  if (issue.lastEditedAt !== null && !validTimestamp(issue.lastEditedAt)) throw snapshotError('Issue lastEditedAt is malformed.');
  const issueCreated = Date.parse(issue.createdAt);
  const issueUpdated = Date.parse(issue.updatedAt);
  const issueEdited = issue.lastEditedAt === null ? null : Date.parse(issue.lastEditedAt);
  if (issueCreated > issueUpdated || (issueEdited !== null && (issueEdited < issueCreated || issueEdited > issueUpdated))) {
    throw snapshotError('Issue timestamps are chronologically inconsistent.');
  }
  if (typeof issue.authorAssociation !== 'string' || issue.authorAssociation === '') throw snapshotError('Issue author association is unavailable.');
  assertObject(issue.author, 'issue.author');
  if (issue.author.__typename !== 'User' || typeof issue.author.id !== 'string' || issue.author.id === '') throw snapshotError('Issue author is not a supported User.');
  if (issue.editor !== null) {
    assertObject(issue.editor, 'issue.editor');
    if (issue.editor.__typename !== 'User' || typeof issue.editor.id !== 'string' || issue.editor.id === '') throw snapshotError('Issue editor is not a supported User.');
  }
  if (issue.lastEditedAt === null && issue.editor !== null) throw snapshotError('Unedited Issue has inconsistent editor provenance.');
  if (issue.lastEditedAt !== null && issue.editor === null) throw snapshotError('Edited Issue has no authenticated editor.');
  return { pullRequest: false, owner, issue };
}

function appendPageRows(connection, label, afterCursor, seenCursors, seenIds, output, project) {
  const page = connectionPage(connection, label, afterCursor);
  for (const edgeValue of page.edges) {
    const edge = assertObject(edgeValue, `${label}.edge`);
    if (typeof edge.cursor !== 'string' || edge.cursor === '' || seenCursors.has(edge.cursor)) throw snapshotError(`${label} has a missing or duplicate cursor.`);
    seenCursors.add(edge.cursor);
    const node = assertObject(edge.node, `${label}.node`);
    const id = assertField(node, 'id', `${label}.node`);
    if (typeof id !== 'string' || id === '' || seenIds.has(id)) throw snapshotError(`${label} has a missing or duplicate node ID.`);
    seenIds.add(id);
    output.push(project(node, edge.cursor));
  }
  return page;
}

async function fetchAuthoritySnapshot(github, { owner, repo, number, expectedRepositoryId }) {
  if (typeof github?.graphql !== 'function') throw snapshotError('Authenticated GitHub GraphQL is unavailable.');
  const expected = { owner, repo, number, repositoryId: expectedRepositoryId };
  let commentCursor = null;
  let deletionCursor = null;
  let commentsDone = false;
  let deletionsDone = false;
  let core;
  let repositoryId;
  let repositoryOwner;
  const comments = [];
  const deletions = [];
  const commentCursors = new Set();
  const deletionCursors = new Set();
  const commentIds = new Set();
  const deletionIds = new Set();

  for (;;) {
    const response = assertObject(await github.graphql(AUTHORITY_SNAPSHOT_QUERY, {
      owner, repo, number, commentCursor, deletionCursor,
    }), 'GraphQL response');
    if (Array.isArray(response.errors) && response.errors.length > 0) throw snapshotError('GitHub GraphQL returned partial or error data.');
    const data = assertObject(assertField(response, 'repository', 'GraphQL response'), 'GraphQL response.repository');
    const repository = assertObject(data, 'repository');
    if (typeof repository.id !== 'string' || repository.id === '') throw snapshotError('Repository ID is unavailable.');
    const result = issueCore(repository, assertField(repository, 'issue', 'repository'), assertField(repository, 'pullRequest', 'repository'), expected);
    if (result.pullRequest) return { pullRequest: true, repositoryId: repository.id };
    const issue = result.issue;
    const currentCore = {
      id: issue.id,
      number: issue.number,
      body: issue.body,
      state: issue.state,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      lastEditedAt: issue.lastEditedAt,
      authorAssociation: issue.authorAssociation,
      author: issue.author,
      editor: issue.editor,
      repositoryId: issue.repository.id,
    };
    const serializedCore = JSON.stringify(currentCore);
    if (core !== undefined && core !== serializedCore) throw snapshotError('Issue snapshot changed during paginated provenance reads.');
    core = serializedCore;
    if (repositoryId !== undefined && repositoryId !== repository.id) throw snapshotError('Repository identity changed during pagination.');
    if (repositoryOwner !== undefined && (repositoryOwner.id !== result.owner.id || repositoryOwner.__typename !== result.owner.__typename)) {
      throw snapshotError('Repository owner identity changed during pagination.');
    }
    repositoryId = repository.id;
    repositoryOwner = result.owner;

    const commentPage = commentsDone ? null : appendPageRows(issue.comments, 'comments', commentCursor, commentCursors, commentIds, comments, (node) => {
      const parent = assertObject(assertField(node, 'issue', 'comment'), 'comment.issue');
      if (parent.id !== issue.id || parent.number !== number || parent.repository?.id !== repository.id) throw snapshotError('Comment parent or repository does not match the target Issue.');
      for (const key of ['body', 'createdAt', 'lastEditedAt', 'authorAssociation', 'author', 'editor']) {
        assertField(node, key, 'comment');
      }
      if (typeof node.body !== 'string' || !validTimestamp(node.createdAt) || typeof node.authorAssociation !== 'string') throw snapshotError('Comment content or creation provenance is malformed.');
      if (node.lastEditedAt !== null && !validTimestamp(node.lastEditedAt)) throw snapshotError('Comment lastEditedAt is malformed.');
      const commentCreated = Date.parse(node.createdAt);
      if (commentCreated < Date.parse(issue.createdAt) ||
          (node.lastEditedAt !== null && commentCreated > Date.parse(node.lastEditedAt))) {
        throw snapshotError('Comment timestamps are chronologically inconsistent.');
      }
      if (node.author !== null) assertObject(node.author, 'comment.author');
      if (node.editor !== null) assertObject(node.editor, 'comment.editor');
      if (node.lastEditedAt === null && node.editor !== null) throw snapshotError('Unedited comment has inconsistent editor provenance.');
      if (node.lastEditedAt !== null && node.editor === null) throw snapshotError('Edited comment has no editor provenance.');
      return { id: node.id, body: node.body, created_at: node.createdAt, last_edited_at: node.lastEditedAt,
        author_association: node.authorAssociation, author: node.author, editor: node.editor,
        parent_issue_id: parent.id, parent_issue_number: parent.number, repository_id: parent.repository.id, url: node.url };
    });
    const deletionPage = deletionsDone ? null : appendPageRows(issue.timelineItems, 'deletion timeline', deletionCursor, deletionCursors, deletionIds, deletions, (node) => {
      if (node.__typename !== 'CommentDeletedEvent' || !validTimestamp(node.createdAt) || !Object.prototype.hasOwnProperty.call(node, 'actor')) {
        throw snapshotError('Deletion timeline contains an unsupported or malformed event.');
      }
      if (Date.parse(node.createdAt) < Date.parse(issue.createdAt)) throw snapshotError('Deletion event predates its parent Issue.');
      if (node.actor !== null && (typeof node.actor !== 'object' || typeof node.actor.__typename !== 'string')) {
        throw snapshotError('Deletion event actor is malformed.');
      }
      return { id: node.id, created_at: node.createdAt, actor_type: node.actor?.__typename ?? null };
    });
    if (commentPage !== null) {
      commentsDone = !commentPage.hasNextPage;
      if (typeof commentPage.endCursor === 'string') commentCursor = commentPage.endCursor;
    }
    if (deletionPage !== null) {
      deletionsDone = !deletionPage.hasNextPage;
      if (typeof deletionPage.endCursor === 'string') deletionCursor = deletionPage.endCursor;
    }
    if (commentsDone && deletionsDone) break;
  }

  if (!core || !repositoryId || !repositoryOwner) throw snapshotError('Provenance snapshot is incomplete.');
  const issue = JSON.parse(core);
  const snapshot = { repositoryId, repositoryOwner, issue, comments, deletions, pullRequest: false };
  snapshot.evidenceFingerprint = snapshotFingerprint(snapshot);
  snapshot.decision = classifyVerifiedSnapshot(snapshot);
  return snapshot;
}

function contentTime(record, prefix) {
  if (record.last_edited_at === null) return canonicalTime(record.created_at);
  return canonicalTime(record.last_edited_at);
}

function bodyDigest(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

function snapshotFingerprint(snapshot) {
  const projection = {
    repositoryId: snapshot.repositoryId,
    ownerId: snapshot.repositoryOwner.id,
    issue: {
      id: snapshot.issue.id,
      number: snapshot.issue.number,
      bodySha256: bodyDigest(snapshot.issue.body),
      state: snapshot.issue.state,
      createdAt: snapshot.issue.createdAt,
      updatedAt: snapshot.issue.updatedAt,
      lastEditedAt: snapshot.issue.lastEditedAt,
      authorAssociation: snapshot.issue.authorAssociation,
      author: snapshot.issue.author,
      editor: snapshot.issue.editor,
    },
    comments: snapshot.comments.map((comment) => ({
      id: comment.id, bodySha256: bodyDigest(comment.body), createdAt: comment.created_at,
      lastEditedAt: comment.last_edited_at, authorAssociation: comment.author_association,
      author: comment.author, editor: comment.editor, parentIssueId: comment.parent_issue_id,
      parentIssueNumber: comment.parent_issue_number, repositoryId: comment.repository_id,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    deletions: snapshot.deletions.map((event) => ({ id: event.id, createdAt: event.created_at, actorType: event.actor_type ?? null })).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return crypto.createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

function provenanceFor(snapshot, source, authorityComment, contentTimestamp, holdReason) {
  return {
    repositoryId: snapshot.repositoryId,
    repositoryOwnerId: snapshot.repositoryOwner.id,
    issueId: snapshot.issue.id,
    issueNumber: snapshot.issue.number,
    issueBodySha256: bodyDigest(snapshot.issue.body),
    issueBodyContentTime: snapshot.issue.lastEditedAt ?? snapshot.issue.createdAt,
    issueAuthorId: snapshot.issue.author?.id ?? null,
    issueEditorId: snapshot.issue.editor?.id ?? null,
    source,
    authorityCommentId: authorityComment?.id ?? null,
    authorityBodySha256: authorityComment ? bodyDigest(authorityComment.body) : bodyDigest(snapshot.issue.body),
    authorityContentTime: contentTimestamp ?? null,
    authorityAuthorId: authorityComment?.author?.id ?? snapshot.issue.author?.id ?? null,
    authorityEditorId: authorityComment?.editor?.id ?? snapshot.issue.editor?.id ?? null,
    deletionEvents: snapshot.deletions.map((event) => ({ id: event.id, createdAt: event.created_at, actorType: event.actor_type ?? null })),
    snapshotSha256: snapshotFingerprint(snapshot),
    holdReason: holdReason ?? null,
  };
}

function heldDecision(snapshot, reason, { needsSteward = false, source = 'provenance' } = {}) {
  const decision = blockedDecision({ source, error: reason, needsSteward });
  decision.provenance = provenanceFor(snapshot, source, undefined, undefined, reason);
  return decision;
}

function classifyVerifiedSnapshot(snapshot) {
  const ownerId = snapshot.repositoryOwner.id;
  const issue = snapshot.issue;
  const issueCreated = canonicalTime(issue.createdAt);
  const issueContent = canonicalTime(issue.lastEditedAt ?? issue.createdAt);
  if (issueCreated === undefined || issueContent === undefined) return heldDecision(snapshot, 'Issue content timestamp is unavailable.');

  const ownerCommentRows = [];
  for (const comment of snapshot.comments) {
    const originalOwnerClaim = comment.author_association === 'OWNER';
    const authorMatches = actorIsOwner(comment.author, ownerId);
    const markerPresent = comment.body.includes(AUTHORITY_MARKER) || comment.body.includes(LEGACY_AUTHORITY_MARKER);
    if (!originalOwnerClaim) continue;
    const time = contentTime(comment);
    const currentEditorOwner = comment.last_edited_at === null
      ? comment.editor === null
      : actorIsOwner(comment.editor, ownerId);
    ownerCommentRows.push({ comment, time, markerPresent, currentEditorOwner, identityValid: authorMatches });
  }

  const trustedRows = ownerCommentRows.filter((row) => row.markerPresent && row.identityValid && row.comment.author_association === 'OWNER' && row.currentEditorOwner && row.time !== undefined);
  trustedRows.sort((a, b) => a.time - b.time || a.comment.id.localeCompare(b.comment.id));
  const latestTrusted = trustedRows.at(-1);
  const suspiciousRows = ownerCommentRows.filter((row) => {
    if (!row.identityValid) return row.time === undefined || row.time >= (latestTrusted?.time ?? issueContent);
    if (!row.markerPresent && row.comment.last_edited_at === null) return false;
    if (row === latestTrusted) return false;
    return row.time === undefined || row.time >= (latestTrusted?.time ?? issueContent);
  });
  if (suspiciousRows.length > 0) return heldDecision(snapshot, 'An OWNER-origin comment has missing, changed, or unverifiable current-content provenance; a later OWNER reaffirmation is required.', { source: 'steward-comment' });

  let authority;
  let source;
  let selectedComment;
  let selectedTime;
  if (latestTrusted !== undefined) {
    if (latestTrusted.time <= issueContent) return heldDecision(snapshot, 'Trusted authority comment is not strictly later than the current Issue body; OWNER reaffirmation is required.', { source: 'steward-comment' });
    const parsed = authorityFromTrustedComment({
      body: latestTrusted.comment.body,
      author_association: latestTrusted.comment.author_association,
      created_at: latestTrusted.comment.created_at,
      id: latestTrusted.comment.id,
    });
    if (parsed?.error) return heldDecision(snapshot, parsed.error, { source: 'steward-comment' });
    if (!parsed?.authority) return heldDecision(snapshot, 'Latest trusted authority comment is invalid; older authority cannot be used.', { source: 'steward-comment' });
    authority = parsed.authority;
    source = 'steward-comment';
    selectedComment = latestTrusted.comment;
    selectedTime = latestTrusted.comment.last_edited_at ?? latestTrusted.comment.created_at;
  } else {
    const bodyOwner = issue.authorAssociation === 'OWNER' && actorIsOwner(issue.author, ownerId);
    const bodyEditorOwner = issue.lastEditedAt === null ? issue.editor === null : actorIsOwner(issue.editor, ownerId);
    const explicitMarker = issue.body.includes(AUTHORITY_MARKER);
    if (explicitMarker && (!bodyOwner || !bodyEditorOwner)) return heldDecision(snapshot, 'Explicit Issue-body authority has no authenticated current OWNER content provenance.', { source: 'steward-body' });
    if (bodyOwner && !bodyEditorOwner) return heldDecision(snapshot, 'OWNER Issue Form body was edited by an unauthenticated actor; current form content is only a proposal.', { needsSteward: true, source: 'issue-form' });
    const parsedBody = bodyOwner && bodyEditorOwner ? authorityFromTrustedBody({ author_association: issue.authorAssociation, body: issue.body }) : undefined;
    if (parsedBody?.error) return heldDecision(snapshot, parsedBody.error, { source: 'steward-body' });
    if (parsedBody?.authority) {
      authority = parsedBody.authority;
      source = 'steward-body';
    } else {
      const proposal = formProposal({ body: issue.body });
      if (proposal.error) return heldDecision(snapshot, proposal.error, { source: 'issue-form' });
      authority = proposal.authority;
      if (!bodyOwner || !bodyEditorOwner) {
        const decision = blockedDecision({ source: 'issue-form', authority, error: 'Issue Form is only a proposal because current content is not authenticated as OWNER authority.', needsSteward: true });
        decision.provenance = provenanceFor(snapshot, 'issue-form', undefined, issue.lastEditedAt ?? issue.createdAt, undefined);
        source = 'issue-form';
        return decision;
      }
      source = 'issue-form';
    }
    selectedTime = issue.lastEditedAt ?? issue.createdAt;
  }

  const selectedMillis = canonicalTime(selectedTime);
  if (selectedMillis === undefined) return heldDecision(snapshot, 'Selected authority content time is unavailable.', { source });
  for (const event of snapshot.deletions) {
    const deletedAt = canonicalTime(event.created_at);
    if (deletedAt === undefined) return heldDecision(snapshot, 'A comment deletion event has an invalid timestamp.', { source });
    if (deletedAt >= selectedMillis) return heldDecision(snapshot, 'A comment was deleted at or after the selected authority content; a later OWNER reaffirmation is required.', { source });
  }

  const decision = readyDecision(authority, source, issue.state === 'OPEN' ? 'open' : 'closed');
  decision.provenance = provenanceFor(snapshot, source, selectedComment, selectedTime, undefined);
  return decision;
}

function blockedUnavailableProvenance(reason, observed = {}) {
  const decision = blockedDecision({ source: 'provenance', error: `Authority provenance is unavailable: ${reason}` });
  decision.provenance = {
    status: 'unavailable',
    repositoryId: observed.repositoryId ?? null,
    issueId: observed.issueId ?? null,
    issueNumber: observed.issueNumber ?? null,
    observedIssueBodySha256: typeof observed.body === 'string' ? bodyDigest(observed.body) : null,
    observedSnapshotSha256: observed.snapshotSha256 ?? null,
    holdReason: reason,
  };
  return decision;
}

function reconcileLabels(existingLabels, desiredManagedLabels) {
  const keep = (existingLabels ?? []).filter((label) => !MANAGED_LABELS.has(label));
  return [...new Set([...keep, ...desiredManagedLabels])].sort();
}

function renderAdmission(decision) {
  const payload = {
    schemaVersion: 1,
    status: decision.status,
    source: decision.source,
    trusted: decision.trusted,
    dispatch: decision.dispatch,
    authority: decision.authority,
    conductor: decision.conductor,
    errors: decision.errors,
    provenance: decision.provenance ?? null,
  };
  const note = decision.dispatch === 'ready'
    ? 'Classification is complete and may be admitted to the separate implementation queue. This comment does not enqueue work by itself.'
    : 'Implementation dispatch remains blocked. Non-implementation work stays outside the implementation dispatcher by design.';
  return `${ADMISSION_MARKER}\n## Tachiko issue admission\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${note}\n\nManaged by \`.github/workflows/issue-admission.yml\`; edit task authority, not this projection.`;
}

module.exports = {
  ADMISSION_MARKER,
  AUTHORITY_SNAPSHOT_QUERY,
  AUTHORITY_MARKER,
  LEGACY_AUTHORITY_MARKER,
  LABEL_DEFINITIONS,
  MANAGED_LABELS,
  TASK_KINDS,
  TASK_SHAPES,
  TRUSTED_ASSOCIATIONS,
  expectedProfile,
  fetchAuthoritySnapshot,
  field,
  normalizeExplicitAuthority,
  reconcileLabels,
  renderAdmission,
  blockedUnavailableProvenance,
  trustedAssociation,
};
