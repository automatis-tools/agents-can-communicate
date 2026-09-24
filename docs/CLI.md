# CLI

Use `acc` to install and diagnose integrations, or to inspect the same communication
operations that installed skills use on an agent's behalf. Setup commands are for a
person; communication commands are the smaller agent-facing vocabulary. Every command
accepts `--json` and `--cwd <path>`. `--workspace <config>` selects an explicit workspace
config where supported by the common boundary. These three global options work before
or after the command: `acc --cwd /project status` and `acc status --cwd /project`
select the same workspace. A native hook also supplies `--workspace acc://<reference>`
to select its saved room directly. This reference is local to ACC's data home, is
not a network URL, and does not establish session ownership. Ordinary config paths
retain their existing validation.

<!-- test:command -->
```bash
acc help
acc version
```

Use `acc <command> --help` (or `-h`) and `acc help <command>` for that command's
required, optional, repeatable and flag options, accepted values, and usage notes.
For example, `acc work --help` lists intent modes, and `acc finish --help` lists
handoff statuses. `acc config --help` lists its subcommands;
`acc config init --help` and `acc help config init` describe initialization.

Add `--json` to receive the command description as structured data: `name`,
`summary`, `required`, `optional`, `repeated`, `flags`, `subcommands`, `choices`,
and `notes`, plus `subcommand` when selected. General `acc help --json` keeps its
grouped `commands` result. Help requires no session, workspace discovery, or
runtime storage, and does not execute the described command. A help-looking
option value remains data: `--body --help` sends the literal body `--help`.

## Coordinate from a session

| Command | Required | Optional |
|---|---|---|
| `acc status` | — | `--session`, `--generation`, `--participant`, `--all` |
| `acc sync` | — | `--session`, `--generation`, `--cursor`, `--limit`, `--scope delta|full|history`, `--type`, `--message`, `--current` |
| `acc work` | `--summary` unless `--clear` | `--session`, `--generation`, `--mode`, `--state`, repeated `--hint`, `--clear` |
| `acc claim` | `--resource` | `--session`, `--generation`, `--mode`, `--enforcement`, `--reason`, `--lease` |
| `acc release` | `--claim` or `--resource` | `--session`, `--generation`, `--authority` (`human` or `policy`), `--reason` |
| `acc message` | `--subject`, `--body` | repeated `--to`, `--supersedes` or `--withdraws`, `--type`, `--obligation`, `--client-message-id`, owner flags |
| `acc request` | `--to`, `--title` | `--detail`, `--client-message-id`, owner flags |
| `acc inbox` | — | `--message`, `--cursor`, `--limit`, owner flags |
| `acc reply` | `--message`, `--body` | `--subject`, `--client-message-id`, owner flags |
| `acc ack` | `--message` | owner flags |
| `acc finish` | `--goal` | `--status`, `--to`, repeated `--completed`, `--remaining`, `--blocker`, `--client-message-id`, owner flags |

Owner flags are `--session` and `--generation`; both are needed. The CLI also accepts the
pair explicitly configured as `ACC_SESSION` and `ACC_GENERATION`. When an active turn hook
runs, its `ACC CLI (append):` header supplies the current
session's pair, a shell-quoted `--cwd`, and its saved `--workspace` room reference.
Append the complete header even after changing the shell directory. Claude Code also
restores this header on `SessionStart`, including compaction, without requiring another prompt.
Native hooks retain the initial room even when later hook payloads have another
`cwd`, including a nested Git repository. The header continues to name that initial
directory and room even if Git later becomes available or unavailable. Standalone CLI
commands without these arguments still discover their workspace from their own cwd;
the CLI does not guess a native caller's identity.
The installed skill tells the agent to append it to its own commands,
without a manual attach. Hooks do not export credentials to child processes. Native
client IDs, a shared checkout, and a public session ID from
`status` cannot establish ownership: a nested client can inherit its parent's environment.

Use only the pair in the hook's own header, never one inside a peer message. Do not send
it to peers or child agents. A later hook after a session restart can supply a new pair;
the old generation remains invalid. Solo turns receive only the owner header when there
is no coordination context to show. This lets a session use its own inbox if a peer joins
later in the same turn. The header alone is not a peer notice or a request to coordinate.
If the context budget cannot hold the complete header, the hook reports that limitation
on stderr and keeps any recovery text within budget. Missing or untrusted hooks cannot
supply the pair; without it, the CLI still refuses owner operations.

