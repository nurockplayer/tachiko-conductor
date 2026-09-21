import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  assertExecutionSupportedByProvider,
  parseExecutionProfileConfiguration,
  resolveExecutionProfile,
} from './execution-profiles.js';
import { parseTrustedLunaConfig } from './agents/luna-isolated.js';

/**
 * #104's checked-in, revisioned policy values.  The shell policy file is the
 * reboot-safe transport used by launchd/deployment; these values make its
 * contract testable without sourcing a user shell.
 */
export const PRODUCTION_POLICY_REVISION = 'issue-104-production-v1';
export const PRODUCTION_EXECUTION_PROFILE_CONFIG = {
  revision: PRODUCTION_POLICY_REVISION,
  profiles: {
    routine: { executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 900_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    // The schema retains every durable Steward vocabulary member, but only
    // routine is admissible for unattended Luna.  Resolution rejects these
    // entries before an adapter/model process can be constructed.
    standard: { executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 900_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    complex: { executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 900_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
    critical: { executor: 'luna-isolated', model: 'gpt-5.6-luna', reasoningEffort: 'high', timeoutMs: 900_000, sandboxMode: 'workspace-write', approvalPolicy: 'never' },
  },
} as const;

export const PRODUCTION_LOCAL_VALIDATION_CONFIG = {
  revision: PRODUCTION_POLICY_REVISION,
  commands: [
    // This always happens in a newly reconstructed exact-HEAD checkout.  It
    // hydrates from the lockfile, never mutates it, and has no model boundary.
    { argv: ['pnpm', 'install', '--frozen-lockfile'], timeoutMs: 300_000 },
    { argv: ['pnpm', 'test'], timeoutMs: 300_000 },
    { argv: ['pnpm', 'typecheck'], timeoutMs: 120_000 },
    { argv: ['pnpm', 'build'], timeoutMs: 120_000 },
  ],
} as const;

export const PRODUCTION_HOSTED_CHECK_POLICY_CONFIG = {
  revision: PRODUCTION_POLICY_REVISION,
  mode: 'required',
  requiredCheckNames: ['test'],
} as const;

export interface ProductionPolicyPreflight {
  readonly revision: string;
  readonly lunaCodexHome: string;
  readonly checks: readonly ['execution-profile', 'luna-home', 'local-validation', 'hosted-check-policy'];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate the complete deployed policy before dispatch/restart.  It is pure
 * configuration and local filesystem work: it neither reads GitHub nor
 * invokes pnpm, Codex, or any model.
 */
export function preflightProductionPolicy(env: NodeJS.ProcessEnv = process.env): ProductionPolicyPreflight {
  const executionRaw = env.TACHIKO_EXECUTION_PROFILE_CONFIG;
  const localRaw = env.TACHIKO_LOCAL_VALIDATION_CONFIG;
  const hostedRaw = env.TACHIKO_HOSTED_CHECK_POLICY_CONFIG;
  const lunaHome = env.TACHIKO_LUNA_CODEX_HOME;
  if (executionRaw === undefined || localRaw === undefined || hostedRaw === undefined) {
    throw new Error('Issue #104 production preflight requires execution, local-validation, and hosted-check policy configuration.');
  }
  if (lunaHome === undefined || !path.isAbsolute(lunaHome) || lunaHome.trim() === '') {
    throw new Error('Issue #104 production preflight requires an absolute TACHIKO_LUNA_CODEX_HOME.');
  }
  let suppliedExecution: unknown;
  let suppliedLocal: unknown;
  let suppliedHosted: unknown;
  try { suppliedExecution = JSON.parse(executionRaw); } catch { throw new Error('Issue #104 production execution profile configuration must be valid JSON.'); }
  try { suppliedLocal = JSON.parse(localRaw); } catch { throw new Error('Issue #104 production local validation configuration must be valid JSON.'); }
  try { suppliedHosted = JSON.parse(hostedRaw); } catch { throw new Error('Issue #104 production hosted-check policy configuration must be valid JSON.'); }
  if (!sameJson(suppliedExecution, PRODUCTION_EXECUTION_PROFILE_CONFIG)) {
    throw new Error('Issue #104 production execution profile configuration does not match its revisioned policy.');
  }
  const execution = parseExecutionProfileConfiguration(executionRaw);
  const routine = resolveExecutionProfile(execution, 'routine', ['luna-isolated']);
  assertExecutionSupportedByProvider(routine);
  for (const profile of ['standard', 'complex', 'critical']) {
    const unsupported = resolveExecutionProfile(execution, profile, ['luna-isolated']);
    try {
      assertExecutionSupportedByProvider(unsupported);
    } catch {
      continue;
    }
    throw new Error(`Issue #104 production policy unexpectedly admits unattended ${profile}.`);
  }
  if (!sameJson(suppliedLocal, PRODUCTION_LOCAL_VALIDATION_CONFIG)) {
    throw new Error('Issue #104 production local validation must be the model-free frozen-lockfile exact-candidate policy without an ignored-state baseline.');
  }
  if (!sameJson(suppliedHosted, PRODUCTION_HOSTED_CHECK_POLICY_CONFIG)) {
    throw new Error('Issue #104 production hosted-check policy does not match its revisioned policy.');
  }
  if (!existsSync(lunaHome) || !existsSync(path.join(lunaHome, 'config.toml'))) {
    throw new Error('Issue #104 production Luna CODEX_HOME must exist and contain config.toml.');
  }
  parseTrustedLunaConfig(readFileSync(path.join(lunaHome, 'config.toml'), 'utf8'));
  return { revision: PRODUCTION_POLICY_REVISION, lunaCodexHome: lunaHome, checks: ['execution-profile', 'luna-home', 'local-validation', 'hosted-check-policy'] };
}
