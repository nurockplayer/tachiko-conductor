#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { ClaudeCodeAdapter } from './agents/claude-code.js';
import type { ImplementationCapabilityResolver, McpHttpCapability } from './adapters/agent.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from './adapters/github.js';
import { buildBrowserAgentConnection, type BrowserAgentConnection } from './browser/agent-config.js';
import { openBrowserForBootstrap } from './browser/mcp-client.js';
import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
  ManagedPlaywrightMcpRuntime,
  browserRuntimeCapability,
  type BrowserRuntime,
  type BrowserRuntimeHandle,
  type BrowserRuntimeSnapshot,
  type StartBrowserRuntimeOptions,
} from './browser/playwright-mcp-runtime.js';
import { createRun } from './domain/run.js';
import { LIVE_HEAD_SYNC_DECISION, canSynchronizeInterruptedHead } from './domain/decisions.js';
import { applyTransition, transitionRequiresResult } from './domain/state-machine.js';
import {
  TRANSITION_TYPES,
  type InterruptKind,
  type IssueTarget,
  type RepositoryTarget,
  type Run,
  type Target,
  type TransitionType,
  type WorkflowState,
} from './domain/types.js';
import { GitHubLiveStateError } from './github/errors.js';
import { LiveGitHubAdapter } from './github/live-state.js';
import { GhCliTransport } from './github/transport.js';
import { DeepSeekApiClient, DeepSeekReviewer, GhPullRequestDiffReader } from './reviewers/deepseek.js';
import { JsonFileStore, type RunStore } from './store/json-file-store.js';
import { runWorkflow, type WorkflowDependencies, type WorkflowOutcome } from './workflow/run.js';

const USAGE = `Tachiko Conductor — local orchestration core.

Usage:
  tachiko run owner/repo#123 [--browser-profile <profile>]
  tachiko run resume <id> --decision <choice> [--browser-profile <profile>]
  tachiko run create --owner <owner> --repo <repo> (--issue <n> | --branch <branch>)
  tachiko run show <id>
  tachiko run transition <id> <transition> [--reason <text>]
  tachiko run list
  tachiko github snapshot owner/repo#123
  tachiko browser bootstrap <profile> [--port <n>] [--host <host>]
  tachiko browser start <profile> [--port <n>] [--host <host>] [--headed | --headless]
  tachiko browser status <profile>
  tachiko browser stop <profile>
  tachiko --help

Transitions: ${TRANSITION_TYPES.join(', ')}.

run owner/repo#123 starts or continues one issue end-to-end: implementation,
validation, independent review, and the final gate. It stops at MERGE_READY,
FAILED, or NEEDS_HUMAN (a structured human decision with evidence and bounded
choices). Resume a parked run with: tachiko run resume <id> --decision <text>.

agent_succeeded, agent_failed, review_approved and changes_requested require
result payloads (agentResult / reviewResult) that adapters supply; run
transition cannot perform them and rejects them explicitly. Drive those
through the domain API (applyTransition) instead.

github snapshot prints one normalized live-state JSON envelope from the
locally authenticated gh CLI: {"ok":true,"snapshot":...} on success, or
{"ok":false,"error":...} on stderr with a non-zero exit code.

Run state is stored under $TACHIKO_DATA_DIR (default ~/.tachiko-conductor/runs).
Browser profiles and runtime metadata are stored outside the repository under
~/.tachiko-conductor/browser by default. start/bootstrap own the child process
in the foreground; use status/stop from another terminal.
`;

/** Bounded review attempts before a run parks in NEEDS_HUMAN. */
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 3;
export { LIVE_HEAD_SYNC_DECISION } from './domain/decisions.js';

/** Resolve the directory where run JSON files are stored. */
export function resolveRunsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACHIKO_DATA_DIR ?? path.join(os.homedir(), '.tachiko-conductor', 'runs');
}

export interface BrowserRoots {
  readonly profileRoot: string;
  readonly runtimeRoot: string;
}

export function resolveBrowserRoots(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): BrowserRoots {
  const root = path.join(homeDirectory, '.tachiko-conductor', 'browser');
  return {
    profileRoot: env.TACHIKO_BROWSER_PROFILE_ROOT ?? path.join(root, 'profiles'),
    runtimeRoot: env.TACHIKO_BROWSER_RUNTIME_ROOT ?? path.join(root, 'runtimes'),
  };
}

