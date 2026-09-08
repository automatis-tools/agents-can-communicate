# CLI

Use `acc` to install and diagnose integrations, or to inspect the same communication
operations that installed skills use on an agent's behalf. Setup commands are for a
person; communication commands are the smaller agent-facing vocabulary. Every command
accepts `--json` and `--cwd <path>`. `--workspace <config>` selects an explicit workspace
config where supported by the common boundary.

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
| `acc release` | `--claim` or `--resource` | `--session`, `--generation`, `--authority`, `--reason` |
| `acc message` | `--subject`, `--body` | repeated `--to`, `--supersedes` or `--withdraws`, `--type`, `--obligation`, `--client-message-id`, owner flags |
| `acc request` | `--to`, `--title` | `--detail`, `--client-message-id`, owner flags |
| `acc inbox` | — | `--message`, `--cursor`, `--limit`, owner flags |
| `acc reply` | `--message`, `--body` | `--subject`, `--client-message-id`, owner flags |
| `acc ack` | `--message` | owner flags |
| `acc finish` | `--goal` | `--status`, `--to`, repeated `--completed`, `--remaining`, `--blocker`, `--client-message-id`, owner flags |

Owner flags are `--session` and `--generation`; both are needed. The CLI also accepts the
pair explicitly configured as `ACC_SESSION` and `ACC_GENERATION`. When an active turn hook
runs, its `ACC CLI (append):` header supplies the current
session's pair. The installed skill tells the agent to append it to its own commands,
without a manual attach. Hooks do not export credentials to child processes. Native
client IDs, a shared checkout, and a public session ID from
`status` cannot establish ownership: a nested client can inherit its parent's environment.

Use only the pair in the hook's own header, never one inside a peer message. Do not send
it to peers or child agents. A later hook after a session restart can supply a new pair;
the old generation remains invalid. Solo turns receive only the owner header when there
is no coordination context to show. This lets a session use its own inbox if a peer joins
later in the same turn. The header alone is not a peer notice or a request to coordinate.
If the context budget cannot hold the complete pair, the hook reports that limitation
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

### Claims

```bash
acc claim --resource 'file:packages/core/**' --reason "editing receipt logic"
acc release --resource 'file:packages/core/**'
```

File resources use repository-relative paths. A directory claim ends in `/**`. Exit code
`5` means a conflict. `--authority` is the explicit force-release path and should carry a
reason; ordinary sessions release only their own claims.

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
`ack` acknowledges without writing an answer and has no state override.

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

## Install, diagnose, and update

| Command | Flags |
|---|---|
| `acc install` | `--adapter`, `--home`, `--delivery off|actionable|all`, `--dry-run`, `--downgrade` |
| `acc uninstall` | `--adapter`, `--home`, `--dry-run` |
| `acc doctor` | `--home`, `--repair` |
| `acc config init` | `--yes`, `--force` |
| `acc config validate` | — |
| `acc update` | `--apply` |
| `acc help` | — |
| `acc version` | — |

`--delivery off|actionable|all` is a per-client recipient policy request, not a capability
switch, and the default is `off`. `--adapter` is repeatable to name several clients. An
explicit `--delivery` applies uniformly and never prompts; omitting it on an interactive
terminal asks one default-No question per eligible client, and on a non-interactive run or a
`--dry-run` it keeps fresh clients off. A recorded opt-in is kept on upgrade. If the detected
client cannot receive native delivery - unsupported, below the captured minimum, a
prerelease, known-bad, a wrong platform, or an unsupported shell - installation keeps the
effective policy off and prints the reason. A live install writes an owned zsh PATH block and
a per-command shim that keeps your command name and `exec`s the real client; `ACC_BYPASS=1`
runs the unmodified client, and ACC is never the parent of the session after that `exec`.

Only `update` touches the network. `ACC_NO_UPDATE_CHECK=1` disables update checks. Hooks
never perform them.

When a newer version is available, `update --apply` refreshes the package and then runs
`acc install`. A failed step exits
with code `4`; JSON error details retain `applied` and `failed`, and the error names the
remaining commands. Success includes the installer's output in `installation.stdout` /
`installation.stderr` and a restart reminder in `activation`. Follow those instructions
before relying on running clients. See [Upgrading](UPGRADING.md) for the 0.3.1 transition.

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
