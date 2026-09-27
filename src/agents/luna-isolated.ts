import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED, GOVERNED_PUBLICATION_REENTRY_ACTION, type GovernedInvocationPreparation, type ImplementationAgent, type ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';
import { CodexCliAdapter, hasOriginalCodexCliRun } from './codex-cli.js';
import { hasPreparedStandaloneLunaInvocation } from '../workspace/standalone-git-bootstrap.js';

/** The sole production name for the #92-qualified subscription transport. */
export const LUNA_ISOLATED_PROVIDER = 'luna-isolated';
export const LUNA_ISOLATED_MODEL = 'gpt-5.6-luna';
export const LUNA_TRUSTED_RUNTIME_REVISION = 'luna-qualified-runtime-v1';

const qualifiedRuntimes = new WeakMap<object, { readonly run: Function; readonly prepare?: Function }>();

/** Read-only source-owned qualification; concrete methods are checked again to reject post-construction replacement. */
export function hasGovernedPublicationConfinement(adapter: object): boolean {
  const qualification = qualifiedRuntimes.get(adapter);
  if (qualification === undefined) return false;
  if (adapter instanceof IsolatedLunaAdapter) {
    return Object.getPrototypeOf(adapter) === IsolatedLunaAdapter.prototype &&
      qualification.run === ORIGINAL_LUNA_RUN && hasOriginalDataMethod(adapter, 'run', qualification.run) &&
      qualification.prepare === ORIGINAL_LUNA_PREPARE && hasOriginalDataMethod(adapter, 'prepareGovernedInvocation', qualification.prepare);
  }
  return adapter instanceof CodexCliAdapter && hasOriginalCodexCliRun(adapter) &&
    qualification.run === getDataMethod(CodexCliAdapter.prototype, 'run');
}

export const LUNA_ISOLATED_ERROR_CODE = {
  TRANSPORT_MISMATCH: 'LUNA_TRANSPORT_MISMATCH',
  RUNTIME_UNQUALIFIED: 'LUNA_RUNTIME_UNQUALIFIED',
  CAPABILITIES_FORBIDDEN: 'LUNA_CAPABILITIES_FORBIDDEN',
  CONTINUATION_FORBIDDEN: 'LUNA_CONTINUATION_FORBIDDEN',
} as const;

export interface IsolatedLunaAdapterOptions {
  readonly codexHome: string;
  readonly timeoutMs: number;
  readonly path?: string;
}

/**
 * #92's fresh, bounded-worker transport.  It intentionally has no App Server
 * probe or provider fallback.  Each repair is a new task packet/worker; this
 * makes restart semantics explicit rather than claiming a durable chat turn.
 */
export class IsolatedLunaAdapter implements ImplementationAgent {
  readonly kind = 'implementation-agent' as const;
  private readonly home: string;
  private readonly timeoutMs: number;
  private readonly executablePath: string | undefined;
  private readonly runtimeConfig: readonly string[];

  constructor(options: IsolatedLunaAdapterOptions) {
    if (!path.isAbsolute(options.codexHome) || !existsSync(options.codexHome)) throw new Error('Qualified Luna CODEX_HOME must be an existing absolute directory.');
    this.home = realpathSync(options.codexHome);
    if (existsSync(path.join(this.home, 'auth.json'))) throw new Error('Qualified Luna CODEX_HOME must use keyring-only authentication; auth.json is forbidden.');
    const configPath = path.join(this.home, 'config.toml');
    if (!existsSync(configPath)) throw new Error('Qualified Luna CODEX_HOME is missing its trusted config.toml.');
    this.runtimeConfig = parseTrustedLunaConfig(readFileSync(configPath, 'utf8'));
    this.timeoutMs = options.timeoutMs;
    this.executablePath = options.path;
    if (new.target === IsolatedLunaAdapter && hasOriginalDataMethod(this, 'run', ORIGINAL_LUNA_RUN) &&
        hasOriginalDataMethod(this, 'prepareGovernedInvocation', ORIGINAL_LUNA_PREPARE)) {
      qualifiedRuntimes.set(this, { run: ORIGINAL_LUNA_RUN, prepare: ORIGINAL_LUNA_PREPARE });
    }
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (request.governedPublication !== undefined && !hasPreparedStandaloneLunaInvocation(request)) {
      return failure(GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED,
        `Governed isolated Luna requires the exact current standalone preparation proof. No model turn or worker process was started. ${GOVERNED_PUBLICATION_REENTRY_ACTION}`,
        request);
    }
    if (request.execution?.executor !== LUNA_ISOLATED_PROVIDER || request.execution.model !== LUNA_ISOLATED_MODEL) {
      return failure(LUNA_ISOLATED_ERROR_CODE.TRANSPORT_MISMATCH, 'Isolated Luna requires the exact luna-isolated / gpt-5.6-luna execution snapshot.');
    }
    if (request.authority !== 'embedded' || request.instructions === undefined || request.instructions.trim() === '') {
      return failure(LUNA_ISOLATED_ERROR_CODE.RUNTIME_UNQUALIFIED, 'Isolated Luna requires a non-empty host-supplied bounded task packet.');
    }
    if ((request.capabilities?.length ?? 0) !== 0) return failure(LUNA_ISOLATED_ERROR_CODE.CAPABILITIES_FORBIDDEN, 'Isolated Luna forbids MCP/browser capabilities.');
    if (request.executor !== undefined || request.sessionId !== undefined) return failure(LUNA_ISOLATED_ERROR_CODE.CONTINUATION_FORBIDDEN, 'Isolated Luna repair/restart uses a fresh bounded worker; session continuation is forbidden.');
    if (request.workspacePath === undefined || request.branch === undefined) return failure(LUNA_ISOLATED_ERROR_CODE.RUNTIME_UNQUALIFIED, 'Isolated Luna requires a host-prepared standalone workspace and branch.');
    const env = isolatedLunaEnvironment(this.home, this.executablePath);
    const isolatedCli = new CodexCliAdapter({
      cwd: request.workspacePath, model: LUNA_ISOLATED_MODEL,
      reasoningEffort: request.execution.reasoningEffort, sandboxMode: 'workspace-write', approvalPolicy: 'never',
      timeoutMs: this.timeoutMs, env, requiredConfig: this.runtimeConfig,
    });
    const nestedRun = getDataMethod(CodexCliAdapter.prototype, 'run');
    if (nestedRun === undefined || !hasOriginalCodexCliRun(isolatedCli)) {
      return failure(GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED,
        `Governed isolated Luna refused a nested Codex CLI whose source-owned run method changed. No model turn or worker process was started. ${GOVERNED_PUBLICATION_REENTRY_ACTION}`,
        request);
    }
    if (hasPreparedStandaloneLunaInvocation(request)) {
      qualifiedRuntimes.set(isolatedCli, { run: nestedRun });
    }
    if (!hasOriginalCodexCliRun(isolatedCli)) {
      return failure(GOVERNED_PUBLICATION_CONFINEMENT_REQUIRED,
        `Governed isolated Luna refused a nested Codex CLI whose source-owned run method changed before invocation. No model turn or worker process was started. ${GOVERNED_PUBLICATION_REENTRY_ACTION}`,
        request);
    }
    return await nestedRun.call(isolatedCli, request);
  }

