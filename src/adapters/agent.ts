import type { AgentResult, Target } from '../domain/types.js';

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

export interface ImplementationRequest {
  /** The work item: a single issue or a whole branch. */
  readonly target: Target;
  readonly baseSha: string;
  readonly instructions?: string;
  /** Per-invocation capabilities; never persisted in Conductor run state. */
  readonly capabilities?: readonly McpHttpCapability[];
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
