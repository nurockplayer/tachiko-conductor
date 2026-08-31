# Tachiko Conductor

Local orchestration core for the Tachiko Conductor product: a deterministic
workflow state machine that drives a GitHub issue from **READY** through
implementation, validation, independent review, and a final merge-ready gate.

This repository implements **[issue #1]**'s MVP scope across **[issue #2]**
through **[issue #6]**: the typed core, the deterministic state machine,
durable local run state, the adapter *interfaces*, the GitHub live-state
adapter (with an injected `gh` CLI transport and agent-handoff parser), a
Claude Code execution adapter, an independent DeepSeek review loop, and the
end-to-end `tachiko run owner/repo#123` command with a structured human
interrupt protocol.

## Design invariants

- GitHub will later be the engineering source of truth; the core only ever
  sees plain data.
- Core workflow logic is independent of Claude Code, DeepSeek, GitHub
  transport, and Linear.
- Reviews are bound to an exact HEAD SHA; `FINAL_GATE` refuses stale approvals.
- An approval containing a blocking finding is contradictory and is rejected
  before it can reach the final gate.
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
pnpm exec tsx src/cli.ts run owner/repo#123
pnpm exec tsx src/cli.ts run resume <id> --decision <choice>
pnpm exec tsx src/cli.ts run create --owner acme --repo widgets --issue 42
pnpm exec tsx src/cli.ts run show <id>
pnpm exec tsx src/cli.ts run transition <id> start
pnpm exec tsx src/cli.ts run list
pnpm exec tsx src/cli.ts github snapshot nurockplayer/tachiko-conductor#42
```

`run owner/repo#123` starts or continues one issue end-to-end: implementation,
validation, independent review, and the final gate. It stops at `MERGE_READY`,
`FAILED`, or a structured `NEEDS_HUMAN` interrupt (reason, evidence, bounded
choices); resume a parked run with `run resume <id> --decision <choice>`.

`github snapshot` prints one normalized live-state JSON envelope from the
locally authenticated `gh` CLI: `{"ok":true,"snapshot":...}` on success, or
`{"ok":false,"error":{code,message,retryable,details}}` on stderr with a
non-zero exit code.

`agent_succeeded`, `agent_failed`, `review_approved` and `changes_requested`
require result payloads supplied by adapters; `run transition` rejects them
explicitly. Drive those through the domain API (`applyTransition`).

## Smoke paths

The opt-in Claude Code smoke test invokes the installed `claude` CLI
non-interactively once and is never part of CI:

```bash
TACHIKO_SMOKE=1 pnpm exec tsx --test tests/claude-code-smoke.test.ts
```

`ClaudeCodeAdapter` returns the CLI's opaque `session_id` as
`AgentResult.sessionId`; persist that result and pass the token back as
`ImplementationRequest.sessionId` to resume after a Conductor process restart.
An optional `AbortSignal` cancels the active process as a deterministic
`CLAUDE_CANCELLED` failure. Results retain bounded wall-clock `durationMs`, but
never raw stdout/stderr transcripts or model-usage details. The execution
prompt requires repository validation and tests to pass before success is
reported.

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
[issue #1]: https://github.com/nurockplayer/tachiko-conductor/issues/1
[issue #3]: https://github.com/nurockplayer/tachiko-conductor/issues/3
[issue #4]: https://github.com/nurockplayer/tachiko-conductor/issues/4
[issue #5]: https://github.com/nurockplayer/tachiko-conductor/issues/5
[issue #6]: https://github.com/nurockplayer/tachiko-conductor/issues/6
