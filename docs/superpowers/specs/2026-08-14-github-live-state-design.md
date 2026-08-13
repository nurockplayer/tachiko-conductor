# GitHub Live-State Adapter Design

**Issue:** [#3](https://github.com/nurockplayer/tachiko-conductor/issues/3)  
**Base dependency:** PR #7 / issue #2  
**Status:** Approved by the user's autonomous-execution mandate

## Goal

Add a read-only GitHub implementation that produces one deterministic,
machine-readable snapshot for `owner/repo#issue`. GitHub live state always wins
over local state, handoffs, and reviews. The adapter never mutates GitHub.

## Boundaries

The implementation has four focused units:

1. `GitHubApiTransport` returns decoded JSON from GitHub API endpoints.
   `GhCliTransport` implements it with `execFile("gh", ["api", ...])`; tests
   inject a fake transport and never need network access.
2. `parseAgentHandoffs` is a pure parser over normalized issue/PR comments. It
   recognizes exactly `<!-- agent-handoff:v1 -->`, preserves Markdown sections,
   selects the latest valid comment by `updatedAt` and stable ID, and emits
   diagnostics for malformed, duplicate, ambiguous, or stale handoffs.
3. `LiveGitHubAdapter` fetches, validates, normalizes, and cross-checks issue,
   associated PR, checks, reviews, and conversations. It extends the issue #2
   `GitHubAdapter` boundary with `readLiveSnapshot`.
4. `tachiko github snapshot owner/repo#123` prints one JSON envelope. Success is
   `{ "ok": true, "snapshot": ... }`; failure is
   `{ "ok": false, "error": ... }` on stderr with a non-zero exit code.

No runtime dependency is added. The core state machine remains unaware of
GitHub transport details.

## Transport and failure contract

`GitHubApiTransport` exposes object reads and fully paginated collection reads.
The concrete CLI transport uses argument arrays, never shell command strings,
and parses JSON only after a zero exit status. It applies a configurable
timeout and maps failures to `GitHubLiveStateError`:

- `GH_NOT_FOUND`
- `GH_AUTH_REQUIRED`
- `GH_RATE_LIMITED`
- `GH_TIMEOUT`
- `GH_TRANSPORT_FAILED`
- `GH_INVALID_RESPONSE`
- `GH_AMBIGUOUS_OPEN_PRS`
- `GH_CONTRADICTORY_STATE`
- `GH_SNAPSHOT_CHANGED`

Errors include `code`, `message`, `retryable`, and structured `details`. No
partial snapshot is returned after a fatal transport or consistency error.

## Live snapshot flow

1. Read the issue and its full timeline/comments.
2. Discover pull requests only from timeline cross-reference/connected events;
   never infer association from branch names, titles, reviews, or handoffs.
3. Filter to open associated PRs. Zero is valid and yields `pullRequest: null`
   and `headSha: null`. More than one is `GH_AMBIGUOUS_OPEN_PRS`; do not choose.
4. For one PR, read its live object and exact `head.sha`, then read issue/PR
   comments, reviews, review comments, combined statuses, and check runs.
5. Re-read the PR. If its number/state/HEAD changed during aggregation, return
   retryable `GH_SNAPSHOT_CHANGED`; never emit mixed-SHA data.
6. Normalize checks and reviews, parse handoffs, and cross-check state. A closed
   issue with an open PR is a nonfatal `CONTRADICTORY_STATE` diagnostic because
   it may be an intentional manual close; missing/empty PR HEAD is fatal.

Exact HEAD comes only from the selected live PR. Review or handoff SHAs are
comparison metadata and can never populate or replace it.

## Normalized data

The snapshot contains:

- repository owner/name
- issue identity, state, title/body, URL, and timestamps
- selected PR identity/state/draft/merge fields/base SHA/exact HEAD, or `null`
- `headSha` copied from that live PR, or `null`
- checks with `availability`, `overall`, and per-check normalized state
- reviews with latest submitted review per author, exact commit SHA, and summary
- deterministically ordered issue/PR conversation entries with stable IDs
- latest valid handoff with raw sections, source metadata, claimed HEAD/PR, and
  freshness, or `null`
- typed nonfatal diagnostics and `observedAt`

Check normalization keeps `unavailable` distinct from empty/passing. Pending
and in-progress checks are pending; failure-like conclusions are failing;
success, neutral, and skipped are passing; unknown values remain unknown with
a diagnostic. Review freshness is computed against live HEAD and never changes
the review's raw state.

## Handoff parser

A valid candidate contains exactly one marker and at least one non-empty `##`
section. Section names are preserved and normalized for lookup. Historical v1
headings such as `Current State`, `Latest Claude Result`, and `Next` remain
readable; the parser does not require newly renamed headings. Claimed HEAD is
accepted only when one unambiguous 40-hex SHA appears in a state/branch section;
claimed PR is accepted only from a state/branch section.

Candidates are sorted by `updatedAt`, then stable ID. Multiple valid marker
comments produce a duplicate diagnostic while the latest remains selected.
A malformed marker newer than the selected valid handoff is explicitly
diagnosed. A claimed HEAD/PR mismatch marks the handoff stale; live state wins.

## Validation

Deterministic tests cover valid/latest/malformed/duplicate handoffs; no/single/
ambiguous PRs; stale handoffs; exact HEAD; snapshot races; checks/reviews;
pagination; transport error mapping; and CLI JSON envelopes. The default suite
uses only fakes. An opt-in smoke command exercises a real public issue and is
documented but not required in CI.

## Out of scope

GitHub mutation, Linear, caching, webhooks, autonomous merge, branch heuristics,
GraphQL-specific abstractions, retry orchestration beyond marking retryable
errors, and model adapters remain outside issue #3.
