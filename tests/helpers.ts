import { createRun } from '../src/domain/run.js';
import type { AgentResult, IssueTarget, ReviewResult, Run, Target } from '../src/domain/types.js';

export const T0 = '2026-08-14T00:00:00.000Z';

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
