# Tachiko Conductor bootstrap heartbeat

This macOS-first bootstrap polls bounded GitHub state without calling a model. It wakes the
qualified GPT-6 Sol target when normalized state changes or the safety interval elapses. GitHub,
canonical `agent-handoff:v1` comments, exact PR heads, and the repository policy remain
authoritative; this is not a queue or workflow engine.

## Operator commands

From the repository root:

```sh
scripts/bootstrap-heartbeat/install.sh
scripts/bootstrap-heartbeat/status.sh
scripts/bootstrap-heartbeat/one-shot.sh
scripts/bootstrap-heartbeat/uninstall.sh
```

Installation defaults to a 180-second LaunchAgent interval and a 1,800-second safety interval.
Each GitHub poll has a 60-second timeout and rejects truncated results or query cost above 100.
Wake execution has a 1,500-second deadline. Exit zero alone is a re-entry boundary: the target
must also print `TACHIKO_HEARTBEAT_SETTLED_V1` on its own final line before the fingerprint is
consumed and the safety clock reset.

Before any wake, the runner verifies and calls a pinned, model-free TypeScript helper built during
installation from a private `git archive` of one captured commit. It never consumes ambient
`dist/` or `node_modules`. The helper reserves the same host-global mission-admission registry used by
dispatch and manual work. It pins the resolved Node executable, the complete built JavaScript
import closure, the registry path, repository/workspace identity, and an explicit revisioned
capacity configuration at installation. Nondefault positive limits are supported when supplied
with `--admission-config-json`. All entry paths use the canonical per-user registry at
`$HOME/.tachiko-conductor/mission-admission/registry.json`; the installer rejects a different
`--admission-registry-path` or inherited path override. A physical symlink alias that resolves to
that canonical file is accepted. This keeps heartbeat, native dispatch, and manual admission on
one host ownership domain.
The build requires clean committed TypeScript/build inputs, the repository's exact
`pnpm@10.34.5` lockfile, and a pinned Node/Corepack/TypeScript identity. Its canonical manifest
binds commit and tree IDs, archive/package/lockfile digests, toolchain identities, every emitted
`dist/` file, and the runtime import closure. Installation verifies and atomically pins exactly those
bytes, reusing a bundle only when its full manifest and files match. Use `--no-load` to prepare and
validate an install without bootstrapping LaunchAgent; this does not enable the held service.
The LaunchAgent does not inherit arbitrary admission-domain variables. `wake_env` cannot override
the registry, config, Run root, or private receipt directory.

Only a fresh `reserved` result permits a wake. Capacity waits and known owners are quiet and
model-free. `already_reserved` is reconciliation evidence and never starts another process. A
helper/config/receipt error fails closed. Admission receipts are private 0600 files in the pinned
host receipts directory; ordinary output, bounded operational state, wake argv, and logs contain
no capability token.

The guard inherits the heartbeat lock and retains it across supervisor death. It releases the
registry generation only after the direct target has exited and process-group inspection proves
the group empty. Unknown process inspection, uncertain child state, stale/corrupt receipts, or
failed helper settlement retain custody. A surviving same-group descendant keeps both the lock
and admission reservation, even after the direct process exits. It is not treated as stopped just
because its parent returned. The `supervisorStopped` proof means the direct wake process exited;
`childrenStopped` means the guard observed the process group empty at the recorded time.
The heartbeat invocation waits for that guard result before deciding whether the fingerprint was
settled, so a successful direct marker is not retried while a same-group child is still running.
The model-free helper trusts the pinned runner and guard as its supervisor for stop attestation:
the helper verifies the exact private receipt and current registry generation, while the runner
and guard are responsible for asserting that the managed provider and contained children have
stopped before settlement. This is a trusted local process boundary, not independent proof against
a malicious same-user process or a target that violates the documented no-detach contract.

The supported target is the pinned default Codex executable and companion running the fixed
GPT-6 Sol/high profile. `--codex` and `--profile` overrides are rejected. Custom wake targets,
including a target named `dispatch once`, remain disabled until a verified native admission and
process-containment adapter exists. The process-group check covers the target's session group; it
cannot prove that a target never detached a mutation-capable descendant. The default target is
accepted under the operational contract that it does not daemonize or detach mutation-capable
children. Any inspection uncertainty fails closed. The obsolete Terra target is not installed;
the service remains held if the required Sol profile is unavailable or does not declare GPT-6 Sol
at high reasoning effort.

## Migration and recovery

Config schema 2 pins the helper build manifest, Node bytes, fixed admission domain, and wake target
contract. Existing schema-1 configs are rejected. `install.sh` creates a fresh staged build from the
captured committed source and performs the full provenance verification itself:

```sh
scripts/bootstrap-heartbeat/install.sh --no-load
```

Valid state schema 1 fingerprints migrate without claiming any old reservation is safe. State
schema 2 records a private supervisor UUID, host/boot identity, process identity, exact registry
generation/receipt ID, and either `reserved_pre_execution` or `spawn_uncertain`. A caught failure
before `Popen` settles the exact generation. On re-entry, reconciliation runs under the canonical
heartbeat lock before the unchanged-GitHub fast path. Automatic orphan settlement requires the same
durable host and a verified different boot, or same-boot proof that the owner process died while
still `reserved_pre_execution`. Same-boot `spawn_uncertain` remains fenced even if a PID or process
group appears empty; process death alone cannot prove descendants stopped. `already_reserved` never
authorizes a spawn. Installation does not take over or expire an active mission based on age. To
investigate a retained reservation, first verify the
supervisor and its process group are stopped. The private receipt is at the configured receipts
directory; inspect it locally with owner-only permissions and compare its generation/supervisor
identity with `dispatch admission status`. Never copy its token into argv, logs, projections, or
GitHub. Recovery settlement must use the pinned helper with the exact receipt generation and
explicit stop proof. If the receipt is missing/corrupt or the process tree cannot be proven stopped,
leave admission held for operator reconciliation.

State and bounded logs live in
`~/Library/Application Support/io.tachiko.conductor.scd-heartbeat/`; the generated plist lives
in `~/Library/LaunchAgents/`. Uninstall removes and unloads only the plist, preserving evidence.
Install and uninstall share the heartbeat lock and fail while a poll or wake is active.

Run focused tests with:

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/bootstrap-heartbeat/test_runner.py
```