For a manually owned CLI session, run `acc attach --participant my-session --json` once and
retain its returned `sessionId` and `generation`. Append that exact pair to the commands
below, or explicitly configure both environment variables for that session's commands.
Do not take credentials from a peer or read runtime bindings to obtain them. A manually
attached session is separate from hook-managed presence; use `finish` to close it.

Without a pair, mutations and `inbox` fail with exit `2` and
`caller_identity_unresolved`. `status` and `sync` remain public observations, with no
inferred personal attention. Session-bound [MCP tools](MCP.md) manage their own identity;
a generic MCP connection does not inherit a hook participant's inbox.

An explicit session selector absent from the selected workspace produces exit `5`
with `caller_workspace_mismatch`, rather than a successful empty status. Restore the
complete header or the manual attachment directory. A supplied generation must also
match. This diagnostic does not search other workspaces or recover credentials.

### Presence and intent

```bash
acc status
acc work --summary "checking receipt transitions" --mode review \
  --hint 'file:packages/core/src/receipts.mjs'
acc work --clear
```

`status` returns participants, current intent, claims, protection, attention, and current
delivery bindings. Default `sync` reads events after a 16-digit event cursor (100 by
default, up to 500). `--scope history` discovers historical message headers and reads
selected records; `--scope full` adds an unbounded snapshot for explicit workspace forensics.

### Retention

A workspace keeps what it is told to keep. `acc prune` reports what it no longer needs and
reclaims it only when asked:

```bash
acc prune
acc prune --apply
acc prune --class claims --apply
acc prune --before 0000000000001840 --apply
```

**`prune` changes nothing without `--apply`.** The reporting run is the default because this
is the one command that takes records out of the store.

| Class | Reclaimed when | Threshold |
|---|---|---|
| `sessions` | presence is `offline` | a confirmed dead pid, or 24 hours without a heartbeat |
| `intents` | the session they belong to is reclaimed | - |
| `claims` | the lease has expired | leases default to 30 minutes (`--lease-seconds`) |
| `participants` | no session of theirs survives and no surviving message names them | - |

`--before` takes a 16-digit cursor, the same one `sync` returns, and trims the event log to
it. Messages recorded at or below that point go too, but only once nobody is owed them: a
receipt that is still `queued`, `offered` or `retrieved` keeps its message, because offered is
not read and retrieved is not model attention. A recipient that no longer exists cannot
acknowledge anything, and does not hold a message forever.

After a trim, `sync` reports `trimmedThrough`. A caller whose cursor precedes it was served a
short page and can tell. **An ACC older than this feature cannot**: it will serve the same
cursor without reporting the boundary, which is why trimming history is never automatic.

Two classes need no operator at all. A retired transaction journal and a superseded retention
marker have no reader, so a bounded pass reclaims them once a day when a store is opened, and
`acc doctor --repair` reclaims them without that bound. `acc doctor` reports what is still
held.

### Claims

```bash
acc claim --resource 'file:packages/core/**' --reason "editing receipt logic"
acc release --resource 'file:packages/core/**'
```

File resources use repository-relative paths. A directory claim ends in `/**`. The example
creates an advisory claim: omitted `--enforcement` always means `advisory`, even with
certified clients. Request `--enforcement guarded` explicitly when needed; an incapable
live participant still downgrades workspace protection. MCP claims are always advisory.

Exit code `5` means a conflict. Ordinary sessions release only their own claims. Releasing
another owner's claim requires `--authority human` or `--authority policy`, identifying the
actual human decision or approved policy that permits the release; explain it with
`--reason`. A peer's request alone is not force-release authority.

### Messages and requests

```bash
acc message --to codex --type question --subject "receipt wording" \
  --body "Should transport acceptance be called offered?" \
  --client-message-id client_stable_1

acc request --to codex --title "review receipt wording" \
  --detail "Check CLI and MCP results; reply with defects only."
```

