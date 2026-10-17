// One-off observation of the existing synthetic probe; no qualification credit.
import childProcess from 'node:child_process';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const pnpm = process.env.Q_DIAG_PNPM;
if (!pnpm || !path.isAbsolute(pnpm) || realpathSync(pnpm) !== pnpm) {
  throw new Error('Diagnostic requires the already verified actual pnpm script');
}
const originalSpawn = childProcess.spawn;
const cap = 64 * 1024;
let observed = 0;
childProcess.spawn = function (file, args, options) {
  const selected = file === '/usr/bin/sandbox-exec' && Array.isArray(args)
    && args.length === 5 && args[0] === '-p' && typeof args[1] === 'string'
    && args[2] === pnpm && args[3] === 'run' && args[4] === 'probe'
    && options?.stdio === 'ignore' && options.shell === false
    && options.detached === true && options.env?.NODE_OPTIONS === undefined;
  if (!selected) return originalSpawn.apply(this, arguments);
  const sequence = ++observed;
  // Retain ignored stdin/stdout, unchanged argv/env/cwd/shell/detached and timers.
  const child = originalSpawn.call(this, file, args, { ...options, stdio: ['ignore', 'ignore', 'pipe'] });
  const chunks = [];
  let retained = 0;
  let total = 0;
  child.stderr.on('data', (chunk) => {
    total += chunk.length;
    const take = Math.min(chunk.length, cap - retained);
    if (take > 0) { chunks.push(chunk.subarray(0, take)); retained += take; }
  });
  child.stderr.on('error', () => {
    process.stderr.write(JSON.stringify({ diagnosticOnly: true, sequence, observation: 'stderr-stream-error' }) + '\n');
  });
  child.once('close', (code, signal) => {
    process.stderr.write(JSON.stringify({
      diagnosticOnly: true, sequence, code, signal,
      stderrBytes: total, truncated: total > cap,
      ...(code === 0 ? {} : { stderr: Buffer.concat(chunks, retained).toString('utf8') }),
    }) + '\n');
  });
  return child;
};
syncBuiltinESMExports();
