import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { ManagedPlaywrightMcpRuntime } from '../../src/browser/playwright-mcp-runtime.js';

const [profileRoot, runtimeRoot, repositoryRoot, playwrightCliPath, profile, portText, snapshotPath, readinessReleasePath] = process.argv.slice(2);
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
  readinessProbe: async (endpoint) => {
    // The parent test releases readiness only after the fake MCP child has
    // published its PID, separating fixture bootstrap from owner-death proof.
    if (readinessReleasePath !== undefined && !existsSync(readinessReleasePath)) return false;
    return await tcpReadinessProbe(endpoint);
  },
});
const handle = await runtime.start({ profile, port: Number(portText), stopTimeoutMs: 250 });
const snapshotTemporaryPath = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
writeFileSync(snapshotTemporaryPath, `${JSON.stringify(handle.snapshot)}\n`, { mode: 0o600, flag: 'wx' });
try {
  renameSync(snapshotTemporaryPath, snapshotPath);
} catch (error) {
  rmSync(snapshotTemporaryPath, { force: true });
  throw error;
}
await handle.waitForExit();
