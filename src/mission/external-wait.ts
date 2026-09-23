import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { classifyWaitChange, normalizeWaitObservation, type WaitObservation, type WaitSubjectStatus, type WaitWakeReason } from '../domain/wait.js';
import { acquireDispatchInvocationLock, DispatchInvocationLockedError } from '../dispatch/invocation-lock.js';

const REVISION = 'mission-external-wait-v1' as const;
const MAX_PROBE_OUTPUT = 16 * 1024;
const MAX_EVIDENCE = 240;

export interface ExternalMissionConfig {
  readonly id: string;
  readonly generation: string;
  readonly owner: string;
  readonly sessionId: string;
  readonly worktree: string;
  readonly cwd: string;
  readonly probeArgv: readonly string[];
  readonly wakeArgv: readonly string[];
  readonly pollIntervalMs: number;
  readonly probeTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly onTimeout: 'continue' | 'policy-action';
}

export interface ExternalMissionReceipt {
  readonly id: string;
  readonly missionId: string;
  readonly generation: string;
  readonly reason: WaitWakeReason;
  readonly status: 'active' | 'completed' | 'failed' | 'blocked';
  readonly evidence: readonly { readonly kind: string; readonly detail: string }[];
  readonly createdAt: string;
}

export interface ExternalMissionState {
  readonly revision: typeof REVISION;
  readonly config: ExternalMissionConfig;
  readonly status: 'starting' | 'waiting' | 'completed' | 'failed' | 'blocked';
  readonly previous: WaitObservation | null;
  readonly receipt: ExternalMissionReceipt | null;
  readonly callback: 'not-needed' | 'pending' | 'delivered' | 'failed';
  readonly probeCount: number;
  readonly deadlineAt: string;
  readonly timeoutCount: number;
  readonly supervisorPid: number | null;
  readonly updatedAt: string;
  readonly error?: string;
}

export class ExternalMissionStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(directory: string, id: string) {
    if (!path.isAbsolute(directory)) throw new Error('Mission wait directory must be absolute.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id)) throw new Error('Mission id must contain 1-120 letters, numbers, dots, underscores, or hyphens.');
    this.filePath = path.join(directory, `${id}.mission-wait.json`);
    this.lockPath = `${this.filePath}.lock`;
  }

  read(): ExternalMissionState | null {
    let raw: string;
    try { raw = readFileSync(this.filePath, 'utf8'); }
    catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') return null;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!isState(value)) throw new Error(`Mission wait state ${this.filePath} is corrupt; refusing to overwrite it.`);
    return value;
  }

  write(state: ExternalMissionState): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}

function isStatus(value: unknown): value is WaitSubjectStatus {
  return value === 'active' || value === 'completed' || value === 'failed' || value === 'blocked' || value === 'idle' || value === 'unknown' || value === 'unavailable';
}

function isState(value: unknown): value is ExternalMissionState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const config = record.config as Record<string, unknown> | undefined;
  return record.revision === REVISION && typeof config === 'object' && config !== null &&
    typeof config.id === 'string' && typeof config.generation === 'string' &&
    typeof config.owner === 'string' && config.owner !== '' && typeof config.sessionId === 'string' && config.sessionId !== '' &&
    typeof config.worktree === 'string' && path.isAbsolute(config.worktree) && typeof config.cwd === 'string' && path.isAbsolute(config.cwd) &&
    Array.isArray(config.probeArgv) &&
    config.probeArgv.every((item) => typeof item === 'string') && Array.isArray(config.wakeArgv) && config.wakeArgv.every((item) => typeof item === 'string') &&
    Number.isSafeInteger(config.pollIntervalMs) && Number.isSafeInteger(config.probeTimeoutMs) && Number.isSafeInteger(config.overallTimeoutMs) &&
    (config.onTimeout === 'continue' || config.onTimeout === 'policy-action') &&
    ['starting', 'waiting', 'completed', 'failed', 'blocked'].includes(String(record.status)) &&
    ['not-needed', 'pending', 'delivered', 'failed'].includes(String(record.callback)) &&
    Number.isSafeInteger(record.probeCount) && Number.isSafeInteger(record.timeoutCount) && typeof record.deadlineAt === 'string' && Number.isFinite(Date.parse(record.deadlineAt)) && typeof record.updatedAt === 'string';
}

