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
| `agent_succeeded` | `IMPLEMENTING` | `VALIDATING` |
| `agent_failed` | `IMPLEMENTING` | `FAILED` |
| `validation_passed` | `VALIDATING` | `REVIEWING` |
| `validation_failed` | `VALIDATING` | `CHANGES_REQUESTED` |
| `review_approved` | `REVIEWING` | `FINAL_GATE` |
| `changes_requested` | `REVIEWING` | `CHANGES_REQUESTED` |
| `start_fix` | `CHANGES_REQUESTED` | `IMPLEMENTING` |
| `revalidate` | `FINAL_GATE` | `VALIDATING` |
| `gate_blocked` | `FINAL_GATE` | `REVIEWING` |
| `merged` | `MERGE_READY` | `MERGED` |
| `wait_dependency` | any active state | `WAITING_DEPENDENCY` |
| `dependency_satisfied` | `WAITING_DEPENDENCY` | resume interrupted state |
| `escalate` | any active state | `NEEDS_HUMAN` |
| `human_resolved` | `NEEDS_HUMAN` | resume interrupted state |
| `fail` | any non-terminal state | `FAILED` |

Anything else throws an `InvalidTransitionError` whose message names the
invalid transition, the current state, and the allowed transitions. `MERGE_READY`
is not a public transition: only the canonical workflow creates it after a live
FINAL_GATE reconciliation of the PR, checks, review, and validation identities.

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
pnpm test        # deterministic unit and contract suite (node:test + tsx)
pnpm typecheck   # type-check src and tests
pnpm build       # emit dist/ for the `tachiko` bin
```

## Test tiers

`pnpm test` is the deterministic default. It excludes real Playwright MCP
browser integration and every authenticated model smoke path. Run the real
local browser integration separately (after installing the pinned Chromium):

```bash
pnpm browser:install
pnpm test:integration
```

On Linux CI or a minimal container, use
`pnpm exec playwright install --with-deps chromium` before the integration
tier. Authenticated smokes are explicit and never part of normal CI:

```bash
pnpm test:smoke:claude
pnpm test:smoke:codex
pnpm test:smoke:browser-agent
```

## CLI

```bash
pnpm exec tsx src/cli.ts run owner/repo#123 --execution-profile standard
pnpm exec tsx src/cli.ts run resume <id> --decision <choice>
pnpm exec tsx src/cli.ts run create --owner acme --repo widgets --issue 42 --execution-profile standard
pnpm exec tsx src/cli.ts run show <id>
pnpm exec tsx src/cli.ts run transition <id> start
pnpm exec tsx src/cli.ts run list
pnpm exec tsx src/cli.ts dispatch once
pnpm exec tsx src/cli.ts github snapshot nurockplayer/tachiko-conductor#42
pnpm exec tsx src/cli.ts browser bootstrap github-work
pnpm exec tsx src/cli.ts browser start github-work --headless
pnpm exec tsx src/cli.ts browser status github-work
pnpm exec tsx src/cli.ts browser stop github-work
pnpm exec tsx src/cli.ts run owner/repo#123 --browser-profile github-work --execution-profile standard
```

`run owner/repo#123` starts or continues one issue end-to-end: implementation,
validation, independent review, and the final gate. It stops at `MERGE_READY`,
`FAILED`, or a structured `NEEDS_HUMAN` interrupt (reason, evidence, bounded
choices); resume a parked run with `run resume <id> --decision <choice>`.
When choices are present, the decision must match one exactly. `Cancel the
run` transitions to `FAILED`; adopting a drifted live HEAD always returns to
independent review before the final gate.

## Queue dispatch (v0)

`tachiko dispatch once` is the explicit, single-owner bridge from a
Steward-maintained GitHub queue projection to Conductor runs. It is not a
scheduler and does not merge PRs. Configure the exact control location rather
than inferring a repository, issue, or comment from prose:

```bash
export TACHIKO_DISPATCH_CONFIG='{
  "revision":"dispatch-v1",
  "owner":"nurockplayer",
  "repo":"tachiko-work",
  "controlIssue":206,
  "queueCommentId":123456789,
  "leaseDurationMs":900000
}'
export TACHIKO_EXECUTION_PROFILE_CONFIG='<revisioned execution-profile JSON>'
pnpm exec tsx src/cli.ts dispatch once
```

The configured queue comment must contain `<!-- issue-dispatch-queue:v1 -->`
and a compact `ready:` list with `issue`, `route`, and `profile` for every
record. Only `route: codex` is executable; `human`, `work`, and `chatgpt`
records remain untouched, and unknown/malformed/duplicate records fail closed.
The dispatcher never edits that Steward-owned comment. It owns exactly one
`<!-- issue-dispatch-runtime:v1 -->` comment on the configured control Issue,
which stores the claim id, run id, profile, state and lease timestamps. It
rereads the comment after every claim/heartbeat write, and it refuses duplicate
or malformed runtime claims.

