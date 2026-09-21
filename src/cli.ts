#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { CLAUDE_CODE_PROVIDER, ClaudeCodeAdapter } from './agents/claude-code.js';
import {
  CODEX_CLI_PROVIDER,
  CodexCliAdapter,
  type CodexCliAdapterOptions,
} from './agents/codex-cli.js';
import { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter, type NativeThreadObservation } from './agents/codex-app-server.js';
import { IsolatedLunaAdapter, LUNA_ISOLATED_PROVIDER } from './agents/luna-isolated.js';
import { ImplementationAgentRegistry } from './agents/implementation-router.js';
import { WORKER_ROUTER_PROVIDER, WorkerRouterAdapter } from './agents/worker-router.js';
import type { ImplementationCapabilityResolver, McpHttpCapability } from './adapters/agent.js';
import type { ImplementationBootstrapAdapter } from './adapters/bootstrap.js';
import type { GitHubAdapter, GitHubLiveSnapshot } from './adapters/github.js';
import type { HostedCheckPolicyConfiguration, LocalValidationConfiguration } from './adapters/validation.js';
import {
  ConfiguredLocalValidationAdapter,
  MAX_LOCAL_VALIDATION_TIMEOUT_MS,
  MIN_LOCAL_VALIDATION_TIMEOUT_MS,
} from './validation/local-command.js';
import { buildBrowserAgentConnection, type BrowserAgentConnection } from './browser/agent-config.js';
import { openBrowserForBootstrap, type BootstrapBrowserLease } from './browser/mcp-client.js';
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
import { parseRepairTaskShapeAuthority, type RepairTaskShapeAuthority } from './domain/repair-admission.js';
import {
  assertExecutionSupportedByProvider,
  normalizeReasoningEffort,
  parseExecutionProfileConfiguration,
  resolveExecutionProfile,
  type ResolvedExecutionConfiguration,
} from './execution-profiles.js';
import {
  CANCEL_RUN_DECISION,
  LIVE_HEAD_SYNC_DECISION,
  RECOVER_LEGACY_PULL_REQUEST_DECISION,
  REESTABLISH_READINESS_DECISION,
  canRecoverLegacyPullRequest,
  canReestablishInterruptedReadiness,
  canSynchronizeInterruptedHead,
} from './domain/decisions.js';
import { applyTransition, transitionRequiresResult } from './domain/state-machine.js';
import { projectRunEfficiency, type RunEfficiencyProjection } from './domain/telemetry.js';
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
import { GhCliTransport, NodeProcessRunner } from './github/transport.js';
import { DeepSeekApiClient, DeepSeekReviewer, GhPullRequestDiffReader } from './reviewers/deepseek.js';
import { JsonFileStore, type RunStore } from './store/json-file-store.js';
import { GitWorktreeBootstrap } from './workspace/git-worktree-bootstrap.js';
import { StandaloneGitBootstrap } from './workspace/standalone-git-bootstrap.js';
import { resolveDispatchConfiguration } from './dispatch/config.js';
import { dispatchOnceCommand } from './dispatch/command.js';
import { DEFAULT_DISPATCH_IDLE_POLL_MS, dispatchContinuously } from './dispatch/continuous.js';
import { GitHubDispatchRuntime } from './dispatch/github-runtime.js';
import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from './dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from './dispatch/launchd.js';
import { preflightProductionPolicy } from './production-policy.js';
import { createDispatchWakeWaiter, dispatchWakePath, signalDispatchWake } from './dispatch/wake.js';
import { pullRequestIdentityConflict } from './workflow/pull-request-identity.js';
import {
  runWorkflow,
  type WorkflowDependencies,
  type WorkflowOptions,
  type WorkflowOutcome,
} from './workflow/run.js';
import { DEFAULT_WAIT_WAKE_POLICY, type WaitWakePolicy } from './domain/wait.js';
import {
  acknowledgeWaitDelivery,
  waitAwaitCommand,
  waitObserveCommand,
  type WaitCommandResult,
  type WaitCommandDependencies,
} from './workflow/wait-command.js';
import { WaitLedgerFileStore } from './workflow/wait-ledger-store.js';
import { NativeThreadWaitObserver, gitHeadReader } from './workflow/wait-observation.js';
import { OPERATIONAL_RUNTIME_PROJECTION_VERSION, readOperationalRuntimeProjection, registerManualLane, setMaintenanceHold, writeOperationalRuntimeProjection } from './operational/runtime-projection.js';

const USAGE = `Tachiko Conductor — local orchestration core.

Usage:
  tachiko run owner/repo#123 --execution-profile <routine|standard|complex|critical> --repair-task-shape-authority <json> [--browser-profile <profile>]
  tachiko run resume <id> --decision <choice> [--browser-profile <profile>]
  tachiko run create --owner <owner> --repo <repo> (--issue <n> | --branch <branch>) --execution-profile <routine|standard|complex|critical> --repair-task-shape-authority <json>
  tachiko run show <id>
  tachiko run inspect <id>
  tachiko run transition <id> <transition> [--reason <text>]
  tachiko run list
  tachiko run projections rebuild
  tachiko dispatch once
  tachiko dispatch serve [--idle-poll-ms <n>] [--max-cycles <n>]
  tachiko dispatch wake
  tachiko production preflight
  tachiko dispatch launchd render --program <absolute-driver-wrapper> --node-program <stable-absolute-node> --working-directory <absolute-path>
  tachiko wait observe <id> [--timeout-ms <n>] [--on-timeout <continue|policy-action>]
  tachiko wait await <id> [--timeout-ms <n>] [--poll-interval-ms <n>] [--on-timeout <continue|policy-action>]
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
Operational projections are secret-free sidecars under
$TACHIKO_DATA_DIR/.operational/v1; rebuild them only from validated persisted runs.
New runs require a revisioned TACHIKO_EXECUTION_PROFILE_CONFIG JSON value.
New unattended runs also require strict revisioned repair-task-shape authority JSON.
the selected --execution-profile is persisted with the run.
wait observe/await are deterministic and model-free: they read native/runtime
state, coalesce it into the durable wait ledger, and report whether the
orchestrator must reconcile. They never start a model turn. One ledger is
written per run at <wait ledger dir>/<runId>.wait.json, where the directory is
$TACHIKO_WAIT_LEDGER_DIR (or the directory of $TACHIKO_WAIT_LEDGER_PATH) and
defaults to <TACHIKO_DATA_DIR>/../wait.
Browser profiles and runtime metadata are stored outside the repository under
~/.tachiko-conductor/browser by default. start/bootstrap own the child process
in the foreground; use status/stop from another terminal.
`;

/** Bounded review attempts before a run parks in NEEDS_HUMAN. */
export const DEFAULT_MAX_REVIEW_ATTEMPTS = 3;
export { LIVE_HEAD_SYNC_DECISION } from './domain/decisions.js';

