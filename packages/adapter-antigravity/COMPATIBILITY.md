# Antigravity CLI compatibility

Investigation notes for issue #174, and the evidence this package's adapter rests on. Every
line below is either observed on a live install or labelled as not observed.

Three capabilities are certified from these captures - `lifecycle.sessionStart`,
`context.beforeTurnInjection` and `delivery.nextTurn`. Everything else in the fourteen-entry
capability shape is false, and most of it is false because the event it would need does not
exist on this client rather than because nobody tried.

Capture host: macOS arm64, Antigravity CLI **1.2.7**, installed from the official installer to
`~/.local/bin/agy` (189,658,880 bytes). Model served during the capture: `gemini-3.8-flash-high`.
Observed 2026-09-20.

## Hook configuration

### Schema

Hooks are namespaced by integration at the top level, then by event. This is the only shape
that loads:

```json
{
  "acc": {
    "SessionStart": [{ "type": "command", "command": "…", "timeout": 10 }]
  }
}
```

The Gemini CLI shape — a flat event map whose entries carry `matcher` and a nested `hooks`
array — is **silently ignored**. So is a config wrapped in a top-level `hooks` key. Nothing is
logged and no error is produced; `/hooks` simply reports an empty list. ACC writes exactly this
Gemini shape into `~/.gemini/settings.json` for its Gemini CLI extension, so an ACC install that
is carried into Antigravity registers nothing.

### Locations

| Path | Loads |
|---|---|
| `~/.gemini/config/hooks.json` | yes, always |
| `<workspace>/.agents/hooks.json` | yes, **only when that directory is an open workspace** |
| `<workspace>/.agent/hooks.json` | no |

A workspace-local config is not picked up merely because the process runs with that directory as
its working directory. In print mode it loaded only when the directory was passed with
`--add-dir`. An adapter that writes `.agents/hooks.json` into a project must therefore also make
sure the project is opened as a workspace, or fall back to the global config.

### Reading a registration back

`agy -p "/hooks" --output-format json` answers without starting a turn or spending quota, and
its `command.data` is the effective hook list:

```json
{ "hooks": [ { "name": "acc", "enabled": true,
  "source": "<workspace>/.agents/hooks.json",
  "actions": [ { "event": "SessionStart", "type": "command",
    "command": "sh \"<path>/acc-hook.sh\" SessionStart", "timeout_seconds": 10 } ] } ] }
```

The namespace key becomes `name`; `source` names the file it was loaded from; `timeout` is
read back as `timeout_seconds`. This is the only thing on the machine that can tell a working
registration from an inert one, which is why install and doctor both read it rather than
trusting the file they wrote. Six answers were captured, and four of them are failures that
look identical on disk to a success:

| What was written | Effective hook list | Fixture |
|---|---|---|
| Nothing at all | `[]` | `fixtures/hooks-readback-empty-1.2.7.json` |
| The namespaced shape, three supported events | all three, with `source` | `fixtures/hooks-readback-registered-1.2.7.json` |
| The namespaced shape, plus `SessionEnd` and `PreToolUse` | **only the supported event** | `fixtures/hooks-readback-dropped-1.2.7.json` |
| The Gemini CLI shape ACC writes today | `[]` | `fixtures/hooks-readback-gemini-shape-1.2.7.json` |
| A valid namespace **plus one extra top-level key** | `[]` | `fixtures/hooks-readback-foreign-key-1.2.7.json` |
| The same namespace name in both locations | **only the global one, whole** | `fixtures/hooks-readback-namespace-collision-1.2.7.json` |

Three of those are new findings, and each one changed the adapter:

- **One unrecognised top-level key drops the whole file.** Every top-level key is read as an
  integration namespace, and a key whose value is not an event map takes every valid namespace
  in the file down with it. The marker the Gemini CLI adapter writes into `settings.json` -
  `"acc:createdFile": true` - registered *nothing at all* here, valid `acc` namespace included.
  So this adapter records "ACC created this file" beside its shim rather than inside the
  client's file, and writes nothing into that file but namespaces.
- **An unsupported event is dropped per action, not per file.** A namespace carrying
  `SessionStart`, `SessionEnd` and `PreToolUse` loads, with only `SessionStart` in it. A
  partially registered install is therefore indistinguishable from a complete one without the
  read-back.
- **Two locations with the same namespace name do not merge.** Global and workspace configs
  merge when their namespaces differ - each appears separately with its own `source`. Give both
  the name `acc` and only the global one survives; the workspace one is discarded entirely,
  including the events the global one does not carry. A machine can therefore hold a correct
  workspace registration that never runs.

