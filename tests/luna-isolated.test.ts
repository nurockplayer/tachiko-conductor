import assert from 'node:assert/strict';
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
});
