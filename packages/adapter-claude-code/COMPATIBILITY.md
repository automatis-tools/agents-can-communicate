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
evidence for 2.1.258 next to the retained 2.1.252 failure. At the time this was written
the adapter's declared capabilities were still `false`; the production Channel has since
shipped and both are declared true behind the native contract - see the release capture
below.

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

## CLI ownership observation — 2026-09-06

Claude Code 2.1.263 exported its own `CLAUDE_CODE_SESSION_ID` while retaining an inherited
`CODEX_THREAD_ID` from the launching Codex process. Neither ACC owner variable was set.
The process ancestry showed an intervening shell and the Claude process, but a PID is
not a per-session credential. This capture does not establish automatic CLI ownership.

CLI owner inference has been withdrawn: native IDs can be inherited by a different
client, and a public roster entry cannot provide its generation. Commands require an
explicit caller-owned pair; session-bound MCP identity is unchanged. Hook presence and
certified delivery capabilities do not imply shell commands have owner credentials.
The observation retained only a fixed session-ID allowlist and process metadata, not a
client transcript. No capability was promoted by this capture.

## Hook-provided CLI ownership, observed 2026-09-06

In a disposable non-Git workspace, the installed hook supplied its own
`--session`/`--generation` pair in the `UserPromptSubmit` context. The real client
loaded the installed skill and used that pair for intent, a file claim, inbox,
reply, and finish. No pair was placed in the task prompt or exported environment;
the agent did not manually attach or read runtime bindings. Durable messages had
the native hook session as author, the answered question became `acknowledged`,
and finish released its claim.

The run retained diagnostic metadata and ACC records, not raw conversation or tool
transcripts. A scripted peer seeded the initial request; Claude then left a question
which the real Codex session answered. These were sequential client turns, not an
idle wake or live injection test. Native delivery capabilities and certification
versions are unchanged. Unsupported next-turn bodies remain withheld with an inbox
recovery command; this observation proves use of the hook's own CLI arguments.

The CLI still refuses a caller lacking its own pair. Hooks never export credentials
that a nested client could inherit. In this earlier capture, solo turns without
pending coordination remained silent; the later startup-order correction below
supersedes that behavior. Very small context budgets can retain recovery without
the pair and report that limitation on stderr. The agent must have permission to
execute the CLI.

Observed client: Claude Code **2.1.263**, macOS arm64. The invocation loaded the
installed plugin through `--plugin-dir`; hook context used the documented
`hookSpecificOutput.additionalContext` envelope.

## Solo ownership and a late peer, 2026-09-06

A simultaneous stock-plugin review exposed a startup-order defect: the first
session began its turn alone, its hook omitted the owner header, and `inbox`
returned `caller_identity_unresolved` after the second client joined. A separate
installed-artifact reproduction showed that the next user prompt restored the
pair; a tool event during the original turn did not.

Turn hooks now supply their own complete CLI pair even while solo, with no peer
roster or instruction to coordinate. The same applies when only an own claim
remains. A budget too small for the pair yields empty context and an explicit
stderr diagnostic. Pending-message recovery and delivery receipts retain their
existing rules. This supersedes the earlier solo-silence observation above.

A fresh delayed-start check used real Claude Code 2.1.263 and Codex CLI 0.153.4 on
macOS arm64, both with stock installed plugins and delivery off. Claude began a
small code review alone; Codex was launched only after Claude's first tool result.
Codex implemented the temporary fixture and requested review. Claude retrieved
that request and answered APPROVED from its original native session; the request
became acknowledged and Codex retrieved the answer. There were exactly two native
participants, no manual attachment, no prompt-supplied owner arguments, no seeded
peer messages, and no operator relay or continuation prompt. The clients chose
inbox polling themselves. This observes in-turn CLI use, not idle wake or live push.

