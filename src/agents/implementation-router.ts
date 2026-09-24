import {
  GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED,
  GOVERNED_PUBLICATION_REENTRY_ACTION,
  hasGovernedPublicationConfinement,
  type GovernedInvocationPreparation,
  type ImplementationAgent,
  type ImplementationRequest,
} from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';
import { assertExecutionSupportedByProvider, type ResolvedExecutionConfiguration } from '../execution-profiles.js';

export const EXECUTOR_ROUTING_ERROR_CODE = {
  PROVIDER_UNAVAILABLE: 'EXECUTOR_PROVIDER_UNAVAILABLE',
  RECONSTRUCTION_FAILED: 'EXECUTOR_RECONSTRUCTION_FAILED',
} as const;

export interface ImplementationAgentRegistryOptions {
  /** Provider used only when a run has no durable or legacy executor identity. */
  readonly defaultProvider: string;
  /** Provider that owns pre-executor-metadata `sessionId` runs. */
  readonly legacySessionProvider?: string;
  readonly providers: Readonly<Record<string, (execution?: ResolvedExecutionConfiguration) => ImplementationAgent>>;
}

/** Reconstructs the correct provider adapter from durable executor metadata. */
export class ImplementationAgentRegistry implements ImplementationAgent {
  readonly kind: 'implementation-agent' = 'implementation-agent';
  private readonly defaultProvider: string;
  private readonly legacySessionProvider: string | undefined;
  private readonly providers: Readonly<Record<string, (execution?: ResolvedExecutionConfiguration) => ImplementationAgent>>;

  constructor(options: ImplementationAgentRegistryOptions) {
    this.defaultProvider = options.defaultProvider;
    this.legacySessionProvider = options.legacySessionProvider;
    this.providers = options.providers;
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (request.governedPublication !== undefined && request.execution === undefined &&
        request.executor === undefined && request.sessionId === undefined) {
      return governedPublicationFailure(request, 'Governed invocation has no exact execution or session identity; a fresh default provider cannot be assumed.');
    }
    const selected = this.resolveAgent(request);
    if ('failure' in selected) return selected.failure;
    if (request.governedPublication !== undefined && !hasGovernedPublicationConfinement(selected.agent)) {
      return governedPublicationFailure(request, 'The selected adapter has no source-qualified host publication boundary.');
    }
    return await selected.agent.run(request);
  }

  prepareGovernedInvocation(request: ImplementationRequest): GovernedInvocationPreparation {
    if (request.governedPublication !== undefined && request.execution === undefined &&
        request.executor === undefined && request.sessionId === undefined) {
      return {
        status: 'held',
        reason: 'Governed invocation has no exact execution or session identity; a fresh default provider cannot be assumed.',
      };
    }
    const selected = this.resolveAgent(request);
    if ('failure' in selected) {
      return { status: 'held', reason: selected.failure.summary };
    }
    if (!hasGovernedPublicationConfinement(selected.agent)) {
      return { status: 'held', reason: 'The selected adapter has no source-qualified host publication boundary.' };
    }
    return {
      status: 'qualified',
      agent: selected.agent,
    };
  }

  private resolveAgent(request: ImplementationRequest): { readonly agent: ImplementationAgent } | { readonly failure: AgentResult } {
    const selectedProvider = request.execution?.executor;
    if (request.executor !== undefined && selectedProvider !== undefined && !isCompatibleExecutorProvider(request.executor.provider, selectedProvider)) {
      return { failure: routingFailure(
          EXECUTOR_ROUTING_ERROR_CODE.RECONSTRUCTION_FAILED,
          `Persisted executor provider "${request.executor.provider}" does not match selected execution executor "${selectedProvider}".`,
          request,
        ) };
    }
    const provider = request.executor?.provider ?? selectedProvider ?? (
      request.sessionId === undefined ? this.defaultProvider : this.legacySessionProvider
    );
    if (provider === undefined || provider.trim() === '' || this.providers[provider] === undefined) {
      const requested = provider ?? '(legacy session provider not configured)';
      return { failure: routingFailure(
          EXECUTOR_ROUTING_ERROR_CODE.PROVIDER_UNAVAILABLE,
          `Implementation executor provider "${requested}" is unavailable; continuity cannot be reconstructed.`,
          request,
        ) };
    }
    let agent: ImplementationAgent;
    try {
      if (request.execution !== undefined) assertExecutionSupportedByProvider(request.execution);
      agent = this.providers[provider](request.execution);
    } catch (error) {
      return { failure: routingFailure(
          EXECUTOR_ROUTING_ERROR_CODE.RECONSTRUCTION_FAILED,
          `Implementation executor provider "${provider}" could not be reconstructed: ${errorMessage(error)}`,
          request,
        ) };
    }
    return { agent };
  }
}

/** App Server is a capability-detected local transport for the Codex CLI profile. */
function isCompatibleExecutorProvider(persisted: string, selected: string): boolean {
  return persisted === selected || (persisted === 'codex-app-server' && selected === 'codex-cli');
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

function governedPublicationFailure(request: ImplementationRequest, detail: string): AgentResult {
  const summary = `Governed mutation is held because ${detail} No model turn or worker process was started. ${GOVERNED_PUBLICATION_REENTRY_ACTION}`;
  return {
    exitStatus: 'failure',
    summary,
    diagnostics: [`${GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED}: ${summary}`],
    ...(request.executor === undefined ? {} : { executor: request.executor }),
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    durationMs: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
