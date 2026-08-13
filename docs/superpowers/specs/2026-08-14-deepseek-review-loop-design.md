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
2. A `PullRequestDiffReader` reads the live PR diff at an exact HEAD through
   the issue #3 `GitHubApiTransport` (files endpoint), so the reviewer never
   guesses what changed.
3. `runReviewLoop` orchestrates the review → fix → re-review cycle through
   the core state machine, bound by a configurable `maxAttempts`, escalating
   non-convergence to `NEEDS_HUMAN`.
4. Reviewer identity is independent from the implementation agent; a Claude
   self-review can never satisfy this gate.

## Reviewer contract

`DeepSeekReviewer.review({ target, headSha, instructions? })`:

1. Read the live snapshot (issue target) for issue context and PR number.
2. Read the PR diff via the diff reader.
3. Build a prompt that demands structured JSON:

```json
{ "verdict": "PASS" | "REQUEST_CHANGES",
  "reviewed_head_sha": "<40-hex>",
  "blocking_findings": [{ "summary": "...", "detail": "..." }],
  "non_blocking_suggestions": [{ "summary": "..." }] }
```

4. Parse and validate before returning a `ReviewResult`:
   - missing/unparseable JSON, unknown verdict, non-array findings →
     `ReviewerError` (REVIEW_INVALID_OUTPUT) — never an approval.
   - `reviewed_head_sha !== request.headSha` → `ReviewerError`
     (REVIEW_STALE_HEAD) — never reuse a PASS for a different HEAD.
   - `PASS` with any blocking finding → `ReviewerError`
     (REVIEW_CONTRADICTORY) — an approval cannot carry blockers.
   - `PASS` clean → `{ verdict: 'approve', reviewerName, headSha, findings: [] }`.
   - `REQUEST_CHANGES` → `{ verdict: 'request_changes', reviewerName,
     headSha, findings: blocking_findings }`.
5. API/transport failures (HTTP error, timeout, quota) → typed `ReviewerError`
   with `retryable` where appropriate.

## Fix loop

`runReviewLoop(store, github, implementation, reviewer, runId, { maxAttempts })`:

- Precondition: run is `REVIEWING` or `CHANGES_REQUESTED` with an exact
  `headSha`.
- Each iteration re-reads GitHub live state first. If the live PR HEAD no
  longer matches the run's `headSha`, the loop escalates to `NEEDS_HUMAN`
  (contradictory live state) instead of reviewing a stale identity.
- Review at the exact live HEAD. `approve` → `review_approved` →
  `FINAL_GATE` → `gate_passed` (freshness enforced by the core) →
  `MERGE_READY`.
- `request_changes` → `changes_requested` → route only actionable blocking
  findings back as implementation instructions → `start_fix` →
  `agent_succeeded` (new exact HEAD from the agent result) →
  `validation_passed` → re-review at the new HEAD.
- An implementation failure → `agent_failed` → `FAILED`.
- Exceeding `maxAttempts` → `escalate` → `NEEDS_HUMAN`.
- Every transition persists through the store; the loop can resume from
  persisted state.

## Safety

- No auto-merge; the final gate stays `MERGE_READY`.
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
