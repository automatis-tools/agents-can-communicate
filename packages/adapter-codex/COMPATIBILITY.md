# Codex compatibility

## Explicit update maintenance (2026-09-10)

The separate update-maintenance ports were exercised with installed Codex CLI
0.154.0 on darwin-arm64 using the `pid` backend and a fresh private `CODEX_HOME`.
The adapter inspected the actual daemon, stopped it through `app-server daemon
stop`, proved process death, started it through the supported `start` command,
and verified the restarted server. A repeated start check returned the restored
instance without another lifecycle command. A detached worker also completed
start/restart/stop after its launcher exited. See the
[metadata capture](fixtures/maintenance/codex-cli-0.154.0-darwin-arm64.json).

CLI 0.154.0 successfully stopped a private 0.153.4 server and started the installed
0.154.0 executable. Neither `start` nor `restart` upgraded an older managed binary
automatically. Maintenance therefore requires matching installed CLI and managed
versions; ACC does not copy binaries, run bootstrap, or modify Codex configuration.
The captured modern executable path is `current/bin/codex`; the legacy
`current/codex` process alias is accepted only when it resolves to the same file.

Inspection verifies the vendor PID/start-time record against process metadata,
the captured executable invocation, ownership of the exact control socket, CLI
version output, and the live protocol handshake. Only loaded-thread IDs,
metadata-only `thread/read` with `includeTurns:false`, and pending queue counts
are used; persisted results contain identity fields and counts, never thread
content. Active work or queued input postpones stopping. Stop repeats inspection
against the approved identity, and unknown process death keeps maintenance open.
Unsupported platforms, backends, binary versions, and malformed metadata refuse
the operation. This does not broaden native delivery or hook capabilities.

No atomic drain or maintenance admission fence appeared in the generated 0.154.0
API schema or lifecycle help. Checks are observations, so they do not prove that
a new turn cannot begin between observation and stopping. Active-turn survival,
UI reconnection, other operating systems, and launchd were not captured. The real
user daemon was inspected read-only and remained running; every private daemon
and temporary home was cleaned up.

## Observed ACC 0.3.1 to 0.4 hook activation

