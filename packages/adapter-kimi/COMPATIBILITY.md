# Kimi Code compatibility

Verified 2026-08-16 against the installed client. Every claim below was produced by
running that client, not by reading about it.

| Item | Value |
|---|---|
| Client | `kimi` **0.36.1** |
| Config root | `~/.kimi-code`, redirectable with `KIMI_CODE_HOME` |
| Local evidence | isolated `KIMI_CODE_HOME`, hook captures, config-schema probes |

## The integration surface is not the plugin

This is the first of the four clients where hooks do **not** live in the plugin. Its
plugin manifest (`.kimi-plugin/plugin.json`) has no `hooks` key at all — the keys it
carries are `name`, `version`, `description`, `skills`, `sessionStart.skill`,
`skillInstructions` and `interface`. Hooks are a top-level `[[hooks]]` array in
`config.toml`, and there is no project-level config to put them in, so ACC edits the
user's global file.

That is why ACC owns a delimited region rather than parsing the file: ACC ships without
dependencies, and a hand-written TOML round-tripper would take the user's comments and
formatting down with it. Install rewrites the region between the markers; everything
outside comes back byte for byte.

## Verified hook events

Not documented locally and not guessed. The client validates `config.toml` with a strict
schema, so an empty hook entry makes it list every accepted value:

```text
$ kimi doctor
hooks[0].event: Invalid option: expected one of "PreToolUse"|"PostToolUse"|
"PostToolUseFailure"|"PermissionRequest"|"PermissionResult"|"UserPromptSubmit"|
"UserPromptQueued"|"TurnStarted"|"Stop"|"StopFailure"|"Interrupt"|"SessionStart"|
"SessionEnd"|"SessionHeartbeat"|"SubagentStart"|"SubagentStop"|"TaskStarted"|
"PreCompact"|"PostCompact"|"Notification"
hooks[0].command: Invalid input: expected string, received undefined
```

The same probe gives the entry shape: `event` and `command` are required, `matcher` and
`timeout` are optional, and **any other key is an error** — `name`, `type`, `async`,
`enabled` and `cwd` were all rejected. An entry copied from another harness does not
merely misbehave here; it fails validation and takes the whole config with it.

`timeout` is in **seconds**, and the schema caps it at 600. The cap is the decisive
evidence: 600 milliseconds would be a nonsensical ceiling for a hook, and copying Gemini's
`10000` — which is correct there, where the unit *is* milliseconds — fails validation
outright and takes every hook in the file down with it.

Confirmed from both directions rather than one: `timeout = 60` lets a hook that sleeps 3s
finish and deny, while `timeout = 1` kills it. A single failing direction proves nothing
here, because a hook dies under `timeout = 1` whichever unit it is.

## What was observed firing

Captured from real sessions. Nine of the twenty events appeared:

