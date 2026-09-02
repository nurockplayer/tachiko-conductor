# Tachiko Conductor

Local orchestration core for the Tachiko Conductor product: a deterministic
workflow state machine that drives a GitHub issue from **READY** through
implementation, validation, independent review, and a final merge-ready gate.

This repository implements **[issue #1]**'s MVP scope across **[issue #2]**
through **[issue #6]**: the typed core, the deterministic state machine,
durable local run state, the adapter *interfaces*, the GitHub live-state
adapter (with an injected `gh` CLI transport and agent-handoff parser), a
Claude Code and Codex CLI execution adapters, an independent DeepSeek review
loop, and the end-to-end `tachiko run owner/repo#123` command with a structured
human interrupt protocol.

It also implements the post-MVP **[issue #12]** managed browser fallback:
the pinned official Playwright MCP server, a dedicated persistent Tachiko
profile, localhost lifecycle/health and typed failures, headed human bootstrap,
and per-run Claude/Codex MCP capability injection. See
[Managed browser runtime](docs/browser-runtime.md).

As part of **[issue #16]**, an authorized open Issue can bootstrap from a
live exact default-branch SHA before a PR exists. Conductor persists one
deterministic implementation branch/worktree identity before creating Git
state, reconstructs it after restart, and binds the discovered PR/exact HEAD
back into the existing validation and review workflow.

## Design invariants

- GitHub is the engineering source of truth; the core only ever sees plain
  normalized data.
- Core workflow logic is independent of Claude Code, DeepSeek, GitHub
  transport, and Linear.
- Reviews are bound to an exact HEAD SHA; `FINAL_GATE` re-reads GitHub and
  refuses stale approvals, draft/closed/unmergeable PRs, non-passing checks,
  and known unresolved review threads.
- An approval containing a blocking finding is contradictory and is rejected
  before it can reach the final gate.
- No autonomous merge, no cloud, no distributed queue, no UI, no Linear.
- Browser automation is fallback-only: stable APIs/native integrations remain
  preferred, and authentication/security/high-risk operations require humans.

## States

`READY`, `IMPLEMENTING`, `VALIDATING`, `REVIEWING`, `CHANGES_REQUESTED`,
`FINAL_GATE`, `MERGE_READY`, `MERGED`, `WAITING_DEPENDENCY`, `NEEDS_HUMAN`,
`FAILED`.

`MERGED` and `FAILED` are terminal; no transition can leave them.

## Transitions

| Event | Allowed from | Goes to |
| --- | --- | --- |
| `start` | `READY` | `IMPLEMENTING` |
| `bootstrap_prepared` | `IMPLEMENTING` | `IMPLEMENTING` |
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
SHA may only be changed by implementation transitions or the exact bounded
live-HEAD synchronization decision offered after drift. That decision routes
through validation and independent review; a gate or merge can never swap in
an unreviewed SHA.

## Quick start

```bash
pnpm install
pnpm browser:install # download the pinned Chromium used by the MCP integration test
pnpm test        # run the test suite (node:test + tsx)
pnpm typecheck   # type-check src and tests
pnpm build       # emit dist/ for the `tachiko` bin
```

On Linux CI or a minimal container, install Chromium and its system packages
with `pnpm exec playwright install --with-deps chromium` before `pnpm test`.

## CLI

```bash
pnpm exec tsx src/cli.ts run owner/repo#123
pnpm exec tsx src/cli.ts run resume <id> --decision <choice>
pnpm exec tsx src/cli.ts run create --owner acme --repo widgets --issue 42
pnpm exec tsx src/cli.ts run show <id>
pnpm exec tsx src/cli.ts run transition <id> start
pnpm exec tsx src/cli.ts run list
pnpm exec tsx src/cli.ts github snapshot nurockplayer/tachiko-conductor#42
pnpm exec tsx src/cli.ts browser bootstrap github-work
pnpm exec tsx src/cli.ts browser start github-work --headless
pnpm exec tsx src/cli.ts browser status github-work
pnpm exec tsx src/cli.ts browser stop github-work
pnpm exec tsx src/cli.ts run owner/repo#123 --browser-profile github-work
```

`run owner/repo#123` starts or continues one issue end-to-end: implementation,
validation, independent review, and the final gate. It stops at `MERGE_READY`,
`FAILED`, or a structured `NEEDS_HUMAN` interrupt (reason, evidence, bounded
choices); resume a parked run with `run resume <id> --decision <choice>`.
When choices are present, the decision must match one exactly. `Cancel the
run` transitions to `FAILED`; adopting a drifted live HEAD always returns to
independent review before the final gate.

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

As part of **[issue #15]**, `CodexCliAdapter` uses the installed Codex CLI's
non-interactive JSONL surface:
fresh work runs through `codex exec --json`, and continuation uses
`codex exec resume <SESSION_ID> --json`. Conductor persists a provider-neutral
`Run.executor` identity and reconstructs that same provider after restart; an
unknown, stale, or mismatched identity fails explicitly instead of starting a
fresh thread. Select Codex for new runs without changing existing Claude runs:

```bash
TACHIKO_IMPLEMENTATION_AGENT=codex-cli pnpm exec tsx src/cli.ts run owner/repo#123
```

The adapter accepts resolved execution values without choosing a model or
profile. Production wiring reads these optional values:

- `TACHIKO_CODEX_MODEL`
- `TACHIKO_CODEX_REASONING_EFFORT` (`minimal`, `low`, `medium`, `high`, `xhigh`)
- `TACHIKO_CODEX_SANDBOX_MODE` (`read-only`, `workspace-write`, `danger-full-access`)
- `TACHIKO_CODEX_APPROVAL_POLICY` (`untrusted`, `on-request`, `never`)
- `TACHIKO_CODEX_TIMEOUT_MS` (positive integer)

The opt-in real-Codex smoke invokes the installed/authenticated CLI in a
read-only sandbox and is excluded from the normal suite and CI:

```bash
TACHIKO_CODEX_SMOKE=1 pnpm exec tsx --test tests/codex-cli-smoke.test.ts
```

The separate opt-in browser-agent smoke starts the managed Playwright MCP
runtime and a localhost fixture, then proves the installed Codex CLI can use
the injected browser capability. It is also skipped in the default suite:

```bash
TACHIKO_BROWSER_AGENT_SMOKE=1 pnpm exec tsx --test tests/browser-agent-smoke.test.ts
```

After `pnpm build`, the same commands work through the `tachiko` bin
(`node dist/cli.js`). Run state is stored under `$TACHIKO_DATA_DIR` (default
`~/.tachiko-conductor/runs`), one `<id>.json` file per run.
Issue bootstrap worktrees are stored under `$TACHIKO_WORKSPACE_ROOT` (default
`~/.tachiko-conductor/workspaces`) and must remain outside the source
repository.

## Persistence

`JsonFileStore` writes each run as a JSON file using an atomic
write-then-rename, so a crash mid-write never corrupts the committed file and a
run survives a process restart intact. A fresh store instance pointed at the
same directory resumes the run exactly where it stopped.

For a Ready Issue with no associated PR, GitHub supplies the live default
branch and exact base SHA. Conductor first performs collision checks and
persists the planned `Run.bootstrap` identity; only then may it create or
restore `tachiko/issue-<number>-<run-key>` in an isolated worktree. Agent
success is rejected unless the worktree is clean, its exact HEAD descends from the
recorded base, and the same HEAD is pushed to the owned remote branch. The
next live GitHub read must discover exactly one associated open PR at that
HEAD before review begins. Existing PR-driven runs skip bootstrap mechanics
and remain supported.

## Layout

```
src/domain/            typed core: types, run factory, state machine
src/store/             durable run persistence
src/adapters/          typed boundaries for GitHub, implementation, and review
src/github/            live GitHub transport, normalization, and handoff parser
src/agents/            Claude Code/Codex adapters and durable provider routing
src/workspace/         provider-neutral isolated Git worktree bootstrap
src/reviewers/         DeepSeek reviewer and bounded fix loop
src/workflow/          state-resume-aware end-to-end orchestration
src/cli.ts             run, resume, state inspection, and GitHub snapshot CLI
tests/                 unit, persistence, adapter, workflow, and CLI E2E tests
```

[issue #2]: https://github.com/nurockplayer/tachiko-conductor/issues/2
[issue #1]: https://github.com/nurockplayer/tachiko-conductor/issues/1
[issue #3]: https://github.com/nurockplayer/tachiko-conductor/issues/3
[issue #4]: https://github.com/nurockplayer/tachiko-conductor/issues/4
[issue #5]: https://github.com/nurockplayer/tachiko-conductor/issues/5
[issue #6]: https://github.com/nurockplayer/tachiko-conductor/issues/6
[issue #15]: https://github.com/nurockplayer/tachiko-conductor/issues/15
[issue #16]: https://github.com/nurockplayer/tachiko-conductor/issues/16
[issue #12]: https://github.com/nurockplayer/tachiko-conductor/issues/12
