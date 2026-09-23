# Desktop Mission Lead external waits

`tachiko mission wait start` installs a detached, model-free supervisor for one
long-running worker, subprocess, or CI check. The mission ID is independent of a
Conductor Run. `tachiko mission wait status <id>` reads only its durable state;
it does not invoke the probe or a model. The supervisor polls until it sees
`completed`, `failed`, or `blocked`, then stores one bounded receipt and invokes
the optional wake command.

Pass commands as JSON argument arrays. They are executed directly without a
shell, so shell expansion, pipes, and redirects do not apply. Keep credentials
in the child process environment or an existing credential helper; command
arguments are saved in a mode-0600 local state file.

```sh
export TACHIKO_MISSION_CODEX_SESSION_ID='01234567-89ab-cdef-0123-456789abcdef'

tachiko mission wait start issue-47-ci \
  --probe-argv '["./scripts/mission-status","issue-47-ci"]' \
  --wake-argv '["node","scripts/mission-codex-wake.mjs"]' \
  --poll-interval-ms 30000 \
  --probe-timeout-ms 15000
```

After `start` returns, the Mission Lead ends its turn. It does not poll `status`
or wait on the command session. The detached supervisor invokes the callback at
the decision boundary, and the callback resumes the configured Codex CLI
session with `codex exec resume <session-id> <prompt>`. `status` is for a human
operator diagnosing the monitor, not a model polling loop. The included
`scripts/mission-codex-wake.mjs` is a working Codex CLI callback; set the session
ID in `TACHIKO_MISSION_CODEX_SESSION_ID` before starting the monitor.

The probe must exit successfully and print one JSON object no larger than 16
KiB. `status` must be `running`, `active`, `completed`, `failed`, or `blocked`.
Optional fields are non-negative monotonic `items` and `turns` counters and
bounded `activeItemId` / `lastCompletedTurnId` strings. The probe should read
the source of truth (for example, a worker's process state or CI run status)
and normalize that result. Probe execution is bounded by
`--probe-timeout-ms`; a timeout, non-zero exit, malformed JSON, or invalid
status creates a failed receipt so monitoring errors do not leave a silent
waiter.

The callback receives `TACHIKO_MISSION_RECEIPT_ID`,
`TACHIKO_MISSION_RECEIPT_PATH`, and `TACHIKO_MISSION_ID` in its environment.
The receipt is persisted before the callback starts. Callback delivery is
at-least-once: after a crash between the callback's action and its success
record, `mission wait start` can retry it with the same receipt ID. The included
Codex callback fsyncs a claim file keyed by that ID, starts `codex exec resume`
as a detached child, and returns after the OS confirms the child started. Its
stdout and stderr go to separate files under the claim directory's `logs/`
subdirectory (override with `TACHIKO_MISSION_CODEX_LOG_DIR`). A retry cannot
start another turn for the same receipt. This is deliberately at-most-once
after the claim: a crash between claim creation and CLI startup can leave a
receipt unhandled. Inspect the claim, logs, and Codex session before manually
resolving that case. An immediate process spawn error removes the claim so a
later callback retry can try again. A Desktop API adapter should use the same
durable receipt claim before enqueueing its continuation.

Repeat `mission wait start` with the same ID and options to restart a stopped
supervisor or retry a failed callback. Reusing the ID with different options
fails closed. The monitor owns a same-host lock and prevents concurrent state
writers. It does not install its own watchdog: if the supervisor process exits,
observation stops until an operator or service calls the same `start` command
again. For unattended hours-long waits, run that command from a persistent
user service that restarts on reboot, or from a model-free watchdog loop, for
example:

```sh
while true; do
  tachiko mission wait start issue-47-ci \
    --probe-argv '["./scripts/mission-status","issue-47-ci"]' \
    --wake-argv '["node","scripts/mission-codex-wake.mjs"]' \
    --poll-interval-ms 30000 \
    --probe-timeout-ms 15000
  sleep 60
done
```

The start lock and supervisor lock make repeated watchdog calls safe; an active
supervisor owns the only write lock. State is stored under
`$TACHIKO_MISSION_WAIT_DIR`, or by default beside the Conductor run directory
at `../missions`.

Example probe contract for a CI wrapper:

```json
{"status":"running","items":2,"turns":1}
```

Then, when the check finishes:

```json
{"status":"completed","items":2,"turns":1}
```

Repeated reports of the same normalized state do not create receipts or wake
callbacks. A timeout with no completion, failure, or blocked transition has no
model action; the detached supervisor keeps waiting.
