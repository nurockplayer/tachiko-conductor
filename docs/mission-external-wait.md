# Desktop Mission Lead external waits

`tachiko mission wait start` installs a detached, model-free supervisor for one
long-running worker, subprocess, or CI check. The mission ID is independent of a
Conductor Run. `tachiko mission wait status <id>` is diagnostic and strictly
read-only. After `start` returns, the Mission Lead ends its turn; it does not
poll status or wait on the monitor session. The supervisor observes the external
subject and only invokes the configured callback at a meaningful terminal or
policy-timeout boundary.

Pass commands as JSON argument arrays. They run directly without a shell, so
shell expansion, pipes, and redirects do not apply. The probe prints exactly
one bounded JSON object. For example:

```sh
export TACHIKO_MISSION_CODEX_SESSION_ID='01234567-89ab-cdef-0123-456789abcdef'

tachiko mission wait start issue-47-ci \
  --owner 'operator@example.com' \
  --session-id "$TACHIKO_MISSION_CODEX_SESSION_ID" \
  --probe-argv '["./scripts/mission-status","issue-47-ci"]' \
  --wake-argv '["node","scripts/mission-codex-wake.mjs"]' \
  --poll-interval-ms 30000 \
  --probe-timeout-ms 15000 \
  --timeout-ms 86400000 \
  --on-timeout continue
```

`owner`, `session-id`, `worktree`, and `cwd` are saved in the mission ledger.
`worktree` and `cwd` default to the current Git worktree and current directory.
The detached supervisor refuses to resume if those paths drift. Reusing a
mission ID with a different owner, session, path, probe, callback, or timeout
configuration fails closed. The persisted session ID is passed to the callback;
it does not depend on a later shell environment change.

The probe must exit successfully and print one JSON object no larger than 16
KiB. `status` must be `running`, `active`, `completed`, `failed`, or `blocked`.
Optional fields are non-negative monotonic `items` and `turns` counters and
bounded `activeItemId` / `lastCompletedTurnId` strings. The probe should read
the source of truth (for example, a worker's process state or CI run status) and
normalize that result. Probe execution is bounded by `--probe-timeout-ms`; a
timeout, non-zero exit, malformed JSON, or invalid status creates a failed
receipt rather than leaving a silent waiter.

The durable receipt is written before the callback starts. The callback receives
`TACHIKO_MISSION_RECEIPT_ID`, `TACHIKO_MISSION_RECEIPT_PATH`, and
`TACHIKO_MISSION_ID`; the stable receipt ID is its idempotency key. Generic
callbacks are delivered at least once, so they must durably deduplicate that
key. The included Codex callback runs `codex exec resume --json`, saves stdout
and stderr in a local log directory, and only acknowledges delivery after it
observes the `turn.started` JSONL event recognized by the repository's Codex CLI
adapter. OS process spawn alone does not count as accepted. If Codex exits before
that event, the pending claim is removed so a retry can launch it. If a callback
or supervisor crashes in the ambiguous interval, retry checks the log and live
child before deciding whether the receipt was accepted; inspect claim and logs
if that state remains uncertain. Once acceptance is durably recorded, another
callback invocation with the same receipt ID cannot start a second turn.

This is a Codex CLI continuation adapter, not a native ChatGPT Desktop
continuation API. Desktop receives no built-in wake from this monitor. Ending a
Desktop turn after `start` only works when an external callback is configured to
resume the intended session. The repo heartbeat at
`scripts/bootstrap-heartbeat/runner.py` directs future Mission Lead turns to
use this path only when a stable session ID and callback are available. Its
prompt is guidance for future CLI wakes only; it does not provide or make a
native Desktop task continuation safe or automatic. Current scheduled Codex
turns do not have a native Desktop session binding.

`--timeout-ms` is an overall observation deadline and defaults to 24 hours.
With `--on-timeout continue` (the default), reaching the deadline advances the
next deadline and monitoring continues model-free; no receipt or callback
occurs. With `--on-timeout policy-action`, reaching the deadline while the
subject is active writes one bounded `timeout-policy` receipt and invokes the
same callback boundary once. Its receipt status is `active`, distinguishing a
wait timeout from completion or failure.

Repeat `mission wait start` with the same ID and options to restart a stopped
supervisor or retry a failed callback. Reusing the ID with different options
fails closed. A same-host writer lock serializes start and supervisor state
writes. The supervisor does not install a watchdog: if the process exits,
observation stops until the deterministic service/scheduler starts it again.
For unattended waits, run start from a persistent user service or model-free
watchdog that restarts on reboot. Repeated start calls are safe while the
supervisor owns its lock. State is stored under `$TACHIKO_MISSION_WAIT_DIR`, or
by default beside the Conductor run directory at `../missions`.

Example CI probe output:

```json
{"status":"running","items":2,"turns":1}
```

Then, when the check finishes:

```json
{"status":"completed","items":2,"turns":1}
```

Repeated reports of the same normalized state do not create receipts or wake
callbacks. `continue` deadlines only advance the model-free observation window.
