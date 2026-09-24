#!/usr/bin/env node
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
import type { GitHubAdapter, GitHubLivePullRequestSnapshot, GitHubLiveSnapshot } from './adapters/github.js';
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
import { claimedRun, DispatchAdmissionWaitError, type DispatchAdmissionObservation } from './dispatch/runner.js';
import { DEFAULT_DISPATCH_IDLE_POLL_MS, dispatchContinuously } from './dispatch/continuous.js';
import { GitHubDispatchRuntime } from './dispatch/github-runtime.js';
import { DispatchInvocationLockedError, acquireDispatchInvocationLock } from './dispatch/invocation-lock.js';
import { renderDispatchLaunchdPlist } from './dispatch/launchd.js';
import { preflightProductionPolicy } from './production-policy.js';
import { createDispatchWakeWaiter, dispatchWakePath, signalDispatchWake } from './dispatch/wake.js';
import { resolveAccountHomeDirectory } from './account-home.js';
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
import { OPERATIONAL_RUNTIME_PROJECTION_VERSION, readOperationalRuntimeProjection, registerManualLane, retireManualLane, setMaintenanceHold, writeOperationalRuntimeProjection } from './operational/runtime-projection.js';
import { createHostAdmissionRegistry, resolveManualOwnerReceiptPath, resolveRunOwnerReceiptPath } from './mission-admission/host-registry.js';
import { canonicalizeMissionEvidence, type AdmissionLaneView, type AdmissionResult, type AdmissionToken, type MissionAdmissionRegistry } from './mission-admission/registry.js';
import { readManualOwnerReceipt, validateManualOwnerReceipt, writeManualOwnerReceipt, type ManualOwnerReceipt } from './mission-admission/manual-owner-receipt.js';
import { readRunOwnerReceipt, writeRunOwnerReceipt, type RunOwnerReceipt, type RunOwnerReceiptPhase } from './mission-admission/run-owner-receipt.js';
import { selectDispatchRuntime, renderDispatchRuntime, type DispatchRuntimeClaim } from './dispatch/queue.js';

