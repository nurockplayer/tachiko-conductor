import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PRODUCTION_EXECUTION_PROFILE_CONFIG,
  PRODUCTION_HOSTED_CHECK_POLICY_CONFIG,
  PRODUCTION_LOCAL_VALIDATION_CONFIG,
  PRODUCTION_NODE_ENGINE_RANGE,
  PRODUCTION_NODE_MIN_VERSION,
  PRODUCTION_POLICY_REVISION,
  isSupportedProductionNodeVersion,
  preflightProductionPolicy,
} from '../src/production-policy.js';

function environment(home: string): NodeJS.ProcessEnv {
  const artifact = path.join(path.dirname(home), 'dependency-artifact');
  mkdirSync(path.join(artifact, 'store'), { recursive: true });
  writeFileSync(path.join(artifact, 'pnpm-lock.yaml.sha256'), '0'.repeat(64));
  return {
    TACHIKO_NODE_PROGRAM: process.execPath,
    TACHIKO_PNPM_PROGRAM: process.execPath,
    TACHIKO_GIT_PROGRAM: process.execPath,
    TACHIKO_PNPM_DEPENDENCY_ARTIFACT: artifact,
    TACHIKO_LUNA_CODEX_HOME: home,
    TACHIKO_PLAYWRIGHT_BROWSERS_PATH: path.dirname(home),
    TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify(PRODUCTION_EXECUTION_PROFILE_CONFIG),
    TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify(PRODUCTION_LOCAL_VALIDATION_CONFIG),
    TACHIKO_HOSTED_CHECK_POLICY_CONFIG: JSON.stringify(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG),
  };
}

const supportedGitRuntime = (_program: string): boolean => true;
const supportedNodeRuntime = (_program: string): boolean => true;