export type ImplementationProvider = typeof CLAUDE_CODE_PROVIDER | typeof CODEX_CLI_PROVIDER | typeof WORKER_ROUTER_PROVIDER | typeof LUNA_ISOLATED_PROVIDER;
export type CodexExecutionConfig = Pick<
  CodexCliAdapterOptions,
  'model' | 'reasoningEffort' | 'sandboxMode' | 'approvalPolicy' | 'timeoutMs'
>;

/** Resolve the explicit Steward-selected profile from one revisioned env config. */
export function resolveSelectedExecutionProfile(
  selected: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutionConfiguration {
  const raw = env.TACHIKO_EXECUTION_PROFILE_CONFIG;
  if (raw === undefined) throw new Error('TACHIKO_EXECUTION_PROFILE_CONFIG is required when creating a new run.');
  const execution = resolveExecutionProfile(
    parseExecutionProfileConfiguration(raw),
    selected,
    [CLAUDE_CODE_PROVIDER, CODEX_CLI_PROVIDER, WORKER_ROUTER_PROVIDER, LUNA_ISOLATED_PROVIDER],
  );
  assertExecutionSupportedByProvider(execution);
  return execution;
}

/** Keep the bootstrap heartbeat's settled signal as the final stdout line. */
export function printDispatchResult(result: Awaited<ReturnType<typeof dispatchOnceCommand>>): void {
  console.log(JSON.stringify(result, null, 2));
  const settled = result.outcome === 'no_eligible_work' ||
    (result.outcome === 'existing_claim' && ['merge_ready', 'needs_human', 'failed'].includes(result.claim.state)) ||
    (result.outcome === 'dispatched' && ['MERGE_READY', 'MERGED', 'NEEDS_HUMAN', 'WAITING_DEPENDENCY', 'FAILED'].includes(result.execution.state));
  if (settled) console.log('TACHIKO_HEARTBEAT_SETTLED_V1');
}

function dispatchLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACHIKO_DISPATCH_LOCK_PATH ?? path.join(os.homedir(), '.tachiko-conductor', 'dispatch', 'once.lock');
}

/**
 * A short, independent fence for admission-state transitions.  The long-lived
 * serve lock deliberately cannot be used here: an operator must be able to
 * place a hold while that singleton is asleep.  Instead, reconcile holds this
 * fence only while it can read the queue, claim work, or cross a provider
 * boundary; hold/release serializes with that interval.
 */
function dispatchAdmissionLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TACHIKO_DISPATCH_ADMISSION_LOCK_PATH ?? `${dispatchLockPath(env)}.admission`;
}

async function withDispatchAdmissionLock<T>(operation: () => Promise<T> | T): Promise<T> {
  for (;;) {
    try {
      const lock = acquireDispatchInvocationLock({ lockPath: dispatchAdmissionLockPath() });
      try {
        return await operation();
      } finally {
        lock.release();
      }
    } catch (error) {
      if (!(error instanceof DispatchInvocationLockedError)) throw error;
      // A transition waits for a current reconciliation boundary rather than
      // racing its projection write or allowing a second admission.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Provider selection is external to adapters; the stateless local router is the default path. */
export function resolveImplementationProvider(env: NodeJS.ProcessEnv = process.env): ImplementationProvider {
  const value = env.TACHIKO_IMPLEMENTATION_AGENT ?? WORKER_ROUTER_PROVIDER;
  if (value === CLAUDE_CODE_PROVIDER || value === CODEX_CLI_PROVIDER || value === WORKER_ROUTER_PROVIDER || value === LUNA_ISOLATED_PROVIDER) return value;
  throw new Error(
    `Invalid TACHIKO_IMPLEMENTATION_AGENT "${value}": expected ${CLAUDE_CODE_PROVIDER}, ${CODEX_CLI_PROVIDER}, ${WORKER_ROUTER_PROVIDER}, or ${LUNA_ISOLATED_PROVIDER}.`,
  );
}

function requiredLunaHome(env: NodeJS.ProcessEnv): string {
  const value = env.TACHIKO_LUNA_CODEX_HOME;
  if (value === undefined || !path.isAbsolute(value) || value.trim() === '') {
    throw new Error('luna-isolated requires TACHIKO_LUNA_CODEX_HOME to name the qualified absolute CODEX_HOME.');
  }
  return value;
}

/** Read already-selected Codex execution values without inventing policy defaults. */
export function resolveCodexExecutionConfig(env: NodeJS.ProcessEnv = process.env): CodexExecutionConfig {
  const config: {
    model?: string;
    reasoningEffort?: CodexCliAdapterOptions['reasoningEffort'];
    sandboxMode?: CodexCliAdapterOptions['sandboxMode'];
    approvalPolicy?: CodexCliAdapterOptions['approvalPolicy'];
    timeoutMs?: number;
  } = {};
  if (env.TACHIKO_CODEX_MODEL !== undefined) {
    if (env.TACHIKO_CODEX_MODEL.trim() === '') throw new Error('TACHIKO_CODEX_MODEL must not be empty.');
    config.model = env.TACHIKO_CODEX_MODEL;
  }
  if (env.TACHIKO_CODEX_REASONING_EFFORT !== undefined) {
    // Accept operator aliases/case and resolve them to the one canonical value
    // here, before any adapter can hand the spelling to a provider spawn.
    config.reasoningEffort = normalizeReasoningEffort(
      env.TACHIKO_CODEX_REASONING_EFFORT,
      { provider: CODEX_CLI_PROVIDER },
    );
  }
  if (env.TACHIKO_CODEX_SANDBOX_MODE !== undefined) {
    const value = env.TACHIKO_CODEX_SANDBOX_MODE;
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
      throw new Error('TACHIKO_CODEX_SANDBOX_MODE must be read-only, workspace-write, or danger-full-access.');
    }
    config.sandboxMode = value as NonNullable<CodexCliAdapterOptions['sandboxMode']>;
  }
  if (env.TACHIKO_CODEX_APPROVAL_POLICY !== undefined) {
    const value = env.TACHIKO_CODEX_APPROVAL_POLICY;
    if (!['untrusted', 'on-request', 'never'].includes(value)) {
      throw new Error('TACHIKO_CODEX_APPROVAL_POLICY must be untrusted, on-request, or never.');
    }
    config.approvalPolicy = value as NonNullable<CodexCliAdapterOptions['approvalPolicy']>;
  }
  if (env.TACHIKO_CODEX_TIMEOUT_MS !== undefined) {
    const value = Number(env.TACHIKO_CODEX_TIMEOUT_MS);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error('TACHIKO_CODEX_TIMEOUT_MS must be a positive safe integer.');
    }
    config.timeoutMs = value;
  }
  return config;
}

/**
 * Parse the repository/run-owned local validation plan. Commands are explicit
 * JSON data; workflow code never derives them from Issue prose or defaults.
 */
export function resolveLocalValidationConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): LocalValidationConfiguration | undefined {
  const raw = env.TACHIKO_LOCAL_VALIDATION_CONFIG;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.revision !== 'string' || record.revision.trim() === '') {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.revision must be a non-empty string.');
  }
  if (!Array.isArray(record.commands)) {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.commands must be an array.');
  }
  if (record.commands.length === 0) {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.commands must contain at least one command.');
  }
  const commands = record.commands.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`TACHIKO_LOCAL_VALIDATION_CONFIG.commands[${index}] must be an object.`);
    }
    const command = value as Record<string, unknown>;
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((part) => typeof part !== 'string' || part.trim() === '')) {
      throw new Error(`TACHIKO_LOCAL_VALIDATION_CONFIG.commands[${index}].argv must be a non-empty string array.`);
    }
    if (!Number.isSafeInteger(command.timeoutMs) ||
      (command.timeoutMs as number) < MIN_LOCAL_VALIDATION_TIMEOUT_MS ||
      (command.timeoutMs as number) > MAX_LOCAL_VALIDATION_TIMEOUT_MS) {
      throw new Error(
        `TACHIKO_LOCAL_VALIDATION_CONFIG.commands[${index}].timeoutMs must be a safe integer between ` +
        `${MIN_LOCAL_VALIDATION_TIMEOUT_MS} and ${MAX_LOCAL_VALIDATION_TIMEOUT_MS}.`,
      );
    }
    return { argv: command.argv as string[], timeoutMs: command.timeoutMs as number };
  });
  if (record.workspacePath !== undefined &&
    (typeof record.workspacePath !== 'string' || record.workspacePath.trim() === '' || !path.isAbsolute(record.workspacePath))) {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.workspacePath must be an absolute non-empty path when supplied.');
  }
  if (record.trustedIgnoredBaselinePath !== undefined &&
    (typeof record.trustedIgnoredBaselinePath !== 'string' || record.trustedIgnoredBaselinePath.trim() === '' || !path.isAbsolute(record.trustedIgnoredBaselinePath))) {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.trustedIgnoredBaselinePath must be an absolute non-empty path when supplied.');
  }
  return {
    revision: record.revision,
    commands,
    ...(record.workspacePath === undefined ? {} : { workspacePath: record.workspacePath }),
    ...(record.trustedIgnoredBaselinePath === undefined ? {} : { trustedIgnoredBaselinePath: record.trustedIgnoredBaselinePath }),
  };
}

