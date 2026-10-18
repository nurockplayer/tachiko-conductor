# Disabled accepted-release host entry

`tachiko` now selects `dist/production-entry.js`. That fixed entry imports only
its bundled resolver and the existing CLI. There is no provider/module loader,
acceptance command, environment opt-in, signing service, or new workflow store.
Direct `src/cli.ts`/`dist/cli.js` remains a development/programmatic entry; it does
not discover or construct installed native capabilities.

This is disabled source engineering. It establishes no personal-host install,
GitHub actor qualification, Oracle/Sol service contract, launchd/reboot proof,
runtime activation, or native delivery. V1 remains unaccepted, with 0/3 native
deliveries. #101 remains empty/HOLD and #115 unloaded/HOLD. Held PR93 remains held.

The current H1/H2/I1 author-validation checkpoint first runs the existing
typecheck, then the retained diagnostic script on Ubuntu CI with fixed affected
files/titles and builtin immediate TAP. Both commands share the existing outer
890-second timeout plus 5-second kill grace; the diagnostic child retains its
880-second limit and can be stopped earlier by the shared outer deadline. This
is not normal acceptance. After affected proof, remove only that temporary
workflow step for the final ordinary candidate. All ordinary test/browser/type/
build commands and the 30-minute job budget remain unchanged.

## Fixed local layout

The resolver uses the physical OS-account home from `resolveAccountHomeDirectory`,
never HOME, cwd, package configuration, PATH discovery, or a data-root override:

```
<physical-home>/.tachiko-conductor/
  releases/<releaseId>/
    accepted-release.json
    package.json
    dist/production-entry.js
    dist/production-host.js
    worker-bin/pnpm                  # fixed regular accepted command launcher
    ...complete compiled distribution and flattened runtime dependencies...
    node_modules/...
    scripts/dispatch-driver.sh
    scripts/issue-104-deploy.sh
  production/host.json
  production/dispatch.json
  production/github/                 # actual qualified nonsecret namespace path
  repositories/<accepted-object-root>/
  runs/                              # existing canonical state
  mission-admission/                 # existing registry and receipts
```

Each release ID is the complete content-derived value returned by `acceptedReleaseId(record)`. The calculation sorts record keys, omits the top-level ID, replaces the merge-policy ID with a fixed placeholder, and normalizes release-directory self references. Artifact, program, namespace or policy changes therefore require a different ID even if both records are rewritten. Computing an ID never grants acceptance.

Each release is selected by its canonical literal absolute entry path, with no mutable `current` or candidate symlink spelling. Both the lexical launched entry and its physical identity must match.
All distribution and acceptance-record files must be regular files with exactly one hardlink in a protected account-owned tree;
symlinked pnpm/dependency trees are deliberately rejected. Provision a complete
physical dependency closure during the separately authorized held installation.
The resolver never installs, downloads, or hydrates executable dependencies.
The accepted object root must be disjoint from the release, production records,
Run/admission stores, and worker workspace root. Existing standalone bootstrap
imports worker objects into this selected host repository; merge reads never fetch.

## Acceptance record versus current opt-in

`accepted-release.json` is created by the host/operator acceptance procedure only,
after exact build/runtime/dependency and host evidence have been qualified. Builds
and workers cannot promote their own manifests. Its closed schema contains:

- `schemaVersion: 1`, bounded immutable `releaseId`, exact `sourceCommit` and
  `sourceTree`, `entry: "dist/production-entry.js"`;
- `stateCompatibility: "conductor-native-state-v1"` and
  `runtimePolicyRevision: "issue-104-production-v7"`;
- `manifest`: every relative regular-file path in the release except this record,
  mapped to its SHA256; `manifestDigest`: SHA256 of JSON for the path-sorted array
  of `[path, sha256]` entries, using the exported `distributionManifestDigest`;
- `node`, `git`, `gh`: each exactly `{ "path": "<physical absolute program>",
  "sha256": "<accepted program bytes>" }`;
- `codex`, `pnpm`: each exactly `{ "path", "sha256", "runtimeDirectory", "manifest", "manifestDigest" }`.
  The protected account-owned tool directory contains the entire executable/runtime dependency
  closure, with every file hashed and no symlinks/hardlinks. It is disjoint from mutable
  workspaces, repositories and authority/release stores. The selected executable is either
  a native binary or a Node script whose exact shebang names the accepted Node plus
  `--no-global-search-paths`; ambient env-node/shell wrappers are unsupported. Wrapper code,
  loaded package files and interpreter identity are all pinned. Outside ancestor package
  resolution is refused at acceptance and every current fence. pnpm's selected path must
  equal `environment.TACHIKO_PNPM_PROGRAM`; a version probe alone grants no identity;