Before a claim, the dispatcher rereads the target Issue, associated PRs, and
local durable runs. A closed Issue, open PR, non-terminal Run, ambiguous claim,
or missing/mismatched claimed Run is not eligible. On restart it resumes the
same claimed Run; an expired lease is never permission to create a second one.
This Issue deliberately does not provide a recurring scheduler or same-host
process lock; those remain #19's boundary.

## Scheduled dispatch (macOS v0)

`tachiko dispatch once` now takes a small local lock before reading GitHub. It
complements (but never replaces) the GitHub claim lease: a concurrent same-host
invocation returns `{ "outcome": "already_running" }` without changing GitHub
or starting a second executor. The default lock lives outside the repository at
`~/.tachiko-conductor/dispatch/once.lock`; override it only with an absolute
`TACHIKO_DISPATCH_LOCK_PATH`. A malformed or live lock fails closed; a lock for
a provably absent PID is retried once.

For macOS, use `launchd` as the external hourly scheduler. First create a
private, absolute-path wrapper that supplies the explicitly selected dispatch,
execution, validation, and hosted-check configurations, then ends with:

```sh
exec /absolute/path/to/tachiko dispatch once
```

Do not put credentials in the generated plist. Render an hourly `HH:25`
example (or choose a different minute) from the checked-in CLI:

```bash
pnpm exec tsx src/cli.ts dispatch launchd render \
  --program '/absolute/path/to/run-dispatch-once.sh' \
  --working-directory "$PWD" --minute 25 \
  > "$HOME/Library/LaunchAgents/io.tachiko.conductor.dispatch-once.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.tachiko.conductor.dispatch-once.plist"
```

Remove it with `launchctl bootout "gui/$(id -u)" <plist-path>` before deleting
the plist. The generated schedule is deliberately only a wake-up cadence: a
late wake remains correct, and an active durable claim is resumed before new
queue work. No launchd installation or real GitHub/Codex invocation occurs in
CI. An opt-in local smoke requires a disposable control Issue and all normal
explicit configuration, then uses:

```bash
TACHIKO_DISPATCH_SMOKE=1 scripts/dispatch-smoke.sh
```

## Execution profiles

The Project Steward explicitly selects one coarse profile when creating an
issue run: `routine`, `standard`, `complex`, or `critical`. Conductor only
resolves that selection; it never derives a profile from Issue prose, diffs,
or reviewer text. New runs require `--execution-profile` and one revisioned
`TACHIKO_EXECUTION_PROFILE_CONFIG` JSON value. For example:

```bash
export TACHIKO_EXECUTION_PROFILE_CONFIG='{
  "revision":"execution-profiles-v1",
  "profiles":{
    "routine":{"executor":"codex-cli","model":"configured-model","reasoningEffort":"low","timeoutMs":600000,"sandboxMode":"workspace-write","approvalPolicy":"on-request"},
    "standard":{"executor":"codex-cli","model":"configured-model","reasoningEffort":"medium","timeoutMs":600000,"sandboxMode":"workspace-write","approvalPolicy":"on-request"},
    "complex":{"executor":"codex-cli","model":"configured-model","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"on-request"},
    "critical":{"executor":"claude-code","model":"configured-model","timeoutMs":900000}
  }
}'
pnpm exec tsx src/cli.ts run owner/repo#123 --execution-profile standard
```

Provider and model identifiers are configuration values, not workflow enums.
The selected profile, config revision, executor, and secret-free resolved
settings are persisted with the run; continuation uses that immutable snapshot
even if a later configuration revision remaps the profile. Unknown profiles,
unavailable executors, malformed settings, and provider-unsupported settings
fail before implementation starts.

## Exact-HEAD validation

`VALIDATING` requires a persisted `ValidationResult` for the current exact
HEAD. Conductor retains compact local-command and hosted-check provenance only;
it never stores command output, full command arguments, or secrets. A new HEAD
makes prior evidence stale. Pending hosted checks park in `WAITING_DEPENDENCY`
for a later re-read; unavailable or unknown evidence fails closed.

Local commands are repository/run configuration and are never inferred from
Issue text. Set `TACHIKO_LOCAL_VALIDATION_CONFIG` to a stable revision and
bounded argv-array commands, for example:

```bash
export TACHIKO_LOCAL_VALIDATION_CONFIG='{"revision":"repo-validation-v1","commands":[{"argv":["pnpm","test"],"timeoutMs":120000}]}'
```

`commands` 必須至少有一個項目。既存 PR（沒有 Conductor bootstrap 記錄）必須在同一設定中明確提供絕對 `workspacePath`；Conductor 會在執行前後驗證其 clean exact HEAD 與 `origin` 的 GitHub owner/repo，絕不使用 ambient cwd。例如：

