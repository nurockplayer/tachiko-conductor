/**
 * Provider-neutral execution-profile boundary.  Profile names are durable
 * Steward choices; executor and model identifiers remain configuration data.
 */
export const EXECUTION_PROFILE_NAMES = ['routine', 'standard', 'complex', 'critical'] as const;

export type ExecutionProfileName = (typeof EXECUTION_PROFILE_NAMES)[number];

/**
 * The canonical reasoning-effort vocabulary the Conductor may request.  It is a
 * durable, provider-neutral control vocabulary: providers may report extra
 * values through runtime discovery, but widening this set changes the durable
 * execution snapshot and is therefore a deliberate, separate decision.
 */
export const CANONICAL_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ExecutionReasoningEffort = (typeof CANONICAL_REASONING_EFFORTS)[number];
export type ExecutionSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ExecutionApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/**
 * Accepted operator aliases, normalized to one canonical runtime value.  Every
 * entry maps to a level of the *same* strength: aliases never downgrade a
 * request, and an ambiguous word (for example "highest") is deliberately absent
 * so it fails closed instead of being guessed down a level.
 */
const REASONING_EFFORT_ALIASES: Readonly<Record<string, ExecutionReasoningEffort>> = {
  minimal: 'minimal',
  min: 'minimal',
  low: 'low',
  medium: 'medium',
  med: 'medium',
  moderate: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x-high': 'xhigh',
  extrahigh: 'xhigh',
  'extra-high': 'xhigh',
  veryhigh: 'xhigh',
  'very-high': 'xhigh',
};

/** Stable, countable codes so telemetry can separate configuration from execution. */
export const EXECUTION_CONFIGURATION_ERROR_CODE = {
  INVALID_REASONING_EFFORT: 'EXECUTION_CONFIG_INVALID_REASONING_EFFORT',
  UNSUPPORTED_MODEL_EFFORT: 'EXECUTION_CONFIG_UNSUPPORTED_MODEL_EFFORT',
} as const;

export type ExecutionConfigurationErrorCode =
  (typeof EXECUTION_CONFIGURATION_ERROR_CODE)[keyof typeof EXECUTION_CONFIGURATION_ERROR_CODE];

/** Bounded, secret-free evidence describing a rejected pre-spawn configuration. */
export interface ExecutionConfigurationEvidence {
  readonly provider?: string;
  readonly model?: string;
  readonly requestedEffort: string;
  readonly canonicalEffort?: ExecutionReasoningEffort;
  readonly supportedEfforts?: readonly string[];
  /** `runtime-discovery` is provider-authoritative; `fallback` is versioned local metadata. */
  readonly capabilitySource?: 'runtime-discovery' | 'fallback';
  readonly capabilityRevision?: string;
  /** Provider-reported values the Conductor vocabulary cannot request. */
  readonly unrequestableEfforts?: readonly string[];
}

/**
 * A typed configuration rejection raised before any model spawn. It is
 * deliberately distinct from runtime/model execution failures so orchestration
 * and telemetry can attribute it to preflight validation.
 */
export class ExecutionConfigurationError extends Error {
  readonly code: ExecutionConfigurationErrorCode;
  readonly evidence: ExecutionConfigurationEvidence;

  constructor(
    code: ExecutionConfigurationErrorCode,
    message: string,
    evidence: ExecutionConfigurationEvidence,
  ) {
    super(message);
    this.name = 'ExecutionConfigurationError';
    this.code = code;
    this.evidence = evidence;
  }
}

export function isExecutionConfigurationError(error: unknown): error is ExecutionConfigurationError {
  return error instanceof ExecutionConfigurationError;
}

/** Stable diagnostic line so configuration rejection is countable apart from runtime failure. */
export function executionConfigurationDiagnostic(error: ExecutionConfigurationError): string {
  return `${error.code}: ${error.message}`;
}

function aliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

/**
 * Normalize an operator/policy spelling (case, spacing, hyphenation, or an
 * accepted alias) to exactly one canonical runtime value.  Throws a typed
 * configuration error for anything it cannot map without guessing.
 */
export function normalizeReasoningEffort(
  value: string,
  context: { readonly provider?: string } = {},
): ExecutionReasoningEffort {
  const canonical = REASONING_EFFORT_ALIASES[aliasKey(value)];
  if (canonical !== undefined) return canonical;
  throw new ExecutionConfigurationError(
    EXECUTION_CONFIGURATION_ERROR_CODE.INVALID_REASONING_EFFORT,
    `Reasoning effort "${value}" is unsupported; expected one of ${CANONICAL_REASONING_EFFORTS.join(', ')}.`,
    { ...(context.provider === undefined ? {} : { provider: context.provider }), requestedEffort: value },
  );
}

/** Secret-free immutable settings retained with a run for reproducibility. */
export interface ResolvedExecutionConfiguration {
  readonly profile: ExecutionProfileName;
  readonly revision: string;
  readonly executor: string;
  readonly model?: string;
  readonly reasoningEffort?: ExecutionReasoningEffort;
  readonly timeoutMs: number;
  readonly sandboxMode?: ExecutionSandboxMode;
  readonly approvalPolicy?: ExecutionApprovalPolicy;
}

export interface ExecutionProfileConfiguration {
  readonly revision: string;
  readonly profiles: Readonly<Record<ExecutionProfileName, Omit<ResolvedExecutionConfiguration, 'profile' | 'revision'>>>;
}

