# Managed browser runtime

Tachiko Conductor uses browser automation only when a stable API, native
integration, or first-party MCP is unavailable or materially insufficient.
Browser Runtime v0 manages the official Microsoft Playwright MCP server; it
does not wrap Playwright actions, fork a browser engine, or introduce a second
browser-agent framework.

The runtime package is pinned exactly to `@playwright/mcp` `0.0.79`. Runtime
launch uses the package's local `cli.js` with a child-process argument array,
never `npx @latest` or a shell-concatenated command.

## Profile boundary

Each profile is an explicit named resource such as `github-work`. Its browser
storage belongs only to Tachiko and is never copied from Chrome, Edge, or the
user's everyday browser profile.

Defaults:

| Resource | Location |
| --- | --- |
| Persistent profiles | `~/.tachiko-conductor/browser/profiles/<profile>` |
| Runtime metadata | `~/.tachiko-conductor/browser/runtimes/<profile>.json` |
| Playwright output | `~/.tachiko-conductor/browser/runtimes/<profile>-output` |

Override the two roots with `TACHIKO_BROWSER_PROFILE_ROOT` and
`TACHIKO_BROWSER_RUNTIME_ROOT`. Both roots must remain outside the current
repository. Directories and metadata are created with user-only permissions.
Runtime metadata contains the named runtime/profile, PID, endpoint, lifecycle
timestamps, readiness/health, and typed exit information. It never contains
cookies, auth headers, passwords, tokens, storage contents, form values, or
model/browser transcripts.

One live runtime owns a profile lock before Playwright starts. A second runtime
cannot mutate that profile concurrently. A dead owner's stale lock can be
reclaimed; a live owner's lock produces `BROWSER_PROFILE_IN_USE` with the PID
and runtime ID.

## Bootstrap and normal use

Build once, then start a headed bootstrap for a named profile:

```bash
pnpm build
node dist/cli.js browser bootstrap github-work
```

Bootstrap opens the dedicated Tachiko browser profile. Navigate and complete
login, SSO, or 2FA manually in that window. The command stays in the foreground
as the owner of the managed child process so it can record the real exit and
clean up reliably. In another terminal:

```bash
node dist/cli.js browser status github-work
node dist/cli.js browser stop github-work
```

After bootstrap, reuse the same profile unattended in headless mode:

```bash
node dist/cli.js browser start github-work --headless
```

`start` is headless by default; `--headed` is available for diagnostics or
manual takeover. The runtime chooses an available port unless `--port` is
provided. It binds to `127.0.0.1` by default and emits the Streamable HTTP MCP
endpoint at `/mcp`. `--host` is an explicit operator override; exposing an MCP
browser endpoint beyond loopback requires a separately trusted network and is
not the v0 default.

Startup checks the configured port, races readiness against child exit and a
bounded timeout, and reports typed errors for invalid config, occupied ports,
profile ownership, spawn failure, startup timeout, early/unexpected exit, and
stop timeout. `SIGINT`/`SIGTERM` request a clean child stop; a bounded `SIGKILL`
fallback is used only when the child does not exit.

## Agent connection

Successful `browser start` and `browser bootstrap` output one JSON document
containing:

- the non-secret runtime snapshot;
- a generic `mcp-http` capability descriptor;
- a Claude Code `mcpServers` object;
- a Codex per-invocation config override.

No global Claude or Codex configuration is mutated. To give an orchestrated
Claude implementation the capability, name the already-running profile:

```bash
node dist/cli.js run nurockplayer/tachiko-conductor#12 --browser-profile github-work
node dist/cli.js run resume <run-id> --decision retry --browser-profile github-work
```

Conductor verifies that the named profile is live and healthy, then adds the
generic capability only to that implementation request. The Claude adapter
translates it into inline `--mcp-config` JSON, `--strict-mcp-config`, and the
narrow `mcp__tachiko_browser__*` allow rule. It does not use
`bypassPermissions`. Review-fix invocations receive the same ephemeral
capability. Browser runtime details are not added to persisted run state or to
the workflow state machine.

For a direct Codex invocation, use the emitted `codex.configOverride` value:

```bash
codex -c 'mcp_servers.tachiko_browser.url="http://127.0.0.1:8931/mcp"' exec '<prompt>'
```

For a direct Claude invocation, pass the emitted `claudeCode` object to
`--mcp-config`, add `--strict-mcp-config`, and allow only
`mcp__tachiko_browser__*`.

## Human and safety boundary

Removing a repetitive hosted-browser consent dialog does not authorize every
web action. An implementation agent receiving this capability is instructed to:

- prefer APIs and first-party integrations;
- never inspect or copy a personal browser profile;
- stop at authentication expiry, login challenges, 2FA, or CAPTCHA rather than
  bypassing or guessing them;
- never make purchases or payments, change billing, delete accounts, or change
  credentials/security settings.

At such a boundary the adapter accepts only the explicit result protocol
`TACHIKO_NEEDS_HUMAN: <reason>`. Conductor routes that result into the existing
`NEEDS_HUMAN` state with bounded takeover/resume choices. It does not infer risk
from arbitrary model prose and does not add browser-specific workflow states.

Playwright MCP supports allowed/blocked origin rules, but its own documentation
warns that they do not cover every redirect/navigation case. They are defense
in depth, not a complete security boundary; Browser Runtime v0 does not present
them as authorization or CAPTCHA/transaction protection.

## Validation and smoke paths

The default suite starts the real pinned Playwright MCP server, navigates only
to a localhost fixture, writes local storage, stops, restarts the same profile,
and verifies that the state persists. It requires no model, paid API, or
external website.

The real-agent path is deliberately separate and opt-in because it invokes the
locally authenticated Codex CLI once:

```bash
TACHIKO_BROWSER_AGENT_SMOKE=1 pnpm exec tsx --test tests/browser-agent-smoke.test.ts
```

It starts the managed runtime and a localhost-only fixture, injects a per-run
MCP config, permits only `browser_navigate` and `browser_snapshot`, uses a
read-only sandbox with no persisted session, and requires Codex to return the
fixture sentinel. Enabling the path without an installed/authenticated `codex`
CLI fails clearly; the default test suite and CI skip it.

Current upstream references:

- [Playwright MCP introduction](https://playwright.dev/mcp/introduction)
- [Playwright MCP configuration](https://playwright.dev/mcp/configuration/options)
- [Playwright MCP profile and state](https://playwright.dev/mcp/configuration/user-profile)
- [Connecting to existing browsers](https://playwright.dev/mcp/configuration/browser-extension)
- [Codex MCP configuration](https://developers.openai.com/codex/extend/mcp)
- [Codex non-interactive mode](https://developers.openai.com/codex/non-interactive-mode)
