import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import {
  environmentForTier,
  isolatedExcludedTests,
  selectTests,
  tsxInvocation,
} from '../scripts/test-tier.mjs';

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

  it('keeps integration and smoke files out while full unit retains browser tests', () => {
    const files = [
      'browser-runtime-integration.test.ts',
      'claude-code-smoke.test.ts',
      'codex-cli-smoke.test.ts',
      'browser-agent-smoke.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'workflow.test.ts',
    ];
    assert.deepEqual(selectTests('unit', files), [
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'workflow.test.ts',
    ]);
    assert.deepEqual(selectTests('integration', files), ['browser-runtime-integration.test.ts']);
    assert.deepEqual(selectTests('smoke:claude', files), ['claude-code-smoke.test.ts']);
  });

  it('uses the explicit network-dependent exclusion list for the isolated tier', () => {
    assert.deepEqual(isolatedExcludedTests, [
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
    ]);

    const files = [
      'browser-runtime-integration.test.ts',
      'claude-code-smoke.test.ts',
      'browser-runtime.test.ts',
      'control-tower-browser.test.ts',
      'workflow.test.ts',
      'other-network.test.ts',
    ];
    assert.deepEqual(selectTests('isolated', files), ['workflow.test.ts', 'other-network.test.ts']);
  });
});