const SANDBOX_MODES: readonly ExecutionSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly ExecutionApprovalPolicy[] = ['untrusted', 'on-request', 'never'];
const PROFILE_KEYS = ['executor', 'timeoutMs', 'model', 'reasoningEffort', 'sandboxMode', 'approvalPolicy'] as const;
const CONFIGURATION_KEYS = ['revision', 'profiles'] as const;
/** Node process timers overflow above this signed 32-bit millisecond value. */
export const MAX_EXECUTION_TIMEOUT_MS = 2_147_483_647;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function profileName(value: string): value is ExecutionProfileName {
  return (EXECUTION_PROFILE_NAMES as readonly string[]).includes(value);
}

function parseProfile(name: ExecutionProfileName, value: unknown): Omit<ResolvedExecutionConfiguration, 'profile' | 'revision'> {
  if (!isRecord(value)) throw new Error(`Execution profile "${name}" must be an object.`);
  if (Object.keys(value).some((key) => !(PROFILE_KEYS as readonly string[]).includes(key))) {
    throw new Error(`Execution profile "${name}" contains an unsupported setting.`);
  }
  if (!nonEmptyString(value.executor)) throw new Error(`Execution profile "${name}".executor must be a non-empty string.`);
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error(`Execution profile "${name}".timeoutMs must be a positive integer no greater than ${MAX_EXECUTION_TIMEOUT_MS}.`);
  }
  if (value.model !== undefined && !nonEmptyString(value.model)) {
    throw new Error(`Execution profile "${name}".model must be a non-empty string when supplied.`);
  }
  if (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string') {
    throw new Error(`Execution profile "${name}".reasoningEffort must be a string when supplied.`);
  }
  if (value.sandboxMode !== undefined && !SANDBOX_MODES.includes(value.sandboxMode as ExecutionSandboxMode)) {
    throw new Error(`Execution profile "${name}".sandboxMode is invalid.`);
  }
  if (value.approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(value.approvalPolicy as ExecutionApprovalPolicy)) {
    throw new Error(`Execution profile "${name}".approvalPolicy is invalid.`);
  }
  const executor = value.executor.trim();
  // Normalize accepted aliases/case to one canonical value here, at resolution
  // time, so no provider adapter ever receives an unnormalized spelling.
  const reasoningEffort = value.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(value.reasoningEffort, { provider: executor });
  return {
    executor,
    timeoutMs: value.timeoutMs as number,
    ...(value.model === undefined ? {} : { model: value.model.trim() }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(value.sandboxMode === undefined ? {} : { sandboxMode: value.sandboxMode as ExecutionSandboxMode }),
    ...(value.approvalPolicy === undefined ? {} : { approvalPolicy: value.approvalPolicy as ExecutionApprovalPolicy }),
  };
}

/** Parse one explicit, revisioned operator configuration; no defaults are inferred. */
export function parseExecutionProfileConfiguration(raw: string): ExecutionProfileConfiguration {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('TACHIKO_EXECUTION_PROFILE_CONFIG must be valid JSON.');
  }
  if (!isRecord(value) || !nonEmptyString(value.revision) || !isRecord(value.profiles) ||
    Object.keys(value).some((key) => !(CONFIGURATION_KEYS as readonly string[]).includes(key))) {
    throw new Error('TACHIKO_EXECUTION_PROFILE_CONFIG must contain non-empty revision and profiles object.');
  }
  const profilesInput = value.profiles;
  const keys = Object.keys(profilesInput);
  if (keys.some((key) => !profileName(key)) || EXECUTION_PROFILE_NAMES.some((name) => profilesInput[name] === undefined)) {
    throw new Error('TACHIKO_EXECUTION_PROFILE_CONFIG.profiles must define exactly routine, standard, complex, and critical.');
  }
  const profiles = Object.fromEntries(
    EXECUTION_PROFILE_NAMES.map((name) => [name, parseProfile(name, profilesInput[name])]),
  ) as ExecutionProfileConfiguration['profiles'];
  return { revision: value.revision.trim(), profiles };
}

/** Resolve a Steward-selected coarse profile to an immutable execution snapshot. */
export function resolveExecutionProfile(
  configuration: ExecutionProfileConfiguration,
  selected: string,
  availableExecutors: readonly string[],
): ResolvedExecutionConfiguration {
  if (!profileName(selected)) throw new Error(`Unknown execution profile "${selected}".`);
  const resolved = configuration.profiles[selected];
  if (!availableExecutors.includes(resolved.executor)) {
    throw new Error(`Execution profile "${selected}" names unavailable executor "${resolved.executor}".`);
  }
  return { profile: selected, revision: configuration.revision, ...resolved };
}

/** Providers reject generic settings they cannot safely honour. */
export function assertExecutionSupportedByProvider(execution: ResolvedExecutionConfiguration): void {
  const codexOnlySettings = execution.reasoningEffort !== undefined ||
    execution.sandboxMode !== undefined || execution.approvalPolicy !== undefined;
  const unsupported = (execution.executor === 'claude-code' && codexOnlySettings) ||
    (execution.executor === 'worker-router' && (execution.model !== undefined || codexOnlySettings)) ||
    // The qualified subscription transport is deliberately a narrow,
    // unattended lane.  Allowing its exact model settings under a stronger
    // profile would silently turn a Steward profile change into a different
    // operational policy.  Those profiles must be explicitly introduced by
    // a future qualified transport instead.
    (execution.executor === 'luna-isolated' && (execution.profile !== 'routine' || execution.model !== 'gpt-5.6-luna' || execution.sandboxMode !== 'workspace-write' || execution.approvalPolicy !== 'never'));
  if (unsupported) {
    throw new Error(`Execution profile "${execution.profile}" requests settings unsupported by executor "${execution.executor}".`);
  }
}
