/**
 * Durable, provider-neutral run efficiency telemetry.
 *
 * The event ledger is deliberately small and structured: it never contains raw
 * transcripts, model prose, hidden reasoning, tool output, or credentials.
 * Metrics and regression signals are projections over this ledger.
 */
import { EXECUTION_CONFIGURATION_ERROR_CODE } from '../execution-profiles.js';
import type { Run } from './types.js';

export const RUN_TELEMETRY_REVISION = 'run-efficiency-v1' as const;
export const RUN_TELEMETRY_THRESHOLD_REVISION = 'run-efficiency-thresholds-v1' as const;

export type MetricObservation<T> =
  | { readonly status: 'observed'; readonly value: T }
  | {
      readonly status: 'partial';
      readonly observedValue: T;
      readonly observedSamples: number;
      readonly totalSamples: number;
      readonly reason: string;
    }
  | { readonly status: 'unknown'; readonly reason: string };

export interface EfficiencyThresholds {
  readonly revision: string;
  /** Same-state, same-HEAD waits before a warning is emitted. */
  readonly repeatedUnchangedStateWakeups: number;
  /** Reviewer starts against one candidate HEAD before a warning is emitted. */
  readonly reviewerStartsAtSameHead: number;
  /** One provider tool-result payload at or above this size triggers a warning. */
  readonly largeToolResultBytes: number;
  /** Repeated configuration-preflight rejections before a warning is emitted. */
  readonly repeatedConfigurationPreflightFailures: number;
  /** Reviewer restarts before a warning is emitted. */
  readonly reviewerRestarts: number;
}

export const DEFAULT_EFFICIENCY_THRESHOLDS: EfficiencyThresholds = Object.freeze({
  revision: RUN_TELEMETRY_THRESHOLD_REVISION,
  repeatedUnchangedStateWakeups: 3,
  reviewerStartsAtSameHead: 2,
  largeToolResultBytes: 1_000_000,
  repeatedConfigurationPreflightFailures: 2,
  reviewerRestarts: 2,
});

export type TelemetryRole = 'worker' | 'reviewer';
export type SpawnAttemptKind = 'initial' | 'resume' | 'repair' | 'review' | 'review_restart';
export type SpawnContextMode = 'bounded' | 'full' | 'unknown';
export type SpawnContextJustification = 'live-target-bounded' | 'operator-full-override';
export type ProviderFailureCategory = 'configuration-preflight' | 'executed-runtime';
export type ProviderCompletionOutcome = 'completed' | 'failed' | 'configuration_preflight_failed';

export interface ProviderTokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface ProviderCapabilityTelemetry {
  readonly source: string;
  readonly revision?: string;
  readonly verified?: boolean;
  readonly unverifiedReason?: string;
}

export interface ProviderFailureTelemetry {
  readonly category: ProviderFailureCategory;
  readonly code: string;
}

export interface ProviderContextTelemetry {
  readonly initialTokens?: number;
  readonly peakTokens?: number;
}

export interface ProviderExecutionTelemetry {
  readonly provider: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  /** Provider-reported model turns for this invocation, when observable. */
  readonly turns?: number;
  readonly usage?: ProviderTokenUsage;
  readonly capability?: ProviderCapabilityTelemetry;
  readonly failure?: ProviderFailureTelemetry;
  readonly context?: ProviderContextTelemetry;
  /** Largest provider tool-result payload observed for this invocation, without content. */
  readonly largestToolResultBytes?: number;
}

export interface RunTelemetrySpawnEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: 'spawn';
  readonly role: TelemetryRole;
  readonly invocationId: string;
  readonly attempt: number;
  readonly attemptKind: SpawnAttemptKind;
  readonly headSha: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly profile: string | null;
  readonly contextMode: SpawnContextMode;
  readonly contextJustification: SpawnContextJustification | null;
}

export interface RunTelemetryCompletionEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: 'completion';
  readonly role: TelemetryRole;
  readonly invocationId: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly outcome: ProviderCompletionOutcome;
  readonly failureCode: string | null;
  readonly turns: MetricObservation<number>;
  readonly usage: {
    readonly inputTokens: MetricObservation<number>;
    readonly cachedInputTokens: MetricObservation<number>;
    readonly outputTokens: MetricObservation<number>;
    readonly reasoningTokens: MetricObservation<number>;
  };
  readonly capability: {
    readonly source: string;
    readonly revision: MetricObservation<string>;
    readonly verified: boolean | null;
    readonly unverifiedReason: string | null;
  } | null;
  readonly context: {
    readonly initialTokens: MetricObservation<number>;
    readonly peakTokens: MetricObservation<number>;
  };
  readonly largestToolResultBytes: MetricObservation<number>;
}

export interface RunTelemetryWaitEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: 'wait_status_wakeup';
  readonly state: string;
  readonly headSha: string | null;
}

export type RunTelemetryEvent = RunTelemetrySpawnEvent | RunTelemetryCompletionEvent | RunTelemetryWaitEvent;

export type RunTelemetryCoverage = 'complete' | 'partial';

export interface RunTelemetry {
  readonly revision: typeof RUN_TELEMETRY_REVISION;
  readonly coverage: RunTelemetryCoverage;
  readonly thresholds: EfficiencyThresholds;
  readonly events: readonly RunTelemetryEvent[];
}

