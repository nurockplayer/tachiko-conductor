import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateHostedCheckPolicy,
  type HostedCheckPolicyObservation,
} from '../src/validation/hosted-policy.js';

function evaluate(observation: HostedCheckPolicyObservation) {
  return evaluateHostedCheckPolicy(observation);
}

describe('hosted-check policy evaluation', () => {
  it('keeps an explicit not-required zero-check response neutral', () => {
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: [], policy: { mode: 'not_required' } }), 'not_required');
    assert.equal(evaluate({ overall: null, observedCheckNames: [], policy: { mode: 'not_required' } }), 'not_required');
  });

  it('does not treat a missing policy and zero checks as passing', () => {
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: [] }), 'unknown');
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: [], policy: null }), 'unknown');
  });

  it('keeps a required zero-check response unknown', () => {
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: [], policy: { mode: 'required' } }), 'unknown');
    assert.equal(evaluate({ overall: 'passing', policy: { mode: 'required', requiredCheckNames: ['ci'] } }), 'unknown');
  });

  it('requires every named check before accepting passing', () => {
    const policy = { mode: 'required' as const, requiredCheckNames: ['build', 'test'] };
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: ['build'], policy }), 'unknown');
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: ['build', 'test'], policy }), 'passed');
  });

  it('prioritizes actual failing and pending observations', () => {
    const policy = { mode: 'not_required' as const };
    assert.equal(evaluate({ overall: 'failing', observedCheckNames: [], policy }), 'failed');
    assert.equal(evaluate({ overall: 'pending', observedCheckNames: [], policy }), 'waiting');
    assert.equal(evaluate({ overall: 'failing', policy: { mode: 'required' } }), 'failed');
    assert.equal(evaluate({ overall: 'pending', policy: { mode: 'required' } }), 'waiting');
  });

  it('fails closed for unknown or unavailable required observations', () => {
    const policy = { mode: 'required' as const };
    assert.equal(evaluate({ overall: 'unknown', observedCheckNames: ['build'], policy }), 'unknown');
    assert.equal(evaluate({ overall: 'unavailable', observedCheckNames: ['build'], policy }), 'unknown');
  });

  it('keeps non-empty not-required observations neutral', () => {
    assert.equal(evaluate({ overall: 'passing', observedCheckNames: ['build'], policy: { mode: 'not_required' } }), 'not_required');
    assert.equal(evaluate({ overall: 'unknown', observedCheckNames: ['build'], policy: { mode: 'not_required' } }), 'unknown');
  });
});
