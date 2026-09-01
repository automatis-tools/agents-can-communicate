# Claude Code compatibility

Verified 2026-08-16 against the installed client and the primary documentation.

| Item | Value |
|---|---|
| Client | **2.1.233** |
| Primary docs | <https://code.claude.com/docs/en/hooks> |
| Local evidence | `~/.claude/settings.json` and installed plugin `hooks/hooks.json` files |

## Verified hook events used by ACC

| Event | Blocking | ACC use |
|---|---|---|
| `SessionStart` | advisory | attach |
| `SessionEnd` | advisory | detach, lifecycle cleanup only |
| `UserPromptSubmit` | can block | prompt for Intent at a safe point |
| `PreToolUse` | can block | resource guard |
| `Stop` | can block | `finish` while the model is still active |
| `SubagentStart` | advisory | child session mapping |
| `SubagentStop` | can block | child session close |

The client supports 31 events in total. Ones ACC does not use but should not be surprised
by include `Setup`, `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`,
`PostToolBatch`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `PreCompact`,
`PostCompact`, `WorktreeCreate`, `Elicitation`.

## Verified hook input fields

Always present: `session_id`, `transcript_path`, `cwd`, `hook_event_name`.
Conditional: `prompt_id`, `permission_mode`, `effort`, `agent_id`, `agent_type`.

`agent_id` and `agent_type` are supplied on subagent calls, so parent/child session
mapping rests on documented metadata rather than inference.

## Observed in a real session

Captured 2026-08-16 from `claude -p` on 2.1.233, using `--plugin-dir` so the capture
plugin was loaded for that session only and never installed into the operator's
configuration. Fixtures are in `fixtures/`.

Fired and completed: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `SessionEnd`. The payloads match the published documentation exactly - unlike
Codex, where nothing was published and the tool vocabulary turned out to differ.

**`PreToolUse` genuinely denies.** Returning

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
 "permissionDecisionReason":"..."}}
```

blocked a `Write` - the file was never created - and a `Bash` call - `echo probe` never
ran. In both cases the model received the reason, explained it to the user, and declined
to route around the guard.

**`UserPromptSubmit` injection reaches the model.** A hook returning
`hookSpecificOutput.additionalContext` put its marker into the session, and the model
reported it as an observation rather than acting on it - which is the property the design
depends on: injected coordination context is data, not instruction.

Tool names confirmed: `Write` with `tool_input: { file_path, content }`, `Bash` with
`tool_input: { command, description }`. Not `apply_patch`, which is what Codex uses.

`PreToolUse` also carries `effort`; `Stop` carries `background_tasks` and
`session_crons` alongside `stop_hook_active` and `last_assistant_message`.

## Privacy consequence

`transcript_path` is supplied on **every** event. "Raw transcripts are not collected by
default" therefore has to be an active property of the adapter, not an absence of
opportunity. `normalizeHook` is a whitelist, and the conformance matrix pins the exact key
set it may produce, so a field the harness starts sending cannot leak into coordination
state by default.

## Consequence for the plan

Task 4 of the adapters plan lists seven events and is accurate for the ones ACC uses.
`TeammateIdle` is worth noting separately: ACC does not replace Claude Agent Teams, and
that event is the documented signal that a teammate is idle.

## Installation, measured 2026-08-17 on 2.1.233

The adapter used to write a settings key called `accPlugins`. There is no such
setting. The client never loaded the plugin, no hook ever fired, and no session
attached - on any machine. Nothing showed it: `acc install` reported success,
`acc doctor` reported the plugin registered, and the capability matrix claimed
`lifecycle.sessionStart: yes`.

Measured by running the client's own commands against a home and diffing it:

```
claude plugin marketplace add <dir>
claude plugin install agents-can-communicate@acc-local --scope user
```

Four results, all required:

| File | Shape |
|---|---|
| `plugins/known_marketplaces.json` | `{ "<m>": { source: { source: "directory", path }, installLocation, lastUpdated } }` |
| `plugins/installed_plugins.json` | `{ version: 2, plugins: { "<p>@<m>": [{ scope, installPath, version, installedAt, lastUpdated }] } }` |
| `plugins/cache/<m>/<p>/<version>/` | the copy the client runs from |
| `settings.json` | `extraKnownMarketplaces` and `enabledPlugins["<p>@<m>"] = true` |

A directory-sourced marketplace stays where it is: `installLocation` is the source
path rather than a clone under `marketplaces/`. ACC still puts its own marketplace
under `plugins/marketplaces/acc-local` so uninstall has one tree to remove.

Two details that only a diff shows:

- the client writes both registries with two-space indent and **no** trailing
  newline. Adding one left uninstall a byte off in a file ACC had only borrowed;
- `enabledPlugins` holds every plugin the user has - twenty-three on the machine
  this was measured on. Taking the whole key would destroy them, and giving it
  back on uninstall would destroy them again, so ACC records ownership of its own
  entry rather than of the container.

Verified on a real machine: after `acc install --adapter claude_code`, a
`claude -p` run with nothing about ACC in the prompt attached a session by
itself, and `acc uninstall` restored all three files byte for byte.

## Native Channel boundary (2026-09-01)

The installed Claude Code `2.1.252` recognizes the documented
`--dangerously-load-development-channels server:acc-spike` entry and displays the
full-screen development-channel security warning before starting the configured MCP
child. The operator cancelled at that warning rather than bypassing it. The `acc-spike`
child was not spawned and its Unix-domain socket was never created.

The real-client capture is therefore `fail`: channel registration, idle delivery, busy
queueing, reply routing, duplicate retry, and durable fallback are all unobserved. The
zero-network spike advertises `claude/channel` plus tools only, omits permission relay,
uses stdio for MCP, and accepts one bounded envelope on a mode-`0600` Unix-domain socket
outside the repository, but those properties are implementation boundaries rather than
real-client certification. No native delivery capability is certified by this evidence.
The redacted capture is under `fixtures/delivery/`.
