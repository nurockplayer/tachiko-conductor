import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeHostedPolicyIdentity,
  activeLocalPolicyIdentity,
  InvalidTransitionError,
  applyTransition,
  isValidationFresh,
} from '../src/domain/state-machine.js';
import type { Run, WorkflowState } from '../src/domain/types.js';
import {
  T0,
  approval,
  newRun,
  successResult,
  validationPassed,
} from './helpers.js';

const OLD_HEAD = 'sha-old';
const NEW_HEAD = 'sha-new';
const ACCEPTED_PR = 7;

/** Build a run pinned to an arbitrary state for closure-boundary assertions. */
function runIn(state: WorkflowState, overrides: Partial<Run> = {}): Run {
  return { ...newRun(), state, ...overrides };
}

describe('validation closure regressions', () => {
  it('treats removed or disabled active configuration identities as stale, not wildcards', () => {
    const run = runIn('FINAL_GATE', {
      headSha: OLD_HEAD,
      validationResult: validationPassed(OLD_HEAD),
    });

    assert.equal(
      isValidationFresh(run, {
        local: { kind: 'configured', revision: 'test-config-v1' },
        hosted: { kind: 'configured', mode: 'required', revision: 'test-hosted-policy-v1' },
      }),
      true,
    );
    assert.equal(
      isValidationFresh(run, {
        local: { kind: 'absent' },
        hosted: { kind: 'configured', mode: 'required', revision: 'test-hosted-policy-v1' },
      }),
      false,
    );
    assert.equal(
      isValidationFresh(run, {
        local: { kind: 'configured', revision: 'test-config-v1' },
        hosted: { kind: 'absent' },
      }),
      false,
    );
  });

  it('distinguishes revision, mode, absent, and anonymous-present policy identities', () => {
    const run = runIn('FINAL_GATE', {
      headSha: OLD_HEAD,
      validationResult: validationPassed(OLD_HEAD),
    });
    const local = { kind: 'configured' as const, revision: 'test-config-v1' };
    const hosted = { kind: 'configured' as const, mode: 'required' as const, revision: 'test-hosted-policy-v1' };

    assert.equal(isValidationFresh(run, { local, hosted }), true);
    assert.equal(isValidationFresh(run, { local: { kind: 'configured', revision: 'test-config-v2' }, hosted }), false);
    assert.equal(isValidationFresh(run, { local, hosted: { kind: 'configured', mode: 'not_required', revision: 'test-hosted-policy-v1' } }), false);
    assert.deepEqual(activeLocalPolicyIdentity(undefined, false), { kind: 'absent' });
    assert.deepEqual(activeLocalPolicyIdentity(undefined, true), { kind: 'invalid' });
    assert.deepEqual(activeHostedPolicyIdentity(undefined, undefined), { kind: 'absent' });
    assert.deepEqual(activeHostedPolicyIdentity(undefined, 'required'), { kind: 'invalid' });
    assert.equal(isValidationFresh(run, { local: activeLocalPolicyIdentity(undefined, true), hosted }), false);
  });

  it('clears prior review and validation evidence when a new HEAD is accepted', () => {
    const run = runIn('IMPLEMENTING', {
      headSha: OLD_HEAD,
      reviewResult: approval('sol', OLD_HEAD),
      validationResult: validationPassed(OLD_HEAD),
    });

    const next = applyTransition(
      run,
      {
        type: 'agent_succeeded',
        agentResult: successResult(NEW_HEAD),
        headSha: NEW_HEAD,
      },
      T0,
    );

    assert.equal(next.headSha, NEW_HEAD);
    assert.equal(next.reviewResult, undefined);
    assert.equal(next.validationResult, undefined);
  });

  it('rejects hosted validation evidence for a PR other than the accepted PR', () => {
    const run = runIn('VALIDATING', {
      headSha: OLD_HEAD,
      pullRequest: { number: ACCEPTED_PR, headSha: OLD_HEAD },
    });
    const conflictingValidation = {
      ...validationPassed(OLD_HEAD),
      hosted: {
        ...validationPassed(OLD_HEAD).hosted,
        pullRequestNumber: ACCEPTED_PR + 1,
      },
    };

    assert.throws(
      () => applyTransition(
        run,
        { type: 'validation_passed', validationResult: conflictingValidation },
        T0,
      ),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTransitionError);
        assert.equal(error.code, 'invalid-validation-result');
        assert.match(error.message, /same pull request identity/i);
        return true;
      },
    );
  });
});