export function resolveRepositoryRoot(
  cwd: string = process.cwd(),
  resolveGitTopLevel: (directory: string) => string = (directory) =>
    execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 2_000,
    }),
): string {
  try {
    const resolved = resolveGitTopLevel(cwd).trim();
    return resolved === '' ? path.resolve(cwd) : path.resolve(resolved);
  } catch {
    return path.resolve(cwd);
  }
}

export function parseBrowserPort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid browser port "${raw}": expected an integer from 1 to 65535.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid browser port "${raw}": expected an integer from 1 to 65535.`);
  }
  return value;
}

export interface BrowserStartCommandResult extends BrowserAgentConnection {
  readonly handle: BrowserRuntimeHandle;
}

export async function browserStartCommand(
  runtime: BrowserRuntime,
  profile: string,
  options: Omit<StartBrowserRuntimeOptions, 'profile'> = {},
): Promise<BrowserStartCommandResult> {
  const handle = await runtime.start({ profile, ...options, headless: options.headless ?? true });
  return { ...buildBrowserAgentConnection(handle.snapshot), handle };
}

export async function browserBootstrapCommand(
  runtime: BrowserRuntime,
  profile: string,
  options: Omit<StartBrowserRuntimeOptions, 'profile' | 'headless'> = {},
  openBrowser: (endpoint: string) => Promise<void> = openBrowserForBootstrap,
): Promise<BrowserStartCommandResult> {
  const handle = await runtime.start({ profile, ...options, headless: false });
  try {
    await abortable(
      () => openBrowser(handle.snapshot.endpoint),
      options.signal,
      () => new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
        `Browser bootstrap for profile "${profile}" was cancelled while opening the headed browser.`,
        { profile, runtimeId: handle.snapshot.runtimeId },
      ),
    );
    return { ...buildBrowserAgentConnection(handle.snapshot), handle };
  } catch (error) {
    await handle.stop().catch(() => undefined);
    throw error;
  }
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal | undefined, error: () => Error): Promise<T> {
  if (signal === undefined) return operation();
  if (signal.aborted) return Promise.reject(error());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const aborted = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      reject(error());
    };
    signal.addEventListener('abort', aborted, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (operationError) {
      settled = true;
      signal.removeEventListener('abort', aborted);
      reject(operationError);
      return;
    }
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (operationError: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        reject(operationError);
      },
    );
  });
}

export async function browserStatusCommand(runtime: BrowserRuntime, profile: string): Promise<BrowserRuntimeSnapshot> {
  const snapshot = await runtime.status(profile);
  if (snapshot === null) {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
      `Browser profile "${profile}" has no runtime metadata. Run tachiko browser bootstrap ${profile} first.`,
      { profile },
    );
  }
  return snapshot;
}

export async function browserStopCommand(runtime: BrowserRuntime, profile: string): Promise<BrowserRuntimeSnapshot> {
  return await runtime.stop(profile);
}

export async function browserImplementationCapabilities(
  runtime: BrowserRuntime,
  profile: string | undefined,
): Promise<readonly McpHttpCapability[] | undefined> {
  if (profile === undefined) return undefined;
  const snapshot = await browserStatusCommand(runtime, profile);
  return [browserRuntimeCapability(snapshot)];
}

/**
 * Parse a GitHub issue number strictly: a decimal integer >= 1 that is also a
 * safe JavaScript integer. Partial, malformed, zero, negative, or
 * unrepresentable input (`42oops`, `3.5`, `0`, `-1`, `9007199254740993`,
 * overflow-to-Infinity) is rejected instead of being silently truncated or
 * rounded by a prefix parse.
 */
export function parseIssueNumber(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --issue "${raw}": expected a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid --issue "${raw}": issue numbers must be a safe integer >= 1.`);
  }
  return value;
}

