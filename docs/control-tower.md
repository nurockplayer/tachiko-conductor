# Tachiko Control Tower

Control Tower is a macOS-first Tauri desktop projection of Conductor's
operational read model. It is deliberately not a second workflow engine:
workflow transitions, provider execution, GitHub authority, and housekeeping
policy remain outside the React UI.

## Run and build

From the repository root, use the pinned package manager:

```bash
export TACHIKO_CONTROL_TOWER_REPOSITORY="$PWD"
corepack pnpm@10.34.5 --dir apps/control-tower dev
corepack pnpm@10.34.5 --dir apps/control-tower build
corepack pnpm@10.34.5 --dir apps/control-tower tauri:build
```

`TACHIKO_CONTROL_TOWER_REPOSITORY` optionally adds a stable Conductor repository
root to the read-only native collector. Finder/Dock launches do not depend on it
or on a shell cwd: discovery begins from the bounded managed-worktree root and
digest-verified operational projections. `TACHIKO_WORKSPACE_ROOT` optionally
selects that managed-worktree root (the default is
`~/.tachiko-conductor/workspaces`). Without a provable root, production renders
an empty/unavailable live state; it never substitutes the deterministic fixture.
`tauri:build` runs a macOS release no-bundle build under
`apps/control-tower/src-tauri/target/release/`; invoking Tauri's normal bundle
command on a configured signing host produces the `.app` artifact.

## Read model and safety

The frontend consumes the provider/UI-neutral
`src/operational/read-model.ts` (`ControlTowerSnapshot` / `WorkUnitView`), so
future CLI or automation consumers can use the same typed projection. The native
collector discovers only the configured Conductor root, direct managed-worktree
roots, and workspace paths named by digest-verified operational projections; it
does not scan HOME or depend on a Codex database/session format. Before joining
a run to a worktree it proves canonical path, common-Git identity, GitHub remote,
branch, bootstrap-base ancestry, and any claimed exact HEAD; a live PR must also
still name that observed head. Missing or ambiguous evidence remains unlinked.
It uses bounded reads for current process RSS when an exact path association is
observable, worktree disk usage, data-volume capacity, system RAM, and GitHub PR
state.

Live reclaim state is intentionally `unknown` until a shared,
repository-owned housekeeping classifier proves it. The UI has no direct
`rm -rf` or `git worktree remove` path; its disabled action explains that the
capability is unavailable.

## Visual fixture

The default browser render is the deterministic golden fixture from Issue #32:
the four approved rows, values, filter labels, card/table composition, and
copy are stable for visual review. The renderer changes to live observations
only inside Tauri. Capture the desktop and 320px views with:

```bash
corepack pnpm@10.34.5 exec playwright screenshot --browser chromium --viewport-size '1440,900' --full-page http://127.0.0.1:1420 docs/evidence/control-tower/golden-desktop-1440.png
corepack pnpm@10.34.5 exec playwright screenshot --browser chromium --viewport-size '320,900' --full-page http://127.0.0.1:1420 docs/evidence/control-tower/golden-narrow-320.png
```