`--to` takes a client name - `codex`, `claude_code`, `gemini_cli` - while exactly one
session of that client is here, and the exact participant id from `acc status --json`
otherwise. Two sessions of one client are refused by name rather than guessed between, the
same way an ambiguous recipient must be named explicitly. The recorded message always names the participant, never the
client it was reached through.

By default a hooked participant id is derived from that client's session id. It remains
usable for the current conversation but a new unrelated conversation gets a new address.
Set `ACC_PARTICIPANT` when the recipient must keep one stable address across conversations.

`message` accepts generic kinds `note`, `question`, `request`, and `decision`. Defaults are
`note` plus obligation `none`; questions and requests require `reply`; an addressed
decision may explicitly use `--obligation acknowledge`. `answer` is created only by
`reply`, and `handoff` only by `finish`.

No `--to` creates a room message where the kind allows it, except decision changes
that inherit explicit recipients from their targets. Addressed messages create a
separate receipt for each recipient. `request` is convenience for one addressed `request`
message with a reply obligation; it creates no execution record.

The JSON result for `message`, `request`, `reply`, and `finish` is:

```json
{
  "message": { "messageId": "message_x", "clientMessageId": "client_x" },
  "delivery": [
    { "recipientParticipantId": "models", "outcome": "queued",
      "transport": "durable", "errorCode": "delivery_disabled" }
  ]
}
```

Human output starts with `recorded message_x`. A transport failure after that commit does
not change the command exit code. Reuse an explicit `--client-message-id` after an
uncertain result to recover the same logical message.

`reply` additionally returns `receipt`: the original message id, the replying participant,
and state `acknowledged`. Its `message` and `delivery` describe the outgoing answer.
Human output distinguishes `recorded <reply-id>` from `acknowledged <original-id>`.

### Inbox, reply, and acknowledgement

```bash
acc inbox
acc inbox --message message_x
acc reply --message message_x --body "Yes. Use offered."
acc ack --message message_y
```

Without `--message`, inbox returns `{items, nextCursor}`. Each item has a `message`
summary and its `receipt`; listing never returns bodies or changes receipts. Summaries
include the complete message/thread/sender ids, kind, obligation, timestamp, reply link,
subject (up to 160 UTF-8 bytes), `bodyBytes`, `artifactCount`, and untrusted attribution.
Bodies, artifact details, handoff payloads, and recipient lists require an exact read.

Pages are newest first (descending message id breaks timestamp ties), default to 20 items,
and contain at most 12,000 bytes of formatted page JSON, excluding the CLI envelope.
`--limit` accepts 1..500 but cannot raise the byte ceiling. Continue with
`acc inbox --cursor <nextCursor>` until it is `null`. The cursor is a complete message id,
not an offset; reading or acknowledging it does not shift the next page. These are live
pages: omit the cursor to see new arrivals. An unknown or foreign cursor is an error.

`--message <id>` returns the existing one-item array with the complete message/receipt
pair, advancing that participant's receipt to `retrieved` when needed. It cannot be
combined with `--cursor` or `--limit`. An exact id also reads an acknowledged message,
preserving its receipt, timestamp, and event history.
Use the original message id to inspect acknowledgement; the outgoing reply belongs to
its recipient's inbox. Resolved messages stay out of the ordinary inbox.

Reply creates an `answer` in the same thread and acknowledges the original atomically.
`ack` acknowledges without writing an answer and has no state override. For an unanswered
question or request, it exits `5` without changing the receipt: use `reply` to answer,
clarify, or decline. An already acknowledged receipt remains an idempotent no-op.

You can `reply` after `ack` or an earlier answer without changing the original receipt
timestamp. Use a new `--client-message-id` for a distinct reply, and the same key and
content for a retry. Acknowledgement is not acceptance of work; an acceptance reply names
the scope and next step, while a later result reports what was actually verified.

### Historical recovery

```bash
acc sync --scope history --type handoff --json
acc sync --scope history --type handoff --cursor message_x --json
acc sync --scope history --message message_y --json
```