/** Parse a strict `owner/repo#123` issue reference into a target. */
export function parseIssueRef(raw: string): IssueTarget {
  const match = /^([^/]+)\/([^/#]+)#(\d+)$/.exec(raw);
  if (match === null) {
    throw new Error(`Invalid issue reference "${raw}": expected owner/repo#123.`);
  }
  return {
    kind: 'issue',
    owner: match[1] ?? '',
    repo: match[2] ?? '',
    issueNumber: parseIssueNumber(match[3] ?? ''),
  };
}

/** Map any snapshot failure to a stable machine-readable error object. */
export function serializeGithubError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof GitHubLiveStateError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

export type GithubSnapshotEnvelope =
  | { readonly ok: true; readonly snapshot: GitHubLiveSnapshot }
  | { readonly ok: false; readonly error: Readonly<Record<string, unknown>> };

/** Read one normalized live snapshot for `owner/repo#123` through an injected adapter. */
export async function githubSnapshotCommand(adapter: GitHubAdapter, ref: string): Promise<GithubSnapshotEnvelope> {
  const target = parseIssueRef(ref);
  try {
    const snapshot = await adapter.readLiveSnapshot(target);
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, error: serializeGithubError(error) };
  }
}

function targetsEqual(a: Target, b: Target): boolean {
  if (a.kind !== b.kind || a.owner !== b.owner || a.repo !== b.repo) return false;
  if (a.kind === 'issue') return (b as IssueTarget).issueNumber === (a as IssueTarget).issueNumber;
  return (b as RepositoryTarget).branch === (a as RepositoryTarget).branch;
}

/** Find a persisted run whose target matches exactly, if any. */
export function findRunByTarget(store: RunStore, target: Target): Run | null {
  return store.list().find((run) => targetsEqual(run.target, target)) ?? null;
}

export interface WorkflowCommandOptions {
  readonly maxReviewAttempts?: number;
  readonly now?: () => string;
}

/**
 * Start or continue one issue end-to-end: create a READY run when none exists
 * for the target, then drive it through implementation, validation, the
 * independent review loop, and the final gate.
 */
export async function runIssueCommand(
  deps: WorkflowDependencies,
  ref: string,
  options: WorkflowCommandOptions = {},
): Promise<WorkflowOutcome> {
  const target = parseIssueRef(ref);
  let run = findRunByTarget(deps.store, target);
  if (run === null) {
    run = createRun(target);
    deps.store.create(run);
  }
  return runWorkflow(deps, run.id, {
    maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
    now: options.now,
  });
}

/**
 * Resume a run parked in NEEDS_HUMAN / WAITING_DEPENDENCY with a supplied
 * human decision, then continue the workflow from the interrupted state.
 * NEEDS_HUMAN resumes via human_resolved; WAITING_DEPENDENCY resumes via
 * dependency_satisfied — the transition is chosen from the parked state so
 * the resume path always matches the state machine.
 */
export async function resumeCommand(
  deps: WorkflowDependencies,
  id: string,
  decision: string,
  options: WorkflowCommandOptions = {},
): Promise<WorkflowOutcome> {
  const run = deps.store.read(id);
  if (run === null) throw new Error(`No run with id "${id}" found.`);
  if (run.state !== 'NEEDS_HUMAN' && run.state !== 'WAITING_DEPENDENCY') {
    throw new Error(`Run "${id}" is not parked for a decision (state ${run.state}); nothing to resume.`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  const transition = run.state === 'NEEDS_HUMAN' ? 'human_resolved' : 'dependency_satisfied';
  let synchronizedHead: string | undefined;
  const synchronizeLiveHead =
    decision.trim() === LIVE_HEAD_SYNC_DECISION &&
    run.state === 'NEEDS_HUMAN' &&
    canSynchronizeInterruptedHead(run.interruptedFrom) &&
    run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION) === true &&
    run.target.kind === 'issue';
  if (synchronizeLiveHead && run.target.kind === 'issue') {
    const snapshot = await deps.github.readLiveSnapshot(run.target);
    if (snapshot.headSha === null) {
      throw new Error(`Cannot synchronize run "${id}": its issue has no live pull request HEAD.`);
    }
    synchronizedHead = snapshot.headSha;
  }
  const resumed = applyTransition(
    run,
    {
      type: transition,
      reason: decision,
      ...(synchronizedHead === undefined ? {} : { headSha: synchronizedHead }),
    },
    now(),
  );
  deps.store.update(resumed);
  return runWorkflow(deps, id, {
    maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
    now: options.now,
  });
}

export function resumeCommandHint(runId: string, browserProfile?: string): string {
  return `tachiko run resume ${runId} --decision <choice>${
    browserProfile === undefined ? '' : ` --browser-profile ${browserProfile}`
  }`;
}

function printOutcome(outcome: WorkflowOutcome, browserProfile?: string): void {
  const { run } = outcome;
  if (outcome.outcome === 'merge_ready') {
    console.log(
      `Run ${run.id}: MERGE_READY — implementation passed independent review at ${run.headSha ?? '(no HEAD)'}.`,
    );
    return;
  }
  if (outcome.outcome === 'merged') {
    console.log(`Run ${run.id}: MERGED — the pull request was already merged.`);
    return;
  }
  if (outcome.outcome === 'needs_human') {
    console.log(`Run ${run.id}: NEEDS_HUMAN — ${outcome.reason}`);
    const interrupt = run.interrupt;
    if (interrupt?.evidence !== undefined) console.log(`Evidence: ${interrupt.evidence}`);
    if ((interrupt?.choices?.length ?? 0) > 0) console.log(`Choices: ${interrupt?.choices?.join(' | ')}`);
    console.log(`Resume with: ${resumeCommandHint(run.id, browserProfile)}`);
    return;
  }
  console.error(`Run ${run.id}: FAILED — ${outcome.reason}`);
}

/** Production wiring: local gh CLI, Claude Code, and the DeepSeek reviewer. */
function buildWorkflowDeps(
  store: RunStore,
  resolveImplementationCapabilities?: ImplementationCapabilityResolver,
): WorkflowDependencies {
  const transport = new GhCliTransport();
  const github = new LiveGitHubAdapter({ transport });
  return {
    store,
    github,
    implementation: new ClaudeCodeAdapter({ cwd: process.cwd(), github }),
    reviewer: new DeepSeekReviewer({
      github,
      diffReader: new GhPullRequestDiffReader(transport),
      client: new DeepSeekApiClient(),
    }),
    resolveImplementationCapabilities,
  };
}

// --- commands (exported so tests can exercise them without spawning a process) ---

export function runCreateCommand(
  store: RunStore,
  owner: string,
  repo: string,
  opts: { issue?: number; branch?: string },
): Run {
  const hasIssue = opts.issue !== undefined;
  const hasBranch = opts.branch !== undefined;
  if (hasIssue && hasBranch) {
    throw new Error('run create requires exactly one of --issue <n> or --branch <branch>; got both.');
  }
  if (!hasIssue && !hasBranch) {
    throw new Error('run create requires exactly one of --issue <n> or --branch <branch>.');
  }
  let target: Target;
  if (opts.issue !== undefined) {
    target = { kind: 'issue', owner, repo, issueNumber: opts.issue };
  } else {
    target = { kind: 'repository', owner, repo, branch: opts.branch ?? 'main' };
  }
  const run = createRun(target);
  store.create(run);
  return run;
}

export function runShowCommand(store: RunStore, id: string): Run {
  const run = store.read(id);
  if (run === null) throw new Error(`No run with id "${id}" found.`);
  return run;
}

export function runTransitionCommand(store: RunStore, id: string, type: TransitionType, reason?: string): Run {
  const requirement = transitionRequiresResult(type);
  if (requirement !== 'none') {
    throw new Error(
      `Transition "${type}" requires an ${requirement}Result payload that this CLI cannot supply. ` +
        `Drive it through the domain API (applyTransition) instead.`,
    );
  }
  const current = store.read(id);
  if (current === null) throw new Error(`No run with id "${id}" found.`);
  const next = applyTransition(current, { type, reason });
  store.update(next);
  return next;
}

export function runListCommand(store: RunStore): Run[] {
  return store.list();
}

export interface RunView {
  id: string;
  target: Target;
  state: WorkflowState;
  headSha: string | null;
  /** Only an unresolved interrupt is a current interrupt. */
  interrupt: { kind: InterruptKind; reason: string } | null;
  transitions: number;
  updatedAt: string;
}

/** Project a run for display; a resolved interrupt is historical, not active. */
export function runShowView(run: Run): RunView {
  const activeInterrupt =
    run.interrupt !== undefined && run.interrupt.resolvedAt === undefined
      ? { kind: run.interrupt.kind, reason: run.interrupt.reason }
      : null;
  return {
    id: run.id,
    target: run.target,
    state: run.state,
    headSha: run.headSha ?? null,
    interrupt: activeInterrupt,
    transitions: run.history.length,
    updatedAt: run.updatedAt,
  };
}

function printRun(run: Run): void {
  console.log(JSON.stringify(runShowView(run), null, 2));
}

function buildBrowserRuntime(): ManagedPlaywrightMcpRuntime {
  const roots = resolveBrowserRoots();
  return new ManagedPlaywrightMcpRuntime({
    ...roots,
    repositoryRoot: resolveRepositoryRoot(),
  });
}

function printBrowserStart(result: BrowserStartCommandResult): void {
  const { handle: _handle, ...view } = result;
  console.log(JSON.stringify({ ok: true, ...view }, null, 2));
}

function serializeBrowserError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof BrowserRuntimeError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
}

interface BrowserSignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export async function waitForOwnedBrowser(
  start: (signal: AbortSignal) => Promise<BrowserStartCommandResult>,
  onStarted: (result: BrowserStartCommandResult) => void = () => undefined,
  signalSource: BrowserSignalSource = process,
): Promise<BrowserRuntimeSnapshot> {
  let stopping = false;
  let handle: BrowserRuntimeHandle | undefined;
  const startupAbort = new AbortController();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    startupAbort.abort();
    if (handle !== undefined) void handle.stop().catch(() => undefined);
  };
  signalSource.on('SIGINT', stop);
  signalSource.on('SIGTERM', stop);
  try {
    const result = await start(startupAbort.signal);
    handle = result.handle;
    onStarted(result);
    if (stopping) return await handle.stop();
    return await handle.waitForExit();
  } finally {
    signalSource.removeListener('SIGINT', stop);
    signalSource.removeListener('SIGTERM', stop);
  }
}

