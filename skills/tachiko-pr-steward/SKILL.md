---
name: tachiko-pr-steward
description: Review an active GitHub pull request at exact HEAD, inspect code, checks, review threads, and the canonical handoff, then decide whether findings block the current contract or belong in follow-up work. Use when the user asks to 看 PR, 審查進度, 看有沒有走歪, 處理 Review comment, or periodically guard Codex implementation.
---

# Tachiko PR Steward

Guard convergence on an active pull request without duplicating implementation ownership.

## Inspect live state

1. Resolve the linked Issue and repository governance/specs that define the contract.
2. Read PR metadata and exact HEAD SHA, changed files and diff, checks/CI, review submissions, inline review threads, PR conversation, and the canonical `agent-handoff:v1` when present.
3. Review the implementation against the Issue contract, not merely whether tests pass.
4. If the PR HEAD changes during review or after an earlier approval, treat the old approval as stale and review the new exact HEAD before declaring it ready.

## Classify findings

For each meaningful finding, assign one outcome:

- **Blocking** — violates the current Issue contract, breaks correctness/safety, invalidates required evidence, or leaves required work incomplete. Post a focused steward finding or review and make sure the canonical handoff reflects the blocker when that workflow is in use.
- **Follow-up** — valid improvement but outside the current contract. Create or recommend a focused follow-up Issue instead of derailing the PR when the user has authorized project-management actions.
- **Note** — non-blocking observation that does not justify churn.

Do not assume an implementation agent will notice every inline review comment. For blocking findings, make the required state visible in the PR's canonical handoff or top-level steward comment when that convention exists.

## Steward behavior

- Prefer updating the existing canonical `agent-handoff:v1` over posting duplicate handoff comments.
- Keep comments evidence-backed and scoped. Avoid speculative rewrites of the Issue during review.
- Do not open a competing implementation branch while another agent owns the PR.
- Never force push. Never merge unless the user has explicitly authorized that merge.
- Before a final recommendation, re-read live PR state so CI, review threads, mergeability, and exact HEAD are current.

For recurring checks, compare against the previous observed state and surface meaningful deltas: new commits, new blockers, resolved blockers, CI/review changes, stalls, or scope drift. Keep unchanged status brief.

## Output

Lead with one of: **blocked**, **needs follow-up but current PR can proceed**, **review-ready**, or **merge-ready pending explicit approval**. Then list only the evidence and actions that materially support that decision.
