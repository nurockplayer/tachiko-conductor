import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OracleReceipt, OracleReceiptStore } from './types.js';
import { canonicalReviewTarget, isReviewRiskReason } from '../reviewers/risk-policy.js';

function validTarget(value: unknown): boolean {
  return canonicalReviewTarget(value) !== null;
}

function valid(value: unknown): value is OracleReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = new Set(['id', 'target', 'requestedHeadSha', 'observedHeadSha', 'outcome', 'reviewedAt', 'blockingFindingCount', 'nonBlockingFindingCount', 'failureCode', 'policy', 'policyQualified']);
  if (!Object.keys(v).every((key) => keys.has(key)) || typeof v.id !== 'string' || v.id.length > 300 || !/^[A-Za-z0-9._-]+$/.test(v.id) ||
    !validTarget(v.target) ||
    typeof v.requestedHeadSha !== 'string' || !/^[0-9a-f]{40}$/i.test(v.requestedHeadSha) || !(typeof v.observedHeadSha === 'string' && /^[0-9a-f]{40}$/i.test(v.observedHeadSha) || v.observedHeadSha === null) ||
    typeof v.reviewedAt !== 'string' || ['approved', 'request_changes', 'failed', 'stale_head'].includes(String(v.outcome)) === false ||
    !Number.isSafeInteger(v.blockingFindingCount) || Number(v.blockingFindingCount) < 0 || Number(v.blockingFindingCount) > 20 || !Number.isSafeInteger(v.nonBlockingFindingCount) || Number(v.nonBlockingFindingCount) < 0 || Number(v.nonBlockingFindingCount) > 20 || Number(v.blockingFindingCount) + Number(v.nonBlockingFindingCount) > 20 ||
    (v.failureCode !== undefined && !['unavailable', 'unauthorized', 'timeout', 'transport_failed', 'invalid_response', 'stale_head'].includes(String(v.failureCode))) ||
    (v.policyQualified !== undefined && typeof v.policyQualified !== 'boolean')) return false;
  // Historical receipts remain readable, but their missing policy block cannot
  // be interpreted as a policy-qualified approval.
  if (v.policy === undefined) return v.policyQualified !== true;
  if (typeof v.policy !== 'object' || v.policy === null) return false;
  const policy = v.policy as Record<string, unknown>;
  const semanticTier = policy.floor === 'R1' || policy.floor === 'R2' ? 'R3' : policy.floor;
  const expectedEffort = semanticTier === 'R5' ? 'Extra High' : semanticTier === 'R4' ? 'High' : 'Medium';
  const successful = v.outcome === 'approved' || v.outcome === 'request_changes';
  return Object.keys(policy).every((key) => ['version', 'floor', 'selectedSemanticTier', 'requestedEffort', 'effectiveEffort', 'reasons', 'criticalReason', 'baseSha', 'pullRequestNumber', 'changedPathCount', 'coverageSha256', 'requestCorrelationId', 'requestedModel', 'effectiveModel', 'bindingId', 'coverageComplete'].includes(key)) &&
    policy.version === 'risk-policy/v1' && ['R1', 'R2', 'R3', 'R4', 'R5'].includes(String(policy.floor)) &&
    policy.selectedSemanticTier === semanticTier && policy.requestedEffort === expectedEffort &&
    (policy.effectiveEffort === 'Medium' || policy.effectiveEffort === 'High' || policy.effectiveEffort === 'Extra High' || policy.effectiveEffort === null) &&
    Array.isArray(policy.reasons) && policy.reasons.length > 0 && policy.reasons.length <= 20 && policy.reasons.every(isReviewRiskReason) && new Set(policy.reasons).size === policy.reasons.length &&
    (typeof policy.criticalReason === 'string' && policy.criticalReason.trim().length > 0 && policy.criticalReason.length <= 500 || policy.criticalReason === null) && (policy.floor !== 'R5' || typeof policy.criticalReason === 'string' && policy.criticalReason.trim().length > 0) &&
    typeof policy.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(policy.baseSha) && (Number.isSafeInteger(policy.pullRequestNumber) && Number(policy.pullRequestNumber) > 0 || policy.pullRequestNumber === null) &&
    Number.isSafeInteger(policy.changedPathCount) && Number(policy.changedPathCount) > 0 && Number(policy.changedPathCount) <= 200 && typeof policy.coverageSha256 === 'string' && /^[0-9a-f]{64}$/.test(policy.coverageSha256) &&
    typeof policy.requestCorrelationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.requestCorrelationId) &&
    typeof policy.requestedModel === 'string' && policy.requestedModel.length > 0 && policy.requestedModel.length <= 160 &&
    (typeof policy.effectiveModel === 'string' && policy.effectiveModel.length > 0 && policy.effectiveModel.length <= 160 || policy.effectiveModel === null) &&
    typeof policy.bindingId === 'string' && policy.bindingId.length > 0 && policy.bindingId.length <= 120 && typeof policy.coverageComplete === 'boolean' &&
    (successful ? v.policyQualified === true && v.failureCode === undefined && v.observedHeadSha === v.requestedHeadSha && policy.coverageComplete === true && typeof policy.effectiveModel === 'string' && policy.effectiveModel === policy.requestedModel && policy.effectiveEffort === policy.requestedEffort && policy.pullRequestNumber !== null &&
      (v.outcome === 'approved' ? Number(v.blockingFindingCount) === 0 : Number(v.blockingFindingCount) > 0) : v.policyQualified === false && v.failureCode !== undefined && Number(v.blockingFindingCount) === 0 && Number(v.nonBlockingFindingCount) === 0) &&
    (v.outcome !== 'stale_head' || v.failureCode === 'stale_head') && (v.outcome !== 'failed' || v.failureCode !== undefined && v.failureCode !== 'stale_head');
}

export class JsonFileOracleReceiptStore implements OracleReceiptStore {
  private readonly dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); mkdirSync(this.dir, { recursive: true }); }
  record(receipt: OracleReceipt): void {
    if (!valid(receipt)) throw new Error('Invalid Oracle receipt.');
    const file = path.join(this.dir, `${receipt.id}.json`);
    const temp = `${file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  }
  list(): readonly OracleReceipt[] {
    return readdirSync(this.dir).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const value: unknown = JSON.parse(readFileSync(path.join(this.dir, name), 'utf8'));
      if (!valid(value)) throw new Error(`Invalid Oracle receipt in ${name}.`);
      return value.policy === undefined ? { ...value, policyQualified: false } : value;
    });
  }
}
