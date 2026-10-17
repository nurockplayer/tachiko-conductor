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

  it('replaces inherited Node options with the sole fixed account fixture only for isolated tests', () => {
    const inherited = { PATH: '/bin', HOME: '/fixture', NODE_OPTIONS: '--import=/untrusted-preload.mjs --inspect' };
    assert.deepEqual(environmentForTier('isolated', inherited), {
      ...inherited, NODE_OPTIONS: `--import=${fixturePreload}`,
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

  it('keeps original userInfo UID, arguments and errors delegated by the existing fixture', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'tachiko-tier-delegation-'));
    try {
      const source = `
import assert from 'node:assert/strict';
import os from 'node:os';
const originalUserInfo = os.userInfo;
const original = originalUserInfo();
let observedArguments;
let failure;
os.userInfo = (...args) => { observedArguments = args; if (failure) throw failure; return originalUserInfo(...args); };
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
