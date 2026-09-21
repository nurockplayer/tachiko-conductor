'use strict';

const crypto = require('node:crypto');

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
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const LABEL_DEFINITIONS = Object.freeze({
  'kind:implementation': { color: '1f6feb', description: 'Repository implementation work.' },
  'kind:repair': { color: '388bfd', description: 'Bounded implementation repair work.' },
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
  const match = new RegExp(`(?:^|\\n)### ${escaped}\\r?\\n+([\\s\\S]*?)(?=\\n### |$)`, 'm').exec(body);
  if (match === null) return undefined;
  const value = match[1].trim();
  if (value === '' || value === '_No response_') return undefined;
  return value;
}

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

function latestTrustedAuthorityComment(comments) {
  const trusted = (comments ?? []).filter((comment) => trustedAssociation(comment.author_association));
  const candidates = [];
  for (const comment of trusted) {
    const body = typeof comment.body === 'string' ? comment.body : '';
    if (body.includes(AUTHORITY_MARKER) || body.includes(LEGACY_AUTHORITY_MARKER)) candidates.push(comment);
  }
  candidates.sort((a, b) => {
    const ta = Date.parse(a.created_at ?? '') || 0;
    const tb = Date.parse(b.created_at ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id ?? 0) - Number(b.id ?? 0);
  });
  return candidates.at(-1);
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

function classifyIssue({ issue, comments = [] }) {
  if (issue?.pull_request) return blockedDecision({ source: 'pull-request', error: 'Pull requests are not classified by issue admission.' });

  const latest = latestTrustedAuthorityComment(comments);
  if (latest !== undefined) {
    const parsed = authorityFromTrustedComment(latest);
    if (parsed?.error) return blockedDecision({ source: 'steward-comment', error: parsed.error });
    if (parsed?.authority) return readyDecision(parsed.authority, 'steward-comment', issue?.state ?? 'open');
  }

  const bodyAuthority = authorityFromTrustedBody(issue ?? {});
  if (bodyAuthority?.error) return blockedDecision({ source: 'steward-body', error: bodyAuthority.error });
  if (bodyAuthority?.authority) return readyDecision(bodyAuthority.authority, 'steward-body', issue?.state ?? 'open');

  const proposal = formProposal(issue ?? {});
  if (proposal.error) return blockedDecision({ source: 'issue-form', error: proposal.error });
  if (!trustedAssociation(issue?.author_association)) {
    return blockedDecision({
      source: 'issue-form',
      authority: proposal.authority,
      error: 'Issue Form classification is only a proposal because the issue author is not trusted for unattended writer authority.',
      needsSteward: true,
    });
  }
  return readyDecision(proposal.authority, 'issue-form', issue?.state ?? 'open');
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
  };
  const note = decision.dispatch === 'ready'
    ? 'Classification is complete and may be admitted to the separate implementation queue. This comment does not enqueue work by itself.'
    : 'Implementation dispatch remains blocked. Non-implementation work stays outside the implementation dispatcher by design.';
  return `${ADMISSION_MARKER}\n## Tachiko issue admission\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n\n${note}\n\nManaged by \`.github/workflows/issue-admission.yml\`; edit task authority, not this projection.`;
}

module.exports = {
  ADMISSION_MARKER,
  AUTHORITY_MARKER,
  LEGACY_AUTHORITY_MARKER,
  LABEL_DEFINITIONS,
  MANAGED_LABELS,
  TASK_KINDS,
  TASK_SHAPES,
  TRUSTED_ASSOCIATIONS,
  classifyIssue,
  expectedProfile,
  field,
  normalizeExplicitAuthority,
  reconcileLabels,
  renderAdmission,
  trustedAssociation,
};
