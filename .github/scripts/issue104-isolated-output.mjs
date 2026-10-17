// One-off exact-command observation. Every instrumented result has zero gate credit.
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const pnpm = process.env.Q_PNPM;
if (!pnpm || !path.isAbsolute(pnpm) || realpathSync(pnpm) !== pnpm) {
  throw new Error('Diagnostic requires the verified actual pnpm script');
}
const originalSpawn = childProcess.spawn;
const cap = 64 * 1024;
const focusCodeSha256 = 'db9f9541a3f3ed44a1cd61ea711b5d39c32d8e38bde5833f14793ce406b02f54';
const chunkBytes = 4 * 1024;
let sequence = 0;
function capture(stream) {
  const state = { totalBytes: 0, tail: Buffer.alloc(0), streamError: false };
  stream.on('data', (chunk) => {
    state.totalBytes += chunk.length;
    state.tail = Buffer.from(Buffer.concat([state.tail, chunk]).subarray(-cap));
  });
  stream.on('error', () => { state.streamError = true; });
  return state;
}
childProcess.spawn = function (file, args, options) {
  const selected = file === '/usr/bin/sandbox-exec' && Array.isArray(args)
    && args.length === 10 && args[0] === '-p' && typeof args[1] === 'string'
    && args[2] === pnpm && args[3] === 'exec' && args[4] === 'node'
    && args[5] === '--import' && args[6] === 'tsx'
    && args[7] === '--input-type=module' && args[8] === '-e' && typeof args[9] === 'string'
    && createHash('sha256').update(args[9]).digest('hex') === focusCodeSha256
    && options?.stdio === 'ignore' && options.shell === false
    && options.detached === true && options.env?.NODE_OPTIONS === undefined;
  if (!selected) return originalSpawn.apply(this, arguments);
  const current = ++sequence;
  const child = originalSpawn.call(this, file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const streams = { stdout: capture(child.stdout), stderr: capture(child.stderr) };
  child.once('close', (code, signal) => {
    for (const [name, state] of Object.entries(streams)) {
      const totalChunks = Math.ceil(state.tail.length / chunkBytes);
      process.stdout.write('FIXTURE_FOCUS_DIAGNOSTIC ' + JSON.stringify({
        diagnosticOnly: true, sequence: current, stream: name, code, signal,
        totalBytes: state.totalBytes, retainedBytes: state.tail.length,
        truncated: state.totalBytes > cap, streamError: state.streamError,
        tailSha256: createHash('sha256').update(state.tail).digest('hex'),
        totalChunks,
      }) + '\n');
      if (state.tail.length > 0) {
        for (let index = 0; index < totalChunks; index += 1) {
          process.stdout.write('FIXTURE_FOCUS_DIAGNOSTIC_CHUNK ' + JSON.stringify({
            diagnosticOnly: true, sequence: current, stream: name, index, totalChunks,
            base64: state.tail.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString('base64'),
          }) + '\n');
        }
      }
    }
  });
  return child;
};
syncBuiltinESMExports();
