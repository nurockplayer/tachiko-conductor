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
- `repository`: exactly `{ "owner", "repo", "objectRoot" }`;
- `github`: exactly `{ "configDirectory", "actorId", "qualification",
  "observationQualification", "confinementQualification" }`. `actorId` is the
  exact GitHub numeric account ID rendered as a string. These are nonsecret
  references to actual host evidence, never a substitute for producing it;
- `mergePolicy`: the complete existing `NativeMergePolicy`, including repository,
  control location, base branch, campaign, release and all policy revisions;
- `environment`: only the nonsecret #104 implementation/profile/local-validation/
  hosted-policy and pinned runtime/artifact/Luna-home values allowed by the resolver.

Program/ancestry checks reject aliases, unsafe ownership/modes and changed bytes.
The runtime must be the accepted physical Node 24.21.0, with exactly the fixed `--no-global-search-paths` option and no
loaders, preloads, NODE_PATH or dynamic linker injection. The package shebang,
driver and held helper all select that option; a bare Node invocation cannot
qualify an accepted installation. Initial acceptance hashes every actual distribution file, including dependencies and package-resolution metadata. Current fences compare protected record bytes and exact file/program inode, size, permissions, hardlink count, nanosecond modification/change times, and complete directory inventory; ordinary writes, replacements, permission/type changes and added files remove capability. This is a removal-only metadata check after initial byte validation, under the stated host confinement assumption.
Ancestor node_modules and CommonJS global dependency fallback directories are rejected; the required SDK entry must resolve physically inside the manifested dependency tree. Missing packages cannot borrow candidate/global code.
The installed entry then replaces inherited environment with the accepted narrow
snapshot. Git/gh use explicit program, environment and cwd; gh pins github.com and
GH_CONFIG_DIR and checks `/user` against the accepted actor ID before squash.
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
Its exit is 78 unless an accepted installation, held state and existing v7 preflight
all pass. Its report explicitly does not establish real binding/native acceptance.
`scripts/issue-104-deploy.sh preflight` (or `held-check`) invokes that same entry.
The helper refuses `restart`; it does not install, accept, kickstart launchd, copy
secrets or release HOLD. Failed verification preserves current state and artifacts.
The launchd renderer defaults stdout/stderr to the account's `.tachiko-conductor/dispatch/`
directory and rejects explicit log paths inside `releases/`, including normalized traversal.
It renders the explicitly supplied working directory. The held helper inherits its caller's
working directory and output streams; it creates no logs. The entry derives authority from
the accepted artifact, while Git/gh use the pinned object-root cwd regardless of caller cwd.
Host acceptance must also ensure configured log paths do not physically alias a release.

Protected filesystem/process confinement and the actual qualified launcher remain
the root of trust. An unrestricted malicious process with the host owner's write
access can replace acceptance records or programs; in-process hashing cannot
retroactively authenticate already executed malicious code. Activation remains
blocked until the actual host boundary and service facts have attributable proof.
