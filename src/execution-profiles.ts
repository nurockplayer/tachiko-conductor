/**
 * Provider-neutral execution-profile boundary.  Profile names are durable
 * Steward choices; executor and model identifiers remain configuration data.
 */
export const EXECUTION_PROFILE_NAMES = ['routine', 'standard', 'complex', 'critical'] as const;

export type ExecutionProfileName = (typeof EXECUTION_PROFILE_NAMES)[number];
export type ExecutionReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ExecutionSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ExecutionApprovalPolicy = 'untrusted' | 'on-request' | 'never';

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

const REASONING_EFFORTS: readonly ExecutionReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SANDBOX_MODES: readonly ExecutionSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly ExecutionApprovalPolicy[] = ['untrusted', 'on-request', 'never'];

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
  if (!nonEmptyString(value.executor)) throw new Error(`Execution profile "${name}".executor must be a non-empty string.`);
  if (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1) {
    throw new Error(`Execution profile "${name}".timeoutMs must be a positive safe integer.`);
  }
  if (value.model !== undefined && !nonEmptyString(value.model)) {
    throw new Error(`Execution profile "${name}".model must be a non-empty string when supplied.`);
  }
  if (value.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(value.reasoningEffort as ExecutionReasoningEffort)) {
    throw new Error(`Execution profile "${name}".reasoningEffort is unsupported.`);
  }
  if (value.sandboxMode !== undefined && !SANDBOX_MODES.includes(value.sandboxMode as ExecutionSandboxMode)) {
    throw new Error(`Execution profile "${name}".sandboxMode is invalid.`);
  }
  if (value.approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(value.approvalPolicy as ExecutionApprovalPolicy)) {
    throw new Error(`Execution profile "${name}".approvalPolicy is invalid.`);
  }
  return {
    executor: value.executor.trim(),
    timeoutMs: value.timeoutMs as number,
    ...(value.model === undefined ? {} : { model: value.model.trim() }),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort as ExecutionReasoningEffort }),
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
  if (!isRecord(value) || !nonEmptyString(value.revision) || !isRecord(value.profiles)) {
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

/** Providers may reject generic settings they cannot safely honour. */
export function assertExecutionSupportedByProvider(execution: ResolvedExecutionConfiguration): void {
  if (execution.executor === 'claude-code' &&
    (execution.reasoningEffort !== undefined || execution.sandboxMode !== undefined || execution.approvalPolicy !== undefined)) {
    throw new Error(`Execution profile "${execution.profile}" requests settings unsupported by executor "${execution.executor}".`);
  }
}
