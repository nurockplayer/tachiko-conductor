import type { ImplementationAgent, ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';

export const EXECUTOR_ROUTING_ERROR_CODE = {
  PROVIDER_UNAVAILABLE: 'EXECUTOR_PROVIDER_UNAVAILABLE',
  RECONSTRUCTION_FAILED: 'EXECUTOR_RECONSTRUCTION_FAILED',
} as const;

export interface ImplementationAgentRegistryOptions {
  /** Provider used only when a run has no durable or legacy executor identity. */
  readonly defaultProvider: string;
  /** Provider that owns pre-executor-metadata `sessionId` runs. */
  readonly legacySessionProvider?: string;
  readonly providers: Readonly<Record<string, () => ImplementationAgent>>;
}

/** Reconstructs the correct provider adapter from durable executor metadata. */
export class ImplementationAgentRegistry implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly defaultProvider: string;
  private readonly legacySessionProvider: string | undefined;
  private readonly providers: Readonly<Record<string, () => ImplementationAgent>>;

  constructor(options: ImplementationAgentRegistryOptions) {
    this.defaultProvider = options.defaultProvider;
    this.legacySessionProvider = options.legacySessionProvider;
    this.providers = options.providers;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    const provider = request.executor?.provider ?? (
      request.sessionId === undefined ? this.defaultProvider : this.legacySessionProvider
    );
    if (provider === undefined || provider.trim() === '' || this.providers[provider] === undefined) {
      const requested = provider ?? '(legacy session provider not configured)';
      return routingFailure(
        EXECUTOR_ROUTING_ERROR_CODE.PROVIDER_UNAVAILABLE,
        `Implementation executor provider "${requested}" is unavailable; continuity cannot be reconstructed.`,
        request,
      );
    }
    let agent: ImplementationAgent;
    try {
      agent = this.providers[provider]();
    } catch (error) {
      return routingFailure(
        EXECUTOR_ROUTING_ERROR_CODE.RECONSTRUCTION_FAILED,
        `Implementation executor provider "${provider}" could not be reconstructed: ${errorMessage(error)}`,
        request,
      );
    }
    return await agent.run(request);
  }
}

function routingFailure(
  code: (typeof EXECUTOR_ROUTING_ERROR_CODE)[keyof typeof EXECUTOR_ROUTING_ERROR_CODE],
  detail: string,
  request: ImplementationRequest,
): AgentResult {
  return {
    exitStatus: 'failure',
    summary: detail,
    diagnostics: [`${code}: ${detail}`],
    ...(request.executor === undefined ? {} : { executor: request.executor }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