export interface EfficiencySignal {
  readonly code:
    | 'repeated_unchanged_state_wakeups'
    | 'reviewer_restarted_before_head_convergence'
    | 'unjustified_full_context_spawn'
    | 'unusually_large_tool_result'
    | 'repeated_configuration_preflight_failure'
    | 'abnormal_reviewer_restart_count';
  readonly severity: 'warning';
  readonly message: string;
  readonly evidence: Readonly<Record<string, string | number | null>>;
}

export interface EfficiencyMetrics {
  readonly modelTurns: MetricObservation<number>;
  readonly inputTokens: MetricObservation<number>;
  readonly cachedInputTokens: MetricObservation<number>;
  readonly cachedInputPercent: MetricObservation<number>;
  readonly outputTokens: MetricObservation<number>;
  readonly reasoningTokens: MetricObservation<number>;
  readonly waitStatusWakeups: MetricObservation<number>;
  readonly workerStarts: MetricObservation<number>;
  readonly workerRestarts: MetricObservation<number>;
  readonly reviewerStarts: MetricObservation<number>;
  readonly reviewerRestarts: MetricObservation<number>;
  readonly configurationPreflightFailures: MetricObservation<number>;
  readonly executedModelFailures: MetricObservation<number>;
  readonly executedModelRetries: MetricObservation<number>;
  readonly spawnContextModes: {
    readonly bounded: number;
    readonly full: number;
    readonly unknown: number;
  } | null;
  readonly contextInitialTokens: MetricObservation<number>;
  readonly contextPeakTokens: MetricObservation<number>;
  readonly largestToolResultBytes: MetricObservation<number>;
  readonly validationDisposition: string;
  readonly reviewDisposition: string;
  readonly runDisposition: string;
}

export interface EfficiencyInvocation {
  readonly invocationId: string;
  readonly role: TelemetryRole;
  readonly attempt: number;
  readonly attemptKind: SpawnAttemptKind;
  readonly headSha: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly profile: string | null;
  readonly contextMode: SpawnContextMode;
  readonly contextJustification: SpawnContextJustification | null;
  readonly outcome: ProviderCompletionOutcome | null;
  readonly failureCode: string | null;
  readonly turns: MetricObservation<number> | null;
  readonly usage: RunTelemetryCompletionEvent['usage'] | null;
  readonly context: RunTelemetryCompletionEvent['context'] | null;
  readonly largestToolResultBytes: MetricObservation<number> | null;
  readonly capability: RunTelemetryCompletionEvent['capability'];
}

export interface RunEfficiencyProjection {
  readonly schemaRevision: typeof RUN_TELEMETRY_REVISION;
  readonly recorded: boolean;
  readonly coverage: RunTelemetryCoverage;
  readonly invocations: readonly EfficiencyInvocation[];
  readonly metrics: EfficiencyMetrics;
  readonly signals: readonly EfficiencySignal[];
  /** Compact human-readable lines; structured metrics remain authoritative. */
  readonly summary: readonly string[];
}

export interface SpawnTelemetryInput {
  readonly role: TelemetryRole;
  readonly attemptKind: SpawnAttemptKind;
  readonly headSha?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly profile?: string;
  readonly contextMode?: SpawnContextMode;
  readonly contextJustification?: SpawnContextJustification;
}

