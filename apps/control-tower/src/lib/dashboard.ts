import type { ControlTowerSnapshot, DashboardFilter, ReclaimState, WorkUnitView } from '../../../../src/operational/read-model.js';
import { goldenSummaryOverride } from './fixture.js';

export interface DashboardSummary {
  readonly activeCount: number;
  readonly activeWorktrees: number;
  readonly memoryUsedBytes?: number;
  readonly memoryPercent?: number;
  readonly diskFreeBytes?: number;
  readonly diskPercentUsed?: number;
  readonly reclaimBytes: number;
  readonly reclaimCount: number;
}

const executingAgentStates = new Set([
  'working',
  'testing',
  'implementing',
  'validating',
  'reviewing',
  'changes_requested',
  'final_gate',
]);

export function isActive(row: WorkUnitView): boolean {
  // A durable run is active only while it is in an executing state. Provider
  // presence is merely an observation: MERGED, FAILED, and MERGE_READY runs
  // must not be shown as executing work.
  return row.agent !== undefined && executingAgentStates.has(row.agent.state.trim().toLowerCase());
}

export function rowsForFilter(rows: readonly WorkUnitView[], filter: DashboardFilter): readonly WorkUnitView[] {
  if (filter === 'active') return rows.filter(isActive);
  if (filter === 'reclaimable') return rows.filter((row) => row.reclaim.state === 'reclaimable');
  return rows;
}

export function statusLine(filter: DashboardFilter, count: number): string {
  if (filter === 'all') return '目前顯示全部工作。';
  if (filter === 'active') return `目前顯示 ${count} 個 Codex 執行中工作。`;
  return `目前顯示 ${count} 個可回收 worktree。`;
}

export function summarize(snapshot: ControlTowerSnapshot): DashboardSummary {
  if (snapshot.mode === 'fixture') return goldenSummaryOverride;
  const active = snapshot.rows.filter(isActive);
  const reclaimable = snapshot.rows.filter((row) => row.reclaim.state === 'reclaimable');
  // System memory is a system observation. Selected process RSS is not a
  // substitute and remains available only in the per-worktree RAM column.
  const memoryUsedBytes = snapshot.system.memoryUsedBytes;
  const memoryPercent = snapshot.system.memoryTotalBytes && memoryUsedBytes
    ? Math.round((memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100)
    : undefined;
  const diskPercentUsed = snapshot.system.dataTotalBytes && snapshot.system.dataFreeBytes !== undefined
    ? Math.round(((snapshot.system.dataTotalBytes - snapshot.system.dataFreeBytes) / snapshot.system.dataTotalBytes) * 100)
    : undefined;
  return {
    activeCount: active.length,
    activeWorktrees: active.length,
    ...(memoryUsedBytes === undefined ? {} : { memoryUsedBytes }),
    ...(memoryPercent === undefined ? {} : { memoryPercent }),
    ...(snapshot.system.dataFreeBytes === undefined ? {} : { diskFreeBytes: snapshot.system.dataFreeBytes }),
    ...(diskPercentUsed === undefined ? {} : { diskPercentUsed }),
    reclaimBytes: reclaimable.reduce((total, row) => total + (row.diskBytes ?? 0), 0),
    reclaimCount: reclaimable.length,
  };
}

export interface ReclaimEvidence {
  readonly classifier: 'proven' | 'unavailable' | 'unknown';
  readonly pullRequestState?: 'MERGED' | 'OPEN' | 'CLOSED';
  readonly clean?: boolean;
  readonly processState?: 'idle' | 'active' | 'unknown';
  readonly recoverableHead?: boolean;
  readonly lockFree?: boolean;
}

export function classifyReclaim(evidence: ReclaimEvidence): { readonly state: ReclaimState; readonly reason: string } {
  if (evidence.classifier !== 'proven') return { state: 'unknown', reason: '安全回收分類器尚不可用；未推定可刪除。' };
  if (evidence.pullRequestState !== 'MERGED') return { state: 'blocked', reason: 'PR 尚未 merged；不會將 closed 或舊工作誤判為可回收。' };
  if (!evidence.clean || evidence.processState !== 'idle' || !evidence.recoverableHead || !evidence.lockFree) return { state: 'blocked', reason: '回收證據不完整（clean、idle、remote HEAD 與 lock state 必須全部成立）。' };
  return { state: 'reclaimable', reason: '分類器已證明可安全回收。' };
}