export function parseArgvJson(value: string, option: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${option} must be a JSON string array.`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${option} must be a non-empty JSON array of non-empty strings.`);
  }
  return parsed;
}

export function validateExternalMissionConfig(input: Omit<ExternalMissionConfig, 'generation'> & { readonly generation?: string }): ExternalMissionConfig {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(input.id)) throw new Error('Mission id must contain 1-120 letters, numbers, dots, underscores, or hyphens.');
  if (!input.owner || input.owner.length > 160) throw new Error('--owner must be a non-empty value of at most 160 characters.');
  if (!input.sessionId || input.sessionId.length > 200) throw new Error('--session-id must be a non-empty value of at most 200 characters.');
  if (!path.isAbsolute(input.worktree) || !path.isAbsolute(input.cwd)) throw new Error('--worktree and --cwd must be absolute paths.');
  for (const [name, argv] of [['--probe-argv', input.probeArgv], ['--wake-argv', input.wakeArgv]] as const) {
    if (!Array.isArray(argv) || (name === '--probe-argv' && argv.length === 0) || argv.some((part) => typeof part !== 'string' || part.length === 0)) {
      throw new Error(`${name} must be ${name === '--probe-argv' ? 'a non-empty' : 'an'} argument vector.`);
    }
  }
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 250) throw new Error('--poll-interval-ms must be a safe integer of at least 250.');
  if (!Number.isSafeInteger(input.probeTimeoutMs) || input.probeTimeoutMs < 1 || input.probeTimeoutMs > 120_000) throw new Error('--probe-timeout-ms must be between 1 and 120000.');
  if (!Number.isSafeInteger(input.overallTimeoutMs) || input.overallTimeoutMs < 1 || input.overallTimeoutMs > 7 * 24 * 60 * 60_000) throw new Error('--timeout-ms must be between 1 and 604800000.');
  if (input.onTimeout !== 'continue' && input.onTimeout !== 'policy-action') throw new Error('--on-timeout must be continue or policy-action.');
  return { ...input, generation: input.generation ?? randomUUID() };
}

function readProbe(config: ExternalMissionConfig): WaitObservation {
  const [file, ...args] = config.probeArgv;
  if (file === undefined) throw new Error('Probe argv is empty.');
  const output = execFileSync(file, args, { encoding: 'utf8', timeout: config.probeTimeoutMs, maxBuffer: MAX_PROBE_OUTPUT, windowsHide: true });
  if (Buffer.byteLength(output, 'utf8') > MAX_PROBE_OUTPUT) throw new Error('Probe output exceeded 16 KiB.');
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error('Probe output must be one JSON object.'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Probe output must be one JSON object.');
  const record = value as Record<string, unknown>;
  const status = record.status === 'running' ? 'active' : record.status;
  if (!isStatus(status) || status === 'unavailable' || status === 'unknown' || status === 'idle') throw new Error('Probe status must be running, active, completed, failed, or blocked.');
  const items = record.items ?? 0;
  const turns = record.turns ?? 0;
  if (!Number.isSafeInteger(items) || (items as number) < 0 || !Number.isSafeInteger(turns) || (turns as number) < 0) throw new Error('Probe items and turns must be non-negative safe integers.');
  const activeItemId = record.activeItemId;
  const lastCompletedTurnId = record.lastCompletedTurnId;
  if (activeItemId !== undefined && (typeof activeItemId !== 'string' || activeItemId.length > 160)) throw new Error('Probe activeItemId must be a string of at most 160 characters.');
  if (lastCompletedTurnId !== undefined && (typeof lastCompletedTurnId !== 'string' || lastCompletedTurnId.length > 160)) throw new Error('Probe lastCompletedTurnId must be a string of at most 160 characters.');
  return normalizeWaitObservation({
    source: 'subprocess',
    subjectId: config.id,
    observedAt: new Date().toISOString(),
    snapshot: {
      status,
      items: items as number,
      turns: turns as number,
      ...(activeItemId === undefined ? {} : { activeItemId }),
      ...(lastCompletedTurnId === undefined ? {} : { lastCompletedTurnId }),
    },
  });
}

function terminal(status: WaitSubjectStatus): status is 'completed' | 'failed' | 'blocked' {
  return status === 'completed' || status === 'failed' || status === 'blocked';
}

function makeReceipt(config: ExternalMissionConfig, observation: WaitObservation, reason: WaitWakeReason, evidence: ExternalMissionReceipt['evidence'], status = observation.status): ExternalMissionReceipt {
  return {
    id: `mission-receipt:${config.id}:${config.generation}`,
    missionId: config.id,
    generation: config.generation,
    reason,
    status: status as ExternalMissionReceipt['status'],
    evidence: evidence.slice(0, 3).map((item) => ({ kind: item.kind, detail: item.detail.slice(0, MAX_EVIDENCE) })),
    createdAt: new Date().toISOString(),
  };
}

function callWake(config: ExternalMissionConfig, store: ExternalMissionStore, receipt: ExternalMissionReceipt): void {
  if (config.wakeArgv.length === 0) return;
  const [file, ...args] = config.wakeArgv;
  if (file === undefined) return;
  execFileSync(file, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: MAX_PROBE_OUTPUT, windowsHide: true,
    env: {
      ...process.env,
      TACHIKO_MISSION_RECEIPT_ID: receipt.id,
      TACHIKO_MISSION_RECEIPT_PATH: store.filePath,
      TACHIKO_MISSION_ID: config.id,
      TACHIKO_MISSION_OWNER: config.owner,
      TACHIKO_MISSION_SESSION_ID: config.sessionId,
      TACHIKO_MISSION_WORKTREE: config.worktree,
      TACHIKO_MISSION_CWD: config.cwd,
    },
  });
}

