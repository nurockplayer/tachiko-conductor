import type {
  ProviderCapabilityTelemetry,
  ProviderContextTelemetry,
  ProviderExecutionTelemetry,
  ProviderFailureTelemetry,
  ProviderTokenUsage,
} from '../domain/telemetry.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = nonNegativeNumber(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Read a non-negative number from the first present nested details object. */
function nestedNumber(
  source: Record<string, unknown>,
  parentKeys: readonly string[],
  childKeys: readonly string[],
): number | undefined {
  for (const parentKey of parentKeys) {
    const parent = record(source[parentKey]);
    if (parent === undefined) continue;
    const value = firstNumber(parent, childKeys);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Parse provider-reported usage without retaining any raw provider payload. */
export function tokenUsageFromProviderValue(value: unknown): ProviderTokenUsage | undefined {
  const usage = record(value);
  if (usage === undefined) return undefined;
  const inputTokens = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  // DeepSeek chat completions reports cache hits at the top level and under prompt_tokens_details.
  const cachedInputTokens =
    firstNumber(usage, [
      'cached_input_tokens',
      'cachedInputTokens',
      'cache_read_input_tokens',
      'cacheReadInputTokens',
      'prompt_cache_hit_tokens',
      'promptCacheHitTokens',
    ]) ??
    nestedNumber(usage, ['prompt_tokens_details', 'promptTokensDetails'], ['cached_tokens', 'cachedTokens']);
  const outputTokens = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  // DeepSeek reports reasoning tokens under completion_tokens_details.
  const reasoningTokens =
    firstNumber(usage, [
      'reasoning_output_tokens',
      'reasoningOutputTokens',
      'reasoning_tokens',
      'reasoningTokens',
    ]) ??
    nestedNumber(
      usage,
      ['completion_tokens_details', 'completionTokensDetails'],
      ['reasoning_tokens', 'reasoningTokens'],
    );
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningTokens].every((item) => item === undefined)) {
    return undefined;
  }
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export function mergeTokenUsage(
  current: ProviderTokenUsage | undefined,
  next: ProviderTokenUsage | undefined,
): ProviderTokenUsage | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  const add = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined ? right : right === undefined ? left : left + right;
  const inputTokens = add(current.inputTokens, next.inputTokens);
  const cachedInputTokens = add(current.cachedInputTokens, next.cachedInputTokens);
  const outputTokens = add(current.outputTokens, next.outputTokens);
  const reasoningTokens = add(current.reasoningTokens, next.reasoningTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export function usageContextFromTokenUsage(usage: ProviderTokenUsage | undefined): ProviderContextTelemetry | undefined {
  if (usage?.inputTokens === undefined) return undefined;
  return { initialTokens: usage.inputTokens, peakTokens: usage.inputTokens };
}

/**
 * Estimate the serialized tool-result payload size without retaining it.
 * Agent messages are excluded because they are completion prose, not tool output.
 */
export function toolResultBytesFromItem(item: unknown): number | undefined {
  const value = record(item);
  if (value === undefined) return undefined;
  const type = value.type;
  if (type === 'agentMessage' || type === 'agent_message' || type === 'reasoning') return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

export function capabilityTelemetry(value: {
  readonly source?: unknown;
  readonly revision?: unknown;
  readonly verified?: unknown;
  readonly unverifiedReason?: unknown;
}): ProviderCapabilityTelemetry | undefined {
  if (typeof value.source !== 'string' || value.source.trim() === '') return undefined;
  return {
    source: value.source,
    ...(typeof value.revision === 'string' && value.revision.trim() !== '' ? { revision: value.revision } : {}),
    ...(typeof value.verified === 'boolean' ? { verified: value.verified } : {}),
    ...(typeof value.unverifiedReason === 'string' && value.unverifiedReason.trim() !== ''
      ? { unverifiedReason: value.unverifiedReason }
      : {}),
  };
}

export function providerTelemetry(input: {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly turns?: number;
  readonly usage?: ProviderTokenUsage | undefined;
  readonly capability?: ProviderCapabilityTelemetry | undefined;
  readonly failure?: ProviderFailureTelemetry | undefined;
  readonly context?: ProviderContextTelemetry | undefined;
  readonly largestToolResultBytes?: number | undefined;
}): ProviderExecutionTelemetry {
  return {
    provider: input.provider,
    ...(input.model === undefined || input.model.trim() === '' ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined || input.reasoningEffort.trim() === ''
      ? {}
      : { reasoningEffort: input.reasoningEffort }),
    ...(input.turns === undefined ? {} : { turns: input.turns }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.capability === undefined ? {} : { capability: input.capability }),
    ...(input.failure === undefined ? {} : { failure: input.failure }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.largestToolResultBytes === undefined ? {} : { largestToolResultBytes: input.largestToolResultBytes }),
  };
}

export function maximumBytes(current: number | undefined, candidate: number | undefined): number | undefined {
  if (candidate === undefined) return current;
  return current === undefined ? candidate : Math.max(current, candidate);
}
