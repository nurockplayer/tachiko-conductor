import { writeFileSync } from 'node:fs';
import net from 'node:net';

import { ManagedPlaywrightMcpRuntime } from '../../src/browser/playwright-mcp-runtime.js';

const [profileRoot, runtimeRoot, repositoryRoot, playwrightCliPath, profile, portText, snapshotPath] = process.argv.slice(2);
if (
  profileRoot === undefined ||
  runtimeRoot === undefined ||
  repositoryRoot === undefined ||
  playwrightCliPath === undefined ||
  profile === undefined ||
  portText === undefined ||
  snapshotPath === undefined
) {
  throw new Error('browser-runtime-owner requires profile/runtime/repository/CLI/profile/port/snapshot arguments');
}

async function tcpReadinessProbe(endpoint: string): Promise<boolean> {
  const url = new URL(endpoint);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    const done = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

const runtime = new ManagedPlaywrightMcpRuntime({
  profileRoot,
  runtimeRoot,
  repositoryRoot,
  playwrightCliPath,
  readinessProbe: tcpReadinessProbe,
});
const handle = await runtime.start({ profile, port: Number(portText), stopTimeoutMs: 250 });
writeFileSync(snapshotPath, `${JSON.stringify(handle.snapshot)}\n`, { mode: 0o600 });
await handle.waitForExit();
