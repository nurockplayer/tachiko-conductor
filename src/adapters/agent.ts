import type { AgentResult, Target } from '../domain/types.js';

export interface ImplementationRequest {
  /** The work item: a single issue or a whole branch. */
  readonly target: Target;
  readonly baseSha: string;
  readonly instructions?: string;
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