The adapter's own configuration was round-tripped against the live client on 2026-09-20:
`installAntigravity` wrote a workspace registration, real `agy -p "/hooks" --output-format
json` reported `SessionStart, PreInvocation, Stop` with that file as its `source`,
`doctorAntigravity` read the same back, and after `uninstallAntigravity` the client reported
an empty list. The probe, the parse and the removal are the real ones; only the model was
never asked for a turn.

A command quoted for a path containing a space - `sh "<dir with space>/probe.sh" SessionStart` -
loads and is read back verbatim. Whether it *executes* correctly with a space in the path was
not captured; that needs a real turn.

### Where ACC registers

**Global, `~/.gemini/config/hooks.json`** — decided in issue #178. It is the location that
always loads, and it is where ACC already registers for every other client that keeps hooks in
the user's home. A workspace registration is available with `ACC_ANTIGRAVITY_HOOKS=workspace`;
it is not the default because a workspace file in a folder nobody opened as a workspace
registers nothing and reports nothing, and a default that silently does nothing is worse than
one that is broader than a given project needs.

A value that is neither is refused by name and that client is skipped, rather than being
replaced by the default. An operator who asked for `workspace` and got the machine-wide file
would have no way of finding out except by reading the file.

| | Global `~/.gemini/config/hooks.json` | Workspace `<project>/.agents/hooks.json` |
|---|---|---|
| Loads | always | only while that project is an open workspace |
| Scope | every Antigravity session on the machine, in any directory | one project |
| Fails as | ACC hooks run in projects that never asked for them | registers nothing, silently, with a file that looks correct |
| Uninstall | one file | one file per project ever installed into |

The namespace collision above bears on this: if both are ever written with the name `acc`, the
global one wins and the workspace one is discarded whole. The two cannot be combined as a
belt-and-braces install.

### Supported events

Each event was registered alone, and then together, and the effective set read back from
`agy -p "/hooks" --output-format json`, which answers without starting a turn or spending quota.

| Event | Loads | Fired in the capture |
|---|---|---|
| `SessionStart` | yes | yes, once |
| `PreInvocation` | yes | yes, once per invocation |
| `PostInvocation` | yes | yes, once per invocation |
| `Stop` | yes | yes, once per execution |
| `SessionEnd` | **no** | — |
| `PreToolUse` | **no** | — |
| `PostToolUse` | **no** | — |
| `Notification` | **no** | — |
| `turn-completion` | **no** | — |
| `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool` (Gemini CLI names) | **no** | — |

`PreToolUse` was also tried with `matcher` inside the action, with `matcher` as a nested key, and
with a `tool` field. None loaded. `turn-completion` does not appear anywhere in the 1.2.7 binary,
as an exact string or a substring.

Consequences for ACC:

- **No tool guard.** There is no `guards.beforeWrite` equivalent. A claim cannot be enforced at
  write time on this client the way it is on Gemini CLI.
- **No session end.** Participant deregistration cannot ride on a lifecycle event; it has to come
  from the user, or be inferred. What this adapter does about it: nothing automatic, and it says
  so. `lifecycle.sessionEnd` is false, which makes the session's lifecycle `manual` in its own
  participant record, so a session here goes offline by presence age or by an explicit
  `acc finish`. A session can linger in the roster after its client has exited. That is a stated
  limitation rather than a quiet one - inferring an end from `Stop` would retire a session that
  is merely between turns, and `fullyIdle` says nothing about whether the process is still alive.

## Payload envelope

There is no `hook_event_name` field. The event is known only from how the command was invoked, so
the adapter must pass it as an argument.

Common to every event: `conversationId`, `modelName`, `transcriptPath`, `artifactDirectoryPath`,
`workspacePaths` (array).

- `PreInvocation` and `PostInvocation` add `invocationNum` and `initialNumSteps`. The two events
  carry byte-identical envelopes for the same invocation; they are not distinguishable from the
  payload alone.
- `Stop` adds `executionNum`, `terminationReason` (observed: `NO_TOOL_CALL`), `error`, and
  `fullyIdle` (observed: `true`). `fullyIdle` is the only idle/busy signal any event carries.

Fixtures: `fixtures/SessionStart-1.2.7.json`, `PreInvocation-1.2.7.json`,
`PostInvocation-1.2.7.json`, `Stop-1.2.7.json`, `Stop-continued-1.2.7.json`. Transcript,
artifact directory, workspace paths and conversation id are redacted; every other field is
verbatim.