This real-client run installed a packed development artifact with SHA-256
`f6d183f13ef0e8cac15060e256335597ea602a3b97559ee54f7ba7fde42466a4`.
Its Claude/Codex hook and skill code matches this correction; the final candidate
also removes Kimi's extra raw-context newline and adds this evidence. Deterministic
packed tests cover the retained first-turn pair, actual inbox/reply author and
receipt, own-claim behavior, and exact context ceilings for Claude, Codex and Kimi.
Codex and Kimi now emit raw context without an extra trailing newline.

The non-Git fixture required Codex exec's normal `--skip-git-repo-check` option;
an initial harness launch omitted it and stopped before Codex started a session.
The successful retry used an empty runtime. Codex hooks were reviewed through the
native trust UI. Diagnostics retain bounded tool categories, final reports and
ACC facts, not raw transcripts. Capability flags and certification versions are
unchanged; this capture does not certify any new injection or guard capability.

The skill trigger was also checked in two real solo Claude runs with the same
ordinary request to read a package name/version. With the broad old description,
Claude unnecessarily loaded the ACC skill and then read the file. With the updated
condition, it only read the file and returned the same correct answer. Neither run
issued a coordination command. This is one observed before/after sample, not a
promise about every model turn.

## Interrupted review recovery, 2026-09-07

A controlled restart check used Claude Code 2.1.263 and Codex CLI 0.153.4 on
macOS arm64 with stock installed plugins, delivery off and a non-Git fixture.
Codex requested review. After Claude retrieved the request, the harness paused
that process, confirmed there was no reply, then resumed it and sent SIGINT.
Its close hook completed. A fresh Claude conversation used the same configured
public participant address, without the old transcript, message ID or owner pair.
It recovered the pending request through ACC, independently reviewed the files,
ran all eight fixture tests and sent APPROVE. The request became acknowledged;
the original Codex process retrieved the verdict and recorded a complete handoff.
All three sessions closed, no claims remained, and an old-owner inbox call was
rejected with exit 5.

This is one graceful interruption/recovery observation with a stable participant
address. The harness launched the successor; ACC did not restart a client. It
does not establish abrupt-crash recovery, idle wake, live push, or a new certified
capability. The successful run reused fixture code from an earlier attempt;
Codex verified it and added failure-path immutability coverage.

The first attempt ended before a request existed because the reviewer finished
waiting. A second reached the request but failed in the diagnostic controller's
non-atomic metadata read. Neither is a passing restart capture. The successful
retry used atomic metadata writes and a fresh runtime. Temporary Codex hook trust
and cache changes were removed; the original configuration matched byte-for-byte.

The installed development artifact was SHA-256
`84209b478b02e4d7a8943f939a958581b8b8791e3ff60d81cabdca101a690c68`.
Its 61 shipped modules across core, storage-filesystem, hook-runner, CLI and both
adapters matched the corrected sources byte-for-byte. The final archive has the
same SHA-256; this repository-only observation is excluded from npm packaging.
Separately, installed-package tests deliberately
schedule session replacement before inbox, acknowledgement, heartbeat and close
writes; those tests reproduce and guard the corrected races. The real-client
run is evidence for recovery, not evidence that those precise races occurred
naturally. No capability flag or certification version changed.

## Foreground review waiting, 2026-09-07

A delayed-start review on Claude Code 2.1.263 and Codex CLI 0.153.4, macOS arm64,
exposed a client-lifecycle limit after both native owner identities worked. Claude
started a background inbox poll, promised to return, then exited `-p` before the
request arrived. ACC retained the queued request; no review verdict existed.
General advice to keep waiting passed once and failed in a fresh repeat.