On stock Codex 0.153.4, the 0.4 hook-command quoting change modified all five ACC hook
definitions from published 0.3.1. Codex required a fresh `/hooks` review; after the operator
reviewed/enabled the modified definitions, a subsequent restart retained all five active
without another prompt. This is activation evidence for that observed transition, not new
hook-event certification or a promise that arbitrary future upgrades preserve trust.
See the [recorded 0.4 candidate evidence](https://github.com/automatis-tools/agents-can-communicate/blob/main/docs/release-evidence/v0.4.0.md)
for its source and artifact provenance. The historical captures below remain unchanged.

## Current LocalDaemon delivery (2026-09-08)

The installed npm package was exercised against exact Codex CLI 0.152.1 and
0.153.4 on darwin-arm64, with an already-running daemon in A and an ordinary
receiver in B. The complete P01–P20 product matrices cover real generated hooks,
installed CLI sends, actual model marker commands and ACC inbox/reply operations.
Separate T01–T04 captures cover direct installed-adapter transport only.

| Exact client | Installed product evidence | Transport evidence |
|---|---|---|
| 0.152.1 | [Product](fixtures/delivery/codex-cli-0.152.1-local-daemon-current-binding-product.json) and [full matrix](fixtures/delivery/codex-cli-0.152.1-local-daemon-current-binding-product-evidence.json) | [Transport](fixtures/delivery/codex-cli-0.152.1-local-daemon-transport.json) |
| 0.153.4 | [Product](fixtures/delivery/codex-cli-0.153.4-local-daemon-current-binding-product.json) and [full matrix](fixtures/delivery/codex-cli-0.153.4-local-daemon-current-binding-product-evidence.json) | [Transport](fixtures/delivery/codex-cli-0.153.4-local-daemon-transport.json) |

These selected product captures were repeated after the router’s final current-binding
check was corrected. Earlier positive product captures and the original remote
workspace failure remain unchanged in hashed provenance history. The retirement
race itself is covered by separate deterministic router regression tests.

Native `delivery.livePush` uses the darwin-arm64 minimum 0.152.1, current feature
probe, recorded recipient consent, and exact thread, canonical cwd, live process,
stable version and protocol checks. Native delivery adds no client arguments and does not
start, restart or stop a vendor daemon. Unsupported platforms, older clients,
Embedded sessions, unavailable sockets and failed identity checks keep the durable
inbox. Ordinary hook capabilities remain limited to their exact 0.147.0 capture.

An expired 120-second lease can refresh on demand for the same current endpoint;
retirement or a changed generation cannot be revived. Refresh does not extend the
24-hour participant-presence limit. Private endpoint references are registered in
the receiver's ACC data home, so a sender's different CODEX_HOME cannot redirect
its offer. Hook and skill commands pin the installed ACC data home even when a
daemon predates opt-in and has no ACC environment variables.

Messages accepted while a turn is running wait for it to finish. An idle thread
can start an automatic turn and spend tokens. Closing the TUI can leave the thread
loaded: both tested versions executed an opted-in synthetic ACC question and
replied after terminal exit. A loaded resume may emit fresh UserPromptSubmit
without a new SessionStart. Actual archive and SessionEnd retire the binding;
terminal exit alone is not an opt-out. Delivery off or uninstall blocks new offers
but cannot withdraw a queue entry the vendor already accepted.

Codex can insert its own project-trust and other tables between ACC config
markers. Reinstall and uninstall preserve those foreign settings. Ambiguous
owned TOML or a closed inline parent namespace causes a conflict before install
writes; diagnostics identify the file and a structural reason. This bounded
preservation scan does not lock out concurrent Codex config edits.

The observed reply loop uses the installed `acc reply` CLI; native
`delivery.replyRoute` remains false. Pending queue entries deduplicate by ACC
message ID. Controlled acknowledgement loss after queue consumption produced two
actual executions on both versions: there is no exactly-once guarantee after
consumption. No additional lifecycle, guard, child-session or next-turn capability
is certified by these product captures.

The earlier September 3 workspace interpretation is corrected by actual `pwd`
measurements: a new explicit `--remote` thread without `--cd` really works in A,
the daemon's directory. Its hook and thread cwd are consistent with that execution.
Ordinary LocalDaemon launch from B preserves B. ACC therefore removes its old
launch rewrite and verifies the existing ordinary thread. The original failure
fixture and provenance bytes remain unchanged as hashed historical evidence.
Dated sections below describe their captures and former implementation, not the
current adapter contract.

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
   `acc doctor` must leave current readiness unverified rather than infer protection
   from installed files or saved trust records. See the onboarding observation below.
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
unobserved. Native `delivery.livePush` has the separate LocalDaemon contract and
installed-product evidence above; native `delivery.replyRoute` remains false.

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

## CLI ownership observation — 2026-09-06

Codex CLI 0.153.4 exported `CODEX_THREAD_ID`; neither ACC owner variable was set.
Its normal workspace-write shell sandbox refused the process-table probe with `EPERM`.
This capture does not establish automatic CLI ownership or plugin hook activation.

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

Observed client: Codex CLI **0.153.4**, macOS arm64. The native `/hooks` review
screen showed all five installed ACC hooks active after review. Enabling the
plugin alone had left them untrusted and skipped. The test used normal persisted
hook trust, without a hook-trust bypass; prompt context arrived as developer text.
Temporary candidate cache and trust changes were scoped to this verification.

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

## Onboarding and hook readiness — Codex 0.153.4, 2026-09-07

The real CLI's `app-server --stdio` and `hooks/list` inspected an ACC installation in
an isolated temporary home on macOS arm64. The installed artifact was the hook-deadline
candidate, SHA-256 `72c4ecfc0ed32f537c14fbbc8b2667c89f0f299c35e2dff3cff5ceccf64bbe58`.
Only ACC's five hook metadata records were retained; no model turn, hook execution or
raw conversation was collected. No running user daemon or user config was changed.

| Fixture configuration | Real client's metadata |
|---|---|
| No saved trust | Five untrusted hooks |
| One current hash | One trusted, four untrusted |
| Commented trust table | Five untrusted |
| Five stale hashes | Five modified |
| Five current hashes, guard disabled | Five trusted, guard enabled=false |
| Five current hashes, all enabled | Five trusted, all enabled |

The preceding ACC doctor suppressed its activation action for every saved or commented
trust substring above. It also called a plugin enabled based only on its config table
header. Detection now reports current hook readiness as unverified and directs the
operator to `/plugins` and `/hooks`. It does not start App Server or reproduce the
client's TOML/hash rules. The installed CLI now renders adapter activation steps and
the access check for a preserved user sandbox, without editing trust decisions.

The current [hook documentation](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks)
describes review of each exact definition. The correction preserves existing trust
records; it does not guarantee that they still apply after a definition changes. This
is configuration/metadata evidence, not new delivery, lifecycle or guard certification.
The interactive trust UI and a new live model turn were not exercised in this audit.

## Live review after native activation, 2026-09-07

The subsequent real-client check used Codex CLI 0.153.4 with Claude Code 2.1.263
on macOS arm64. The native `/hooks` UI reviewed all five current ACC definitions
before launching the author. The temporary plugin cache and hook trust records
were restored afterward; the original configuration matched byte-for-byte.

Two fresh non-Git fixtures installed the same archive, SHA-256
`aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2`.
Codex used the original hook-provided owner pair to publish intent, claim files,
request review and retrieve the original Claude reviewer's approval. It recorded
its complete handoff after verdict retrieval. Both processes exited naturally
with code 0, both sessions closed, and no claims or owner bindings remained.
The fixture tests passed (eight and six cases). All 200 installed archive files
in the repeat matched the source and tarball byte-for-byte.

The earlier baseline and one generic-guidance repeat failed because the Claude
reviewer exited after starting a background poll. The final skills specify
separate inbox reads and short foreground waits for an agreed review; the
[Claude observation](../adapter-claude-code/COMPATIBILITY.md#foreground-review-waiting-2026-09-07)
retains both failures and the first generic-guidance success. Task prompts and
client background settings were unchanged. This observes model turns and native
owner use after trust, extending the metadata-only onboarding audit above.
Delivery remained off; no capability or certification version was promoted.

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

## Continuation after abrupt client death, 2026-09-07

One real Claude Code 2.1.263 → fresh Codex CLI 0.153.4 run used the unchanged
`aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2` archive.
After implementing and testing a helper, Claude renewed two explicitly configured
180-second advisory file claims and recorded an unaddressed decision with the
remaining aggregation rule. The harness sent SIGKILL to that exact child process
immediately after its successful message result, before any finish. Its recorded
session stayed open, presence became offline, and both claims remained active.

The new Codex participant recovered the decision through public sync. An attempted
claim returned exit 5, identifying the crashed owner's resource and lease expiry.
Codex had been explicitly instructed to respect reservations and allow up to four
minutes for expiry. It acquired both files under its own identity after expiry,
completed the carried clamping rule, and recorded its own complete handoff.
The first observed file change followed acquisition. File hashes were sampled at
250 ms from shortly before expiry through successor exit; this does not exclude
transient changes between samples or before observation began.

Independent checks passed 22 final fixture tests, the original nine helper tests,
and a specification oracle. The successor exited naturally with code 0. Its claims
were released and session closed; the crashed session remained open/offline with
two expired claim records and its old hook binding. Active claims were zero. No
post-crash event used the old owner, and no force release occurred. The original
decision was unchanged; the completion addressed to the offline Claude participant
remained queued. Neither that receipt nor history retrieval proves model attention.

The ceiling value also appeared as an invalid helper input in a predecessor test;
this is not a clean number-absence experiment. The aggregation/clamping rule was
absent from the specification and predecessor implementation. No unsaved-context
recovery, real quota exhaustion, automatic restart, write-guard certification or
new capability is established. Delivery was off. The 180-second lease was a test
parameter; the default is 1800 seconds. Original Codex config/trust bytes were
restored and the temporary native cache removed.

## Authorized recovery and turns after finish, 2026-09-07

A real two-turn Codex CLI 0.153.4 app-server conversation exposed a lifecycle bug
on the preceding `aa947539f5e0ae4d9491775e3ad809c7a5279f615f6a5769fd468f69c4d37fc2`
archive. After recovering a crashed Claude decision, Codex encountered its two
unexpired default 1800-second claims, asked permission and recorded a partial finish.
That closed its ACC owner. The next user turn supplied scoped release approval, but
the hook could not heartbeat the closed record and projected no fresh owner arguments.
Claim, heartbeat and human-authority release failed; files and old claims were unchanged.

The hook runner now opens a fresh owner on a genuine turn after its exact completed
binding. Installed Claude/Codex regressions failed on the old code and pass on the fix.
Native lifecycle hooks serialize; the post-probe check also detects a replacement during
probing. This does not claim atomic exclusion of every later external CLI replacement.

The fixed archive, SHA-256
`170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05`,
was installed from clean commit `a0fc2a67bb597593a42d178c852d5356f89b2d74`.
Two distinct native app-server captures on macOS arm64 completed:

- Default-lease recovery: Claude Code 2.1.263 saved its helper and decision, then the
  harness killed that child. Fresh Codex recovered the decision through public sync,
  reported the offline holder, both files and about 27 minutes remaining, and asked
  permission without changing files or claims. In this replay it kept its ACC owner
  open. After one explicit approval in the same thread, it force-released only those
  two claims with human authority and a reason, acquired both files under its own
  owner, completed the implementation and recorded a complete handoff. The original
  eight tests, 26 final tests and an independent specification oracle passed. Changing
  the recovered ceiling from 23 to 24 failed the oracle. The value was absent from all
  predecessor project files and the successor prompt; the saved decision contained it.
- Direct lifecycle regression: a separate ephemeral conversation explicitly recorded
  a partial finish and waited. Its next user prompt received a new owner pair without
  another native SessionStart or client restart. That owner published work, claimed
  the fixture file, verified it and finished successfully. The participant and PID
  stayed the same, the captured prior closed-session fields and full handoff were
  unchanged, and no claims
  or hook bindings remained. No project files changed in this capture.

Both Codex processes exited naturally with code 0. The recovery capture retained the
crashed Claude session as open/offline and its old hook binding, with no claims. Its
completion receipt stayed queued for that offline participant. File hashes were sampled
at 250 ms from before thread creation through exit; the first observed recovery edit
followed both new acquisitions. This cannot exclude transient edits between samples.

Delivery was off; native hook trust was checked through Codex, and temporary cache and
all synthetic project trust changes were removed with exact original config restoration.
Prompts explicitly required claim respect; the direct regression explicitly requested
partial finish. These are bounded observations, not universal model compliance, actual
quota exhaustion, unsaved-context recovery, automatic restart or new capabilities.

## Review across distinct Git worktrees, 2026-09-07

One real Claude Code 2.1.263 reviewer and Codex CLI 0.153.4 author completed two
review rounds on the unchanged installed archive
`170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05`.
Both worktrees resolved to one ACC workspace; status retained their distinct
checkout roots and branches. The reviewer stayed at the correct baseline while
the author's proposal added an in-place sort that broke the specification.
The original fixture test passed in both checkouts; an independent oracle failed
only on the proposal.

The author requested review before its first observed edit. The reviewer retrieved
the request, ran Git inspection and returned four valid blocking findings against
that proposal. Initial provenance rests on the request's unique short SHA, Git diff
activity and proposal-specific findings; the collector did not capture a resolved
initial SHA or the proposed source returned to the reviewer.

Codex acquired both file claims, added regressions, removed the sort and committed
the correction. The same reviewer retrieved the second request and independently
resolved the author's full new SHA through Git before approving that exact revision.
The author retrieved and acknowledged the verdict before its complete handoff.
Independent verification passed all ten final fixture tests and the specification
oracle; restoring the original defective source in a scratch copy failed seven of
those tests and the oracle. The old single test still passed on both implementations.

Both clients exited naturally with code 0. Their sessions closed, with no claims
or hook bindings left. The final reviewer checkout was clean at its original commit;
its HEAD at tool results and three fixture-file hashes at 250 ms samples stayed
unchanged. The author's observed final revision also stayed unchanged after approval.
These samples do not exclude transient edits between observations. Temporary Codex
hook/cache and project trust changes were removed, restoring original config bytes.

The reviewer made one incorrect incidental claim: an already-sorted frozen array
of length two also throws on the proposal, contrary to its assertion that this case
escapes the bug. Independent execution confirmed this; the four blocking findings
remain valid. Test/reply commands were sometimes bundled, so tool-result timestamps
do not establish the order of individual checks inside those commands.

Prompts explicitly requested review across worktrees and revision-specific verdicts.
No ready-made ACC messages, manual relay or model continuation was supplied; delivery
was off. This is one observed exchange, not automatic revision pinning, a moving-HEAD
or dirty-checkout audit, or a guarantee of review accuracy. No ACC runtime behavior
or capability changed.

## Review while the author advances its revision, 2026-09-07

One further Claude Code 2.1.263 / Codex CLI 0.153.4 exchange used the unchanged
`170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05` archive.
The author requested review of commit A, then implemented an optional limit and
committed B before reading A's verdict. The reviewer was explicitly instructed to
review the requested commit and its specification. The author prompt specified
review of the current committed implementation followed by the enhancement, without
supplying ACC messages. The resulting request identified the full A SHA.

The harness paused its own reviewer process after its inbox result contained the
initial request id and full A SHA. The stopped PID was observed; it resumed after
158 seconds when a new clean B commit existed, within the 180-second timing bound.
This was one deliberate timing intervention. ACC did not pause or schedule a client,
and the harness injected no coordination messages or model continuation prompts.

The original reviewer approved A after B was committed. Codex explicitly restricted
that approval to A and requested a separate review of B. Parsed Git-show metadata
contained each full SHA with matching returned implementation hashes; raw commands
and separately hashed specification output were not retained. The same reviewer
approved B, and the author retrieved and acknowledged that verdict before its complete
handoff. B was still the final clean commit. Fourteen final fixture tests and an
independent oracle passed; restoring A's source failed seven tests and the new-feature
oracle. No ACC runtime or capability change was required.

After the author exited, the reviewer sent a separate amendment: its initial approval
had missed inherited sparse-hole values and custom iterators hiding invalid entries.
Independent execution confirmed both deviation classes in A and their correction in B.
The amendment's exact global-prototype example was imprecise: its non-writable index
itself causes TypeError; the scoped inherited-index and iterator examples do reproduce
the missed defects. The original approval record remained unchanged. The amendment's
receipt stayed queued for the closed author; receipt of B's approval does not imply
receipt of this later correction. B's approval was not withdrawn.

Both clients exited with code 0, and both ACC sessions closed with no claims or hook
bindings. The reviewer ended clean at its initial commit; sampled fixture files and
HEAD observations stayed unchanged. Samples cannot exclude transient edits between
observations. Temporary Codex cache and trust changes were removed, with exact original
config restoration. Delivery was off. These are observations of explicitly scoped
review and a delayed verdict, not generic revision enforcement, automatic wake-up,
universal review accuracy or recovery of a late correction in a successor session.

## Late review after a completed turn, 2026-09-07

Three Claude Code 2.1.263 / Codex CLI 0.153.4 captures used the unchanged
`170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05` archive.
Codex first completed an explicitly bounded smoke-test handoff without editing.
Claude then reviewed the committed implementation from a separate worktree and sent
a blocking request to the closed author's exact participant. The reviewer prompt
directed inherited-index and custom-iterator checks: this demonstrates reproduction
of those seeded defect classes, not unaided discovery or universal review accuracy.

The late request was captured queued before a prewritten continuation prompt was
submitted to the same ephemeral native conversation. The prompt contained no finding
text or message id. A fresh ACC owner retained the author's participant and native PID;
the old closed session and handoff stayed unchanged. The continuation retrieved the
complete finding through inbox before observed edits, acquired its own two file claims,
corrected the implementation and replied under its new owner. A hook message id alone
was not counted as proof of body receipt. The reviewer had already exited, so the reply
remained queued; no receipt or attention by the exited reviewer is claimed.

In the first run, native sandbox policy blocked the synthetic Git index lock. The
author left a truthful partial handoff with an uncommitted correction. In the second
run, the throwaway harness rejected a native Git approval request and the author again
finished partial. An isolated replay proved that the handler incorrectly rejected
shell-wrapped Git commands before operator review; the rejected live command itself
was not retained. After correcting that handler, a third run used command-specific
approval for the already-authorized fixture Git commit; it committed the correction
and completed its handoff. The final run's 16 fixture tests
and independent checks passed; restoring only the original source failed 4 tests.
Both defect classes and representative variants were also checked separately against
the old and corrected source. SPEC.md stayed unchanged. The final handoff explicitly
retained the reviewer's non-blocking hostile-Proxy spoofing limit; independent replay
confirmed that behavior remains. A complete status here is scoped to this correction.

Codex's app-server transport can include internal review child events. Captured root
thread and requested-turn identities distinguish those reports from the actual author's
completion. Sampled files cannot exclude transient edits between observations. All three
runs ended with closed ACC sessions and no claims or bindings; temporary native Codex
cache/trust changes were restored exactly. Delivery was off. No ACC runtime code,
maintained test or capability changed. These captures do not establish a native restart,
transfer to another participant, automatic wake-up or enforcement of semantic blockers.

## New-client recovery of a late review, 2026-09-07

A further capture used the unchanged archive SHA-256
`170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05`.
Codex CLI 0.153.4 completed a bounded smoke-test handoff and exited. A separate
Claude Code 2.1.263 reviewer then reproduced inherited-index and custom-iterator
defects at that exact committed revision, sent a blocking request to the closed
Codex participant, and exited. The reviewer prompt named these defect classes.

A new Claude conversation started afterward in the author's checkout with its own
native id, PID and ACC participant. Its prewritten prompt asked to recover prior
coordination context; it contained no message ids, finding text or old credentials.
A successful public full sync returned the complete predecessor handoff and late
finding bodies before observed edits. These were workspace-history reads, not inbox
retrieval by the original addressee. The successor acquired its own two file claims;
recorded leases and releases covered the observed changes. It committed a correction
and recorded a complete handoff. Eleven fixture tests passed independently; restoring
only the original implementation failed three. Five separate deviation checks passed.

The original closed session, handoffs and review request stayed unchanged. The old
recipient's receipt remained queued. The successor sent its own resolution note to
the exited reviewer, referencing the original request without replying or acknowledging
on the addressee's behalf. That note remained queued; the original reviewer did not
retrieve or approve the correction. The successor's room handoff had no recipients
or receipts, and explicitly preserved the original unanswered communication obligation.

Two phrases in the native report were inaccurate: acknowledgement belongs to the
owning participant, not specifically to a Codex client; the resolution note was queued,
while the room handoff was recorded without an addressed receipt. Full finding bodies
came from the full-sync snapshot, not the delta event payload. The original records
are preserved; those phrases are not product guarantees.

All three native processes exited naturally; all ACC sessions closed, with no claims
or hook bindings remaining. Temporary Codex trust/cache changes were restored exactly.
Delivery stayed off. This is one explicit continuation in a small fresh workspace,
not automatic client restart, unsaved-context recovery, arbitrary-history discovery or
transfer of another participant's inbox. No ACC runtime, maintained test or capability
changed. File samples do not exclude transient changes between observations.

## Outgoing sandbox permissions, 2026-09-09

On macOS arm64, ordinary Codex CLI 0.153.4 and Claude Code 2.1.267 sessions exposed
an asymmetry in installed ACC 0.4.2: Claude's request reached Codex through the
LocalDaemon queue, but Codex's shell reply could not connect to the Claude channel.
The OS returned EPERM while both receiving bindings remained active. The former
`recipient_unavailable` diagnosis concealed this sender-side permission failure.

A workspace permission profile granting ACC state writes and its local Unix sockets,
with the network proxy enabled and no external domains allowed, resolved that failure.
A fresh ordinary Claude → Codex → Claude round trip then produced both synthetic
markers and two successful native offers, without inbox polling or additional prompts.
The same Codex sandbox allowed the ACC socket and denied an unrelated Unix socket and
localhost TCP connection. Raw model transcripts were not retained.

Automatic outgoing permission setup is limited to Codex 0.153.4 or newer on this
platform. The installer preserves custom policies and reports them as unverified;
configuration readiness never establishes an active session's effective permissions.
This does not expand the certified hook versions or establish native replyRoute.
The patch also uses a stable short macOS channel directory across different TMPDIR
values and retains permission failures as a distinct safe offer code.
