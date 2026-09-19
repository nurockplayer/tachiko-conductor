import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from '../dispatch/invocation-lock.js';

import { TRANSITION_TYPES, WORKFLOW_STATES, type Run, type WorkflowState } from '../domain/types.js';
import { isProviderExecutionTelemetry, isRunTelemetry } from '../domain/telemetry.js';
import { isToolOutputEnvelope } from '../evidence/tool-output.js';
import { isValidationResultCoherent } from '../domain/validation.js';
import { CANONICAL_REASONING_EFFORTS, EXECUTION_PROFILE_NAMES, MAX_EXECUTION_TIMEOUT_MS } from '../execution-profiles.js';

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
  /**
   * Optional compare-and-swap write: replace a Run only when its durable
   * identity is still exactly `expected`, returning false when another writer
   * changed it first. Callers must degrade safely when it is absent.
   */
  updateIfUnchanged?(expected: Run, next: Run): boolean;
  list(): Run[];
  delete(id: string): void;
}

export interface JsonFileStoreOptions {
  /** Directory that will hold one `<id>.json` file per run. */
  readonly dir: string;
  /** Bound for waiting on another same-host Run writer. */
  readonly mutationLockTimeoutMs?: number;
  /** Retry cadence while a live Run writer owns the mutation fence. */
  readonly mutationLockRetryMs?: number;
  /** Test seam: runs after CAS comparison succeeds while the mutation fence is still held. */
  readonly beforeConditionalWrite?: () => void;
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
    executor.sessionId.trim().length > 0 &&
    (executor.generation === undefined || (typeof executor.generation === 'string' && executor.generation.trim().length > 0))
  );
}

function isExecutionConfiguration(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const execution = value as Record<string, unknown>;
  return typeof execution.profile === 'string' && EXECUTION_PROFILE_NAMES.includes(execution.profile as typeof EXECUTION_PROFILE_NAMES[number]) &&
    typeof execution.revision === 'string' && execution.revision.trim() !== '' &&
    typeof execution.executor === 'string' && execution.executor.trim() !== '' &&
    typeof execution.timeoutMs === 'number' && Number.isSafeInteger(execution.timeoutMs) &&
    execution.timeoutMs > 0 && execution.timeoutMs <= MAX_EXECUTION_TIMEOUT_MS &&
    isOptionalNonEmptyString(execution.model) &&
    (execution.reasoningEffort === undefined || (CANONICAL_REASONING_EFFORTS as readonly string[]).includes(execution.reasoningEffort as string)) &&
    (execution.sandboxMode === undefined || ['read-only', 'workspace-write', 'danger-full-access'].includes(execution.sandboxMode as string)) &&
    (execution.approvalPolicy === undefined || ['untrusted', 'on-request', 'never'].includes(execution.approvalPolicy as string));
}

function isBootstrapIdentity(value: unknown, target: unknown): boolean {
  if (typeof value !== 'object' || value === null || typeof target !== 'object' || target === null) return false;
  const bootstrap = value as Record<string, unknown>;
  const issue = target as Record<string, unknown>;
  return issue.kind === 'issue' && bootstrap.owner === issue.owner && bootstrap.repo === issue.repo &&
    bootstrap.issueNumber === issue.issueNumber && [
      bootstrap.owner, bootstrap.repo, bootstrap.baseBranch, bootstrap.baseSha, bootstrap.branch, bootstrap.workspacePath,
    ].every((entry) => typeof entry === 'string' && entry.trim() !== '') &&
    typeof bootstrap.issueNumber === 'number' && Number.isSafeInteger(bootstrap.issueNumber) && bootstrap.issueNumber > 0;
}

function isPullRequestIdentity(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const pullRequest = value as Record<string, unknown>;
  return typeof pullRequest.number === 'number' && Number.isSafeInteger(pullRequest.number) && pullRequest.number > 0 &&
    typeof pullRequest.headSha === 'string' && pullRequest.headSha.trim() !== '';
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
    isOptionalDuration(result.durationMs) &&
    (result.output === undefined || isToolOutputEnvelope(result.output)) &&
    (result.telemetry === undefined || isProviderExecutionTelemetry(result.telemetry))
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
    result.findings.every(isReviewFinding) &&
    (result.telemetry === undefined || isProviderExecutionTelemetry(result.telemetry))
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
    (TRANSITION_TYPES.includes(record.type as (typeof TRANSITION_TYPES)[number]) ||
      record.type === 'final_gate_verified' || record.type === 'gate_passed') &&
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
    (v.dispatchClaimId === undefined || (typeof v.dispatchClaimId === 'string' && v.dispatchClaimId.trim() !== '')) &&
    Array.isArray(v.history) &&
    v.history.every(isTransitionRecord) &&
    (v.execution === undefined || isExecutionConfiguration(v.execution)) &&
    isOptionalString(v.headSha) &&
    (v.interrupt === undefined || isInterrupt(v.interrupt)) &&
    (v.agentResult === undefined || isAgentResult(v.agentResult)) &&
    (v.executor === undefined || isExecutorIdentity(v.executor)) &&
    (v.bootstrap === undefined || isBootstrapIdentity(v.bootstrap, v.target)) &&
    (v.pullRequest === undefined || isPullRequestIdentity(v.pullRequest)) &&
    (v.pullRequest === undefined || v.headSha === undefined || (v.pullRequest as { headSha: unknown }).headSha === v.headSha) &&
    (v.reviewResult === undefined || isReviewResult(v.reviewResult)) &&
    (v.validationResult === undefined || isValidationResultCoherent(v.validationResult)) &&
    (v.telemetry === undefined || isRunTelemetry(v.telemetry)) &&
    (v.validationResult === undefined || v.headSha === undefined || (v.validationResult as { headSha: unknown }).headSha === v.headSha) &&
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
/**
 * Identity of one durable Run snapshot for compare-and-swap writes. Any field a
 * workflow transition can change participates, so a stale writer is refused
 * rather than reverting a concurrent transition.
 */
function runFingerprint(run: Run | null): string {
  if (run === null) return 'absent';
  return JSON.stringify({
    state: run.state,
    updatedAt: run.updatedAt,
    headSha: run.headSha ?? null,
    history: run.history.length,
    agentResult: run.agentResult ?? null,
    reviewResult: run.reviewResult ?? null,
    validationResult: run.validationResult ?? null,
    pullRequest: run.pullRequest ?? null,
    executor: run.executor ?? null,
    interrupt: run.interrupt ?? null,
    // Telemetry can change on its own without touching `updatedAt`, so a
    // concurrent telemetry append must invalidate the comparison too.
    telemetry: run.telemetry ?? null,
  });
}

export class RunMutationLockedError extends Error {
  constructor(runId: string, lockPath: string) {
    super(`Run "${runId}" is currently owned by another same-host mutation at ${lockPath}; refusing an unfenced write.`);
    this.name = 'RunMutationLockedError';
  }
}

const DEFAULT_RUN_MUTATION_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_RUN_MUTATION_LOCK_RETRY_MS = 10;

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(cell, 0, 0, milliseconds);
}

