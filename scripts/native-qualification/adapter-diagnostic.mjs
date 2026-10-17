// Supplemental evidence only. One actual exported adapter call per owned subprocess.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [candidate, evidenceRoot, fixtureRoot, git, mode] = process.argv.slice(2);
assert.equal(process.argv.length, 7);
assert.ok(['control', 'captured'].includes(mode));
for (const value of [candidate, evidenceRoot, fixtureRoot, git]) assert.ok(path.isAbsolute(value));
assert.equal(realpathSync(process.cwd()), realpathSync(candidate));
if (mode === 'control') mkdirSync(evidenceRoot, { mode: 0o700 });
assert.ok(lstatSync(evidenceRoot).isDirectory() && !lstatSync(evidenceRoot).isSymbolicLink());
const storeRoot = path.join(evidenceRoot, 'store');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFileSync(path.join(evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const setup = [];
let fixture;
const raw = (bytes) => ({ base64: (bytes ?? Buffer.alloc(0)).toString('base64'),
  bytes: bytes?.length ?? 0, sha256: hash(bytes ?? Buffer.alloc(0)) });
// Node publishes child_process at construction, before spawnfile is populated.
// Attach now and select only the actual sandbox-exec child at its spawn event.
const childChannel = channel('child_process');
const observation = { status: 'UNKNOWN', events: [], bounded: true };
const observerStarted = process.hrtime.bigint();
let attached = 0;
let selected = 0;
let observationWriteFailed = false;
function persistObservation() {
  const phases = observation.events.map((event) => event.phase);
  observation.status = observation.bounded && selected === 1 && phases.join(',') === 'spawn,exit,close'
    ? 'OBSERVED' : 'UNKNOWN';
  try { save(mode + '-process.json', observation); }
  catch { observationWriteFailed = true; }
}
function observeChild({ process: child }) {
  if (++attached > 32) { observation.bounded = false; return; }
  let matches = false;
  const record = (phase, detail = {}) => {
    if (observation.events.length >= 6) { observation.bounded = false; return; }
    observation.events.push({ phase, monotonicMs: Number(process.hrtime.bigint() - observerStarted) / 1e6, ...detail });
    persistObservation();
  };
  child.once('spawn', () => {
    if (child.spawnfile !== '/usr/bin/sandbox-exec') return;
    matches = true;
    selected += 1;
    record('spawn');
  });
  for (const phase of ['exit', 'close']) child.once(phase, (code, signal) => {
    if (matches) record(phase, { code, signal });
  });
}
childChannel.subscribe(observeChild);

function verifyFixture(owned, configuration, original) {
  assert.deepEqual(owned.target, { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 42 });
  assert.match(owned.headSha, /^[0-9a-f]{40}$/);
  assert.ok(realpathSync(owned.workspacePath).startsWith(realpathSync(fixtureRoot) + path.sep));
  const pnpm = path.resolve(candidate, 'node_modules/.bin/pnpm');
  assert.deepEqual(configuration, { revision: 'darwin-real-toolchain-v1', nodeProgram: process.execPath, pnpmProgram: pnpm,
    commands: [{ argv: [pnpm, '--version'], timeoutMs: 30_000 }] });
  const bytes = readFileSync(path.join(owned.workspacePath, 'package.json'));
  assert.equal(bytes.toString('utf8'), JSON.stringify({ packageManager: 'pnpm@10.34.5' }));
  const nodeIdentity = { physicalPath: realpathSync(process.execPath), sha256: hash(readFileSync(process.execPath)) };
  const pnpmIdentity = { physicalPath: realpathSync(pnpm), sha256: hash(readFileSync(pnpm)) };
  assert.deepEqual(nodeIdentity, original.node);
  assert.deepEqual(pnpmIdentity, original.pnpm);
  const argv = ['-C', owned.workspacePath, 'rev-parse', 'HEAD'];
  const result = spawnSync(git, argv, { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const proof = { request: owned, configuration, packageSha256: hash(bytes), node: nodeIdentity, pnpm: pnpmIdentity,
    headProbe: { argv: [git, ...argv], exitCode: result.status, signal: result.signal,
      error: result.error?.message ?? null, stdout: raw(result.stdout), stderr: raw(result.stderr) } };
  save(mode + '.json', { inputProof: proof, evidence: null });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString('utf8').trim(), owned.headSha);
  return proof;
}

function inventoryStore() {
  // A fresh one-operation store contains only channel bytes and operation metadata.
  const files = [];
  let total = 0;
  for (const directory of [storeRoot, path.join(storeRoot, 'operations')]) {
    let entries;
    try { entries = readdirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.ok(entries.length <= 32, 'store entry bound');
    for (const name of entries.sort()) {
      const absolute = path.join(directory, name);
      const info = lstatSync(absolute);
      if (info.isDirectory() && absolute === path.join(storeRoot, 'operations')) continue;
      assert.ok(info.isFile() && !info.isSymbolicLink(), 'store regular evidence file required');
      total += info.size;
      assert.ok(files.length < 32 && total <= 32 * 1024 * 1024, 'store byte/count bound');
      const bytes = readFileSync(absolute);
      files.push({ path: path.relative(evidenceRoot, absolute), bytes: bytes.length, sha256: hash(bytes),
        uid: info.uid, gid: info.gid, mode: info.mode & 0o777, device: String(info.dev), inode: String(info.ino) });
    }
  }
  save('store-manifest.json', { files, totalBytes: total, textRangesAreNotRawByteProof: true });
}

async function main() {
  assert.equal(process.platform, 'darwin');
  const { ConfiguredLocalValidationAdapter } = await import(pathToFileURL(path.join(candidate, 'src/validation/local-command.ts')).href);
  const { FileToolOutputStore, readToolOutput } = await import(pathToFileURL(path.join(candidate, 'src/evidence/tool-output.ts')).href);
  if (mode === 'control') {
    // Match the original seatbelt test's fresh request(), two commits and package bytes.
    const workspacePath = mkdtempSync(path.join(fixtureRoot, 'tachiko-validation-'));
    function fixtureGit(args) {
      const argv = ['-C', workspacePath, ...args];
      const result = spawnSync(git, argv, { timeout: 10_000, maxBuffer: 1024 * 1024 });
      setup.push({ argv: [git, ...argv], exitCode: result.status, signal: result.signal,
        error: result.error?.message ?? null, stdout: raw(result.stdout), stderr: raw(result.stderr) });
      save('fixture.json', { setup, fixture });
      assert.equal(result.status, 0, 'fixture Git command must complete');
      return result.stdout.toString('utf8').trim();
    }
    for (const args of [['init'], ['config', 'user.email', 'validation@example.test'], ['config', 'user.name', 'Validation'],
      ['add', '.'], ['commit', '-m', 'initial']]) {
      if (args[0] === 'add') writeFileSync(path.join(workspacePath, 'README.md'), 'validation\n');
      fixtureGit(args);
    }
    fixtureGit(['rev-parse', 'HEAD']);
    fixtureGit(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    const packageBytes = JSON.stringify({ packageManager: 'pnpm@10.34.5' });
    writeFileSync(path.join(workspacePath, 'package.json'), packageBytes);
    fixtureGit(['add', 'package.json']);
    fixtureGit(['commit', '-m', 'pin package manager']);
    const headSha = fixtureGit(['rev-parse', 'HEAD']);
    const pnpm = path.resolve(candidate, 'node_modules/.bin/pnpm');
    const owned = { target: { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 42 }, headSha, workspacePath };
    const configuration = { revision: 'darwin-real-toolchain-v1', nodeProgram: process.execPath, pnpmProgram: pnpm,
      commands: [{ argv: [pnpm, '--version'], timeoutMs: 30_000 }] };
    fixture = { request: owned, configuration, packageBytes, packageSha256: hash(Buffer.from(packageBytes)),
      node: { physicalPath: realpathSync(process.execPath), sha256: hash(readFileSync(process.execPath)) },
      pnpm: { physicalPath: realpathSync(pnpm), sha256: hash(readFileSync(pnpm)) } };
    save('fixture.json', { setup, fixture });

    const startedControl = new Date().toISOString();
    const inputProof = verifyFixture(owned, configuration, fixture);
    const control = await new ConfiguredLocalValidationAdapter(configuration).validate(owned);
    save('control.json', { startedAt: startedControl, endedAt: new Date().toISOString(), inputProof, evidence: control });
    assert.equal(control.commands.length, 1);
    assert.ok(['passed', 'failed'].includes(control.commands[0].outcome), 'stop on unavailable/timeout control');
    assert.ok(control.commands[0].exitCode === null || Number.isFinite(control.commands[0].exitCode), 'retain numeric or null inner exit');
    return;
  }

  const { fixture: storedFixture } = JSON.parse(readFileSync(path.join(evidenceRoot, 'fixture.json'), 'utf8'));
  const { configuration, request: owned } = storedFixture;
  const { evidence: control } = JSON.parse(readFileSync(path.join(evidenceRoot, 'control.json'), 'utf8'));
  mkdirSync(storeRoot, { mode: 0o700 });
  const store = new FileToolOutputStore(storeRoot, { capacity: 1 });
  const startedCaptured = new Date().toISOString();
  const inputProof = verifyFixture(owned, configuration, storedFixture);
  const captured = await new ConfiguredLocalValidationAdapter({ ...configuration,
    commands: [{ ...configuration.commands[0], captureOutput: true }], outputStore: store,
  }).validate(owned);
  // Persist the full independent result before checking completeness or reading output.
  save('captured.json', { startedAt: startedCaptured, endedAt: new Date().toISOString(), inputProof, evidence: captured });
  inventoryStore();
  assert.equal(captured.commands.length, 1);
  const command = captured.commands[0];
  assert.ok(['passed', 'failed'].includes(command.outcome), 'stop on unavailable/timeout captured command');
  assert.ok(command.exitCode === null || Number.isFinite(command.exitCode), 'retain numeric or null inner exit');
  assert.equal(command.captureStatus, 'complete', 'partial/unavailable capture is incomplete diagnostic');
  assert.ok(command.output && !command.output.overflow.capture);
  const ranges = ['stdout', 'stderr'].map((channel) => readToolOutput(command.output, store, { channel, offset: 0, length: 16_384 }));
  save('captured.json', { startedAt: startedCaptured, endedAt: new Date().toISOString(), inputProof, evidence: captured,
    ranges, rawByteProof: 'original store files plus store-manifest.json; ranges are decoded text only' });
  const first = control.commands[0];
  save('comparison.json', { complete: true, controlStatus: control.status, capturedStatus: captured.status,
    sameStatus: control.status === captured.status, sameCommandOutcome: first.outcome === command.outcome,
    sameExitCode: first.exitCode === command.exitCode, acceptanceCredit: false });
}

try {
  await main();
} catch (error) {
  save('error.json', { error: String(error), stack: error.stack, complete: false });
  process.exitCode = 1;
} finally {
  childChannel.unsubscribe(observeChild);
  persistObservation();
  if (observationWriteFailed || !observation.bounded) process.exitCode = 1;
  try { if (mode === 'captured') inventoryStore(); }
  catch (error) {
    save('error.json', { error: String(error), stack: error.stack, complete: false });
    process.exitCode = 1;
  }
  // Keep original store bytes/metadata for the encrypted collector archive; no release/cleanup.
}
