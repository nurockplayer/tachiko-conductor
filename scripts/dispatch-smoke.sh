#!/bin/sh
set -eu

if [ "${TACHIKO_DISPATCH_SMOKE:-}" != "1" ]; then
  echo 'Refusing live dispatch smoke: set TACHIKO_DISPATCH_SMOKE=1 after configuring a disposable control Issue.' >&2
  exit 2
fi

exec pnpm exec tsx src/cli.ts dispatch once
