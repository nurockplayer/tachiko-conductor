#!/bin/sh
# Long-running launchd entrypoint. Install this only from a stable, merged
# checkout: a Codex worktree is intentionally not a durable launchd target.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Canonical production control plane: Issue #101, Steward queue comment
# 5755262217. This is queue location only; execution and validation policy
# deliberately remain external and are not invented here.
export TACHIKO_DISPATCH_CONFIG='{"revision":"dispatch-production-v1","owner":"nurockplayer","repo":"tachiko-conductor","controlIssue":101,"queueCommentId":5755262217,"leaseDurationMs":900000}'

exec corepack pnpm@10.34.5 exec tsx "$ROOT/src/cli.ts" dispatch serve "$@"
