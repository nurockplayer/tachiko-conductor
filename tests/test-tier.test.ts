import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  environmentForTier,
  isolatedExcludedTests,
  selectTests,
  tsxInvocation,
} from '../scripts/test-tier.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturePreload = new URL('./fixtures/account-home-preload.mjs', import.meta.url).href;
const isolatedLockPreload = new URL('./fixtures/isolated-lock-preload.mjs', import.meta.url).href;
const isolatedFixturePreload = new URL('./fixtures/account-home-preload.mjs?isolated=kernel-ids-v1', import.meta.url).href;

describe('test tier runner', () => {
  it('uses Node with the tsx JavaScript entry point instead of a platform shim', () => {
    assert.deepEqual(tsxInvocation('/repo'), {
      command: process.execPath,
      arguments: [path.join('/repo', 'node_modules', 'tsx', 'dist', 'cli.mjs')],
    });
  });

  it('sets smoke opt-in flags inside the cross-platform runner environment', () => {
    assert.deepEqual(environmentForTier('smoke:codex', { PATH: '/bin' }), {
      PATH: '/bin',
      TACHIKO_CODEX_SMOKE: '1',
    });
    assert.deepEqual(environmentForTier('unit', { PATH: '/bin' }), { PATH: '/bin' });
  });

  it('replaces inherited Node options with the sole fixed account and lock fixture only for isolated tests', () => {
    const inherited = { PATH: '/bin', HOME: '/fixture', NODE_OPTIONS: '--import=/untrusted-preload.mjs --inspect' };
    assert.deepEqual(environmentForTier('isolated', inherited), {
      ...inherited, NODE_OPTIONS: `--import=${isolatedLockPreload}`,
    });
    assert.equal(inherited.NODE_OPTIONS, '--import=/untrusted-preload.mjs --inspect');
    for (const tier of ['unit', 'integration', 'smoke:claude', 'smoke:codex', 'smoke:worker-router', 'smoke:browser-agent']) {
      assert.equal(environmentForTier(tier, inherited).NODE_OPTIONS, inherited.NODE_OPTIONS);
    }
  });

  it('propagates the captured fixture account through real tsx test workers and fresh Node children', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-worker-'));
    const home = path.join(directory, 'home');
    mkdirSync(home, { mode: 0o700 });
    try {
      const worker = path.join(directory, 'account.test.ts');
      const completion = path.join(directory, 'worker-complete');
      writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
      writeFileSync(worker, `
import assert from 'node:assert/strict';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { it } from 'node:test';
it('keeps the initial fixture account across worker and fresh child HOME mutations', () => {
  const typedFixture: string = ${JSON.stringify(home)};
  assert.ok(process.env.NODE_TEST_CONTEXT, 'fixture must execute in an actual Node test worker');
  assert.equal(os.userInfo().homedir, typedFixture);
  if (process.getuid) assert.equal(os.userInfo().uid, process.getuid());
  const fixtureUserInfo = os.userInfo;
  process.env.HOME = typedFixture + '-later-home';
  assert.equal(os.userInfo().homedir, typedFixture, 'capture precedes later HOME mutation');
  try {
    os.userInfo = (() => ({ ...fixtureUserInfo(), homedir: typedFixture + '-case-account' })) as typeof os.userInfo;
    assert.equal(os.userInfo().homedir, typedFixture + '-case-account');
  } finally { os.userInfo = fixtureUserInfo; }
  assert.equal(os.userInfo().homedir, typedFixture, 'per-case restore retains the fixture');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(`import assert from 'node:assert/strict';import os from 'node:os';const home=${JSON.stringify(home)};assert.equal(os.userInfo().homedir,home);if(process.getuid)assert.equal(os.userInfo().uid,process.getuid());process.env.HOME=home+'-child-mutation';assert.equal(os.userInfo().homedir,home);console.log('FIXTURE_CHILD_OK');`)}], {
    env: { ...process.env, HOME: typedFixture }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /FIXTURE_CHILD_OK/);
  writeFileSync(${JSON.stringify(completion)}, 'FIXTURE_WORKER_OK');
});
`);
      const invocation = tsxInvocation(root);
      const environment = environmentForTier('isolated', { ...process.env, HOME: home, NODE_OPTIONS: '--import=/must-not-be-loaded.mjs' });
      // This is a fresh test coordinator, not the enclosing test worker.
      delete environment.NODE_TEST_CONTEXT;
      const result = spawnSync(invocation.command, [...invocation.arguments, '--test', '--test-concurrency=1', worker], {
        cwd: root, env: environment,
        encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(readFileSync(completion, 'utf8'), 'FIXTURE_WORKER_OK');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps the exact lock delegate synchronous and guarded in tsx workers and fresh children', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-lock-'));
    const home = path.join(directory, 'home');
    mkdirSync(home, { mode: 0o700 });
    const target = new URL('../src/dispatch/invocation-lock.ts', import.meta.url).href;
    const alias = new URL('../src/dispatch/invocation-lock.js', import.meta.url).href;
    const bystander = new URL('../src/account-home.ts', import.meta.url).href;
    // Real built output is verified separately after building in an owned
    // scratch context; this pre-build worker requires source only.
    const proof = `
const assert = (await import('node:assert/strict')).default;
const fs = await import('node:fs');
const { createHash } = await import('node:crypto');
const target = ${JSON.stringify(target)};
await assert.rejects(import(target + '?tachiko-test-lock-original=1'));
await assert.rejects(import(${JSON.stringify(alias)} + '?tachiko-test-lock-original=1'));
const lock = await import(target);
const alias = await import(${JSON.stringify(alias)});
assert.equal(alias.acquireDispatchInvocationLock, lock.acquireDispatchInvocationLock);
assert.equal(alias.DispatchInvocationLockedError, lock.DispatchInvocationLockedError);
const bystander = await import(${JSON.stringify(bystander)});
assert.equal(typeof bystander.resolveAccountHomeDirectory, 'function');
assert.equal(bystander.acquireDispatchInvocationLock, undefined);
const lockPath = ${JSON.stringify(path.join(directory, 'once.lock'))};
const read = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const first = lock.acquireDispatchInvocationLock({ lockPath, nonce: () => 'simulated-owner' });
try {
  assert.equal(typeof first.release, 'function');
  assert.equal(first.then, undefined, 'delegate must not return a Promise');
  const record = read();
  assert.equal(record.processStartId, 'simulated-start:' + process.pid);
  assert.equal(record.hostId, createHash('sha256').update('tachiko isolated TEST host').digest('hex'));
  // Deliberately different untrusted simulated values cannot establish PID reuse.
  fs.writeFileSync(lockPath, JSON.stringify({ ...record, processStartId: 'simulated-start:different' }));
  assert.throws(() => lock.acquireDispatchInvocationLock({ lockPath }), lock.DispatchInvocationLockedError);
  assert.equal(read().nonce, record.nonce, 'real live PID remains fenced');
  fs.writeFileSync(lockPath, JSON.stringify(record));
} finally { first.release(); }
const explicit = { hostId: 'a'.repeat(64), bootId: 'b'.repeat(64) };
const calls = [];
const supplied = lock.acquireDispatchInvocationLock({ lockPath,
  hostBootIdentity: () => { calls.push('host'); return explicit; },
  processStartIdentity: (pid) => { calls.push(pid); return 'explicit-start'; },
});
try { assert.equal(read().hostId, explicit.hostId); assert.equal(read().processStartId, 'explicit-start'); assert.deepEqual(calls, ['host', process.pid]); }
finally { supplied.release(); }
const sentinel = new Error('explicit identity failure');
assert.throws(() => lock.acquireDispatchInvocationLock({ lockPath, hostBootIdentity: () => { throw sentinel; } }), (error) => error === sentinel);
assert.throws(() => lock.acquireDispatchInvocationLock({ lockPath, processStartIdentity: () => null }), /valid owner incarnation/);
// Null reaches the real native default. A supported host can succeed; a
// restricted host must preserve its actual identity error rather than simulate.
for (const key of ['hostBootIdentity', 'processStartIdentity']) {
  let native;
  try {
    native = lock.acquireDispatchInvocationLock({ lockPath, [key]: null });
    if (key === 'hostBootIdentity') assert.notEqual(read().hostId, createHash('sha256').update('tachiko isolated TEST host').digest('hex'));
    else assert.doesNotMatch(read().processStartId, /^simulated-start:/);
  } catch (error) {
    assert.match(error.message, /Dispatch invocation lock (could not establish|requires a supported)/);
  } finally { native?.release(); }
}
await assert.rejects(import(target + '?tachiko-test-lock-original=1'), /original-module bypass/);
await assert.rejects(import(target + '?unrecognized=1'), /original-module bypass/);
await assert.rejects(import(${JSON.stringify(alias)} + '?tachiko-test-lock-original=1'), /original-module bypass/);
await assert.rejects(import(target + '#unrecognized'), /original-module bypass/);
console.log('LOCK_DELEGATE_PROOF_OK');
`;
    try {
      const worker = path.join(directory, 'lock.test.ts');
      const completion = path.join(directory, 'complete');
      writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}\n');
      writeFileSync(worker, `import { it } from 'node:test';import { writeFileSync } from 'node:fs';it('real tsx lock worker', async () => {${proof}\nwriteFileSync(${JSON.stringify(completion)}, 'ok');});`);
      const environment = environmentForTier('isolated', { ...process.env, HOME: home });
      delete environment.NODE_TEST_CONTEXT;
      const invocation = tsxInvocation(root);
      const workerResult = spawnSync(invocation.command, [...invocation.arguments, '--test', '--test-concurrency=1', worker], {
        cwd: root, env: environment, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(workerResult.error, undefined);
      assert.equal(workerResult.status, 0, workerResult.stdout + workerResult.stderr);
      assert.equal(readFileSync(completion, 'utf8'), 'ok');
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', proof], {
        cwd: root, env: environment, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, /LOCK_DELEGATE_PROOF_OK/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps unavailable native defaults fail-closed without the fixture and passes explicit null through it', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-native-default-'));
    const target = new URL('../src/dispatch/invocation-lock.ts', import.meta.url).href;
    try {
      for (const isolated of [false, true]) {
        const source = `
import assert from 'node:assert/strict';
const { acquireDispatchInvocationLock } = await import(${JSON.stringify(target)});
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  // A child-local unsupported-platform control makes real defaults unavailable
  // without replacing a builtin, process probe or production implementation.
  Object.defineProperty(process, 'platform', { value: 'unsupported-test' });
  assert.throws(() => acquireDispatchInvocationLock({ lockPath: ${JSON.stringify(path.join(directory, 'once.lock'))}, ${isolated ? 'hostBootIdentity: null,' : ''} }),
    /requires a supported host identity source/);
  console.log('REAL_DEFAULT_IDENTITY_REJECTED');
} finally { Object.defineProperty(process, 'platform', originalPlatform); }
`;
        const environment = isolated
          ? environmentForTier('isolated', { ...process.env, HOME: directory })
          : { ...process.env, HOME: directory, NODE_OPTIONS: '' };
        const result = spawnSync(process.execPath, [...(isolated ? [] : ['--import', isolatedFixturePreload]), '--import', 'tsx', '--input-type=module', '-e', source], {
          cwd: root, env: environment, encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /REAL_DEFAULT_IDENTITY_REJECTED/);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps default-mode userInfo arguments and original errors delegated without a native passwd lookup', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-delegation-'));
    try {
      const source = `
import assert from 'node:assert/strict';
import os from 'node:os';
const originalUserInfo = os.userInfo;
const original = { uid: process.getuid(), gid: process.getgid(), username: 'observed-test-account', homedir: '/observed-test-home', shell: '/test-fixture-shell' };
let observedArguments;
let failure;
os.userInfo = (...args) => { observedArguments = args; if (failure) throw failure; return { ...original }; };
try {
  await import(${JSON.stringify(fixturePreload)});
  const options = { encoding: 'utf8' };
  const actual = os.userInfo(options);
  assert.equal(actual.uid, original.uid);
  assert.equal(actual.gid, original.gid);
  assert.equal(actual.username, original.username);
  assert.equal(actual.homedir, ${JSON.stringify(directory)});
  assert.equal(observedArguments[0], options);
  failure = Object.assign(new Error('original account lookup failed'), { code: 'ERR_SYSTEM_ERROR' });
  assert.throws(() => os.userInfo(), (error) => error === failure);
  console.log('FIXTURE_DELEGATION_OK');
} finally { os.userInfo = originalUserInfo; }
`;
      // This separate control installs an observed original before explicitly
      // importing the unchanged fixture, rather than inheriting a prior preload.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, HOME: directory, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /FIXTURE_DELEGATION_OK/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses only captured kernel identity in explicit mode when original userInfo always throws', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-kernel-'));
    try {
      const source = `
import assert from 'node:assert/strict';
import os from 'node:os';
const originalUserInfo = os.userInfo;
const kernel = { uid: process.getuid(), effectiveUid: process.geteuid(), gid: process.getgid(), effectiveGid: process.getegid() };
let originalCalls = 0;
os.userInfo = () => { originalCalls += 1; throw new Error('passwd must not be consulted'); };
try {
  await import(${JSON.stringify(isolatedFixturePreload)});
  assert.equal(originalCalls, 0);
  const account = os.userInfo();
  assert.equal(account.uid, kernel.uid);
  assert.equal(account.uid, kernel.effectiveUid);
  assert.equal(account.gid, kernel.gid);
  assert.equal(account.gid, kernel.effectiveGid);
  assert.equal(account.homedir, ${JSON.stringify(directory)});
  assert.equal(account.username, 'tachiko-isolated-test-account');
  assert.equal(account.shell, '/test-fixture-shell');
  assert.deepEqual(os.userInfo({ encoding: 'utf8' }), account);
  assert.throws(() => os.userInfo({ encoding: 'buffer' }), /supports only default or utf8/);
  assert.throws(() => os.userInfo({ unexpected: true }), /supports only default or utf8/);
  process.env.HOME = ${JSON.stringify(directory)} + '-later-home';
  assert.deepEqual(os.userInfo(), account);
  assert.equal(originalCalls, 0);
  console.log('FIXTURE_KERNEL_ONLY_OK');
} finally { os.userInfo = originalUserInfo; }
`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, HOME: directory, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /FIXTURE_KERNEL_ONLY_OK/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects missing, inconsistent or invalid kernel identity and non-absolute fixture HOME', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-kernel-negative-'));
    const cases = [
      ...['getuid', 'geteuid', 'getgid', 'getegid'].map((name) => ({ label: `missing ${name}`, setup: `process.${name} = undefined;`, home: directory, expected: 'requires kernel UID and GID functions' })),
      { label: 'UID mismatch', setup: 'process.geteuid = () => process.getuid() + 1;', home: directory, expected: 'requires matching real and effective kernel IDs' },
      { label: 'GID mismatch', setup: 'process.getegid = () => process.getgid() + 1;', home: directory, expected: 'requires matching real and effective kernel IDs' },
      ...['-1', 'NaN', 'Infinity', '1.5', 'Number.MAX_SAFE_INTEGER + 1'].map((value) => ({ label: `invalid ${value}`, setup: `process.getuid = () => ${value};`, home: directory, expected: 'requires safe nonnegative kernel IDs' })),
      { label: 'missing HOME', setup: '', home: '', expected: 'requires an absolute private HOME' },
      { label: 'relative HOME', setup: '', home: 'relative-fixture-home', expected: 'requires an absolute private HOME' },
    ];
    try {
      for (const fixture of cases) {
        const source = `
import assert from 'node:assert/strict';
import os from 'node:os';
const originalUserInfo = os.userInfo;
const identityMethods = ['getuid', 'geteuid', 'getgid', 'getegid'];
const originals = identityMethods.map((name) => Object.getOwnPropertyDescriptor(process, name));
let originalCalls = 0;
os.userInfo = () => { originalCalls += 1; throw new Error('passwd must not be consulted'); };
try {
  ${fixture.setup}
  await assert.rejects(import(${JSON.stringify(isolatedFixturePreload)}), (error) => error.message.includes(${JSON.stringify(fixture.expected)}));
  assert.equal(originalCalls, 0);
  console.log('FIXTURE_KERNEL_REJECTED');
} finally {
  os.userInfo = originalUserInfo;
  for (let index = 0; index < identityMethods.length; index += 1) {
    if (originals[index]) Object.defineProperty(process, identityMethods[index], originals[index]);
    else delete process[identityMethods[index]];
  }
}
`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
          env: { ...process.env, HOME: fixture.home, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(result.error, undefined, fixture.label);
        assert.equal(result.status, 0, `${fixture.label}: ${result.stderr}`);
        assert.match(result.stdout, /FIXTURE_KERNEL_REJECTED/, fixture.label);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps the actual production account resolver fail-closed when userInfo throws despite existing HOME', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-production-identity-'));
    try {
      const source = `
import assert from 'node:assert/strict';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { resolveAccountHomeDirectory } from ${JSON.stringify(new URL('../src/account-home.ts', import.meta.url).href)};
const originalUserInfo = os.userInfo;
try {
  assert.equal(existsSync(process.env.HOME), true);
  os.userInfo = () => { throw Object.assign(new Error('forced passwd failure'), { code: 'ERR_SYSTEM_ERROR' }); };
  assert.throws(() => resolveAccountHomeDirectory(), { message: 'Cannot resolve the physical home directory for the effective OS account.' });
  console.log('PRODUCTION_ACCOUNT_REJECTED');
} finally { os.userInfo = originalUserInfo; }
`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        env: { ...process.env, HOME: directory, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PRODUCTION_ACCOUNT_REJECTED/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps integration and smoke files out while full unit retains browser tests', () => {
    const files = [
      'browser-runtime-integration.test.ts',
      'claude-code-smoke.test.ts',
      'codex-cli-smoke.test.ts',
      'browser-agent-smoke.test.ts',
      'browser-bootstrap-client.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'local-command-sandbox.test.ts',
      'workflow.test.ts',
    ];
    assert.deepEqual(selectTests('unit', files), [
      'browser-bootstrap-client.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'local-command-sandbox.test.ts',
      'workflow.test.ts',
    ]);
    assert.deepEqual(selectTests('integration', files), ['browser-runtime-integration.test.ts']);
    assert.deepEqual(selectTests('smoke:claude', files), ['claude-code-smoke.test.ts']);
  });

  it('uses the explicit host-only exclusion list for the isolated tier', () => {
    assert.deepEqual(isolatedExcludedTests, [
      'browser-bootstrap-client.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'local-command-sandbox.test.ts',
    ]);

    const files = [
      'browser-runtime-integration.test.ts',
      'claude-code-smoke.test.ts',
      'browser-bootstrap-client.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'local-command-sandbox.test.ts',
      'workflow.test.ts',
      'other-network.test.ts',
    ];
    assert.deepEqual(selectTests('isolated', files), ['workflow.test.ts', 'other-network.test.ts']);
  });
});