export class JsonFileStore implements RunStore {
  readonly name = 'json-file';
  private readonly dir: string;
  private readonly mutationLockTimeoutMs: number;
  private readonly mutationLockRetryMs: number;
  private readonly beforeConditionalWrite: (() => void) | undefined;

  constructor(options: JsonFileStoreOptions) {
    this.dir = path.resolve(options.dir);
    this.mutationLockTimeoutMs = options.mutationLockTimeoutMs ?? DEFAULT_RUN_MUTATION_LOCK_TIMEOUT_MS;
    this.mutationLockRetryMs = options.mutationLockRetryMs ?? DEFAULT_RUN_MUTATION_LOCK_RETRY_MS;
    this.beforeConditionalWrite = options.beforeConditionalWrite;
    if (!Number.isSafeInteger(this.mutationLockTimeoutMs) || this.mutationLockTimeoutMs < 0) {
      throw new Error('mutationLockTimeoutMs must be a non-negative safe integer.');
    }
    if (!Number.isSafeInteger(this.mutationLockRetryMs) || this.mutationLockRetryMs < 1) {
      throw new Error('mutationLockRetryMs must be a positive safe integer.');
    }
    mkdirSync(this.dir, { recursive: true });
  }

  private filePathFor(id: string): string {
    assertSafeId(id);
    return path.join(this.dir, `${id}.json`);
  }

  private mutationLockPathFor(id: string): string {
    return `${this.filePathFor(id)}.mutation.lock`;
  }

  /**
   * Serialize every same-host Run mutation through one per-run process lock.
   * The shared lock covers both the CAS comparison and its write; ordinary
   * update/create/delete writers use the same fence, closing the TOCTOU window.
   */
  private withMutationLock<T>(id: string, operation: () => T): T {
    const lockPath = this.mutationLockPathFor(id);
    const deadlineAt = Date.now() + this.mutationLockTimeoutMs;
    for (;;) {
      try {
        const lock = acquireDispatchInvocationLock({ lockPath });
        try {
          return operation();
        } finally {
          lock.release();
        }
      } catch (error) {
        if (!(error instanceof DispatchInvocationLockedError)) throw error;
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) throw new RunMutationLockedError(id, lockPath);
        sleepSync(Math.min(this.mutationLockRetryMs, remaining));
      }
    }
  }

  create(run: Run): void {
    this.withMutationLock(run.id, () => {
      const filePath = this.filePathFor(run.id);
      if (existsSync(filePath)) {
        throw new Error(`A run with id "${run.id}" already exists at ${filePath}; refusing to overwrite.`);
      }
      writeJsonAtomic(filePath, run);
    });
  }

  read(id: string): Run | null {
    const filePath = this.filePathFor(id);
    if (!existsSync(filePath)) return null;
    return readRun(filePath, id);
  }

  update(run: Run): void {
    this.withMutationLock(run.id, () => {
      writeJsonAtomic(this.filePathFor(run.id), run);
    });
  }

  updateIfUnchanged(expected: Run, next: Run): boolean {
    if (expected.id !== next.id) throw new Error('updateIfUnchanged requires expected and next to name the same Run id.');
    return this.withMutationLock(expected.id, () => {
      const filePath = this.filePathFor(expected.id);
      const current = readRun(filePath, expected.id);
      if (runFingerprint(current) !== runFingerprint(expected)) return false;
      this.beforeConditionalWrite?.();
      writeJsonAtomic(filePath, next);
      return true;
    });
  }

  list(): Run[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readRun(path.join(this.dir, name), name.slice(0, -'.json'.length)));
  }

  delete(id: string): void {
    this.withMutationLock(id, () => {
      const filePath = this.filePathFor(id);
      if (!existsSync(filePath)) {
        throw new Error(`No run with id "${id}" exists at ${filePath}; nothing to delete.`);
      }
      unlinkSync(filePath);
    });
  }
}
