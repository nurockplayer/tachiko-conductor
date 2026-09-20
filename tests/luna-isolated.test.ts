import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { isolatedLunaEnvironment, parseTrustedLunaConfig } from '../src/agents/luna-isolated.js';

describe('qualified Luna runtime configuration', () => {
  it('pins all capability-denying overrides after repository configuration', () => {
    const config = parseTrustedLunaConfig('tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
    assert.deepEqual(config, ['features.plugins=false', 'features.apps=false', 'mcp_servers={}', 'web_search=false', 'sandbox_workspace_write.network_access=false']);
  });
  it('rejects an incomplete trusted configuration before any model spawn', () => {
    assert.throws(() => parseTrustedLunaConfig('tachiko_luna_runtime_revision = "luna-qualified-runtime-v1"\n[features]\nplugins = false\napps = false\n'), /explicitly disable/);
  });
  it('supplies a trusted commit identity without ambient user Git configuration', () => {
    const env = isolatedLunaEnvironment('/tmp/qualified-luna', '/usr/bin');
    assert.equal(env.HOME, '/tmp/qualified-luna');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(env.GIT_AUTHOR_EMAIL, 'tachiko-luna@localhost');
    assert.equal(env.GIT_COMMITTER_NAME, 'Tachiko Isolated Luna');
  });
  it('creates a fresh isolated commit using only the supplied identity', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tachiko-luna-identity-'));
    try {
      const home = path.join(root, 'qualified-home');
      const repository = path.join(root, 'repository');
      mkdirSync(home); mkdirSync(repository);
      const env = isolatedLunaEnvironment(home, process.env.PATH);
      execFileSync('git', ['init', '-b', 'main'], { cwd: repository, env, stdio: 'ignore' });
      writeFileSync(path.join(repository, 'fresh.txt'), 'isolated\n');
      execFileSync('git', ['add', 'fresh.txt'], { cwd: repository, env, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'fresh isolated identity'], { cwd: repository, env, stdio: 'ignore' });
      assert.equal(execFileSync('git', ['show', '-s', '--format=%an <%ae>'], { cwd: repository, env, encoding: 'utf8' }).trim(), 'Tachiko Isolated Luna <tachiko-luna@localhost>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
