import { randomUUID } from 'node:crypto';

import { EXECUTION_PROFILE_NAMES } from '../execution-profiles.js';

/** The Steward-owned, read-only queue marker. */
export const DISPATCH_QUEUE_MARKER = '<!-- issue-dispatch-queue:v1 -->';
/** The single machine-owned runtime claim marker. */
export const DISPATCH_RUNTIME_MARKER = '<!-- issue-dispatch-runtime:v1 -->';

export interface DispatchQueueEntry {
  readonly issue: number;
  readonly route: 'codex' | 'chatgpt' | 'work' | 'human';
  readonly profile: string;
}

export interface DispatchRuntimeClaim {
  readonly issue: number;
  readonly claimId: string;
  readonly runId: string | null;
  readonly profile: string;
  readonly state: 'claimed' | 'running' | 'merge_ready' | 'needs_human' | 'failed' | 'retired';
  readonly claimedAt: string;
  readonly heartbeatAt: string;
  readonly leaseUntil: string;
}

export class DispatchProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchProtocolError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function supportedProfile(value: string): boolean {
  return (EXECUTION_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * Parse the intentionally tiny queue grammar. It accepts only unquoted YAML
 * scalar values so a visually similar prose comment can never become work.
 */
export function parseDispatchQueue(body: string): readonly DispatchQueueEntry[] {
  const marker = body.indexOf(DISPATCH_QUEUE_MARKER);
  if (marker < 0) throw new DispatchProtocolError('The configured control comment has no issue-dispatch-queue:v1 marker.');
  if (body.indexOf(DISPATCH_QUEUE_MARKER, marker + DISPATCH_QUEUE_MARKER.length) >= 0) {
    throw new DispatchProtocolError('The configured control comment has duplicate issue-dispatch-queue:v1 markers.');
  }
  const lines = body.slice(marker + DISPATCH_QUEUE_MARKER.length).split(/\r?\n/);
  let started = false;
  let current: Partial<Record<'issue' | 'route' | 'profile', string>> | undefined;
  const result: DispatchQueueEntry[] = [];
  const finish = () => {
    if (current === undefined) return;
    const keys = Object.keys(current).sort();
    if (keys.join(',') !== 'issue,profile,route') throw new DispatchProtocolError('Every queue record must contain exactly issue, route, and profile.');
    const issue = positiveInteger(current.issue ?? '');
    if (issue === null) throw new DispatchProtocolError('Queue issue must be a positive safe integer.');
    if (!['codex', 'chatgpt', 'work', 'human'].includes(current.route ?? '')) {
      throw new DispatchProtocolError(`Queue issue #${issue} has an unknown route "${current.route ?? ''}".`);
    }
    if (!nonEmpty(current.profile) || /[\s:#]/.test(current.profile)) {
      throw new DispatchProtocolError(`Queue issue #${issue} has an invalid profile.`);
    }
    if (!supportedProfile(current.profile)) {
      throw new DispatchProtocolError(`Queue issue #${issue} has an unsupported execution profile "${current.profile}".`);
    }
    if (result.some((entry) => entry.issue === issue)) throw new DispatchProtocolError(`Queue contains duplicate issue #${issue}.`);
    result.push({ issue, route: current.route as DispatchQueueEntry['route'], profile: current.profile });
    current = undefined;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!started) {
      if (line !== 'ready:') throw new DispatchProtocolError('Queue marker must be followed by a ready: list.');
      started = true;
      continue;
    }
    const item = /^\s*-\s+(issue|route|profile):\s*([^\s]+)\s*$/.exec(line);
    if (item !== null) {
      finish();
      current = { [item[1] as 'issue' | 'route' | 'profile']: item[2] ?? '' };
      continue;
    }
    const property = /^\s+(issue|route|profile):\s*([^\s]+)\s*$/.exec(line);
    if (property === null || current === undefined) throw new DispatchProtocolError(`Invalid queue syntax: "${line.trim()}".`);
    const key = property[1] as 'issue' | 'route' | 'profile';
    if (current[key] !== undefined) throw new DispatchProtocolError(`Duplicate ${key} in one queue record.`);
    current[key] = property[2] ?? '';
  }
  if (!started) throw new DispatchProtocolError('Queue marker must be followed by a ready: list.');
  finish();
  return result;
}

export function renderDispatchRuntime(claim: DispatchRuntimeClaim): string {
  return `${DISPATCH_RUNTIME_MARKER}\n\n\`\`\`json\n${JSON.stringify(claim, null, 2)}\n\`\`\``;
}

/** Strictly parse an entire machine-owned runtime comment. */
export function parseDispatchRuntime(body: string): DispatchRuntimeClaim | null {
  const prefix = `${DISPATCH_RUNTIME_MARKER}\n\n\`\`\`json\n`;
  if (!body.startsWith(prefix) || !body.endsWith('\n\`\`\`')) return null;
  const raw = body.slice(prefix.length, -4);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DispatchProtocolError('Dispatch runtime comment contains invalid JSON.'); }
  const parsed = record(value);
  if (parsed === null) throw new DispatchProtocolError('Dispatch runtime comment must contain an object.');
  const expected = ['claimId', 'claimedAt', 'heartbeatAt', 'issue', 'leaseUntil', 'profile', 'runId', 'state'];
  if (Object.keys(parsed).sort().join(',') !== expected.join(',')) throw new DispatchProtocolError('Dispatch runtime comment has unknown or missing fields.');
  if (!Number.isSafeInteger(parsed.issue) || (parsed.issue as number) < 1 || !nonEmpty(parsed.claimId) || !nonEmpty(parsed.profile) || !supportedProfile(parsed.profile) ||
    !(parsed.runId === null || nonEmpty(parsed.runId)) || !nonEmpty(parsed.claimedAt) || !nonEmpty(parsed.heartbeatAt) || !nonEmpty(parsed.leaseUntil) ||
    !['claimed', 'running', 'merge_ready', 'needs_human', 'failed', 'retired'].includes(parsed.state as string)) {
    throw new DispatchProtocolError('Dispatch runtime comment has invalid field values.');
  }
  for (const time of [parsed.claimedAt, parsed.heartbeatAt, parsed.leaseUntil]) {
    if (Number.isNaN(Date.parse(time as string))) throw new DispatchProtocolError('Dispatch runtime timestamps must be ISO-compatible dates.');
  }
  return parsed as unknown as DispatchRuntimeClaim;
}

export interface DispatchRuntimeComment {
  readonly id: string;
  readonly body: string;
}

/** Finds the sole runtime claim. Absence is valid; duplicate/malformed claims are not. */
export function selectDispatchRuntime(comments: readonly DispatchRuntimeComment[]): { readonly id: string; readonly claim: DispatchRuntimeClaim } | null {
  const marked = comments.filter((comment) => comment.body.includes(DISPATCH_RUNTIME_MARKER));
  if (marked.length > 1) throw new DispatchProtocolError('Multiple dispatch runtime comments exist; refusing ambiguous ownership.');
  if (marked.length === 0) return null;
  const comment = marked[0]!;
  const claim = parseDispatchRuntime(comment.body);
  if (claim === null) throw new DispatchProtocolError('Dispatch runtime marker comment does not follow the strict runtime format.');
  return { id: comment.id, claim };
}

export interface DispatchClaimApi {
  listRuntimeComments(): Promise<readonly DispatchRuntimeComment[]>;
  createRuntimeComment(body: string): Promise<DispatchRuntimeComment>;
}

export interface DispatchClaimOptions {
  readonly now: () => string;
  readonly leaseDurationMs: number;
  readonly createClaimId?: () => string;
}

/**
 * Claim only after the caller has separately reconciled Issue/PR/Run state.
 * The post-write reread prevents a successful write from being mistaken for a
 * durable ownership fence when another writer has replaced it.
 */
export async function claimDispatchEntry(
  api: DispatchClaimApi,
  entry: DispatchQueueEntry,
  options: DispatchClaimOptions,
): Promise<{ readonly commentId: string; readonly claim: DispatchRuntimeClaim }> {
  if (entry.route !== 'codex') throw new DispatchProtocolError(`Queue issue #${entry.issue} is not routed to Codex.`);
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs < 1) {
    throw new DispatchProtocolError('Dispatch lease duration must be a positive safe integer.');
  }
  if (selectDispatchRuntime(await api.listRuntimeComments()) !== null) {
    throw new DispatchProtocolError('A dispatch runtime claim already exists; refusing a competing claim.');
  }
  const now = options.now();
  const claim: DispatchRuntimeClaim = {
    issue: entry.issue,
    claimId: (options.createClaimId ?? randomUUID)(),
    runId: null,
    profile: entry.profile,
    state: 'claimed',
    claimedAt: now,
    heartbeatAt: now,
    leaseUntil: new Date(Date.parse(now) + options.leaseDurationMs).toISOString(),
  };
  const created = await api.createRuntimeComment(renderDispatchRuntime(claim));
  const reread = selectDispatchRuntime(await api.listRuntimeComments());
  if (reread === null || reread.claim.claimId !== claim.claimId || reread.id !== created.id) {
    throw new DispatchProtocolError('Dispatch claim was not the sole canonical runtime claim after write.');
  }
  return { commentId: reread.id, claim: reread.claim };
}
