import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { BROWSER_RUNTIME_ERROR_CODE, BrowserRuntimeError } from './playwright-mcp-runtime.js';

export interface BootstrapBrowserLease {
  close(): Promise<void>;
}

const BOOTSTRAP_STREAM_READY_TIMEOUT_MS = 5_000;

interface BootstrapStreamReadiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  readonly settled: boolean;
}

function createBootstrapStreamReadiness(): BootstrapStreamReadiness {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // The SDK starts its initial GET in the background after the initialized
  // notification. Attach a rejection handler now, before connect() returns.
  void promise.catch(() => undefined);
  return {
    promise,
    get settled() { return settled; },
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

function bootstrapFetch(endpoint: URL, readiness: BootstrapStreamReadiness): FetchLike {
  const nativeFetch = globalThis.fetch;
  let firstEndpointGetSeen = false;
  return (input, init) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(input instanceof Request ? input.url : input.toString(), endpoint);
    } catch {
      return nativeFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (requestUrl.href !== endpoint.href || method !== 'GET' || firstEndpointGetSeen) {
      return nativeFetch(input, init);
    }
    firstEndpointGetSeen = true;

    const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
    const requestSessionId = requestHeaders.get('mcp-session-id');
    try {
      return nativeFetch(input, init).then((response) => {
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        const responseSessionId = response.headers.get('mcp-session-id');
        if (
          response.status === 200 &&
          mediaType === 'text/event-stream' &&
          response.body !== null &&
          requestSessionId !== null &&
          requestSessionId.length > 0 &&
          responseSessionId === requestSessionId
        ) {
          readiness.resolve();
        } else {
          readiness.reject(new Error('The bootstrap MCP event stream was not established for the initialized session.'));
        }
        return response;
      }, (error: unknown) => {
        readiness.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
    } catch (error) {
      readiness.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };
}

async function waitForBootstrapStream(readiness: BootstrapStreamReadiness): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      readiness.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for the bootstrap MCP event stream.')), BOOTSTRAP_STREAM_READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Launch the headed dedicated browser once so a human can authenticate it. */
export async function openBrowserForBootstrap(endpoint: string): Promise<BootstrapBrowserLease> {
  const client = new Client({ name: 'tachiko-browser-bootstrap', version: '0.1.0' });
  const readiness = createBootstrapStreamReadiness();
  let endpointUrl: URL;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= client.close().catch(() => undefined);
    return closePromise;
  };
  try {
    endpointUrl = new URL(endpoint);
    await client.connect(new StreamableHTTPClientTransport(endpointUrl, { fetch: bootstrapFetch(endpointUrl, readiness) }));
    await waitForBootstrapStream(readiness);
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'about:blank' },
    });
    if (result.isError === true) {
      throw new Error('Playwright MCP returned a tool error while opening the bootstrap browser.');
    }
    return { close };
  } catch (error) {
    await close();
    throw new BrowserRuntimeError(
      BROWSER_RUNTIME_ERROR_CODE.BOOTSTRAP_FAILED,
      `Could not open the headed bootstrap browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
