#!/bin/sh
# Source only from a stable, merged checkout.  This file contains no secrets
# and is deliberately independent of the #101 queue-driver wrapper.
set -eu

# The launchd plist (or an operator invoking the stable driver) owns this
# durable absolute location.  Never invent a home: it could silently select
# the wrong owner configuration.  This script never copies authentication.
: "${TACHIKO_LUNA_CODEX_HOME:?TACHIKO_LUNA_CODEX_HOME must name an owner-controlled absolute Luna CODEX_HOME}"
case "$TACHIKO_LUNA_CODEX_HOME" in
  /*) ;;
  *) echo "TACHIKO_LUNA_CODEX_HOME must be an absolute path" >&2; exit 78 ;;
esac
export TACHIKO_LUNA_CODEX_HOME
: "${TACHIKO_NODE_PROGRAM:?TACHIKO_NODE_PROGRAM must name the host-provisioned absolute Node runtime}"
case "$TACHIKO_NODE_PROGRAM" in
  /*) ;;
  *) echo "TACHIKO_NODE_PROGRAM must be an absolute path" >&2; exit 78 ;;
esac
if [ ! -x "$TACHIKO_NODE_PROGRAM" ]; then
  echo "TACHIKO_NODE_PROGRAM is not executable: $TACHIKO_NODE_PROGRAM" >&2
  exit 78
fi
export TACHIKO_NODE_PROGRAM
: "${TACHIKO_PNPM_PROGRAM:?TACHIKO_PNPM_PROGRAM must name the host-provisioned absolute pnpm executable}"
case "$TACHIKO_PNPM_PROGRAM" in
  /*) ;;
  *) echo "TACHIKO_PNPM_PROGRAM must be an absolute path" >&2; exit 78 ;;
esac
if [ ! -x "$TACHIKO_PNPM_PROGRAM" ]; then
  echo "TACHIKO_PNPM_PROGRAM is not executable: $TACHIKO_PNPM_PROGRAM" >&2
  exit 78
fi
export TACHIKO_PNPM_PROGRAM
: "${TACHIKO_PLAYWRIGHT_BROWSERS_PATH:?TACHIKO_PLAYWRIGHT_BROWSERS_PATH must name a host-owned absolute Playwright browser artifact directory}"
case "$TACHIKO_PLAYWRIGHT_BROWSERS_PATH" in
  /*) ;;
  *) echo "TACHIKO_PLAYWRIGHT_BROWSERS_PATH must be an absolute path" >&2; exit 78 ;;
esac
export TACHIKO_PLAYWRIGHT_BROWSERS_PATH
export TACHIKO_IMPLEMENTATION_AGENT='luna-isolated'
export TACHIKO_EXECUTION_PROFILE_CONFIG='{"revision":"issue-104-production-v3","profiles":{"routine":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"standard":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"complex":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"critical":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"}}}'
export TACHIKO_LOCAL_VALIDATION_CONFIG='{"revision":"issue-104-production-v3","playwrightBrowsersPathEnvironment":"TACHIKO_PLAYWRIGHT_BROWSERS_PATH","nodeProgramEnvironment":"TACHIKO_NODE_PROGRAM","pnpmProgramEnvironment":"TACHIKO_PNPM_PROGRAM","commands":[{"argv":["pnpm","install","--frozen-lockfile"],"timeoutMs":300000},{"argv":["pnpm","test"],"timeoutMs":300000},{"argv":["pnpm","typecheck"],"timeoutMs":120000},{"argv":["pnpm","build"],"timeoutMs":120000}]}'
export TACHIKO_HOSTED_CHECK_POLICY_CONFIG='{"revision":"issue-104-production-v3","mode":"not_required"}'
