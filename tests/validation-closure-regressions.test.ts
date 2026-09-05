import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
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
        localRevision: 'test-config-v1',
        hostedPolicyRevision: 'test-hosted-policy-v1',
      }),
      true,
    );
    assert.equal(
      isValidationFresh(run, {
        localRevision: null,
        hostedPolicyRevision: 'test-hosted-policy-v1',
      }),
      false,
    );
    assert.equal(
      isValidationFresh(run, {
        localRevision: 'test-config-v1',
        hostedPolicyRevision: null,
      }),
      false,
    );
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