export async function main(argv: string[]): Promise<number> {
  const store = new JsonFileStore({ dir: resolveRunsDir() });
  const [command, subcommand, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  if (command === 'browser') {
    const runtime = buildBrowserRuntime();
    try {
      if (subcommand === 'start' || subcommand === 'bootstrap') {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            port: { type: 'string' },
            host: { type: 'string' },
            headed: { type: 'boolean' },
            headless: { type: 'boolean' },
          },
        });
        const [profile] = positionals;
        if (profile === undefined) throw new Error(`browser ${subcommand} requires a profile name.`);
        if (values.headed === true && values.headless === true) {
          throw new Error('browser start accepts only one of --headed or --headless.');
        }
        if (subcommand === 'bootstrap' && values.headless === true) {
          throw new Error('browser bootstrap is always headed so a human can complete authentication.');
        }
        const port = values.port === undefined ? undefined : parseBrowserPort(values.port);
        const shared = { ...(port === undefined ? {} : { port }), ...(values.host === undefined ? {} : { host: values.host }) };
        const finalSnapshot = await waitForOwnedBrowser(
          async (signal) =>
            subcommand === 'bootstrap'
              ? await browserBootstrapCommand(runtime, profile, { ...shared, signal })
              : await browserStartCommand(runtime, profile, {
                  ...shared,
                  signal,
                  headless: values.headed === true ? false : true,
                }),
          printBrowserStart,
        );
        if (finalSnapshot.state === 'failed') {
          console.error(JSON.stringify({ ok: false, runtime: finalSnapshot }, null, 2));
          return 1;
        }
        return 0;
      }
      if (subcommand === 'status' || subcommand === 'stop') {
        const profile = rest[0];
        if (profile === undefined) throw new Error(`browser ${subcommand} requires a profile name.`);
        const snapshot =
          subcommand === 'status'
            ? await browserStatusCommand(runtime, profile)
            : await browserStopCommand(runtime, profile);
        console.log(JSON.stringify({ ok: true, runtime: snapshot }, null, 2));
        return 0;
      }
      console.error(`Unknown command: browser ${subcommand ?? ''}\n`);
      console.error(USAGE);
      return 1;
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: serializeBrowserError(error) }, null, 2));
      return 1;
    }
  }

  if (command === 'github') {
    if (subcommand === 'snapshot') {
      const ref = rest[0];
      if (ref === undefined) {
        console.error('github snapshot requires owner/repo#123.');
        return 1;
      }
      const adapter = new LiveGitHubAdapter({ transport: new GhCliTransport() });
      const outcome = await githubSnapshotCommand(adapter, ref);
      if (outcome.ok) {
        console.log(JSON.stringify(outcome, null, 2));
        return 0;
      }
      console.error(JSON.stringify({ ok: false, error: outcome.error }, null, 2));
      return 1;
    }
    console.error(`Unknown command: github ${subcommand ?? ''}\n`);
    console.error(USAGE);
    return 1;
  }

  if (command !== 'run') {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    return 1;
  }

  if (subcommand === 'create') {
    const { values } = parseArgs({
      args: rest,
      options: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue: { type: 'string' },
        branch: { type: 'string' },
      },
    });
    const { owner, repo } = values;
    if (owner === undefined || repo === undefined) {
      throw new Error('run create requires --owner and --repo.');
    }
    const issue = values.issue !== undefined ? parseIssueNumber(values.issue) : undefined;
    const run = runCreateCommand(store, owner, repo, { issue, branch: values.branch });
    console.log(`Created run ${run.id} (${run.state}).`);
    printRun(run);
    return 0;
  }

  if (subcommand === 'show') {
    const id = rest[0];
    if (id === undefined) throw new Error('run show requires a run id.');
    printRun(runShowCommand(store, id));
    return 0;
  }

  if (subcommand === 'transition') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { reason: { type: 'string' } },
    });
    const [id, type] = positionals;
    if (id === undefined || type === undefined) {
      throw new Error('run transition requires <id> and <transition>.');
    }
    if (!TRANSITION_TYPES.includes(type as TransitionType)) {
      throw new Error(`Unknown transition "${type}". Valid transitions: ${TRANSITION_TYPES.join(', ')}.`);
    }
    const next = runTransitionCommand(store, id, type as TransitionType, values.reason);
    console.log(`Run ${next.id}: ${next.state}.`);
    printRun(next);
    return 0;
  }

  if (subcommand === 'list') {
    for (const run of runListCommand(store)) {
      console.log(`${run.id}\t${run.state}\t${JSON.stringify(run.target)}`);
    }
    return 0;
  }

  if (subcommand === 'resume') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        decision: { type: 'string' },
        'browser-profile': { type: 'string' },
      },
    });
    const [id] = positionals;
    if (id === undefined) throw new Error('run resume requires a run id.');
    const runtime = buildBrowserRuntime();
    const resolveCapabilities = async () => await browserImplementationCapabilities(runtime, values['browser-profile']);
    const outcome = await resumeCommand(
      buildWorkflowDeps(store, resolveCapabilities),
      id,
      values.decision ?? 'resumed',
    );
    printOutcome(outcome, values['browser-profile']);
    return outcome.outcome === 'failed' ? 1 : 0;
  }

  if (subcommand === undefined) {
    console.error('run requires a subcommand or an owner/repo#123 reference.\n');
    console.error(USAGE);
    return 1;
  }

  // The remaining form is `run owner/repo#123`: start or continue one issue.
  const { values, positionals } = parseArgs({
    args: [subcommand, ...rest],
    allowPositionals: true,
    options: { 'browser-profile': { type: 'string' } },
  });
  const [ref, extra] = positionals;
  if (ref === undefined || extra !== undefined) {
    throw new Error('run requires exactly one owner/repo#123 reference.');
  }
  const runtime = buildBrowserRuntime();
  const resolveCapabilities = async () => await browserImplementationCapabilities(runtime, values['browser-profile']);
  const outcome = await runIssueCommand(buildWorkflowDeps(store, resolveCapabilities), ref);
  printOutcome(outcome, values['browser-profile']);
  return outcome.outcome === 'failed' ? 1 : 0;
}

// Run directly (`node dist/cli.js ...` or `node --import tsx src/cli.ts ...`)
// as well as via the `tachiko` bin entry.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
