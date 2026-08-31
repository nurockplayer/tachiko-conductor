# Claude Code Execution Adapter Design

**Issue:** [#4](https://github.com/nurockplayer/tachiko-conductor/issues/4)
**Base dependency:** PR #8 / issue #3 (GitHub live state) and PR #7 / issue #2
**Status:** Autonomous-execution workstream

## Goal

Let the Conductor start and continue Claude Code implementation work without
manual prompt copy/paste. The adapter drives the locally installed Claude Code
CLI non-interactively (`claude -p`), captures a typed `AgentResult`, and never
lets raw terminal text or full transcripts leak into the workflow.

## Boundaries

1. `ClaudeCodeAdapter implements ImplementationAgent` runs `claude` through an
   injected `ProcessRunner` (reused from `src/github/transport.ts`) with an
   argument array — never a shell string.
2. An optional injected `GitHubAdapter` supplies a live snapshot summary into
   the prompt so GitHub remains the engineering source of truth.
3. Every execution outcome — success, non-zero exit, `is_error`, timeout,
   cancellation, missing executable, or post-run git read failure — becomes a deterministic
   `AgentResult` with `exitStatus`, `summary`, optional `headSha`, and
   `diagnostics`. Results include bounded wall-clock `durationMs`, but no raw
   transcript or provider-specific model usage.
4. Session continuity: a fresh run starts a new session; a continuation run
   passes persisted `AgentResult.sessionId` back through
   `ImplementationRequest.sessionId` and then `--resume <sessionId>`. Continuity
   therefore survives a Conductor process restart and does not depend on
   mutable adapter state.
5. The prompt requires repository validation and tests to pass before Claude
   reports success.

## Execution contract

```
claude -p <prompt> --output-format json \
  --permission-mode acceptEdits \
  [--allowedTools <tool> ...] \
  [--model <model>] \
  [--resume <sessionId>]
```

Parsed JSON result:

```json
{ "type": "result", "session_id": "...", "result": "...", "is_error": false }
```

Failure mapping (all deterministic and machine-readable):

- exit code ≠ 0 → `exitStatus: 'failure'`, status-only summary (no raw process output), code
  `CLAUDE_EXIT_FAILURE`.
- parsed `is_error === true` → `CLAUDE_ERROR`.
- timeout (`ETIMEDOUT`) → `CLAUDE_TIMEOUT`.
- request cancellation (`AbortSignal`) → `CLAUDE_CANCELLED`.
- missing executable (`ENOENT`) → `CLAUDE_NOT_FOUND`.
- invalid JSON or structurally invalid result output → `CLAUDE_INVALID_OUTPUT`.
- post-run `git rev-parse HEAD` failure → `headSha` omitted plus a
  `HEAD_READ_FAILED` diagnostic; an empty or failed HEAD read never invents a
  SHA and never yields `exitStatus: 'success'`.

## Safety

- Default `--permission-mode acceptEdits` with a bounded `--allowedTools`
  whitelist; `--disallowedTools` reserves destructive tools.
- No real production credentials; nothing authenticates as the user beyond
  whatever the local `claude` binary already has.
- No auto-merge; the adapter cannot bypass the Conductor state machine.
- A Claude self-review can never satisfy the independent reviewer gate
  (issue #5 owns that gate).
- Full raw transcripts, process output, secrets, and model usage are not persisted.

## Validation

- Fake-runner unit tests assert exact argument arrays, prompt construction,
  restart-safe `--resume` behavior, structured JSON validation, cancellation,
  and every failure mapping — no network,
  no real `claude`, in the default suite.
- An opt-in smoke command (`TACHIKO_SMOKE=1`) may invoke the real CLI once
  and is never part of CI.
