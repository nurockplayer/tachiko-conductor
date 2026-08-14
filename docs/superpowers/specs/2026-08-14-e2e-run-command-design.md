# End-to-End Run Command and Human Interrupt Design

**Issue:** [#6](https://github.com/nurockplayer/tachiko-conductor/issues/6)
**Base dependency:** PR #10 / issue #5 (review loop), PR #9 / issue #4 (implementation), PR #8 / issue #3 (GitHub live state), PR #7 / issue #2 (core)
**Status:** Autonomous-execution workstream

## Goal

Provide the first complete local user experience: `tachiko run owner/repo#123`
starts one GitHub issue, runs the orchestration loop, and stops only when the
workflow reaches a completed, failed, or human-decision state. No model output
is ever copied between agents by hand.

## Boundaries

1. `runWorkflow` wires the core state machine, GitHub adapter, implementation
   adapter, and reviewer adapter together. It is state-resume aware: given a
   persisted run id, it picks up from the run's current state.
2. A structured `NEEDS_HUMAN` interrupt carries `reason`, `evidence`, and
   bounded `choices` when they are known. The core `Interrupt` type gains
   optional `evidence` and `choices`; the store validates them.
3. The CLI resolves `owner/repo#123`, creates a run if needed, and drives the
   workflow. When the workflow parks the run in `NEEDS_HUMAN`, the CLI prints
   the interrupt (reason/evidence/choices) and, after a supplied decision,
   resumes the same logical run via `human_resolved`.
4. Fake-adapter E2E tests make the full loop deterministic in CI: no network,
   no real Claude Code, no real DeepSeek.

## Workflow

`runWorkflow(store, github, implementation, reviewer, runId, { maxReviewAttempts })`:

- `READY` → `start` → `IMPLEMENTING`. The initial base SHA and issue context
  come from the live GitHub snapshot.
- `IMPLEMENTING` → `implementation.run(...)` → `agent_succeeded` (exact new
  HEAD) → `VALIDATING`, or `agent_failed` → `FAILED`.
- `VALIDATING` → `validation_passed` → `REVIEWING`.
- `REVIEWING` / `CHANGES_REQUESTED` → delegate to `runReviewLoop` (issue #5).
- `FINAL_GATE` → `gate_passed` → `MERGE_READY`, or `gate_blocked` →
  `REVIEWING`.
- `NEEDS_HUMAN` → stop with the structured interrupt. The CLI resumes after a
  supplied decision via `human_resolved` → return to the interrupted state.
- `MERGE_READY` → stop, ready for manual merge. `FAILED` → stop.
- Escalation conditions surface instead of guessing: reviewer non-convergence
  (issue #5), contradictory GitHub state, live-HEAD drift, or an unsupported
  target all park the run in `NEEDS_HUMAN` with evidence and bounded choices.

## Interrupt contract extension

`Interrupt` gains:

```ts
readonly evidence?: string;
readonly choices?: readonly string[];
```

`TransitionInput` gains `interrupt?: { evidence?: string; choices?: readonly
string[] }`, consumed only by `escalate` / `wait_dependency`. The persisted-run
guard validates optional `evidence` (string) and `choices` (string array).
Existing interrupt behavior (kind/reason/createdAt/resolvedAt) is unchanged.

## CLI

`tachiko run owner/repo#123`:

1. Parse the strict ref (reuse `parseIssueRef`).
2. If no persisted run exists for the target, create one (`READY`).
3. Drive `runWorkflow`.
4. On `NEEDS_HUMAN`, print the interrupt (reason/evidence/choices) and, when
   the user supplies a decision, `human_resolved` then continue the workflow.
5. On `MERGE_READY` / `FAILED`, print the terminal state.

A separate `tachiko run resume <id> [--decision <text>]` resumes a parked run.

## Safety

- No auto-merge; the workflow stops at `MERGE_READY`.
- No Linear, cloud deployment, web UI, or automatic production credentials.
- Escalation over guessing: ambiguous/contradictory/unsupported conditions
  park in `NEEDS_HUMAN` instead of being coerced forward.

## Validation

- Fake-adapter E2E: READY → implementation → review changes → fix → review
  PASS → `MERGE_READY`.
- Fake-adapter E2E: reaches `NEEDS_HUMAN`, resumes after a supplied decision,
  and completes.
- Restart-resume: a run persisted mid-flow resumes exactly where it stopped.
- Default suite uses fakes only.
