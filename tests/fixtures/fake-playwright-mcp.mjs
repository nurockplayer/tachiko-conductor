import fs from 'node:fs';
import http from 'node:http';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.env.FAKE_MCP_ARGS_PATH) {
  fs.writeFileSync(process.env.FAKE_MCP_ARGS_PATH, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
}

if (process.env.FAKE_MCP_PID_PATH) {
  fs.writeFileSync(process.env.FAKE_MCP_PID_PATH, `${process.pid}\n`, { mode: 0o600 });
}

if (process.env.FAKE_MCP_MODE === 'exit') {
  process.exit(23);
}

if (process.env.FAKE_MCP_MODE === 'hang' || process.env.FAKE_MCP_MODE === 'hang-ignore-term') {
  if (process.env.FAKE_MCP_MODE === 'hang-ignore-term') process.on('SIGTERM', () => undefined);
  process.stdin.resume();
  process.stdin.on('close', () => process.exit(0));
  setInterval(() => {}, 1_000);
} else {
  const host = option('--host') ?? '127.0.0.1';
  const port = Number(option('--port'));
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.listen(port, host, () => {
    if (process.env.FAKE_MCP_MODE === 'exit-after-ready') {
      setTimeout(() => process.exit(24), 50);
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.stdin.resume();
  process.stdin.on('close', stop);
}
