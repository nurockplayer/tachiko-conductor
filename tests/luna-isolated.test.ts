import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseTrustedLunaConfig } from '../src/agents/luna-isolated.js';

describe('qualified Luna runtime configuration', () => {
  it('pins all capability-denying overrides after repository configuration', () => {
    const config = parseTrustedLunaConfig('[features]\nplugins = false\napps = false\nmcp_servers = {}\nweb_search = false\n[sandbox_workspace_write]\nnetwork_access = false\n');
    assert.deepEqual(config, ['features.plugins=false', 'features.apps=false', 'mcp_servers={}', 'web_search=false', 'sandbox_workspace_write.network_access=false']);
  });
  it('rejects an incomplete trusted configuration before any model spawn', () => {
    assert.throws(() => parseTrustedLunaConfig('[features]\nplugins = false\napps = false\n'), /explicitly disable/);
  });
});
