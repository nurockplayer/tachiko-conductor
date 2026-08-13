import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAgentHandoffs } from '../src/github/handoff.js';
import type { GitHubConversationEntry } from '../src/adapters/github.js';

const SHA_1 = '1111111111111111111111111111111111111111';
const SHA_2 = '2222222222222222222222222222222222222222';

function comment(
  id: string,
  body: string,
  updatedAt: string,
  scope: 'issue' | 'pull_request' = 'pull_request',
): GitHubConversationEntry {
  return {
    id,
    scope,
    kind: 'comment',
    author: 'alice',
    body,
    createdAt: updatedAt,
    updatedAt,
    url: `https://github.test/comments/${id}`,
  };
}

function handoffBody(headSha: string, prNumber: number, status = 'Ready'): string {
  return `<!-- agent-handoff:v1 -->

## Status

${status}

## Branch / PR

HEAD: \`${headSha}\`
PR: #${prNumber}

## Exact next actions

Continue from live state.`;
}

describe('agent-handoff:v1 parser', () => {
  it('parses a valid handoff and marks matching live identity current', () => {
    const entry = comment('c1', handoffBody(SHA_1, 7), '2026-08-14T01:00:00.000Z');

    const result = parseAgentHandoffs([entry], { headSha: SHA_1, pullRequestNumber: 7 });

    assert.equal(result.handoff?.sourceId, 'c1');
    assert.equal(result.handoff?.claimedHeadSha, SHA_1);
    assert.equal(result.handoff?.claimedPullRequestNumber, 7);
    assert.equal(result.handoff?.freshness, 'current');
    assert.equal(result.handoff?.sections.Status, 'Ready');
    assert.deepEqual(result.problems, []);
  });

  it('selects the latest valid handoff independent of API order and diagnoses duplicates', () => {
    const newer = comment('c2', handoffBody(SHA_2, 8, 'New'), '2026-08-14T02:00:00.000Z');
    const older = comment('c1', handoffBody(SHA_1, 7, 'Old'), '2026-08-14T01:00:00.000Z');

    const result = parseAgentHandoffs([newer, older], { headSha: SHA_2, pullRequestNumber: 8 });

    assert.equal(result.handoff?.sourceId, 'c2');
    assert.equal(result.handoff?.sections.Status, 'New');
    assert.deepEqual(result.problems.map((problem) => problem.code), ['DUPLICATE_HANDOFFS']);
  });

  it('keeps an older valid handoff when a newer marker is malformed', () => {
    const valid = comment('c1', handoffBody(SHA_1, 7), '2026-08-14T01:00:00.000Z');
    const malformed = comment(
      'c2',
      '<!-- agent-handoff:v1 -->\n\nmarker without sections',
      '2026-08-14T02:00:00.000Z',
    );

    const result = parseAgentHandoffs([malformed, valid], { headSha: SHA_1, pullRequestNumber: 7 });

    assert.equal(result.handoff?.sourceId, 'c1');
    assert.deepEqual(
      result.problems.map((problem) => [problem.code, problem.sourceId]),
      [
        ['MALFORMED_HANDOFF', 'c2'],
        ['MALFORMED_HANDOFF_NEWER_THAN_SELECTED', 'c2'],
      ],
    );
  });

  it('rejects two markers in one comment as ambiguous instead of splicing them', () => {
    const body = `${handoffBody(SHA_1, 7)}\n\n${handoffBody(SHA_2, 8)}`;

    const result = parseAgentHandoffs(
      [comment('c1', body, '2026-08-14T01:00:00.000Z')],
      { headSha: SHA_1, pullRequestNumber: 7 },
    );

    assert.equal(result.handoff, null);
    assert.deepEqual(result.problems.map((problem) => problem.code), ['AMBIGUOUS_HANDOFF']);
  });

  it('uses stable id ordering for equal timestamps and marks mismatched claims stale', () => {
    const at = '2026-08-14T01:00:00.000Z';
    const a = comment('a', handoffBody(SHA_1, 7, 'A'), at);
    const b = comment('b', handoffBody(SHA_2, 8, 'B'), at);

    const result = parseAgentHandoffs([b, a], { headSha: SHA_1, pullRequestNumber: 7 });

    assert.equal(result.handoff?.sourceId, 'b');
    assert.equal(result.handoff?.freshness, 'stale');
    assert.deepEqual(result.problems.map((problem) => problem.code), ['DUPLICATE_HANDOFFS', 'STALE_HANDOFF']);
  });
});