/** Parse the explicit repository/run contract for hosted checks. */
export function resolveHostedCheckPolicyConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): HostedCheckPolicyConfiguration | undefined {
  const raw = env.TACHIKO_HOSTED_CHECK_POLICY_CONFIG;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.revision !== 'string' || record.revision.trim() === '') {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG.revision must be a non-empty string.');
  }
  if (record.mode !== 'required' && record.mode !== 'not_required') {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG.mode must be required or not_required.');
  }
  if (record.requiredCheckNames !== undefined &&
    (!Array.isArray(record.requiredCheckNames) || record.requiredCheckNames.length === 0 ||
      record.requiredCheckNames.some((name) => typeof name !== 'string' || name.trim() === ''))) {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG.requiredCheckNames must be a non-empty string array when supplied.');
  }
  if (record.mode === 'not_required' && record.requiredCheckNames !== undefined) {
    throw new Error('TACHIKO_HOSTED_CHECK_POLICY_CONFIG.requiredCheckNames is only valid when mode is required.');
  }
  return {
    revision: record.revision,
    policy: record.mode === 'not_required'
      ? { mode: 'not_required' }
      : {
          mode: 'required',
          ...(record.requiredCheckNames === undefined ? {} : { requiredCheckNames: record.requiredCheckNames as string[] }),
        },
  };
}

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
  const resolvedCwd = path.resolve(cwd);
  let resolved: string;
  try {
    resolved = resolveGitTopLevel(cwd).trim();
  } catch {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Cannot establish the Git repository top-level from "${resolvedCwd}"; refusing browser storage.`,
      { cwd: resolvedCwd },
    );
  }
  if (resolved === '') {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.INVALID_CONFIG,
      `Cannot establish the Git repository top-level from "${resolvedCwd}"; refusing browser storage.`,
      { cwd: resolvedCwd },
    );
  }
  return path.resolve(resolved);
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
  openBrowser: (endpoint: string) => Promise<BootstrapBrowserLease | void> = openBrowserForBootstrap,
): Promise<BrowserStartCommandResult> {
  const handle = await runtime.start({ profile, ...options, headless: false });
  try {
    const lease = await abortable(
      () => openBrowser(handle.snapshot.endpoint),
      options.signal,
      () => new BrowserRuntimeError(
        BROWSER_RUNTIME_ERROR_CODE.NOT_RUNNING,
        `Browser bootstrap for profile "${profile}" was cancelled while opening the headed browser.`,
        { profile, runtimeId: handle.snapshot.runtimeId },
      ),
      closeBootstrapLease,
    );
    const leasedHandle = lease === undefined ? handle : holdBootstrapLease(handle, lease);
    return { ...buildBrowserAgentConnection(handle.snapshot), handle: leasedHandle };
  } catch (error) {
    await handle.stop().catch(() => undefined);
    throw error;
  }
}

function holdBootstrapLease(handle: BrowserRuntimeHandle, lease: BootstrapBrowserLease): BrowserRuntimeHandle {
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releasePromise ??= closeBootstrapLease(lease);
    return releasePromise;
  };
  return {
    snapshot: handle.snapshot,
    async stop() {
      try {
        return await handle.stop();
      } finally {
        await release();
      }
    },
    async waitForExit() {
      try {
        return await handle.waitForExit();
      } finally {
        await release();
      }
    },
  };
}

async function closeBootstrapLease(lease: BootstrapBrowserLease | void): Promise<void> {
  await lease?.close().catch(() => undefined);
}

function abortable<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  error: () => Error,
  disposeLateResult?: (value: T) => Promise<void>,
): Promise<T> {
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
        if (settled) {
          void disposeLateResult?.(value).catch(() => undefined);
          return;
        }
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

/** Find an active persisted run whose target matches exactly, if any. */
export function findRunByTarget(store: RunStore, target: Target): Run | null {
  return store.list().find((run) =>
    targetsEqual(run.target, target) && run.state !== 'MERGED' && run.state !== 'FAILED',
  ) ?? null;
}

export interface WorkflowCommandOptions {
  readonly maxReviewAttempts?: number;
  readonly now?: () => string;
  /** Required for a newly-created production issue run; persisted runs retain their own snapshot. */
  readonly execution?: ResolvedExecutionConfiguration;
  /** Immutable queue-claim identity when this run is created by dispatch once. */
  readonly dispatchClaimId?: string;
  /** Explicit revisioned task-shape authority for a newly created unattended run. */
  readonly repairTaskShapeAuthority?: RepairTaskShapeAuthority;
  /** Optional run-scoped efficiency-signal thresholds. */
  readonly telemetryThresholds?: WorkflowOptions['telemetryThresholds'];
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
  let run = deps.store.list().find((candidate) =>
    targetsEqual(candidate.target, target) && candidate.state !== 'MERGED' && candidate.state !== 'FAILED',
  ) ?? null;
  if (options.dispatchClaimId !== undefined && run !== null && run.dispatchClaimId !== options.dispatchClaimId) {
    throw new Error(`Active durable run "${run.id}" is not bound to dispatch claim "${options.dispatchClaimId}"; refusing ambiguous recovery.`);
  }
  if (run === null) {
    run = createRun(target, undefined, undefined, options.execution, options.dispatchClaimId, options.repairTaskShapeAuthority);
    deps.store.create(run);
  } else {
    if (options.execution !== undefined && JSON.stringify(options.execution) !== JSON.stringify(run.execution)) {
      throw new Error(`Run "${run.id}" already has an immutable execution profile snapshot; refusing to replace it.`);
    }
    if (options.repairTaskShapeAuthority !== undefined &&
      (run.repairTaskShapeAuthority?.revision !== options.repairTaskShapeAuthority.revision ||
        run.repairTaskShapeAuthority?.shape !== options.repairTaskShapeAuthority.shape)) {
      throw new Error(`Run "${run.id}" already has an immutable repair task-shape authority; refusing to replace it.`);
    }
  }
  return runWorkflow(deps, run.id, {
    maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
    now: options.now,
    ...(options.telemetryThresholds === undefined ? {} : { telemetryThresholds: options.telemetryThresholds }),
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
  if (decision.trim() === '') throw new Error('A non-empty --decision is required to resume a parked run.');
  const choices = run.interrupt?.choices ?? [];
  if (choices.length > 0 && !choices.includes(decision)) {
    throw new Error(`Invalid decision "${decision}". Choose exactly one of: ${choices.join(' | ')}.`);
  }
  const now = options.now ?? (() => new Date().toISOString());
  if (
    decision.trim() === CANCEL_RUN_DECISION &&
    run.interrupt?.choices?.includes(CANCEL_RUN_DECISION) === true
  ) {
    const cancelled = applyTransition(run, { type: 'fail', reason: CANCEL_RUN_DECISION }, now());
    deps.store.update(cancelled);
    return { outcome: 'failed', run: cancelled, reason: CANCEL_RUN_DECISION };
  }
  const transition = run.state === 'NEEDS_HUMAN' ? 'human_resolved' : 'dependency_satisfied';
  let synchronizedHead: string | undefined;
  let synchronizedPullRequest: Run['pullRequest'];
  const reestablishReadiness =
    decision.trim() === REESTABLISH_READINESS_DECISION &&
    run.state === 'NEEDS_HUMAN' &&
    canReestablishInterruptedReadiness(run.interruptedFrom) &&
    run.interrupt?.choices?.includes(REESTABLISH_READINESS_DECISION) === true &&
    run.target.kind === 'issue';
  const recoverLegacyPullRequest =
    decision.trim() === RECOVER_LEGACY_PULL_REQUEST_DECISION &&
    run.state === 'NEEDS_HUMAN' &&
    canRecoverLegacyPullRequest(run.interruptedFrom) &&
    run.pullRequest === undefined &&
    run.interrupt?.choices?.includes(RECOVER_LEGACY_PULL_REQUEST_DECISION) === true &&
    run.target.kind === 'issue';
  const synchronizeLiveHead =
    (decision.trim() === LIVE_HEAD_SYNC_DECISION &&
    run.state === 'NEEDS_HUMAN' &&
    canSynchronizeInterruptedHead(run.interruptedFrom) &&
    run.interrupt?.choices?.includes(LIVE_HEAD_SYNC_DECISION) === true &&
    run.target.kind === 'issue') || reestablishReadiness;
  if ((synchronizeLiveHead || recoverLegacyPullRequest) && run.target.kind === 'issue') {
    const snapshot = await deps.github.readLiveSnapshot(run.target);
    if (snapshot.headSha === null || snapshot.pullRequest === null) {
      throw new Error(`Cannot synchronize run "${id}": its issue has no live pull request identity and exact HEAD.`);
    }
    const conflict = pullRequestIdentityConflict(run, snapshot, { allowHeadAdvance: true });
    if (conflict !== null) throw new Error(`Cannot synchronize run "${id}": ${conflict}`);
    if (recoverLegacyPullRequest && snapshot.headSha !== run.headSha) {
      throw new Error(`Cannot recover run "${id}": live GitHub HEAD does not match its legacy requested-change HEAD.`);
    }
    // An explicit live-HEAD sync is an owned identity adoption. Even runs
    // without a bootstrap must carry the re-read PR tuple atomically so a
    // later reviewer cannot see an exact HEAD detached from its acceptance.
    synchronizedPullRequest = { number: snapshot.pullRequest.number, headSha: snapshot.headSha };
    if (synchronizeLiveHead) synchronizedHead = snapshot.headSha;
  }
  const resumed = applyTransition(
    run,
    {
      type: transition,
      reason: decision,
      ...(synchronizedHead === undefined ? {} : { headSha: synchronizedHead }),
      ...(synchronizedPullRequest === undefined ? {} : { pullRequest: synchronizedPullRequest }),
    },
    now(),
  );
  deps.store.update(resumed);
  return runWorkflow(deps, id, {
    maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
    now: options.now,
    ...(options.telemetryThresholds === undefined ? {} : { telemetryThresholds: options.telemetryThresholds }),
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
  if (outcome.outcome === 'waiting_dependency') {
    console.log(`Run ${run.id}: WAITING_DEPENDENCY — ${outcome.reason}`);
    console.log(`Resume with: ${resumeCommandHint(run.id, browserProfile)}`);
    return;
  }
  console.error(`Run ${run.id}: FAILED — ${outcome.reason}`);
}

/** Production wiring: durable implementation routing, local gh, and independent review. */
function buildWorkflowDeps(
  store: RunStore,
  resolveImplementationCapabilities?: ImplementationCapabilityResolver,
  env: NodeJS.ProcessEnv = process.env,
  transport: GhCliTransport = new GhCliTransport(),
): WorkflowDependencies {
  const github = new LiveGitHubAdapter({ transport });
  const localValidation = resolveLocalValidationConfiguration(env);
  const hostedCheckPolicy = resolveHostedCheckPolicyConfiguration(env);
  let bootstrap: ImplementationBootstrapAdapter | undefined;
  let lunaBootstrap: ImplementationBootstrapAdapter | undefined;
  const lazyBootstrap: ImplementationBootstrapAdapter = {
    kind: 'implementation-bootstrap',
    bootstrapKind: 'linked-worktree',
    plan: async (request) => {
      bootstrap ??= new GitWorktreeBootstrap({
        repositoryRoot: resolveRepositoryRoot(),
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(os.homedir(), '.tachiko-conductor', 'workspaces'),
      });
      return bootstrap.plan(request);
    },
    prepare: async (request) => {
      bootstrap ??= new GitWorktreeBootstrap({
        repositoryRoot: resolveRepositoryRoot(),
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(os.homedir(), '.tachiko-conductor', 'workspaces'),
      });
      return bootstrap.prepare(request);
    },
    guard: (identity) => {
      if (bootstrap === undefined) throw new Error('Bootstrap workspace was not prepared.');
      return bootstrap.guard(identity);
    },
    verifyDurable: async (request) => {
      if (bootstrap === undefined) throw new Error('Bootstrap workspace was not prepared.');
      return bootstrap.verifyDurable(request);
    },
  };
  return {
    store,
    github,
    implementation: new ImplementationAgentRegistry({
      defaultProvider: resolveImplementationProvider(env),
      legacySessionProvider: CLAUDE_CODE_PROVIDER,
      providers: {
        [CLAUDE_CODE_PROVIDER]: (execution) => new ClaudeCodeAdapter({
          cwd: process.cwd(), github,
          ...(execution?.model === undefined ? {} : { model: execution.model }),
          ...(execution === undefined ? {} : { timeoutMs: execution.timeoutMs }),
        }),
        [CODEX_CLI_PROVIDER]: (execution) => new CodexAppServerAdapter({
          cwd: process.cwd(),
          fallback: new CodexCliAdapter({
            cwd: process.cwd(),
            ...(execution === undefined ? resolveCodexExecutionConfig(env) : {
              ...(execution.model === undefined ? {} : { model: execution.model }),
              ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }),
              ...(execution.sandboxMode === undefined ? {} : { sandboxMode: execution.sandboxMode }),
              ...(execution.approvalPolicy === undefined ? {} : { approvalPolicy: execution.approvalPolicy }),
              timeoutMs: execution.timeoutMs,
            }),
          }),
          ...(execution === undefined ? resolveCodexExecutionConfig(env) : {
            ...(execution.model === undefined ? {} : { model: execution.model }),
            ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }),
            ...(execution.sandboxMode === undefined ? {} : { sandboxMode: execution.sandboxMode }),
            ...(execution.approvalPolicy === undefined ? {} : { approvalPolicy: execution.approvalPolicy }),
            timeoutMs: execution.timeoutMs,
          }),
        }),
        // The configured compatible provider first attempts the local stdio
        // App Server; only an unavailable/failed handshake falls back to the
        // unchanged bounded CLI adapter. Durable App Server identities route
        // back here through their own provider key after a restart.
        [CODEX_APP_SERVER_PROVIDER]: (execution) => new CodexAppServerAdapter({
          cwd: process.cwd(),
          fallback: new CodexCliAdapter({
            cwd: process.cwd(),
            ...(execution === undefined ? resolveCodexExecutionConfig(env) : {
              ...(execution.model === undefined ? {} : { model: execution.model }),
              ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }),
              ...(execution.sandboxMode === undefined ? {} : { sandboxMode: execution.sandboxMode }),
              ...(execution.approvalPolicy === undefined ? {} : { approvalPolicy: execution.approvalPolicy }),
              timeoutMs: execution.timeoutMs,
            }),
          }),
          ...(execution === undefined ? resolveCodexExecutionConfig(env) : {
            ...(execution.model === undefined ? {} : { model: execution.model }),
            ...(execution.reasoningEffort === undefined ? {} : { reasoningEffort: execution.reasoningEffort }),
            ...(execution.sandboxMode === undefined ? {} : { sandboxMode: execution.sandboxMode }),
            ...(execution.approvalPolicy === undefined ? {} : { approvalPolicy: execution.approvalPolicy }),
            timeoutMs: execution.timeoutMs,
          }),
        }),
        [WORKER_ROUTER_PROVIDER]: (execution) => new WorkerRouterAdapter({
          cwd: process.cwd(),
          ...(execution === undefined ? {} : { timeoutMs: execution.timeoutMs }),
        }),
        [LUNA_ISOLATED_PROVIDER]: (execution) => new IsolatedLunaAdapter({
          codexHome: requiredLunaHome(env), timeoutMs: execution?.timeoutMs ?? 10 * 60_000,
        }),
      },
    }),
    reviewer: new DeepSeekReviewer({
      github,
      diffReader: new GhPullRequestDiffReader(transport),
      client: new DeepSeekApiClient(),
    }),
    bootstrap: lazyBootstrap,
    bootstrapForExecution: (execution) => {
      if (execution?.executor !== LUNA_ISOLATED_PROVIDER) return lazyBootstrap;
      lunaBootstrap ??= new StandaloneGitBootstrap({
        repositoryRoot: resolveRepositoryRoot(),
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(os.homedir(), '.tachiko-conductor', 'workspaces'),
      });
      return lunaBootstrap;
    },
    ...(localValidation === undefined ? {} : { validation: new ConfiguredLocalValidationAdapter(localValidation) }),
    ...(hostedCheckPolicy === undefined ? {} : { hostedCheckPolicy }),
    resolveImplementationCapabilities,
    // A run carrying explicit repair authority is admitted only against this
    // same revisioned execution-profile configuration. Missing or invalid
    // configuration is intentionally surfaced as an unavailable profile.
    resolveRepairExecutionProfile: (profile) => {
      try {
        return resolveSelectedExecutionProfile(profile, env);
      } catch {
        return undefined;
      }
    },
  };
}

// --- commands (exported so tests can exercise them without spawning a process) ---

export function runCreateCommand(
  store: RunStore,
  owner: string,
  repo: string,
  opts: { issue?: number; branch?: string; execution?: ResolvedExecutionConfiguration; repairTaskShapeAuthority?: RepairTaskShapeAuthority },
): Run {
  if (opts.repairTaskShapeAuthority === undefined) {
    throw new Error('run create requires explicit revisioned repair task-shape authority.');
  }
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
  const run = createRun(target, undefined, undefined, opts.execution, undefined, opts.repairTaskShapeAuthority);
  store.create(run);
  return run;
}

export function runShowCommand(store: RunStore, id: string): Run {
  const run = store.read(id);
  if (run === null) throw new Error(`No run with id "${id}" found.`);
  return run;
}

export function runTransitionCommand(store: RunStore, id: string, type: TransitionType, reason?: string): Run {
  if (type === 'bootstrap_prepared') {
    throw new Error('Transition "bootstrap_prepared" requires durable bootstrap identity that this CLI cannot supply. Drive it through the workflow.');
  }
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
  /** Persisted secret-free execution selection, when this is a profile-backed run. */
  execution: Run['execution'] | null;
  /** Only an unresolved interrupt is a current interrupt. */
  interrupt: { kind: InterruptKind; reason: string } | null;
  transitions: number;
  updatedAt: string;
  /** Structured per-run efficiency projection; absent telemetry is explicitly unknown. */
  telemetry: RunEfficiencyProjection;
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
    execution: run.execution ?? null,
    interrupt: activeInterrupt,
    transitions: run.history.length,
    updatedAt: run.updatedAt,
    telemetry: projectRunEfficiency(run),
  };
}

function printRun(run: Run): void {
  console.log(JSON.stringify(runShowView(run), null, 2));
}

function printRunInspection(run: Run): void {
  const telemetry = projectRunEfficiency(run);
  const lines = [...telemetry.summary];
  if (telemetry.signals.length > 0) {
    lines.push('', 'warnings');
    for (const signal of telemetry.signals) lines.push(`  ${signal.code}: ${signal.message}`);
  }
  console.log(lines.join('\n'));
}

function buildBrowserRuntime(): ManagedPlaywrightMcpRuntime {
  const roots = resolveBrowserRoots();
  return new ManagedPlaywrightMcpRuntime({
    ...roots,
    repositoryRoot: resolveRepositoryRoot(),
  });
}

function buildBrowserCapabilityResolver(
  browserProfile: string | undefined,
): ImplementationCapabilityResolver | undefined {
  if (browserProfile === undefined) return undefined;
  const runtime = buildBrowserRuntime();
  return async () => await browserImplementationCapabilities(runtime, browserProfile);
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

/**
 * Durable wait-ledger location. `TACHIKO_WAIT_LEDGER_PATH` names a path whose
 * directory holds the per-run ledgers; its basename is conventional (the file
 * actually written is `<dir>/<runId>.wait.json`). Prefer
 * `resolveWaitLedgerDirectory`/`resolveWaitLedgerFile` in callers.
 */
export function resolveWaitLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TACHIKO_WAIT_LEDGER_PATH !== undefined && env.TACHIKO_WAIT_LEDGER_PATH.trim() !== '') return env.TACHIKO_WAIT_LEDGER_PATH;
  return path.join(path.dirname(resolveRunsDir(env)), 'wait', 'state.json');
}

/** Parse the bounded wait policy from CLI values; defaults stay revisioned. */
export function resolveWaitWakePolicy(values: {
  readonly 'timeout-ms'?: string;
  readonly 'on-timeout'?: string;
}): WaitWakePolicy {
  const policy = DEFAULT_WAIT_WAKE_POLICY;
  const timeoutMs = values['timeout-ms'] === undefined ? policy.timeoutMs : Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('--timeout-ms must be a non-negative safe integer.');
  const onTimeout = values['on-timeout'] ?? policy.onTimeout;
  if (onTimeout !== 'continue' && onTimeout !== 'policy-action') throw new Error('--on-timeout must be continue or policy-action.');
  return { ...policy, timeoutMs, onTimeout };
}

/**
 * Single-owner fence for one run's wait path, beside that run's ledger. Two wait
 * processes can never perform the ledger read-modify-write concurrently.
 */
export function waitLockPath(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveWaitLedgerFile(runId, env)}.lock`;
}