## Delivery

### PreInvocation injection — observed

Returning

```json
{ "injectSteps": [ { "ephemeralMessage": "…token…" } ] }
```

placed the text where the model read it: the model reproduced the probe token in its reply. This
is before-turn injection, equivalent in authority to the Gemini CLI `additionalContext` path.

`userMessage` and `toolCall` also appear as strings in the binary but were not exercised.

### Stop continuation — observed

Returning

```json
{ "decision": "continue", "reason": "…text…" }
```

from `Stop` did not end the turn. A second invocation ran, and the model reproduced the token
carried in `reason`, so the reason reaches the model as prompt text.

**It is a bounded nudge, not a gate.** The vendor changelog for 1.1.9 records a fix for "stop
hooks that always block hanging the agent forever; after a configurable number of consecutive
continuations, the hook can no longer block and the turn ends normally". An adapter must impose
its own ceiling and fail open, and must not present a blocked turn as a guarantee that a peer
will be answered.

This adapter's ceiling is **one continuation per turn**, counted from the `executionNum` the
client itself supplies - `Stop-1.2.7.json` carries `0` and `Stop-continued-1.2.7.json` carries
`1`, so the counter is the client's rather than state ACC would have to keep between two
short-lived hook processes. `stopResponse` returns `{}` - which permits shutdown - for every
input that is not a non-empty reason below that ceiling, so a hook error, an expired budget and
an unreachable store all end in a turn that finishes normally. Nothing in the sender-facing
story says a peer will answer because a receiver's turn was continued.

### Live push — not observed

`agy agentapi` exists as a hidden subcommand — it is absent from `agy --help` — exposing
`get-conversation-metadata`, `new-conversation` and `send-message <recipient_id> <content>`. No
`agentapi` binary exists on disk under `~/.gemini/antigravity-cli/bin/`, which holds only
`webm_encoder`; a separate wrapper script at that path has been reported elsewhere and is not
present on this install. Whether `send-message` wakes an idle session has not been captured.
`delivery.livePush` stays false.

### Reply routing — not observed

`delivery.replyRoute` stays false.

## MCP registration

`agy mcp add|remove|list|enable|disable` manages the user-level `mcp_config.json` and has existed
since 1.1.16. An adapter should use it rather than writing the file.

Two paths exist and both were present on the capture host with `{"mcpServers": {}}`:
`~/.gemini/config/mcp_config.json` is current, `~/.gemini/antigravity/mcp_config.json` is the
legacy location. The 1.0.3 changelog entry describes the migration between them, so a leftover
legacy file is expected rather than a sign of a second active configuration. Detection must not
infer the install from either path.

## Plugin import

On first authenticated run, AGY copied the ACC Gemini CLI extension from `~/.gemini/extensions/`
into `~/.gemini/antigravity-cli/plugins/agents-can-communicate/`, byte for byte, and generated a
`plugin.json` carrying only name, version and description. `agy plugin list` still reports "No
imported plugins" and `agy mcp list` reports "No MCP servers configured".

So a machine can hold a complete copy of the ACC integration while ACC is invisible to the
client: the files are there, the hook names are Gemini CLI's, and nothing is registered. Any
report that ACC "is already present" on an Antigravity install has to be checked against
`agy plugin list`, `agy mcp list` and `agy -p "/hooks"`, not against the presence of files.

## Version floors to consider

From the vendor changelog, not from capture:

- **1.1.10** — hooks began running before the built-in termination checks, "which lets `Stop`
  hooks run at all instead of sitting unreachable behind the built-ins".
- **1.2.4** — fixed `hooks.json` being "silently dropped when customization token budget
  truncation is active".
- **1.1.16** — `agy mcp` subcommands.
- **1.1.1** — fixed workspace `.agents/hooks.json` not loading after trusting a folder.

## Not observed

- Any behaviour on Linux or Windows.
- `userMessage` and `toolCall` injection types.
- Whether `agentapi send-message` reaches an idle session.
- Reply routing back to ACC.
- The continuation ceiling's actual value, and what the model is told when it is reached.
- Interactive-session behaviour. Everything above was captured in print mode.
- Whether a hook command whose path contains a space *runs*; it registers and reads back
  verbatim, but no turn was spent on executing one.
- Which of two same-named namespaces wins on load order rather than on location: the one capture
  had the global file winning, and a workspace-first ordering was not constructed.
- Whether a `PostInvocation` registration costs anything measurable. It is not registered,
  because its envelope is byte-identical to `PreInvocation`'s and there is nothing ACC would do
  there twice.
