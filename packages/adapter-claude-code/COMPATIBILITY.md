# Claude Code compatibility

Decision lifecycle rendering is checked by `tests/acceptance/decision-lifecycle-packed.test.mjs`
using the installed ACC channel and a local socket. Replacement/withdrawal links and
status survive in its existing untrusted text envelope. This is a transport regression
fixture, not a new observation of a Claude model interpreting the change; it adds no
capability claim.

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

## Default-lease crash checkpoint, 2026-09-07

Claude Code 2.1.263 on macOS arm64 participated in the authorized-recovery capture
on archive `170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05`.
It claimed two files with the default 1800-second lease, implemented a validation
helper, passed eight tests and recorded a durable unaddressed decision. The harness
sent SIGKILL to that child after observing the saved decision id in a successful
tool result. No finish or aggregation edit had occurred. The decision preserved the
ceiling 23, clamping and the rejected throwing alternative; 23 was absent from all
four project files. The independent aggregation oracle was still failing.

Codex subsequently asked permission, released only those two claims after explicit
approval and completed the carried decision. Claude's session stayed open/offline,
its original decision and hook binding remained, and completion addressed to it stayed
queued. It did not resume or acknowledge anything. Full successor and separate native
Codex turn-renewal observations are in the Codex compatibility record. No new Claude
capability is claimed; after-finish behavior for Claude was checked with installed hook
executables, not an additional live Claude conversation.

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

## Recovery beyond the first history page, 2026-09-07/08

Claude Code 2.1.263 on macOS arm64 completed a separate continuation on the same
installed archive (sha256 `170424207429240978ccda7e6a3bc60d17e3c8192576dcce32b7c1c755397a05`).
Before launch, the harness seeded five explicitly synthetic manual CLI sessions,
286 messages and 297 events through the public installed CLI, then closed those
sessions. Historical handoffs described earlier states; the current handoff and
late blocking request appeared at events 120 and 178. The newest handoff concerned
unrelated work. A public cursor preflight returned pages of 100, 100 and 97 events.

The fresh native participant received one continuation prompt without old message
ids or finding bodies. It loaded the installed skill and found its own inbox empty.
A full-sync invocation was followed by successful tool output containing the full
current handoff, finding and reviewer-handoff bodies before observed edits. The
model selected relevant context from the full snapshot; this does not demonstrate
native cursor traversal or bounded-size body retrieval.

It claimed both edited files, committed the correction, sent its own resolution
note and completed its handoff. Eight fixture tests passed independently; restoring
the old source failed one test containing the iteration regressions. Five separate
old/corrected cases also confirmed the inherited-hole and custom-iterator defects.
All old sessions, messages and receipts stayed unchanged. The original request
remained queued for its original participant; the new note stayed queued for the
closed synthetic reviewer, with no peer approval. The new room handoff had no
recipients or receipts. Claims and hook bindings were gone after natural exit 0.

This history deliberately used repetitive unrelated notes that identify their own
scope. It does not establish discovery in arbitrary organic histories, conflicting
business decisions, automatic restart or live delivery. Three intermediate native
tool results reported errors; their text was not retained, so their causes cannot
be classified from this capture. The final outcome and independent checks passed.
No ACC runtime, maintained test or capability changed; delivery stayed off. Only
Claude ran natively in this capture, and no native Codex settings were changed.
## Startup admission check, 2026-09-09 (no model delivery capture)

Claude Code 2.1.266 on darwin-arm64 was launched through the ordinary ACC-generated
shim in a disposable profile. ACC was installed from the development archive built
from `5503e2a867f23215c7e8fc8aa072ab4efd9b725f`, SHA-256
`04ce871d1a79f47f4bac14795a7c26d9bfe627df08b57bd300534fe97990d064`.
The profile used a dummy API key and an unreachable localhost model endpoint; this
exercise did not authenticate to a model or demonstrate a model receiving a message.

On the first completed startup, bootstrap reported `supported: true`, `/mcp` showed
the ACC Channel connected with two tools, and ACC published an `actionable` binding
for the actual Claude PID. Claude nevertheless reported that it ignored the development
flag because Channels were not currently available. On the next launch of that same
profile, Claude displayed its development-channel warning. The cause of that change
in vendor availability was not established; restarting is not a guaranteed remedy.

A metadata-only witness on the second launch observed `actionable` in the MCP child
and subsequent prompt hook. MCP initialization used protocol `2025-11-25`, client
version `2.1.266`, roots/listChanged and elicitation capabilities; it did not report
whether Claude admitted inbound Channel notifications. No raw conversation content
was retained as evidence, and no capability certification is added by this check.

This exposes a diagnostic limit: ACC's native binding verifies its local endpoint,
not the vendor's inbound Channel gate. Install/doctor now name the separate client-side
check, and doctor calls the observed state a local active transport. The remote report
of an empty binding list remains unconfirmed; it was not reproduced by this local run.
