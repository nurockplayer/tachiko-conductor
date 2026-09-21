import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXECUTION_CONFIGURATION_ERROR_CODE,
  assertExecutionSupportedByProvider,
  isExecutionConfigurationError,
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

  it('normalizes accepted case/alias spellings to the canonical runtime value before spawn', () => {
    const aliasConfig = CONFIG
      .replace('"reasoningEffort":"low"', '"reasoningEffort":"Low"')
      .replace('"reasoningEffort":"medium"', '"reasoningEffort":"Med"')
      .replace('"reasoningEffort":"high"', '"reasoningEffort":"XHigh"');
    const configuration = parseExecutionProfileConfiguration(aliasConfig);

    assert.equal(resolveExecutionProfile(configuration, 'routine', ['codex-cli']).reasoningEffort, 'low');
    assert.equal(resolveExecutionProfile(configuration, 'standard', ['codex-cli']).reasoningEffort, 'medium');
    // "XHigh" is the top tier and must not be downgraded to "high".
    assert.equal(resolveExecutionProfile(configuration, 'complex', ['codex-cli']).reasoningEffort, 'xhigh');
  });

  it('fails closed with a typed error for an unsupported reasoning effort in a profile', () => {
    const bad = CONFIG.replace('"reasoningEffort":"high"', '"reasoningEffort":"highest"');
    assert.throws(
      () => parseExecutionProfileConfiguration(bad),
      (error: unknown) => {
        assert.ok(isExecutionConfigurationError(error));
        assert.equal(error.code, EXECUTION_CONFIGURATION_ERROR_CODE.INVALID_REASONING_EFFORT);
        assert.equal(error.evidence.requestedEffort, 'highest');
        return true;
      },
    );
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

  it('accepts only the exact qualified isolated Luna transport settings', () => {
    const configuration = parseExecutionProfileConfiguration(CONFIG);
    const luna = { ...configuration, profiles: { ...configuration.profiles, routine: { executor: 'luna-isolated', model: 'gpt-5.6-luna', timeoutMs: 60_000, sandboxMode: 'workspace-write' as const, approvalPolicy: 'never' as const } } };
    assert.doesNotThrow(() => assertExecutionSupportedByProvider(resolveExecutionProfile(luna, 'routine', ['luna-isolated'])));
    const wrong = resolveExecutionProfile({ ...luna, profiles: { ...luna.profiles, routine: { ...luna.profiles.routine, model: 'configured-model' } } }, 'routine', ['luna-isolated']);
    assert.throws(() => assertExecutionSupportedByProvider(wrong), /unsupported/);
  });
});
