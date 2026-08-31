# Claude Code Execution Adapter Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive Claude Code non-interactively through an injectable process
runner, produce typed `AgentResult`s, support session continuation, and keep
GitHub live state in the execution envelope.

**Spec:** `docs/superpowers/specs/2026-08-14-claude-code-adapter-design.md`

## Global Constraints

- Argument arrays only, never shell strings.
- Every outcome is a deterministic `AgentResult`; no raw terminal text.
- Session continuity is explicit in request/result data so it can be persisted
  across process restarts.
- Cancellation uses `AbortSignal`; execution results retain only bounded
  duration metadata.
- No auto-merge, no production credentials, no persisted transcripts.
- Default suite uses a fake runner; real CLI only behind an opt-in smoke flag.
- Keep each commit independently testable.

### Task 1: Core adapter with fake-runner tests

**Files:**
- Create: `src/agents/claude-code.ts`
- Create: `tests/claude-code.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `ProcessRunner` from `src/github/transport.ts`, `ImplementationAgent`.

- [ ] **Step 1: Write failing adapter tests**
  Fake runner records exact `claude` argument arrays. Cover: prompt is passed
  as `-p`, `--output-format json`, JSON result → success `AgentResult`;
  non-zero exit, `is_error`, cancellation, `ETIMEDOUT`, `ENOENT`, invalid or
  structurally incomplete JSON → typed
  failure with diagnostic codes; post-run `git rev-parse HEAD` success/failure.
- [ ] **Step 2: Run tests and verify RED** (`pnpm exec tsx --test tests/claude-code.test.ts`)
- [ ] **Step 3: Implement the adapter**
  Reuse `ProcessRunner`/`NodeProcessRunner`; build the arg array; parse JSON
  after zero exit; map every failure deterministically; read the post-run HEAD
  via `git rev-parse HEAD`; never invent a SHA.
- [ ] **Step 4: Run focused tests, full suite, typecheck — verify GREEN**
- [ ] **Step 5: Commit** (`feat: add injectable Claude Code execution adapter`)

### Task 2: Session continuation and live-state prompt enrichment

**Files:**
- Modify: `src/agents/claude-code.ts`
- Modify: `tests/claude-code.test.ts`

- [ ] **Step 1: Add failing resume/context tests**
  A persisted request session id produces `--resume <id>`; the returned
  `session_id` is included in `AgentResult`; an injected `GitHubAdapter` contributes a live snapshot summary
  into the prompt; a transport failure degrades to an instructions-only prompt
  with a diagnostic, never a throw.
- [ ] **Step 2: Implement resume and prompt construction**
  `--resume` when a session id exists; record `session_id` from the result;
  render a compact live-state summary (issue number, state, PR, HEAD, checks,
  reviews, handoff freshness) when a `GitHubAdapter` is provided.
- [ ] **Step 3: Run focused and full tests, typecheck — verify GREEN**
- [ ] **Step 4: Commit** (`feat: support session resume and live-state context`)

### Task 3: Validation and release

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm build` on exact HEAD.
- [ ] **Step 2:** Opt-in smoke path (`TACHIKO_SMOKE=1`) documented, not run in CI.
- [ ] **Step 3:** Independent reviewer gate on the issue #4 diff.
- [ ] **Step 4:** Commit/push and open the stacked PR on `feat/3-github-live-state`.
