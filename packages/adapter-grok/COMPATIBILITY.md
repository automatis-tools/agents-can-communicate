# Grok compatibility

The initial hook inventory below was verified 2026-08-31 against Grok 1.0.13.
The later CLI ownership check used Grok 1.0.24; it does not recertify the older client.

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
not. This adapter writes only under `$GROK_HOME` (default `~/.grok`). Claude Code remains a separate
adapter. Uninstalling Claude Code must not uninstall Grok, and the reverse.

## Integration surface

Hooks live in `$GROK_HOME/hooks/*.json` and are always trusted. Skills live in
`$GROK_HOME/skills/`. Plugins under `$GROK_HOME/plugins/` are auto-trusted but
stay off until `[plugins].enabled` lists them, so ACC does **not** install as a
Grok plugin.

Install creates three owned paths under the selected Grok home (defaults shown):

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
false. On the observed 1.0.24 client, the skill first runs public `acc status --json`,
receives its own arguments
from a terminal hook reminder, then uses the exact pair for `acc inbox` and mutations.

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
- `GROK_HOME` relocated away from `~/.grok` during the original 1.0.13 capture

## Consequence for the plan

Grok installs hooks and a skill for coordination and inbox polling, but has no certified
effective capability tier. `SessionStart` remains unobserved; installed wiring does not
prove lifecycle, turn injection, or write/shell guards. Do not inherit another adapter's
capability row.

For message delivery this means polling and durable `acc inbox` only. Grok has
no certified next-turn or live-push transport, including on the observed 1.0.13
client, and installation must never report either one as active.

## CLI ownership check (2026-09-08, macOS arm64)

A locally packed development candidate was installed into an isolated home with the
ordinary ACC installer, then loaded by **Grok 1.0.24 (`68e414c661e3`, stable)**.
The binary SHA-256 was
`4291021c1570a7c8610277a3d65490a5e54b50311e222c6b4614264f02a215b3`.
The headless client used its documented `bypassPermissions` mode for disposable ACC
commands; ordinary approval mode had cancelled the first command for lack of interactive
input. ACC does not select or alter this permission mode.

The installed skill ran public status, then used its own hook-provided session and
generation for intent, a room note, and a complete handoff. Public ACC state attributed
the note and handoff to the participant derived from that exact native Grok session;
no manually attached or MCP replacement participant appeared. Both recorded messages
survived exit, with zero live sessions or claims. Evidence retains client/version hashes,
operation metadata, and deliberate ACC fixture messages, not raw client transcripts.

Configured **PreToolUse** `additionalContext` arrives after the terminal result. ACC
sends one complete own-identity line only; it does not rewrite the command, collect peer
bodies, or advance delivery receipts. The first public status call is a bootstrap, not an
owned mutation. A header alongside `finish` can already name a closed owner; every owned mutation or
inbox read still validates the pair. A new genuine user turn supplies a fresh owner.

Two independently launched Grok sessions also completed a request/reply exchange:
each saw its own header, used only its own pair, explicitly read the message, and
finished with a complete handoff. The request became `acknowledged`, the answer
`retrieved`, and both owners closed. The [normalized capture](fixtures/cli-owner-grok-1.0.24.json)
records these observations and the tested development archive hash.

This proves the installed CLI ownership flow on the observed version and platform.
It does not prove external wake, peer-message injection, subagent identity, a real guard
refusal, or support on other client versions/platforms. All capability flags remain false.
Install, doctor, and uninstall also exercise explicit, empty, and unset `GROK_HOME` through
the packed CLI; relocating a profile never authorizes using another session's identity.

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
