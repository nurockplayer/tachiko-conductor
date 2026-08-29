import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { BROWSER_RUNTIME_ERROR_CODE, BrowserRuntimeError } from './playwright-mcp-runtime.js';

/** Launch the headed dedicated browser once so a human can authenticate it. */
export async function openBrowserForBootstrap(endpoint: string): Promise<void> {
  const client = new Client({ name: 'tachiko-browser-bootstrap', version: '0.1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'about:blank' },
    });
    if (result.isError === true) {
      throw new Error('Playwright MCP returned a tool error while opening the bootstrap browser.');
    }
  } catch (error) {
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.BOOTSTRAP_FAILED,
      `Could not open the headed bootstrap browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