- `repository`: exactly `{ "owner", "repo", "objectRoot" }`;
- `github`: exactly `{ "configDirectory", "actorId", "qualification",
  "observationQualification", "confinementQualification" }`. `actorId` is the
  exact GitHub numeric account ID rendered as a string. These are nonsecret
  references to actual host evidence, never a substitute for producing it;
- `mergePolicy`: the complete existing `NativeMergePolicy`, including repository,
  control location, base branch, campaign, release and all policy revisions;
- `environment`: only the nonsecret #104 implementation/profile/local-validation/
  hosted-policy and pinned runtime/artifact/Luna-home values allowed by the resolver.

Before sealing the distribution manifest, the separately authorized held acceptance
procedure must create the regular executable `worker-bin/pnpm` with the exact bytes
returned by exported `workerPnpmAlias(record.node.path, record.pnpm.path)` in the
compiled production-host module. This is a fixed single-purpose artifact: its
shebang selects accepted Node with `--no-global-search-paths`, and its only child
is the JSON-quoted accepted pnpm path with the original arguments, cwd and minimal
worker environment. It imports only Node's builtin child-process module. Include
the file in the complete manifest before calculating the content-derived release
ID; builds do not accept or install it. No mutable alias directory is created at
runtime. The resolver validates its exact bytes/executable identity before enabling
new work and puts its protected directory first in the worker PATH, ahead of Node,
Git and system directories. Supported Node shebang paths must be canonical
absolute paths without whitespace or control characters, and the complete header
must fit a conservative 127 UTF-8 bytes including newline: the kernel must select
that exact interpreter, with no shell/env fallback. Worker PATH components must
be canonical absolute directories without colons or control characters; spaces
in those directory segments remain literal. These representation checks affect
initiation only; unavailable initiation uses a safe system PATH for compatible
issued observation. The pnpm target is JSON-quoted and may contain spaces/colons.
Arbitrary selected pnpm basenames are supported without
exposing tool/config/credential variables to the isolated child. The independent
validator's existing protected aliases and seatbelt write-deny remain unchanged.
A valid compatible installation without a supported launcher retains original
issued observation but has unavailable initiation. Subsequent changes to manifested
artifacts still fail the existing immutable installation fence.

Program/ancestry checks reject aliases, unsafe ownership/modes and changed bytes.
Account-contained programs use the existing physical account-root guard, including its
root-owned sticky ancestor rule; externally installed OS programs retain strict complete
ancestry checks. A private tool copy is a distinct program identity, never an assertion
that the already-running process used those bytes. The running Node path must match.
The GitHub namespace must also be physically disjoint from candidate/workspace/object
roots, immutable releases, tools and Run/admission/dispatch authority stores.
The real Luna/Codex chain invokes the accepted Codex path explicitly. An injected test
process runner cannot acquire source-owned governed-runtime qualification. Only the
validated static composition with the original concrete process transport retains that
eligibility, rechecked before creation; this is separate from actual host qualification.
The runtime must be the accepted physical Node in the supported `>=24.21.0 <25` range, with exactly the fixed `--no-global-search-paths` option and no
loaders, preloads, NODE_PATH or dynamic linker injection. The package shebang,
driver and held helper all select that option; a bare Node invocation cannot
qualify an accepted installation. Initial acceptance hashes every actual distribution file, including dependencies and package-resolution metadata. Current fences compare protected record bytes and exact file/program inode, size, permissions, hardlink count, nanosecond modification/change times, and complete directory inventory; ordinary writes, replacements, permission/type changes and added files remove capability. This is a removal-only metadata check after initial byte validation, under the stated host confinement assumption.
Ancestor node_modules and CommonJS global dependency fallback directories are rejected; the required SDK entry must resolve physically inside the manifested dependency tree. Missing packages cannot borrow candidate/global code.
The installed entry then replaces inherited environment with the accepted narrow
snapshot. Git/gh use explicit program, environment and cwd; gh pins github.com and
GH_CONFIG_DIR. Each merge captures exactly one token with the pinned `gh auth token --hostname github.com`, then freezes a private `GH_TOKEN` environment for both `/user` and the expected-HEAD squash PUT. The numeric actor must match the accepted actor. This permits host-memory transfer, not zero-copy handling; the token never enters general transport, worker, validation, descriptors, stores or diagnostics. Selection is not retried or replaced if the namespace changes. Capture, actor, final-authority and request failures produce sanitized binding reasons without secret-bearing causes. Issued-only observation and settlement do not capture a merge token. Preflight reports the mechanism as configured and actor state as `not_probed`; it performs no auth or user probe.
Foreign repository REST and GraphQL requests are rejected before spawning gh.