```bash
export TACHIKO_LOCAL_VALIDATION_CONFIG='{"revision":"repo-validation-v1","workspacePath":"/absolute/clean/worktree","commands":[{"argv":["pnpm","test"],"timeoutMs":120000}]}'
```

Hosted checks are independently policy-controlled. Set
`TACHIKO_HOSTED_CHECK_POLICY_CONFIG` with a stable revision and either
`{"mode":"not_required"}` or `{"mode":"required","requiredCheckNames":[...]}`.
For example:

```bash
export TACHIKO_HOSTED_CHECK_POLICY_CONFIG='{"revision":"repo-hosted-v1","mode":"required","requiredCheckNames":["test"]}'
```

Absent policy is fail-closed: neither an empty nor non-empty GitHub check list
is hosted passing evidence. Validation evidence is reusable only for the exact
HEAD and an explicit active identity (local revision; hosted mode plus
revision). Removing, changing, or supplying an anonymous policy/adapter is an
identity change, never a nullable wildcard. An explicit `not_required` hosted
policy is neutral; GitHub observations do not infer one.

Historical persisted `gate_passed` entries remain read-compatible for completed
old runs only. They are never a public transition and never certify current
validation, review, or final readiness; current policy or live-state drift
returns the run to validation before review can resume.

An explicitly `not_required` hosted policy remains neutral even when the
hosted-check observation endpoint is unavailable; this does not relax the
separate live Issue/PR/exact-HEAD/merge-state reconciliation. A configured
validation adapter or hosted policy without a non-empty revision is invalid
operator configuration: Conductor parks before validation or review executes.

Without explicit configuration, local validation is unknown and the run cannot
advance to review. The configured runner refuses an ambient directory: it
re-proves the clean bootstrap-owned worktree's exact HEAD before and after the
commands. Commands use a direct process boundary (no shell), with compact
pass, non-zero-exit, timeout, unavailable-executable, and malformed
configuration outcomes; timeouts terminate the owned command group and settle
within a bounded grace period.

## Implementation workspace safety

For an issue that has no associated open pull request, Conductor first creates
one deterministic, persisted bootstrap identity before it lets an implementation
provider run. The identity binds the issue target, GitHub's live default
branch/base SHA, a Conductor-owned branch, and an isolated linked Git worktree.
By default worktrees are below `~/.tachiko-conductor/workspaces`; set
`TACHIKO_WORKSPACE_ROOT` to choose another root outside the source repository.

The bootstrap boundary is deliberately fail-closed. It requires the configured
remote fetch URL and every effective push URL to resolve exactly to the target
`github.com/<owner>/<repo>`, confirms the fetched base SHA, and rejects dirty,
ambiguous, divergent, or non-linked worktrees. On a restart it may only
fast-forward a clean local replica to the already persisted/live PR HEAD; it
never resets, force-pushes, or silently adopts a new remote head.

Immediately before both Claude Code and Codex CLI spawn, the prepared workspace
is revalidated for source common Git directory, current branch, and effective
remote destinations. A failure is a resumable `NEEDS_HUMAN` bootstrap interrupt,
not a terminal provider failure. Provider success is accepted only after the
workspace has a clean, pushed exact HEAD and live GitHub proves the matching PR
identity. The same guard and durable-progress check apply to review fixes.

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
pnpm test:smoke:claude
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
fresh thread. Select Codex for new runs with a configured Codex execution
profile, without changing existing Claude runs:

```bash
pnpm exec tsx src/cli.ts run owner/repo#123 --execution-profile standard
```

The adapter accepts resolved execution values without choosing a model or
profile. The profile configuration above is the production path for new runs.
The following direct Codex environment values remain available for legacy
persisted runs that have no profile snapshot:

- `TACHIKO_CODEX_MODEL`
- `TACHIKO_CODEX_REASONING_EFFORT` (`minimal`, `low`, `medium`, `high`, `xhigh`)
- `TACHIKO_CODEX_SANDBOX_MODE` (`read-only`, `workspace-write`, `danger-full-access`)
- `TACHIKO_CODEX_APPROVAL_POLICY` (`untrusted`, `on-request`, `never`)
- `TACHIKO_CODEX_TIMEOUT_MS` (positive integer)

The opt-in real-Codex smoke invokes the installed/authenticated CLI in a
read-only sandbox and is excluded from the normal suite and CI:

```bash
pnpm test:smoke:codex
```

The separate opt-in browser-agent smoke starts the managed Playwright MCP
runtime and a localhost fixture, then proves the installed Codex CLI can use
the injected browser capability. It is also skipped in the default suite:

```bash
pnpm test:smoke:browser-agent
```

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
src/adapters/          typed boundaries for GitHub, implementation, and review
src/github/            live GitHub transport, normalization, and handoff parser
src/agents/            Claude Code/Codex adapters and durable provider routing
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
[issue #12]: https://github.com/nurockplayer/tachiko-conductor/issues/12
