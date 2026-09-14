# Tachiko Conductor bootstrap heartbeat

This macOS-first bootstrap polls bounded GitHub state without calling a model. It wakes one
replaceable target only when the normalized state changes or 30 minutes have elapsed since the
last successful reconciliation. GitHub, canonical `agent-handoff:v1` comments, exact PR heads,
and the repository's standing SCD policy remain authoritative; this is not a queue, lease, or
workflow engine.

## Operator commands

From the repository root:

```sh
scripts/bootstrap-heartbeat/install.sh
scripts/bootstrap-heartbeat/status.sh
scripts/bootstrap-heartbeat/one-shot.sh
scripts/bootstrap-heartbeat/uninstall.sh
```

Installation defaults to a 180-second LaunchAgent interval and a 1,800-second safety interval.
Each GitHub poll has a 60-second subprocess timeout so a stalled request cannot retain the lock
forever. The bounded GraphQL projection rejects truncation and any GitHub-reported query cost over
100 points, keeping the 180-second schedule sustainable. Wake execution has a 1,500-second deadline; timeout terminates its isolated process
group and leaves the fingerprint unconsumed for retry. Exit zero alone is a re-entry boundary:
the target must also print `TACHIKO_HEARTBEAT_SETTLED_V1` on its own final line to consume the
fingerprint and reset the safety clock. Installation resolves `gh`, validates the audited ChatGPT-bundled Codex executable,
records the exact user-owned SCD profile digest, primes a GitHub baseline without waking Codex,
and loads `io.tachiko.conductor.scd-heartbeat`.
The resolved `gh` executable is opened and checked for root/current-user ownership and safe leaf
permissions during installation, then copied from that verified descriptor into a digest-named,
mode-0700 snapshot in the private state directory. Polls execute those pinned bytes rather than
reopening a replaceable Homebrew path; a successful reinstall prunes older digest snapshots.
Installation updates config, plist, pinned snapshots, and the loaded service as one rollback-capable
operation; an activation failure restores the previous installed files and loaded service.

State and bounded logs live in
`~/Library/Application Support/io.tachiko.conductor.scd-heartbeat/`; the generated plist lives
in `~/Library/LaunchAgents/`. Uninstall removes and unloads only the plist, preserving state and
logs for diagnosis.

Use `runner.py install --help` for interval and path overrides. `one-shot.sh` runs the same
change detector as launchd; `runner.py run --prime` deliberately resets the baseline without a
wake.

## Replace the wake target

The detector executes the absolute argv array in `config.json`; it has no knowledge of Codex or
Conductor dispatch semantics. The default installer generates the current direct SCD/Codex argv.
After the native dispatcher is available, reinstall with an explicit command such as:

```sh
scripts/bootstrap-heartbeat/install.sh \
  --acknowledge-relocatable-wake-target \
  --wake-command-json '["/absolute/path/to/node","/absolute/path/to/tachiko-conductor/dist/cli.js","dispatch","once"]' \
  --required-file /absolute/path/to/tachiko-conductor/dist/cli.js
```

That changes only the launcher boundary. Fingerprinting, wake policy, lock, state, and LaunchAgent
remain unchanged. The acknowledgement is required because wake execution uses a private verified
snapshot: only the first argv entry must be relocation-safe. Location-dependent CLI scripts remain
at their original path by running them as an argument to a relocation-safe interpreter, as in the
future `tachiko dispatch once` example above; `--required-file` pins and validates that entry file.
Installation rejects executable symlinks up front rather than accepting an unusable configuration.
Every replaceable target uses the same provider-neutral completion protocol: emit
`TACHIKO_HEARTBEAT_SETTLED_V1` only after all currently executable in-scope work is settled or
there is no executable work. A successful process exit without that acknowledgement remains
eligible for the next poll instead of sleeping until the safety interval.
Install and uninstall acquire the same heartbeat flock as polling and wake execution. They fail
closed while a poll or wake is active, so config, plist, and verified executable snapshots cannot
be replaced concurrently.

## Fail-closed behavior

- Pagination/truncation, invalid GitHub data, invalid state/config, or an unsafe wake target never
  wakes a model. Wake executables must be owned by root/current user, must not be group/world
  writable, and are SHA-256 pinned at install time alongside the default SCD profile. Each wake
  executes a private snapshot copied from the already-verified executable descriptor, so a
  pathname replacement between verification and launch cannot change the executed bytes.
- One advisory `flock` covers collection and the entire direct wake. A dedicated same-host guard
  retains it if the supervisor dies, while the wake target and its background descendants never
  inherit the descriptor. Normal direct-child completion releases the guard without waiting for
  background work or descendant-held output pipes. A nonblocking, volume-bounded tail drain
  preserves the direct target's final completion acknowledgement. Forced timeout cleanup retains
  the flock through TERM/KILL of the entire target group.
  Concurrent launchd fires cannot create another writer.
- Invalid lock metadata or unlocked metadata naming a live/unknown owner fails closed. Metadata for
  a provably exited PID can be recovered because the kernel lock has already been released.
- A failed wake does not consume the changed fingerprint or reset the safety clock.
- A zero-exit wake without the explicit settled acknowledgement also does not consume it.

Run focused tests with:

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/bootstrap-heartbeat/test_runner.py
```
