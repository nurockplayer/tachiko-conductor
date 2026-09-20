import type { DispatchControlLocation } from './github-runtime.js';

export interface DispatchConfiguration extends DispatchControlLocation {
  readonly revision: string;
  readonly leaseDurationMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`TACHIKO_DISPATCH_CONFIG.${name} must be a non-empty string.`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`TACHIKO_DISPATCH_CONFIG.${name} must be a positive safe integer.`);
  return value as number;
}

/** Parse the explicit single-owner queue location; no repository defaults are inferred. */
export function parseDispatchConfiguration(raw: string): DispatchConfiguration {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('TACHIKO_DISPATCH_CONFIG must be valid JSON.'); }
  const parsed = record(value);
  if (parsed === null) throw new Error('TACHIKO_DISPATCH_CONFIG must be an object.');
  const expected = ['controlIssue', 'leaseDurationMs', 'owner', 'queueCommentId', 'repo', 'revision'];
  if (Object.keys(parsed).sort().join(',') !== expected.join(',')) {
    throw new Error('TACHIKO_DISPATCH_CONFIG must contain exactly revision, owner, repo, controlIssue, queueCommentId, and leaseDurationMs.');
  }
  return {
    revision: string(parsed.revision, 'revision'), owner: string(parsed.owner, 'owner'), repo: string(parsed.repo, 'repo'),
    controlIssue: integer(parsed.controlIssue, 'controlIssue'), queueCommentId: integer(parsed.queueCommentId, 'queueCommentId'),
    leaseDurationMs: integer(parsed.leaseDurationMs, 'leaseDurationMs'),
  };
}

export function resolveDispatchConfiguration(env: NodeJS.ProcessEnv = process.env): DispatchConfiguration {
  if (env.TACHIKO_DISPATCH_CONFIG === undefined) throw new Error('TACHIKO_DISPATCH_CONFIG is required for dispatch commands.');
  return parseDispatchConfiguration(env.TACHIKO_DISPATCH_CONFIG);
}
