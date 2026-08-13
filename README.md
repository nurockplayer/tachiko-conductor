# Tachiko Conductor

Local orchestration core for the Tachiko Conductor product: a deterministic
workflow state machine that drives a GitHub issue from **READY** through
implementation, validation, independent review, and a final merge-ready gate.

This repository currently implements **[issue #2]** only: the typed core, the
state machine, durable local run state, and the adapter *interfaces*. No
transport or model adapters are implemented yet (issues #3–#6).

## Design invariants

- GitHub will later be the engineering source of truth; the core only ever
  sees plain data.
- Core workflow logic is independent of Claude Code, DeepSeek, GitHub
  transport, and Linear.
- Reviews are bound to an exact HEAD SHA; `FINAL_GATE` refuses stale approvals.
- No autonomous merge, no cloud, no distributed queue, no UI, no Linear.

## States

`READY`, `IMPLEMENTING`, `VALIDATING`, `REVIEWING`, `CHANGES_REQUESTED`,
`FINAL_GATE`, `MERGE_READY`, `MERGED`, `WAITING_DEPENDENCY`, `NEEDS_HUMAN`,
`FAILED`.

`MERGED` and `FAILED` are terminal; no transition can leave them.

## Transitions

| Event | Allowed from | Goes to |
| --- | --- | --- |
| `start` | `READY` | `IMPLEMENTING` |
| `agent_succeeded` | `IMPLEMENTING` | `VALIDATING` |
| `agent_failed` | `IMPLEMENTING` | `FAILED` |
| `validation_passed` | `VALIDATING` | `REVIEWING` |
| `validation_failed` | `VALIDATING` | `CHANGES_REQUESTED` |
| `review_approved` | `REVIEWING` | `FINAL_GATE` |
| `changes_requested` | `REVIEWING` | `CHANGES_REQUESTED` |
| `start_fix` | `CHANGES_REQUESTED` | `IMPLEMENTING` |
| `gate_passed` | `FINAL_GATE` | `MERGE_READY` |
| `gate_blocked` | `FINAL_GATE` | `REVIEWING` |
| `merged` | `MERGE_READY` | `MERGED` |
| `wait_dependency` | any active state | `WAITING_DEPENDENCY` |
| `dependency_satisfied` | `WAITING_DEPENDENCY` | resume interrupted state |
| `escalate` | any active state | `NEEDS_HUMAN` |
| `human_resolved` | `NEEDS_HUMAN` | resume interrupted state |
| `fail` | any non-terminal state | `FAILED` |

Anything else throws an `InvalidTransitionError` whose message names the
invalid transition, the current state, and the allowed transitions. The final
gate is enforced in the core: `gate_passed` only succeeds when the latest
review result is bound to the run's current HEAD SHA.

Transitions persist only the payloads they produce: agent results are bound to
`agent_succeeded`/`agent_failed` (and must carry a matching exit status),
review results to `review_approved`/`changes_requested`, and the run's HEAD
SHA may only be changed by implementation transitions. A gate or merge can
never swap in an unreviewed SHA.

## Quick start

```bash
pnpm install
pnpm test        # run the test suite (node:test + tsx)
pnpm typecheck   # type-check src and tests
pnpm build       # emit dist/ for the `tachiko` bin
```

## CLI

```bash
pnpm exec tsx src/cli.ts run create --owner acme --repo widgets --issue 42
pnpm exec tsx src/cli.ts run show <id>
pnpm exec tsx src/cli.ts run transition <id> start
pnpm exec tsx src/cli.ts run list
```

`agent_succeeded`, `agent_failed`, `review_approved` and `changes_requested`
require result payloads supplied by adapters; `run transition` rejects them
explicitly. Drive those through the domain API (`applyTransition`).

After `pnpm build`, the same commands work through the `tachiko` bin
(`node dist/cli.js`). Run state is stored under `$TACHIKO_DATA_DIR` (default
`~/.tachiko-conductor/runs`), one `<id>.json` file per run.

## Persistence

`JsonFileStore` writes each run as a JSON file using an atomic
write-then-rename, so a crash mid-write never corrupts the committed file and a
run survives a process restart intact. A fresh store instance pointed at the
same directory resumes the run exactly where it stopped.

## Layout

```
src/domain/            typed core: types, run factory, state machine
src/store/             durable run persistence
src/adapters/          typed boundaries for GitHub, agents, reviewers (not implemented)
src/cli.ts             minimal CLI entrypoint
tests/                 state-machine, store, resume, adapters, CLI tests
```

[issue #2]: https://github.com/nurockplayer/tachiko-conductor/issues/2
