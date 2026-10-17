import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeHostedPolicyIdentity,
  activeLocalPolicyIdentity,
  InvalidTransitionError,
  applyTransition,
  isValidationFresh,
} from '../src/domain/state-machine.js';
import type { LocalValidationEvidence, Run, WorkflowState } from '../src/domain/types.js';
import { isValidationResultCoherent, localValidationHasUnsettledProcessFamily } from '../src/domain/validation.js';
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
  const run = { ...newRun(), state, ...overrides };
  return run.headSha === undefined || run.pullRequest !== undefined
    ? run
    : { ...run, pullRequest: { number: ACCEPTED_PR, headSha: run.headSha } };
}

describe('validation closure regressions', () => {
  it('keeps explicit family-settlement uncertainty unknown ahead of hosted failure only', () => {
    for (const code of [0, 7]) {
      const local: LocalValidationEvidence = { status: 'unknown', configRevision: 'test-config-v1', commands: [
        { commandIndex: 0, executable: 'node', outcome: code === 0 ? 'passed' : 'failed', exitCode: code, durationMs: 1 },
        { commandIndex: 1, executable: 'process-family-settlement', outcome: 'unavailable', exitCode: null, durationMs: 0 },
      ] };
      const seed = validationPassed(OLD_HEAD);
      const held = { ...seed, status: 'unknown', local, hosted: { ...seed.hosted, status: 'failed', overall: 'failing' } };
      assert.equal(localValidationHasUnsettledProcessFamily(local), true);
      assert.equal(isValidationResultCoherent(held), true);
      assert.equal(isValidationResultCoherent({ ...held, status: 'failed' }), false);
      assert.equal(isValidationResultCoherent({ ...held, status: 'passed' }), false);
      const ordinary = { ...local, commands: [local.commands[0]!, { ...local.commands[1]!, executable: 'git' }] };
      assert.equal(localValidationHasUnsettledProcessFamily(ordinary), false);
      assert.equal(isValidationResultCoherent({ ...held, local: ordinary, status: 'failed' }), true,
        'unrelated local unknown retains known hosted-failure precedence');
      assert.equal(isValidationResultCoherent({ ...held, local: ordinary }), false);
      assert.equal(localValidationHasUnsettledProcessFamily({ commands: [{ executable: 'process-family-settlement', outcome: 'passed' }] }), false);
    }
    let getterCalls = 0;
    const command = { get executable() { getterCalls += 1; return 'process-family-settlement'; }, outcome: 'unavailable' };
    assert.equal(localValidationHasUnsettledProcessFamily({ commands: [command] }), false);
    assert.equal(getterCalls, 0, 'marker recognition must not invoke evidence accessors');
  });

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
        pullRequest: { number: ACCEPTED_PR, headSha: NEW_HEAD },
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