const USAGE = `Tachiko Conductor — local orchestration core.

Usage:
  tachiko run owner/repo#123 --execution-profile <routine|standard|complex|critical> --repair-task-shape-authority <json> [--browser-profile <profile>]
  tachiko run resume <id> --decision <choice> [--browser-profile <profile>]
  tachiko run admission recover <id> --generation <n> [--stopped]
  tachiko run create --owner <owner> --repo <repo> (--issue <n> | --branch <branch>) --execution-profile <routine|standard|complex|critical> --repair-task-shape-authority <json>
  tachiko run show <id>
  tachiko run inspect <id>
  tachiko run transition <id> <transition> [--reason <text>]
  tachiko run list
  tachiko run projections rebuild
  tachiko dispatch once
  tachiko dispatch serve [--idle-poll-ms <n>] [--max-cycles <n>]
  tachiko dispatch admission status
  tachiko dispatch manual register
  tachiko dispatch manual park --stopped
  tachiko dispatch manual retire --stopped --expected-generation <n>
  tachiko dispatch manual recover --receipt-stdin
  tachiko dispatch wake
  tachiko production preflight
  tachiko dispatch launchd render --program <absolute-driver-wrapper> --node-program <stable-absolute-node> --pnpm-program <absolute-pnpm> --dependency-artifact-path <absolute-lockfile-bound-store> --luna-codex-home <absolute-path> --playwright-browsers-path <absolute-host-artifact-path> --working-directory <absolute-path>
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

function canonicalPhysicalPath(candidate: string): string {
  let cursor = path.resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Cannot resolve a physical dispatch lock path.');
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(realpathSync.native(cursor), ...suffix);
}

function canonicalDispatchLockPath(kind: 'once' | 'admission', homeDirectory: string): string {
  const base = path.join(homeDirectory, '.tachiko-conductor', 'dispatch');
  return path.join(base, kind === 'once' ? 'once.lock' : 'once.lock.admission');
}

function dispatchLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const homeDirectory = resolveAccountHomeDirectory();
  const canonical = canonicalPhysicalPath(canonicalDispatchLockPath('once', homeDirectory));
  const configured = env.TACHIKO_DISPATCH_LOCK_PATH;
  if (configured === undefined) return canonical;
  if (!path.isAbsolute(configured) || canonicalPhysicalPath(configured) !== canonical) {
    throw new Error('TACHIKO_DISPATCH_LOCK_PATH must resolve to the canonical per-account dispatch lock.');
  }
  return canonical;
}

/**
 * A short, independent fence for admission-state transitions.  The long-lived
 * serve lock deliberately cannot be used here: an operator must be able to
 * place a hold while that singleton is asleep.  Instead, reconcile holds this
 * fence only while it can read the queue, claim work, or cross a provider
 * boundary; hold/release serializes with that interval.
 */
function dispatchAdmissionLockPath(env: NodeJS.ProcessEnv = process.env): string {
  const homeDirectory = resolveAccountHomeDirectory();
  // Validate both configurable aliases against the same account root even
  // when this caller needs only the short admission fence.
  dispatchLockPath(env);
  const canonical = canonicalPhysicalPath(canonicalDispatchLockPath('admission', homeDirectory));
  const configured = env.TACHIKO_DISPATCH_ADMISSION_LOCK_PATH;
  if (configured === undefined) return canonical;
  if (!path.isAbsolute(configured) || canonicalPhysicalPath(configured) !== canonical) {
    throw new Error('TACHIKO_DISPATCH_ADMISSION_LOCK_PATH must resolve to the canonical per-account admission lock.');
  }
  return canonical;
}

async function withDispatchAdmissionLock<T>(operation: (release: () => void) => Promise<T> | T): Promise<T> {
  for (;;) {
    try {
      const lock = acquireDispatchInvocationLock({ lockPath: dispatchAdmissionLockPath() });
      let released = false;
      const release = () => { if (!released) { released = true; lock.release(); } };
      try {
        return await operation(release);
      } finally {
        release();
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
  if (record.playwrightBrowsersPathEnvironment !== undefined && record.playwrightBrowsersPathEnvironment !== 'TACHIKO_PLAYWRIGHT_BROWSERS_PATH') {
    throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.playwrightBrowsersPathEnvironment must be TACHIKO_PLAYWRIGHT_BROWSERS_PATH when supplied.');
  }
  if (record.nodeProgramEnvironment !== undefined && record.nodeProgramEnvironment !== 'TACHIKO_NODE_PROGRAM') throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.nodeProgramEnvironment must be TACHIKO_NODE_PROGRAM when supplied.');
  if (record.pnpmProgramEnvironment !== undefined && record.pnpmProgramEnvironment !== 'TACHIKO_PNPM_PROGRAM') throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.pnpmProgramEnvironment must be TACHIKO_PNPM_PROGRAM when supplied.');
  if (record.dependencyArtifactPathEnvironment !== undefined && record.dependencyArtifactPathEnvironment !== 'TACHIKO_PNPM_DEPENDENCY_ARTIFACT') throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG.dependencyArtifactPathEnvironment must be TACHIKO_PNPM_DEPENDENCY_ARTIFACT when supplied.');
  if ((record.nodeProgramEnvironment === undefined) !== (record.pnpmProgramEnvironment === undefined)) throw new Error('TACHIKO_LOCAL_VALIDATION_CONFIG must configure both Node and pnpm toolchain paths together.');
  const nodeProgram = record.nodeProgramEnvironment === undefined ? undefined : env.TACHIKO_NODE_PROGRAM;
  const pnpmProgram = record.pnpmProgramEnvironment === undefined ? undefined : env.TACHIKO_PNPM_PROGRAM;
  const dependencyArtifactPath = record.dependencyArtifactPathEnvironment === undefined ? undefined : env.TACHIKO_PNPM_DEPENDENCY_ARTIFACT;
  if (record.nodeProgramEnvironment !== undefined && (typeof nodeProgram !== 'string' || nodeProgram.trim() === '' || !path.isAbsolute(nodeProgram))) throw new Error('TACHIKO_NODE_PROGRAM must be an absolute host-provisioned runtime.');
  if (record.pnpmProgramEnvironment !== undefined && (typeof pnpmProgram !== 'string' || pnpmProgram.trim() === '' || !path.isAbsolute(pnpmProgram))) throw new Error('TACHIKO_PNPM_PROGRAM must be an absolute host-provisioned pnpm executable.');
  if (record.dependencyArtifactPathEnvironment !== undefined && (typeof dependencyArtifactPath !== 'string' || dependencyArtifactPath.trim() === '' || !path.isAbsolute(dependencyArtifactPath))) throw new Error('TACHIKO_PNPM_DEPENDENCY_ARTIFACT must be an absolute host-provisioned dependency artifact.');
  const playwrightBrowsersPath = record.playwrightBrowsersPathEnvironment === undefined ? undefined : env.TACHIKO_PLAYWRIGHT_BROWSERS_PATH;
  if (record.playwrightBrowsersPathEnvironment !== undefined &&
    (typeof playwrightBrowsersPath !== 'string' || playwrightBrowsersPath.trim() === '' || !path.isAbsolute(playwrightBrowsersPath))) {
    throw new Error('TACHIKO_PLAYWRIGHT_BROWSERS_PATH must be an absolute non-empty host-owned browser artifact directory.');
  }
  return {
    revision: record.revision,
    commands: commands.map((command) => ({ ...command, argv: command.argv[0] === 'pnpm' && pnpmProgram !== undefined ? [pnpmProgram, ...command.argv.slice(1)] : command.argv })),
    ...(record.workspacePath === undefined ? {} : { workspacePath: record.workspacePath }),
    ...(record.trustedIgnoredBaselinePath === undefined ? {} : { trustedIgnoredBaselinePath: record.trustedIgnoredBaselinePath }),
    ...(playwrightBrowsersPath === undefined ? {} : { playwrightBrowsersPath }),
    ...(nodeProgram === undefined ? {} : { nodeProgram }),
    ...(pnpmProgram === undefined ? {} : { pnpmProgram }),
    ...(dependencyArtifactPath === undefined ? {} : { dependencyArtifactPath }),
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
  return env.TACHIKO_DATA_DIR ?? path.join(resolveAccountHomeDirectory(), '.tachiko-conductor', 'runs');
}

export interface BrowserRoots {
  readonly profileRoot: string;
  readonly runtimeRoot: string;
}

export function resolveBrowserRoots(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = resolveAccountHomeDirectory(),
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

/** Find a unique active persisted run whose target matches exactly, if any. */
export function findRunByTarget(store: RunStore, target: Target): Run | null {
  const matches = store.list().filter((run) =>
    targetsEqual(run.target, target) && run.state !== 'MERGED' && run.state !== 'FAILED',
  );
  if (matches.length > 1) throw new Error(`Multiple active durable Runs overlap target ${target.kind === 'issue' ? `${target.owner}/${target.repo}#${target.issueNumber}` : `${target.owner}/${target.repo}:${target.branch}`}; refusing ambiguous ownership.`);
  return matches[0] ?? null;
}

function evidenceForRun(run: Run, additional: { readonly pullRequest?: number; readonly workspace?: string } = {}): ReturnType<typeof canonicalizeMissionEvidence> {
  const shared = {
    repository: `${run.target.owner}/${run.target.repo}`,
    run: run.id,
    ...(run.dispatchClaimId === undefined ? {} : { claim: run.dispatchClaimId }),
    ...(run.pullRequest === undefined ? {} : { pullRequest: run.pullRequest.number }),
    ...(run.bootstrap === undefined ? {} : { workspace: run.bootstrap.workspacePath }),
    ...(additional.pullRequest === undefined ? {} : { pullRequest: additional.pullRequest }),
    ...(additional.workspace === undefined ? {} : { workspace: additional.workspace }),
  };
  return canonicalizeMissionEvidence(run.target.kind === 'issue'
    ? { ...shared, issue: run.target.issueNumber }
    : { ...shared, claim: `branch:${run.target.branch}` });
}

/** Resume from the workspace already bound to this Run, never from the caller's ambient cwd. */
function persistedRunWorkspace(run: Run): string | undefined {
  if (run.bootstrap !== undefined) return run.bootstrap.workspacePath;
  const repository = `${run.target.owner}/${run.target.repo}`.toLowerCase();
  const receiptPath = resolveRunOwnerReceiptPath(repository, run.id, evidenceForRun(run));
  const receipt = readRunOwnerReceipt(receiptPath);
  if (receipt === null) return undefined;
  if (receipt.runId !== run.id || receipt.laneId !== `run:${run.id}` || receipt.repository !== repository ||
    receipt.issue !== (run.target.kind === 'issue' ? run.target.issueNumber : undefined) || receipt.claimId !== run.dispatchClaimId) {
    throw new Error(`Run owner receipt does not match Run "${run.id}"; refusing workspace recovery.`);
  }
  return receipt.workspace;
}

/** Public, bounded admission status. Physical surfaces and capability tokens are intentionally omitted. */
export function dispatchAdmissionStatus(registry: MissionAdmissionRegistry, store?: RunStore) {
  const snapshot = registry.snapshot();
  return {
    schemaVersion: snapshot.schemaVersion,
    revision: snapshot.revision,
    counts: snapshot.counts,
    limits: snapshot.limits,
    omittedLaneCount: snapshot.omittedLaneCount,
    lanesTruncated: snapshot.lanesTruncated,
    lanes: snapshot.lanes.map(({ laneId, missionId, evidence, role, status, generation, highAutonomy, parkedReason }) => ({
      laneId, missionId, role, status, generation, highAutonomy,
      ...(evidence.run === undefined ? {} : { runState: store?.read(evidence.run)?.state ?? 'unknown' }),
      evidence: {
        repository: evidence.repository,
        ...(evidence.run === undefined ? {} : { run: evidence.run }),
        ...(evidence.claim === undefined ? {} : { claim: evidence.claim }),
        ...(evidence.issue === undefined ? {} : { issue: evidence.issue }),
        ...(evidence.pullRequest === undefined ? {} : { pullRequest: evidence.pullRequest }),
        ...(evidence.workspace === undefined ? {} : { workspace: evidence.workspace }),
        ...(evidence.repositoryScope === true ? { repositoryScope: true as const } : {}),
      },
      reason: parkedReason ?? (status === 'active' ? 'active_owner' : status),
      ...(parkedReason === undefined ? {} : { parkedReason }),
    })),
    lastTransition: snapshot.lastTransition,
  };
}

export function assertCanonicalDispatchResumeClaim(run: Run, claim: DispatchRuntimeClaim | null, config: ReturnType<typeof resolveDispatchConfiguration>, claimBoundRun: Run | null = null): asserts claim is DispatchRuntimeClaim {
  const uniqueUnboundRunProof = claimBoundRun?.id === run.id && claimBoundRun.dispatchClaimId === claim?.claimId;
  if (run.target.kind !== 'issue' || run.dispatchClaimId === undefined || run.execution === undefined ||
    (run.state !== 'NEEDS_HUMAN' && run.state !== 'WAITING_DEPENDENCY') ||
    `${run.target.owner}/${run.target.repo}`.toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase() ||
    claim === null || claim.state !== 'needs_human' || (claim.runId !== run.id && !(claim.runId === null && uniqueUnboundRunProof)) || claim.claimId !== run.dispatchClaimId ||
    claim.issue !== run.target.issueNumber || claim.profile !== run.execution.profile) {
    throw new Error(`Dispatch runtime claim for Run "${run.id}" is missing, stale, replaced, or differently bound; refusing human resume.`);
  }
}

function runReceiptFor(run: Run, missionId: string, token: AdmissionToken, phase: RunOwnerReceiptPhase, workspace?: string): RunOwnerReceipt {
  return {
    schemaVersion: 1,
    laneId: token.laneId,
    missionId,
    repository: `${run.target.owner}/${run.target.repo}`.toLowerCase(),
    runId: run.id,
    ...(run.target.kind === 'issue' ? { issue: run.target.issueNumber } : {}),
    ...(run.dispatchClaimId === undefined ? {} : { claimId: run.dispatchClaimId }),
    ...(workspace === undefined ? {} : { workspace }),
    token,
    generation: token.generation,
    phase,
  };
}

function receiptForCurrentToken(receiptPath: string, token: AdmissionToken, phase: RunOwnerReceiptPhase): RunOwnerReceipt {
  const receipt = readRunOwnerReceipt(receiptPath);
  if (receipt === null || receipt.laneId !== token.laneId || receipt.generation !== token.generation || receipt.token?.token !== token.token) {
    throw new Error(`Run owner receipt does not match exact admission generation ${token.generation}.`);
  }
  return { ...receipt, phase, token };
}

function finalizeRunOwnerReceipt(receiptPath: string | undefined, token: AdmissionToken, phase: 'parked' | 'released', generation: number): void {
  if (receiptPath === undefined) return;
  const current = readRunOwnerReceipt(receiptPath);
  if (current === null || current.laneId !== token.laneId || current.generation !== token.generation || current.token?.token !== token.token) {
    throw new Error(`Run owner receipt does not match exact admission generation ${token.generation} after registry settlement.`);
  }
  const { token: _token, ...withoutToken } = current;
  writeRunOwnerReceipt(receiptPath, { ...withoutToken, phase, generation });
}

function sameRunReceiptIdentity(receipt: RunOwnerReceipt, run: Run, missionId: string): boolean {
  return receipt.laneId === `run:${run.id}` && receipt.runId === run.id && receipt.repository === `${run.target.owner}/${run.target.repo}`.toLowerCase() &&
    receipt.issue === (run.target.kind === 'issue' ? run.target.issueNumber : undefined) && receipt.claimId === run.dispatchClaimId && receipt.missionId === missionId;
}

function canBindMissingReceiptWorkspace(receipt: RunOwnerReceipt, run: Run, registryWorkspace: string | undefined): boolean {
  if (receipt.workspace !== undefined || registryWorkspace === undefined || run.bootstrap === undefined) return false;
  const repository = `${run.target.owner}/${run.target.repo}`.toLowerCase();
  const persistedWorkspace = canonicalizeMissionEvidence({ repository, workspace: run.bootstrap.workspacePath }).workspace;
  return persistedWorkspace === registryWorkspace;
}

/** Re-read and reconcile only the exact parked generation while its registry lock is held. */
function writeParkedReleaseTransition(
  receiptPath: string,
  run: Run,
  missionId: string,
  parkedGeneration: number,
  workspace: string | undefined,
  allowMissingWorkspaceBinding: boolean,
): void {
  const current = readRunOwnerReceipt(receiptPath);
  if (current === null || !sameRunReceiptIdentity(current, run, missionId) ||
    (current.workspace !== workspace && !(allowMissingWorkspaceBinding && current.workspace === undefined && workspace !== undefined && current.phase !== 'pre_execution'))) {
    throw new Error(`Run owner receipt does not match parked generation ${parkedGeneration} under the registry transaction.`);
  }
  const exactParkTransition = current.phase === 'park_transition' && current.generation === parkedGeneration - 1 && current.token?.generation === parkedGeneration - 1;
  const exactParked = current.phase === 'parked' && current.generation === parkedGeneration && current.token === undefined;
  const exactReleaseRetry = current.phase === 'parked_release_transition' && current.generation === parkedGeneration && current.token === undefined;
  const interruptedReadmission = current.phase === 'pre_execution' && current.generation === parkedGeneration + 1 && current.token?.generation === parkedGeneration + 1;
  if (!exactParkTransition && !exactParked && !exactReleaseRetry && !interruptedReadmission) {
    throw new Error(`Run owner receipt phase and generation do not match parked registry generation ${parkedGeneration}.`);
  }
  const { token: _token, ...withoutToken } = current;
  writeRunOwnerReceipt(receiptPath, { ...withoutToken, ...(workspace === undefined ? {} : { workspace }), phase: 'parked_release_transition', generation: parkedGeneration });
}

function finalizeParkedRunOwnerReceipt(receiptPath: string, run: Run, missionId: string, parkedGeneration: number, workspace: string | undefined): void {
  const current = readRunOwnerReceipt(receiptPath);
  if (current === null || !sameRunReceiptIdentity(current, run, missionId) || current.workspace !== workspace) {
    throw new Error(`Run owner receipt does not match parked generation ${parkedGeneration} after registry settlement.`);
  }
  const releasedGeneration = parkedGeneration + 1;
  if (current.phase === 'released' && current.generation === releasedGeneration && current.token === undefined) return;
  if (current.phase !== 'parked_release_transition' || current.generation !== parkedGeneration || current.token !== undefined) {
    throw new Error(`Run owner receipt does not match parked generation ${parkedGeneration} after registry settlement.`);
  }
  writeRunOwnerReceipt(receiptPath, { ...current, phase: 'released', generation: releasedGeneration });
}

function acquireRunAdmission(registry: MissionAdmissionRegistry, run: Run, receiptPath?: string, workspace?: string): AdmissionToken {
  const laneId = `run:${run.id}`;
  const evidence = evidenceForRun(run, workspace === undefined ? {} : { workspace });
  const result = registry.admit({ laneId, role: 'production_captain', evidence, highAutonomy: true }, {
    ...(receiptPath === undefined ? {} : { beforePublish: (candidate: Extract<AdmissionResult, { outcome: 'admitted' }>) => {
      writeRunOwnerReceipt(receiptPath, runReceiptFor(run, candidate.missionId, candidate.token, 'pre_execution', evidence.workspace));
    } }),
  });
  if (result.outcome !== 'admitted') {
    const snapshot = registry.snapshot();
    const observation: DispatchAdmissionObservation = {
      schemaVersion: 1,
      revision: snapshot.revision,
      decisionRevision: result.revision,
      missionId: result.missionId,
      laneId,
      runId: run.id,
      ...(run.dispatchClaimId === undefined ? {} : { claimId: run.dispatchClaimId }),
      repository: evidence.repository,
      ...(evidence.issue === undefined ? {} : { issue: evidence.issue }),
      ...(evidence.pullRequest === undefined ? {} : { pullRequest: evidence.pullRequest }),
      ...(evidence.workspace === undefined ? {} : { workspace: evidence.workspace }),
      role: 'production_captain',
      counts: snapshot.counts,
      limits: snapshot.limits,
      result: result.outcome,
      reason: result.outcome === 'parked' ? result.reason : `overlaps:${result.conflictingLaneId}`,
      lastTransition: snapshot.lastTransition,
    };
    if (result.outcome === 'parked') {
      const detail = `Run "${run.id}" is waiting for mission admission capacity (${result.reason}).`;
      if (run.dispatchClaimId !== undefined) throw new DispatchAdmissionWaitError(run.id, laneId, 'capacity', detail, observation);
      throw new Error(`Run "${run.id}" cannot enter mission admission: ${detail}`);
    }
    const conflict = registry.readLane(result.conflictingLaneId);
    if (conflict?.role === 'production_captain' && conflict.evidence.repositoryScope === true && conflict.evidence.repository === `${run.target.owner}/${run.target.repo}`.toLowerCase()) {
      const detail = `Run "${run.id}" is waiting for repository ownership held by manual lane "${conflict.laneId}".`;
      if (run.dispatchClaimId !== undefined) throw new DispatchAdmissionWaitError(run.id, laneId, 'owner', detail, observation);
      throw new Error(`Run "${run.id}" cannot enter mission admission: ${detail}`);
    }
    throw new Error(`Run "${run.id}" cannot enter mission admission: overlaps active or parked lane "${result.conflictingLaneId}".`);
  }
  return result.token;
}

function settleRunAdmission(registry: MissionAdmissionRegistry, token: AdmissionToken, run: Run, receiptPath?: string): void {
  if (run.state === 'FAILED' || run.state === 'MERGED') {
    registry.release(token, true, receiptPath === undefined ? undefined : () => writeRunOwnerReceipt(receiptPath, receiptForCurrentToken(receiptPath, token, 'release_transition')),
      receiptPath === undefined ? undefined : () => finalizeRunOwnerReceipt(receiptPath, token, 'released', token.generation + 1));
  } else {
    const reason = run.state === 'NEEDS_HUMAN' || run.state === 'WAITING_DEPENDENCY' ? 'workflow_wait' : 'workflow_settled';
    registry.park(token, reason, receiptPath === undefined ? undefined : () => writeRunOwnerReceipt(receiptPath, receiptForCurrentToken(receiptPath, token, 'park_transition')),
      receiptPath === undefined ? undefined : () => finalizeRunOwnerReceipt(receiptPath, token, 'parked', token.generation + 1));
  }
}

function releasePreExecutionRunAdmission(registry: MissionAdmissionRegistry, token: AdmissionToken, receiptPath?: string): void {
  registry.release(token, true, receiptPath === undefined ? undefined : () => writeRunOwnerReceipt(receiptPath, receiptForCurrentToken(receiptPath, token, 'release_transition')),
    receiptPath === undefined ? undefined : () => finalizeRunOwnerReceipt(receiptPath, token, 'released', token.generation + 1));
}

/** Settle only the exact receipt generation. This retires authority and never resumes or spawns work. */
export function recoverRunAdmission(
  store: RunStore,
  registry: MissionAdmissionRegistry,
  runId: string,
  expectedGeneration: number,
  operatorStopped: boolean,
  receiptPath?: string,
  crashAfter?: { readonly parkReceiptNormalization?: () => void; readonly parkReceiptFinalization?: () => void },
): 'released' {
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error('Run admission recovery requires --generation <positive integer>.');
  const run = store.read(runId);
  if (run === null) throw new Error(`No run with id "${runId}" found.`);
  const laneId = `run:${run.id}`;
  const repo = `${run.target.owner}/${run.target.repo}`.toLowerCase();
  const canonicalReceiptPath = receiptPath ?? resolveRunOwnerReceiptPath(repo, run.id, evidenceForRun(run, run.bootstrap === undefined ? {} : { workspace: run.bootstrap.workspacePath }));
  const receipt = readRunOwnerReceipt(canonicalReceiptPath);
  if (receipt === null || receipt.laneId !== laneId || receipt.runId !== run.id || receipt.repository !== repo ||
    receipt.issue !== (run.target.kind === 'issue' ? run.target.issueNumber : undefined) || receipt.claimId !== run.dispatchClaimId) {
    throw new Error(`Run "${run.id}" has no matching private owner receipt; refusing recovery.`);
  }
  if (receipt.generation !== expectedGeneration &&
    !(receipt.phase === 'released' && receipt.generation === expectedGeneration + 1) &&
    !(receipt.phase === 'pre_execution' && receipt.generation === expectedGeneration + 1) &&
    !(receipt.phase === 'park_transition' && receipt.generation === expectedGeneration - 1)) {
    throw new Error(`Run owner receipt generation ${receipt.generation} does not match expected generation ${expectedGeneration}.`);
  }
  const lane = registry.readLane(laneId);
  if (lane === null || lane.missionId !== receipt.missionId || lane.role !== 'production_captain' || lane.evidence.repository !== repo || lane.evidence.run !== run.id ||
    lane.evidence.issue !== receipt.issue || (receipt.claimId !== undefined && lane.evidence.claim !== receipt.claimId)) {
    throw new Error(`Run owner receipt does not match the canonical registry owner for Run "${run.id}".`);
  }
  if (lane.status === 'released' && lane.generation === expectedGeneration + 1) {
    if (receipt.phase === 'released') return 'released';
    if (receipt.phase === 'release_transition' || receipt.phase === 'parked_release_transition') {
      registry.withExactReleasedLane(laneId, expectedGeneration + 1, () => {
        const current = readRunOwnerReceipt(canonicalReceiptPath);
        const canBindWorkspace = current !== null &&
          (current.phase === 'release_transition' || current.phase === 'parked_release_transition') &&
          canBindMissingReceiptWorkspace(current, run, lane.evidence.workspace);
        const workspaceMatches = current !== null && (current.workspace === lane.evidence.workspace || canBindWorkspace);
        if (current === null || !sameRunReceiptIdentity(current, run, lane.missionId) || !workspaceMatches ||
          (current.generation !== expectedGeneration && current.generation !== expectedGeneration + 1)) {
          throw new Error(`Run owner receipt does not match exact released generation ${expectedGeneration + 1}.`);
        }
        if (current.phase === 'released' && current.generation === expectedGeneration + 1 && current.token === undefined) return;
        if (current.phase !== 'release_transition' && current.phase !== 'parked_release_transition') throw new Error('Run owner receipt phase is not an exact released transition.');
        const exactActiveTransition = current.phase === 'release_transition' && current.generation === expectedGeneration && current.token?.laneId === laneId && current.token.generation === expectedGeneration;
        const exactParkedTransition = current.phase === 'parked_release_transition' && current.generation === expectedGeneration && current.token === undefined;
        if (!exactActiveTransition && !exactParkedTransition) throw new Error('Run owner receipt transition does not match the exact released generation.');
        const { token: _token, ...withoutToken } = current;
        writeRunOwnerReceipt(canonicalReceiptPath, { ...withoutToken, ...(canBindWorkspace ? { workspace: lane.evidence.workspace } : {}), phase: 'released', generation: expectedGeneration + 1 });
      });
      return 'released';
    }
  }
  if (lane.status === 'parked') {
    const expectedParkReason = run.state === 'NEEDS_HUMAN' || run.state === 'WAITING_DEPENDENCY' ? 'workflow_wait' : 'workflow_settled';
    const workspaceMatches = receipt.workspace === lane.evidence.workspace ||
      (receipt.workspace === undefined && ['park_transition', 'parked', 'parked_release_transition'].includes(receipt.phase) &&
        canBindMissingReceiptWorkspace(receipt, run, lane.evidence.workspace));
    const interruptedParkPublication = receipt.phase === 'park_transition' && receipt.generation === expectedGeneration - 1 &&
      lane.generation === expectedGeneration && lane.parkedReason === expectedParkReason &&
      workspaceMatches;
    const normalizedParkRetry = receipt.generation === expectedGeneration && lane.generation === expectedGeneration &&
      (receipt.phase === 'parked' || receipt.phase === 'parked_release_transition') && lane.parkedReason === expectedParkReason &&
      workspaceMatches;
    const interruptedParkedReadmission = lane.generation === expectedGeneration && receipt.generation === expectedGeneration + 1 &&
      (receipt.phase === 'pre_execution' || receipt.phase === 'parked_release_transition') && receipt.workspace === lane.evidence.workspace;
    const exactParkedGeneration = lane.generation === expectedGeneration && receipt.generation === expectedGeneration &&
      (receipt.phase === 'parked' || receipt.phase === 'parked_release_transition') && workspaceMatches;
    if (!interruptedParkPublication && !normalizedParkRetry && !interruptedParkedReadmission && !exactParkedGeneration) throw new Error('Parked registry lane does not match the Run owner receipt phase and generation.');
    if (!operatorStopped) throw new Error('Parked Run recovery requires explicit --stopped operator attestation that the provider and children have stopped.');
    registry.releaseParked(laneId, lane.generation, true,
      () => {
        writeParkedReleaseTransition(canonicalReceiptPath, run, lane.missionId, lane.generation, lane.evidence.workspace,
          canBindMissingReceiptWorkspace(receipt, run, lane.evidence.workspace));
        if (interruptedParkPublication) crashAfter?.parkReceiptNormalization?.();
      },
      () => {
        finalizeParkedRunOwnerReceipt(canonicalReceiptPath, run, lane.missionId, lane.generation, lane.evidence.workspace);
        crashAfter?.parkReceiptFinalization?.();
      });
    return 'released';
  }
  if (lane.status !== 'active' || receipt.token === undefined || receipt.token.generation !== expectedGeneration || receipt.token.laneId !== laneId) {
    throw new Error('Run owner receipt and registry do not identify the exact recoverable active generation.');
  }
  if (!operatorStopped) throw new Error('External recovery requires explicit --stopped operator attestation that the provider and children have stopped; receipt phase alone cannot prove supervisor death.');
  registry.assertCurrentOwner(receipt.token);
  const transition = { ...receipt, phase: 'release_transition' as const, token: receipt.token };
  registry.release(receipt.token, true, () => writeRunOwnerReceipt(canonicalReceiptPath, transition),
    () => finalizeRunOwnerReceipt(canonicalReceiptPath, receipt.token!, 'released', expectedGeneration + 1));
  return 'released';
}

function updateClaimedRunIfUnchanged(store: RunStore, expected: Run, next: Run): void {
  if (store.updateIfUnchanged === undefined) throw new Error(`Run store cannot compare-and-swap dispatch-bound Run "${expected.id}"; refusing to overwrite a concurrent decision.`);
  if (!store.updateIfUnchanged(expected, next)) throw new Error(`Dispatch-bound Run "${expected.id}" changed while the decision was being prepared; reload before retrying.`);
}

async function withRunAdmissionBoundary<T>(options: WorkflowCommandOptions, operation: () => T): Promise<T> {
  return options.withDispatchAdmissionLock === undefined ? operation() : options.withDispatchAdmissionLock(operation);
}

export function parseGitHubRepositoryRemote(remote: string): string {
  const trimmed = remote.trim();
  let ownerRepo: string | null = null;
  const scp = /^git@github\.com:([^?#]+)$/i.exec(trimmed);
  if (scp) ownerRepo = scp[1]!;
  else {
    try {
      const url = new URL(trimmed);
      const validCredentials = url.protocol === 'https:' ? url.username === '' && url.password === '' : (url.username === '' || url.username === 'git') && url.password === '';
      if (url.hostname.toLowerCase() !== 'github.com' || !validCredentials || url.search !== '' || url.hash !== '' || (url.protocol !== 'https:' && url.protocol !== 'ssh:')) {
        throw new Error('remote must be a direct GitHub HTTPS or SSH URL');
      }
      ownerRepo = url.pathname.replace(/^\//, '');
    } catch (error) {
      if (error instanceof Error && error.message === 'remote must be a direct GitHub HTTPS or SSH URL') throw error;
      throw new Error('Cannot resolve repository identity from git remote.origin.url.');
    }
  }
  const normalized = ownerRepo?.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  if (!normalized || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized)) throw new Error('Git remote does not identify exactly one GitHub owner/repository.');
  return normalized;
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
  /** Optional seam for helper-level tests; executable CLI always supplies the host registry. */
  readonly admission?: MissionAdmissionRegistry;
  /** Physical ambient provider cwd when execution has no prepared workspace. */
  readonly admissionWorkspace?: string;
  /** Private owner-only receipt path; executable CLI always supplies it with admission. */
  readonly runOwnerReceiptPath?: string;
  /** Release a surrounding short dispatch admission lock after durable admission/Run transition, before workflow execution. */
  readonly releaseDispatchAdmissionLock?: () => void;
  readonly withDispatchAdmissionLock?: <T>(operation: () => T | Promise<T>) => Promise<T>;
  /** Serialize the direct Run lookup/profile/create/admit boundary and hand its short-lock release to the admission path. */
  readonly withRunAdmissionLock?: <T>(operation: (release: () => void) => T | Promise<T>) => Promise<T>;
  /** Atomic short-lock bridge for a canonical live dispatch claim plus Run CAS. */
  readonly commitDispatchResumeTransition?: (expected: Run, next: Run, commitRun: () => void) => Promise<void>;
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
  if (options.withRunAdmissionLock !== undefined && options.releaseDispatchAdmissionLock === undefined) {
    return options.withRunAdmissionLock((release) => runIssueCommand(deps, ref, {
      ...options,
      withRunAdmissionLock: undefined,
      releaseDispatchAdmissionLock: release,
    }));
  }
  const target = parseIssueRef(ref);
  let run = findRunByTarget(deps.store, target);
  if (run !== null && run.dispatchClaimId !== options.dispatchClaimId) {
    throw new Error(`Active durable run "${run.id}" is not bound to dispatch claim "${options.dispatchClaimId}"; refusing ambiguous recovery.`);
  }
  const isNewRun = run === null;
  if (run === null) {
    run = createRun(target, undefined, undefined, options.execution, options.dispatchClaimId, options.repairTaskShapeAuthority);
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
  // Persist the exact READY intent before admission for both direct and
  // dispatch callers. Capacity denial and a crash after admission can then be
  // retried against this same immutable Run id.
  const precreatedRun = isNewRun && (options.dispatchClaimId !== undefined || options.admission !== undefined);
  if (precreatedRun) deps.store.create(run);
  const runOwnerReceiptPath = options.runOwnerReceiptPath ?? (options.admission === undefined ? undefined : resolveRunOwnerReceiptPath(`${run.target.owner}/${run.target.repo}`.toLowerCase(), run.id, evidenceForRun(run, options.admissionWorkspace === undefined ? {} : { workspace: options.admissionWorkspace })));
  const admissionToken = options.admission === undefined ? undefined : acquireRunAdmission(options.admission, run, runOwnerReceiptPath, options.admissionWorkspace);
  let mayReleaseAsPreExecution = admissionToken !== undefined;
  try {
    if (isNewRun && !precreatedRun) deps.store.create(run);
    options.releaseDispatchAdmissionLock?.();
    const outcome = await runWorkflow(deps, run.id, {
      maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
      now: options.now,
      ...(options.telemetryThresholds === undefined ? {} : { telemetryThresholds: options.telemetryThresholds }),
      onExecutionStart: () => {
        mayReleaseAsPreExecution = false;
        if (admissionToken !== undefined && runOwnerReceiptPath !== undefined) {
          options.admission!.renew(admissionToken, () => writeRunOwnerReceipt(runOwnerReceiptPath, receiptForCurrentToken(runOwnerReceiptPath, admissionToken, 'execution_possible')));
        }
      },
      ...(admissionToken === undefined ? {} : { admissionFence: { registry: options.admission!, token: admissionToken, productionMissionId: options.admission!.readLane(admissionToken.laneId)!.missionId, ...(options.admissionWorkspace === undefined ? {} : { executionWorkspace: options.admissionWorkspace }) } }),
    });
    mayReleaseAsPreExecution = false;
    if (admissionToken !== undefined) await withRunAdmissionBoundary(options, () => settleRunAdmission(options.admission!, admissionToken, outcome.run, runOwnerReceiptPath));
    return outcome;
  } catch (error) {
    if (admissionToken !== undefined && mayReleaseAsPreExecution) {
      options.releaseDispatchAdmissionLock?.();
      await withRunAdmissionBoundary(options, () => releasePreExecutionRunAdmission(options.admission!, admissionToken, runOwnerReceiptPath));
    }
    throw error;
  }
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
  if (run.dispatchClaimId !== options.dispatchClaimId) {
    throw new Error(`Run "${id}" is bound to dispatch claim "${run.dispatchClaimId}"; matching dispatch ownership is required to resume it.`);
  }
  if (run.state !== 'NEEDS_HUMAN' && run.state !== 'WAITING_DEPENDENCY') {
    throw new Error(`Run "${id}" is not parked for a decision (state ${run.state}); nothing to resume.`);
  }
  if (decision.trim() === '') throw new Error('A non-empty --decision is required to resume a parked run.');
  const choices = run.interrupt?.choices ?? [];
  if (choices.length > 0 && !choices.includes(decision)) {
    throw new Error(`Invalid decision "${decision}". Choose exactly one of: ${choices.join(' | ')}.`);
  }
  const targetOwner = findRunByTarget(deps.store, run.target);
  if (targetOwner !== null && targetOwner.id !== id) throw new Error(`Run "${id}" is not the unique active durable Run for its target.`);
  const runOwnerReceiptPath = options.runOwnerReceiptPath ?? (options.admission === undefined ? undefined : resolveRunOwnerReceiptPath(`${run.target.owner}/${run.target.repo}`.toLowerCase(), run.id, evidenceForRun(run, options.admissionWorkspace === undefined ? {} : { workspace: options.admissionWorkspace })));
  const admissionToken = options.admission === undefined ? undefined : acquireRunAdmission(options.admission, run, runOwnerReceiptPath, options.admissionWorkspace);
  let mayReleaseAsPreExecution = admissionToken !== undefined;
  try {
  const now = options.now ?? (() => new Date().toISOString());
  if (
    decision.trim() === CANCEL_RUN_DECISION &&
    run.interrupt?.choices?.includes(CANCEL_RUN_DECISION) === true
  ) {
    const cancelled = applyTransition(run, { type: 'fail', reason: CANCEL_RUN_DECISION }, now());
  if (run.dispatchClaimId !== undefined && options.commitDispatchResumeTransition !== undefined) {
    await options.commitDispatchResumeTransition(run, cancelled, () => {
      updateClaimedRunIfUnchanged(deps.store, run, cancelled);
      mayReleaseAsPreExecution = false;
    });
  } else if (run.dispatchClaimId !== undefined) updateClaimedRunIfUnchanged(deps.store, run, cancelled);
  else deps.store.update(cancelled);
    mayReleaseAsPreExecution = false;
    options.releaseDispatchAdmissionLock?.();
    if (admissionToken !== undefined) await withRunAdmissionBoundary(options, () => settleRunAdmission(options.admission!, admissionToken, cancelled, runOwnerReceiptPath));
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
  if (run.dispatchClaimId !== undefined && options.commitDispatchResumeTransition !== undefined) {
    await options.commitDispatchResumeTransition(run, resumed, () => {
      updateClaimedRunIfUnchanged(deps.store, run, resumed);
      mayReleaseAsPreExecution = false;
    });
  } else if (run.dispatchClaimId !== undefined) updateClaimedRunIfUnchanged(deps.store, run, resumed);
  else deps.store.update(resumed);
  options.releaseDispatchAdmissionLock?.();
  const outcome = await runWorkflow(deps, id, {
    maxReviewAttempts: options.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS,
    now: options.now,
    ...(options.telemetryThresholds === undefined ? {} : { telemetryThresholds: options.telemetryThresholds }),
    onExecutionStart: () => {
      mayReleaseAsPreExecution = false;
      if (admissionToken !== undefined && runOwnerReceiptPath !== undefined) {
        options.admission!.renew(admissionToken, () => writeRunOwnerReceipt(runOwnerReceiptPath, receiptForCurrentToken(runOwnerReceiptPath, admissionToken, 'execution_possible')));
      }
    },
    ...(admissionToken === undefined ? {} : { admissionFence: { registry: options.admission!, token: admissionToken, productionMissionId: options.admission!.readLane(admissionToken.laneId)!.missionId, ...(options.admissionWorkspace === undefined ? {} : { executionWorkspace: options.admissionWorkspace }) } }),
  });
  mayReleaseAsPreExecution = false;
  if (admissionToken !== undefined) await withRunAdmissionBoundary(options, () => settleRunAdmission(options.admission!, admissionToken, outcome.run, runOwnerReceiptPath));
  return outcome;
  } catch (error) {
    if (admissionToken !== undefined && mayReleaseAsPreExecution) {
      options.releaseDispatchAdmissionLock?.();
      await withRunAdmissionBoundary(options, () => releasePreExecutionRunAdmission(options.admission!, admissionToken, runOwnerReceiptPath));
    }
    throw error;
  }
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
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(resolveAccountHomeDirectory(), '.tachiko-conductor', 'workspaces'),
      });
      return bootstrap.plan(request);
    },
    prepare: async (request) => {
      bootstrap ??= new GitWorktreeBootstrap({
        repositoryRoot: resolveRepositoryRoot(),
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(resolveAccountHomeDirectory(), '.tachiko-conductor', 'workspaces'),
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
        workspaceRoot: env.TACHIKO_WORKSPACE_ROOT ?? path.join(resolveAccountHomeDirectory(), '.tachiko-conductor', 'workspaces'),
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

export function runTransitionCommand(store: RunStore, id: string, type: TransitionType, reason?: string, admission?: MissionAdmissionRegistry): Run {
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
  const transition = (): Run => {
    const current = store.read(id);
    if (current === null) throw new Error(`No run with id "${id}" found.`);
    const next = applyTransition(current, { type, reason });
    if (type === 'merged') {
      throw new Error('Transition "merged" requires an exact live GitHub merged pull-request proof; use the CLI merge reconciliation path.');
    }
    if (store.updateIfUnchanged !== undefined) {
      if (!store.updateIfUnchanged(current, next)) throw new Error(`Run "${id}" changed concurrently; refusing to apply a stale transition.`);
    } else if (admission !== undefined) {
      throw new Error('Admission-backed Run transitions require compare-and-swap Run storage; refusing an unfenced write.');
    } else {
      store.update(next);
    }
    return next;
  };
  return admission === undefined ? transition() : admission.withRunTransitionFence(id, transition);
}

function assertExactMergedPullRequest(run: Run, pullRequest: GitHubLivePullRequestSnapshot): void {
  const repository = `${run.target.owner}/${run.target.repo}`.toLowerCase();
  const bootstrap = run.bootstrap;
  const persisted = run.pullRequest;
  if (bootstrap === undefined || persisted === undefined || run.headSha === undefined || run.headSha === '' ||
    pullRequest.state !== 'merged' || pullRequest.number !== persisted.number ||
    pullRequest.headSha !== run.headSha || persisted.headSha !== run.headSha ||
    bootstrap.owner.toLowerCase() !== run.target.owner.toLowerCase() || bootstrap.repo.toLowerCase() !== run.target.repo.toLowerCase() ||
    (run.target.kind === 'issue' && bootstrap.issueNumber !== run.target.issueNumber) ||
    pullRequest.headRef !== (bootstrap.publicationBranch ?? bootstrap.branch) ||
    pullRequest.baseRef !== bootstrap.baseBranch ||
    pullRequest.headRepository === undefined || pullRequest.headRepository === null ||
    `${pullRequest.headRepository.owner}/${pullRequest.headRepository.repo}`.toLowerCase() !== repository ||
    pullRequest.baseRepository === undefined || pullRequest.baseRepository === null ||
    `${pullRequest.baseRepository.owner}/${pullRequest.baseRepository.repo}`.toLowerCase() !== repository) {
    throw new Error(`Live pull request proof does not match Run "${run.id}" persisted PR, HEAD, branch, and base identity, or the PR is not merged.`);
  }
  // The base branch is mutable and may advance (including after a squash
  // merge); repository and branch identity are the stable base proof.
}

function assertMergeLaneIdentity(run: Run, lane: AdmissionLaneView): string | undefined {
  const repository = `${run.target.owner}/${run.target.repo}`.toLowerCase();
  if (lane.laneId !== `run:${run.id}` || lane.evidence.run !== run.id || lane.evidence.repository !== repository ||
    lane.evidence.issue !== (run.target.kind === 'issue' ? run.target.issueNumber : undefined) ||
    lane.evidence.claim !== run.dispatchClaimId || lane.evidence.pullRequest !== run.pullRequest?.number) {
    throw new Error(`Admission lane identity for Run "${run.id}" does not match the persisted merge identity.`);
  }
  if (run.bootstrap === undefined) throw new Error(`Run "${run.id}" has no persisted bootstrap identity for merge reconciliation.`);
  const persistedWorkspace = canonicalizeMissionEvidence({ repository, workspace: run.bootstrap.workspacePath }).workspace;
  if (lane.evidence.workspace !== persistedWorkspace) {
    throw new Error(`Admission lane workspace for Run "${run.id}" does not match its persisted bootstrap workspace.`);
  }
  return lane.evidence.workspace;
}

function readMergeReceipt(receiptPath: string, run: Run, missionId: string, workspace: string | undefined): RunOwnerReceipt {
  const receipt = readRunOwnerReceipt(receiptPath);
  if (receipt === null || !sameRunReceiptIdentity(receipt, run, missionId) ||
    (receipt.workspace !== workspace && !(receipt.workspace === undefined && canBindMissingReceiptWorkspace(receipt, run, workspace)))) {
    throw new Error(`Run owner receipt does not match exact merge lane identity for Run "${run.id}".`);
  }
  return receipt;
}

function writeMergeReleaseTransition(receiptPath: string, run: Run, missionId: string, lane: AdmissionLaneView): number {
  const workspace = assertMergeLaneIdentity(run, lane);
  const receipt = readMergeReceipt(receiptPath, run, missionId, workspace);
  const generation = lane.generation;
  const alreadyTransitioning = receipt.phase === 'parked_release_transition' && receipt.generation === generation && receipt.token === undefined;
  if (alreadyTransitioning) {
    if (receipt.settlementReason !== 'workflow_settled') throw new Error(`Run owner receipt lacks workflow_settled merge authority for Run "${run.id}".`);
    return generation;
  }
  const initialParked = receipt.phase === 'parked' && receipt.generation === generation && receipt.token === undefined;
  if (!initialParked) throw new Error(`Run owner receipt phase and generation do not match workflow_settled lane generation ${generation}.`);
  const { token: _token, ...withoutToken } = receipt;
  writeRunOwnerReceipt(receiptPath, {
    ...withoutToken,
    ...(workspace === undefined ? {} : { workspace }),
    phase: 'parked_release_transition',
    generation,
    settlementReason: 'workflow_settled',
  });
  return generation;
}

function finalizeMergeReleaseReceipt(receiptPath: string, run: Run, missionId: string, workspace: string | undefined, parkedGeneration: number): void {
  const receipt = readMergeReceipt(receiptPath, run, missionId, workspace);
  const releasedGeneration = parkedGeneration + 1;
  if (receipt.phase === 'released' && receipt.generation === releasedGeneration && receipt.token === undefined && receipt.settlementReason === 'workflow_settled') {
    if (workspace !== undefined && receipt.workspace === undefined) writeRunOwnerReceipt(receiptPath, { ...receipt, workspace });
    return;
  }
  if (receipt.phase !== 'parked_release_transition' || receipt.generation !== parkedGeneration || receipt.token !== undefined || receipt.settlementReason !== 'workflow_settled') {
    throw new Error(`Run owner receipt does not match workflow_settled merge generation ${parkedGeneration}.`);
  }
  writeRunOwnerReceipt(receiptPath, { ...receipt, ...(workspace === undefined ? {} : { workspace }), phase: 'released', generation: releasedGeneration });
}

function casMergedRun(store: RunStore, current: Run): Run {
  if (current.state === 'MERGED') return current;
  if (current.state !== 'MERGE_READY') throw new Error(`Run "${current.id}" is ${current.state}; only MERGE_READY can be merged.`);
  if (store.updateIfUnchanged === undefined) throw new Error(`Run store cannot compare-and-swap merged Run "${current.id}"; refusing an unfenced transition.`);
  const next = applyTransition(current, { type: 'merged' });
  if (!store.updateIfUnchanged(current, next)) throw new Error(`Run "${current.id}" changed concurrently; refusing to publish merge settlement.`);
  return next;
}

/** Apply a normal merged transition only after exact live GitHub proof. Caller holds the canonical dispatch lock. */
export async function runMergedTransitionCommand(
  store: RunStore,
  id: string,
  github: GitHubAdapter,
  admission: MissionAdmissionRegistry,
  withDispatchAdmissionLock: <T>(operation: () => T | Promise<T>) => Promise<T>,
): Promise<Run> {
  const initial = store.read(id);
  if (initial === null) throw new Error(`No run with id "${id}" found.`);
  if (initial.state !== 'MERGE_READY' && initial.state !== 'MERGED') {
    throw new Error(`Run "${id}" is ${initial.state}; only MERGE_READY or an exact merged retry may be reconciled.`);
  }
  if (initial.pullRequest === undefined) throw new Error(`Run "${id}" has no persisted pull request identity; refusing an operator-claimed merge.`);
  if (github.readPullRequest === undefined) throw new Error('GitHub adapter cannot directly read the persisted pull request; refusing an operator-claimed merge.');
  const proof = await github.readPullRequest(initial.target.owner, initial.target.repo, initial.pullRequest.number);
  assertExactMergedPullRequest(initial, proof);

  const reconcile = (): Run => {
    let parkedGeneration: number | undefined;
    let workspace: string | undefined;
    let firstReconciliation = true;
    const result = admission.reconcileMergedRun(id, (lane, phase) => {
    const current = store.read(id);
    if (current === null) throw new Error(`No run with id "${id}" found during merge reconciliation.`);
    if (firstReconciliation) {
      firstReconciliation = false;
      if (JSON.stringify(current) !== JSON.stringify(initial)) {
        throw new Error(`Run "${id}" changed after live merge proof and before locked reconciliation; refusing a stale transition.`);
      }
    }
    assertExactMergedPullRequest(current, proof);
    if (current.state !== 'MERGE_READY' && current.state !== 'MERGED') throw new Error(`Run "${id}" changed to ${current.state} during merge reconciliation.`);

    if (lane === null) {
      if (phase !== 'unadmitted') throw new Error('Admission lane disappeared during merge reconciliation.');
      if (readRunOwnerReceipt(resolveRunOwnerReceiptPath(`${current.target.owner}/${current.target.repo}`.toLowerCase(), current.id, evidenceForRun(current))) !== null) {
        throw new Error(`Run owner receipt exists without its admission lane for Run "${id}"; refusing merge reconciliation.`);
      }
      return casMergedRun(store, current);
    }
    const laneWorkspace = assertMergeLaneIdentity(current, lane);
    workspace = laneWorkspace;
    const repository = `${current.target.owner}/${current.target.repo}`.toLowerCase();
    const receiptPath = resolveRunOwnerReceiptPath(repository, current.id, evidenceForRun(current, laneWorkspace === undefined ? {} : { workspace: laneWorkspace }));
    const storedReceipt = readRunOwnerReceipt(receiptPath);
    if (storedReceipt === null && current.state === 'MERGED' && phase === 'already_released') return current;
    const receipt = readMergeReceipt(receiptPath, current, lane.missionId, laneWorkspace);
    if (phase === 'before_publish') {
      parkedGeneration = writeMergeReleaseTransition(receiptPath, current, lane.missionId, lane);
      return casMergedRun(store, current);
    }
    if (phase === 'after_publish') {
      const generation = parkedGeneration ?? lane.generation;
      const settled = store.read(id);
      if (settled === null || settled.state !== 'MERGED') throw new Error(`Run "${id}" was not durably merged before its lane release.`);
      assertExactMergedPullRequest(settled, proof);
      finalizeMergeReleaseReceipt(receiptPath, settled, lane.missionId, laneWorkspace, generation);
      return settled;
    }
    if (phase !== 'already_released') throw new Error('Merge reconciliation reached an invalid admission phase.');

    if (current.state === 'MERGE_READY') {
      const exactFinalizedTransition = receipt.phase === 'released' && receipt.generation === lane.generation &&
        receipt.token === undefined && receipt.settlementReason === 'workflow_settled';
      if (exactFinalizedTransition) return casMergedRun(store, current);
      const exactPriorTransition = receipt.phase === 'parked_release_transition' && receipt.generation === lane.generation - 1 &&
        receipt.token === undefined && receipt.settlementReason === 'workflow_settled';
      if (!exactPriorTransition) throw new Error(`Released lane for Run "${id}" lacks the exact workflow_settled merge transition receipt.`);
      parkedGeneration = lane.generation - 1;
      const merged = casMergedRun(store, current);
      finalizeMergeReleaseReceipt(receiptPath, merged, lane.missionId, laneWorkspace, parkedGeneration);
      return merged;
    }
    const exactFinalReceipt = receipt.phase === 'released' && receipt.generation === lane.generation && receipt.token === undefined &&
      receipt.settlementReason === 'workflow_settled';
    const exactInterruptedTransition = receipt.phase === 'parked_release_transition' && receipt.generation === lane.generation - 1 &&
      receipt.token === undefined && receipt.settlementReason === 'workflow_settled';
    if (!exactFinalReceipt && !exactInterruptedTransition) {
      throw new Error(`Released lane for merged Run "${id}" lacks its exact workflow_settled merge receipt.`);
    }
    if (exactInterruptedTransition) finalizeMergeReleaseReceipt(receiptPath, current, lane.missionId, laneWorkspace, lane.generation - 1);
    return current;
    });
    return result;
  };
  return await withDispatchAdmissionLock(reconcile);
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
    if (subcommand === 'admission' && rest[0] === 'status' && rest.length === 1) {
      console.log(JSON.stringify(dispatchAdmissionStatus(createHostAdmissionRegistry(), store), null, 2));
      return 0;
    }
    if (subcommand === 'manual' && ['register', 'park', 'retire', 'recover'].includes(rest[0] ?? '')) {
      const action = rest[0];
      const stopped = rest.includes('--stopped');
      const expectedFlag = rest.indexOf('--expected-generation');
      const receiptStdin = rest.includes('--receipt-stdin');
      const expectedRaw = expectedFlag >= 0 ? rest[expectedFlag + 1] : undefined;
      if ((action === 'register' && (rest.length !== 1)) ||
        (action === 'park' && (!stopped || rest.some((item) => item !== 'park' && item !== '--stopped'))) ||
        (action === 'retire' && (!stopped || expectedFlag < 0 || expectedRaw === undefined || rest.length !== 4 || rest.filter((item) => item === '--expected-generation').length !== 1)) ||
        (action === 'recover' && (!receiptStdin || rest.length !== 2))) {
        throw new Error('Manual commands require register; park --stopped; retire --stopped --expected-generation <n>; or recover --receipt-stdin.');
      }
      const expectedGeneration = expectedRaw === undefined ? undefined : Number(expectedRaw);
      if (action === 'retire' && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration! <= 0)) throw new Error('--expected-generation must be a positive integer.');
      return await withDispatchAdmissionLock(async () => {
      const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
      const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
      const checkpointSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const clean = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '';
      const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
      const repository = parseGitHubRepositoryRemote(remote);
      const registry = createHostAdmissionRegistry();
      const identity = canonicalizeMissionEvidence({ repository, repositoryScope: true, workspace: worktree });
      const laneId = `manual:${createHash('sha256').update(`${repository}\0${identity.workspace}`).digest('hex').slice(0, 32)}`;
      const receiptPath = resolveManualOwnerReceiptPath(repository, identity.workspace!);
      const now = new Date().toISOString();
      const manualProjection = (receipt: ManualOwnerReceipt, state: 'active' | 'parked', clean: boolean, revision?: number) => registerManualLane(resolveRunsDir(), {
        repository, worktree: identity.workspace!, branch: receipt.branch, checkpointSha: receipt.checkpointSha,
        clean, state, recoverable: clean, laneId, missionId: receipt.missionId,
        ...(revision === undefined ? {} : { admissionRevision: revision }),
      }, now);
      if (action === 'register') {
        const prior = registry.readLane(laneId);
        let missionId: string;
        let revision: number;
        let token: AdmissionToken;
        if (prior?.status === 'active') {
          throw new Error(`Manual lane already has active ownership at generation ${prior.generation}; a second registration cannot reuse that capability.`);
        } else if (prior?.status === 'parked' && (prior.parkedReason === undefined || !['capacity_captains', 'capacity_writers', 'capacity_high_autonomy', 'capacity_repository'].includes(prior.parkedReason))) {
          throw new Error(`Manual lane remains reserved at parked generation ${prior.generation} (${prior.parkedReason}); retire its exact clean checkpoint before registering again.`);
        } else {
          const admission = registry.admit({ laneId, role: 'production_captain', evidence: identity, highAutonomy: true }, {
            beforePublish: (candidate) => {
              const receipt: ManualOwnerReceipt = { schemaVersion: 1, laneId, missionId: candidate.missionId, repository, workspace: identity.workspace!, branch, checkpointSha, status: 'active', generation: candidate.token.generation, token: candidate.token };
              try { writeManualOwnerReceipt(receiptPath, receipt); }
              catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Manual owner receipt could not be durably published before admission: ${detail}`);
              }
            },
          });
          if (admission.outcome !== 'admitted') throw new Error(admission.outcome === 'duplicate'
            ? `Manual production lane overlaps active or parked lane "${admission.conflictingLaneId}".`
            : `Manual production lane is parked by ${admission.reason}.`);
          missionId = admission.missionId;
          revision = admission.revision;
          token = admission.token;
        }
        const receipt = readManualOwnerReceipt(receiptPath);
        if (receipt?.status !== 'active' || receipt.generation !== token.generation || receipt.token?.token !== token.token) throw new Error(`Manual lane ${laneId} generation ${token.generation} was admitted but its exact private owner receipt is unavailable; retain the registry fence and reconcile from its private receipt.`);
        let projection: ReturnType<typeof registerManualLane>;
        try { projection = manualProjection(receipt, 'active', clean, revision); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Manual lane ${laneId} generation ${token.generation} has a private owner receipt at ${receiptPath}, but projection publication failed; preserve the fence and retry reconciliation: ${detail}`);
        }
        console.log(JSON.stringify({ projection, laneId, missionId, admissionRevision: revision, ownerReceiptPath: receiptPath }));
        return 0;
      }
      if (action === 'recover') {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(0, 'utf8')); } catch { throw new Error('Manual recovery stdin must contain one strict JSON ManualOwnerReceipt.'); }
        if (!validateManualOwnerReceipt(parsed) || parsed.status !== 'active' || parsed.laneId !== laneId || parsed.repository !== repository || parsed.workspace !== identity.workspace || parsed.token === undefined) throw new Error('Recovery receipt does not identify this active manual owner.');
        const current = registry.readLane(laneId);
        if (current?.status !== 'active' || current.missionId !== parsed.missionId || current.generation !== parsed.generation || current.role !== 'production_captain' || current.evidence.repositoryScope !== true || current.evidence.workspace !== identity.workspace) throw new Error('Recovery receipt is stale or does not match current registry ownership.');
        registry.assertCurrentOwner(parsed.token);
        writeManualOwnerReceipt(receiptPath, parsed);
        const projection = manualProjection(parsed, 'active', clean, registry.snapshot().revision);
        console.log(JSON.stringify({ projection, laneId, missionId: parsed.missionId, ownerReceiptPath: receiptPath }));
        return 0;
      }
      const prior = registry.readLane(laneId);
      const receipt = readManualOwnerReceipt(receiptPath);
      if (receipt === null || receipt.laneId !== laneId || receipt.repository !== repository || receipt.workspace !== identity.workspace) throw new Error('Private manual owner receipt is missing or belongs to a different worktree; refusing mutation.');
      if (action === 'park') {
        if (!clean || !stopped || branch !== receipt.branch) throw new Error('Manual park requires the original branch and a clean stopped worktree.');
        let generation: number;
        let revision: number;
        if (receipt.status === 'active' || (receipt.status === 'parking' && prior?.status === 'active')) {
          if (!receipt.token || prior?.status !== 'active' || prior.generation !== receipt.generation || prior.missionId !== receipt.missionId) throw new Error('Manual owner receipt is stale or no longer matches active registry ownership.');
          if (receipt.status === 'parking' && (branch !== receipt.branch || checkpointSha !== receipt.checkpointSha)) throw new Error('Interrupted manual park must resume from its exact recorded branch and HEAD checkpoint.');
          const parking: ManualOwnerReceipt = receipt.status === 'parking' ? receipt : { ...receipt, status: 'parking', branch, checkpointSha };
          if (receipt.status !== 'parking') writeManualOwnerReceipt(receiptPath, parking);
          revision = registry.parkManual(receipt.token, { worktree, branch, checkpointSha, clean, stopped });
          const parkedLane = registry.readLane(laneId)!;
          generation = parkedLane.generation;
          writeManualOwnerReceipt(receiptPath, { schemaVersion: 1, laneId, missionId: receipt.missionId, repository, workspace: identity.workspace!, branch, checkpointSha, status: 'parked', generation });
        } else if (receipt.status === 'parking' && prior?.status === 'parked' && prior.generation === receipt.generation + 1 && prior.parkedReason === 'manual_checkpoint') {
          generation = prior.generation; revision = registry.snapshot().revision;
          writeManualOwnerReceipt(receiptPath, { schemaVersion: 1, laneId, missionId: receipt.missionId, repository, workspace: identity.workspace!, branch: receipt.branch, checkpointSha: receipt.checkpointSha, status: 'parked', generation });
        } else if (receipt.status === 'parked' && prior?.status === 'parked' && prior.generation === receipt.generation && prior.parkedReason === 'manual_checkpoint') {
          generation = receipt.generation; revision = registry.snapshot().revision;
        } else throw new Error('Manual owner receipt and registry do not establish a current active or parked generation.');
        const parkedReceipt = readManualOwnerReceipt(receiptPath)!;
        const projection = manualProjection(parkedReceipt, 'parked', true, revision);
        console.log(JSON.stringify({ projection, laneId, missionId: receipt.missionId, admissionRevision: revision, parkedGeneration: generation, ownerReceiptPath: receiptPath }));
        return 0;
      }
      if (receipt.status !== 'parked' || expectedGeneration !== receipt.generation || !clean || !stopped || branch !== receipt.branch || checkpointSha !== receipt.checkpointSha ||
        !((prior?.status === 'parked' && prior.generation === receipt.generation) || (prior?.status === 'released' && prior.generation === receipt.generation + 1))) throw new Error('Manual retirement requires the exact parked receipt generation and unchanged clean stopped branch/HEAD checkpoint.');
      let revision: number;
      try { revision = registry.retireManual(laneId, receipt.generation, { worktree, branch, checkpointSha, clean, stopped }); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Manual retirement did not release its exact parked generation; the parked projection remains authoritative: ${detail}`);
      }
      let projection: ReturnType<typeof retireManualLane>;
      try { projection = retireManualLane(resolveRunsDir(), laneId, now); }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Manual lane generation ${receipt.generation} is retired in the registry, but its parked projection could not be cleared; preserve the released generation and retry exact-generation reconciliation: ${detail}`);
      }
      // Retain the parked private receipt as a harmless generation tombstone.
      // The next authorized register replaces it while holding this same lock.
      console.log(JSON.stringify({ projection, laneId, missionId: receipt.missionId, admissionRevision: revision, retiredGeneration: receipt.generation + 1 }));
      return 0;
      });
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
          'pnpm-program': { type: 'string' },
          'dependency-artifact-path': { type: 'string' },
          'luna-codex-home': { type: 'string' },
          'playwright-browsers-path': { type: 'string' },
          'working-directory': { type: 'string' },
          label: { type: 'string' },
          'stdout-path': { type: 'string' },
          'stderr-path': { type: 'string' },
        },
      });
      if (positionals.length > 0 || values.program === undefined || values['node-program'] === undefined || values['pnpm-program'] === undefined || values['dependency-artifact-path'] === undefined || values['luna-codex-home'] === undefined || values['playwright-browsers-path'] === undefined || values['working-directory'] === undefined) {
        throw new Error('dispatch launchd render requires --program, --node-program, --pnpm-program, --dependency-artifact-path, --luna-codex-home, --playwright-browsers-path, and --working-directory.');
      }
      console.log(renderDispatchLaunchdPlist({
        program: values.program,
        nodeProgram: values['node-program'],
        pnpmProgram: values['pnpm-program'],
        dependencyArtifactPath: values['dependency-artifact-path'],
        lunaCodexHome: values['luna-codex-home'],
        playwrightBrowsersPath: values['playwright-browsers-path'],
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
      const reconcile = async () => await withDispatchAdmissionLock(async (releaseAdmissionLock) => {
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
        const admission = createHostAdmissionRegistry();
        return await dispatchOnceCommand(config, {
          workflow,
          runtime,
          admission,
          releaseAdmissionLock,
          withAdmissionLock: async <T>(operation: () => Promise<T> | T) => await withDispatchAdmissionLock(operation),
          resolveExecutionProfile: (profile) => resolveSelectedExecutionProfile(profile),
          runIssue: async (ref, execution, dispatchClaimId, repairTaskShapeAuthority, missionAdmission, release, withLock) => {
            return await runIssueCommand(workflow, ref, {
              ...(execution === undefined ? {} : { execution }), dispatchClaimId, repairTaskShapeAuthority, admission: missionAdmission!,
              releaseDispatchAdmissionLock: release, withDispatchAdmissionLock: withLock,
            });
          },
          resumeClaimedRun: async (run, dispatchClaimId, missionAdmission, release, withLock) => {
            if (run.target.kind !== 'issue') throw new Error(`Dispatch claimed Run ${run.id} is not an issue Run.`);
            const workspace = persistedRunWorkspace(run);
            return await runIssueCommand(workflow, `${run.target.owner}/${run.target.repo}#${run.target.issueNumber}`, {
              ...(run.execution === undefined ? {} : { execution: run.execution }),
              dispatchClaimId,
              ...(run.repairTaskShapeAuthority === undefined ? {} : { repairTaskShapeAuthority: run.repairTaskShapeAuthority }),
              admission: missionAdmission!,
              ...(workspace === undefined ? {} : { admissionWorkspace: workspace }),
              releaseDispatchAdmissionLock: release, withDispatchAdmissionLock: withLock,
            });
          },
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

  if (subcommand === 'admission' && rest[0] === 'recover') {
    const { values, positionals } = parseArgs({
      args: rest.slice(1), allowPositionals: true,
      options: { generation: { type: 'string' }, stopped: { type: 'boolean' } },
    });
    const [id] = positionals;
    if (id === undefined || values.generation === undefined) throw new Error('run admission recover requires <run-id> --generation <n>.');
    const generation = Number(values.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('--generation must be a positive safe integer.');
    const disposition = await withDispatchAdmissionLock(() => recoverRunAdmission(store, createHostAdmissionRegistry(), id, generation, values.stopped === true));
    console.log(JSON.stringify({ outcome: disposition, runId: id, generation }));
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
    const next = type === 'merged'
      ? await runMergedTransitionCommand(store, id, new LiveGitHubAdapter({ transport: new GhCliTransport() }), createHostAdmissionRegistry(), withDispatchAdmissionLock)
      : await withDispatchAdmissionLock(() => runTransitionCommand(store, id, type as TransitionType, values.reason, createHostAdmissionRegistry()));
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
    const outcome = await withDispatchAdmissionLock(async (releaseAdmissionLock) => {
      const run = store.read(id);
      if (run === null) throw new Error(`No run with id "${id}" found.`);
      const admissionWorkspace = persistedRunWorkspace(run);
      const withLock = async <T>(operation: () => Promise<T> | T) => await withDispatchAdmissionLock(operation);
      let commitDispatchResumeTransition: WorkflowCommandOptions['commitDispatchResumeTransition'];
      if (run.dispatchClaimId !== undefined) {
        if (run.target.kind !== 'issue' || run.execution === undefined) throw new Error(`Dispatch-bound Run "${id}" has no canonical issue/profile binding.`);
        const config = resolveDispatchConfiguration();
        if (`${run.target.owner}/${run.target.repo}`.toLowerCase() !== `${config.owner}/${config.repo}`.toLowerCase()) throw new Error('Dispatch-bound Run does not belong to the configured canonical runtime repository.');
        const runtime = new GitHubDispatchRuntime(new GhCliTransport(), config);
        const assertLiveClaim = async (expectedRun: Run) => {
          const selected = selectDispatchRuntime(await runtime.listRuntimeComments());
          if (selected === null) throw new Error('Dispatch runtime claim is missing.');
          const claim = selected.claim;
          const claimBoundRun = claim.runId === null && expectedRun.target.kind === 'issue'
            ? claimedRun(store, claim, { issue: expectedRun.target.issueNumber, route: 'codex', profile: expectedRun.execution!.profile }, { owner: config.owner, repo: config.repo })
            : null;
          assertCanonicalDispatchResumeClaim(expectedRun, claim, config, claimBoundRun);
          return selected;
        };
        await assertLiveClaim(run);
        commitDispatchResumeTransition = async (expectedRun, nextRun, commitRun) => {
          const live = await assertLiveClaim(expectedRun);
          const now = new Date().toISOString();
          const transitionClaim: DispatchRuntimeClaim = { ...live.claim, runId: expectedRun.id, state: nextRun.state === 'FAILED' ? 'failed' : 'running', heartbeatAt: now, leaseUntil: new Date(Date.parse(now) + config.leaseDurationMs).toISOString() };
          // Persist the exact Run decision first while the short lock still
          // excludes competing decisions. If the following GitHub write fails
          // or the process dies, the retained claim plus active Run can be
          // reconciled by dispatch; a claim-only `running` state could strand
          // the still-parked Run from its public resume path.
          commitRun();
          await runtime.updateRuntimeComment(live.id, renderDispatchRuntime(transitionClaim));
          const observed = selectDispatchRuntime(await runtime.listRuntimeComments());
          if (observed === null || observed.id !== live.id || observed.claim.claimId !== transitionClaim.claimId || observed.claim.runId !== expectedRun.id || observed.claim.state !== transitionClaim.state) {
            throw new Error('Dispatch claim changed after the human Run decision was committed; retained Run and claim require reconciliation.');
          }
        };
      }
      return await resumeCommand(buildWorkflowDeps(store, resolveCapabilities), id, values.decision!, {
        admission: createHostAdmissionRegistry(),
        ...(admissionWorkspace === undefined ? {} : { admissionWorkspace }),
        releaseDispatchAdmissionLock: releaseAdmissionLock,
        withDispatchAdmissionLock: withLock,
        ...(run.dispatchClaimId === undefined ? {} : { dispatchClaimId: run.dispatchClaimId, commitDispatchResumeTransition }),
      });
    });
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
  const outcome = await withDispatchAdmissionLock(async (releaseAdmissionLock) => {
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
    return runIssueCommand(buildWorkflowDeps(store, resolveCapabilities), ref, {
      execution, repairTaskShapeAuthority, admission: createHostAdmissionRegistry(),
      releaseDispatchAdmissionLock: releaseAdmissionLock,
      withDispatchAdmissionLock: async <T>(operation: () => T | Promise<T>) => await withDispatchAdmissionLock(operation),
    });
  });
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
