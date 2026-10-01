# GitHub issue admission

GitHub intake records **task intent** before Tachiko Conductor resolves a concrete implementation provider. It does not replace the durable Run, #101 dispatch queue, exact-HEAD validation, review, or merge gate.

## Task kinds

| Kind | Implementation writer? | GitHub implementation dispatch |
| --- | --- | --- |
| `implementation` | yes, after task-shape admission | eligible when `bounded`/`interacting` |
| `repair` | yes, after task-shape admission | eligible when `bounded`/`interacting` |
| `research` | no | blocked |
| `decision` | no | blocked; Steward/Oracle boundary |
| `operational` | no repository implementation writer | blocked |
| `coordination` | no | blocked |
| `tracking` | no | blocked |

Repository code changes discovered by research/operational/coordination work should be authorized by a separate or revised `implementation`/`repair` Issue rather than silently acquiring writer authority.

## Provider-neutral task-shape mapping

The GitHub admission projection reuses the policy implemented by #90:

```text
bounded     -> routine
interacting -> complex
decision    -> Steward/Oracle, zero implementation writer
```

`routine` and `complex` are execution profiles, not model/provider names. Provider routing remains runtime configuration.

## Trust boundary

Issue Forms are structured intake. Only an `OWNER` Issue Form submission becomes trusted task authority automatically. `MEMBER`, `COLLABORATOR`, and external associations require explicit OWNER/Steward authority before unattended writer admission; association alone is not treated as repository-write authority. For untrusted authors, the same form is only a proposal and receives `needs:steward`; it cannot receive `dispatch:ready`.

A trusted Steward may author/reconcile an Issue through a body or comment containing this strict marker and JSON:

````markdown
<!-- steward-task-authority:v1 -->

```json
{
  "revision": "issue-123-authority-v2",
  "kind": "implementation",
  "shape": "bounded",
  "executionProfile": "routine",
  "oracleRequired": false
}
```
````

The fields are strict:

- writer kinds (`implementation`, `repair`):
  - `bounded` requires `routine`, `oracleRequired=false`;
  - `interacting` requires `complex`, `oracleRequired=false`;
  - `decision` requires `executionProfile=null`, `oracleRequired=true`;
- `decision` kind requires `shape="decision"`, `executionProfile=null`, `oracleRequired=true`;
- `research`, `operational`, `coordination`, and `tracking` require `shape=null`, `executionProfile=null`, `oracleRequired=false`.

The latest trusted structured authority comment wins. An invalid latest trusted authority fails closed rather than falling back to older state.

Issue Form authority revisions are content-bound to the full submitted form body. Editing scope, acceptance criteria, dependencies, or stop conditions therefore rotates the revision even when the selected task shape is unchanged. Explicit Steward authority uses its supplied revision and must be bumped when that authority changes.

Legacy `<!-- steward-task-shape-authority:v1 -->` `{revision, shape}` comments remain read-compatible and project as `kind=implementation`.

## Managed projection

`.github/workflows/issue-admission.yml` creates/reconciles a bounded label set and one canonical `<!-- tachiko-issue-admission:v1 -->` comment.

Important: labels and the managed comment are **derived projections**. `dispatch:ready` means the Issue is eligible to be admitted to the separate implementation queue; it does not insert or mutate #101 by itself.

Managed labels:

- `kind:*`
- `shape:bounded|interacting|decision`
- `profile:routine|complex`
- `oracle:required|not-required`
- `classification:ready`
- `needs:classification`
- `needs:steward`
- `dispatch:ready|blocked`

Unrelated labels (for example priority labels) are preserved. Stale managed labels are replaced from current trusted authority.

## ChatGPT / API-created Issues

When ChatGPT or another trusted automation creates an Issue without the browser Issue Form, include the strict `steward-task-authority:v1` block in the Issue body. Do not encode Luna, Terra, DeepSeek, CODEX_HOME paths, or model names in task authority.

For an implementation Issue the normalized admission comment exposes a provider-neutral Conductor handoff:

```json
{
  "executionProfile": "routine",
  "taskShapeAuthority": {
    "revision": "issue-123-authority-v2",
    "shape": "bounded"
  }
}
```

The Project Steward may use that projection when deliberately admitting an Issue to #101, but #101 remains a separate explicit queue/claim boundary.
