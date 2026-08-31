# GitHub Live-State Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a deterministic read-only GitHub snapshot for one issue, including its associated PR, exact HEAD, checks, reviews, conversations, and latest valid agent handoff.

**Architecture:** A pure handoff parser and live-state normalizer consume an injected `GitHubApiTransport`; the production transport shells out safely to `gh api` with argument arrays. The CLI prints stable JSON envelopes and never lets reviews or handoffs supply the live HEAD.

**Tech Stack:** Node.js 20+, TypeScript, `node:test`, `node:child_process.execFile`, GitHub CLI REST API, pnpm 10.34.5.

**Spec:** `docs/superpowers/specs/2026-08-14-github-live-state-design.md`

## Global Constraints

- GitHub is the engineering source of truth; live PR state wins.
- Exact HEAD comes only from the selected live PR.
- Core workflow code must not depend on GitHub CLI transport.
- No GitHub mutations, Linear, cloud service, UI, or autonomous merge.
- No runtime dependency additions.
- Every fatal failure is typed and machine-readable; no partial success.
- Use TDD and keep each commit independently testable.

---

### Task 1: Handoff parser and public live-state contract

**Files:**
- Create: `src/github/errors.ts`
- Create: `src/github/handoff.ts`
- Modify: `src/adapters/github.ts`
- Modify: `src/index.ts`
- Create: `tests/github-handoff.test.ts`

**Interfaces:**
- Consumes: existing `IssueTarget`, `IssueSnapshot`, `PullRequestSnapshot`.
- Produces:
  - `GitHubProblem { code, message, sourceId?, details? }`
  - `GitHubLiveStateError extends Error { code, retryable, details }`
  - `GitHubConversationEntry { id, scope, kind, author, body, createdAt, updatedAt, url }`
  - `AgentHandoffSnapshot { sourceId, sourceScope, sourceUpdatedAt, sections, claimedHeadSha?, claimedPullRequestNumber?, freshness }`
  - `parseAgentHandoffs(entries, live): { handoff, problems }`
  - normalized live snapshot/check/review types and `GitHubAdapter.readLiveSnapshot`.

- [ ] **Step 1: Write failing parser tests**

Cover one valid marker, reverse-ordered old/new valid comments, malformed latest
with older valid fallback, duplicate markers in one comment, duplicate valid
comments, stable equal-timestamp ordering, and stale claimed HEAD/PR. Assert
literal section maps and problem codes, never parser internals.

- [ ] **Step 2: Run the parser tests and verify RED**

Run: `pnpm exec tsx --test tests/github-handoff.test.ts`  
Expected: module-not-found or missing-export failure for `parseAgentHandoffs`.

- [ ] **Step 3: Implement the minimal parser and typed errors**

Parse exact markers and `##` headings, reject multiple markers within one
comment, sort candidates by ISO `updatedAt` then ID, select the latest valid
candidate, extract only unambiguous 40-hex HEAD/PR claims from state/branch
sections, and emit literal diagnostic codes from the spec.

- [ ] **Step 4: Add the public snapshot types and adapter method**

Extend `GitHubAdapter` with:

```ts
readLiveSnapshot(target: IssueTarget): Promise<GitHubLiveSnapshot>;
```

Update existing adapter stubs in `tests/adapters.test.ts` with a coherent fake
snapshot. Export the new public types and parser through `src/index.ts`.

- [ ] **Step 5: Run focused and type tests and verify GREEN**

Run: `pnpm exec tsx --test tests/github-handoff.test.ts tests/adapters.test.ts && pnpm typecheck`  
Expected: all pass with no diagnostics.

- [ ] **Step 6: Commit**

```bash
rtk git add src/github/errors.ts src/github/handoff.ts src/adapters/github.ts src/index.ts tests/github-handoff.test.ts tests/adapters.test.ts
rtk git commit -m "feat: define GitHub live snapshot and handoff parser"
```

### Task 2: Safe injected GitHub API transport

**Files:**
- Create: `src/github/transport.ts`
- Create: `tests/github-transport.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface GitHubApiTransport {
  get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown>;
  getPaginated(path: string, query?: Readonly<Record<string, string>>): Promise<readonly unknown[]>;
}

export interface ProcessRunner {
  run(file: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
```

- `GhCliTransport` takes `{ runner?, timeoutMs? }` and implements both reads.

- [ ] **Step 1: Write failing transport tests**

Use a recording fake runner. Assert exact `gh api` argument arrays, query
encoding, `--paginate --slurp` collection flattening, JSON parse failures,
missing executable, auth/404/rate-limit/timeout/nonzero mapping, and that no
shell string is ever constructed.

- [ ] **Step 2: Run transport tests and verify RED**

Run: `pnpm exec tsx --test tests/github-transport.test.ts`  
Expected: missing transport module/export failure.

- [ ] **Step 3: Implement process runner and transport**

