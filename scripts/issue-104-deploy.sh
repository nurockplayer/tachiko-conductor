#!/bin/sh
# Held local verification only. No installation, acceptance, active supervisor
# restart, secret copy, state rollback, or implicit HOLD release.
set -eu
ROOT=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)
# Reject lexical aliases, including a current symlink or an aliased ancestor.
[ "$0" = "$ROOT/scripts/issue-104-deploy.sh" ] || exit 78
case "$ROOT" in */.tachiko-conductor/releases/current) exit 78 ;; esac
cd -P -- "$ROOT"
: "${TACHIKO_NODE_PROGRAM:?use the accepted absolute Node runtime}"
case "$TACHIKO_NODE_PROGRAM" in /*) ;; *) exit 78 ;; esac
unset NODE_OPTIONS NODE_PATH LD_PRELOAD DYLD_INSERT_LIBRARIES
case "${1:-preflight}" in
  preflight|held-check) exec "$TACHIKO_NODE_PROGRAM" --no-global-search-paths "$ROOT/dist/production-entry.js" production preflight ;;
  restart) echo 'Restart requires HOLD, independent drain/quiescence proof, held release selection, then held-check. This helper does not restart a supervisor.' >&2; exit 78 ;;
  *) echo "usage: $0 [preflight|held-check]" >&2; exit 64 ;;
esac
