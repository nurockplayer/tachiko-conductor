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
forever. Wake execution has a 1,500-second deadline; timeout terminates its isolated process
group and leaves the fingerprint unconsumed for retry. Installation resolves `gh`, validates the audited ChatGPT-bundled Codex executable,
records the exact user-owned SCD profile digest, primes a GitHub baseline without waking Codex,
and loads `io.tachiko.conductor.scd-heartbeat`.

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
  --wake-command-json '["/absolute/path/to/tachiko","dispatch","once"]'
```

That changes only the launcher boundary. Fingerprinting, wake policy, lock, state, and LaunchAgent
remain unchanged.

## Fail-closed behavior

- Pagination/truncation, invalid GitHub data, invalid state/config, or an unsafe wake target never
  wakes a model. Wake executables must be owned by root/current user and have a non-writable
  resolved path chain.
- One advisory `flock` covers collection and the entire wake. Concurrent launchd fires observe the
  lock and exit without creating another writer.
- Invalid lock metadata or unlocked metadata naming a live/unknown owner fails closed. Metadata for
  a provably exited PID can be recovered because the kernel lock has already been released.
- A failed wake does not consume the changed fingerprint or reset the safety clock.

Run focused tests with:

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 scripts/bootstrap-heartbeat/test_runner.py
```
