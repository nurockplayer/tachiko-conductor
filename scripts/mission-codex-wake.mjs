#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const receiptId = process.env.TACHIKO_MISSION_RECEIPT_ID;
const receiptPath = process.env.TACHIKO_MISSION_RECEIPT_PATH;
const missionId = process.env.TACHIKO_MISSION_ID;
const sessionId = process.env.TACHIKO_MISSION_CODEX_SESSION_ID;
if (!receiptId || !receiptPath || !missionId || !sessionId) {
  console.error('Mission receipt, mission ID, and TACHIKO_MISSION_CODEX_SESSION_ID are required.');
  process.exit(2);
}

const claimDirectory = process.env.TACHIKO_MISSION_CLAIM_DIR ?? path.join(os.homedir(), '.tachiko-conductor', 'mission-receipts');
mkdirSync(claimDirectory, { recursive: true, mode: 0o700 });
const key = createHash('sha256').update(receiptId).digest('hex');
const claimPath = path.join(claimDirectory, `${key}.claimed.json`);
const logDirectory = process.env.TACHIKO_MISSION_CODEX_LOG_DIR ?? path.join(claimDirectory, 'logs');
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const stdoutPath = path.join(logDirectory, `${key}.stdout.log`);
const stderrPath = path.join(logDirectory, `${key}.stderr.log`);
let descriptor;
try {
  descriptor = openSync(claimPath, 'wx', 0o600);
} catch (error) {
  if (typeof error === 'object' && error !== null && (error).code === 'EEXIST') process.exit(0);
  throw error;
}

// Consume the idempotency key before starting Codex. A crash after this point
// may require a human to inspect the session, but retry cannot start a second turn.
try {
  writeSync(descriptor, `${JSON.stringify({ receiptId, missionId, sessionId, claimedAt: new Date().toISOString() })}\n`);
  fsyncSync(descriptor);
} finally {
  closeSync(descriptor);
}
const directoryDescriptor = openSync(claimDirectory, 'r');
try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }

const prompt = [
  `Mission ${missionId} produced receipt ${receiptId}.`,
  `Read the durable receipt at ${receiptPath}.`,
  'Reconcile the worker or CI result against the authoritative project state, then report the next action.',
].join(' ');
const stdoutDescriptor = openSync(stdoutPath, 'a', 0o600);
const stderrDescriptor = openSync(stderrPath, 'a', 0o600);
const child = spawn(process.env.TACHIKO_CODEX_BIN ?? 'codex', ['exec', 'resume', sessionId, prompt], {
  detached: true,
  stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
});
try {
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
} catch (error) {
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
  unlinkSync(claimPath);
  throw error;
}
child.unref();
closeSync(stdoutDescriptor);
closeSync(stderrDescriptor);

const acknowledgedClaim = `${claimPath}.${process.pid}.tmp`;
writeFileSync(acknowledgedClaim, `${JSON.stringify({ receiptId, missionId, sessionId, pid: child.pid, claimedAt: new Date().toISOString(), stdoutPath, stderrPath })}\n`, { encoding: 'utf8', mode: 0o600 });
const acknowledgedDescriptor = openSync(acknowledgedClaim, 'r');
try { fsyncSync(acknowledgedDescriptor); } finally { closeSync(acknowledgedDescriptor); }
renameSync(acknowledgedClaim, claimPath);
const finalDirectoryDescriptor = openSync(claimDirectory, 'r');
try { fsyncSync(finalDirectoryDescriptor); } finally { closeSync(finalDirectoryDescriptor); }