| Event | Payload beyond the common four |
|---|---|
| `SessionStart` | `source`, `model`, `profile` |
| `UserPromptSubmit` | `prompt` (content blocks), `is_steer` |
| `TurnStarted` | `turn_id`, `origin_kind`, `prompt` (raw string) |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_call_id` |
| `PostToolUse` | the above plus `tool_output` |
| `PostToolUseFailure` | the above plus `error` (`code`, `message`, `retryable`) |
| `Stop` | `stop_hook_active` |
| `StopFailure` | `error_type`, `error_message` |
| `SessionHeartbeat` | `uptime_ms` |

The common four on every event are `hook_event_name`, `session_id`, `cwd` and
`client_type`.

**`SessionEnd` never fired.** It is in the enum and was wired in every capture run;
prompt mode exits without it. The handoff therefore has to be written while the session
is still working.

## SessionHeartbeat

Observed at `uptime_ms` 60002, 120004 and 180006 — a fixed 60s cadence, independent of
whether the session is doing anything. No other adapter has this: the other three reach
a hook only when the user takes a turn, so an idle session's presence goes stale while
its process is alive. This is what `lifecycle.heartbeat` records.

## The deny contract

Five candidate replies were run against a real session, and only two stopped the tool:

| Reply | Denied? |
|---|---|
| exit code 2 | yes |
| `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}` | yes |
| exit code 1 | no |
| `{"decision":"block","reason":"..."}` | no |
| `{"permission":"deny","reason":"..."}` | no |

ACC uses the structured reply because the reason survives it: the denied call reaches the
model as a failure whose `error.message` is ACC's text. A denied call raises
`PostToolUseFailure`, not `PostToolUse`, so the two are distinguishable.

## Tool vocabulary and the matcher

Read out of a real request rather than assumed from the family resemblance: this client
offers `Agent`, `AgentSwarm`, `AskUserQuestion`, `Bash`, `Edit`, `Glob`, `Grep`, `Read`,
`Skill`, `Write` and others. Its editor is `Write`/`Edit`, not Codex's `apply_patch`.

The matcher was proved to select, in both directions: `Write|Edit|Bash` fired twice in one
turn and blocked the write, while `NoSuchTool` never fired and the write ran.

## Context injection

Works, and was observed on the wire reaching the model. Unlike Claude Code, this client
does **not** unwrap `additionalContext` — it wraps a hook's entire stdout in
`<hook_result hook_event="UserPromptSubmit">` and shows the model whatever that was.
Emitting Claude Code's JSON envelope here puts the envelope itself into the conversation,
so ACC injects plain text.

## Coordination, verified against the real client

The strongest check here is not a fixture. A peer session claimed a file, the real
client tried to write it through ACC's real hooks and real runtime, and then the claim
was released and the same run repeated:

```text
peer claims file:hello.txt (guarded)
kimi -p "Create hello.txt with the word hello"   ->  refused by ACC
peer releases the claim
kimi -p "Create hello.txt with the word hello"   ->  written
```

The contrast is the point. A guard observed only denying proves as little as one observed
only allowing; either alone is consistent with a guard that is simply stuck.

One operational consequence falls out of it. Because `SessionEnd` never fires, each
`kimi -p` run leaves an attached session behind, and two runs show up as two live
participants:

```text
models   harness=cli    presence=online
kimi     harness=kimi   presence=online
kimi     harness=kimi   presence=online
```

They are not leaked: presence is derived from the declared 60s cadence, so a finished
session stops beating and ages out to stale and then offline on its own. But a peer
reading the roster within that window sees sessions that have already exited. Interactive
sessions, which live long enough to heartbeat, do not have this problem.

## End-to-end verification

The adapter was not only unit-tested. ACC's own `installKimiPlugin` wrote into an isolated
`KIMI_CODE_HOME`, and a real session then ran against that installation, with a runner
that called this package's real `normalizeKimiHook` and real `denyResponse`:

```text
{"kind":"sessionStart","ok":true,"normalisedKind":"sessionStart","tool":null}
{"kind":"beforeTurn", "ok":true,"normalisedKind":"beforeTurn", "tool":null}
{"kind":"beforeTool", "ok":true,"normalisedKind":"beforeTool", "tool":"Write"}
{"kind":"beforeTool", "ok":true,"normalisedKind":"beforeTool", "tool":"Bash"}
{"kind":"turnEnd",    "ok":true,"normalisedKind":"turnEnd",    "tool":null}
```

The file was never written. `kimi doctor` accepted the config both before and after, and
`uninstallKimiPlugin` restored it byte for byte.

What that covers, which unit tests cannot: the block is valid TOML to this client's own
parser, the absolute command path is reachable from a hook's environment, the matcher
fires on the tools this client really names, and the deny reply is the shape it really
acts on.

`SessionHeartbeat` is absent from that log because the session finished inside a minute.

## How the guard capture was possible

The account's quota was exhausted, so no real turn could run — the same wall that left
the Gemini adapter unable to declare a guard. Here it was gone around instead: a local
provider served one canned turn, so the client itself really wrote a file and really ran
a shell command. Only the model was stubbed; every payload above came from the client.

The client speaks OpenAI chat completions with `stream: true` to a provider of
`type = "openai"`, imported through `kimi provider add <registry-url>`. Accepted provider
types are `openai`, `anthropic` and `kimi`.
