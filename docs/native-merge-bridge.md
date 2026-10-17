# Disabled native merge bridge

The ordinary production factory has no native merge host. A queue entry,
`TACHIKO_DISPATCH_CONFIG`, green checks, or an approval cannot enable it.
Actual reviewer transport, merge actor/operation, accepted release, and personal
host qualification remain separate activation gates. Deterministic fixtures
provide no native delivery credit.

An accepted release may pass a `NativeMergeHost` to `buildWorkflowDeps`. Its
nonsecret policy is copied and frozen for the process and must exactly match the
optional `merge` descriptor in the existing dispatch configuration. The policy
binds repository, base branch, campaign/control issue/comment, dispatch and merge
revisions, release identity, squash method, integration policy, and required
review/local/hosted validation revisions. Unknown or contradictory enabled fields
are rejected. Candidate workspace files, executable policies, and environment
flags cannot supply the separate trusted host capability. `readMergeCandidate`
reads only local immutable objects in an object repository selected by that host;
it never fetches missing objects.

Before submission, the existing same-Run mission admission and claim must be
current, the full live final gate must pass, bootstrap/PR/fresh default base must
agree, and trusted Git must prove base ancestry and source tree. Observed base
drift parks for explicit integration disposition. The request is a single direct
GitHub `PUT /pulls/{number}/merge` with `sha` and `merge_method: squash`.
GitHub guards HEAD. BASE equality is **last observed**, not atomic: unseen base
movement can still race the request. There is no automatic rebase or synthetic
merge validation.

The Run CAS records immutable preparation, then the exact current
`issuanceGeneration` with `submissionPossible` before the external boundary.
A proven unsubmitted preparation can resume only through fresh complete
readmission and final checks. A possible submission is never resent. Open PR,
timeout, lost acknowledgement, restart, lease expiry, or policy replacement do
not prove non-submission. Three durable read-only observations with 30-second
backoff are available; exhaustion retains ownership and requires attention.
The complete callable direct-PR/default-branch/commit/ancestry/squash capability set must exist before preparation, the possible-submission marker and the API boundary. Known missing capabilities wait before any effect. Waiting and observation create no model turns.

Merged readback is retained separately from qualification. The actual squash
commit must have exactly one parent equal to the recorded base, tree equal to
the validated source tree, and proven ancestry in a fresh default branch read.
The mutable postmerge PR base SHA is not historical provenance. Wrong or unknown
integration remains merged-but-unsettled and blocks the next row. Manual,
automatic, historical, released, and receipt-less native settlement retries all
require the same qualified attempt and exact owner evidence. Ordinary legacy
external-merge settlement retains its existing compatibility.

Revocation uses the existing serialized maintenance HOLD, request drain, host
policy/release replacement, and restart. Successful HOLD fences later requests;
it cannot cancel an already-issued request. Recovery uses the original control
location retained by the attempt even if current configuration/binding is absent
or replaced. That recovery cycle may only observe/settle the exact issued Run;
it does not read the queue, start another writer, admit B, or release HOLD. A
later ordinary cycle requires current configuration before any new work.

After observation exhaustion, the existing `run transition <id> merged` exact
proof command can qualify an issued attempt, readmit and normalize its quiescent
parked owner, and use the existing CAS/receipt release path. It cannot issue a
request or normalize an active/unknown local invocation. Stopped local-owner
recovery still requires the existing explicit operator attestation; stopping a
process cannot retire or cancel an issued external merge attempt. Only exact
qualified settlement allows normal dispatch to advance to the next eligible
issue while retaining the earlier queue row. Every historical or released-owner
shortcut for native delivered work also requires a fresh model-free integration
read before successor admission, even if the old runtime claim or queue row is
absent or rerouted. Exact explicit non-delivery retirement or cancellation of
unissued work retains its existing disposition authority and cannot reopen A
merely because its native binding wait is due. Release alone is not disposition;
unresolved native review and possibly issued merges remain fenced.
A historical qualification remains immutable evidence, not a freshness lease.

Exact-proof normalization validates the prior receipt phase, token and generation
inside the admission transaction before replacing it. Stale or foreign receipts
remain untouched. If a process dies after qualification CAS but before owner
parking, the existing explicit operator-stopped recovery establishes real
`workflow_settled` parking and uses the existing stopped release protocol. Fresh
integration proof is still required for MERGED settlement. An arbitrary released
receipt, timeout or active invocation cannot substitute for that stopped evidence.