export interface CompletionTelemetryInput {
  readonly role: TelemetryRole;
  readonly invocationId: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly outcome: ProviderCompletionOutcome;
  readonly failureCode?: string;
  readonly turns?: number;
  readonly usage?: ProviderTokenUsage;
  readonly capability?: ProviderCapabilityTelemetry;
  readonly context?: ProviderContextTelemetry;
  readonly largestToolResultBytes?: number;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function observedMetric<T>(value: T): MetricObservation<T> {
  return { status: 'observed', value };
}

export function unknownMetric<T>(reason: string): MetricObservation<T> {
  return { status: 'unknown', reason };
}

function partialMetric<T>(
  observedValue: T,
  observedSamples: number,
  totalSamples: number,
  reason: string,
): MetricObservation<T> {
  return { status: 'partial', observedValue, observedSamples, totalSamples, reason };
}

function numericMetric(value: unknown, reason: string): MetricObservation<number> {
  return finiteNonNegative(value) ? observedMetric(value) : unknownMetric(reason);
}

function stringMetric(value: unknown, reason: string): MetricObservation<string> {
  return nonEmpty(value) ? observedMetric(value.trim()) : unknownMetric(reason);
}

function cloneThresholds(value: EfficiencyThresholds): EfficiencyThresholds {
  return {
    revision: value.revision,
    repeatedUnchangedStateWakeups: value.repeatedUnchangedStateWakeups,
    reviewerStartsAtSameHead: value.reviewerStartsAtSameHead,
    largeToolResultBytes: value.largeToolResultBytes,
    repeatedConfigurationPreflightFailures: value.repeatedConfigurationPreflightFailures,
    reviewerRestarts: value.reviewerRestarts,
  };
}

function assertThresholds(value: EfficiencyThresholds): void {
  if (!nonEmpty(value.revision) ||
      value.repeatedUnchangedStateWakeups < 1 ||
      value.reviewerStartsAtSameHead < 1 ||
      value.largeToolResultBytes < 1 ||
      value.repeatedConfigurationPreflightFailures < 1 ||
      value.reviewerRestarts < 1) {
    throw new Error('Efficiency thresholds require a non-empty revision and positive safe-integer limits.');
  }
}

export function createRunTelemetry(
  overrides: Partial<Omit<EfficiencyThresholds, 'revision'>> & { readonly revision?: string } = {},
): RunTelemetry {
  const thresholds: EfficiencyThresholds = {
    ...cloneThresholds(DEFAULT_EFFICIENCY_THRESHOLDS),
    ...overrides,
  };
  assertThresholds(thresholds);
  return { revision: RUN_TELEMETRY_REVISION, coverage: 'complete', thresholds, events: [] };
}

export function withRunTelemetryThresholds(
  run: Run,
  overrides: Partial<Omit<EfficiencyThresholds, 'revision'>> & { readonly revision?: string } = {},
): Run {
  if (run.telemetry === undefined) {
    return { ...run, telemetry: { ...createRunTelemetry(overrides), coverage: 'partial' } };
  }
  const thresholds: EfficiencyThresholds = {
    ...cloneThresholds(run.telemetry.thresholds),
    ...overrides,
  };
  assertThresholds(thresholds);
  return { ...run, telemetry: { ...run.telemetry, thresholds, events: run.telemetry.events } };
}

export function appendRunTelemetryEvents(run: Run, events: readonly RunTelemetryEvent[]): Run {
  if (events.length === 0 && run.telemetry !== undefined) return run;
  const existing = run.telemetry ?? { ...createRunTelemetry(), coverage: 'partial' as const };
  const byId = new Set(existing.events.map((event) => event.id));
  const additions = events.filter((event) => {
    if (byId.has(event.id)) return false;
    byId.add(event.id);
    return true;
  });
  if (additions.length === 0 && run.telemetry !== undefined) return run;
  return { ...run, telemetry: { ...existing, events: [...existing.events, ...additions] } };
}

function completionExists(run: Run, invocationId: string): boolean {
  return run.telemetry?.events.some((event) => event.kind === 'completion' && event.invocationId === invocationId) ?? false;
}

export function recordSpawnTelemetry(
  run: Run,
  input: SpawnTelemetryInput,
  at: string,
): { readonly run: Run; readonly invocationId: string; readonly reused: boolean } {
  const headSha = input.headSha?.trim() === '' ? undefined : input.headSha?.trim();
  const sameScope = (run.telemetry?.events ?? []).filter(
    (event): event is RunTelemetrySpawnEvent =>
      event.kind === 'spawn' && event.role === input.role && event.headSha === (headSha ?? null),
  );
  const unfinished = sameScope.find((event) => !completionExists(run, event.invocationId));
  if (unfinished !== undefined) {
    return { run, invocationId: unfinished.invocationId, reused: true };
  }
  const attempt = sameScope.length + 1;
  const invocationId = `spawn:${run.id}:${input.role}:${headSha ?? 'no-head'}:${attempt}`;
  const event: RunTelemetrySpawnEvent = {
    id: invocationId,
    at,
    kind: 'spawn',
    role: input.role,
    invocationId,
    attempt,
    attemptKind: input.attemptKind,
    headSha: headSha ?? null,
    provider: nonEmpty(input.provider) ? input.provider.trim() : null,
    model: nonEmpty(input.model) ? input.model.trim() : null,
    reasoningEffort: nonEmpty(input.reasoningEffort) ? input.reasoningEffort.trim() : null,
    profile: nonEmpty(input.profile) ? input.profile.trim() : null,
    contextMode: input.contextMode ?? 'unknown',
    contextJustification: input.contextJustification ?? null,
  };
  return { run: appendRunTelemetryEvents(run, [event]), invocationId, reused: false };
}

export function recordCompletionTelemetry(run: Run, input: CompletionTelemetryInput, at: string): Run {
  const event: RunTelemetryCompletionEvent = {
    id: `completion:${input.invocationId}`,
    at,
    kind: 'completion',
    role: input.role,
    invocationId: input.invocationId,
    provider: nonEmpty(input.provider) ? input.provider.trim() : null,
    model: nonEmpty(input.model) ? input.model.trim() : null,
    reasoningEffort: nonEmpty(input.reasoningEffort) ? input.reasoningEffort.trim() : null,
    outcome: input.outcome,
    failureCode: input.failureCode?.trim() === '' ? null : input.failureCode?.trim() ?? null,
    turns: numericMetric(input.turns, 'provider-did-not-report-turn-count'),
    usage: {
      inputTokens: numericMetric(input.usage?.inputTokens, 'provider-did-not-report-input-tokens'),
      cachedInputTokens: numericMetric(input.usage?.cachedInputTokens, 'provider-did-not-report-cached-input-tokens'),
      outputTokens: numericMetric(input.usage?.outputTokens, 'provider-did-not-report-output-tokens'),
      reasoningTokens: numericMetric(input.usage?.reasoningTokens, 'provider-did-not-report-reasoning-tokens'),
    },
    capability: input.capability === undefined
      ? null
      : {
          source: input.capability.source,
          revision: stringMetric(input.capability.revision, 'capability-revision-not-reported'),
          verified: input.capability.verified ?? null,
          unverifiedReason: nonEmpty(input.capability.unverifiedReason) ? input.capability.unverifiedReason.trim() : null,
        },
    context: {
      initialTokens: numericMetric(input.context?.initialTokens, 'context-size-not-observed'),
      peakTokens: numericMetric(input.context?.peakTokens, 'context-size-not-observed'),
    },
    largestToolResultBytes: numericMetric(input.largestToolResultBytes, 'tool-result-size-not-observed'),
  };
  return appendRunTelemetryEvents(run, [event]);
}

export function recordWaitTelemetry(run: Run, at: string): Run {
  if (run.state !== 'WAITING_DEPENDENCY') return run;
  const event: RunTelemetryWaitEvent = {
    id: `wait:${run.id}:${run.history.length}:${run.state}`,
    at,
    kind: 'wait_status_wakeup',
    state: run.state,
    headSha: run.headSha ?? null,
  };
  return appendRunTelemetryEvents(run, [event]);
}

function observedCount(count: number): MetricObservation<number> {
  return observedMetric(count);
}

function aggregateNumbers(
  observations: readonly MetricObservation<number>[],
  noSamplesReason: string,
): MetricObservation<number> {
  if (observations.length === 0) return unknownMetric(noSamplesReason);
  let total = 0;
  let observedSamples = 0;
  for (const observation of observations) {
    if (observation.status === 'observed') {
      total += observation.value;
      observedSamples += 1;
    } else if (observation.status === 'partial') {
      total += observation.observedValue;
      observedSamples += 1;
    }
  }
  if (observedSamples === 0) return unknownMetric(noSamplesReason);
  if (observedSamples === observations.length) return observedMetric(total);
  return partialMetric(total, observedSamples, observations.length, 'some-provider-usage-is-missing');
}

function aggregateMax(
  observations: readonly MetricObservation<number>[],
  noSamplesReason: string,
  partialReason: string,
): MetricObservation<number> {
  if (observations.length === 0) return unknownMetric(noSamplesReason);
  const values: number[] = [];
  for (const observation of observations) {
    if (observation.status === 'observed') values.push(observation.value);
    else if (observation.status === 'partial') values.push(observation.observedValue);
  }
  if (values.length === 0) return unknownMetric(noSamplesReason);
  const value = Math.max(...values);
  if (values.length === observations.length) return observedMetric(value);
  return partialMetric(value, values.length, observations.length, partialReason);
}

function firstObserved(
  observations: readonly MetricObservation<number>[],
  noSamplesReason: string,
): MetricObservation<number> {
  if (observations.length === 0) return unknownMetric(noSamplesReason);
  const first = observations[0]!;
  if (first.status === 'observed') return first;
  if (first.status === 'partial') {
    return partialMetric(first.observedValue, first.observedSamples, first.totalSamples, first.reason);
  }
  return unknownMetric(noSamplesReason);
}

function countSpawn(
  events: readonly RunTelemetryEvent[],
  role: TelemetryRole,
  restartsOnly: boolean,
): number {
  return events.filter(
    (event): event is RunTelemetrySpawnEvent =>
      event.kind === 'spawn' &&
      event.role === role &&
      (!restartsOnly || event.attempt > 1 || event.attemptKind === 'resume' || event.attemptKind === 'repair' || event.attemptKind === 'review_restart'),
  ).length;
}

function countExecutedRetries(events: readonly RunTelemetryEvent[]): number {
  let retries = 0;
  const priorByRoleHead = new Map<string, 'executed' | 'configuration-preflight' | null>();
  for (const event of events) {
    if (event.kind === 'spawn') {
      const key = `${event.role}:${event.headSha ?? 'no-head'}`;
      const prior = priorByRoleHead.get(key);
      if (event.attempt > 1 && prior === 'executed') retries += 1;
      continue;
    }
    if (event.kind !== 'completion') continue;
    const spawn = events.find(
      (candidate): candidate is RunTelemetrySpawnEvent =>
        candidate.kind === 'spawn' && candidate.invocationId === event.invocationId,
    );
    if (spawn === undefined) continue;
    const key = `${spawn.role}:${spawn.headSha ?? 'no-head'}`;
    priorByRoleHead.set(
      key,
      event.outcome === 'failed'
        ? 'executed'
        : event.outcome === 'configuration_preflight_failed'
          ? 'configuration-preflight'
          : null,
    );
  }
  return retries;
}

function percentage(input: MetricObservation<number>, cached: MetricObservation<number>): MetricObservation<number> {
  if (input.status !== 'observed' || cached.status !== 'observed' || input.value <= 0) {
    return unknownMetric('cached-input-percentage-requires-observed-input-and-cached-totals');
  }
  if (cached.value > input.value) return unknownMetric('cached-input-exceeds-input-total');
  return observedMetric((cached.value / input.value) * 100);
}

function metricText(value: MetricObservation<number>, formatter: (value: number) => string = String): string {
  if (value.status === 'observed') return formatter(value.value);
  if (value.status === 'partial') return `${formatter(value.observedValue)} partial (${value.observedSamples}/${value.totalSamples})`;
  return 'unknown';
}

export function projectRunEfficiency(run: Run): RunEfficiencyProjection {
  if (run.telemetry === undefined) {
    const unknown = (reason: string): MetricObservation<number> => unknownMetric(reason);
    const metrics: EfficiencyMetrics = {
      modelTurns: unknown('telemetry-not-recorded'),
      inputTokens: unknown('telemetry-not-recorded'),
      cachedInputTokens: unknown('telemetry-not-recorded'),
      cachedInputPercent: unknown('telemetry-not-recorded'),
      outputTokens: unknown('telemetry-not-recorded'),
      reasoningTokens: unknown('telemetry-not-recorded'),
      waitStatusWakeups: unknown('telemetry-not-recorded'),
      workerStarts: unknown('telemetry-not-recorded'),
      workerRestarts: unknown('telemetry-not-recorded'),
      reviewerStarts: unknown('telemetry-not-recorded'),
      reviewerRestarts: unknown('telemetry-not-recorded'),
      configurationPreflightFailures: unknown('telemetry-not-recorded'),
      executedModelFailures: unknown('telemetry-not-recorded'),
      executedModelRetries: unknown('telemetry-not-recorded'),
      spawnContextModes: null,
      contextInitialTokens: unknown('telemetry-not-recorded'),
      contextPeakTokens: unknown('telemetry-not-recorded'),
      largestToolResultBytes: unknown('telemetry-not-recorded'),
      validationDisposition: run.validationResult?.status ?? 'unknown',
      reviewDisposition: run.reviewResult?.verdict ?? 'unknown',
      runDisposition: run.state,
    };
    return {
      schemaRevision: RUN_TELEMETRY_REVISION,
      recorded: false,
      coverage: 'partial',
      invocations: [],
      metrics,
      signals: [],
      summary: formatEfficiencySummary(metrics),
    };
  }

  const events = run.telemetry.events;
  const completions = events.filter((event): event is RunTelemetryCompletionEvent => event.kind === 'completion');
  const allCompletions = completions;
  const turns = allCompletions.map((event) => event.turns);
  const inputTokens = allCompletions.map((event) => event.usage.inputTokens);
  const cachedInputTokens = allCompletions.map((event) => event.usage.cachedInputTokens);
  const outputTokens = allCompletions.map((event) => event.usage.outputTokens);
  const reasoningTokens = allCompletions.map((event) => event.usage.reasoningTokens);
  const contextInitial = allCompletions.map((event) => event.context.initialTokens);
  const contextPeak = allCompletions.map((event) => event.context.peakTokens);
  const toolResult = allCompletions.map((event) => event.largestToolResultBytes);
  const spawnContextModes = {
    bounded: events.filter((event) => event.kind === 'spawn' && event.contextMode === 'bounded').length,
    full: events.filter((event) => event.kind === 'spawn' && event.contextMode === 'full').length,
    unknown: events.filter((event) => event.kind === 'spawn' && event.contextMode === 'unknown').length,
  };
  const metrics: EfficiencyMetrics = {
    modelTurns: aggregateNumbers(turns, 'no-provider-turn-observations'),
    inputTokens: aggregateNumbers(inputTokens, 'no-provider-input-token-observations'),
    cachedInputTokens: aggregateNumbers(cachedInputTokens, 'no-provider-cached-input-token-observations'),
    cachedInputPercent: percentage(
      aggregateNumbers(inputTokens, 'no-provider-input-token-observations'),
      aggregateNumbers(cachedInputTokens, 'no-provider-cached-input-token-observations'),
    ),
    outputTokens: aggregateNumbers(outputTokens, 'no-provider-output-token-observations'),
    reasoningTokens: aggregateNumbers(reasoningTokens, 'no-provider-reasoning-token-observations'),
    waitStatusWakeups: observedCount(events.filter((event) => event.kind === 'wait_status_wakeup').length),
    workerStarts: observedCount(countSpawn(events, 'worker', false)),
    workerRestarts: observedCount(countSpawn(events, 'worker', true)),
    reviewerStarts: observedCount(countSpawn(events, 'reviewer', false)),
    reviewerRestarts: observedCount(countSpawn(events, 'reviewer', true)),
    configurationPreflightFailures: observedCount(completions.filter((event) => event.outcome === 'configuration_preflight_failed').length),
    executedModelFailures: observedCount(completions.filter((event) => event.outcome === 'failed').length),
    executedModelRetries: observedCount(countExecutedRetries(events)),
    spawnContextModes,
    contextInitialTokens: firstObserved(contextInitial, 'no-provider-context-observations'),
    contextPeakTokens: aggregateMax(contextPeak, 'no-provider-context-observations', 'some-provider-context-is-missing'),
    largestToolResultBytes: aggregateMax(toolResult, 'no-provider-tool-result-observations', 'some-provider-tool-result-observations-missing'),
    validationDisposition: run.validationResult?.status ?? 'unknown',
    reviewDisposition: run.reviewResult?.verdict ?? 'unknown',
    runDisposition: run.state,
  };
  const coverageAwareMetrics = run.telemetry.coverage === 'partial'
    ? withPartialCoverage(metrics)
    : metrics;
  const signals = evaluateEfficiencySignals(run.telemetry, coverageAwareMetrics);
  return {
    schemaRevision: RUN_TELEMETRY_REVISION,
    recorded: true,
    coverage: run.telemetry.coverage,
    invocations: projectInvocations(events),
    metrics: coverageAwareMetrics,
    signals,
    summary: formatEfficiencySummary(coverageAwareMetrics),
  };
}

function withPartialCoverage(metrics: EfficiencyMetrics): EfficiencyMetrics {
  const reason = 'telemetry-started-mid-run';
  const unknown = <T>(): MetricObservation<T> => unknownMetric(reason);
  return {
    ...metrics,
    modelTurns: unknown(),
    inputTokens: unknown(),
    cachedInputTokens: unknown(),
    cachedInputPercent: unknown(),
    outputTokens: unknown(),
    reasoningTokens: unknown(),
    waitStatusWakeups: unknown(),
    workerStarts: unknown(),
    workerRestarts: unknown(),
    reviewerStarts: unknown(),
    reviewerRestarts: unknown(),
    configurationPreflightFailures: unknown(),
    executedModelFailures: unknown(),
    executedModelRetries: unknown(),
    spawnContextModes: null,
    contextInitialTokens: unknown(),
    contextPeakTokens: unknown(),
    largestToolResultBytes: unknown(),
  };
}

function projectInvocations(events: readonly RunTelemetryEvent[]): readonly EfficiencyInvocation[] {
  const completions = new Map(
    events
      .filter((event): event is RunTelemetryCompletionEvent => event.kind === 'completion')
      .map((event) => [event.invocationId, event] as const),
  );
  return events
    .filter((event): event is RunTelemetrySpawnEvent => event.kind === 'spawn')
    .map((spawn) => {
      const completion = completions.get(spawn.invocationId);
      return {
        invocationId: spawn.invocationId,
        role: spawn.role,
        attempt: spawn.attempt,
        attemptKind: spawn.attemptKind,
        headSha: spawn.headSha,
        provider: completion?.provider ?? spawn.provider,
        model: completion?.model ?? spawn.model,
        reasoningEffort: completion?.reasoningEffort ?? spawn.reasoningEffort,
        profile: spawn.profile,
        contextMode: spawn.contextMode,
        contextJustification: spawn.contextJustification,
        outcome: completion?.outcome ?? null,
        failureCode: completion?.failureCode ?? null,
        turns: completion?.turns ?? null,
        usage: completion?.usage ?? null,
        context: completion?.context ?? null,
        largestToolResultBytes: completion?.largestToolResultBytes ?? null,
        capability: completion?.capability ?? null,
      };
    });
}

export function evaluateEfficiencySignals(
  telemetry: RunTelemetry,
  metrics: EfficiencyMetrics = projectMetricsWithoutSignals(telemetry),
): readonly EfficiencySignal[] {
  const thresholds = telemetry.thresholds;
  const signals: EfficiencySignal[] = [];
  const waits = telemetry.events.filter(
    (event): event is RunTelemetryWaitEvent => event.kind === 'wait_status_wakeup',
  );
  const waitCounts = new Map<string, number>();
  for (const wait of waits) {
    const key = `${wait.state}:${wait.headSha ?? 'no-head'}`;
    waitCounts.set(key, (waitCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of waitCounts) {
    if (count >= thresholds.repeatedUnchangedStateWakeups) {
      signals.push({
        code: 'repeated_unchanged_state_wakeups',
        severity: 'warning',
        message: `Repeated unchanged-state wakeups for ${key} (${count} >= ${thresholds.repeatedUnchangedStateWakeups}).`,
        evidence: { stateHead: key, count, threshold: thresholds.repeatedUnchangedStateWakeups },
      });
    }
  }

  const reviewerStarts = new Map<string, number>();
  const reviewerRestarts = metrics.reviewerRestarts.status === 'observed' ? metrics.reviewerRestarts.value : 0;
  for (const event of telemetry.events) {
    if (event.kind !== 'spawn' || event.role !== 'reviewer') continue;
    const key = event.headSha ?? 'no-head';
    reviewerStarts.set(key, (reviewerStarts.get(key) ?? 0) + 1);
  }
  for (const [headSha, count] of reviewerStarts) {
    if (count >= thresholds.reviewerStartsAtSameHead) {
      signals.push({
        code: 'reviewer_restarted_before_head_convergence',
        severity: 'warning',
        message: `Reviewer started ${count} times for unchanged HEAD ${headSha} (threshold ${thresholds.reviewerStartsAtSameHead}).`,
        evidence: { headSha, starts: count, threshold: thresholds.reviewerStartsAtSameHead },
      });
    }
  }

  for (const event of telemetry.events) {
    if (event.kind !== 'spawn' || event.contextMode !== 'full' || event.contextJustification === 'operator-full-override') continue;
    signals.push({
      code: 'unjustified_full_context_spawn',
      severity: 'warning',
      message: `Full-context spawn ${event.invocationId} has no durable operator override.`,
      evidence: { invocationId: event.invocationId, role: event.role, headSha: event.headSha },
    });
  }

  for (const event of telemetry.events) {
    if (event.kind !== 'completion' || event.largestToolResultBytes.status !== 'observed') continue;
    if (event.largestToolResultBytes.value >= thresholds.largeToolResultBytes) {
      signals.push({
        code: 'unusually_large_tool_result',
        severity: 'warning',
        message: `Tool-result payload ${event.largestToolResultBytes.value} bytes reached the configured large-result threshold.`,
        evidence: {
          invocationId: event.invocationId,
          bytes: event.largestToolResultBytes.value,
          threshold: thresholds.largeToolResultBytes,
        },
      });
    }
  }

  if (metrics.configurationPreflightFailures.status === 'observed' &&
      metrics.configurationPreflightFailures.value >= thresholds.repeatedConfigurationPreflightFailures) {
    signals.push({
      code: 'repeated_configuration_preflight_failure',
      severity: 'warning',
      message: `Configuration preflight failed ${metrics.configurationPreflightFailures.value} times (threshold ${thresholds.repeatedConfigurationPreflightFailures}).`,
      evidence: {
        failures: metrics.configurationPreflightFailures.value,
        threshold: thresholds.repeatedConfigurationPreflightFailures,
      },
    });
  }
  if (reviewerRestarts >= thresholds.reviewerRestarts) {
    signals.push({
      code: 'abnormal_reviewer_restart_count',
      severity: 'warning',
      message: `Reviewer restarted ${reviewerRestarts} times (threshold ${thresholds.reviewerRestarts}).`,
      evidence: { restarts: reviewerRestarts, threshold: thresholds.reviewerRestarts },
    });
  }
  return signals;
}

function projectMetricsWithoutSignals(telemetry: RunTelemetry): EfficiencyMetrics {
  const runLike: Run = {
    id: 'projection',
    target: { kind: 'repository', owner: 'local', repo: 'projection', branch: 'main' },
    state: 'READY',
    createdAt: '',
    updatedAt: '',
    history: [],
    telemetry,
  };
  return projectRunEfficiency(runLike).metrics;
}

export function formatEfficiencySummary(metrics: EfficiencyMetrics): readonly string[] {
  const tokens = (value: number): string => value.toLocaleString('en-US');
  const contextModes = metrics.spawnContextModes === null
    ? 'unknown'
    : `bounded=${metrics.spawnContextModes.bounded}, full=${metrics.spawnContextModes.full}, unknown=${metrics.spawnContextModes.unknown}`;
  return [
    `model turns          ${metricText(metrics.modelTurns)}`,
    `input tokens         ${metricText(metrics.inputTokens, tokens)}`,
    `cached input         ${metricText(metrics.cachedInputTokens, tokens)} (${metricText(metrics.cachedInputPercent, (value) => `${value.toFixed(1)}%`)})`,
    `output tokens        ${metricText(metrics.outputTokens, tokens)}`,
    `wait/status turns    ${metricText(metrics.waitStatusWakeups)}`,
    `worker starts        ${metricText(metrics.workerStarts)}`,
    `worker restarts      ${metricText(metrics.workerRestarts)}`,
    `review starts        ${metricText(metrics.reviewerStarts)}`,
    `review restarts      ${metricText(metrics.reviewerRestarts)}`,
    `largest tool output  ${metricText(metrics.largestToolResultBytes, tokens)} bytes`,
    `context peak         ${metricText(metrics.contextPeakTokens, tokens)}`,
    `spawn context        ${contextModes}`,
    `validation outcome   ${metrics.validationDisposition}`,
    `review outcome       ${metrics.reviewDisposition}`,
  ];
}

export function createCompletionInputFromResult(
  result: {
    readonly exitStatus: 'success' | 'failure';
    readonly summary?: string;
    readonly diagnostics?: readonly string[];
    readonly telemetry?: ProviderExecutionTelemetry;
  },
  fallback: {
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
  },
  role: TelemetryRole,
  invocationId: string,
): CompletionTelemetryInput {
  const telemetry = result.telemetry;
  const failureCode = telemetry?.failure?.code ?? firstDiagnosticCode(result.diagnostics);
  const outcome: ProviderCompletionOutcome = result.exitStatus === 'success'
    ? 'completed'
    : telemetry?.failure?.category === 'configuration-preflight' ||
        isConfigurationDiagnostic(failureCode)
      ? 'configuration_preflight_failed'
      : 'failed';
  return {
    role,
    invocationId,
    outcome,
    ...(telemetry?.provider === undefined && fallback.provider === undefined ? {} : { provider: telemetry?.provider ?? fallback.provider }),
    ...(telemetry?.model === undefined && fallback.model === undefined ? {} : { model: telemetry?.model ?? fallback.model }),
    ...(telemetry?.reasoningEffort === undefined && fallback.reasoningEffort === undefined ? {} : { reasoningEffort: telemetry?.reasoningEffort ?? fallback.reasoningEffort }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(telemetry?.turns === undefined ? (outcome === 'configuration_preflight_failed' ? { turns: 0 } : {}) : { turns: telemetry.turns }),
    ...(telemetry?.usage === undefined ? {} : { usage: telemetry.usage }),
    ...(telemetry?.capability === undefined ? {} : { capability: telemetry.capability }),
    ...(telemetry?.context === undefined ? {} : { context: telemetry.context }),
    ...(telemetry?.largestToolResultBytes === undefined ? {} : { largestToolResultBytes: telemetry.largestToolResultBytes }),
  };
}

function firstDiagnosticCode(diagnostics: readonly string[] | undefined): string | undefined {
  const first = diagnostics?.[0];
  if (first === undefined) return undefined;
  const index = first.indexOf(':');
  return (index === -1 ? first : first.slice(0, index)).trim();
}

function isConfigurationDiagnostic(value: string | undefined): boolean {
  return value?.startsWith(EXECUTION_CONFIGURATION_ERROR_CODE.INVALID_REASONING_EFFORT) === true ||
    value?.startsWith(EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT) === true;
}

export function isMetricObservation(value: unknown, item: (value: unknown) => boolean): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.status === 'observed') return item(record.value);
  if (record.status === 'partial') {
    return item(record.observedValue) &&
      Number.isSafeInteger(record.observedSamples) &&
      Number.isSafeInteger(record.totalSamples) &&
      (record.observedSamples as number) >= 0 &&
      (record.totalSamples as number) >= (record.observedSamples as number) &&
      typeof record.reason === 'string' && record.reason.trim() !== '';
  }
  return record.status === 'unknown' && typeof record.reason === 'string' && record.reason.trim() !== '';
}

export function isProviderExecutionTelemetry(value: unknown): value is ProviderExecutionTelemetry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!nonEmpty(record.provider)) return false;
  if (record.model !== undefined && !nonEmpty(record.model)) return false;
  if (record.reasoningEffort !== undefined && !nonEmpty(record.reasoningEffort)) return false;
  if (record.turns !== undefined && !finiteNonNegative(record.turns)) return false;
  if (record.largestToolResultBytes !== undefined && !finiteNonNegative(record.largestToolResultBytes)) return false;
  if (record.usage !== undefined) {
    if (typeof record.usage !== 'object' || record.usage === null) return false;
    const usage = record.usage as Record<string, unknown>;
    if (Object.values(usage).some((item) => item !== undefined && !finiteNonNegative(item))) return false;
  }
  if (record.capability !== undefined) {
    if (typeof record.capability !== 'object' || record.capability === null) return false;
    const capability = record.capability as Record<string, unknown>;
    if (!nonEmpty(capability.source)) return false;
    if (capability.revision !== undefined && !nonEmpty(capability.revision)) return false;
    if (capability.verified !== undefined && typeof capability.verified !== 'boolean') return false;
    if (capability.unverifiedReason !== undefined && !nonEmpty(capability.unverifiedReason)) return false;
  }
  if (record.failure !== undefined) {
    if (typeof record.failure !== 'object' || record.failure === null) return false;
    const failure = record.failure as Record<string, unknown>;
    if (failure.category !== 'configuration-preflight' && failure.category !== 'executed-runtime') return false;
    if (!nonEmpty(failure.code)) return false;
  }
  if (record.context !== undefined) {
    if (typeof record.context !== 'object' || record.context === null) return false;
    const context = record.context as Record<string, unknown>;
    if (context.initialTokens !== undefined && !finiteNonNegative(context.initialTokens)) return false;
    if (context.peakTokens !== undefined && !finiteNonNegative(context.peakTokens)) return false;
  }
  return true;
}

