# Bounded Tool Output and Drill-Down Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral bounded-output contract that keeps routine command, validation, and worker results small while preserving explicit, attributable access to complete or ranged evidence.

**Architecture:** `src/evidence/tool-output.ts` owns the versioned envelope, bounded previews, diagnostic extraction, artifact storage, range reads, and searches. Process and execution adapters attach the envelope as supplemental evidence while retaining their existing machine-readable fields for parsing and exact-HEAD checks. Persisted validation and agent records accept the envelope structurally, but the envelope never becomes validation or merge authority.

**Tech Stack:** TypeScript, Node.js filesystem/crypto APIs, `node:test`, pnpm.

**Spec:** GitHub Issue #49 and parent Issue #46, read live on 2026-09-19.

## Global Constraints

- GitHub Issue #49 and its parent #46 are authoritative for the bounded-output/evidence contract.
- Exact command exit codes, failure classification, workspace identity checks, reported HEAD SHAs, and final-gate live reconciliation remain authoritative and must not be inferred from a preview.
- Routine previews are bounded and explicitly marked; complete evidence is never silently discarded.
- Raw provider transcripts remain out of durable telemetry; artifacts contain only command/worker evidence needed for explicit drill-down and are stored with private local permissions.
- Scope is limited to #49; do not change polling, model configuration, merge behavior, or unrelated provider policy.

### Task 1: Add the provider-neutral output contract

**Files:**
- Create: `src/evidence/tool-output.ts`
- Modify: `src/index.ts`
- Test: `tests/tool-output.test.ts`

**Interfaces:**
- Produces `ToolOutputEnvelope`, `ToolOutputPolicy`, `ToolOutputStore`, `ToolOutputArtifactReference`, `boundToolOutput`, `readToolOutput`, and `searchToolOutput`.
- A bound result carries outcome, exact exit code, bounded stdout/stderr previews, high-signal diagnostics, explicit overflow metadata, and an opaque artifact reference.
- Drill-down accepts an envelope plus a store and an explicit channel/range; search returns bounded matching lines without loading the complete output into the caller.

- [ ] **Step 1: Write failing contract tests** covering successful huge output, failed huge output with diagnostics and exit code, explicit truncation metadata, full/range reads, diagnostic search, default bounds, and a larger per-call policy.
- [ ] **Step 2: Run `corepack pnpm@10.34.5 exec tsx --test tests/tool-output.test.ts` and confirm the new imports/functions fail because the contract is absent.
- [ ] **Step 3: Implement the versioned envelope, secure file-backed and in-memory stores, bounded tail/diagnostic selection, UTF-8 byte accounting, range reads, and bounded searches.
- [ ] **Step 4: Re-run the focused contract tests and typecheck.

### Task 2: Integrate command, validation, provider, and worker evidence

**Files:**
- Modify: `src/github/transport.ts`
- Modify: `src/validation/local-command.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/validation.ts`
- Modify: `src/store/json-file-store.ts`
- Modify: `src/agents/claude-code.ts`
- Modify: `src/agents/codex-cli.ts`
- Modify: `src/agents/worker-router-container.ts`
- Modify: `src/agents/worker-router.ts`
- Modify: `src/index.ts`
- Tests: `tests/github-transport.test.ts`, `tests/local-command-validation.test.ts`, `tests/claude-code.test.ts`, `tests/codex-cli.test.ts`, `tests/worker-router-container.test.ts`, `tests/worker-router.test.ts`, `tests/store.test.ts`

**Interfaces:**
- `ProcessResult` exposes a bounded `output` envelope while preserving existing raw machine-readable stdout/stderr fields for provider parsing and Git authority commands.
- `ProcessRunOptions` permits a task-specific output policy/store without changing command exit semantics.
- `LocalValidationCommandEvidence`, `AgentResult`, and `ContainerWorkerResult` carry optional bounded output evidence; structural validation accepts only coherent envelopes.

- [ ] **Step 1: Add failing regression tests for process envelopes, validation failure/success output, provider failure evidence, worker log evidence, artifact round-trip persistence, and exact-HEAD behavior with huge output.
- [ ] **Step 2: Run each focused test file and confirm the new assertions fail for the missing integration.
- [ ] **Step 3: Attach envelopes at the process and execution boundaries; include failure tails and artifact references without replacing exact exit/HEAD fields.
- [ ] **Step 4: Update structural guards and exports; keep `FINAL_GATE` and validation authority code unchanged except for optional evidence shape validation.
- [ ] **Step 5: Run focused tests, then the full unit suite, typecheck, and build.

### Task 3: Review and exact-HEAD closeout

**Files:**
- Modify only files required by Tasks 1–2.

- [ ] **Step 1: Inspect the diff for scope, raw-output leakage, silent truncation, and any weakened exact-HEAD or merge-gate checks.
- [ ] **Step 2: Commit the implementation on `codex/issue-49-tool-output-evidence`.
- [ ] **Step 3: Run fresh final validation from the committed exact HEAD.
- [ ] **Step 4: Obtain an independent review against the exact base and HEAD SHAs; fix any blocking findings and re-run invalidated validation/review.
- [ ] **Step 5: Stop merge-ready without merging or force-pushing.
