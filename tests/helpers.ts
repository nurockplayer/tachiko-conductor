import { createRun } from '../src/domain/run.js';
import type { ActiveValidationConfiguration } from '../src/domain/state-machine.js';
import type { AgentResult, IssueTarget, ReviewResult, Run, Target, ValidationResult } from '../src/domain/types.js';

export const T0 = '2026-08-14T00:00:00.000Z';

export const TEST_VALIDATION_AUTHORITY: ActiveValidationConfiguration = {
  local: { kind: 'configured', revision: 'test-config-v1' },
  hosted: { kind: 'configured', revision: 'test-hosted-policy-v1', mode: 'required' },
};

export const TARGET: IssueTarget = { kind: 'issue', owner: 'acme', repo: 'widgets', issueNumber: 42 };

export function newRun(id = 'run-test-1', target: Target = TARGET): Run {
  return createRun(target, T0, id);
}

export function successResult(headSha = 'sha-1', summary = 'implemented'): AgentResult {
  return { exitStatus: 'success', summary, headSha };
}

export function failureResult(summary = 'agent crashed'): AgentResult {
  return { exitStatus: 'failure', summary };
}

export function approval(reviewerName = 'reviewer-1', headSha = 'sha-1'): ReviewResult {
  return { verdict: 'approve', reviewerName, headSha, findings: [] };
}

export function changesRequested(reviewerName = 'reviewer-1', headSha = 'sha-1'): ReviewResult {
  return {
    verdict: 'request_changes',
    reviewerName,
    headSha,
    findings: [{ severity: 'blocking', summary: 'the diff has a bug' }],
  };
}

/** A compact successful exact-HEAD validation ledger for state-machine fixtures. */
export function validationPassed(headSha = 'sha-1'): ValidationResult {
  return {
    headSha,
    status: 'passed',
    local: {
      status: 'passed', configRevision: 'test-config-v1',
      commands: [{ commandIndex: 0, executable: 'test', outcome: 'passed', exitCode: 0, durationMs: 1 }],
    },
    hosted: {
      status: 'passed', observedAt: T0, pullRequestNumber: 7,
      availability: 'available', overall: 'passing',
      policyRevision: 'test-hosted-policy-v1', policyMode: 'required',
      requiredCheckNames: [], observedCheckNames: ['test'],
    },
  };
}

export function validationFailed(headSha = 'sha-1'): ValidationResult {
  return {
    headSha,
    status: 'failed',
    local: {
      status: 'failed', configRevision: 'test-config-v1',
      commands: [{ commandIndex: 0, executable: 'test', outcome: 'failed', exitCode: 1, durationMs: 1 }],
    },
    hosted: {
      status: 'passed', observedAt: T0, pullRequestNumber: 7,
      availability: 'available', overall: 'passing',
      policyRevision: 'test-hosted-policy-v1', policyMode: 'required',
      requiredCheckNames: [], observedCheckNames: ['test'],
    },
  };
}
