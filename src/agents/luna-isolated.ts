import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { ImplementationAgent, ImplementationRequest } from '../adapters/agent.js';
import type { AgentResult } from '../domain/types.js';
import { CodexCliAdapter } from './codex-cli.js';

/** The sole production name for the #92-qualified subscription transport. */
export const LUNA_ISOLATED_PROVIDER = 'luna-isolated';
export const LUNA_ISOLATED_MODEL = 'gpt-5.6-luna';
export const LUNA_TRUSTED_RUNTIME_REVISION = 'luna-qualified-runtime-v1';

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
  }

  async run(request: ImplementationRequest): Promise<AgentResult> {
    if (request.execution?.executor !== LUNA_ISOLATED_PROVIDER || request.execution.model !== LUNA_ISOLATED_MODEL) {
      return failure(LUNA_ISOLATED_ERROR_CODE.TRANSPORT_MISMATCH, 'Isolated Luna requires the exact luna-isolated / gpt-5.6-luna execution snapshot.');
    }
    if (request.authority !== 'embedded' || request.instructions === undefined || request.instructions.trim() === '') {
      return failure(LUNA_ISOLATED_ERROR_CODE.RUNTIME_UNQUALIFIED, 'Isolated Luna requires a non-empty host-supplied bounded task packet.');
    }
    if ((request.capabilities?.length ?? 0) !== 0) return failure(LUNA_ISOLATED_ERROR_CODE.CAPABILITIES_FORBIDDEN, 'Isolated Luna forbids MCP/browser capabilities.');
    if (request.executor !== undefined || request.sessionId !== undefined) return failure(LUNA_ISOLATED_ERROR_CODE.CONTINUATION_FORBIDDEN, 'Isolated Luna repair/restart uses a fresh bounded worker; session continuation is forbidden.');
    if (request.workspacePath === undefined || request.branch === undefined) return failure(LUNA_ISOLATED_ERROR_CODE.RUNTIME_UNQUALIFIED, 'Isolated Luna requires a host-prepared standalone workspace and branch.');
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: this.home,
      HOME: this.home,
      PATH: this.executablePath ?? process.env.PATH ?? '',
      NO_PROXY: '*',
    };
    return await new CodexCliAdapter({
      cwd: request.workspacePath, model: LUNA_ISOLATED_MODEL,
      reasoningEffort: request.execution.reasoningEffort, sandboxMode: 'workspace-write', approvalPolicy: 'never',
      timeoutMs: this.timeoutMs, env, requiredConfig: this.runtimeConfig,
    }).run(request);
  }
}

/** Closed capability contract, then reapplied after repository configuration. */
export function parseTrustedLunaConfig(raw: string): readonly string[] {
  const required = [/^\s*plugins\s*=\s*false\s*$/m, /^\s*apps\s*=\s*false\s*$/m,
    /^\s*mcp_servers\s*=\s*\{\s*\}\s*$/m, /^\s*web_search\s*=\s*(false|"disabled")\s*$/m,
    /^\s*network_access\s*=\s*false\s*$/m];
  if (!required.every((pattern) => pattern.test(raw))) throw new Error('Qualified Luna config.toml must explicitly disable plugins, apps, MCP, web search, and command network access.');
  return ['features.plugins=false', 'features.apps=false', 'mcp_servers={}', 'web_search=false', 'sandbox_workspace_write.network_access=false'];
}

function failure(code: string, summary: string): AgentResult {
  return { exitStatus: 'failure', summary, diagnostics: [`${code}: ${summary}`] };
}
