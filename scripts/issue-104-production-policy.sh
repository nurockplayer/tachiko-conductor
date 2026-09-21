#!/bin/sh
# Source only from a stable, merged checkout.  This file contains no secrets
# and is deliberately independent of the #101 queue-driver wrapper.
set -eu

: "${TACHIKO_LUNA_CODEX_HOME:=/Users/tachikoma/.tachiko-conductor/luna-codex-home}"
export TACHIKO_LUNA_CODEX_HOME
export TACHIKO_IMPLEMENTATION_AGENT='luna-isolated'
export TACHIKO_EXECUTION_PROFILE_CONFIG='{"revision":"issue-104-production-v1","profiles":{"routine":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"standard":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"complex":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"},"critical":{"executor":"luna-isolated","model":"gpt-5.6-luna","reasoningEffort":"high","timeoutMs":900000,"sandboxMode":"workspace-write","approvalPolicy":"never"}}}'
export TACHIKO_LOCAL_VALIDATION_CONFIG='{"revision":"issue-104-production-v1","commands":[{"argv":["pnpm","install","--frozen-lockfile"],"timeoutMs":300000},{"argv":["pnpm","test"],"timeoutMs":300000},{"argv":["pnpm","typecheck"],"timeoutMs":120000},{"argv":["pnpm","build"],"timeoutMs":120000}]}'
export TACHIKO_HOSTED_CHECK_POLICY_CONFIG='{"revision":"issue-104-production-v1","mode":"required","requiredCheckNames":["test"]}'
