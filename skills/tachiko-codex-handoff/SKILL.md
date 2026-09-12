---
name: tachiko-codex-handoff
description: Prepare or refresh a GitHub-grounded implementation handoff for Codex, including an executable Issue contract, an appropriate model and reasoning effort, and a concise non-duplicative prompt. Use when the user says 給我 prompt, 交給 Codex, 串行長任務, 照固定流程給我實作 prompt, or asks which Luna, Terra, Sol, or Astra level should run the work.
---

# Tachiko Codex Handoff

Prepare the smallest handoff that lets Codex execute reliably without turning the prompt into a second source of truth.

## Ground the handoff

1. Read the live repository governance, accepted specs/ADRs relevant to the task, the target Issue, current default-branch HEAD, and any active PR or canonical handoff.
2. Make the Issue executable before writing the handoff. Durable goals, scope, non-goals, acceptance criteria, validation, and evidence requirements belong in GitHub. If the Issue is incomplete and the user has authorized project management, update it first.
3. Reuse the active PR, branch, session, or handoff when one already owns the task. Do not create competing implementation work.
4. When choosing a model or effort, read `references/model-routing.md`. Route by role, ambiguity, and risk rather than task length or benchmark hype.

## Build the prompt

Keep the prompt concise and do not copy the Issue body back into it. Include only what the implementation agent must know to enter the workflow safely:

- exact target Issue or PR;
- instruction to read live repository governance, the Issue contract, latest default branch, and current PR/handoff before editing;
- instruction that the Issue is the implementation contract and scope must not be broadened;
- isolated branch/worktree expectations when new implementation work is required;
- repository-required validation, tests, browser/source evidence, or build checks by reference to the Issue rather than duplication;
- one canonical handoff comment when the repository workflow uses it. The comment must contain the exact marker `<!-- agent-handoff:v1 -->`, followed by at least one non-empty level-two (`##`) section. Prefer a compact structure such as `## STATUS`, `## CURRENT STATE`, `## EVIDENCE`, and `## NEXT ACTION`; put the exact 40-character HEAD SHA and `PR: #<number>` in `## CURRENT STATE` when a PR exists so the live parser can bind identity. Update that same comment only at meaningful milestones rather than posting duplicates;
- no force push and no merge without explicit approval;
- progress updates to GitHub at meaningful milestones and re-reading the latest Issue/PR comments before major phase transitions;
- a fresh independent exact-HEAD review before final handoff when project policy requires it;
- the stop condition: review gate, merge-ready gate, or a bounded human blocker.

If the user supplied a start time or review checkpoint, include that exact checkpoint and tell the agent when to re-read GitHub comments. Do not invent a schedule.

## Execute or return

If an authorized Codex connector is available and the user asked ChatGPT to hand off the work directly, launch the handoff instead of returning a prompt only. Otherwise return the ready-to-paste prompt.

If the user explicitly asks for recurring monitoring, create the requested follow-up separately; do not hide monitoring instructions inside the implementation prompt.

## Output

Report:

1. recommended model and effort, with one-line reasoning;
2. exact Issue/PR target and whether the GitHub contract was changed;
3. either the launched handoff status or the concise prompt;
4. any explicit review/monitoring checkpoint the user requested.
