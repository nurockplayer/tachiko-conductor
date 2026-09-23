#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const receiptId = process.env.TACHIKO_MISSION_RECEIPT_ID;
const receiptPath = process.env.TACHIKO_MISSION_RECEIPT_PATH;
const missionId = process.env.TACHIKO_MISSION_ID;
const owner = process.env.TACHIKO_MISSION_OWNER;
const sessionId = process.env.TACHIKO_MISSION_SESSION_ID;
const worktree = process.env.TACHIKO_MISSION_WORKTREE;
const cwd = process.env.TACHIKO_MISSION_CWD;
if (!receiptId || !receiptPath || !missionId || !owner || !sessionId || !worktree || !cwd) {
  console.error('Persisted mission receipt and owner/session/worktree/cwd identity are required.');
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

function syncDirectory(directory) {
  const descriptor = openSync(directory, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function persistClaim(claim) {
  const temporary = `${claimPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(claim)}\n`, { encoding: 'utf8', mode: 0o600 });
  const descriptor = openSync(temporary, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, claimPath);
  syncDirectory(claimDirectory);
}

function logHasTurnStarted() {
  try {
    return readFileSync(stdoutPath, 'utf8').split(/\r?\n/).some((line) => {
      try { return JSON.parse(line).type === 'turn.started'; } catch { return false; }
    });
  } catch { return false; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

function readClaim() {
  try { return JSON.parse(readFileSync(claimPath, 'utf8')); }
  catch { return null; }
}

const existing = readClaim();
if (existing?.phase === 'accepted' || logHasTurnStarted()) {
  if (existing?.phase !== 'accepted') persistClaim({ ...existing, receiptId, missionId, owner, sessionId, worktree, cwd, phase: 'accepted', acceptedAt: new Date().toISOString(), stdoutPath, stderrPath });
  process.exit(0);
}
if (existing?.phase === 'pending') {
  if (Number.isSafeInteger(existing.pid) && processAlive(existing.pid)) {
    for (let attempt = 0; attempt < 110; attempt += 1) {
      if (logHasTurnStarted()) {
        persistClaim({ ...existing, phase: 'accepted', acceptedAt: new Date().toISOString() });
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (!processAlive(existing.pid)) break;
    }
    if (logHasTurnStarted()) {
      persistClaim({ ...existing, phase: 'accepted', acceptedAt: new Date().toISOString() });
      process.exit(0);
    }
    if (Number.isSafeInteger(existing.pid) && processAlive(existing.pid)) {
      console.error('Codex process is still pending a turn.started event; preserving the claim.');
      process.exit(1);
    }
  }
  unlinkSync(claimPath);
}

const prompt = [
  `Mission ${missionId} produced receipt ${receiptId}.`,
  `Read the durable receipt at ${receiptPath}.`,
  'Reconcile the worker or CI result against the authoritative project state, then report the next action.',
].join(' ');
const stdoutDescriptor = openSync(stdoutPath, 'a', 0o600);
const stderrDescriptor = openSync(stderrPath, 'a', 0o600);
let claimDescriptor;
try {
  claimDescriptor = openSync(claimPath, 'wx', 0o600);
  writeSync(claimDescriptor, `${JSON.stringify({ receiptId, missionId, owner, sessionId, worktree, cwd, phase: 'pending', claimedAt: new Date().toISOString() })}\n`);
  fsyncSync(claimDescriptor);
} catch (error) {
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
  if (error?.code === 'EEXIST') process.exit(0);
  throw error;
} finally {
  if (claimDescriptor !== undefined) closeSync(claimDescriptor);
}
syncDirectory(claimDirectory);

const child = spawn(process.env.TACHIKO_CODEX_BIN ?? 'codex', ['exec', 'resume', '--json', sessionId, prompt], {
  detached: true,
  cwd,
  stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
});
let exit = null;
let spawnError = null;
child.once('error', (error) => { spawnError = error; });
child.once('exit', (code, signal) => { exit = { code, signal }; });
try {
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (child.pid === undefined) throw new Error('Codex spawn did not return a process id.');
  persistClaim({ receiptId, missionId, owner, sessionId, worktree, cwd, phase: 'pending', pid: child.pid, claimedAt: new Date().toISOString(), stdoutPath, stderrPath });
  child.unref();
  for (;;) {
    if (logHasTurnStarted()) {
      persistClaim({ receiptId, missionId, owner, sessionId, worktree, cwd, phase: 'accepted', pid: child.pid, claimedAt: new Date().toISOString(), acceptedAt: new Date().toISOString(), stdoutPath, stderrPath });
      break;
    }
    if (spawnError !== null) throw spawnError;
    if (exit !== null) throw new Error(`Codex exited before turn.started (code=${exit.code}, signal=${exit.signal}).`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
} catch (error) {
  if (existsSync(claimPath)) unlinkSync(claimPath);
  throw error;
} finally {
  closeSync(stdoutDescriptor);
  closeSync(stderrDescriptor);
}