describe('#104 production policy', () => {
  it('uses the real credential-free CLT qualifier by default', { skip: process.platform !== 'darwin' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-git-'));
    try {
      const home = path.join(root, 'luna');
      mkdirSync(home);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const wrapper = path.join(root, 'configured-vcs');
      writeFileSync(wrapper, '#!/bin/sh\nexec /Library/Developer/CommandLineTools/usr/bin/git "$@"\n', { mode: 0o700 });
      const unsupported = path.join(root, 'unsupported-vcs');
      writeFileSync(unsupported, '#!/bin/sh\necho /unqualified/git-core\n', { mode: 0o700 });
      const env = environment(home);
      for (const git of ['/Library/Developer/CommandLineTools/usr/bin/git', '/usr/bin/git', wrapper]) {
        assert.equal(preflightProductionPolicy({ ...env, TACHIKO_GIT_PROGRAM: git }).revision, PRODUCTION_POLICY_REVISION);
      }
      assert.throws(() => preflightProductionPolicy({ ...env, TACHIKO_GIT_PROGRAM: unsupported }), /supported Apple Command Line Tools Git runtime/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const authority of ['TACHIKO_NODE_PROGRAM', 'TACHIKO_PNPM_PROGRAM', 'TACHIKO_GIT_PROGRAM']) {
    it(`requires ${authority} to be an absolute regular executable file in preflight and shell policy`, () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-tools-'));
      try {
        const home = path.join(root, 'luna');
        mkdirSync(home);
        writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
        const executable = path.join(root, 'tool');
        const nonExecutable = path.join(root, 'not-executable');
        const symlink = path.join(root, 'tool-link');
        const directoryLink = path.join(root, 'directory-link');
        const missing = path.join(root, 'missing');
        const danglingLink = path.join(root, 'dangling-link');
        writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
        symlinkSync(executable, symlink);
        symlinkSync(home, directoryLink);
        symlinkSync(missing, danglingLink);
        const env = environment(home);
        for (const candidate of [root, directoryLink, nonExecutable, missing, danglingLink, 'relative-tool']) {
          const supplied = { ...env, [authority]: candidate };
          assert.throws(() => preflightProductionPolicy(supplied, supportedGitRuntime), new RegExp(`${authority}.*absolute regular executable file`));
          const sourced = spawnSync('/bin/sh', ['-c', '. "$1"', 'sh', path.resolve('scripts/issue-104-production-policy.sh')], { encoding: 'utf8', env: supplied });
          assert.equal(sourced.status, 78, `${authority}=${candidate}: ${sourced.stderr}`);
          assert.match(sourced.stderr, new RegExp(authority));
        }
        for (const candidate of [executable, symlink]) {
          const supplied = { ...env, [authority]: candidate };
          assert.equal(preflightProductionPolicy(
            supplied,
            supportedGitRuntime,
            authority === 'TACHIKO_NODE_PROGRAM' ? supportedNodeRuntime : undefined,
          ).revision, PRODUCTION_POLICY_REVISION);
          const sourced = spawnSync('/bin/sh', ['-c', '. "$1"', 'sh', path.resolve('scripts/issue-104-production-policy.sh')], { encoding: 'utf8', env: supplied });
          assert.equal(sourced.status, 0, sourced.stderr);
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it('pins the latest Node 24 LTS runtime contract', () => {
    const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { engines?: { node?: string } };
    assert.equal(PRODUCTION_NODE_MIN_VERSION, '24.21.0');
    assert.equal(PRODUCTION_NODE_ENGINE_RANGE, '>=24.21.0 <25');
    assert.equal(manifest.engines?.node, PRODUCTION_NODE_ENGINE_RANGE);
    assert.equal(readFileSync(path.resolve('.node-version'), 'utf8').trim(), PRODUCTION_NODE_MIN_VERSION);
    assert.equal(isSupportedProductionNodeVersion('v24.21.0'), true);
    assert.equal(isSupportedProductionNodeVersion('24.22.3'), true);
    assert.equal(isSupportedProductionNodeVersion('v24.20.9'), false);
    assert.equal(isSupportedProductionNodeVersion('v23.99.0'), false);
    assert.equal(isSupportedProductionNodeVersion('v25.0.0'), false);
  });

  it('rejects a production Node runtime outside the pinned LTS line', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-node-'));
    try {
      const home = path.join(root, 'luna');
      mkdirSync(home);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const env = environment(home);
      assert.throws(
        () => preflightProductionPolicy(env, supportedGitRuntime, () => false),
        /Node\.js 24\.21\.0 LTS or newer 24\.x runtime/,
      );
      assert.equal(preflightProductionPolicy(env, supportedGitRuntime, supportedNodeRuntime).revision, PRODUCTION_POLICY_REVISION);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('declares hosted checks explicitly not_required with no required context', () => {
    assert.deepEqual(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG, {
      revision: PRODUCTION_POLICY_REVISION,
      mode: 'not_required',
    });
  });

  it('preflights a revisioned routine-only Luna and model-free pnpm policy without provider activity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      mkdirSync(path.join(root, 'luna'));
      writeFileSync(path.join(root, 'luna', 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      assert.deepEqual(preflightProductionPolicy(environment(path.join(root, 'luna')), supportedGitRuntime), {
        revision: PRODUCTION_POLICY_REVISION, lunaCodexHome: path.join(root, 'luna'),
        checks: ['execution-profile', 'luna-home', 'playwright-browsers', 'dependency-artifact', 'local-validation', 'hosted-check-policy'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported Git runtime before activation and qualifies only the configured Git path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      const home = path.join(root, 'luna');
      mkdirSync(home);
      writeFileSync(path.join(home, 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const env = environment(home);
      const rejectedPaths: string[] = [];
      assert.throws(
        () => preflightProductionPolicy(env, (program) => { rejectedPaths.push(program); return false; }),
        /supported Apple Command Line Tools Git runtime/,
      );
      assert.deepEqual(rejectedPaths, [process.execPath]);

      const acceptedPaths: string[] = [];
      const result = preflightProductionPolicy(env, (program) => { acceptedPaths.push(program); return true; });
      assert.equal(result.revision, PRODUCTION_POLICY_REVISION);
      assert.deepEqual(acceptedPaths, [process.execPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects policy drift, an ignored-state baseline, and unsupported unattended profiles before dispatch', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      mkdirSync(path.join(root, 'luna'));
      writeFileSync(path.join(root, 'luna', 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const env = environment(path.join(root, 'luna'));
      env.TACHIKO_LOCAL_VALIDATION_CONFIG = JSON.stringify({ ...PRODUCTION_LOCAL_VALIDATION_CONFIG, trustedIgnoredBaselinePath: '/tmp/worker-state' });
      assert.throws(() => preflightProductionPolicy(env, supportedGitRuntime), /frozen-lockfile exact-candidate policy/);
      const profiles = structuredClone(PRODUCTION_EXECUTION_PROFILE_CONFIG) as { profiles: Record<string, { executor: string }> };
      profiles.profiles.standard!.executor = 'codex-cli';
      assert.throws(() => preflightProductionPolicy({ ...environment(path.join(root, 'luna')), TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify(profiles) }, supportedGitRuntime), /execution profile configuration/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps all durable policy inputs in the standalone reboot-safe shell file', () => {
    const script = readFileSync(path.resolve('scripts/issue-104-production-policy.sh'), 'utf8');
    assert.match(script, /TACHIKO_LUNA_CODEX_HOME/);
    assert.match(script, /TACHIKO_PLAYWRIGHT_BROWSERS_PATH/);
    assert.match(script, /TACHIKO_PNPM_PROGRAM/);
    assert.match(script, /TACHIKO_GIT_PROGRAM/);
    assert.match(script, /TACHIKO_EXECUTION_PROFILE_CONFIG/);
    assert.match(script, /"routine"/);
    assert.match(script, /"gpt-5\.6-luna"/);
    assert.match(script, /pnpm","install","--frozen-lockfile/);
    assert.match(script, /TACHIKO_HOSTED_CHECK_POLICY_CONFIG/);
    assert.match(script, /"mode":"not_required"/);
    assert.doesNotMatch(script, /requiredCheckNames/);
    const sourced = spawnSync('sh', ['-c', '. "$1"; printf "%s\\n%s\\n%s" "$TACHIKO_EXECUTION_PROFILE_CONFIG" "$TACHIKO_LOCAL_VALIDATION_CONFIG" "$TACHIKO_HOSTED_CHECK_POLICY_CONFIG"', 'sh', path.resolve('scripts/issue-104-production-policy.sh')], {
      encoding: 'utf8', env: { ...process.env, TACHIKO_LUNA_CODEX_HOME: '/tmp/qualified-luna', TACHIKO_PLAYWRIGHT_BROWSERS_PATH: '/tmp/qualified-playwright', TACHIKO_NODE_PROGRAM: '/bin/sh', TACHIKO_PNPM_PROGRAM: '/bin/sh', TACHIKO_GIT_PROGRAM: '/bin/sh', TACHIKO_PNPM_DEPENDENCY_ARTIFACT: '/tmp/qualified-dependency-artifact' },
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    const [execution, local, hosted] = sourced.stdout.split('\n');
    assert.deepEqual(JSON.parse(execution!), PRODUCTION_EXECUTION_PROFILE_CONFIG);
    assert.deepEqual(JSON.parse(local!), PRODUCTION_LOCAL_VALIDATION_CONFIG);
    assert.deepEqual(JSON.parse(hosted!), PRODUCTION_HOSTED_CHECK_POLICY_CONFIG);
  });

  it('does not invent a Luna CODEX_HOME when the durable owner setting is absent', () => {
    const sourced = spawnSync('sh', ['-c', '. "$1"', 'sh', path.resolve('scripts/issue-104-production-policy.sh')], {
      encoding: 'utf8', env: {},
    });
    assert.notEqual(sourced.status, 0);
    assert.match(sourced.stderr, /TACHIKO_LUNA_CODEX_HOME/);
  });

  it('fails closed when the host has not provisioned the pinned browser artifacts', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      mkdirSync(path.join(root, 'luna'));
      writeFileSync(path.join(root, 'luna', 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      const env = environment(path.join(root, 'luna'));
      env.TACHIKO_PLAYWRIGHT_BROWSERS_PATH = path.join(root, 'missing-browser-artifacts');
      assert.throws(() => preflightProductionPolicy(env, supportedGitRuntime), /artifact directory must be an existing private non-symlink/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects Luna file authentication before dispatch', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      mkdirSync(path.join(root, 'luna'));
      writeFileSync(path.join(root, 'luna', 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      writeFileSync(path.join(root, 'luna', 'auth.json'), '{}');
      assert.throws(() => preflightProductionPolicy(environment(path.join(root, 'luna')), supportedGitRuntime), /auth\.json/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
