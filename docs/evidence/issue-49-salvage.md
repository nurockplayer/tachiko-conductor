# Issue 49: bounded output salvage foundation

## Scope and provenance

Source-only reconciliation of PR93's `e585be51bfccfaa7ca1f0605ce85506353d4a569`
onto local baseline `2fefa1cf92f191c7095cce8d2873f100169ecb83` (the reviewed
source tree of PR144). The envelope, store, capture and range/search machinery
and original tests are salvaged from PR93, not independently reimplemented.

Current source authority:
- https://github.com/nurockplayer/tachiko-conductor/issues/114
- https://github.com/nurockplayer/tachiko-conductor/issues/48#issuecomment-5917783533
- https://github.com/nurockplayer/tachiko-conductor/issues/49#issuecomment-5829424792
- Preserved blockers: https://github.com/nurockplayer/tachiko-conductor/pull/93#issuecomment-5742870047

The operator approved parking #48 as externally blocked, **not passed**, and
continuing this source-only successor. No #48 acceptance HOLD is cleared.

## Bounded changes

1. Default `NodeProcessRunner` behavior remains non-durable and machine-readable.
   It does not create artifacts. Provider adapters keep their existing parser,
   redaction and raw-transcript exclusions; none is opted into capture here.
2. Explicit `outputStore` opt-in selects streaming evidence commands. These
   return bounded stdout/stderr previews plus the full artifact reference.
   Callers needing complete machine-readable stdout must not opt in. The owner
   must retain the envelope and explicitly delete its artifact when its evidence
   retention ends; internal Git/provider calls create no orphan artifacts.
3. Streaming commands do not use `execFile`'s 16 MiB buffered limit. Existing
   default `execFile` environment narrowing and the immediate synchronous
   `beforeSpawn` fence remain intact. The streaming spawn path has the same
   environment and synchronous admission contract.
4. Storage initialization, writes and finalization are supplemental. Failures
   produce a null artifact, explicit capture overflow, bounded diagnostics and
   the original command outcome; they never fabricate full evidence or PASS.
5. Range reads align to complete UTF-8 code points. The returned offset and
   nextOffset are authoritative; alignment may add at most six bytes to the
   requested budget. File capture is private (0700 root, 0600 files), and no
   shared root is chmodded. Partial captures are discarded on failure.
6. Diagnostics retain the first high-signal failures rather than only the tail.
   Stream previews, diagnostic limits, deterministic search and explicit
   larger task budgets are preserved.

Private artifacts contain UTF-8 text supplied by the caller. This module is
not a universal secret detector. Only explicitly safe command output may opt
in; credential-bearing or provider transcripts must retain their current
non-durable/sanitized boundaries. Raw artifact reads are private drill-down
operations, not a permission to publish logs.

## Validation status and remaining integration

Test sources cover success/failure/timeout/cancellation, startup failures,
streaming beyond 16 MiB, first-diagnostic retention, storage failures, UTF-8
ranges, private files, explicit deletion, narrow environments, admission
refusal, and absence of default provider artifacts. Tests and typecheck have
not run at this source freeze; a static whitespace diff check alone is not a
validation pass or review approval.

This foundation does not yet opt production validation/worker/CLI paths into
the evidence API, wire pilot telemetry, or satisfy all #49 acceptance. Those
consumers need separate bounded reconciliation of the existing PR93 changes
against today's trust boundaries. Existing exact-HEAD validation, publication,
review-loop and account-home code are unchanged. No runtime, queue, registry,
HOLD, Codex, provider experiment, merge, source publication or deployment is
performed by this work.

## Independent static review repairs

The first frozen candidate received four blocking findings: unchecked artifact
digests during file retrieval, discarded observed exit codes on timeout/abort,
unbounded ignored-TERM/inherited-pipe teardown, and a fixture that called
`process.exit` before its buffered output necessarily drained. These findings
are accepted; historical review approval does not carry over to this repair.

The repair produces range/search results from the same bounded streaming pass
that validates both channels' byte counts and combined SHA. It retains an
observed numeric exit status even when the outcome is timed out or cancelled.
Captured command teardown signals only its exact direct child, escalates TERM
to KILL after 250 ms, and after one second closes owned pipe handles with
explicit incomplete capture and `ECHILD_CLEANUP_UNPROVEN`. This is never proof
of descendant/tree quiescence. The original noncapturing path is unchanged.

Added test sources cover same-size replacement, append, in-memory forged
identity, live cancellation, numeric TERM handlers, ignored TERM and inherited
pipes. The huge-output fixture uses `process.exitCode` so output can drain.
All tests remain unexecuted pending coordinated validation admission.
