import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANONICAL_REASONING_EFFORTS,
  EXECUTION_CONFIGURATION_ERROR_CODE,
  assertExecutionSupportedByProvider,
  isExecutionConfigurationError,
  normalizeReasoningEffort,
} from '../src/execution-profiles.js';
import {
  CAPABILITY_SOURCE,
  CODEX_CAPABILITY_FALLBACK_REVISION,
  codexFallbackCapabilityCatalog,
  preflightModelEffort,
  runtimeCapabilityCatalog,
} from '../src/agents/model-capability.js';

/** The live shape observed from `codex app-server` `model/list`. */
const LIVE_CATALOG = runtimeCapabilityCatalog(
  [
    { model: 'deepseek-flash', supportedReasoningEfforts: ['low', 'high', 'max'] },
    { model: 'gpt-5.6-terra', supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  ],
  'codex-app-server:model/list',
);

describe('reasoning-effort normalization', () => {
  it('normalizes case, spacing, hyphenation, and accepted aliases to one canonical value', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['High', 'high'],
      ['HIGH', 'high'],
      ['  high  ', 'high'],
      ['Medium', 'medium'],
      ['med', 'medium'],
      ['min', 'minimal'],
      ['XHigh', 'xhigh'],
      ['x-high', 'xhigh'],
      ['X_HIGH', 'xhigh'],
      ['Extra High', 'xhigh'],
      ['very-high', 'xhigh'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeReasoningEffort(input), expected, `"${input}" should normalize to "${expected}"`);
    }
  });

  it('never silently changes a requested level, including never downgrading high', () => {
    // Canonical inputs are already fixed points; normalization is not a policy lever.
    for (const canonical of CANONICAL_REASONING_EFFORTS) {
      assert.equal(normalizeReasoningEffort(canonical), canonical);
      assert.equal(normalizeReasoningEffort(canonical.toUpperCase()), canonical);
    }
    assert.equal(normalizeReasoningEffort('High'), 'high');
    assert.notEqual(normalizeReasoningEffort('High'), 'medium');
    assert.notEqual(normalizeReasoningEffort('xhigh'), 'high');
  });

  it('fails closed with a typed error for an unsupported or ambiguous value', () => {
    for (const value of ['turbo', 'highest', 'highest-possible', '', 'max']) {
      assert.throws(
        () => normalizeReasoningEffort(value, { provider: 'codex-cli' }),
        (error: unknown) => {
          assert.ok(isExecutionConfigurationError(error));
          assert.equal(error.code, EXECUTION_CONFIGURATION_ERROR_CODE.INVALID_REASONING_EFFORT);
          assert.equal(error.evidence.requestedEffort, value);
          assert.equal(error.evidence.provider, 'codex-cli');
          return true;
        },
      );
    }
  });
});

describe('model/effort capability preflight', () => {
  it('validates a positively-reported pair against runtime discovery', () => {
    const result = preflightModelEffort({
      provider: 'codex-app-server',
      catalog: LIVE_CATALOG,
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, CAPABILITY_SOURCE.RUNTIME_DISCOVERY);
    assert.equal(result.verified, true);
    assert.equal(result.reasoningEffort, 'high');
  });

  it('rejects a combination the provider reports as unsupported with typed actionable evidence', () => {
    assert.throws(
      () => preflightModelEffort({
        provider: 'codex-app-server',
        catalog: LIVE_CATALOG,
        model: 'deepseek-flash',
        reasoningEffort: 'medium',
      }),
      (error: unknown) => {
        assert.ok(isExecutionConfigurationError(error));
        assert.equal(error.code, EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT);
        assert.equal(error.evidence.provider, 'codex-app-server');
        assert.equal(error.evidence.model, 'deepseek-flash');
        assert.equal(error.evidence.requestedEffort, 'medium');
        assert.deepEqual(error.evidence.supportedEfforts, ['low', 'high', 'max']);
        assert.equal(error.evidence.capabilitySource, CAPABILITY_SOURCE.RUNTIME_DISCOVERY);
        // Provider values outside the Conductor vocabulary are surfaced, not mapped.
        assert.deepEqual(error.evidence.unrequestableEfforts, ['max']);
        return true;
      },
    );
  });

  it('does not invent a rejection for a model an authoritative catalog omits', () => {
    const result = preflightModelEffort({
      provider: 'codex-app-server',
      catalog: LIVE_CATALOG,
      model: 'hidden-or-aliased-model',
      reasoningEffort: 'high',
    });
    assert.equal(result.verified, false);
    assert.equal(result.unverifiedReason, 'model-not-listed');
    assert.equal(result.reasoningEffort, 'high');
  });

  it('keeps provider-specific capability scoped to its own provider', () => {
    // A Codex catalog that restricts an effort constrains Codex only.
    const codex = runtimeCapabilityCatalog([{ model: 'scoped-model', supportedReasoningEfforts: ['low'] }], 'codex-scoped-v1');
    assert.throws(
      () => preflightModelEffort({ provider: 'codex-cli', catalog: codex, model: 'scoped-model', reasoningEffort: 'high' }),
      (error: unknown) => isExecutionConfigurationError(error) && error.code === EXECUTION_CONFIGURATION_ERROR_CODE.UNSUPPORTED_MODEL_EFFORT,
    );
    // The same request evaluated for a different provider boundary is unaffected.
    const other = preflightModelEffort({
      provider: 'some-other-provider', catalog: codexFallbackCapabilityCatalog(),
      model: 'scoped-model', reasoningEffort: 'high',
    });
    assert.equal(other.ok, true);
    // Providers that never supported a reasoning effort still reject it outright.
    for (const executor of ['claude-code', 'worker-router']) {
      assert.throws(
        () => assertExecutionSupportedByProvider({ profile: 'critical', revision: 'v1', executor, timeoutMs: 1, reasoningEffort: 'high' }),
        /unsupported by executor/,
      );
    }
  });

  it('asserts nothing from local fallback metadata and records the fallback revision', () => {
    const catalog = codexFallbackCapabilityCatalog();
    assert.equal(catalog.revision, CODEX_CAPABILITY_FALLBACK_REVISION);
    const result = preflightModelEffort({
      provider: 'codex-cli',
      catalog,
      model: 'configured-model',
      reasoningEffort: 'high',
    });
    assert.equal(result.verified, false);
    assert.equal(result.source, CAPABILITY_SOURCE.FALLBACK);
    assert.equal(result.revision, CODEX_CAPABILITY_FALLBACK_REVISION);
    assert.equal(result.unverifiedReason, 'fallback-no-per-model-assertion');
    // The requested level is still carried through so it is never downgraded.
    assert.equal(result.reasoningEffort, 'high');
  });
});
