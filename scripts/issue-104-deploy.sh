#!/bin/sh
# Held deployment/restart helper for #104.  It owns no queue policy and never
# starts a model during preflight.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/issue-104-production-policy.sh"
: "${TACHIKO_NODE_PROGRAM:?TACHIKO_NODE_PROGRAM must name the stable absolute Node runtime}"
if [ ! -x "$TACHIKO_NODE_PROGRAM" ]; then
  echo "TACHIKO_NODE_PROGRAM is not executable: $TACHIKO_NODE_PROGRAM" >&2
  exit 78
fi
: "${TACHIKO_PNPM_PROGRAM:?TACHIKO_PNPM_PROGRAM must name the host-provisioned absolute pnpm executable}"
case "$TACHIKO_PNPM_PROGRAM" in /*) ;; *) echo "TACHIKO_PNPM_PROGRAM must be an absolute path" >&2; exit 78 ;; esac
if [ ! -x "$TACHIKO_PNPM_PROGRAM" ]; then echo "TACHIKO_PNPM_PROGRAM is not executable: $TACHIKO_PNPM_PROGRAM" >&2; exit 78; fi

preflight() {
  "$TACHIKO_NODE_PROGRAM" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/src/cli.ts" production preflight
}

case "${1:-preflight}" in
  preflight) preflight ;;
  restart)
    # Hold before supervisor re-entry.  The durable hold is preserved across
    # reboot and release is an explicit operator action after verification.
    "$TACHIKO_NODE_PROGRAM" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/src/cli.ts" dispatch maintenance hold
    preflight
    : "${TACHIKO_LAUNCHD_LABEL:=io.tachiko.conductor.dispatch-driver}"
    launchctl kickstart -k "gui/$(id -u)/$TACHIKO_LAUNCHD_LABEL"
    ;;
  *) echo "usage: $0 [preflight|restart]" >&2; exit 64 ;;
esac
