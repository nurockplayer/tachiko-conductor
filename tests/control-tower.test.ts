import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyReclaim, formatBytes, isActive, provenanceLabel, rowsForFilter, statusLine, summarize } from '../apps/control-tower/src/lib/dashboard.ts';
import { goldenFixture } from '../apps/control-tower/src/lib/fixture.ts';
import { collectGitWorktrees, parseGitWorktreePorcelain } from '../apps/control-tower/src/lib/git-worktrees.ts';
import { collectDataVolume, parseDfKilobytes } from '../apps/control-tower/src/lib/system.ts';
import { createSingleFlightCollector } from '../apps/control-tower/src/lib/tauri.ts';

test('golden fixture preserves the approved values and all three filters', () => {
  const summary = summarize(goldenFixture);
  assert.equal(summary.activeCount, 3);
  assert.equal(summary.memoryUsedBytes, 21_800_000_000);
  assert.equal(summary.diskFreeBytes, 12_000_000_000);
  assert.equal(summary.reclaimBytes, 7_400_000_000);
  assert.equal(rowsForFilter(goldenFixture.rows, 'all').length, 4);
  assert.equal(rowsForFilter(goldenFixture.rows, 'active').length, 2);
  assert.equal(rowsForFilter(goldenFixture.rows, 'reclaimable').length, 2);
  assert.equal(statusLine('all', 4), '目前顯示全部工作。');
  assert.equal(statusLine('active', 2), '目前顯示 2 個 Codex 執行中工作。');
  assert.equal(statusLine('reclaimable', 2), '目前顯示 2 個可回收 worktree。');
});

test('Git porcelain parser preserves spaces and does not invent an odd-path branch', () => {
  const parsed = parseGitWorktreePorcelain('worktree /tmp/work trees/one\nHEAD abcd1234\nbranch refs/heads/codex/issue-32\n\nworktree /tmp/unlinked odd\nHEAD ffff0000\ndetached\n');
  assert.deepEqual(parsed, [
    { path: '/tmp/work trees/one', headSha: 'abcd1234', branch: 'codex/issue-32', detached: false },
    { path: '/tmp/unlinked odd', headSha: 'ffff0000', detached: true },
  ]);
  assert.deepEqual(collectGitWorktrees({ run: () => ({ stdout: '', status: 1 }) }), []);
});

test('system collection is injected and malformed df fails unknown', () => {
  assert.deepEqual(parseDfKilobytes('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 80 20 80% /'), { totalBytes: 102_400, freeBytes: 20_480 });
  assert.deepEqual(parseDfKilobytes('not a df row'), {});
  assert.deepEqual(collectDataVolume({ run: () => ({ stdout: 'ignored', status: 1 }) }, '/tmp'), {});
});

test('reclaim classifier fails closed unless all proven evidence exists', () => {
  assert.equal(classifyReclaim({ classifier: 'unavailable' }).state, 'unknown');
  assert.equal(classifyReclaim({ classifier: 'proven', pullRequestState: 'CLOSED', clean: true, processState: 'idle', recoverableHead: true, lockFree: true }).state, 'blocked');
  assert.equal(classifyReclaim({ classifier: 'proven', pullRequestState: 'MERGED', clean: true, processState: 'unknown', recoverableHead: true, lockFree: true }).state, 'blocked');
  assert.equal(classifyReclaim({ classifier: 'proven', pullRequestState: 'MERGED', clean: true, processState: 'idle', recoverableHead: true, lockFree: true }).state, 'reclaimable');
});

test('only durable executing states contribute to the active and system summaries', () => {
  const terminalStates = ['MERGED', 'FAILED', 'MERGE_READY'] as const;
  for (const state of terminalStates) {
    assert.equal(isActive({
      repository: 'nurockplayer/tachiko-conductor',
      agent: { provider: 'Codex', state },
      worktree: { path: `/tmp/${state}`, shortId: 'dead' },
      process: { pid: 1, rssBytes: 99_000_000_000, state: 'observed' },
      reclaim: { state: 'unknown' },
    }), false);
  }
  const summary = summarize({
    mode: 'live', generatedAt: '0',
    rows: [{ repository: 'nurockplayer/tachiko-conductor', agent: { provider: 'Codex', state: 'VALIDATING' }, worktree: { path: '/tmp/live', shortId: 'live' }, reclaim: { state: 'unknown' } }],
    system: { memoryTotalBytes: 100, memoryUsedBytes: 75 },
  });
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.memoryUsedBytes, 75);
  assert.equal(summary.memoryPercent, 75);
});

test('unknown system memory remains unknown instead of using process RSS', () => {
  const summary = summarize({
    mode: 'live', generatedAt: '0',
    rows: [{ repository: 'repo', agent: { provider: 'Codex', state: 'WORKING' }, worktree: { path: '/tmp/live', shortId: 'live' }, process: { pid: 1, rssBytes: 90_000_000_000, state: 'observed' }, reclaim: { state: 'unknown' } }],
    system: { memoryTotalBytes: 100_000_000_000 },
  });
  assert.equal(summary.memoryUsedBytes, undefined);
  assert.equal(summary.memoryPercent, undefined);
});

test('live collector is single-flight across concurrent renderer effects', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const collect = createSingleFlightCollector(async () => {
    calls += 1;
    await next;
    return { mode: 'live', generatedAt: '0', rows: [], system: {} };
  });
  const first = collect();
  const second = collect();
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  release?.();
  await first;
  await collect();
  assert.equal(calls, 2);
});

test('zero free capacity is visible rather than rendered as unknown', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(undefined), '—');
});

test('dashboard provenance distinguishes golden fixture from successful live observations', () => {
  assert.equal(provenanceLabel('fixture'), '示意資料 · Issue → Codex → PR → Worktree → 回收');
  assert.equal(provenanceLabel('live'), '即時觀測 · Issue → Codex → PR → Worktree → 回收');
});
