import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  assertExecutionSupportedByProvider,
  parseExecutionProfileConfiguration,
  resolveExecutionProfile,
} from './execution-profiles.js';
import { parseTrustedLunaConfig } from './agents/luna-isolated.js';
import { hasSupportedProductionGitRuntime } from './validation/local-command.js';

/**
 * #104's checked-in, revisioned policy values.  The shell policy file is the
 * reboot-safe transport used by launchd/deployment; these values make its
 * contract testable without sourcing a user shell.
 */
export const PRODUCTION_POLICY_REVISION = 'issue-104-production-v7';
export const PRODUCTION_NODE_MIN_VERSION = '24.21.0';
export const PRODUCTION_NODE_ENGINE_RANGE = '>=24.21.0 <25';

export function isSupportedProductionNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 24 && minor >= 21 && Number.isSafeInteger(patch) && patch >= 0;
}

export function hasSupportedProductionNodeRuntime(program: string): boolean {
  try {
    const result = spawnSync(program, ['--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
      env: process.platform === 'win32'
        ? {
            PATH: process.env.Path ?? process.env.PATH ?? 'C:\\Windows\\System32',
            SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
            COMSPEC: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe',
            PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
          }
        : { PATH: '/usr/bin:/bin' },
    });
    return result.status === 0 && result.signal === null && isSupportedProductionNodeVersion(result.stdout);
  } catch {
    return false;
  }
}
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
  playwrightBrowsersPathEnvironment: 'TACHIKO_PLAYWRIGHT_BROWSERS_PATH',
  nodeProgramEnvironment: 'TACHIKO_NODE_PROGRAM',
  pnpmProgramEnvironment: 'TACHIKO_PNPM_PROGRAM',
  gitProgramEnvironment: 'TACHIKO_GIT_PROGRAM',
  dependencyArtifactPathEnvironment: 'TACHIKO_PNPM_DEPENDENCY_ARTIFACT',
  hydratedDependencyRoots: ['node_modules', 'apps/control-tower/node_modules'],
  terminalGeneratedIgnoredRoots: ['dist'],
  commands: [
    // This always happens in a newly reconstructed exact-HEAD checkout.  It
    // hydrates from the lockfile, never mutates it, and has no model boundary.
    { argv: ['pnpm', 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'], timeoutMs: 300_000 },
    { argv: ['pnpm', 'test:isolated'], timeoutMs: 300_000 },
    { argv: ['pnpm', 'typecheck'], timeoutMs: 120_000 },
    { argv: ['pnpm', 'build'], timeoutMs: 120_000 },
  ],
} as const;

export const PRODUCTION_HOSTED_CHECK_POLICY_CONFIG = {
  revision: PRODUCTION_POLICY_REVISION,
  // The live repository has neither branch protection nor rulesets requiring
  // a hosted context.  Its only active workflow is unrelated to production
  // validation, so this revision deliberately has no hosted-check gate.
  mode: 'not_required',
} as const;

export interface ProductionPolicyPreflight {
  readonly revision: string;
  readonly lunaCodexHome: string;
  readonly checks: readonly ['execution-profile', 'luna-home', 'playwright-browsers', 'dependency-artifact', 'local-validation', 'hosted-check-policy'];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPrivateBrowserArtifactDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function isPrivateRegularFile(file: string): boolean {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0;
  } catch { return false; }
}

function isAbsoluteExecutableFile(file: string | undefined): boolean {
  if (file === undefined || !path.isAbsolute(file)) return false;
  try {
    // Follow host-managed symlinks, matching the shell policy's -f/-x tests.
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/**
 * Validate the complete deployed policy before dispatch/restart. This uses
 * configuration, local filesystem work and a credential-free bounded Git
 * runtime probe: it neither reads GitHub nor invokes pnpm, Codex, or any model.
 */
export function preflightProductionPolicy(
  env: NodeJS.ProcessEnv = process.env,
  gitRuntimeIsSupported: (program: string) => boolean = hasSupportedProductionGitRuntime,
  nodeRuntimeIsSupported: (program: string) => boolean = hasSupportedProductionNodeRuntime,
): ProductionPolicyPreflight {
  const executionRaw = env.TACHIKO_EXECUTION_PROFILE_CONFIG;
  const localRaw = env.TACHIKO_LOCAL_VALIDATION_CONFIG;
  const hostedRaw = env.TACHIKO_HOSTED_CHECK_POLICY_CONFIG;
  const lunaHome = env.TACHIKO_LUNA_CODEX_HOME;
  const playwrightBrowsersPath = env.TACHIKO_PLAYWRIGHT_BROWSERS_PATH;
  const nodeProgram = env.TACHIKO_NODE_PROGRAM;
  const pnpmProgram = env.TACHIKO_PNPM_PROGRAM;
  const gitProgram = env.TACHIKO_GIT_PROGRAM;
  const dependencyArtifact = env.TACHIKO_PNPM_DEPENDENCY_ARTIFACT;
  if (executionRaw === undefined || localRaw === undefined || hostedRaw === undefined) {
    throw new Error('Issue #104 production preflight requires execution, local-validation, and hosted-check policy configuration.');
  }
  if (lunaHome === undefined || !path.isAbsolute(lunaHome) || lunaHome.trim() === '') {
    throw new Error('Issue #104 production preflight requires an absolute TACHIKO_LUNA_CODEX_HOME.');
  }
  if (playwrightBrowsersPath === undefined || !path.isAbsolute(playwrightBrowsersPath) || playwrightBrowsersPath.trim() === '') {
    throw new Error('Issue #104 production preflight requires an absolute TACHIKO_PLAYWRIGHT_BROWSERS_PATH.');
  }
  if (!isAbsoluteExecutableFile(nodeProgram)) {
    throw new Error('Issue #104 production preflight requires TACHIKO_NODE_PROGRAM to be an absolute regular executable file.');
  }
  if (!nodeRuntimeIsSupported(nodeProgram!)) {
    throw new Error(`Issue #104 production preflight requires Node.js ${PRODUCTION_NODE_MIN_VERSION} LTS or newer 24.x runtime.`);
  }
  if (!isAbsoluteExecutableFile(pnpmProgram)) {
    throw new Error('Issue #104 production preflight requires TACHIKO_PNPM_PROGRAM to be an absolute regular executable file.');
  }
  if (!isAbsoluteExecutableFile(gitProgram)) {
    throw new Error('Issue #104 production preflight requires TACHIKO_GIT_PROGRAM to be an absolute regular executable file.');
  }
  if (!gitRuntimeIsSupported(gitProgram!)) {
    throw new Error('Issue #104 production preflight requires TACHIKO_GIT_PROGRAM to select the supported Apple Command Line Tools Git runtime.');
  }
  if (dependencyArtifact === undefined || !path.isAbsolute(dependencyArtifact) || !isPrivateBrowserArtifactDirectory(dependencyArtifact) ||
    !isPrivateBrowserArtifactDirectory(path.join(dependencyArtifact, 'store')) || !isPrivateRegularFile(path.join(dependencyArtifact, 'pnpm-lock.yaml.sha256'))) {
    throw new Error('Issue #104 production preflight requires a private absolute TACHIKO_PNPM_DEPENDENCY_ARTIFACT with store and pnpm-lock.yaml.sha256.');
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
  if (existsSync(path.join(lunaHome, 'auth.json'))) {
    throw new Error('Issue #104 production Luna CODEX_HOME must not contain auth.json; Luna uses keyring-only authentication.');
  }
  if (!isPrivateBrowserArtifactDirectory(playwrightBrowsersPath)) {
    throw new Error('Issue #104 production Playwright browser artifact directory must be an existing private non-symlink host path; hydrate it host-side before validation.');
  }
  parseTrustedLunaConfig(readFileSync(path.join(lunaHome, 'config.toml'), 'utf8'));
  return { revision: PRODUCTION_POLICY_REVISION, lunaCodexHome: lunaHome, checks: ['execution-profile', 'luna-home', 'playwright-browsers', 'dependency-artifact', 'local-validation', 'hosted-check-policy'] };
}
