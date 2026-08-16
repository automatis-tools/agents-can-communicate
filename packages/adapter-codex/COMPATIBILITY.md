# Codex compatibility

Verified 2026-08-16 against the installed client and the material it ships.

| Item | Value |
|---|---|
| Client | `codex-cli` **0.147.0** (aarch64-apple-darwin standalone) |
| Primary docs | <https://learn.chatgpt.com/docs/plugins> (redirected from developers.openai.com/codex/plugins) |
| Local evidence | installed plugins under `~/.codex/plugins`, bundled `plugin-creator` skill |

## Verified plugin format

`.codex-plugin/plugin.json`, with these manifest keys confirmed by the bundled
`references/plugin-json-spec.md`:

`name`, `version`, `description`, `author`, `homepage`, `repository`, `license`,
`keywords`, `skills` (path), `hooks` (path), `mcpServers` (path **or** inline object),
`apps` (path), `interface` (presentation metadata).

Because `hooks` is a declared path rather than a fixed location, the plan's
`plugin/hooks/hooks.json` layout is compatible.

Hook file shape, taken from real installed plugins:

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Bash",
  "hooks": [ { "type": "command", "command": "./scripts/x.sh" } ] } ] } }
```

## Verified hook events

The taxonomy is not published in the documentation, but it is present in the installed
0.147.0 binary as an enum, appearing twice - once beside `HookEventsToml` and once beside
`HookStateToml` and `trusted_hash`:

```text
PreToolUse  PermissionRequest  PostToolUse  PreCompact  PostCompact
SessionStart  SessionEnd  UserPromptSubmit  SubagentStart  SubagentStop  Stop
```

Independently, `PostToolUse` and `Stop` were observed in real installed plugins.

The events ACC needs therefore exist in this version: `SessionStart` and `SessionEnd` for
attach and detach, `PreToolUse` for a guard, `UserPromptSubmit` for the Intent prompt,
`Stop` for finish, and `SubagentStart`/`SubagentStop` for child sessions.

Related vocabulary in the same binary: `HookSource` (`codex`, `system`, `project`, `mcp`),
`HookHandlerType`, `HookTrustStatus`, `execution_mode`, `scope`, and a `HookRunSummary`
carrying `event_name`, `handler_type`, `execution_mode`, `source_path`, `display_order`,
and `status_message`.

## Open risks

1. **The hook payload shape is unknown.** The event names are settled (above), but
   nothing published or bundled describes what a Codex hook receives on stdin. Claude
   Code documents `session_id`, `cwd`, `transcript_path`, and `hook_event_name`; Codex
   documents nothing equivalent, and the binary's `HookRunSummary` fields describe the
   *result* of a hook run rather than its input. Until a real session is observed, the
   adapter cannot normalise a payload it has never seen, and therefore declares no
   capability as true. Enum membership proves an event exists, not that ACC can handle it.
2. **Hooks require persisted user trust.** The client exposes
   `--dangerously-bypass-hook-trust`, and the docs say "Review and trust plugin hooks
   before you enable them". Installation therefore cannot be silent: `acc install` can
   place the plugin, but the user must trust its hooks before any of them run, and
   `acc doctor` has to report the untrusted state rather than implying protection.
3. **Distribution is marketplace-based.** `codex plugin add` installs from a configured
   marketplace snapshot; the personal marketplace lives at
   `~/.agents/plugins/marketplace.json`. A file drop into a plugins directory is not the
   supported installation path.

## Consequence for the plan

`docs/superpowers/plans/2026-08-15-acc-adapters.md` Task 3 assumes session-start and
session-end hooks and a direct install. The events exist, so the first assumption holds.
The remaining gap is the payload shape: capabilities stay false and `doctor` reports the
adapter as uncaptured until a real Codex session has been observed and its hook payloads
recorded as fixtures. Installation must also account for hook trust and the marketplace
path rather than writing files directly.
