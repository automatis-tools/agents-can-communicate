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

## Management surface

`gemini hooks` exists as a subcommand, currently offering `gemini hooks migrate` for
importing Claude Code hooks. `gemini extensions` manages extensions. Installation should
prefer these surfaces over hand-editing settings where they cover the operation.

## Consequence for the plan

Task 5 of the adapters plan is accurate. Add `name` and `timeout` to every installed hook
entry: `name` is what lets uninstall remove exactly ACC's entries, which is otherwise a
guess by command string.