All five shipped skills now give a concrete recipe for a user-requested wait:
read inbox, perform a separate five-second foreground wait, then read inbox again.
Consume every result, avoid background polling, and leave a truthful partial
handoff if a deadline, client limit or blocker ends the wait. This matches the
[documented print-mode boundary](https://code.claude.com/docs/en/tools-reference#background-commands):
background commands end shortly after the final result; commands starting with
`sleep` do not auto-background. No client background-task setting was changed.

Two fresh non-Git fixtures installed the exact same archive, SHA-256
`aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2`.
In both, Claude loaded the installed skill, remained in its original turn through
short foreground waits, retrieved the late request and sent an approval verdict.
The original Codex author retrieved it and recorded a complete handoff. Both
processes exited naturally with code 0; both sessions closed and no claims or
native owner bindings remained. The fixture tests passed (eight and six cases).

The ordinary task prompts were unchanged from the failing baseline. Codex started
only after Claude's first tool result; neither prompt supplied owner arguments.
There was no seeded peer message, manual attachment, operator relay or continuation
prompt. Native Codex hook review preceded each run, and temporary trust/cache
changes were restored with an exact configuration digest match afterward.

These are two observed in-turn polling successes, not a guarantee of model
compliance or an idle-wake/restart capability. Delivery remained off. Other clients'
waiting behavior was not exercised; their skills carry the same portable guidance.
Capability flags, certification versions and runtime code are unchanged.

## Iterative review on unchanged ACC bytes, 2026-09-07

The foreground-wait archive above (SHA-256
`aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2`)
completed a further real Claude Code 2.1.263 / Codex CLI 0.153.4 review on macOS
arm64. A fresh non-Git fixture contained a deliberately defective normalizeTags
implementation and two passing tests. The author requested review before editing.
Claude independently reported input mutation, reordered output, last-spelling
retention and missing regression coverage, then remained available. Codex received
the findings, corrected the fixture and requested review again. Metadata records
successful Claude Read calls for both revised files after that request; the
implementation hash differs from the initial version and matches the final file.

The original reviewer sent APPROVED for the revised request, and the original
author retrieved that verdict before its complete handoff. Both processes exited
naturally with code 0, both sessions closed, and no claims or owner bindings
remained. All nine revised fixture tests passed; six failed with the original
implementation restored in a scratch copy. An independent specification check
failed before and passed after the fixture correction.

This is one two-round observation on the existing ACC implementation, not a new
ACC fix or capability certification. No model continuation prompt, seeded peer
message or operator relay was used. Delivery stayed off. Native Codex hook review
preceded the run; temporary trust/cache changes were restored exactly afterward.
Clarification was unnecessary in this fixture, so a clarification-question round
and different-checkout version selection remain unobserved by this capture.

## Continuation by a different client, 2026-09-07

The same installed archive, SHA-256
`aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2`,
completed one sequential Claude Code 2.1.263 → Codex CLI 0.153.4 continuation on
macOS arm64. In a fresh non-Git fixture, Claude implemented and tested a validation
helper, left aggregation unfinished, and recorded a partial room handoff before
exiting. The handoff preserved a product decision to clamp per-SKU totals to 17
and the rejected alternative of throwing on overflow. That value was absent from
the project files and the successor prompt.

A new Codex conversation started after Claude's process exited, with its own
native session and participant. No prior transcript, message id or owner pair
was supplied. After an empty inbox, public ACC sync returned the prior handoff id
before implementation edits. Codex retained the helper, implemented the carried
ceiling/clamping decision, passed 22 fixture tests and recorded its own complete
handoff. An independent specification check passed, while changing the ceiling
to 18 in a scratch copy failed it; the original nine helper tests still passed.

The old handoff remained unchanged. History recovery created no addressed receipt
for a participant that did not exist when that room handoff was recorded. Both
processes exited naturally with code 0; both sessions closed, with no remaining
claims or bindings. Temporary native Codex trust/cache changes were restored
exactly. Delivery was off, with no operator relay or continuation intervention.

This is one explicit handoff/continuation observation, not an abrupt crash,
provider-quota exhaustion or recovery of unsaved context. The harness opened the
successor; ACC did not restart a client. No runtime code or capability changed.
