import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyReclaim, rowsForFilter, statusLine, summarize } from '../apps/control-tower/src/lib/dashboard.ts';
import { goldenFixture } from '../apps/control-tower/src/lib/fixture.ts';
import { collectGitWorktrees, parseGitWorktreePorcelain } from '../apps/control-tower/src/lib/git-worktrees.ts';
import { collectDataVolume, parseDfKilobytes } from '../apps/control-tower/src/lib/system.ts';

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
