import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { environmentForTier, selectTests, tsxInvocation } from '../scripts/test-tier.mjs';

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

  it('keeps integration and smoke files out of the deterministic unit tier', () => {
    const files = [
      'browser-runtime-integration.test.ts',
      'claude-code-smoke.test.ts',
      'codex-cli-smoke.test.ts',
      'browser-agent-smoke.test.ts',
      'workflow.test.ts',
    ];
    assert.deepEqual(selectTests('unit', files), ['workflow.test.ts']);
    assert.deepEqual(selectTests('integration', files), ['browser-runtime-integration.test.ts']);
    assert.deepEqual(selectTests('smoke:claude', files), ['claude-code-smoke.test.ts']);
  });
});
