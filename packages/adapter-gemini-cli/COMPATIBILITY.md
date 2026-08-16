# Gemini CLI compatibility

Verified 2026-08-16 against the installed client and its live configuration.

| Item | Value |
|---|---|
| Client | **0.37.0** |
| Primary docs | <https://geminicli.com/docs/extensions/>, <https://geminicli.com/docs/hooks/> |
| Local evidence | `~/.gemini/settings.json`, `gemini hooks --help`, `gemini extensions` |

## Verified hook events

Observed in live configuration:

`SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`,
`Notification`, `PreCompress`.

The six the adapters plan names are all present. `Notification` and `PreCompress` are
additional and unused by ACC.

## Verified hook entry shape

```json
{ "AfterAgent": [ { "matcher": "*", "hooks": [
  { "name": "example", "type": "command", "command": "…", "timeout": 10000 } ] } ] }
```

Two fields the plan does not mention are real and useful: `name`, which makes an entry
identifiable for ownership-scoped uninstall, and `timeout` in milliseconds, which bounds a
hook rather than letting it hang a turn.

## Observed in a real session

Captured 2026-08-16 from `gemini -p` on 0.37.0, with the capture hooks configured in a
temporary project's `.gemini/settings.json` so no global configuration was changed.
Fixtures are in `fixtures/`.

Fired with real payloads: `SessionStart`, `BeforeAgent`, `SessionEnd`, `PreCompress`.

Payload shape, common to every event: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `timestamp`. `SessionStart` adds `source`; `BeforeAgent` adds `prompt`;
`SessionEnd` adds `reason`; `PreCompress` adds `trigger`. The `timestamp` field is
particular to this client - neither Codex nor Claude Code supplies one.

`gemini extensions validate` accepts the ACC extension bundle, exit 0.

## Not observed, and why

`BeforeTool`, `AfterTool`, and `AfterAgent` never fired. The account used for the capture
received HTTP 403 from `cloudcode-pa.googleapis.com`, so no model turn ever ran and no
tool was ever called. The events are configurable and the client accepts them, but an
event accepted in configuration is not an event observed protecting anything, so this
adapter declares no guard and no injection.

This gap closes as soon as one turn completes on an account that can reach the model API.
It is an account-state problem, not a protocol or client limitation.

## Management surface

`gemini hooks` exists as a subcommand, currently offering `gemini hooks migrate` for
importing Claude Code hooks. `gemini extensions` manages extensions. Installation should
prefer these surfaces over hand-editing settings where they cover the operation.

## Consequence for the plan

Task 5 of the adapters plan is accurate. Add `name` and `timeout` to every installed hook
entry: `name` is what lets uninstall remove exactly ACC's entries, which is otherwise a
guess by command string.