export function isRunTelemetry(value: unknown): value is RunTelemetry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.revision !== RUN_TELEMETRY_REVISION ||
      (record.coverage !== 'complete' && record.coverage !== 'partial') ||
      !Array.isArray(record.events)) return false;
  if (typeof record.thresholds !== 'object' || record.thresholds === null) return false;
  const thresholds = record.thresholds as Record<string, unknown>;
  if (!nonEmpty(thresholds.revision) ||
      !Number.isSafeInteger(thresholds.repeatedUnchangedStateWakeups) || (thresholds.repeatedUnchangedStateWakeups as number) < 1 ||
      !Number.isSafeInteger(thresholds.reviewerStartsAtSameHead) || (thresholds.reviewerStartsAtSameHead as number) < 1 ||
      !Number.isSafeInteger(thresholds.largeToolResultBytes) || (thresholds.largeToolResultBytes as number) < 1 ||
      !Number.isSafeInteger(thresholds.repeatedConfigurationPreflightFailures) || (thresholds.repeatedConfigurationPreflightFailures as number) < 1 ||
      !Number.isSafeInteger(thresholds.reviewerRestarts) || (thresholds.reviewerRestarts as number) < 1) {
    return false;
  }
  return record.events.every((event) => isRunTelemetryEvent(event));
}

