import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PRODUCTION_EXECUTION_PROFILE_CONFIG,
  PRODUCTION_HOSTED_CHECK_POLICY_CONFIG,
  PRODUCTION_LOCAL_VALIDATION_CONFIG,
  PRODUCTION_POLICY_REVISION,
  preflightProductionPolicy,
} from '../src/production-policy.js';

function environment(home: string): NodeJS.ProcessEnv {
  return {
    TACHIKO_LUNA_CODEX_HOME: home,
    TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify(PRODUCTION_EXECUTION_PROFILE_CONFIG),
    TACHIKO_LOCAL_VALIDATION_CONFIG: JSON.stringify(PRODUCTION_LOCAL_VALIDATION_CONFIG),
    TACHIKO_HOSTED_CHECK_POLICY_CONFIG: JSON.stringify(PRODUCTION_HOSTED_CHECK_POLICY_CONFIG),
  };
}

describe('#104 production policy', () => {
  it('preflights a revisioned routine-only Luna and model-free pnpm policy without provider activity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-production-policy-'));
    try {
      mkdirSync(path.join(root, 'luna'));
      writeFileSync(path.join(root, 'luna', 'config.toml'), 'tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
      assert.deepEqual(preflightProductionPolicy(environment(path.join(root, 'luna'))), {
        revision: PRODUCTION_POLICY_REVISION, lunaCodexHome: path.join(root, 'luna'),
        checks: ['execution-profile', 'luna-home', 'local-validation', 'hosted-check-policy'],
      });
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
      assert.throws(() => preflightProductionPolicy(env), /frozen-lockfile exact-candidate policy/);
      const profiles = structuredClone(PRODUCTION_EXECUTION_PROFILE_CONFIG) as { profiles: Record<string, { executor: string }> };
      profiles.profiles.standard.executor = 'codex-cli';
      assert.throws(() => preflightProductionPolicy({ ...environment(path.join(root, 'luna')), TACHIKO_EXECUTION_PROFILE_CONFIG: JSON.stringify(profiles) }), /execution profile configuration/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps all durable policy inputs in the standalone reboot-safe shell file', () => {
    const script = readFileSync(path.resolve('scripts/issue-104-production-policy.sh'), 'utf8');
    assert.match(script, /TACHIKO_LUNA_CODEX_HOME/);
    assert.match(script, /TACHIKO_EXECUTION_PROFILE_CONFIG/);
    assert.match(script, /"routine"/);
    assert.match(script, /"gpt-5\.6-luna"/);
    assert.match(script, /pnpm","install","--frozen-lockfile/);
    assert.match(script, /TACHIKO_HOSTED_CHECK_POLICY_CONFIG/);
    const sourced = spawnSync('sh', ['-c', '. "$1"; printf "%s\\n%s\\n%s" "$TACHIKO_EXECUTION_PROFILE_CONFIG" "$TACHIKO_LOCAL_VALIDATION_CONFIG" "$TACHIKO_HOSTED_CHECK_POLICY_CONFIG"', 'sh', path.resolve('scripts/issue-104-production-policy.sh')], {
      encoding: 'utf8', env: { ...process.env, TACHIKO_LUNA_CODEX_HOME: '/tmp/qualified-luna' },
    });
    assert.equal(sourced.status, 0, sourced.stderr);
    const [execution, local, hosted] = sourced.stdout.split('\n');
    assert.deepEqual(JSON.parse(execution!), PRODUCTION_EXECUTION_PROFILE_CONFIG);
    assert.deepEqual(JSON.parse(local!), PRODUCTION_LOCAL_VALIDATION_CONFIG);
    assert.deepEqual(JSON.parse(hosted!), PRODUCTION_HOSTED_CHECK_POLICY_CONFIG);
  });
});
