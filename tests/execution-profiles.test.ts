import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertExecutionSupportedByProvider,
  parseExecutionProfileConfiguration,
  resolveExecutionProfile,
} from '../src/execution-profiles.js';

const CONFIG = JSON.stringify({
  revision: 'execution-profiles-v1',
  profiles: {
    routine: { executor: 'codex-cli', model: 'model-routine', reasoningEffort: 'low', timeoutMs: 60_000, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    standard: { executor: 'codex-cli', model: 'model-standard', reasoningEffort: 'medium', timeoutMs: 120_000, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    complex: { executor: 'codex-cli', model: 'model-complex', reasoningEffort: 'high', timeoutMs: 300_000, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    critical: { executor: 'claude-code', model: 'model-critical', timeoutMs: 600_000 },
  },
});

describe('execution profiles', () => {
  it('resolves the same named profile and revision to the same explicit provider-neutral snapshot', () => {
    const configuration = parseExecutionProfileConfiguration(CONFIG);
    const first = resolveExecutionProfile(configuration, 'complex', ['claude-code', 'codex-cli']);
    const second = resolveExecutionProfile(configuration, 'complex', ['claude-code', 'codex-cli']);

    assert.deepEqual(first, second);
    assert.deepEqual(first, {
      profile: 'complex', revision: 'execution-profiles-v1', executor: 'codex-cli', model: 'model-complex',
      reasoningEffort: 'high', timeoutMs: 300_000, sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
    });
  });

  it('allows a profile to remap model configuration without changing the coarse profile identity', () => {
    const oldConfig = parseExecutionProfileConfiguration(CONFIG);
    const newConfig = parseExecutionProfileConfiguration(CONFIG.replace('model-standard', 'model-next'));
    const oldResolved = resolveExecutionProfile(oldConfig, 'standard', ['claude-code', 'codex-cli']);
    const newResolved = resolveExecutionProfile(newConfig, 'standard', ['claude-code', 'codex-cli']);

    assert.equal(oldResolved.profile, 'standard');
    assert.equal(newResolved.profile, 'standard');
    assert.equal(newResolved.model, 'model-next');
  });

  it('fails closed for malformed profiles, unknown profile/executor, and unsupported provider settings', () => {
    assert.throws(
      () => parseExecutionProfileConfiguration(JSON.stringify({ revision: 'v1', profiles: { routine: {} } })),
      /must define exactly routine, standard, complex, and critical/,
    );
    const configuration = parseExecutionProfileConfiguration(CONFIG);
    assert.throws(() => resolveExecutionProfile(configuration, 'guessed', ['codex-cli']), /Unknown execution profile/);
    assert.throws(() => resolveExecutionProfile(configuration, 'critical', ['codex-cli']), /unavailable executor/);
    assert.throws(
      () => assertExecutionSupportedByProvider({
        profile: 'critical', revision: 'v1', executor: 'claude-code', timeoutMs: 1, reasoningEffort: 'high',
      }),
      /unsupported by executor/,
    );
    assert.throws(
      () => assertExecutionSupportedByProvider({
        profile: 'routine', revision: 'v1', executor: 'worker-router', timeoutMs: 1, model: 'ignored-model',
      }),
      /unsupported by executor/,
    );
    assert.throws(
      () => assertExecutionSupportedByProvider({
        profile: 'standard', revision: 'v1', executor: 'worker-router', timeoutMs: 1, sandboxMode: 'workspace-write',
      }),
      /unsupported by executor/,
    );
    assert.doesNotThrow(() => assertExecutionSupportedByProvider({
      profile: 'routine', revision: 'v1', executor: 'worker-router', timeoutMs: 60_000,
    }));
    assert.throws(
      () => parseExecutionProfileConfiguration(CONFIG.replace('reasoningEffort', 'reasoningEfort')),
      /unsupported setting/,
    );
    assert.throws(
      () => parseExecutionProfileConfiguration(CONFIG.replace('timeoutMs', 'unknownTimeout')),
      /unsupported setting/,
    );
    assert.throws(
      () => parseExecutionProfileConfiguration(CONFIG.replace('"timeoutMs":60000', '"timeoutMs":2147483648')),
      /no greater than 2147483647/,
    );
  });
});