export async function superviseExternalMissionAsync(
  store: ExternalMissionStore,
  options: {
    readonly observe?: (config: ExternalMissionConfig) => WaitObservation;
    readonly wake?: (config: ExternalMissionConfig, store: ExternalMissionStore, receipt: ExternalMissionReceipt) => void;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly maxPolls?: number;
    readonly now?: () => number;
  } = {},
): Promise<void> {
  const lock = acquireDispatchInvocationLock({ lockPath: store.lockPath });
  try {
    const observe = options.observe ?? readProbe;
    const wake = options.wake ?? callWake;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    let state = store.read();
    if (state === null) throw new Error(`Mission wait ${store.filePath} was not initialized.`);
    if (state.receipt !== null) {
      if (state.callback === 'pending' || state.callback === 'failed') {
        try { wake(state.config, store, state.receipt); state = { ...state, callback: 'delivered', updatedAt: new Date().toISOString() }; }
        catch { state = { ...state, callback: 'failed', error: 'wake callback failed; retry mission wait start', updatedAt: new Date().toISOString() }; }
        store.write(state);
      }
      return;
    }
    state = { ...state, status: 'waiting', supervisorPid: process.pid, updatedAt: new Date().toISOString() };
    store.write(state);
    let polls = 0;
    for (;;) {
      const deadlineReached: boolean = now() >= Date.parse(state.deadlineAt);
      let observation: WaitObservation;
      try { observation = observe(state.config); }
      catch {
        observation = normalizeWaitObservation({ source: 'subprocess', subjectId: state.config.id, observedAt: new Date().toISOString(), snapshot: { status: 'failed', evidence: [{ kind: 'failure', detail: 'status probe execution or contract failed' }] } });
      }
      const change = classifyWaitChange(state.previous, observation);
      if (terminal(observation.status) && (change.kind === 'completion' || change.kind === 'failure' || change.kind === 'blocked')) {
        const receipt = makeReceipt(state.config, observation, change.kind, change.evidence);
        state = { ...state, status: observation.status, previous: observation, receipt, callback: state.config.wakeArgv.length === 0 ? 'not-needed' : 'pending', probeCount: state.probeCount + 1, updatedAt: new Date().toISOString() };
        store.write(state);
        if (state.callback === 'pending') {
          try { wake(state.config, store, receipt); state = { ...state, callback: 'delivered', updatedAt: new Date().toISOString() }; }
          catch { state = { ...state, callback: 'failed', error: 'wake callback failed; retry mission wait start', updatedAt: new Date().toISOString() }; }
          store.write(state);
        }
        return;
      }
      if (deadlineReached && state.config.onTimeout === 'policy-action') {
        const receipt = makeReceipt(state.config, observation, 'timeout-policy', [{ kind: 'status-changed', detail: 'overall mission wait deadline reached' }], 'active');
        state = { ...state, status: 'waiting', previous: observation, receipt, callback: state.config.wakeArgv.length === 0 ? 'not-needed' : 'pending', probeCount: state.probeCount + 1, timeoutCount: state.timeoutCount + 1, deadlineAt: new Date(now() + state.config.overallTimeoutMs).toISOString(), updatedAt: new Date(now()).toISOString() };
        store.write(state);
        if (state.callback === 'pending') {
          try { wake(state.config, store, receipt); state = { ...state, callback: 'delivered', updatedAt: new Date(now()).toISOString() }; }
          catch { state = { ...state, callback: 'failed', error: 'wake callback failed; retry mission wait start', updatedAt: new Date(now()).toISOString() }; }
          store.write(state);
        }
        return;
      }
      state = {
        ...state,
        previous: observation,
        probeCount: state.probeCount + 1,
        ...(deadlineReached ? { deadlineAt: new Date(now() + state.config.overallTimeoutMs).toISOString(), timeoutCount: state.timeoutCount + 1 } : {}),
        updatedAt: new Date(now()).toISOString(),
      };
      store.write(state);
      polls += 1;
      if (options.maxPolls !== undefined && polls >= options.maxPolls) return;
      await sleep(state.config.pollIntervalMs);
    }
  } finally { lock.release(); }
}

