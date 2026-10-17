import type { ReviewResult, Target } from '../domain/types.js';
import type { Run } from '../domain/types.js';
import type { GitHubLiveSnapshot } from './github.js';
import type { RunStore } from '../store/json-file-store.js';

export interface NativeReviewContext {
  readonly run: Run;
  readonly snapshot: GitHubLiveSnapshot;
  readonly owner?: { readonly missionId: string; readonly laneId: string; readonly generation: number };
  readonly assertCurrent: () => void;
  readonly assertLiveClaim?: () => Promise<void>;
  /** Explicit attention recovery may reconcile existing receipts only. */
  readonly cachedOnly?: boolean;
}

export interface NativeReviewBoundary {
  available(): boolean;
  /** Configured-host scheduling only; performs no receipt/service observation. */
  canObserve?(run: Run, now: string): boolean;
  /** Bounded evidence-only recovery; cannot issue, accept a verdict, or run a worker. */
  observe?(context: NativeReviewContext & { readonly store: RunStore; readonly now: () => string }): Promise<{ readonly run: Run; readonly reason: string }>;
  advance(context: NativeReviewContext & { readonly store: RunStore; readonly now: () => string; readonly onSubmission: (run: Run) => Run; readonly recoveryConfiguration?: import('../dispatch/config.js').DispatchConfiguration }): Promise<
    | { readonly outcome: 'wait'; readonly run: Run; readonly reason: string }
    | { readonly outcome: 'complete'; readonly run: Run; readonly result: ReviewResult }
    | { readonly outcome: 'superseded'; readonly run: Run; readonly reason: string }>;
  /** Reads and authenticates immutable evidence again, using current host authority. */
  validate(context: NativeReviewContext): boolean;
}

export interface ReviewRequest {
  /** The work item: a single issue or a whole branch. */
  readonly target: Target;
  /** Exact HEAD SHA the review must be bound to. */
  readonly headSha: string;
  readonly instructions?: string;
}

/**
 * Boundary to an independent reviewer. Every approval is bound to the exact
 * HEAD SHA it reviewed; the core's FINAL_GATE refuses stale approvals.
 * Concrete implementations are added in issue #5; the core depends only on
 * this interface.
 */
export interface ReviewerAdapter {
  readonly kind: 'reviewer';
  readonly native?: NativeReviewBoundary;
  review(request: ReviewRequest): Promise<ReviewResult>;
}
