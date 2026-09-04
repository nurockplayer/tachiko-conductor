import type { AgentResult, ExecutorIdentity, Target } from '../domain/types.js';

export const HUMAN_TAKEOVER_DIAGNOSTIC = 'TACHIKO_NEEDS_HUMAN:';

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

/** Transient filesystem identity guard; implementations assert it immediately before process spawn. */
export interface WorkspaceGuard {
  assertValid(): void;
}

/** Provider-neutral signal that the prepared implementation workspace is no longer safe to use. */
export const WORKSPACE_GUARD_FAILURE_CODE = 'WORKSPACE_GUARD_FAILURE' as const;

export class WorkspaceGuardFailure extends Error {
  readonly code = WORKSPACE_GUARD_FAILURE_CODE;
  readonly causeError: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Prepared workspace identity guard failed: ${detail}`);
    this.name = 'WorkspaceGuardFailure';
    this.causeError = cause;
  }
}

export function isWorkspaceGuardFailure(error: unknown): error is WorkspaceGuardFailure {
  return error instanceof WorkspaceGuardFailure;
}

/** Preserve guard failures as a typed bootstrap signal at every provider boundary. */
export function assertWorkspaceGuard(guard: WorkspaceGuard | undefined): void {
  if (guard === undefined) return;
  try {
    guard.assertValid();
  } catch (error) {
    if (isWorkspaceGuardFailure(error)) throw error;
    throw new WorkspaceGuardFailure(error);
  }
}

export interface ImplementationRequest {
  /** The work item: a single issue or a whole branch. */
  readonly target: Target;
  readonly baseSha: string;
  /** Isolated provider-neutral workspace prepared for this issue, when bootstrapped. */
  readonly workspacePath?: string;
  /** Durable implementation branch paired with workspacePath. */
  readonly branch?: string;
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
}
