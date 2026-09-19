#!/bin/sh
# Disposable commit-only worker entrypoint for the issue #74 acceptance path.
#
# It mirrors the production worker-router contract exactly:
#   * the task arrives on stdin,
#   * the prepared worktree is the cwd,
#   * the worker commits only and never publishes,
#   * the recognized provenance marker is emitted on stderr.
set -eu

task="$(cat)"
if ! printf '%s' "$task" | grep -q 'TACHIKO_ISSUE74_TASK_MARKER'; then
  echo "container worker: task was not delivered on stdin" 1>&2
  exit 8
fi

marker="CONTAINER_WORKER_MARKER.txt"
printf 'CONTAINER_WORKER_OK\n' > "$marker"

git add -- "$marker"
git commit -q -m "test(#74): container worker commit" --no-gpg-sign

# Containment proof: the bare remote is not mounted, so publication must fail
# here. If it unexpectedly succeeds, fail the run instead of publishing.
if git push --porcelain origin HEAD:refs/heads/containment-probe >/dev/null 2>&1; then
  echo "container worker: unexpected push succeeded" 1>&2
  exit 9
fi

echo "[worker-router] -> deepseek-worker" 1>&2
echo "container worker committed $(git rev-parse HEAD)"