  prepareGovernedInvocation(request: ImplementationRequest): GovernedInvocationPreparation {
    if (!hasPreparedStandaloneLunaInvocation(request)) {
      return { status: 'held', reason: `Isolated Luna has no exact current standalone preparation proof. ${GOVERNED_PUBLICATION_REENTRY_ACTION}` };
    }
    return { status: 'qualified', agent: this };
  }
}

// Capture the original concrete methods after this class initializes. These
// are intentionally local to Luna's module; cross-module CLI identities are
// captured per privately minted adapter during the runtime call above.
const ORIGINAL_LUNA_RUN = IsolatedLunaAdapter.prototype.run;
const ORIGINAL_LUNA_PREPARE = IsolatedLunaAdapter.prototype.prepareGovernedInvocation;
function getDataMethod(target: object, name: string): Function | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
    ? descriptor.value
    : undefined;
}

function hasOriginalDataMethod(target: object, name: string, expected: Function | undefined): boolean {
  if (expected === undefined || Object.getOwnPropertyDescriptor(target, name) !== undefined) return false;
  return getDataMethod(Object.getPrototypeOf(target), name) === expected;
}

/** Minimal fresh-worker environment; deliberately independent of user HOME. */
export function isolatedLunaEnvironment(home: string, executablePath?: string): NodeJS.ProcessEnv {
  return { CODEX_HOME: home, HOME: home, PATH: executablePath ?? process.env.PATH ?? '', NO_PROXY: '*',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Tachiko Isolated Luna', GIT_AUTHOR_EMAIL: 'tachiko-luna@localhost',
    GIT_COMMITTER_NAME: 'Tachiko Isolated Luna', GIT_COMMITTER_EMAIL: 'tachiko-luna@localhost' };
}

/** Closed capability contract, then reapplied after repository configuration. */
export function parseTrustedLunaConfig(raw: string): readonly string[] {
  if (!new RegExp(`^\\s*tachiko_luna_runtime_revision\\s*=\\s*"${LUNA_TRUSTED_RUNTIME_REVISION}"\\s*$`, 'm').test(raw)) {
    throw new Error(`Qualified Luna config.toml must pin ${LUNA_TRUSTED_RUNTIME_REVISION}.`);
  }
  const required = [/^\s*plugins\s*=\s*false\s*$/m, /^\s*apps\s*=\s*false\s*$/m,
    /^\s*mcp_servers\s*=\s*\{\s*\}\s*$/m, /^\s*web_search\s*=\s*(false|"disabled")\s*$/m,
    /^\s*network_access\s*=\s*false\s*$/m];
  if (!required.every((pattern) => pattern.test(raw))) throw new Error('Qualified Luna config.toml must explicitly disable plugins, apps, MCP, web search, and command network access.');
  return ['features.plugins=false', 'features.apps=false', 'mcp_servers={}', 'web_search=false', 'sandbox_workspace_write.network_access=false'];
}

function failure(code: string, summary: string, request?: ImplementationRequest): AgentResult {
  return { exitStatus: 'failure', summary, diagnostics: [`${code}: ${summary}`],
    ...(request?.executor === undefined ? {} : { executor: request.executor }),
    ...(request?.sessionId === undefined ? {} : { sessionId: request.sessionId }), durationMs: 0 };
}