export function createExternalMissionState(config: ExternalMissionConfig): ExternalMissionState {
  return { revision: REVISION, config, status: 'starting', previous: null, receipt: null, callback: config.wakeArgv.length === 0 ? 'not-needed' : 'pending', probeCount: 0, supervisorPid: null, deadlineAt: new Date(Date.now() + config.overallTimeoutMs).toISOString(), timeoutCount: 0, updatedAt: new Date().toISOString() };
}

function sameMissionConfig(left: ExternalMissionConfig, right: ExternalMissionConfig): boolean {
  return JSON.stringify(left.probeArgv) === JSON.stringify(right.probeArgv) &&
    JSON.stringify(left.wakeArgv) === JSON.stringify(right.wakeArgv) &&
    left.owner === right.owner && left.sessionId === right.sessionId && left.worktree === right.worktree && left.cwd === right.cwd &&
    left.pollIntervalMs === right.pollIntervalMs && left.probeTimeoutMs === right.probeTimeoutMs &&
    left.overallTimeoutMs === right.overallTimeoutMs && left.onTimeout === right.onTimeout;
}

/** Persist the start state before spawning, with no parent write after launch. */
export function startExternalMission(
  store: ExternalMissionStore,
  config: ExternalMissionConfig,
  launch: () => void,
): { readonly state: ExternalMissionState; readonly started: boolean; readonly alreadyRunning: boolean } {
  const startLock = acquireDispatchInvocationLock({ lockPath: `${store.lockPath}.start` });
  try {
    let state = store.read();
    if (state === null) state = createExternalMissionState(config);
    else if (!sameMissionConfig(state.config, config)) throw new Error(`Mission id ${config.id} already belongs to a different durable wait configuration.`);

    if (state.receipt !== null && state.callback !== 'failed' && state.callback !== 'pending') {
      return { state, started: false, alreadyRunning: false };
    }
    try {
      const owner = acquireDispatchInvocationLock({ lockPath: store.lockPath });
      try {
        state = { ...state, status: state.receipt === null ? 'starting' : state.status, supervisorPid: null, updatedAt: new Date().toISOString() };
        store.write(state);
        launch();
        return { state: store.read() ?? state, started: true, alreadyRunning: false };
      } finally {
        owner.release();
      }
    } catch (error) {
      if (!(error instanceof DispatchInvocationLockedError)) throw error;
      return { state, started: false, alreadyRunning: true };
    }
  } finally {
    startLock.release();
  }
}

export { DispatchInvocationLockedError };