Wrap `execFile` (not `exec`) and preserve stdout/stderr/exit code. For paginated
calls, parse `--slurp` as pages and flatten array pages. Reject object pages as
`GH_INVALID_RESPONSE`. Map deterministic stderr/status patterns to the error
codes in the spec and retain `retryable` only for rate limit, timeout, and
transient transport failures.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec tsx --test tests/github-transport.test.ts && pnpm typecheck`  
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
rtk git add src/github/transport.ts src/index.ts tests/github-transport.test.ts
rtk git commit -m "feat: add injectable gh api transport"
```

### Task 3: Live snapshot aggregation and consistency checks

**Files:**
- Create: `src/github/live-state.ts`
- Create: `tests/github-live-state.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `GitHubApiTransport`, `parseAgentHandoffs`, live snapshot types.
- Produces: `LiveGitHubAdapter implements GitHubAdapter`.

- [ ] **Step 1: Write failing no-PR and single-PR tests**

Fake endpoint responses for issue, full timeline/comments, one associated open
PR, statuses, check runs, reviews, and review comments. Assert no-PR yields null
PR/HEAD, and one PR yields only the exact live `head.sha` with deterministic
conversation ordering.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm exec tsx --test tests/github-live-state.test.ts`  
Expected: missing `LiveGitHubAdapter`.

- [ ] **Step 3: Implement issue/PR discovery and raw validation**

Read issue + paginated timeline/comments, identify PR numbers only from
timeline source objects, fetch candidates, retain only open PRs, reject more
than one, and validate every consumed field before normalization. Implement
the existing `readIssue`, `readBranch`, and `listPullRequests` methods through
the same transport without weakening their issue #2 contracts.

- [ ] **Step 4: Add failing consistency/error tests**

Cover two open PRs, empty PR HEAD, issue/PR number mismatch, PR HEAD changing on
the second read, transport failure without partial output, stale handoff, and
closed issue + open PR diagnostic. Assert exact error/problem codes.

- [ ] **Step 5: Implement aggregation, normalization, and re-read gate**

Normalize check states and latest submitted review per author, preserve review
commit SHAs, parse handoffs after all conversations arrive, and re-read the PR
after aggregation. Return `GH_SNAPSHOT_CHANGED` if state or HEAD differs.

- [ ] **Step 6: Add pagination/idempotency tests**

Place the latest handoff on a later fake page, provide unordered/duplicate
conversation IDs, and call the adapter twice. Assert complete deduplicated
deep-equal snapshots except for an injected fixed `observedAt` clock.

- [ ] **Step 7: Run focused and full tests and verify GREEN**

Run: `pnpm exec tsx --test tests/github-live-state.test.ts tests/github-handoff.test.ts && pnpm test && pnpm typecheck`  
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
rtk git add src/github/live-state.ts src/index.ts tests/github-live-state.test.ts
rtk git commit -m "feat: aggregate normalized GitHub live state"
```

### Task 4: Snapshot CLI, documentation, and stacked PR

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Adds: `tachiko github snapshot owner/repo#123`.
- Success stdout: one `{ ok: true, snapshot }` JSON document.
- Failure stderr: one `{ ok: false, error }` JSON document and exit code 1.

- [ ] **Step 1: Write failing CLI tests**

Exercise exported command logic with an injected fake `GitHubAdapter`, then
spawn the CLI with invalid targets. Assert strict target parsing, one JSON
document, no prose preamble, exact exit codes, and typed error serialization.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `pnpm exec tsx --test tests/cli.test.ts`  
Expected: unknown `github snapshot` command or missing exported command.

- [ ] **Step 3: Implement CLI target parsing and adapter wiring**

Parse `owner/repo#positive-safe-integer` without partial matches. Construct
`GhCliTransport` and `LiveGitHubAdapter` only inside the snapshot path. Keep
existing run commands byte-for-byte compatible.

- [ ] **Step 4: Document usage and opt-in public smoke**

Add snapshot schema/failure examples, `gh auth status` prerequisite, safe
read-only boundary, and:

```bash
pnpm exec tsx src/cli.ts github snapshot nurockplayer/tachiko-conductor#3
```

Document that the network smoke is manual/opt-in and the deterministic suite
uses fake transport.

- [ ] **Step 5: Run final validation**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
rtk git diff --check feat/2-bootstrap-core...HEAD
```

Expected: all pass. Also run the documented public snapshot command once and
verify `ok: true`, correct issue number, and either null or exact live PR HEAD.

- [ ] **Step 6: Commit, push, and create the stacked PR**

```bash
rtk git add src/cli.ts tests/cli.test.ts README.md
rtk git commit -m "feat: add GitHub live snapshot command"
rtk git push origin feat/3-github-live-state
rtk gh pr create --base feat/2-bootstrap-core --head feat/3-github-live-state --title "Implement GitHub live-state adapter and handoff parser" --body "Closes #3\n\nStacked on #7."
```

- [ ] **Step 7: Review and reconcile**

Run an exact-HEAD standards/spec review, fix every blocking finding with a
regression test, resolve addressed threads, update the single
`<!-- agent-handoff:v1 -->` comment on the stacked PR, and re-check GitHub live
state before moving to issue #4.
