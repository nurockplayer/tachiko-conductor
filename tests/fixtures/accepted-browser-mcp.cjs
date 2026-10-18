// Controlled installed-package process only: no Playwright browser, account or model.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const report = path.join(process.env.HOME, '.tachiko-conductor', 'controlled-browser.jsonl');
const record = value => fs.appendFileSync(report, JSON.stringify(value) + '\n', { mode: 0o600 });
record({ phase: 'spawn', execArgv: process.execArgv, selected: process.env.PLAYWRIGHT_BROWSERS_PATH });
try {
  record({ phase: 'dependency-loaded', value: require('controlled-browser-dependency') });
} catch (error) {
  record({ phase: 'dependency-refused', code: error.code === 'MODULE_NOT_FOUND' ? 'MODULE_NOT_FOUND' : 'OTHER' });
  process.exit(23);
}
const option = name => process.argv[process.argv.indexOf(name) + 1];
const session = 'controlled-installed-browser-session';
const headers = { 'content-type': 'application/json', 'mcp-session-id': session };
const server = http.createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': session });
    response.flushHeaders();
    response.write(': controlled-ready\n\n');
    return;
  }
  if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return; }
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'controlled-installed', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'browser_navigate', inputSchema: { type: 'object' } }] };
  else if (message.method === 'tools/call') { record({ phase: 'tool', name: message.params.name }); result = { content: [] }; }
  else result = {};
  response.writeHead(200, headers);
  response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
server.listen(Number(option('--port')), option('--host'));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.on('close', stop);
