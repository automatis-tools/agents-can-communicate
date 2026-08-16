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
