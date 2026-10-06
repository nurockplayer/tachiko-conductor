import type { Target } from '../domain/types.js';
import { createHash } from 'node:crypto';

/** Provider neutral, fail closed review risk classification. */

export const REVIEW_RISK_POLICY_VERSION = 'risk-policy/v1' as const;
export const REVIEW_RISK_LIMITS = { paths: 200, pathLength: 240, signalCount: 20, signalLength: 240, criticalQuestionLength: 500 } as const;

export type ReviewRiskTier = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export const REVIEW_RISK_REASONS = [
  'tiny_safe_documentation', 'ordinary_implementation', 'public_api_or_persistence',
  'concurrency_or_recovery', 'security_or_release_authority', 'workflow_or_recovery_state',
  'reviewer_policy_or_qualification', 'admission_or_release_authority',
  'publication_or_isolation_authority', 'declared_risk_signal', 'critical_escalation',
] as const;
export type ReviewRiskReason = typeof REVIEW_RISK_REASONS[number];
const REVIEW_RISK_REASON_SET: ReadonlySet<string> = new Set(REVIEW_RISK_REASONS);
export function isReviewRiskReason(value: unknown): value is ReviewRiskReason {
  return typeof value === 'string' && REVIEW_RISK_REASON_SET.has(value);
}

export interface ReviewRiskEvidence {
  readonly target: Target;
  readonly headSha: string;
  readonly baseSha: string;
  readonly changedPaths: readonly string[];
  readonly manifestComplete: true;
  readonly deterministicValidation: { readonly passed: true; readonly headSha: string; readonly baseSha: string };
  readonly riskSignals: readonly string[];
  readonly riskEvidenceComplete: true;
  /** A prior, established safe documentation/mechanical change pattern. */
  readonly establishedSafePattern?: boolean;
  /** Escalation question must be bounded and name the unresolved critical issue. */
  readonly criticalQuestion?: string;
}

export type ReviewRiskDecision =
  | { readonly outcome: 'hold'; readonly reasons: readonly ('missing_evidence' | 'invalid_identity' | 'invalid_manifest' | 'invalid_risk_evidence' | 'validation_not_current')[] }
  | { readonly outcome: 'review'; readonly policyVersion: typeof REVIEW_RISK_POLICY_VERSION; readonly floor: ReviewRiskTier; readonly reasons: readonly ReviewRiskReason[]; readonly headSha: string; readonly baseSha: string; readonly targetKey: string; readonly changedPaths: readonly string[]; readonly criticalQuestion?: string; readonly criticalReason?: string };

const SHA = /^[0-9a-f]{40}$/i;
const KNOWN_SIGNALS = new Set(['public_api', 'persistence', 'schema', 'multi_component', 'concurrency', 'recovery', 'state_machine', 'ack_loss', 'auth', 'security', 'trust_boundary', 'irreversible_data', 'merge_release_authority', 'self_host_critical']);
const R5_SIGNALS = new Set(['auth', 'security', 'trust_boundary', 'irreversible_data', 'merge_release_authority', 'self_host_critical']);
const R4_SIGNALS = new Set(['concurrency', 'recovery', 'state_machine', 'ack_loss']);
const R3_SIGNALS = new Set(['public_api', 'persistence', 'schema', 'multi_component']);

function pathValid(path: string): boolean {
  return path.length > 0 && path.length <= REVIEW_RISK_LIMITS.pathLength && !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && /^[A-Za-z0-9._@+-]+$/.test(part));
}

