# Grok compatibility

Verified 2026-08-31 against the installed client and the published hook docs.

| Item | Value |
|---|---|
| Client | **1.0.13** (`5e9a58528b76`, stable) |
| Binary | `~/.grok/bin/grok` → `grok-macos-aarch64` (Mach-O arm64) |
| Config root | `~/.grok`, redirectable with `GROK_HOME` |
| Primary docs | `~/.grok/docs/user-guide/10-hooks.md`, `09-plugins.md`, `08-skills.md` |
| Local evidence | TUI session logs under `~/.grok/sessions/`, `ps -o comm=` |

## Why this adapter exists

Grok also scans Claude Code plugins. An ACC install that only wrote `~/.claude`
made Grok look coordinated when Claude Code was present, and inert when it was
not. This adapter writes only under `~/.grok`. Claude Code remains a separate
adapter. Uninstalling Claude Code must not uninstall Grok, and the reverse.

## Integration surface

Hooks live in `$GROK_HOME/hooks/*.json` and are always trusted. Skills live in
`$GROK_HOME/skills/`. Plugins under `$GROK_HOME/plugins/` are auto-trusted but
stay off until `[plugins].enabled` lists them, so ACC does **not** install as a
Grok plugin.

Install creates three owned paths:

- `~/.grok/hooks/acc.json`
- `~/.grok/hooks/acc-hook.sh`
- `~/.grok/skills/acc/`

It never creates or edits `~/.claude/**`.

## Observed hook events

Captured from real TUI sessions `01a05a0b-…` and `01a05a0c-…` on 1.0.13. The
session log records `hook_execution` with the event name, hook id, status, and
elapsed_ms. It does not store stdin. Payload field names below are from the
published docs, which the same client ships.

| Event (stdin value) | File key | Observed firing | ACC use |
|---|---|---|---|
| `session_start` | `SessionStart` | registered; no `hook_execution` row in the captured log | attach |
| `user_prompt_submit` | `UserPromptSubmit` | yes (451ms / 448ms / 68ms) | heartbeat, poll |
| `pre_tool_use` | `PreToolUse` | yes (`tool_name: read_file`) | write/shell guard (wired, deny unproven) |
| `post_tool_use` | `PostToolUse` | yes | unused |
| `stop` | `Stop` | yes (53ms) | finish while the model is active |
| `session_end` | `SessionEnd` | yes (57ms) | detach |

`ps -o comm=` reports `grok`, so presence can resolve this client's pid.

## Verified hook input fields

Published common fields: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`,
`timestamp`, `permissionMode`, `promptId`. Tool events add `toolName` and
`toolInput`.

Grok's stdin is camelCase. Claude Code's is snake_case. A normaliser that only
reads `hook_event_name` attaches nothing here: the Claude plugin hook on Grok
returned success in 68ms (fail-open) and no Grok session appeared on the roster.

## Response contracts

**Deny (documented, not captured stopping a call).**

```json
{"decision": "deny", "reason": "..."}
```

`hookSpecificOutput.permissionDecision` is also documented. Neither has been
watched blocking a `write` or `run_terminal_command` on this client, so
`guards.beforeWrite` and `guards.beforeShell` stay false.

**Inject.** UserPromptSubmit stdout / `additionalContext` is discarded on 1.0.13
(published as a current limit). `context.beforeTurnInjection` is therefore
false. Agents on this client read `acc status` / `acc inbox` via the skill.

PreToolUse `additionalContext` is documented as arriving *after* the call, which
is not a write guard.

## Tool names

Observed: `read_file`. Documented example: `run_terminal_command`. Grok's own
tools used for edits are `write`, `search_replace`, and `run_terminal_command`.
Claude's `Write|Edit|Bash` matcher does not match them — that is why the
Claude-compat ACC plugin never guarded a Grok edit.

Timeouts on this client are **seconds**. Observe hooks default to 5s; Stop
defaults to 600s.

## What was not observed

- A PreToolUse deny actually blocking `write` or `run_terminal_command`
- UserPromptSubmit `additionalContext` reaching the model
- `SessionStart` stdin (the hook was loaded; the log had no execution row)
- SubagentStart / SubagentStop mapping
- SessionHeartbeat (this client has none)
- `GROK_HOME` relocated away from `~/.grok`

## Consequence for the plan

Grok is tier 2 for attach, presence, and skill-driven polling. It is not tier 2
for turn injection or proven write/shell guards. Advertise that honestly; do
not inherit Claude Code's capability row.

For message delivery this means polling and durable `acc inbox` only. Grok has
no certified next-turn or live-push transport, including on the observed 1.0.13
client, and installation must never report either one as active.

## Native delivery boundary (2026-09-02)

The installed `grok 1.0.13` exposes a shared leader mode on its public surface:
`--leader` / `--no-leader` on `grok agent`, `--leader-socket <PATH>` (default
`~/.grok/leader.sock`), `grok agent leader` ("Run as the shared leader process for
other clients"), and `[cli] use_leader` in `config.toml`, which the vendor's configuration
reference documents as "Use the leader process for config reload and MCP watches".

That surface shares one backend between clients. It does not name a public method that
injects an addressed message into an independently opened ordinary TUI session, and the
leader help only speaks of remote prompts arriving through the vendor relay for headless
leaders. The leader socket protocol is private; ACC does not reverse-engineer it.
`grok agent serve` and `grok agent stdio` are real public entry points, but both make
another process the client's controller, which is outside the transparent-delivery
boundary.

The read-only capture is therefore `fail`, with idle, busy, reply, duplicate, and fallback
all `unobserved`; no client, leader, or ACP server was started by it. The redacted capture
is under `fixtures/delivery/` and `certification.json` stays without native evidence:
`delivery.livePush` and `delivery.replyRoute` remain absent, installation wires hooks and
the skill only, and messages stay durable for `acc inbox`.