/**
 * Per-run ledger file. `TACHIKO_WAIT_LEDGER_DIR` names the directory directly;
 * otherwise the directory of `TACHIKO_WAIT_LEDGER_PATH` is used, so the
 * configured path stays a single explicit override.
 */
export function resolveWaitLedgerDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.TACHIKO_WAIT_LEDGER_DIR;
  if (directory !== undefined && directory.trim() !== '') return directory;
  return path.dirname(resolveWaitLedgerPath(env));
}

/** One ledger per run at `<wait ledger directory>/<runId>.wait.json`. */
export function resolveWaitLedgerFile(runId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveWaitLedgerDirectory(env), `${runId}.wait.json`);
}

/**
 * Build the deterministic wait dependencies for one run. A native #35 observer
 * is only wired for App Server executors; otherwise the runtime fallback path
 * is used. Nothing here starts or resumes a Codex turn.
 */
export interface CodexNativeObservationAdapter {
  observeRuntime(executor: NonNullable<Run['executor']>): Promise<NativeThreadObservation>;
}

/**
 * Build the deterministic wait dependencies for one run.
 *
 * A native #35 observer is wired only for App Server executors and only reads
 * `thread/read`; it never starts, resumes, steers, or interrupts a turn.
 *
 * Exactly one observer instance is retained for the lifetime of these
 * dependencies, so consecutive provider reads within one command observe a
 * real transition. The active -> idle completion boundary is *also* classified
 * from the durable previous observation in `classifyWaitChange`, so a separate
 * CLI invocation or a runtime restart that has no observer memory preserves it.
 */
