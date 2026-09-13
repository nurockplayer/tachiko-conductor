/**
 * Provider/UI-neutral operational projection. This boundary is intentionally
 * separate from workflow mutation so a future CLI or automation consumer can
 * consume the same observations without importing React or Tauri.
 */
export type PullRequestState = 'OPEN' | 'MERGED' | 'CLOSED' | 'UNKNOWN';
export type ReclaimState = 'in_use' | 'reclaimable' | 'blocked' | 'unknown';

export interface WorkUnitView {
  readonly repository: string;
  readonly issue?: number;
  readonly pullRequest?: { readonly number: number; readonly state: PullRequestState };
  readonly runId?: string;
  readonly agent?: {
    readonly provider: string;
    readonly profile?: string;
    readonly state: string;
    readonly durationMs?: number;
  };
  readonly worktree: {
    readonly path: string;
    readonly shortId: string;
    readonly branch?: string;
    readonly headSha?: string;
    readonly clean?: boolean;
  };
  readonly process?: { readonly pid: number; readonly rssBytes?: number; readonly state: string };
  readonly diskBytes?: number;
  readonly reclaim: { readonly state: ReclaimState; readonly reason?: string };
}

export interface SystemView {
  readonly memoryTotalBytes?: number;
  readonly memoryUsedBytes?: number;
  readonly dataTotalBytes?: number;
  readonly dataFreeBytes?: number;
}

export interface ControlTowerSnapshot {
  readonly mode: 'fixture' | 'live';
  readonly generatedAt: string;
  readonly rows: readonly WorkUnitView[];
  readonly system: SystemView;
  readonly sourceNote?: string;
}

export type DashboardFilter = 'all' | 'active' | 'reclaimable';