The protected `production/host.json` is a separate, closed current authorization:

```json
{
  "schemaVersion": 1,
  "revision": "host-disabled-v1",
  "releaseId": "<accepted immutable release ID>",
  "manifestDigest": "<accepted distribution digest>",
  "enabled": false
}
```

Only an explicitly enabled record adds `merge`, exactly equal to the immutable
accepted `mergePolicy`. Unknown fields and missing/malformed/replaced records
remove merge initiation availability. Oracle and Sol remain typed unavailable;
there is no service URL, callback, raw credential, `qualified: true` or module field.

`production/dispatch.json` independently stores the existing strict dispatch
configuration. A queue location never manufactures merge opt-in. Its optional
`merge` must separately match the resolver host at the existing final issuance
fence. A missing descriptor, stale review/validation/HEAD/base, foreign claim,
owner mismatch, unsupported actor or missing objects still prevents issuance.
Normal initiation also checks the exact unchanged v7 configuration and exact routine Luna Run execution snapshot; a v7 label with contradictory executor/model/revisions is unavailable. Manual/unclaimed run and resume commands gain no dispatch merge authority. Compatible accepted installation and issued-only observation remain independent of this ordinary policy guard.

## Frozen process and original-attempt recovery

Each process captures one immutable installation/current-configuration snapshot.
Descriptor changes cannot hot-enable it. Installation or descriptor drift at
preparation, the durable possible-submission marker, or the final external request
removes initiation eligibility and latches restart/requalification required.
Drift checks are an additional fence, not atomic revocation or atomic BASE fencing.
The existing last-observed BASE and postmerge actual-parent/tree/ancestry semantics
remain unchanged. HOLD fences later requests, not a request already sent.

Dispatch finds issued work in the existing canonical stores before parsing current
ordinary configuration. A held cycle with no issued work stays model-free. A
compatible accepted installation retains its pinned GitHub observation route when
current host or dispatch opt-in is absent, malformed, disabled or replaced. It
uses `issuedMergeRecoveryConfiguration` for the original target/control location
only. The issued-only dependency view has no squash/create-PR capability, merge
host, current reviewer/lead service, implementation, validation or bootstrap route.
It cannot read a replacement queue, admit B, resubmit A, reset budgets, or release HOLD.

Existing Stage9 authenticated-completion requirements remain exact. Historical
receipt authentication is distinct from current submit/observe service availability.
The composition and diagnostics report independent `historicalVerification.review` and `.lead` availability. Missing required namespaces park before any Run write; each configured proof still must authenticate, including inactive requests.
The shipped resolver does not invent a historical Oracle/Sol authenticator from
receipt paths, digests, labels, GitHub identity, or a Run. Genuinely absent supported
historical authentication, absent observation auth, incompatible installation,
multiple issued owners, foreign receipts, active/unknown local ownership and
exhausted budgets retain unresolved ownership. Controlled tests supply the existing
historical receipts+authenticate dependency explicitly, without current reasoning
service callbacks; this is source evidence, not native service qualification.

## Held verification and launcher

The generated plist selects an absolute driver inside one particular accepted
release and pins its absolute Node program. That driver executes the same compiled
package entry. Durable runtime/profile/dispatch values come from protected records,
not interactive exports or a shell-sourced candidate policy. The old routine-only
v7 `luna-isolated / gpt-5.6-luna` policy remains unchanged.

The legal switch procedure is HOLD → independent drain/quiescence proof → held
release/configuration change → separately authorized restart → held verification.
Retain the known-good accepted artifact and immutable old policy evidence. Never
restore old Run/claim/owner JSON or use restart/lease expiry as stopped proof.

`production preflight` prints installation/artifact/root identities, binding
availability, v7 policy checks and HOLD without model calls or GitHub mutation.
After policy probes it checks the captured current initiation fence, then reads
typed HOLD last. Exit is 78 for unavailable initiation, descriptor/artifact drift,
or inactive/missing/invalid HOLD. The report includes that final HOLD status and
the initiation refusal reason. A healthy accepted routine policy with active HOLD
and a valid DISABLED merge descriptor may succeed; enabled merge, available model
roles and live actor qualification are not prerequisites. This read-only result
does not promise future atomic HOLD persistence or establish native acceptance.
`<accepted-release>/scripts/issue-104-deploy.sh preflight` (or `held-check`) invokes that same entry through its absolute physical path.
The helper refuses `restart`; it does not install, accept, kickstart launchd, copy
secrets or release HOLD. Failed verification preserves current state and artifacts.
The launchd renderer defaults stdout/stderr to the account's `.tachiko-conductor/dispatch/`
directory and rejects explicit log paths inside `releases/`, including normalized traversal.
It requires the selected physical release as WorkingDirectory. The held helper also changes
to its physical release and inherits only its caller's output streams; it creates no logs.
The entry derives authority from the accepted artifact, while Git/gh use the pinned object-root
cwd. Rendering checks physical log aliases and ancestry; host confinement must preserve those
objects after rendering.

