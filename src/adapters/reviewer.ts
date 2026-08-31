import type { ReviewResult, Target } from '../domain/types.js';

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
  review(request: ReviewRequest): Promise<ReviewResult>;
}