function isRunTelemetryEvent(value: unknown): value is RunTelemetryEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  if (!nonEmpty(event.id) || !nonEmpty(event.at) || !nonEmpty(event.kind)) return false;
  if (event.kind === 'spawn') {
    return (event.role === 'worker' || event.role === 'reviewer') &&
      nonEmpty(event.invocationId) &&
      Number.isSafeInteger(event.attempt) && (event.attempt as number) >= 1 &&
      ['initial', 'resume', 'repair', 'review', 'review_restart'].includes(event.attemptKind as string) &&
      (event.headSha === null || nonEmpty(event.headSha)) &&
      (event.provider === null || nonEmpty(event.provider)) &&
      (event.model === null || nonEmpty(event.model)) &&
      (event.reasoningEffort === null || nonEmpty(event.reasoningEffort)) &&
      (event.profile === null || nonEmpty(event.profile)) &&
      (event.contextMode === 'bounded' || event.contextMode === 'full' || event.contextMode === 'unknown') &&
      (event.contextJustification === null || event.contextJustification === 'live-target-bounded' || event.contextJustification === 'operator-full-override');
  }
  if (event.kind === 'wait_status_wakeup') {
    return nonEmpty(event.state) && (event.headSha === null || nonEmpty(event.headSha));
  }
  if (event.kind === 'completion') {
    if ((event.role !== 'worker' && event.role !== 'reviewer') || !nonEmpty(event.invocationId) ||
        (event.provider !== null && !nonEmpty(event.provider)) ||
        (event.model !== null && !nonEmpty(event.model)) ||
        (event.reasoningEffort !== null && !nonEmpty(event.reasoningEffort)) ||
        !['completed', 'failed', 'configuration_preflight_failed'].includes(event.outcome as string) ||
        (event.failureCode !== null && !nonEmpty(event.failureCode))) return false;
    if (!isMetricObservation(event.turns, finiteNonNegative)) return false;
    if (typeof event.usage !== 'object' || event.usage === null) return false;
    const usage = event.usage as Record<string, unknown>;
    if (!isMetricObservation(usage.inputTokens, finiteNonNegative) ||
        !isMetricObservation(usage.cachedInputTokens, finiteNonNegative) ||
        !isMetricObservation(usage.outputTokens, finiteNonNegative) ||
        !isMetricObservation(usage.reasoningTokens, finiteNonNegative)) return false;
    if (event.capability !== null) {
      if (typeof event.capability !== 'object' || event.capability === null) return false;
      const capability = event.capability as Record<string, unknown>;
      if (!nonEmpty(capability.source) || !isMetricObservation(capability.revision, nonEmpty)) return false;
      if (capability.verified !== null && typeof capability.verified !== 'boolean') return false;
      if (capability.unverifiedReason !== null && !nonEmpty(capability.unverifiedReason)) return false;
    }
    if (typeof event.context !== 'object' || event.context === null) return false;
    const context = event.context as Record<string, unknown>;
    return isMetricObservation(context.initialTokens, finiteNonNegative) &&
      isMetricObservation(context.peakTokens, finiteNonNegative) &&
      isMetricObservation(event.largestToolResultBytes, finiteNonNegative);
  }
  return false;
}
