import assert from 'node:assert/strict';
import http, { type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';

import {
  BROWSER_RUNTIME_ERROR_CODE,
  BrowserRuntimeError,
} from '../src/browser/playwright-mcp-runtime.js';
import { openBrowserForBootstrap } from '../src/browser/mcp-client.js';

const SESSION_ID = 'bootstrap-readiness-session';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('bootstrap MCP stream readiness', () => {
  it('waits for the same-session GET stream before requesting browser_navigate', async () => {
    const getSeen = deferred();
    const releaseGet = deferred();
    const toolSeen = deferred();
    const streamClosed = deferred();
    let toolCalled = false;
    let getRequestSession: string | undefined;
    const server = http.createServer(async (request, response) => {
      if (request.method === 'POST') {
        const message = await readJson(request);
        if (message.method === 'initialize') {
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID });
          response.end(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
          }));
        } else if (message.method === 'notifications/initialized') {
          response.writeHead(202, { 'mcp-session-id': SESSION_ID });
          response.end();
        } else if (message.method === 'tools/call') {
          toolCalled = true;
          toolSeen.resolve();
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));
        } else {
          response.writeHead(400).end();
        }
        return;
      }
      if (request.method === 'GET') {
        const sessionHeader = request.headers['mcp-session-id'];
        getRequestSession = Array.isArray(sessionHeader) ? undefined : sessionHeader;
        response.once('close', () => streamClosed.resolve());
        getSeen.resolve();
        await releaseGet.promise;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': SESSION_ID });
        response.flushHeaders();
        response.write(': stream-ready\n\n');
        return;
      }
      response.writeHead(405).end();
    });

    const port = await listen(server);
    let lease: { close(): Promise<void> } | undefined;
    try {
      const opening = openBrowserForBootstrap(`http://127.0.0.1:${port}/mcp`);
      await getSeen.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      assert.equal(getRequestSession, SESSION_ID);
      assert.equal(toolCalled, false);

      releaseGet.resolve();
      lease = await opening;
      await toolSeen.promise;
      assert.ok(lease);
      await lease.close();
      lease = undefined;
      await withTimeout(streamClosed.promise, 1_000);
    } finally {
      releaseGet.resolve();
      await lease?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails closed on a wrong-session SSE GET, aborts it, and never requests browser_navigate', async () => {
    let toolCalls = 0;
    const getSeen = deferred();
    const responseClosed = deferred();
    const server = http.createServer(async (request, response) => {
      if (request.method === 'POST') {
        const message = await readJson(request);
        if (message.method === 'initialize') {
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID });
          response.end(JSON.stringify({
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
          }));
        } else if (message.method === 'notifications/initialized') {
          response.writeHead(202, { 'mcp-session-id': SESSION_ID });
          response.end();
        } else if (message.method === 'tools/call') {
          toolCalls += 1;
          response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } }));
        } else {
          response.writeHead(400).end();
        }
        return;
      }
      if (request.method === 'GET') {
        getSeen.resolve();
        response.once('close', () => responseClosed.resolve());
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'different-session' });
        response.flushHeaders();
        response.write(': wrong session\n\n');
        return;
      }
      response.writeHead(405).end();
    });

    const port = await listen(server);
    try {
      await assert.rejects(
        openBrowserForBootstrap(`http://127.0.0.1:${port}/mcp`),
        (error: unknown) => error instanceof BrowserRuntimeError && error.code === BROWSER_RUNTIME_ERROR_CODE.BOOTSTRAP_FAILED,
      );
      await getSeen.promise;
      assert.equal(toolCalls, 0);
      await withTimeout(responseClosed.promise, 1_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('wraps malformed endpoints as BOOTSTRAP_FAILED', async () => {
    await assert.rejects(
      openBrowserForBootstrap('not a URL'),
      (error: unknown) => error instanceof BrowserRuntimeError && error.code === BROWSER_RUNTIME_ERROR_CODE.BOOTSTRAP_FAILED,
    );
  });
});
