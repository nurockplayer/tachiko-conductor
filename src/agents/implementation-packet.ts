import { createHash } from 'node:crypto';

import type { Target } from '../domain/types.js';
import type { AgentHandoffSnapshot, GitHubProblem } from '../adapters/github.js';
import { isValidationResultCoherent } from '../domain/validation.js';

export const IMPLEMENTATION_PACKET_VERSION = 'tachiko.implementation-packet.v1' as const;

export const IMPLEMENTATION_PACKET_LIMITS = Object.freeze({
  issueBodyBytes: 32 * 1024,
  repairEvidenceBytes: 24 * 1024,
  renderedBytes: 60 * 1024,
  finalCliBytes: 64 * 1024,
  titleBytes: 1024,
  workspacePathBytes: 4096,
  branchBytes: 1024,
  blockingFindings: 20,
});

export type ImplementationPacketKind = 'initial' | 'validation-repair' | 'review-repair';

const HANDOFF_REFUSAL_PROBLEMS = new Set([
  'MALFORMED_HANDOFF', 'MALFORMED_HANDOFF_NEWER_THAN_SELECTED', 'AMBIGUOUS_HANDOFF',
  'DUPLICATE_HANDOFFS', 'STALE_HANDOFF',
]);

export function acceptedScopeFromHandoff(handoff: AgentHandoffSnapshot | null, problems: readonly GitHubProblem[] = [], allowUnclaimedInitial = false):
  | { readonly sourceId: string; readonly sourceScope: 'issue' | 'pull_request'; readonly sourceUpdatedAt: string; readonly freshness: 'current' | 'unknown'; readonly text: string }
  | null {
  if (handoff === null || problems.some((problem) => HANDOFF_REFUSAL_PROBLEMS.has(problem.code))) return null;
  const unclaimedInitial = allowUnclaimedInitial && handoff.freshness === 'unknown' &&
    handoff.sourceScope === 'issue' && handoff.claimedHeadSha === undefined && handoff.claimedPullRequestNumber === undefined;
  if (handoff.freshness !== 'current' && !unclaimedInitial) return null;
  const sections = Object.entries(handoff.sections).filter(([heading, text]) =>
    /^(?:accepted(?:\s+#48-a)?\s+)?(?:bounded\s+)?scope$/i.test(heading.trim()) && nonEmpty(text));
  if (sections.length !== 1) return null;
  return {
    sourceId: handoff.sourceId,
    sourceScope: handoff.sourceScope,
    sourceUpdatedAt: handoff.sourceUpdatedAt,
    freshness: handoff.freshness,
    text: sections[0]![1],
  };
}

export interface ImplementationPacketInput {
  readonly kind: ImplementationPacketKind;
  readonly identity: {
    readonly runId: string;
    readonly target: Target;
    readonly workspacePath: string;
    readonly branch: string;
    readonly baseSha: string;
    readonly execution: {
      readonly profile: string;
      readonly revision: string;
      readonly executor: string;
      readonly timeoutMs: number;
      readonly model?: string;
      readonly reasoningEffort?: string;
      readonly sandboxMode?: string;
      readonly approvalPolicy?: string;
    };
  };
  readonly authority: {
    readonly repository: { readonly owner: string; readonly repo: string };
    readonly issue: {
      readonly id: string;
      readonly number: number;
      readonly updatedAt: string;
      readonly title: string;
      readonly body: string;
    };
    readonly acceptedScope: {
      readonly sourceId: string;
      readonly sourceScope: 'issue' | 'pull_request';
      readonly sourceUpdatedAt: string;
      readonly freshness: 'current' | 'stale' | 'unknown';
      readonly text: string;
    };
  };
  readonly repair: null | {
    readonly headSha: string;
    readonly pullRequestNumber: number;
    readonly evidenceRef: string;
    readonly evidence: string;
    readonly evidenceKind: 'validation' | 'review';
    readonly evidenceHeadSha: string;
    readonly evidencePullRequestNumber: number;
    readonly evidenceStatus: 'failed' | 'request_changes';
    readonly blockingFindings: readonly string[];
  };
}

export interface ImplementationPacket {
  readonly version: typeof IMPLEMENTATION_PACKET_VERSION;
  readonly kind: ImplementationPacketKind;
  readonly identity: ImplementationPacketInput['identity'];
  readonly provenance: {
    readonly issueId: string;
    readonly issueNumber: number;
    readonly repository: string;
    readonly issueUpdatedAt: string;
    readonly issueBodySha256: string;
    readonly acceptedScopeSourceId: string;
    readonly acceptedScopeSourceScope: 'issue' | 'pull_request';
    readonly acceptedScopeUpdatedAt: string;
    readonly acceptedScopeSha256: string;
    readonly repairEvidenceRef?: string;
    readonly repairEvidenceSha256?: string;
  };
  readonly rendered: string;
  readonly finalCliText: string;
}

export type ImplementationPacketRefusalCode =
  | 'PACKET_IDENTITY_MISSING'
  | 'PACKET_AUTHORITY_MISSING'
  | 'PACKET_ISSUE_BODY_OVERSIZE'
  | 'PACKET_TITLE_OVERSIZE'
  | 'PACKET_REPAIR_EVIDENCE_MISSING'
  | 'PACKET_REPAIR_EVIDENCE_OVERSIZE'
  | 'PACKET_TOO_MANY_BLOCKING_FINDINGS'
  | 'PACKET_RENDERED_OVERSIZE'
  | 'PACKET_FINAL_CLI_OVERSIZE';

export type ImplementationPacketResult =
  | { readonly kind: 'packet'; readonly packet: ImplementationPacket }
  | { readonly kind: 'refusal'; readonly code: ImplementationPacketRefusalCode; readonly reason: string };

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function repairEvidenceMaterial(repair: NonNullable<ImplementationPacketInput['repair']>): string {
  return [repair.evidence, ...repair.blockingFindings].join('\n');
}

function repairEvidenceMatches(kind: ImplementationPacketKind, repair: NonNullable<ImplementationPacketInput['repair']>): boolean {
  try {
    const evidence: unknown = JSON.parse(repair.evidence);
    if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return false;
    const value = evidence as Record<string, unknown>;
    if (kind === 'validation-repair') {
      return isValidationResultCoherent(value) && value.status === 'failed' &&
        value.headSha === repair.headSha && value.hosted.pullRequestNumber === repair.pullRequestNumber;
    }
    return kind === 'review-repair' && value.verdict === 'request_changes' &&
      value.headSha === repair.headSha && value.pullRequestNumber === repair.pullRequestNumber;
  } catch {
    return false;
  }
}

function targetText(target: Target): string {
  return target.kind === 'issue'
    ? `${target.owner}/${target.repo}#${target.issueNumber}`
    : `${target.owner}/${target.repo}@${target.branch}`;
}

function refusal(code: ImplementationPacketRefusalCode, reason: string): ImplementationPacketResult {
  return { kind: 'refusal', code, reason: `${code}: ${reason} No text was truncated; no model turn or publication is authorized.` };
}

/** Deterministic, side-effect-free packet construction. Oversize inputs always fail closed. */
export function buildImplementationPacket(input: ImplementationPacketInput): ImplementationPacketResult {
  const { identity, authority, repair } = input;
  const missingIdentity = [
    ['run id', identity.runId], ['workspace path', identity.workspacePath], ['branch', identity.branch], ['base SHA', identity.baseSha],
    ['execution profile', identity.execution.profile], ['execution revision', identity.execution.revision], ['executor', identity.execution.executor],
  ].filter(([, value]) => !nonEmpty(value as string)).map(([name]) => name as string);
  if (!Number.isSafeInteger(identity.execution.timeoutMs) || identity.execution.timeoutMs < 1) missingIdentity.push('execution timeout');
  if (missingIdentity.length > 0) {
    return refusal('PACKET_IDENTITY_MISSING', `Required identity is missing: ${missingIdentity.join(', ')}.`);
  }
  if (utf8Bytes(identity.workspacePath) > IMPLEMENTATION_PACKET_LIMITS.workspacePathBytes ||
      utf8Bytes(identity.branch) > IMPLEMENTATION_PACKET_LIMITS.branchBytes) {
    return refusal('PACKET_IDENTITY_MISSING', 'Workspace path or branch exceeds its versioned identity byte bound.');
  }
  if (!nonEmpty(authority.issue.id) || !nonEmpty(authority.issue.updatedAt) ||
      identity.target.kind !== 'issue' || authority.issue.number !== identity.target.issueNumber ||
      authority.repository.owner.toLowerCase() !== identity.target.owner.toLowerCase() ||
      authority.repository.repo.toLowerCase() !== identity.target.repo.toLowerCase() ||
      !nonEmpty(authority.acceptedScope.sourceId) || !nonEmpty(authority.acceptedScope.sourceUpdatedAt) ||
      (authority.acceptedScope.sourceScope !== 'issue' && authority.acceptedScope.sourceScope !== 'pull_request') ||
      !((authority.acceptedScope.freshness === 'current') ||
        (input.kind === 'initial' && authority.acceptedScope.freshness === 'unknown' && authority.acceptedScope.sourceScope === 'issue')) ||
      !nonEmpty(authority.acceptedScope.text)) {
    return refusal('PACKET_AUTHORITY_MISSING', 'Current issue authority and a selected accepted-scope source are required.');
  }
  if (utf8Bytes(authority.issue.title) > IMPLEMENTATION_PACKET_LIMITS.titleBytes) {
    return refusal('PACKET_TITLE_OVERSIZE', `Issue title exceeds ${IMPLEMENTATION_PACKET_LIMITS.titleBytes} UTF-8 bytes.`);
  }
  if (utf8Bytes(authority.issue.body) > IMPLEMENTATION_PACKET_LIMITS.issueBodyBytes) {
    return refusal('PACKET_ISSUE_BODY_OVERSIZE', `Issue body exceeds ${IMPLEMENTATION_PACKET_LIMITS.issueBodyBytes} UTF-8 bytes.`);
  }
  if (input.kind === 'initial' && repair !== null) {
    return refusal('PACKET_REPAIR_EVIDENCE_MISSING', 'Initial packets cannot carry untyped repair evidence.');
  }
  if (input.kind !== 'initial') {
    if (repair === null || !/^[0-9a-f]{40}$/i.test(repair.headSha) || repair.headSha !== identity.baseSha ||
        !Number.isSafeInteger(repair.pullRequestNumber) || repair.pullRequestNumber < 1 ||
        !nonEmpty(repair.evidenceRef) || !nonEmpty(repair.evidence) ||
        repair.evidenceHeadSha !== repair.headSha || repair.evidencePullRequestNumber !== repair.pullRequestNumber ||
        !repairEvidenceMatches(input.kind, repair) ||
        (input.kind === 'validation-repair' && (repair.evidenceKind !== 'validation' || repair.evidenceStatus !== 'failed')) ||
        (input.kind === 'review-repair' && (repair.evidenceKind !== 'review' || repair.evidenceStatus !== 'request_changes'))) {
      return refusal('PACKET_REPAIR_EVIDENCE_MISSING', 'Repair requires exact HEAD, accepted pull request, and source-bound evidence.');
    }
    const aggregateRepairBytes = utf8Bytes(repairEvidenceMaterial(repair));
    if (aggregateRepairBytes > IMPLEMENTATION_PACKET_LIMITS.repairEvidenceBytes) {
      return refusal('PACKET_REPAIR_EVIDENCE_OVERSIZE', `Repair evidence and blocking findings exceed ${IMPLEMENTATION_PACKET_LIMITS.repairEvidenceBytes} UTF-8 bytes.`);
    }
    if (repair.blockingFindings.length > IMPLEMENTATION_PACKET_LIMITS.blockingFindings) {
      return refusal('PACKET_TOO_MANY_BLOCKING_FINDINGS', `Repair has more than ${IMPLEMENTATION_PACKET_LIMITS.blockingFindings} blocking findings.`);
    }
    if (input.kind === 'review-repair' && repair.blockingFindings.length === 0) {
      return refusal('PACKET_REPAIR_EVIDENCE_MISSING', 'Review repair requires at least one blocking finding.');
    }
  }

  const provenance: ImplementationPacket['provenance'] = {
    issueId: authority.issue.id,
    issueNumber: authority.issue.number,
    repository: `${authority.repository.owner}/${authority.repository.repo}`,
    issueUpdatedAt: authority.issue.updatedAt,
    issueBodySha256: digest(authority.issue.body),
    acceptedScopeSourceId: authority.acceptedScope.sourceId,
    acceptedScopeSourceScope: authority.acceptedScope.sourceScope,
    acceptedScopeUpdatedAt: authority.acceptedScope.sourceUpdatedAt,
    acceptedScopeSha256: digest(authority.acceptedScope.text),
    ...(repair === null ? {} : {
      repairEvidenceRef: repair.evidenceRef,
      repairEvidenceSha256: digest(repairEvidenceMaterial(repair)),
    }),
  };
  const lines = [
    `Packet: ${IMPLEMENTATION_PACKET_VERSION}`,
    `Kind: ${input.kind}`,
    `Run: ${identity.runId}`,
    `Target: ${targetText(identity.target)}`,
    `Workspace: ${identity.workspacePath}`,
    `Branch: ${identity.branch}`,
    `Base: ${identity.baseSha}`,
    `Execution: profile=${identity.execution.profile}; revision=${identity.execution.revision}; executor=${identity.execution.executor}; model=${identity.execution.model ?? '(unspecified)'}; reasoning=${identity.execution.reasoningEffort ?? '(unspecified)'}; timeoutMs=${identity.execution.timeoutMs}; sandbox=${identity.execution.sandboxMode ?? '(unspecified)'}; approval=${identity.execution.approvalPolicy ?? '(unspecified)'}`,
    `Issue authority: ${provenance.repository}#${authority.issue.number} ${authority.issue.id} updated ${authority.issue.updatedAt} sha256=${provenance.issueBodySha256}`,
    `Accepted scope: ${authority.acceptedScope.sourceScope} ${authority.acceptedScope.sourceId} updated ${authority.acceptedScope.sourceUpdatedAt} sha256=${provenance.acceptedScopeSha256}`,
    `Task title: ${authority.issue.title}`,
    'Accepted scope and instructions:',
    authority.acceptedScope.text,
    'Issue requirements:',
    authority.issue.body,
  ];
  if (repair !== null) {
    lines.push(
      `Repair identity: PR #${repair.pullRequestNumber} at exact HEAD ${repair.headSha}`,
      `Repair evidence source: ${repair.evidenceRef} sha256=${provenance.repairEvidenceSha256}`,
      'Repair evidence:',
      repair.evidence,
      ...(repair.blockingFindings.length === 0 ? [] : ['Blocking findings:', ...repair.blockingFindings.map((item, index) => `${index + 1}. ${item}`)]),
    );
  }
  lines.push(
    'Worker contract: implement only this bounded packet and required tests; preserve the supplied execution identity; commit one clean exact HEAD. Do not push or create a pull request; the trusted host owns publication.',
  );
  const rendered = lines.join('\n');
  if (utf8Bytes(rendered) > IMPLEMENTATION_PACKET_LIMITS.renderedBytes) {
    return refusal('PACKET_RENDERED_OVERSIZE', `Rendered packet exceeds ${IMPLEMENTATION_PACKET_LIMITS.renderedBytes} UTF-8 bytes.`);
  }
  const finalCliText = [
    `Implement ${targetText(identity.target)} from base ${identity.baseSha}.`,
    'Treat the supplied bounded task packet as the only target authority; do not use network or MCP to rediscover it.',
    'Run repository-required validation before reporting success.',
    rendered,
  ].join('\n');
  if (utf8Bytes(finalCliText) > IMPLEMENTATION_PACKET_LIMITS.finalCliBytes) {
    return refusal('PACKET_FINAL_CLI_OVERSIZE', `Final CLI packet exceeds ${IMPLEMENTATION_PACKET_LIMITS.finalCliBytes} UTF-8 bytes.`);
  }
  return {
    kind: 'packet',
    packet: Object.freeze({
      version: IMPLEMENTATION_PACKET_VERSION,
      kind: input.kind,
      identity,
      provenance: Object.freeze(provenance),
      rendered,
      finalCliText,
    }),
  };
}

/** Validate all authority, evidence, and byte bounds before repair admission or workspace mutation. */
export function preflightImplementationPacket(input: ImplementationPacketInput): ImplementationPacketResult {
  return buildImplementationPacket({
    ...input,
    identity: {
      ...input.identity,
      workspacePath: input.identity.workspacePath || 'w'.repeat(IMPLEMENTATION_PACKET_LIMITS.workspacePathBytes),
      branch: input.identity.branch || 'b'.repeat(IMPLEMENTATION_PACKET_LIMITS.branchBytes),
      baseSha: input.identity.baseSha || '<pending-base>',
    },
  });
}

/** Re-check the final serialized CLI packet at the last source-owned boundary. */
export function renderFinalCliPacket(packet: ImplementationPacket):
  | { readonly kind: 'packet'; readonly text: string }
  | { readonly kind: 'refusal'; readonly code: 'PACKET_FINAL_CLI_OVERSIZE'; readonly reason: string } {
  if (utf8Bytes(packet.finalCliText) > IMPLEMENTATION_PACKET_LIMITS.finalCliBytes) {
    return {
      kind: 'refusal',
      code: 'PACKET_FINAL_CLI_OVERSIZE',
      reason: `PACKET_FINAL_CLI_OVERSIZE: final CLI packet exceeds ${IMPLEMENTATION_PACKET_LIMITS.finalCliBytes} UTF-8 bytes. No model turn or publication is authorized.`,
    };
  }
  return { kind: 'packet', text: packet.finalCliText };
}
