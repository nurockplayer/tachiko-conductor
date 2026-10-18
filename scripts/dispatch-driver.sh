#!/bin/sh
# This fixed copy belongs inside one protected accepted release. No tsx/source,
# interactive exports, checkout discovery or mutable current-release link.
set -eu
ROOT=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd -P)
# Reject lexical aliases, including a current symlink or an aliased ancestor.
[ "$0" = "$ROOT/scripts/dispatch-driver.sh" ] || exit 78
case "$ROOT" in */.tachiko-conductor/releases/current) exit 78 ;; esac
cd -P -- "$ROOT"
: "${TACHIKO_NODE_PROGRAM:?launchd must pin the accepted absolute Node program}"
case "$TACHIKO_NODE_PROGRAM" in /*) ;; *) exit 78 ;; esac
# No inherited Node loader/preload can be authenticated retroactively.
unset NODE_OPTIONS NODE_PATH LD_PRELOAD DYLD_INSERT_LIBRARIES
exec "$TACHIKO_NODE_PROGRAM" --no-global-search-paths "$ROOT/dist/production-entry.js" dispatch serve "$@"
