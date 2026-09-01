import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeProcessRunner } from '../src/github/transport.js';

// Opt-in local smoke path for issue #15: proves the installed/authenticated
// Codex CLI exposes the non-interactive JSONL surface used by the adapter.
//   TACHIKO_CODEX_SMOKE=1 pnpm exec tsx --test tests/codex-cli-smoke.test.ts
// Never runs in the default suite or in CI.
const enabled = process.env.TACHIKO_CODEX_SMOKE === '1';

describe('Codex CLI smoke (opt-in: TACHIKO_CODEX_SMOKE=1)', { skip: !enabled }, () => {
  it('invokes Codex read-only and observes a thread, agent message, and completed turn', async () => {
    const runner = new NodeProcessRunner();
    const result = await runner.run(
      'codex',
      ['exec', '--json', '--sandbox', 'read-only', 'Do not modify files. Reply with the single word ok.'],
      { timeoutMs: 120_000, cwd: process.cwd() },
    );
    assert.equal(result.exitCode, 0);
    const events = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(events.some((event) => event.type === 'thread.started' && typeof event.thread_id === 'string'));
    assert.ok(events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => {
      if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return false;
      const item = event.item as Record<string, unknown>;
      return item.type === 'agent_message' && typeof item.text === 'string';
    }));
  });
});
