# Gemini CLI compatibility

Verified 2026-08-16 against the installed client and its live configuration.

| Item | Value |
|---|---|
| Client | **0.37.0** and **0.55.1** (re-certified; see the last section) |
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

## The guard gap, and how it was closed

`BeforeTool`, `AfterTool` and `AfterAgent` were undeclarable for a long time: the capture
account received HTTP 403 from `cloudcode-pa.googleapis.com`, so no model turn ever ran
and no tool was ever called. An event accepted in configuration is not an event observed
protecting anything, so the adapter declared no guard and no injection.

The 403 was never the real obstacle — reaching *a* model was. Setting
`GOOGLE_GEMINI_BASE_URL` to a local endpoint (with `GEMINI_API_KEY` set to anything, and
an isolated `HOME` so the client does not fall back to OAuth) makes the client run a real
turn against a canned reply. Only the model is stubbed: the client really called
`write_file`, really called `run_shell_command`, and a deny really stopped each of them.

Two details decide whether a guard fires at all:

- **Approval mode.** In the default and `plan` modes this client declares no write tool to
  the model — the toolset is `list_directory`, `read_file`, `grep_search`, `glob`,
  `google_web_search`, `enter_plan_mode` and friends. `write_file` and `replace` appear
  under `auto_edit`, and `run_shell_command` under `yolo`. A guard that never fires in
  plan mode is the client's doing, not a broken install.
- **Workspace containment.** The client refuses a path outside the workspace before the
  tool runs, with `Path not in workspace`.

## The deny contract, and the trap in it

Five candidate replies were run against a real session:

| Reply | Denied? |
|---|---|
| exit code 2 | yes |
| `{"decision":"block","reason":"..."}` | yes |
| `{"hookSpecificOutput":{...,"permissionDecision":"deny",...}}` | **no** |
| exit code 1 | no |
| `{"permission":"deny","reason":"..."}` | no |

The third row is the trap. That shape denies on both Claude Code and Kimi Code, and here
it lets the write through every time, silently.

Context injection inverts it: a bare string and `{"additionalContext": "..."}` are both
dropped, while the `hookSpecificOutput` envelope works — the client unwraps it and appends
the text to the user turn as `<hook_context>...</hook_context>`. Two contracts, opposite
shapes, same client.

`timeout` here is in **milliseconds**, confirmed from both directions: `2000` kills a hook
that sleeps 3s and `10000` lets it finish. (Kimi Code's field is seconds — the same number
means very different things across these clients.)

## Management surface

`gemini hooks` exists as a subcommand, currently offering `gemini hooks migrate` for
importing Claude Code hooks. `gemini extensions` manages extensions. Installation should
prefer these surfaces over hand-editing settings where they cover the operation.

## Consequence for the plan

Task 5 of the adapters plan is accurate. Add `name` and `timeout` to every installed hook
entry: `name` is what lets uninstall remove exactly ACC's entries, which is otherwise a
guess by command string.


## Re-certified on 0.55.1 (2026-08-16)

The installed client moved from 0.37.0 to 0.55.1 mid-certification. Everything above was
measured again against the new version rather than assumed to carry over.

**Unchanged.** The hook event names, the payload fields, the deny contract and the
injection contract are all identical. `exit 2` and `{"decision":"block"}` deny;
`hookSpecificOutput.permissionDecision` still does not. Injection still needs the
`hookSpecificOutput` envelope and still arrives as `<hook_context>...</hook_context>`
appended to the user turn.

**Changed, and both stop a headless run before the first turn:**

1. An auth method must be chosen explicitly. Without
   `security.auth.selectedType` in settings, the client exits with
   `Invalid auth method selected.` - 0.37.0 defaulted instead. Accepted values are
   `gemini-api-key`, `oauth-personal`, `vertex-ai`, `cloud-shell`.
2. The workspace must be trusted. An untrusted folder downgrades the approval mode and
   then refuses, naming `--skip-trust` or `GEMINI_CLI_TRUST_WORKSPACE=true`.

**Changed, and relevant only to capture:** a turn is now routed by first asking a small
model to score its complexity, with a JSON schema attached. A stand-in endpoint that
answers that call with prose makes the client retry and give up before offering any tool,
so nothing fires and it looks like the model simply declined.

The account still receives HTTP 403 from the real model API in headless mode - verified
with a plain `gemini -p` outside ACC entirely, so it is neither ACC's doing nor the
client's. ACC's own hooks were observed firing against the real API on 0.55.1 regardless:
a real session attached and closed through ACC's runtime before the model call failed.

## The extension's hooks.json is a template, measured 2026-08-17 on 0.55.1

This client loads an extension's own `hooks/hooks.json` **in addition to** the
entries in `settings.json`. ACC shipped that file, so every event carried two ACC
hooks: the shimmed one from settings, and the bundled one whose command is still
the literal placeholder `acc-hook`. A hook's environment carries no PATH, so the
second could never run.

What the client reported, on every event:

```
Hook registry initialized with 18 hook entries
Expanding hook command: sh "…/hooks/acc-hook.sh" sessionStart
Expanding hook command: acc-hook sessionStart
Hook execution for SessionStart: 2 succeeded, 1 failed (acc-sessionStart)
```

The work was being done the whole time by the entry that worked, which is why it
looked like a mystery rather than a duplicate. After the template stops shipping:

```
Hook registry initialized with 13 hook entries
Hook execution for SessionStart: 2 hooks executed successfully
```

Found only by reading the client's own `--debug` output. The failure was invisible
from ACC's side: the hook it ran exited 0 and did its work.

## What a live model could not confirm here

Hook wiring is verified against the real client. The model call is not: this
account returns `Permission 'cloudaicompanion.companions.generateChat' denied`
in headless mode, which is the same account limitation already recorded in
`CHANGELOG.md`. So no Gemini session has been driven by a live model, and the
matrix rows for this client rest on hook captures rather than on a completed
turn.

Headless runs also need workspace trust: `GEMINI_CLI_TRUST_WORKSPACE=true`, or
`--skip-trust`.
