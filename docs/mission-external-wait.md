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
tachiko mission wait start issue-47-ci \
  --probe-argv '["./scripts/mission-status","issue-47-ci"]' \
  --wake-argv '["./scripts/desktop-wake","--mission","issue-47-ci"]' \
  --poll-interval-ms 30000 \
  --probe-timeout-ms 15000

tachiko mission wait status issue-47-ci
```

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
record, `mission wait start` can retry it with the same receipt ID. A Desktop
continuation adapter must durably consume that ID before asking the Desktop
agent to continue; this is the idempotency boundary that prevents one receipt
from starting multiple model turns. Keep the callback short and have it enqueue
the continuation if the Desktop API can take a long time.

Repeat `mission wait start` with the same ID and options to recover a stopped
supervisor or retry a failed callback. Reusing the ID with different options
fails closed. The monitor owns a same-host lock, and `status` remains safe to
poll from the Desktop interface because it never performs the wait itself.
State is stored under `$TACHIKO_MISSION_WAIT_DIR`, or by default beside the
Conductor run directory at `../missions`.

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
