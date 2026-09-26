import type { AgentResult, ExecutorIdentity, Target } from '../domain/types.js';
import type { ResolvedExecutionConfiguration } from '../execution-profiles.js';

export const HUMAN_TAKEOVER_DIAGNOSTIC = 'TACHIKO_NEEDS_HUMAN:';
export const GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED = 'GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED' as const;
export const GOVERNED_PUBLICATION_REENTRY_ACTION = 'Preserve this Run’s executor/session and retry only after its exact runtime has a source-qualified host publication boundary.';

const confinedAgents = new WeakSet<object>();

/** Mark a source-owned adapter whose runtime confines worker writes and host-owned publication. */
export function qualifyGovernedPublicationAdapter<T extends object>(adapter: T): T {
  confinedAgents.add(adapter);
  return adapter;
}

export function hasGovernedPublicationConfinement(adapter: object): boolean {
  return confinedAgents.has(adapter);
}

export function humanTakeoverReason(result: AgentResult): string | undefined {
  const diagnostic = result.diagnostics?.find((value) => value.startsWith(HUMAN_TAKEOVER_DIAGNOSTIC));
  const reason = diagnostic?.slice(HUMAN_TAKEOVER_DIAGNOSTIC.length).trim();
  return reason === undefined || reason === '' ? undefined : reason;
}

/** Ephemeral connection to one already-running HTTP MCP server. */
export interface McpHttpCapability {
  readonly kind: 'mcp-http';
  readonly name: string;
  readonly endpoint: string;
}

/** Validate and normalize generic HTTP MCP capabilities at the adapter boundary. */
export function normalizeMcpHttpCapabilities(
  capabilities: readonly McpHttpCapability[],
): readonly McpHttpCapability[] {
  const names = new Set<string>();
  return capabilities.map((capability) => {
    if (!/^[A-Za-z0-9_-]+$/.test(capability.name)) {
      throw new Error(`Invalid MCP capability name "${capability.name}"; use only letters, digits, underscores, or hyphens.`);
    }
    if (names.has(capability.name)) {
      throw new Error(`Duplicate MCP capability name "${capability.name}".`);
    }
    names.add(capability.name);
    let endpoint: URL;
    try {
      endpoint = new URL(capability.endpoint);
    } catch {
      throw new Error(`MCP capability "${capability.name}" has an invalid endpoint URL.`);
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error(`MCP capability "${capability.name}" must use an HTTP or HTTPS endpoint.`);
    }
    if (endpoint.username !== '' || endpoint.password !== '') {
      throw new Error(`MCP capability "${capability.name}" must not embed credentials in its endpoint URL.`);
    }
    return { ...capability, endpoint: endpoint.toString() };
  });
}

/** Resolve ephemeral capabilities immediately before an implementation call. */
export type ImplementationCapabilityResolver = () => Promise<readonly McpHttpCapability[] | undefined>;

/** A non-persisted guard that providers must assert directly before spawning. */
export interface WorkspaceGuard {
  assertValid(phase?: 'before-execution' | 'after-execution'): void | Promise<void>;
}

export const WORKSPACE_GUARD_FAILURE_CODE = 'WORKSPACE_GUARD_FAILURE' as const;

export class WorkspaceGuardFailure extends Error {
  readonly code = WORKSPACE_GUARD_FAILURE_CODE;
  constructor(cause: unknown, readonly executor?: ExecutorIdentity) {
    super(`Prepared workspace identity guard failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'WorkspaceGuardFailure';
  }
}

export function isWorkspaceGuardFailure(error: unknown): error is WorkspaceGuardFailure {
  return error instanceof WorkspaceGuardFailure;
}

export async function assertWorkspaceGuard(
  guard: WorkspaceGuard | undefined,
  phase: 'before-execution' | 'after-execution' = 'before-execution',
  executor?: ExecutorIdentity,
): Promise<void> {
  if (guard === undefined) return;
  try {
    await guard.assertValid(phase);
  } catch (error) {
    if (isWorkspaceGuardFailure(error) && (executor === undefined || error.executor !== undefined)) throw error;
    throw new WorkspaceGuardFailure(error, executor);
  }
}

export interface ImplementationRequest {
  /** The work item: a single issue or a whole branch. */
  readonly target: Target;
  readonly baseSha: string;
  /** Prepared linked worktree; providers use this as their process cwd. */
  readonly workspacePath?: string;
  readonly branch?: string;
  /** Synchronous final authority check for host publication; never persisted or sent into an executor. */
  readonly beforePublish?: () => void;
  /** Must be evaluated after capability resolution and directly before spawn. */
  readonly workspaceGuard?: WorkspaceGuard;
  /** Whether the executor should read target authority live instead of from copied prose. */
  readonly authority?: 'embedded' | 'live-target';
  readonly instructions?: string;
  /** Small Conductor/review instructions that remain relevant with live authority. */
  readonly supplementalInstructions?: string;
  /** Per-invocation capabilities; never persisted in Conductor run state. */
  readonly capabilities?: readonly McpHttpCapability[];
  /** Previously persisted executor session token, when continuing a run. */
  readonly sessionId?: string;
  /** Provider-neutral durable executor identity for exact continuation. */
  readonly executor?: ExecutorIdentity;
  /**
   * The existing durable Run/claim ownership fence. Native runtime control is
   * forbidden when this is absent; an App Server process is never ownership.
   */
  readonly runtimeOwnership?: {
    readonly runId: string;
    readonly generation: string;
    readonly dispatchClaimId?: string;
  };
  /** Host-only governor requirement; never persisted or serialized into worker instructions. */
  readonly governedPublication?: { readonly required: true; readonly continuation: boolean };
  /** Immutable Steward-selected execution snapshot; adapters never select it. */
  readonly execution?: ResolvedExecutionConfiguration;
  /** Cancels the active implementation process. */
  readonly signal?: AbortSignal;
}

/**
 * Boundary to an implementation agent (e.g. Claude Code in non-interactive
 * mode). Concrete implementations are added in issue #4; the core depends only
 * on this interface.
 */
export interface ImplementationAgent {
  readonly kind: 'implementation-agent';
  run(request: ImplementationRequest): Promise<AgentResult>;
  /** Resolves and pins the exact source-owned adapter before a governed invocation is counted or started. */
  prepareGovernedInvocation?(request: ImplementationRequest): GovernedInvocationPreparation;
}

export type GovernedInvocationPreparation =
  | { readonly status: 'qualified'; readonly agent: ImplementationAgent }
  | { readonly status: 'held'; readonly reason: string };

/** Defense in depth for adapters called directly, outside the implementation registry. */
export function governedPublicationRefusal(adapter: object, request: ImplementationRequest): AgentResult | undefined {
  if (request.governedPublication === undefined || hasGovernedPublicationConfinement(adapter)) return undefined;
  const detail = 'Governed mutation is held because this runtime has no source-qualified publication confinement; no model turn or worker process was started. ' + GOVERNED_PUBLICATION_REENTRY_ACTION;
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED}: ${detail}`],
    ...(request.executor === undefined ? {} : { executor: request.executor }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    durationMs: 0,
  };
}
