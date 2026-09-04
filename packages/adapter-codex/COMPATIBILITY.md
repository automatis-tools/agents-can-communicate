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

1. **Hooks require persisted user trust.** The client exposes
   `--dangerously-bypass-hook-trust`, and the docs say "Review and trust plugin hooks
   before you enable them". Installation therefore cannot be silent: `acc install` can
   place the plugin, but the user must trust its hooks before any of them run, and
   `acc doctor` has to report the untrusted state rather than implying protection.
2. **Distribution is marketplace-based.** `codex plugin add` installs from a configured
   marketplace snapshot; the personal marketplace lives at
   `~/.agents/plugins/marketplace.json`. A file drop into a plugins directory is not the
   supported installation path.

## What this adapter declares

Session-start and session-end hooks exist, so lifecycle holds; the payload gap is closed by
capture. Certified true on 0.147.0 darwin-arm64: `lifecycle.sessionStart`,
`lifecycle.sessionEnd`, `context.beforeTurnInjection`, `guards.beforeWrite`, and
`delivery.nextTurn`. The shell denial was observed, but its `PreToolUse` payload was not
retained — the shipped Bash JSON is an allowed `PostToolUse` event — so it cannot satisfy
the package-local evidence gate and `guards.beforeShell` is now false. Child sessions remain
unobserved. Native `delivery.livePush` and `delivery.replyRoute` remain false after the
0.152.0 boundary capture.

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
- [claim] file:src/** held by models - file edits and recognised shell writes are blocked; a runtime can still get past
- session_9Xo… (cli, online)
- session_BlU… (codex, online)
```

Captured from a real session: the peer held the claim, and the Codex model was told before
it started. Unenforceable is not the same as unknown.

The note has three forms, because two separate facts decide it - what the claim's owner
asked for, and whether ACC can stop this particular session:

| Claim | This session | Note |
|---|---|---|
| guarded | can be guarded | `file edits and recognised shell writes are blocked; a runtime can still get past` |
| guarded | cannot be guarded | `not enforced for this session; do not edit it` |
| advisory | either | `advisory; nothing will stop you, the owner is asking` |

Reading only the session's capability would announce a block on an advisory claim that
will never happen - and its owner explicitly did not ask for one.

## Native delivery boundary (2026-09-01)

The installed `codex-cli 0.152.0` experimental app-server schema includes the proposed
`turn/start` shape: empty `input`, `clientUserMessageId`, `turnTrigger`, and a standalone
`toolOutput` with `name`, optional `namespace`, and string `output` are accepted by the
generated schema.

The real-client capture is nevertheless `fail`. `codex app-server daemon version`
reported that `~/.codex/app-server-control/app-server-control.sock` did not exist. The
spike did not start, bootstrap, or restart the daemon, did not start a target client, and
did not run the proxy without that socket. Native idle delivery, busy non-interruption,
reply routing, duplicate retry, and durable fallback are all unobserved. No native
delivery capability is certified by this evidence. The redacted capture is under
`fixtures/delivery/`.

Consequently `acc install --adapter codex --delivery actionable|all` keeps the effective
policy `off` and names this exact limitation. Only `codex-cli 0.147.0` on
`darwin-arm64` retains its separately captured next-turn hook capability. `0.152.0` and
unknown or uncertified versions retain the durable `acc inbox` recovery path; ACC does
not start a daemon or target client to make native delivery appear available.

## Native queue capture (2026-09-02)

The installed `codex-cli 0.152.1` on `darwin-arm64` was started with the user's ordinary
`codex` command plus the vendor's own `--remote unix://` attachment to the local App Server
daemon. No daemon existed beforehand: `codex app-server daemon start` created it for this
capture and `codex app-server daemon stop` removed it afterwards; ACC recorded that it was
ACC-created. The daemon's control socket answers an HTTP upgrade and then speaks JSON-RPC
one message per WebSocket text frame; a newline-framed line gets no answer.

Observed, from the probe's closed result lines and from ACC's own records:

- **idle** — with the thread `idle`, `thread/queue/add` (21:26:37Z) was accepted as a
  queued submission; the thread started a turn by itself, and 19 s later an ACC answer
  addressed to the asking session existed with `inReplyTo` set to the queued message id.
- **busy** — with the thread `active` on a 40-line counting turn, a second submission
  (21:31:05Z) was accepted and stayed in `thread/queue/list` until the count reached 40;
  it was then presented as a user prompt and answered (ACC answer at 21:31:31Z):
  `queued_after_turn`.
- **reply** — both replies were `acc reply` calls made by the model through the ACC skill,
  producing real ACC answer records. That proves the product loop, not a native reply
  route, so `delivery.replyRoute` stays uncertified for Codex.
- **duplicate** — retrying the busy submission while it was still queued returned the same
  `queuedSubmissionId` (the probe checks `thread/queue/list` first). Retrying the idle id
  after its submission had been consumed created a second submission and a short turn, but
  the model recognised the id and no second ACC answer was recorded: native idempotency
  holds only while a submission is queued.
- **fallback** — after `daemon stop`, the probe reported `transport_unavailable` at
  `initialize`, and a durable ACC question recorded at 21:32:19Z kept a `queued` receipt.

Facts that shape the adapter:

- exact thread discovery: `thread/loaded/list` names the live threads; `thread/list` with
  `{ cwd: "<absolute path>", limit, useStateDbOnly: true }` answers in milliseconds and
  filters exactly, while the default listing reads rollouts from disk (2.7 s for 20);
- `thread/queue/add` takes `{ threadId, input: [{ type: "text", text }], clientUserMessageId }`
  and answers `{ queuedSubmission: { id, clientUserMessageId, input } }`;
- an unknown method is answered as `-32600 "Invalid request: unknown variant"`, an unloaded
  thread as `-32603 "no rollout found"`;
- the initialize `userAgent` is `<client>/<appServerVersion> (...)`;
- minimum: this first passing capture, `0.152.1`; the 0.152.0 failure is retained;
- not captured: `darwin-x64`, Linux, Windows, and a pre-existing daemon.

`certification.json` carried passing `delivery.livePush` evidence for 0.152.1 for one day.
It was superseded by the failure capture recorded in the withdrawal below, and the passing
capture stays in the repository as history rather than being rewritten.

## Native queue adapter (2026-09-02) - withdrawn the next day

For one day the shipped adapter declared `delivery.livePush` true behind the native
contract `codex-app-server-thread-queue-v1`, minimum `0.152.1` on `darwin-arm64`. The
section after this one records why that stopped. What follows describes the transport as
it was built, and it still works; what it cannot do is tell ACC where the session is.
`delivery.replyRoute` stays false: Codex answers ACC through the existing `acc reply`
CLI, not a native callback, and the adapter exposes no `routeReply`.

The transport is JSON-RPC over WebSocket on the daemon's control Unix socket
(`~/.codex/app-server-control/app-server-control.sock`); a newline-framed line gets no
answer. `probeNativeDelivery` initializes and confirms `thread/queue/list` exists;
`bindNativeSession` uses the hook's Codex `session_id` as the thread id and verifies the
id and cwd; `offerMessage` re-verifies the thread and calls `thread/queue/add` with
`{ threadId, input: [{ type: "text", text }], clientUserMessageId }`, the ACC message id as
the stable `clientUserMessageId`, so a retry while the submission is still queued is the
same offer.

ACC never starts, restarts, supervises, or stops the daemon. Detection only reaches an
eligible verdict when a daemon already answered the probe, so the recorded
`native-service` mechanism is always `preExisting: true` with no apply or teardown command,
and uninstall leaves the vendor daemon in place. To use native Codex delivery, start the
daemon yourself (`codex app-server daemon start`) before `acc install`; the install detects
it and adds only the `--remote unix://` attachment to the ordinary `codex` command. With no
daemon the client stays durable/next-turn only.

## Native delivery withdrawn (2026-09-03)

The release capture ran the shipped adapter against a real client working in one project
while the daemon had been started in another. In `--remote` mode the session runs inside
the daemon, and **both** the hook payload's `cwd` and the App Server's own `thread/list`
reported the daemon's directory as the session's:

```
thread/list { useStateDbOnly: true, cwd: /path/B }   -> { data: [] }
thread/list { useStateDbOnly: true, cwd: /path/A }   -> { data: [ { id: …, cwd: /path/A } ] }
```

ACC registered the session in the daemon's workspace and injected that workspace's peers
into it. Nothing ACC can reach carries the real directory, so there is no honest way to
address such a session, and a session ACC cannot place must not be addressed.

So the capability is withdrawn: no `nativeDelivery` descriptor, `delivery.livePush` false,
and the probe and handshake answer `workspace_identity_unavailable`. This is recorded as
its own capture, `fixtures/delivery/codex-cli-0.152.1-remote-workspace.json`, beside the
passing one it supersedes. Withdrawing it also repaired ordinary Codex use: ACC no longer
adds `--remote`, so hooks fire with the correct `cwd` again. The earlier spike missed this
by starting the daemon in the session's own directory, where the two coincide. An upstream
issue was filed against the client.
