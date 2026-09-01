import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { TRANSITION_TYPES, WORKFLOW_STATES, type Run, type WorkflowState } from '../domain/types.js';

/**
 * Durable local storage for runs. Synchronous by design: the conductor is a
 * small single-process CLI and a sync API keeps the store trivial to reason
 * about and test.
 */
export interface RunStore {
  readonly name: string;
  create(run: Run): void;
  read(id: string): Run | null;
  update(run: Run): void;
  list(): Run[];
  delete(id: string): void;
}

export interface JsonFileStoreOptions {
  /** Directory that will hold one `<id>.json` file per run. */
  readonly dir: string;
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid run id "${id}": ids may only contain [A-Za-z0-9._-].`);
  }
}

/** States that pause a run and must be able to resume. */
const INTERRUPT_STATES: ReadonlySet<string> = new Set(['NEEDS_HUMAN', 'WAITING_DEPENDENCY']);

/** Structural guard for the Target union so a corrupt target fails early. */
function isTarget(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  if (t.kind === 'issue') {
    return typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.issueNumber === 'number';
  }
  if (t.kind === 'repository') {
    return typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.branch === 'string';
  }
  return false;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isOptionalDuration(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isExecutorIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const executor = value as Record<string, unknown>;
  return (
    typeof executor.provider === 'string' &&
    executor.provider.trim().length > 0 &&
    typeof executor.sessionId === 'string' &&
    executor.sessionId.trim().length > 0
  );
}

function isAgentResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    (result.exitStatus === 'success' || result.exitStatus === 'failure') &&
    typeof result.summary === 'string' &&
    isOptionalString(result.headSha) &&
    isOptionalStringArray(result.changedFiles) &&
    isOptionalStringArray(result.diagnostics) &&
    (result.executor === undefined || isExecutorIdentity(result.executor)) &&
    isOptionalNonEmptyString(result.sessionId) &&
    isOptionalDuration(result.durationMs)
  );
}

function isReviewFinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const finding = value as Record<string, unknown>;
  return (
    (finding.severity === 'blocking' || finding.severity === 'non_blocking') &&
    typeof finding.summary === 'string' &&
    isOptionalString(finding.detail)
  );
}

function isReviewResult(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    (result.verdict === 'approve' || result.verdict === 'request_changes') &&
    typeof result.reviewerName === 'string' &&
    typeof result.headSha === 'string' &&
    Array.isArray(result.findings) &&
    result.findings.every(isReviewFinding)
  );
}

function isInterrupt(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const interrupt = value as Record<string, unknown>;
  return (
    (interrupt.kind === 'needs_human' || interrupt.kind === 'waiting_dependency') &&
    typeof interrupt.reason === 'string' &&
    typeof interrupt.createdAt === 'string' &&
    isOptionalString(interrupt.resolvedAt) &&
    isOptionalString(interrupt.evidence) &&
    isOptionalStringArray(interrupt.choices)
  );
}

function isTransitionRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === 'string' &&
    TRANSITION_TYPES.includes(record.type as (typeof TRANSITION_TYPES)[number]) &&
    typeof record.from === 'string' &&
    WORKFLOW_STATES.includes(record.from as WorkflowState) &&
    typeof record.to === 'string' &&
    WORKFLOW_STATES.includes(record.to as WorkflowState) &&
    typeof record.at === 'string' &&
    isOptionalString(record.reason)
  );
}

/**
 * A persisted interrupt context must be coherent: a run parked in
 * NEEDS_HUMAN / WAITING_DEPENDENCY must be able to resume to a valid,
 * non-interrupt state, and any other state must not carry an interruptedFrom.
 * This keeps RESUME from ever restoring an invalid state.
 */
function isValidInterruptContext(state: string, interruptedFrom: unknown): boolean {
  const stateIsInterrupt = INTERRUPT_STATES.has(state);
  if (stateIsInterrupt) {
    return (
      typeof interruptedFrom === 'string' &&
      WORKFLOW_STATES.includes(interruptedFrom as WorkflowState) &&
      !INTERRUPT_STATES.has(interruptedFrom)
    );
  }
  return interruptedFrom === undefined;
}

/**
 * Minimal structural guard so a corrupt or incompatible file fails loudly at
 * the storage boundary instead of crashing later in the state machine.
 * Mirrors the Run type: state and interruptedFrom must be valid workflow
 * states, the target must be a well-formed IssueTarget/RepositoryTarget, and
 * headSha must be a string when present.
 */
function isRun(value: unknown): value is Run {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.state === 'string' &&
    WORKFLOW_STATES.includes(v.state as WorkflowState) &&
    isTarget(v.target) &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string' &&
    Array.isArray(v.history) &&
    v.history.every(isTransitionRecord) &&
    isOptionalString(v.headSha) &&
    (v.interrupt === undefined || isInterrupt(v.interrupt)) &&
    (v.agentResult === undefined || isAgentResult(v.agentResult)) &&
    (v.executor === undefined || isExecutorIdentity(v.executor)) &&
    (v.reviewResult === undefined || isReviewResult(v.reviewResult)) &&
    isValidInterruptContext(v.state, v.interruptedFrom)
  );
}

/** Write atomically: write to `<path>.tmp`, then rename over the target. */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function readRun(filePath: string, id: string): Run {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read run "${id}" from ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Run file ${filePath} is not valid JSON (corrupt?): ${(err as Error).message}`);
  }
  if (!isRun(parsed)) {
    throw new Error(
      `Run file ${filePath} is corrupt or incompatible: expected a run with a state from the workflow enum (id/state/target/history).`,
    );
  }
  if (parsed.id !== id) {
    throw new Error(
      `Run file ${filePath} is corrupt or incompatible: persisted run id "${parsed.id}" does not match its file name "${id}".`,
    );
  }
  return parsed;
}

/**
 * JSON-file run store with atomic writes. A crash mid-write never corrupts the
 * committed run file, so a run survives a process restart intact: each write
 * goes to `<id>.json.tmp` and is renamed into place only after it is complete.
 */
export class JsonFileStore implements RunStore {
  readonly name = 'json-file';
  private readonly dir: string;

  constructor(options: JsonFileStoreOptions) {
    this.dir = options.dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private filePathFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  create(run: Run): void {
    const filePath = this.filePathFor(run.id);
    if (existsSync(filePath)) {
      throw new Error(`A run with id "${run.id}" already exists at ${filePath}; refusing to overwrite.`);
    }
    writeJsonAtomic(filePath, run);
  }

  read(id: string): Run | null {
    const filePath = this.filePathFor(id);
    if (!existsSync(filePath)) return null;
    return readRun(filePath, id);
  }

  update(run: Run): void {
    writeJsonAtomic(this.filePathFor(run.id), run);
  }

  list(): Run[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readRun(path.join(this.dir, name), name.slice(0, -'.json'.length)));
  }

  delete(id: string): void {
    const filePath = this.filePathFor(id);
    if (!existsSync(filePath)) {
      throw new Error(`No run with id "${id}" exists at ${filePath}; nothing to delete.`);
    }
    unlinkSync(filePath);
  }
}