function pathTier(path: string): { tier: ReviewRiskTier; reason: ReviewRiskReason } {
  const p = path.toLowerCase();
  // Exact repository-owned execution authorities are reviewed at the highest
  // floor even when callers provide no risk signals. Keep these paths ahead of
  // the broader workflow, agent, and API patterns below.
  if (/^src\/(cli|execution-profiles)\.ts$/.test(p) || /^src\/agents\/(implementation-router|claude-code|codex-cli|codex-app-server)\.ts$/.test(p) || p === 'src/adapters/agent.ts' || /^src\/dispatch\/(command|config|github-runtime|queue|runner|launchd)\.ts$/.test(p) || p === 'scripts/bootstrap-heartbeat/runner.py') return { tier: 'R5', reason: 'admission_or_release_authority' };
  if (/^src\/validation\/(local-command|hosted-policy)\.ts$/.test(p) || /^src\/domain\/(validation|state-machine|decisions)\.ts$/.test(p)) return { tier: 'R5', reason: 'admission_or_release_authority' };
  if (p === 'src/reviewers/deepseek.ts') return { tier: 'R5', reason: 'reviewer_policy_or_qualification' };
  if (/^src\/browser\/(playwright-mcp-runtime|agent-config)\.ts$/.test(p)) return { tier: 'R5', reason: 'security_or_release_authority' };
  // These paths affect qualification/session lifecycle but do not themselves
  // admit, publish, or execute work.
  if (p === 'src/dispatch/continuous.ts') return { tier: 'R4', reason: 'workflow_or_recovery_state' };
  if (p === 'src/agents/model-capability.ts') return { tier: 'R4', reason: 'reviewer_policy_or_qualification' };
  if (p === 'src/browser/mcp-client.ts') return { tier: 'R4', reason: 'concurrency_or_recovery' };
  if (/^src\/(mission-admission|domain\/repair-admission)(\/|\.)/.test(p) || /^src\/production-policy\.ts$/.test(p)) return { tier: 'R5', reason: 'admission_or_release_authority' };
  if (/^src\/workspace\/(git-worktree-bootstrap|standalone-git-bootstrap)\.ts$/.test(p) || /^src\/agents\/(worker-router|worker-router-container|luna-isolated)\.ts$/.test(p) || /^src\/github\/live-state\.ts$/.test(p) || /^src\/workflow\/run\.ts$/.test(p) || /^src\/reviewers\/loop\.ts$/.test(p)) return { tier: 'R5', reason: 'publication_or_isolation_authority' };
  if (/^src\/(workflow|dispatch\/invocation-lock)(\/|\.)/.test(p) || /^scripts\/bootstrap-heartbeat\//.test(p)) return { tier: 'R4', reason: 'workflow_or_recovery_state' };
  if (/^src\/oracle\//.test(p) || /^src\/reviewers\/risk-policy\.ts$/.test(p)) return { tier: 'R4', reason: 'reviewer_policy_or_qualification' };
  if (/^src\/store\//.test(p) || /^src\/domain\/types\.ts$/.test(p) || /^src\/adapters\//.test(p)) return { tier: 'R3', reason: 'public_api_or_persistence' };
  if (/(^|\/)(auth|security|crypto|secrets?)(\/|\.|$)|(^|\/)(release|deploy|merge)(\/|\.|$)/.test(p)) return { tier: 'R5', reason: 'security_or_release_authority' };
  if (/(^|\/)(recovery|concurrency|state-machine|state_machine|queue|lock)(\/|\.|$)|ack-loss/.test(p)) return { tier: 'R4', reason: 'concurrency_or_recovery' };
  if (/\.(sql|prisma|proto|graphql|d\.ts)$|(^|\/)(schema|migrations?)(\/|$)|(^|\/)(public|api)(\/|$)|(^|\/)(index|types)(\.[^/]+)?$/.test(p)) return { tier: 'R3', reason: 'public_api_or_persistence' };
  return { tier: 'R2', reason: 'ordinary_implementation' };
}

const rank: Record<ReviewRiskTier, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };
function higher(a: ReviewRiskTier, b: ReviewRiskTier): ReviewRiskTier { return rank[a] >= rank[b] ? a : b; }
function record(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((d) => !('value' in d))) return null;
    return value as Record<string, unknown>;
  } catch { return null; }
}
function array(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index++) if (!descriptors[String(index)] || !('value' in descriptors[String(index)]!)) return null;
    if (Object.keys(descriptors).some((key) => key !== 'length' && !/^\d+$/.test(key))) return null;
    return Array.from({ length: value.length }, (_, index) => descriptors[String(index)]!.value as unknown);
  } catch { return null; }
}
export function canonicalReviewTarget(value: unknown): { readonly target: Target; readonly key: string } | null {
  const t = record(value);
  if (t === null || typeof t.kind !== 'string' || typeof t.owner !== 'string' || typeof t.repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(t.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(t.repo)) return null;
  if (t.kind === 'issue' && Number.isSafeInteger(t.issueNumber) && Number(t.issueNumber) > 0 && Object.keys(t).every((key) => ['kind', 'owner', 'repo', 'issueNumber'].includes(key))) {
    const target = { kind: 'issue' as const, owner: t.owner, repo: t.repo, issueNumber: Number(t.issueNumber) };
    return { target, key: targetDigest(['review-target/v1', 'issue', target.owner, target.repo, target.issueNumber]) };
  }
  if (t.kind === 'repository' && typeof t.branch === 'string' && t.branch.length > 0 && t.branch.length <= 240 && !t.branch.startsWith('/') && !t.branch.includes('\\') && !t.branch.split('/').some((part) => part === '' || part === '.' || part === '..') && Object.keys(t).every((key) => ['kind', 'owner', 'repo', 'branch', 'publicationBranch'].includes(key))) {
    if (t.publicationBranch !== undefined && (typeof t.publicationBranch !== 'string' || t.publicationBranch.length === 0 || t.publicationBranch.length > 240 || t.publicationBranch.startsWith('/') || t.publicationBranch.includes('\\') || t.publicationBranch.split('/').some((part) => part === '' || part === '.' || part === '..'))) return null;
    const target = { kind: 'repository' as const, owner: t.owner, repo: t.repo, branch: t.branch, ...(typeof t.publicationBranch === 'string' ? { publicationBranch: t.publicationBranch } : {}) };
    return { target, key: targetDigest(['review-target/v1', 'repository', target.owner, target.repo, target.branch, target.publicationBranch ?? null]) };
  }
  return null;
}

function targetDigest(fields: readonly (string | number | null)[]): string {
  return `review-target/v1:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
}

/** Classifies already-observed trusted candidate evidence. Malformed or incomplete evidence never becomes a low tier. */
export function classifyReviewRisk(input: unknown): ReviewRiskDecision {
  const e = record(input);
  if (e === null) return { outcome: 'hold', reasons: ['missing_evidence'] };
  if (Object.keys(e).some((key) => !['target', 'headSha', 'baseSha', 'changedPaths', 'manifestComplete', 'deterministicValidation', 'riskSignals', 'riskEvidenceComplete', 'establishedSafePattern', 'criticalQuestion'].includes(key))) return { outcome: 'hold', reasons: ['invalid_risk_evidence'] };
  const candidateTarget = canonicalReviewTarget(e.target);
  if (candidateTarget === null || typeof e.headSha !== 'string' || !SHA.test(e.headSha) || typeof e.baseSha !== 'string' || !SHA.test(e.baseSha)) return { outcome: 'hold', reasons: ['invalid_identity'] };
  const headSha = e.headSha;
  const baseSha = e.baseSha;
  const changedPaths = array(e.changedPaths, REVIEW_RISK_LIMITS.paths);
  const riskSignals = array(e.riskSignals, REVIEW_RISK_LIMITS.signalCount);
  if (e.manifestComplete !== true || changedPaths === null || changedPaths.length === 0 || !changedPaths.every((p) => typeof p === 'string' && pathValid(p)) || new Set(changedPaths).size !== changedPaths.length) return { outcome: 'hold', reasons: ['invalid_manifest'] };
  if (e.riskEvidenceComplete !== true || riskSignals === null || !riskSignals.every((s) => typeof s === 'string' && s.length > 0 && s.length <= REVIEW_RISK_LIMITS.signalLength && KNOWN_SIGNALS.has(s)) || new Set(riskSignals).size !== riskSignals.length) return { outcome: 'hold', reasons: ['invalid_risk_evidence'] };
  const paths = changedPaths as string[];
  const signals = riskSignals as string[];
  if (e.establishedSafePattern !== undefined && typeof e.establishedSafePattern !== 'boolean') return { outcome: 'hold', reasons: ['invalid_risk_evidence'] };
  const validation = record(e.deterministicValidation);
  if (validation === null || Object.keys(validation).some((key) => !['passed', 'headSha', 'baseSha'].includes(key)) || validation.passed !== true || validation.headSha !== e.headSha || validation.baseSha !== e.baseSha) return { outcome: 'hold', reasons: ['validation_not_current'] };
  if (e.criticalQuestion !== undefined && (typeof e.criticalQuestion !== 'string' || e.criticalQuestion.trim().length < 12 || e.criticalQuestion.length > REVIEW_RISK_LIMITS.criticalQuestionLength)) return { outcome: 'hold', reasons: ['invalid_risk_evidence'] };

  let floor: ReviewRiskTier = 'R2';
  const reasons = new Set<ReviewRiskReason>();
  let criticalReason: string | undefined;
  const onlyDocs = paths.every((p) => /(^|\/)(readme[^/]*\.md|docs\/[^/]+\.md|\.md)$/i.test(p));
  if (onlyDocs && e.establishedSafePattern === true) { floor = 'R1'; reasons.add('tiny_safe_documentation'); }
  else reasons.add('ordinary_implementation');
  for (const path of paths) {
    const result = pathTier(path);
    if (!(floor === 'R1' && result.tier === 'R2')) floor = higher(floor, result.tier);
    if (rank[result.tier] > 2) reasons.add(result.reason);
    if (result.tier === 'R5' && criticalReason === undefined) criticalReason = `path:${path}:${result.reason}`.slice(0, 500);
  }
  for (const signal of signals) {
    if (R5_SIGNALS.has(signal)) { floor = higher(floor, 'R5'); reasons.add('declared_risk_signal'); if (criticalReason === undefined) criticalReason = `signal:${signal}`; }
    else if (R4_SIGNALS.has(signal)) { floor = higher(floor, 'R4'); reasons.add('declared_risk_signal'); }
    else if (R3_SIGNALS.has(signal)) { floor = higher(floor, 'R3'); reasons.add('declared_risk_signal'); }
  }
  const criticalQuestion = e.criticalQuestion?.trim();
  if (criticalQuestion) { floor = higher(floor, 'R5'); reasons.add('critical_escalation'); criticalReason = criticalQuestion; }
  return Object.freeze({ outcome: 'review', policyVersion: REVIEW_RISK_POLICY_VERSION, floor, reasons: Object.freeze([...reasons]), headSha, baseSha, targetKey: candidateTarget.key, changedPaths: Object.freeze([...paths]), ...(criticalQuestion === undefined ? {} : { criticalQuestion }), ...(criticalReason === undefined ? {} : { criticalReason }) });
}
