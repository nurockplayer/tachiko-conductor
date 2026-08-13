# DeepSeek Review and Automatic Fix Loop Implementation Plan

**Spec:** `docs/superpowers/specs/2026-08-14-deepseek-review-loop-design.md`

## Global Constraints

- Reviewer independence; a Claude self-review can never satisfy the gate.
- Every accepted PASS is bound to the exact reviewed HEAD SHA.
- Malformed / contradictory / stale-SHA output never counts as approval.
- API/model selection is configuration; secrets come from env at call time.
- No auto-merge. Default suite uses fakes — no network.

### Task 1: Reviewer adapter with injectable client and diff reader

**Files:**
- Create: `src/reviewers/deepseek.ts`
- Create: `tests/deepseek-reviewer.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing reviewer tests** (fake client + fake diff reader)
  PASS clean → approve bound to exact headSha; REQUEST_CHANGES → request_changes
  with blocking findings; missing reviewed SHA → REVIEW_STALE_HEAD; verdict
  mismatch vs SHA → stale; unknown verdict / non-array findings →
  REVIEW_INVALID_OUTPUT; PASS with blockers → REVIEW_CONTRADICTORY; API HTTP
  error / timeout → typed ReviewerError.
- [ ] **Step 2: Run tests — verify RED**
- [ ] **Step 3: Implement reviewer + prompt builder**
  Live snapshot context + PR diff → structured prompt; parse and validate the
  JSON response; map to ReviewResult or ReviewerError.
- [ ] **Step 4: Run focused and full tests, typecheck — verify GREEN**
- [ ] **Step 5: Commit** (`feat: add injectable DeepSeek reviewer adapter`)

### Task 2: Automatic fix loop orchestrator

**Files:**
- Create: `src/reviewers/loop.ts`
- Create: `tests/review-loop.test.ts`

- [ ] **Step 1: Write failing loop tests** (fake store/github/implementation/reviewer)
  approve → FINAL_GATE → MERGE_READY; request_changes → fix → agent_succeeded →
  re-review → approve; max-attempt escalation to NEEDS_HUMAN; implementation
  failure → FAILED; live-HEAD drift → NEEDS_HUMAN; run persists after each
  transition.
- [ ] **Step 2: Run tests — verify RED**
- [ ] **Step 3: Implement runReviewLoop** driving applyTransition + store.
- [ ] **Step 4: Run focused and full tests, typecheck — verify GREEN**
- [ ] **Step 5: Commit** (`feat: add bounded review/fix loop with human escalation`)

### Task 3: Validation and release

- [ ] **Step 1:** `pnpm test`, `pnpm typecheck`, `pnpm build` on exact HEAD.
- [ ] **Step 2:** Independent reviewer gate on the issue #5 diff.
- [ ] **Step 3:** Commit/push and open the stacked PR on `feat/4-claude-code`.