Protected filesystem/process confinement and the actual qualified launcher remain
the root of trust. An unrestricted malicious process with the host owner's write
access can replace acceptance records or programs; in-process hashing cannot
retroactively authenticate already executed malicious code. Activation remains
blocked until the actual host boundary and service facts have attributable proof.

Normal workflow effects carry the captured production Run fence through final review/lead
preparation, marker and request cuts, worker/repair creation, validation probes/commands
and governed publication. Synchronous issue checks run after the last awaited claim read.
Current descriptor/installation drift only removes eligibility; observation callbacks do
not inherit this initiation gate. Explicit `run transition <id> merged` authenticates all
retained terminal review/lead/inactive proof records again before admission/owner writes,
using original configured verifiers. Legacy structural readability and separately guarded
stopped-owner attestation do not become authenticated completion or merge authority.

The routine worker has two explicit process routes: the accepted Codex entry for model execution, and the accepted Git executable for the exact `rev-parse HEAD` completion read. The HEAD route rejects every other executable/argument sequence. Both selected transports participate in the existing source-owned Luna qualification identity; controlled injected transports prove selection and completion only, and confer no governed runtime qualification. Shared Git observation remains installation-scoped so revoked current initiation does not disable issued observation or cleanup.

Accepted Codex and pnpm runtime directories must be physically disjoint in both containment directions from the selected object repository and GitHub namespace, including nonstandard directory names. Repair plan/prepare mutation callbacks, post-plan bootstrap persistence in both promoted and resumed workflow paths, and the final native repair consumption CAS check the captured normal Run fence after their last awaited authority read. These checks do not apply to historical issued-only settlement.

Tests provision only their newly created private account tree with private directory/file permissions before accepting either transpiled or TypeScript-compiled artifacts. They never change shared runner/tool/source permissions. Successful controlled JSONL plus exact accepted Git HEAD output is a process-selection proof without a real model; actual compiled-child entry, real Git lifecycle and normal CI are separate checks. No personal Mac executor is connected or qualified in this session; the user's machine existence is unknown.

A first bootstrap plan may precede physical workspace admission. The planning fence checks the exact captured Run, current lane ownership token, and captured production configuration. The existing explicit/planned workspace-strengthening protocol then establishes workspace authority before full mutation admission. Actual prepare, worker and publication boundaries retain their full workspace/current-owner/Run checks; a workspace-less initial lane is not itself physical mutation authority.

The launchd renderer requires an existing physical accepted release (driver, compiled entry and record), rejects lexical/symlink aliases including `current`, and requires WorkingDirectory to equal that selected physical release. The driver and held helper likewise reject alias spellings and explicitly change to their physical release before invoking the compiled entry. Log parents must already exist with safe physical ancestry; existing log files must be regular, account-owned, unaliased and not writable by others. Both explicit and default logs remain outside immutable releases. These are rendering/startup checks under the existing protected-host assumption, not an executed macOS supervisor/reboot or unrestricted same-owner compromise guarantee.

`pnpm test:stage10-diagnostic` is an additional fixed focused selection using the existing Node/tsx route and built-in TAP reporter. The current author-validation workflow includes the temporary focused step and shared typecheck bound described above. The final ordinary candidate must remove only that step; every full ordinary unit/browser/typecheck/root/Tower command remains. Case/cut traces contain only literal labels, counters and booleans. A diagnostic checkpoint or partial result is not normal-tier acceptance. Deferred gate tests race both early workflow outcomes and release/await settlement in finally before cleanup.

The actual accepted runtime uses the existing supported Node predicate (`>=24.21.0 <25`) while its executable path and bytes remain exactly accepted. Simulated process.version tests exercise this boundary; a different actual binary still requires a different accepted identity. Accepted actor IDs must already be canonical positive safe-integer decimal strings before merge authority or configured preflight status is exposed; this local validation performs no actor/auth probe.

The retained diagnostic utility currently selects production-host.test.ts and review-loop.test.ts with twelve fixed H1/H2/I1 title alternatives: accepted worker tools/representation and held-preflight authority, promoted repair planning/reconciliation, and affected deferred-gate lifecycle. Earlier E1–E4 installed-entry selection and its timeout are historical evidence; those full installed-entry cases remain in the unchanged ordinary suite. Their original-task parsing, imported immutable history and original authenticators are never rewritten. Diagnostic observations remain separate from every ordinary test/build gate.
