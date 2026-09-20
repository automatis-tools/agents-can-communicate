# Antigravity CLI compatibility

Investigation notes for issue #174. Nothing here is certified yet: no adapter ships from this
package. Every line below is either observed on a live install or labelled as not observed.

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
  from the user, or be inferred.

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