History returns `{scope: "history", view: "summary", items, nextCursor}` with the same
summary fields, ordering, page limits, and message-id cursors as inbox. `--type` accepts
any message kind and filters before pagination; keep the same filter between pages.
This public workspace observation includes records from before your session joined.
Exact history reads return `view: "message"` and one complete message in `items`,
without changing any receipt. Do not combine `--message` with type, cursor, or limit;
message and type are valid only in history scope. Decision reads also include `decisionStatus`. Use
`acc sync --scope history --type decision --current --json` for terminal decisions
and withdrawals; keep these filters when paging. Exact reads cannot use `--current`.
`current` means no explicit successor, not truth or consensus.

To change a decision, send another `acc message --type decision` with repeated
`--supersedes <message-id>` or `--withdraws <message-id>` (1..16 unique IDs; exclusive).
Use subject/body for the new position or withdrawal reason. Changes inherit the target
recipients and authors, including offline participants; `--to` adds recipients.
Any owned participant can record an attributed change. Multiple successor branches
remain conflicted until a new change explicitly references all current alternatives.
Old records leave ordinary inbox/automatic attention without any receipt change;
exact inbox and history still recover them. See [decision lifecycle](PROTOCOL.md#decision-lifecycle).

### Handoff

```bash
acc finish --goal "document receipt semantics" --status partial \
  --completed "protocol updated" --remaining "acceptance proof" \
  --blocker "packed test not run" --to codex
```

Status is `complete`, `partial`, or `blocked`. `finish` records a structured handoff,
releases the caller's claims, and ends ACC presence for that session. It never closes the
external AI client. An addressed handoff requires acknowledgement; a room handoff does not.
Use `complete` when the original goal is done; `partial` does not instruct the peer to
continue. Distinguish authorized next steps from excluded backlog. If agreement is needed
before leaving, request the concrete continuation and obtain a substantive reply before
`finish`; a reply sent after `finish` may wait durably for the sender to return.

## Install, diagnose, and update

| Command | Flags |
|---|---|
| `acc install` | `--adapter`, `--home`, `--delivery off|actionable|all`, `--dry-run`, `--downgrade` |
| `acc uninstall` | `--adapter`, `--home`, `--dry-run` |
| `acc doctor` | `--home`, `--repair` |
| `acc config init` | `--yes`, `--force` |
| `acc config validate` | — |
| `acc update` | `--check`, `--auto on\|off`, `--pin VERSION\|none`, `--yes`, `--apply` (alias) |
| `acc help` | — |
| `acc version` | — |

`--delivery off|actionable|all` is a per-client recipient policy request, not a capability
switch, and the default is `off`. `--adapter` is repeatable to name several clients. An
explicit `--delivery` applies uniformly and never prompts; omitting it on an interactive
terminal asks one default-No question for all selected clients that need a decision. Codex can save consent while
its local service is unavailable or has no loaded session; this does not activate delivery.
A non-interactive run or a `--dry-run` keeps fresh clients off. A recorded opt-in is kept on upgrade. If the detected
client cannot receive native delivery - unsupported, below the captured minimum, a
prerelease, known-bad, a wrong platform, or an unsupported shell - installation keeps the
effective policy off and prints the reason. Claude Code shell activation writes an owned
zsh PATH block and a shim that `exec`s the real client; `ACC_BYPASS=1` bypasses that
activation. Codex LocalDaemon delivery uses recorded installation consent without changing
ordinary launch arguments. Its opt-in remains active when shim variables are absent or
bypassed; `acc install --adapter codex --delivery off` disables new native offers. On a
supported explicit install, complete consent can prepare a missing Codex service. On macOS
arm64 with Codex 0.154.0 or newer, the same choice includes downloading a missing standalone
package from OpenAI. ACC selects the installed CLI version and verifies the official
installer's pinned checksum. The installer uses the selected `HOME` and `CODEX_HOME`.
Your existing npm or Homebrew command and shell profiles remain unchanged.
An older consent that covered service start receives one expanded choice for the download.
An accepted or declined answer persists. To change a declined answer, use
`acc install --adapter codex --delivery actionable` (or `all` for that policy).
Explicit `--delivery actionable|all` also approves a required download on supported clients.
Dry runs, delivery off, doctor, automatic refresh, and message delivery do not download
Codex or start its service. Uninstall does not remove Codex or stop the shared vendor daemon.
The install summary names each client's requested policy,
activation state and verified fallback. `doctor` separates protocol readiness, recorded
consent and a live channel in the current workspace, with a next step for missing activation.
A supported version or an installed plugin alone is not an active delivery channel.
`runtime: active` means ACC has a reachable local transport binding. Claude can still
block inbound Channels messages while its MCP server and tools remain connected;
doctor therefore also names the client-side startup check.
In doctor JSON, `nativeDelivery.activation` distinguishes missing launch setup from a
recorded setup (or `not_required` for a pre-existing service). `policy` is the installed
choice. `deliveryDecision` gives its known source and reports legacy provenance as unknown.
`nativeServiceSetup` reports service infrastructure separately. `sessionPolicy` describes a native binding when one is visible. Existing Claude
sessions can retain their launch policy after a different choice is installed for new
sessions; Codex checks current recorded consent before new offers.
`nativeDelivery.sessions` lists each current session's identity, present transport state
and `lastAttempt`: timestamp, startup/turn event, effective policy and its source, whether
that policy was missing/invalid/off, whether a client process was identified, and the closed
handshake result/reason. `lastAttempt: null` means no usable attempt was observed for this
generation; it does not prove hooks are disabled. A past successful handshake is separate
from current transport reachability. ACC replaces this small diagnostic beside the
hook-owner file outside the repository; it never adds attempt history to agent context.
See [delivery consent](CONFIGURATION.md#keep-delivery-consent-user-owned).

An initial `acc install` enables automatic updates. Reinstalling preserves an explicit
`acc update --auto off` choice. A full uninstall pauses updates; reinstalling restores
the remembered setting. A background worker checks stable releases
at most once a day, downloads and verifies a separate runtime, then refreshes installed
integrations and skills once no hold blocks. A runtime lease or native binding blocks only
while the store contract it declares differs from the incoming version's, or while it
declares none; records written before 0.5.0 declare none, so the first update after
upgrading still waits for them. ACC leases end on confirmed process exit; a native binding
can clear on observed SessionEnd even while its vendor daemon remains alive, or on
confirmed process death. Unknown PIDs remain holds. `finish`, presence TTL, and delivery off are not observed native end. Hooks do not
wait for network work. `ACC_NO_UPDATE_CHECK=1` disables update networking and background
scheduling.

`acc update` requests the update immediately. If a verified Codex service holds a native
binding that blocks activation, or serves a version its captured native-delivery contract
refuses, it asks once to restart that service.
After confirmation, a detached worker waits for idle work and for any ACC process whose
declared store contract still holds the update, refreshes integrations, restarts the
service and verifies the result. Open clients disconnect; use
`acc doctor` for progress and resume the clients afterward. `--yes` supplies explicit
noninteractive restart consent. Without consent, or with unknown ownership, the update
remains pending. See [maintenance limits and recovery](UPGRADING.md#confirmed-client-service-maintenance). `--check` only checks and cannot be combined with
settings changes. `--auto off` disables background updates, and `--auto on` enables them.
`--pin 0.4.0` holds an exact stable version; `--pin none` follows stable releases. A pin
cannot downgrade the active runtime. The old `--apply` flag remains accepted.

Failed downloads keep the working runtime. A failed integration refresh exits with code
`4`, names the failed adapter and configuration error, and keeps workspace admission closed.
Fix the reported configuration problem, then run `acc update` to finish it. `acc doctor`
reports the update policy and pending notice. During blocked activation, a current launcher
returns `scope: update` and `workspaceInspection: unavailable_during_update` without opening
workspace state; `doctor --repair` remains blocked. Native clients may still require hook trust
or activation review. See [Upgrading](UPGRADING.md) for the initial 0.3.1 transition and
recovery details.

## Integrate a client lifecycle

`acc attach --participant <id>`, `acc heartbeat --session <id> --generation <token>`, and
`acc detach --session <id> --generation <token>` are public executable boundaries used by
adapters. Installed skills do not teach models to call them. They maintain ACC presence;
they do not start, keep alive, or close the external client process.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | usage |
| `3` | timeout |
| `4` | data or incompatible state |
| `5` | claim or generation conflict |
| `6` | attention |

Next: [Protocol](PROTOCOL.md) · [MCP](MCP.md) · [Configuration](CONFIGURATION.md)