export function buildWaitCommandDependencies(options: {
  readonly store: RunStore;
  readonly run: Run;
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable read-only App Server observation seam for deterministic wiring tests. */
  readonly appServerAdapter?: CodexNativeObservationAdapter;
  readonly now?: () => string;
}): WaitCommandDependencies {
  const env = options.env ?? process.env;
  const run = options.run;
  const now = options.now ?? (() => new Date().toISOString());
  const workspace = run.bootstrap?.workspacePath;
  const adapter = run.executor?.provider === CODEX_APP_SERVER_PROVIDER
    ? options.appServerAdapter ?? new CodexAppServerAdapter({ cwd: workspace ?? process.cwd() })
    : undefined;
  const nativeObserver = adapter === undefined
    ? undefined
    : new NativeThreadWaitObserver({
        client: { observeThread: () => adapter.observeRuntime(run.executor!) },
        threadId: run.executor!.sessionId,
        now,
        subjectId: run.id,
      });
  return {
    store: options.store,
    ledgerStore: new WaitLedgerFileStore({ filePath: resolveWaitLedgerFile(run.id, env) }),
    now,
    ...(workspace === undefined ? {} : { readHead: gitHeadReader(new NodeProcessRunner(), workspace) }),
    ...(nativeObserver === undefined ? {} : { nativeObserver }),
  };
}

