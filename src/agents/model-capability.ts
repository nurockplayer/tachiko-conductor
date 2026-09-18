/**
 * Provider-boundary model/reasoning-effort capability.
 *
 * This module owns the *provider-specific* knowledge about which reasoning
 * efforts a model accepts.  It never leaks into generic orchestration policy:
 * the orchestration core only sees the canonical `ExecutionReasoningEffort`
 * vocabulary and a typed preflight outcome.
 *
 * Preference order, per the #50 contract and the #28 prior-art note:
 *   1. the provider runtime's own authoritative catalog when it exposes one;
 *   2. otherwise a conservative, explicitly versioned local fallback.
 * The chosen source is always recorded so telemetry and review can tell a
 * stale-fallback defect apart from an authoritative provider rejection.
 */
import {
  CANONICAL_REASONING_EFFORTS,
  EXECUTION_CONFIGURATION_ERROR_CODE,
  ExecutionConfigurationError,
  type ExecutionConfigurationEvidence,
  type ExecutionReasoningEffort,
} from '../execution-profiles.js';

export const CAPABILITY_SOURCE = {
  RUNTIME_DISCOVERY: 'runtime-discovery',
  FALLBACK: 'fallback',
} as const;

export type CapabilitySource = (typeof CAPABILITY_SOURCE)[keyof typeof CAPABILITY_SOURCE];

export interface ModelCapabilityEntry {
  readonly model: string;
  /** Provider-reported values, which may include levels the Conductor cannot request. */
  readonly supportedReasoningEfforts: readonly string[];
}

export interface ModelCapabilityCatalog {
  readonly source: CapabilitySource;
  /** Stable identifier for local metadata; present whenever `source` is `fallback`. */
  readonly revision?: string;
  readonly models: readonly ModelCapabilityEntry[];
}

/** Bounded identifier so a stale fallback is diagnosable rather than anonymous. */
export const CODEX_CAPABILITY_FALLBACK_REVISION = 'codex-model-effort-fallback-v1';

/**
 * Conservative fallback for the Codex provider when the runtime cannot be
 * queried. It asserts only the canonical vocabulary and deliberately makes no
 * per-model claim, so it can never invent or downgrade a support decision.
 */
export function codexFallbackCapabilityCatalog(): ModelCapabilityCatalog {
  return { source: CAPABILITY_SOURCE.FALLBACK, revision: CODEX_CAPABILITY_FALLBACK_REVISION, models: [] };
}

/** Build an authoritative catalog from provider-reported model descriptors. */
export function runtimeCapabilityCatalog(
  models: readonly ModelCapabilityEntry[],
  revision?: string,
): ModelCapabilityCatalog {
  return {
    source: CAPABILITY_SOURCE.RUNTIME_DISCOVERY,
    ...(revision === undefined ? {} : { revision }),
    models,
  };
}

/** Ready-made reason a preflight could not positively assert the pair. */
export type UnverifiedReason =
  | 'no-effort-requested'
  | 'no-model-selected'
  | 'model-not-listed'
  | 'fallback-no-per-model-assertion';

/** Outcome of a successful preflight; never reports a substituted effort. */
export interface ModelEffortPreflightResult {
  readonly ok: true;
  readonly source: CapabilitySource;
  readonly revision?: string;
  readonly model?: string;
  /** True only when the exact model/effort pair was positively asserted. */
  readonly verified: boolean;
  /** Present exactly when `verified` is false, so telemetry can explain why. */
  readonly unverifiedReason?: UnverifiedReason;
  readonly reasoningEffort?: ExecutionReasoningEffort;
}

export interface ModelEffortPreflightRequest {
  readonly provider: string;
  readonly catalog: ModelCapabilityCatalog;
  readonly model?: string;
  readonly reasoningEffort?: ExecutionReasoningEffort;
}

const canonicalSet: ReadonlySet<string> = new Set(CANONICAL_REASONING_EFFORTS);

function findEntry(catalog: ModelCapabilityCatalog, model: string): ModelCapabilityEntry | undefined {
  const wanted = model.trim().toLowerCase();
  return catalog.models.find((entry) => entry.model.trim().toLowerCase() === wanted);
}

/**
 * Validate the requested model/effort pair *before* any model turn starts.
 *
 * It fails closed with a typed `ExecutionConfigurationError` only for a
 * positively-asserted incompatibility and never substitutes a weaker effort.
 * When the pair cannot be asserted (no model, an unlisted model, or local
 * fallback metadata that makes no per-model claim) it reports `verified: false`
 * with a bounded reason instead of guessing in either direction.
 */
export function preflightModelEffort(request: ModelEffortPreflightRequest): ModelEffortPreflightResult {
  const { provider, catalog, model, reasoningEffort } = request;
  const base: Pick<ModelEffortPreflightResult, 'source' | 'revision' | 'model'> = {
    source: catalog.source,
    ...(catalog.revision === undefined ? {} : { revision: catalog.revision }),
    ...(model === undefined ? {} : { model }),
  };
  // No requested effort means there is no pair to assert; the provider default applies.
  if (reasoningEffort === undefined) {
    return { ok: true, ...base, verified: false, unverifiedReason: 'no-effort-requested' };
  }
  // Without an explicit model the runtime chooses one, so no pair can be asserted.
  if (model === undefined || model.trim() === '') {
    return { ok: true, ...base, verified: false, unverifiedReason: 'no-model-selected', reasoningEffort };
  }

  const entry = findEntry(catalog, model);
  if (entry === undefined) {
    // A model the catalog does not enumerate is *not* asserted unsupported:
    // hidden models and provider-side aliases exist, so rejecting here would
    // create new avoidable failures. Only positive incompatibilities fail, and
    // the reason distinguishes authoritative omission from local fallback.
    return {
      ok: true,
      ...base,
      verified: false,
      unverifiedReason: catalog.source === CAPABILITY_SOURCE.FALLBACK ? 'fallback-no-per-model-assertion' : 'model-not-listed',
      reasoningEffort,
    };
  }

  const reported = entry.supportedReasoningEfforts;
  if (reported.includes(reasoningEffort)) {
    return { ok: true, ...base, verified: true, reasoningEffort };
  }

  const unrequestable = reported.filter((value) => !canonicalSet.has(value));
  const evidence: ExecutionConfigurationEvidence = {
    provider,
    model,
    requestedEffort: reasoningEffort,
    canonicalEffort: reasoningEffort,
    supportedEfforts: reported,
    capabilitySource: catalog.source,
    ...(catalog.revision === undefined ? {} : { capabilityRevision: catalog.revision }),
    ...(unrequestable.length === 0 ? {} : { unrequestableEfforts: unrequestable }),
  };
  throw new ExecutionConfigurationError(
    EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT,
    `Reasoning effort "${reasoningEffort}" is unsupported by ${provider} model "${model}"; ` +
      `the provider reports ${reported.length === 0 ? 'no supported efforts' : reported.join(', ')}. ` +
      'Refusing to start a model turn rather than silently changing the requested level.',
    evidence,
  );
}
