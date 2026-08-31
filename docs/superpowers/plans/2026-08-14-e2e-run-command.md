# End-to-End Run Command and Human Interrupt Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-14-e2e-run-command-design.md`

## Global Constraints

- No auto-merge; stop at `MERGE_READY`.
- Escalation over guessing; `NEEDS_HUMAN` carries reason/evidence/choices.
- Default suite uses fake adapters — no network, no real Claude/DeepSeek.
- Keep each commit independently testable.

### Task 1: NEEDS_HUMAN interrupt protocol (evidence + choices)

**Files:**
- Modify: `src/domain/types.ts` (Interrupt, TransitionInput)
- Modify: `src/domain/state-machine.ts` (consume interrupt payload on escalate/wait_dependency)
- Modify: `src/store/json-file-store.ts` (validate evidence/choices)
- Modify: `tests/state-machine.test.ts`, `tests/store.test.ts`

- [ ] **Step 1:** Write failing tests — escalate carries evidence/choices onto the interrupt; store accepts/rejects evidence/choices; existing interrupts unchanged.
- [ ] **Step 2:** Implement the contract extension and validation.
- [ ] **Step 3:** Run focused and full tests, typecheck — GREEN.
- [ ] **Step 4:** Commit (`feat: add evidence and bounded choices to human interrupts`).

### Task 2: runWorkflow orchestrator

**Files:**
- Create: `src/workflow/run.ts`
- Create: `tests/workflow.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1:** Write failing fake-adapter tests — READY → implementation → review changes → fix → review PASS → MERGE_READY; agent failure → FAILED; NEEDS_HUMAN parks with evidence/choices; resume after human_resolved completes; restart-resume from a persisted mid-flow run.
- [ ] **Step 2:** Implement runWorkflow (state-resume aware, delegating to runReviewLoop).
- [ ] **Step 3:** Focused + full tests, typecheck — GREEN.
- [ ] **Step 4:** Commit (`feat: add state-resume-aware workflow orchestrator`).

### Task 3: CLI `run owner/repo#123` + resume

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`

- [ ] **Step 1:** Write failing CLI tests — run command creates/drives a run through fake adapters; prints NEEDS_HUMAN interrupt; resume with a decision completes.
- [ ] **Step 2:** Implement the run/resume commands with production adapter wiring.
- [ ] **Step 3:** Focused + full tests, typecheck, build — GREEN.
- [ ] **Step 4:** Commit (`feat: add end-to-end run and resume commands`).

### Task 4: Validation and release

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm build` on exact HEAD.
- [ ] **Step 2:** Independent reviewer gate on the issue #6 diff.
- [ ] **Step 3:** Commit/push and open the stacked PR on `feat/5-deepseek-review`.
- [ ] **Step 4:** Reconcile GitHub (all stacked PRs, no blocking findings).
