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

The shipped adapter therefore keeps `delivery.livePush` and `delivery.replyRoute` false.
`acc install --adapter claude_code --delivery actionable` (or `all`) reports the failed
capture, keeps the effective policy `off`, and installs no Channel MCP entry. The default
is also `off`. Messages remain durable for the certified 2.1.233 next-turn hook or for
explicit recovery through `acc inbox`; an unknown or uncertified version retains the inbox
path without being promoted to next-turn support. `acc doctor` reports the same boundary.

## Native Channel capture (2026-09-02)

The installed Claude Code `2.1.258` on `darwin-arm64` was started with the user's ordinary
`claude` command. A temporary shell bootstrap added only
`--dangerously-load-development-channels plugin:agents-can-communicate@acc-local`, and the
plugin's `.mcp.json` pointed at the disposable ACC Channel under `scripts/spikes/`. The
operator accepted the vendor's full-screen development-channel warning by hand; ACC neither
suppressed nor answered it.

Observed, from the Channel's redacted log and the operator's terminal:

- **idle** — a question written to the Channel at 21:16:07Z was presented without any human
  prompt; Claude called the explicit `acc_reply` tool at 21:16:39Z.
- **busy** — during a 37 s counting turn, a second question written at 21:18:45Z appeared as
  an inbound line at once, but Claude acted on it only after the turn completed
  (`acc_reply` at 21:19:21Z): `queued_after_turn`, matching the vendor's documented
  queueing of channel events until the next turn.
- **reply** — both replies were explicit tool calls bound to the exact message id; the
  model sees the tool as `mcp__plugin_agents-can-communicate_acc-channel__acc_reply`.
- **duplicate** — the same id resent was answered `duplicate: true` with no second
  notification and no second reply.
- **fallback** — after the Channel child was terminated (21:19:45Z) a native attempt failed
  with `transport_unavailable`, and a durable ACC question recorded at 21:20:11Z stayed
  `queued` on the durable transport.

Facts that shape the adapter:

- Claude Code reads plugin components, including `.mcp.json`, from the marketplace source
  copy (`plugins/marketplaces/<marketplace>/<plugin>/`), not from the plugin cache alone;
  `claude plugin details` reports `MCP servers (0)` until the source copy carries the file.
- The Channel is a stdio MCP server declaring `experimental: { "claude/channel": {} }` and
  `tools: {}`; the model receives
  `<channel source="plugin:agents-can-communicate:acc-channel" message_id="…" kind="…">`;
  meta keys must be identifier characters.
- The endpoint's Unix socket path must stay under 104 bytes (macOS `sun_path`).
- Minimum: the research lower bound is `2.1.80`, where Channels first appeared; the shipped
  minimum is this first passing capture, `2.1.258`, until an older release is captured.
- Still experimental: the development-channel flag and its warning are vendor-owned and
  visible; no official allowlist path exists for ACC yet.
- Not captured: `darwin-x64`, Linux, Windows, and the durable ACC answer record (the spike's
  `acc_reply` routes to the channel; the production adapter must route it through ACC's
  conversation service and prove that in a process test).

`certification.json` now carries passing `delivery.livePush` and `delivery.replyRoute`
evidence for 2.1.258 next to the retained 2.1.252 failure. The adapter's declared
capabilities stay `false` until the production Channel ships, so `effectiveCapabilities()`
still reports no live delivery.

## Release capture on the installed tarball (2026-09-04, 2.1.260)

The spike above proved the protocol. This one proves the product: the packed artifact
installed into the real home, two ordinary `claude` sessions in one workspace, no wrapper
and no hand injection. The first attempt ran on 2.1.259 and is what exposed the Channel
ownership defect; the client updated itself to 2.1.260 before the verification run, so the
version recorded here is the one the delivery events actually carry, not the one the run
started out as. It is passing evidence beside 2.1.258 and deliberately **not** a
second anchor - an anchor is the minimum's proof, and the whole point of a contract with no
maximum is that a newer stable client is admitted by probe and handshake rather than by
another capture. This is the run that exercised that rule.

- **idle** — `offered` over `claude-channel` to a session sitting at its prompt; the peer's
  question was answered with no human turn in between.
- **reply** — `routed`, and this time all the way through: the answer is a real ACC record
  whose `clientMessageId` is `channel-reply-<message id>`, which is the Channel's own
  `acc_reply` route rather than the CLI. The spike could not show this.
- **duplicate** — `same_message_id`. The repeated send returned the same message id and
  took the durable path, so the Channel was never asked to notify twice, and exactly one
  answer came back.
- **busy** — `queued_after_turn`, watched on the terminal: a 400-number counting turn ran to
  completion, and only then did the inbound line appear and get answered. The session said
  so itself before replying.
- **fallback** — `queued`. With the receiving Channel process killed, the next message was
  recorded and queued on the durable transport with `recipient_unavailable`.

Two behaviours worth knowing, both measured here rather than assumed:

- A `note` to an `actionable` install is **not** pushed: it comes back
  `queued`/`delivery_disabled`, because nothing about it needs acting on. Only messages
  carrying an obligation take the live path.
- A recipient whose presence has gone `stale` is still reachable natively. Presence and
  delivery are separate facts, and an idle session that has not taken a turn recently is
  not thereby unaddressable.

This capture is also the verification of the Channel ownership fix: before it, a second
session in the same workspace made both Channels register under the first client's pid.
