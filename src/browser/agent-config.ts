import type { McpHttpCapability } from '../adapters/agent.js';
import { browserRuntimeCapability, type BrowserRuntimeSnapshot } from './playwright-mcp-runtime.js';

export interface BrowserAgentConnection {
  readonly runtime: BrowserRuntimeSnapshot;
  readonly capability: McpHttpCapability;
  readonly claudeCode: {
    readonly mcpServers: Readonly<Record<string, { readonly type: 'http'; readonly url: string }>>;
  };
  readonly codex: { readonly configOverride: string };
}

/** Translate one generic runtime capability outside the workflow state machine. */
export function buildBrowserAgentConnection(snapshot: BrowserRuntimeSnapshot): BrowserAgentConnection {
  const capability = browserRuntimeCapability(snapshot);
  return {
    runtime: snapshot,
    capability,
    claudeCode: {
      mcpServers: {
        [capability.name]: { type: 'http', url: capability.endpoint },
      },
    },
    codex: {
      configOverride: `mcp_servers.${capability.name}.url=${JSON.stringify(capability.endpoint)}`,
    },
  };
}
