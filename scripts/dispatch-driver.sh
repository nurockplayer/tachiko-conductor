#!/bin/sh
# Long-running launchd entrypoint. Install this only from a stable, merged
# checkout: a Codex worktree is intentionally not a durable launchd target.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Canonical production control plane: Issue #101, Steward queue comment
# 5755262217. This is queue location only; execution and validation policy
# deliberately remain external and are not invented here.
export TACHIKO_DISPATCH_CONFIG='{"revision":"dispatch-production-v1","owner":"nurockplayer","repo":"tachiko-conductor","controlIssue":101,"queueCommentId":5755262217,"leaseDurationMs":900000}'

# launchd does not inherit an interactive shell PATH. The post-merge installer
# supplies this explicit, stable runtime through its plist; this wrapper never
# discovers a transient FNM/Corepack path or starts a restart loop on it.
: "${TACHIKO_NODE_PROGRAM:?TACHIKO_NODE_PROGRAM must name a stable absolute Node runtime}"
if [ ! -x "$TACHIKO_NODE_PROGRAM" ]; then
  echo "TACHIKO_NODE_PROGRAM is not executable: $TACHIKO_NODE_PROGRAM" >&2
  exit 78
fi

exec "$TACHIKO_NODE_PROGRAM" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/src/cli.ts" dispatch serve "$@"
