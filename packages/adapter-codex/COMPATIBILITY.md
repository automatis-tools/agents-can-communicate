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

## Observed in a real session

Captured 2026-08-16 from `codex exec` on 0.147.0, run against an isolated `CODEX_HOME` so
the operator's own configuration was never touched. Fixtures are in `fixtures/`.

Fired and completed: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `SessionEnd`.

Payload shape, common to every event: `session_id`, `transcript_path`, `cwd`,
`hook_event_name`, `model`, `permission_mode`. `SessionStart` adds `source`;
`UserPromptSubmit` adds `turn_id` and `prompt`; `PreToolUse` adds `turn_id`, `tool_name`,
`tool_input`, `tool_use_id`; `Stop` adds `stop_hook_active` and `last_assistant_message`;
`SessionEnd` adds `reason` and omits `model` and `permission_mode`.

**`PreToolUse` genuinely blocks.** A hook exiting 2 with a reason on stderr produced

```text
error=Command blocked by PreToolUse hook: ACC: blocked by a resource claim held by
another session
hook: PreToolUse Blocked
```

and the model reported the reason back to the user in its own words. Verified for both a
shell command and a file edit; the edit never reached disk.

Three findings that change the adapter:

1. **Codex names its edit tool `apply_patch`**, not `Write` or `Edit`. A matcher borrowed
   from another harness's vocabulary would never have fired on a file edit, so the adapter
   would have reported edits as guarded while letting every one through.
2. **Hook commands must be absolute paths.** A relative `./scripts/x.sh` - which is what
   the bundled example plugins use - failed on every event with no output.
3. **Conversation content is handed to hooks directly**: `transcript_path` on every event,
   the raw `prompt` on `UserPromptSubmit`, `last_assistant_message` on `Stop`. Whitelist
   normalisation is what keeps it out of coordination state.

## Installation mechanics, observed

A marketplace is a directory whose manifest lives at
`<root>/.agents/plugins/marketplace.json`, with `plugins` as an **array** of
`{ name, source: { source: "local", path }, policy, category }`. It is registered with
`codex plugin marketplace add <dir>`, which writes `[marketplaces.<name>]` into
`$CODEX_HOME/config.toml`; a plugin is then installed with
`codex plugin add <plugin>@<marketplace>`, which records `[plugins."<p>@<m>"] enabled` and
copies the plugin into `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`.

`CODEX_HOME` relocates the whole configuration root, which is what made this capture
possible without touching the operator's install.

## Open risks

1. **Context injection is unverified.** The event names are settled (above), but
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
The payload gap is now closed by capture. Declared true: `lifecycle.sessionStart`,
`lifecycle.sessionEnd`, `guards.beforeWrite`, `guards.beforeShell`, `delivery.polling`.
Still false and why: context injection unobserved, child sessions unobserved (no subagent
ran during the capture), wake and execution not offered by this harness.

## Certification findings (2026-08-16)

Running the cross-vendor scenario against a real 0.147.0 client turned up three things
that unit tests could not, because all three concern what the *client* does with what ACC
writes.

### Placing files is not installing

The install used to write a marketplace file and stop. That is not enough, and worse, the
file was in a shape this client rejects:

```text
Error: invalid marketplace file .../marketplace.json:
  invalid type: map, expected a sequence at line 3 column 13
```

`plugins` is a **sequence**, and each entry carries its own `name`, `source`
(`{source: "local", path}`), `policy` and `category`. `authentication` accepts only
`ON_INSTALL` or `ON_USE` - anything else fails validation. Because a rejected file fails
to load *entirely*, an ACC install into the user's own marketplace would have taken every
plugin they had with it.

ACC's ownership marker used to be written as an extra key beside the plugins, which in a
sequence becomes a nameless entry the client tries to load. Ownership is now the entry's
own name.

Four things must all be true before a single hook runs:

1. the plugin directory exists;
2. it is published in a marketplace file the client can parse;
3. `[marketplaces.acc-local]` and `[plugins."agents-can-communicate@acc-local"]` are
   registered in the client's `config.toml`;
4. the client has **installed** it - `codex plugin add agents-can-communicate@acc-local` -
   which copies it into `$CODEX_HOME/plugins/cache/`.

ACC does all four. Step 4 looked like the client's own business until it was measured:
diffing `$CODEX_HOME` around `codex plugin add` shows the command does exactly one thing -
copy the plugin into `plugins/cache/<marketplace>/<plugin>/<version>/`. Nothing else
changes, not `config.toml` and nothing under `HOME`, and all three path components are
ACC's own: the marketplace it created, the plugin name it chose, and the version in the
manifest it ships.

So ACC writes that copy itself, and a real session against an ACC-written cache fires
every hook. `detect` still names `codex plugin add` for the case where the cache is
missing - someone cleared it, or the client moved where it keeps one - because then the
supported command is the right answer.

Hook trust remains a manual step. That one is the client's security model, not a gap.

Because the client runs the *cached copy*, a hook command relative to the bundle would not
survive installation. ACC's shim is written with absolute paths, so it does.

A marketplace already registered by hand makes ACC's block a duplicate table, which this
client refuses to load. Install now refuses with a conflict instead of writing it.

### Write guards depend on the model, not on ACC

In the observed configuration the client offered `exec_command`, `write_stdin`,
`update_plan`, `request_user_input`, `view_image`, `multi_agent_v1`, the goal tools and
`web_search` - **no `apply_patch`**. Whether `apply_patch` is offered is a property of the
model's metadata (`apply_patch_tool_type`), not a user setting.

With such a model, an edit runs through `exec_command`, which reaches hooks as
`tool_name: "Bash"` with a `command` string. A command names no resource, so a write guard
has nothing to compare against a claim. `guards.beforeWrite` stays true - it was observed
denying a real `apply_patch` edit - but it protects only models that use that tool.

### Tool names are normalised for hooks

The model calls `exec_command`; the hook receives `tool_name: "Bash"`. The adapter's
matcher already covers `Bash`, but the two vocabularies are not the same list, and the one
that matters for a matcher is the one hooks see.

### The lifecycle is clean

Unlike Kimi Code, this client fires `SessionEnd`. Observed across a full run: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `Stop`, `SessionEnd` - and afterwards ACC's runtime state
held no session record and no binding. Nothing is left to age out.


## Context injection, finally observed

Declared false for a long time with the honest reason "never seen reaching the model".
It has now been seen. A `UserPromptSubmit` hook's stdout arrives in the request as a
**`developer` role message**, verbatim and unwrapped:

```json
{"type":"message","role":"developer","content":[{"type":"input_text","text":"…"}]}
```

No envelope of any kind, so the injection is plain text - Claude Code's JSON envelope
would put the envelope itself into the conversation, exactly as it would on Kimi Code.

The `developer` role is the most direct channel of the four, which is a reason for care
rather than comfort: at that role a model reads text as instruction, so anything a peer
wrote has to stay framed as data. The shared projector does that framing.

This matters most where the guard cannot help. With a model that has no `apply_patch`,
edits run through the shell and no claim can be matched against them. ACC cannot stop that
write, so it says so before the turn instead:

```text
2 session(s); cursor 0000000000000004
- [claim] file:src/** held by models - file edits are blocked; edits made through a shell are not
- session_9Xo… (cli, online)
- session_BlU… (codex, online)
```

Captured from a real session: the peer held the claim, and the Codex model was told before
it started. Unenforceable is not the same as unknown.
