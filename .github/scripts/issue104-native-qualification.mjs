import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { Q_ROOT: root, Q_CANDIDATE: candidate, Q_NODE: node, Q_PNPM: pnpm, Q_GIT: git,
  Q_EXPECTED_SHA: expectedHead, Q_EXPECTED_TREE: expectedTree } = process.env;
for (const value of [root, candidate, node, pnpm, git]) assert.ok(path.isAbsolute(value));
assert.equal(process.platform, 'darwin');
assert.equal(process.version, 'v24.21.0');
// Discard only the observed Darwin startup metadata, never admit it as input.
const removedDarwinTextEncoding = Object.hasOwn(process.env, '__CF_USER_TEXT_ENCODING');
delete process.env.__CF_USER_TEXT_ENCODING;
const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'Q_ROOT', 'Q_CANDIDATE', 'Q_NODE', 'Q_PNPM', 'Q_GIT', 'Q_EXPECTED_SHA', 'Q_EXPECTED_TREE']);
assert.deepEqual(Object.keys(process.env).filter((key) => !allowed.has(key)), []);
console.log('VALIDATION_STARTUP ' + JSON.stringify({ removedDarwinTextEncoding, environmentKeys: Object.keys(process.env).sort() }));
const gitEnv = { PATH: path.dirname(node) + ':/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, env: gitEnv, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, JSON.stringify({ program, args, status: result.status, signal: result.signal, stderr: result.stderr }));
  assert.equal(result.signal, null);
  return result.stdout.trim();
}
function gitAt(directory, args) { return command(git, ['-C', directory, ...args]); }
function sha(data) { return createHash('sha256').update(data).digest('hex'); }
// Public receipts bind complete private manifests without oversized log lines.
function manifestSummary(manifest) {
  if (!Array.isArray(manifest)) return null;
  const rootCounts = { dist: 0, node_modules: 0, 'apps/control-tower/node_modules': 0, other: 0, malformed: 0 };
  for (const entry of manifest) {
    const match = typeof entry === 'string' ? /^(?:file|link|directory) (.+) [0-7]+ [a-f0-9]{64}$/i.exec(entry) : null;
    if (match === null) { rootCounts.malformed += 1; continue; }
    const root = ['dist', 'node_modules', 'apps/control-tower/node_modules'].find((name) => match[1] === name || match[1].startsWith(name + '/'));
    rootCounts[root ?? 'other'] += 1;
  }
  return { entryCount: manifest.length, sha256: sha(JSON.stringify(manifest)), rootCounts };
}
function fingerprint(directory) {
  let entries = 0; let bytes = 0;
  function walk(current) {
    assert.ok(++entries < 100_000, 'host artifact entry budget');
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return ['link', stat.mode, fs.readlinkSync(current)];
    if (stat.isFile()) { bytes += stat.size; assert.ok(bytes < 512 * 1024 * 1024, 'host artifact byte budget'); return ['file', stat.mode, stat.size, sha(fs.readFileSync(current))]; }
    assert.ok(stat.isDirectory(), 'regular artifact tree only');
    return ['dir', stat.mode, fs.readdirSync(current).sort().map((name) => [name, walk(path.join(current, name))])];
  }
  return { sha256: sha(JSON.stringify(walk(directory))), entries, bytes };
}
const validation = await import(pathToFileURL(path.join(candidate, 'dist/validation/local-command.js')));
const policy = await import(pathToFileURL(path.join(candidate, 'dist/production-policy.js')));
assert.equal(policy.PRODUCTION_POLICY_REVISION, 'issue-104-production-v7');
assert.equal(gitAt(candidate, ['rev-parse', 'HEAD']), expectedHead);
assert.equal(gitAt(candidate, ['rev-parse', 'HEAD^{tree}']), expectedTree);
assert.equal(gitAt(candidate, ['status', '--porcelain', '--untracked-files=no']), '');
assert.ok(validation.hasSupportedProductionGitRuntime('/usr/bin/git'));
assert.ok(validation.hasSupportedProductionGitRuntime(git));
assert.equal(command(pnpm, ['--version'], root), '10.34.5');
const artifact = path.join(root, 'artifact');
const lockSha = sha(fs.readFileSync(path.join(candidate, 'pnpm-lock.yaml')));
assert.equal(fs.readFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), 'utf8').trim(), lockSha);
const binding = JSON.parse(fs.readFileSync(path.join(artifact, 'candidate.json'), 'utf8'));
assert.deepEqual(binding, { head: expectedHead, tree: expectedTree, lockSha256: lockSha });
const artifactBefore = fingerprint(artifact);
const reports = [];
// One diagnostic-only fixture prerequisite, never the full four-command gate.
const focusCode = "import { spawnSync } from 'node:child_process'; import { environmentForTier, tsxInvocation } from './scripts/test-tier.mjs'; const tsx = tsxInvocation(process.cwd()); const result = spawnSync(tsx.command, [...tsx.arguments, '--test', '--test-concurrency=2', 'tests/account-home.test.ts', 'tests/mission-admission.test.ts', 'tests/store.test.ts'], { cwd: process.cwd(), env: environmentForTier('isolated'), stdio: 'inherit' }); if (result.error !== undefined) throw result.error; process.exitCode = result.status ?? 1;";
for (const mode of ['owned-request']) {
  const workspace = path.join(root, mode);
  command(git, ['clone', '--no-local', '--no-checkout', candidate, workspace]);
  gitAt(workspace, ['checkout', '--detach', expectedHead]);
  gitAt(workspace, ['remote', 'set-url', 'origin', 'https://github.com/nurockplayer/tachiko-conductor.git']);
  const authority = { path: workspace, gitDir: path.join(workspace, '.git') };
  const before = await validation.ignoredManifest(authority, git, { nodeProgram: node });
  assert.deepEqual(before, [], 'fresh entry has no worker ignored authority');
  const cleanups = [];
  // Read-only observation at the existing cleanup test seam, followed by the
  // unchanged exported production cleanup implementation for every call.
  async function observeCleanup(paths) {
    const receipt = { paths: [...paths], snapshots: [], privateStores: [] };
    try {
      for (const privateRoot of paths) {
        const privateStore = path.join(privateRoot, 'store');
        if (fs.existsSync(privateStore)) {
          const stat = fs.lstatSync(privateStore);
          fs.accessSync(privateStore, fs.constants.W_OK);
          receipt.privateStores.push({ path: privateStore, directory: stat.isDirectory(), symlink: stat.isSymbolicLink(), uid: stat.uid, writable: true, distinctFromTrusted: fs.realpathSync(privateStore) !== fs.realpathSync(path.join(artifact, 'store')) });
        }
        const commandWorkspace = path.join(privateRoot, 'workspace');
        const metadata = path.join(privateRoot, 'git');
        if (fs.existsSync(commandWorkspace) && fs.existsSync(metadata)) {
          receipt.snapshots.push({ workspace: commandWorkspace,
            head: command(git, ['--git-dir=' + metadata, '--work-tree=' + commandWorkspace, 'rev-parse', 'HEAD']),
            tree: command(git, ['--git-dir=' + metadata, '--work-tree=' + commandWorkspace, 'rev-parse', 'HEAD^{tree}']),
            manifest: await validation.ignoredManifest({ path: commandWorkspace, gitDir: metadata }, git, { nodeProgram: node }) });
        }
      }
    } catch (error) { receipt.observationError = String(error); }
    receipt.cleaned = await validation.disposePrivateTrees(paths);
    receipt.absentAfter = paths.every((entry) => !fs.existsSync(entry));
    cleanups.push(receipt);
    return receipt.cleaned;
  }
  const commands = [
    { ...policy.PRODUCTION_LOCAL_VALIDATION_CONFIG.commands[0], argv: [pnpm, ...policy.PRODUCTION_LOCAL_VALIDATION_CONFIG.commands[0].argv.slice(1)] },
    { argv: [pnpm, 'exec', 'node', '--input-type=module', '-e', focusCode], timeoutMs: 300_000 },
  ];
  const configuration = { revision: policy.PRODUCTION_POLICY_REVISION, commands, nodeProgram: node, pnpmProgram: pnpm, gitProgram: git,
    dependencyArtifactPath: artifact, playwrightBrowsersPath: path.join(root, 'browsers'),
    hydratedDependencyRoots: policy.PRODUCTION_LOCAL_VALIDATION_CONFIG.hydratedDependencyRoots,
    terminalGeneratedIgnoredRoots: [],
    ...(mode === 'configured-preexisting-pr' ? { workspacePath: workspace } : {}) };
  const request = { target: { kind: 'issue', owner: 'nurockplayer', repo: 'tachiko-conductor', issueNumber: 104 }, headSha: expectedHead,
    ...(mode === 'owned-request' ? { workspacePath: workspace } : {}) };
  const evidence = await new validation.ConfiguredLocalValidationAdapter(configuration, undefined, observeCleanup).validate(request);
  const after = await validation.ignoredManifest(authority, git, { nodeProgram: node });
  const report = { diagnosticOnly: true, mode, head: expectedHead, tree: expectedTree, lockSha256: lockSha, environmentKeys: Object.keys(process.env).sort(),
    configuredPrograms: { node, pnpm, git }, commands, admittedDependencyRoots: configuration.hydratedDependencyRoots,
    terminalGeneratedIgnoredRoots: configuration.terminalGeneratedIgnoredRoots, initialIgnoredManifest: before, finalEntryIgnoredManifest: after,
    evidence, cleanups, artifactBefore, artifactAfter: fingerprint(artifact) };
  reports.push(report);
  fs.writeFileSync(path.join(root, mode + '.json'), JSON.stringify(report, null, 2));
  const publicReport = { ...report,
    initialIgnoredManifest: manifestSummary(before), finalEntryIgnoredManifest: manifestSummary(after),
    cleanups: cleanups.map((entry) => ({ ...entry,
      snapshots: entry.snapshots.map((snapshot) => ({ ...snapshot, manifest: manifestSummary(snapshot.manifest) })) })),
  };
  const publicLine = 'FIXTURE_FOCUS_RECEIPT ' + JSON.stringify(publicReport) + '\n';
  assert.ok(Buffer.byteLength(publicLine, 'utf8') <= 16 * 1024, 'bounded complete public receipt');
  await new Promise((resolve, reject) => process.stdout.write(publicLine, (error) => error ? reject(error) : resolve()));
  assert.equal(evidence.status, 'passed', mode);
  assert.equal(evidence.commands.length, 2);
  assert.ok(evidence.commands.every((entry, index) => entry.commandIndex === index && entry.outcome === 'passed' && entry.exitCode === 0));
  assert.deepEqual(after, []);
  assert.equal(gitAt(workspace, ['rev-parse', 'HEAD']), expectedHead);
  assert.equal(gitAt(workspace, ['status', '--porcelain', '--untracked-files=all']), '');
  assert.ok(cleanups.length > 0 && cleanups.every((entry) => entry.cleaned && entry.absentAfter && !entry.observationError));
  const privateStores = cleanups.flatMap((entry) => entry.privateStores);
  assert.equal(privateStores.length, 1);
  assert.ok(privateStores.every((entry) => entry.directory && !entry.symlink && entry.uid === process.getuid() && entry.writable && entry.distinctFromTrusted));
  const snapshots = cleanups.flatMap((entry) => entry.snapshots);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].head, expectedHead);
  assert.equal(snapshots[0].tree, expectedTree);
  const manifest = snapshots[0].manifest;
  assert.ok(Array.isArray(manifest) && manifest.length > 0);
  const roots = new Set(manifest.map((entry) => entry.replace(/^(file|link|directory) /, '').replace(/ [0-7]+ [a-f0-9]{64}$/i, '')));
  assert.ok(![...roots].some((entry) => entry === 'dist' || entry.startsWith('dist/')), 'focus never runs build');
  assert.ok([...roots].every((entry) => ['dist', 'node_modules', 'apps/control-tower/node_modules'].some((admitted) => entry === admitted || entry.startsWith(admitted + '/'))));
  assert.deepEqual(report.artifactAfter, artifactBefore, 'trusted private artifact unchanged');
}
console.log('FIXTURE_FOCUS_COMPLETE ' + JSON.stringify({ diagnosticOnly: true, head: expectedHead, tree: expectedTree, adapterModes: reports.map((entry) => entry.mode), artifact: artifactBefore, compiledValidatorSha256: sha(fs.readFileSync(path.join(candidate, 'dist/validation/local-command.js'))) }));
