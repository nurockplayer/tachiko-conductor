# DeepSeek Review and Automatic Fix Loop Design

**Issue:** [#5](https://github.com/nurockplayer/tachiko-conductor/issues/5)
**Base dependency:** PR #9 / issue #4 (implementation agent) and PR #8 / issue #3 (GitHub live state)
**Status:** Autonomous-execution workstream

## Goal

Route an implementation at an exact PR HEAD to an independent DeepSeek
reviewer, and feed blocking findings back to Claude Code until the review
passes or the loop escalates. Every accepted `PASS` is explicitly bound to the
exact reviewed HEAD SHA; malformed or stale reviewer output never counts as
approval.

## Boundaries

1. `DeepSeekReviewer implements ReviewerAdapter` calls a configurable
   DeepSeek (OpenAI-compatible) chat-completions endpoint through an
   injectable `ReviewApiClient`. Tests inject a fake client; production uses
   `fetch` with a base URL, model, and API key that are configuration (env),
   never persisted.
2. A `PullRequestDiffReader` reads GitHub's complete PR diff media
   representation through the issue #3 `GitHubApiTransport`, bracketed by PR
   HEAD reads. Missing/incomplete diff data fails closed rather than silently
   treating omitted file patches as the exact diff.
3. `runReviewLoop` orchestrates the review → fix → re-review cycle through
   the core state machine, bound by a configurable `maxAttempts`, escalating
   non-convergence to `NEEDS_HUMAN`.
4. Reviewer identity is independent from the implementation agent; a Claude
   self-review can never satisfy this gate.

## Reviewer contract

`DeepSeekReviewer.review({ target, headSha, instructions? })`:

1. Read the live snapshot (issue target) for issue title/body context and PR
   number, and require its live HEAD to equal `request.headSha`.
2. Read the complete PR diff via the diff reader, with pre/post exact-HEAD
   validation, then re-read live identity after diff acquisition.
3. Re-read live identity after the model call, so a PR that moves while either
   the diff or review is in flight can never produce an accepted approval.
4. Build a prompt that demands structured JSON:

```json
{ "verdict": "PASS" | "REQUEST_CHANGES",
  "reviewed_head_sha": "<40-hex>",
  "blocking_findings": [{ "summary": "...", "detail": "..." }],
  "non_blocking_suggestions": [{ "summary": "..." }] }
```

5. Parse and validate before returning a `ReviewResult`:
   - missing/unparseable JSON, unknown verdict, non-array findings →
     `ReviewerError` (REVIEW_INVALID_OUTPUT) — never an approval.
   - `reviewed_head_sha !== request.headSha` → `ReviewerError`
     (REVIEW_STALE_HEAD) — never reuse a PASS for a different HEAD.
   - `PASS` with any blocking finding → `ReviewerError`
     (REVIEW_CONTRADICTORY) — an approval cannot carry blockers.
   - `non_blocking_suggestions` must be a valid array of actionable-shaped
     objects and are preserved as non-blocking findings.
   - `REQUEST_CHANGES` without a blocking finding is contradictory and fails
     closed.
   - `PASS` clean → `{ verdict: 'approve', reviewerName, headSha, findings }`.
   - `REQUEST_CHANGES` → `{ verdict: 'request_changes', reviewerName,
     headSha, findings }`; the result preserves both blocker and suggestion
     metadata, while the fix loop routes blockers only.
6. API/snapshot/diff transport failures (HTTP error, timeout, quota) → typed
   `ReviewerError` with `retryable` where appropriate.

## Fix loop

`runReviewLoop(store, github, implementation, reviewer, runId, { maxAttempts })`:

- Precondition: run is `REVIEWING` or `CHANGES_REQUESTED` with an exact
  `headSha`.
- Each iteration re-reads GitHub live state first. If the live PR HEAD no
  longer matches the run's `headSha`, the loop escalates to `NEEDS_HUMAN`
  (contradictory live state) instead of reviewing a stale identity.
- Review at the exact live HEAD. `approve` → persisted `review_approved` →
  `FINAL_GATE`. Issue #6's final-gate workflow owns the fresh GitHub readiness
  re-read and the later `gate_passed` transition to `MERGE_READY`.
- `request_changes` → `changes_requested` → route only actionable blocking
  findings back as implementation instructions → `start_fix` →
  `agent_succeeded` (new exact HEAD from the agent result) →
  `validation_passed` → re-review at the new HEAD.
- An implementation failure → `agent_failed` → `FAILED`.
- The attempt count is derived from persisted review transitions, so process
  re-entry cannot reset the configured bound. Exceeding `maxAttempts` →
  `escalate` → `NEEDS_HUMAN`.
- Retryable reviewer failures persist `NEEDS_HUMAN`; fatal reviewer failures
  persist `FAILED` rather than escaping the loop as unstructured exceptions.
- Every transition persists through the store; the loop can resume from
  persisted state.

## Safety

- No auto-merge; this loop stops at `FINAL_GATE`.
- Reviewer API/model selection is configuration, not hard-coded workflow
  logic.
- Malformed, contradictory, or stale-SHA reviewer output can never advance
  the run toward `FINAL_GATE`.
- Secrets are read from environment at call time, never persisted.

## Validation

- Tests cover PASS, REQUEST_CHANGES → fix → PASS, stale SHA, malformed
  output, contradictory approval, max-attempt escalation, live-HEAD drift
  escalation, and the full loop persisting through the store.
- The default suite uses fake clients, a fake diff reader, and a fake
  implementation agent — no network, no real DeepSeek API.
