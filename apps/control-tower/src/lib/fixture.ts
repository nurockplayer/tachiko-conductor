import type { ControlTowerSnapshot } from '../../../../src/operational/read-model.js';

/** Approved deterministic fixture. Keep its copy and values stable for visual review. */
export const goldenFixture: ControlTowerSnapshot = {
  mode: 'fixture',
  generatedAt: '2026-09-13T00:00:00.000Z',
  rows: [
    { repository: 'tachiko-work', issue: 421, agent: { provider: 'Terra', state: 'working', durationMs: 34 * 60_000 }, pullRequest: { number: 512, state: 'OPEN' }, worktree: { path: 'chatgpt/issue-421', shortId: '4424', branch: 'chatgpt/issue-421', clean: true }, process: { pid: 4210, rssBytes: 4_600_000_000, state: 'running' }, diskBytes: 3_600_000_000, reclaim: { state: 'in_use' } },
    { repository: 'tachiko-sheet', issue: 423, agent: { provider: 'Terra', state: 'testing', durationMs: 11 * 60_000 }, pullRequest: { number: 97, state: 'OPEN' }, worktree: { path: 'codex/issue-423', shortId: '91af', branch: 'codex/issue-423', clean: true }, process: { pid: 4230, rssBytes: 2_100_000_000, state: 'running' }, diskBytes: 1_800_000_000, reclaim: { state: 'in_use' } },
    { repository: 'tachiko-work', issue: 418, agent: { provider: 'idle', state: 'session complete' }, pullRequest: { number: 506, state: 'MERGED' }, worktree: { path: 'codex/issue-418', shortId: 'ac72', branch: 'codex/issue-418', clean: true }, diskBytes: 4_900_000_000, reclaim: { state: 'reclaimable', reason: 'PR 已 merged；分類器已證明可安全回收。' } },
    { repository: 'tachiko-conductor', issue: 416, agent: { provider: 'idle', state: 'no process' }, pullRequest: { number: 141, state: 'MERGED' }, worktree: { path: 'codex/issue-416', shortId: 'b32e', branch: 'codex/issue-416', clean: true }, diskBytes: 2_500_000_000, reclaim: { state: 'reclaimable', reason: 'PR 已 merged；分類器已證明可安全回收。' } },
  ],
  system: { memoryTotalBytes: 32_000_000_000, memoryUsedBytes: 21_800_000_000, dataTotalBytes: 400_000_000_000, dataFreeBytes: 12_000_000_000 },
  autopilot: {
    supervisor: 'running', currentStage: 'implementing', lastMeaningfulTransition: 'Implement started · 2m ago',
    nextPollAt: '2026-09-21T01:03:00.000Z', eventWakeEligible: 'yes',
    activeWriter: { issue: 421, runId: 'run-421', worker: 'Terra' },
    restart: { verdict: 'WAIT FOR CURRENT CHECKPOINT', reason: 'A typed active writer owns run-421; wait for its durable checkpoint.' },
  },
};

export const goldenSummaryOverride = {
  activeCount: 3,
  activeWorktrees: 3,
  memoryUsedBytes: 21_800_000_000,
  memoryPercent: 68,
  diskFreeBytes: 12_000_000_000,
  diskPercentUsed: 97,
  reclaimBytes: 7_400_000_000,
  reclaimCount: 2,
} as const;
