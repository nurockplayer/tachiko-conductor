import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeClaudeProcessRunner } from '../src/agents/claude-code.js';

// Opt-in local smoke path for issue #4: proves the installed Claude Code CLI
// can be invoked non-interactively and returns a parseable JSON result.
//   TACHIKO_SMOKE=1 pnpm exec tsx --test tests/claude-code-smoke.test.ts
// Never runs in the default suite or in CI.
const enabled = process.env.TACHIKO_SMOKE === '1';

describe('Claude Code smoke (opt-in: TACHIKO_SMOKE=1)', { skip: !enabled }, () => {
  it('invokes the installed claude CLI non-interactively and parses its JSON result', async () => {
    const runner = new NodeClaudeProcessRunner();
    const result = await runner.run(
      'claude',
      ['-p', 'Reply with the single word ok.', '--output-format', 'json'],
      { timeoutMs: 120_000, cwd: process.cwd() },
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout) as { is_error?: boolean; result?: unknown };
    assert.equal(parsed.is_error, false);
  });
});
