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

/** Secret-free operational state; never inferred from heartbeat or worker prose. */
export interface AutopilotView {
  readonly supervisor: 'running' | 'stopped' | 'parked' | 'unknown';
  readonly currentStage: string;
  readonly lastMeaningfulTransition?: string;
  readonly nextPollAt?: string;
  readonly eventWakeEligible: 'yes' | 'no' | 'unknown';
  /** Typed ownership state, independent of helper-process observations. */
  readonly writerOwnership?: 'none' | 'active' | 'ambiguous';
  readonly checkpoint?: 'durable' | 'in_progress' | 'unknown';
  readonly checkpointSha?: string;
  readonly manualWriterState?: 'active' | 'parked';
  readonly activeWriter?: { readonly issue?: number; readonly runId?: string; readonly worker?: string };
  readonly restart: {
    readonly verdict: 'SAFE TO RESTART' | 'SAFE NOW · WINDOW NOT GUARANTEED' | 'WAIT FOR CURRENT CHECKPOINT' | 'DO NOT RESTART' | 'UNKNOWN — CANNOT PROVE SAFE';
    readonly reason: string;
  };
}

export interface ControlTowerSnapshot {
  readonly mode: 'fixture' | 'live';
  readonly generatedAt: string;
  readonly rows: readonly WorkUnitView[];
  readonly system: SystemView;
  readonly autopilot?: AutopilotView;
  readonly sourceNote?: string;
}

export type DashboardFilter = 'all' | 'active' | 'reclaimable';