/** Print the bounded, model-free wait result and its settled marker. */
export function printWaitResult(result: WaitCommandResult): void {
  console.log(JSON.stringify(result, null, 2));
  if (result.wake.shouldWake) console.log('TACHIKO_WAIT_WAKE_V1');
  else if (result.idle) console.log('TACHIKO_WAIT_IDLE_V1');
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

  if (command === 'dispatch') {
    if (subcommand === 'manual' && (rest[0] === 'register' || rest[0] === 'park') && rest.length === 1) {
      const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const clean = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
      const repository = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
      console.log(JSON.stringify(registerManualLane(resolveRunsDir(), { repository, worktree, branch, checkpointSha, clean, state: rest[0] === 'register' ? 'active' : 'parked', recoverable: clean }, new Date().toISOString())));
      return 0;
    }
    if (subcommand === 'maintenance' && (rest[0] === 'hold' || rest[0] === 'release') && rest.length === 1) {
      const desired = rest[0] === 'hold';
      const { projection, wake } = await withDispatchAdmissionLock(() => {
        const wasHeld = readOperationalRuntimeProjection(resolveRunsDir())?.maintenanceHold.active === true;
        const projection = setMaintenanceHold(resolveRunsDir(), desired, new Date().toISOString());
        // A meaningful release wakes the already-singleton driver exactly once.
        // Repeating an already released command is deliberately a no-op at the
        // wake boundary; it cannot manufacture another reconciliation.
        return { projection, wake: !desired && wasHeld ? signalDispatchWake(dispatchWakePath()) : undefined };
      });
      console.log(JSON.stringify({ projection, ...(wake === undefined ? {} : { wake }) }));
      return 0;
    }
    if (subcommand === 'wake' && rest.length === 0) {
      console.log(JSON.stringify({ outcome: 'wake_signaled', token: signalDispatchWake(dispatchWakePath()) }));
      return 0;
    }
    if (subcommand === 'launchd' && rest[0] === 'render') {
      const { values, positionals } = parseArgs({
        args: rest.slice(1),
        options: {
          program: { type: 'string' },
          'node-program': { type: 'string' },
          'working-directory': { type: 'string' },
          label: { type: 'string' },
          'stdout-path': { type: 'string' },
          'stderr-path': { type: 'string' },
        },
      });
      if (positionals.length > 0 || values.program === undefined || values['node-program'] === undefined || values['working-directory'] === undefined) {
        throw new Error('dispatch launchd render requires --program, --node-program, and --working-directory.');
      }
      console.log(renderDispatchLaunchdPlist({
        program: values.program,
        nodeProgram: values['node-program'],
        workingDirectory: values['working-directory'],
        ...(values.label === undefined ? {} : { label: values.label }),
        ...(values['stdout-path'] === undefined ? {} : { standardOutPath: values['stdout-path'] }),
        ...(values['stderr-path'] === undefined ? {} : { standardErrorPath: values['stderr-path'] }),
      }));
      return 0;
    }
    if (subcommand !== 'once' && subcommand !== 'serve') {
      console.error(`Unknown command: dispatch ${subcommand ?? ''}\n`);
      console.error(USAGE);
      return 1;
    }
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        'idle-poll-ms': { type: 'string' },
        'max-cycles': { type: 'string' },
      },
    });
    if (positionals.length > 0 || (subcommand === 'once' && (values['idle-poll-ms'] !== undefined || values['max-cycles'] !== undefined))) {
      console.error(`Unknown command: dispatch ${subcommand ?? ''}\n`);
      console.error(USAGE);
      return 1;
    }
    let lock;
    try {
      lock = acquireDispatchInvocationLock({ lockPath: dispatchLockPath() });
    } catch (error) {
      if (error instanceof DispatchInvocationLockedError) {
        console.log(JSON.stringify({ outcome: 'already_running', reason: error.message }));
        return 0;
      }
      throw error;
    }
    try {
      const publishRuntime = (stage: string, supervisor: 'running' | 'stopped' | 'parked', nextPollAt?: string) => writeOperationalRuntimeProjection(resolveRunsDir(), {
        schemaVersion: OPERATIONAL_RUNTIME_PROJECTION_VERSION, updatedAt: new Date().toISOString(), supervisor, stage,
        ...(nextPollAt === undefined ? {} : { nextPollAt }), eventWakeEligible: subcommand === 'serve',
        maintenanceHold: readOperationalRuntimeProjection(resolveRunsDir())?.maintenanceHold ?? { active: false },
        ...(() => {
          const active = store.list().filter((run) => !['MERGED', 'FAILED', 'MERGE_READY', 'NEEDS_HUMAN', 'WAITING_DEPENDENCY'].includes(run.state));
          if (active.length !== 0 && active.length !== 1) return { ownership: 'ambiguous' as const, checkpoint: 'unknown' as const };
          if (active.length === 0) return { ownership: 'none' as const, checkpoint: 'durable' as const };
          const run = active[0]!;
          if (run.bootstrap === undefined) return { ownership: 'ambiguous' as const, checkpoint: 'unknown' as const };
          return { ownership: 'active' as const, checkpoint: run.headSha === undefined ? 'in_progress' as const : 'durable' as const, activeWriter: { runId: run.id, ...(run.target.kind === 'issue' ? { issue: run.target.issueNumber } : {}), ...(run.execution === undefined ? {} : { worker: run.execution.executor }), worktree: run.bootstrap.workspacePath } };
        })(),
        ...(readOperationalRuntimeProjection(resolveRunsDir())?.manualLane === undefined ? {} : { manualLane: readOperationalRuntimeProjection(resolveRunsDir())!.manualLane! }),
      });
      const idlePollMs = values['idle-poll-ms'] === undefined ? DEFAULT_DISPATCH_IDLE_POLL_MS : Number(values['idle-poll-ms']);
      const nextPollAt = () => subcommand === 'serve' ? new Date(Date.now() + idlePollMs).toISOString() : undefined;
      const reconcile = async () => await withDispatchAdmissionLock(async () => {
        // This durable typed fence precedes queue reads, configuration, GitHub,
        // workflow construction, and every model-capable boundary. The same
        // admission lock serializes an operator hold/release with this entire
        // interval, so a transition cannot be overwritten mid-reconcile.
        if (readOperationalRuntimeProjection(resolveRunsDir())?.maintenanceHold.active) {
          publishRuntime('maintenance_hold', 'parked', nextPollAt());
          return { outcome: 'maintenance_hold' as const, reason: 'Typed restart hold prevents new dispatch admission.' };
        }
        publishRuntime('scanning', 'running', nextPollAt());
        const config = resolveDispatchConfiguration();
        const transport = new GhCliTransport();
        const runtime = new GitHubDispatchRuntime(transport, config);
        const workflow = buildWorkflowDeps(store, undefined, process.env, transport);
        return await dispatchOnceCommand(config, {
          workflow,
          runtime,
          resolveExecutionProfile: (profile) => resolveSelectedExecutionProfile(profile),
          runIssue: async (ref, execution, dispatchClaimId, repairTaskShapeAuthority) => await runIssueCommand(workflow, ref, {
            ...(execution === undefined ? {} : { execution }), dispatchClaimId, repairTaskShapeAuthority,
          }),
          resumeClaimedRun: async (run) => await runWorkflow(workflow, run.id, { maxReviewAttempts: DEFAULT_MAX_REVIEW_ATTEMPTS }),
        });
      });
      const publishSettledRuntime = async (result: Awaited<ReturnType<typeof reconcile>>) => await withDispatchAdmissionLock(() => {
        const held = readOperationalRuntimeProjection(resolveRunsDir())?.maintenanceHold.active === true;
        publishRuntime(held || result.outcome === 'maintenance_hold' ? 'maintenance_hold' : result.outcome === 'dispatched' ? result.execution.state.toLowerCase() : 'idle', held || result.outcome === 'maintenance_hold' ? 'parked' : 'stopped');
      });
      if (subcommand === 'once') {
        const result = await reconcile();
        await publishSettledRuntime(result);
        printDispatchResult(result);
        return 0;
      }
      const result = await dispatchContinuously({
        dispatchOnce: reconcile,
        sleep: createDispatchWakeWaiter(dispatchWakePath()),
        idlePollMs,
        ...(values['max-cycles'] === undefined ? {} : { maxCycles: Number(values['max-cycles']) }),
      });
      if (result.last !== null) await publishSettledRuntime(result.last);
      console.log(JSON.stringify(result, null, 2));
      return 0;
    } finally {
      lock.release();
    }
  }

  if (command === 'production') {
    if (subcommand !== 'preflight' || rest.length !== 0) {
      console.error(`Unknown command: production ${subcommand ?? ''}\n`);
      console.error(USAGE);
      return 1;
    }
    console.log(JSON.stringify({ ok: true, preflight: preflightProductionPolicy(process.env) }, null, 2));
    return 0;
  }

  if (command === 'wait') {
    if (subcommand !== 'observe' && subcommand !== 'await') {
      console.error(`Unknown command: wait ${subcommand ?? ''}\n`);
      console.error(USAGE);
      return 1;
    }
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        'timeout-ms': { type: 'string' },
        'poll-interval-ms': { type: 'string' },
        'on-timeout': { type: 'string' },
      },
    });
    const [id, extra] = positionals;
    if (id === undefined || extra !== undefined) throw new Error(`wait ${subcommand} requires exactly one run id.`);
    const run = store.read(id);
    if (run === null) throw new Error(`Run ${id} was not found.`);
    const policy = resolveWaitWakePolicy(values);
    const pollIntervalMs = values['poll-interval-ms'] === undefined
      ? undefined
      : Number(values['poll-interval-ms']);
    if (pollIntervalMs !== undefined && (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0)) {
      throw new Error('--poll-interval-ms must be a non-negative safe integer.');
    }
    // The wait ledger is a per-run read-modify-write. Hold the same single-owner
    // invocation fence `dispatch once` uses, scoped to this run, so two wait
    // processes can never clobber each other's durable wake decisions.
    let lock;
    try {
      lock = acquireDispatchInvocationLock({ lockPath: waitLockPath(id) });
    } catch (error) {
      if (error instanceof DispatchInvocationLockedError) {
        console.log(JSON.stringify({ outcome: 'already_running', runId: id, reason: error.message }));
        return 0;
      }
      throw error;
    }
    try {
      const dependencies = buildWaitCommandDependencies({ store, run });
      const result = subcommand === 'observe'
        ? await waitObserveCommand({ id, mode: 'observe', policy }, dependencies)
        : await waitAwaitCommand({ id, mode: 'wait', policy, ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }) }, dependencies);
      printWaitResult(result);
      // Only after the wake has been emitted is it safe to mark it delivered; a
      // crash before this point makes the next process replay it.
      acknowledgeWaitDelivery(result, dependencies.ledgerStore);
      // A wake is a reconciliation signal, not a failure; the caller decides.
      return 0;
    } finally {
      lock.release();
    }
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
        'execution-profile': { type: 'string' },
        'repair-task-shape-authority': { type: 'string' },
      },
    });
    const { owner, repo } = values;
    if (owner === undefined || repo === undefined) {
      throw new Error('run create requires --owner and --repo.');
    }
    const issue = values.issue !== undefined ? parseIssueNumber(values.issue) : undefined;
    if (values['execution-profile'] === undefined) {
      throw new Error('run create requires --execution-profile <routine|standard|complex|critical>.');
    }
    if (values['repair-task-shape-authority'] === undefined) {
      throw new Error('run create requires --repair-task-shape-authority <strict-json>.');
    }
    const execution = resolveSelectedExecutionProfile(values['execution-profile']);
    const repairTaskShapeAuthority = parseRepairTaskShapeAuthority(values['repair-task-shape-authority']);
    const run = runCreateCommand(store, owner, repo, { issue, branch: values.branch, execution, repairTaskShapeAuthority });
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

  if (subcommand === 'inspect') {
    const id = rest[0];
    if (id === undefined) throw new Error('run inspect requires a run id.');
    printRunInspection(runShowCommand(store, id));
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

  if (subcommand === 'projections' && rest[0] === 'rebuild' && rest.length === 1) {
    console.log(JSON.stringify({ ok: true, rebuilt: store.rebuildOperationalProjections() }));
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
    if (values.decision === undefined) throw new Error('run resume requires --decision <choice>.');
    const resolveCapabilities = buildBrowserCapabilityResolver(values['browser-profile']);
    const outcome = await resumeCommand(
      buildWorkflowDeps(store, resolveCapabilities),
      id,
      values.decision,
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
    options: { 'browser-profile': { type: 'string' }, 'execution-profile': { type: 'string' }, 'repair-task-shape-authority': { type: 'string' } },
  });
  const [ref, extra] = positionals;
  if (ref === undefined || extra !== undefined) {
    throw new Error('run requires exactly one owner/repo#123 reference.');
  }
  const resolveCapabilities = buildBrowserCapabilityResolver(values['browser-profile']);
  const target = parseIssueRef(ref);
  const existing = findRunByTarget(store, target);
  if (existing === null && values['execution-profile'] === undefined) {
    throw new Error('run owner/repo#123 requires --execution-profile <routine|standard|complex|critical> for a new run.');
  }
  if (existing === null && values['repair-task-shape-authority'] === undefined) {
    throw new Error('run owner/repo#123 requires --repair-task-shape-authority <strict-json> for a new run.');
  }
  const execution = values['execution-profile'] === undefined
    ? undefined
    : resolveSelectedExecutionProfile(values['execution-profile']);
  const repairTaskShapeAuthority = values['repair-task-shape-authority'] === undefined
    ? undefined
    : parseRepairTaskShapeAuthority(values['repair-task-shape-authority']);
  const outcome = await runIssueCommand(buildWorkflowDeps(store, resolveCapabilities), ref, { execution, repairTaskShapeAuthority });
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
