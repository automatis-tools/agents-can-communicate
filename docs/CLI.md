# CLI

The `acc` command is the universal local boundary. Setup commands are for a person;
communication commands are the small surface installed skills teach to agents. Every
command accepts `--json` and `--cwd <path>`. `--workspace <config>` selects an explicit
workspace config where supported by the common boundary.

<!-- test:command -->
```bash
acc help
acc version
```

## Communication commands

| Command | Required | Optional |
|---|---|---|
| `acc status` | — | `--participant`, `--all` |
| `acc sync` | — | `--session`, `--cursor`, `--limit`, `--scope delta|full` |
| `acc work` | `--summary` unless `--clear` | `--session`, `--generation`, `--mode`, `--state`, repeated `--hint`, `--clear` |
| `acc claim` | `--resource` | `--session`, `--generation`, `--mode`, `--enforcement`, `--reason`, `--lease` |
| `acc release` | `--claim` or `--resource` | `--session`, `--generation`, `--authority`, `--reason` |
| `acc message` | `--subject`, `--body` | repeated `--to`, `--type`, `--obligation`, `--client-message-id`, owner flags |
| `acc request` | `--to`, `--title` | `--detail`, `--client-message-id`, owner flags |
| `acc inbox` | — | `--message`, owner flags |
| `acc reply` | `--message`, `--body` | `--subject`, `--client-message-id`, owner flags |
| `acc ack` | `--message` | owner flags |
| `acc finish` | `--goal` | `--status`, `--to`, repeated `--completed`, `--remaining`, `--blocker`, `--client-message-id`, owner flags |

Owner flags are `--session` and `--generation`. A normal hooked session omits them because
the CLI resolves its current binding. Scripts and adapters may pass them explicitly.

### Presence and intent

```bash
acc status
acc work --summary "checking receipt transitions" --mode review \
  --hint 'file:packages/core/src/receipts.mjs'
acc work --clear
```

`status` returns participants, current intent, claims, protection, attention, and current
delivery bindings. `sync` is a bounded event read; use `--scope full` only for an explicit
whole-workspace forensic question. Neither is the recovery path for one message.

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
same way `--session` refuses. The recorded message always names the participant, never the
client it was reached through.

`message` accepts generic kinds `note`, `question`, `request`, and `decision`. Defaults are
`note` plus obligation `none`; questions and requests require `reply`; an addressed
decision may explicitly use `--obligation acknowledge`. `answer` is created only by
`reply`, and `handoff` only by `finish`.

No `--to` creates a room message where the kind allows it. Addressed messages create a
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

### Inbox, reply, and acknowledgement

```bash
acc inbox
acc inbox --message message_x
acc reply --message message_x --body "Yes. Use offered."
acc ack --message message_y
```

Inbox returns only unresolved messages addressed to this participant. Reading advances
that participant's receipt to `retrieved`. Reply creates an `answer` in the same thread and
acknowledges the original atomically. `ack` acknowledges without writing an answer and has
no state override.

### Handoff

```bash
acc finish --goal "document receipt semantics" --status partial \
  --completed "protocol updated" --remaining "acceptance proof" \
  --blocker "packed test not run" --to codex
```

Status is `complete`, `partial`, or `blocked`. `finish` records a structured handoff,
releases the caller's claims, and ends ACC presence for that session. It never closes the
external AI client. An addressed handoff requires acknowledgement; a room handoff does not.

## Setup and maintenance

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

## Adapter lifecycle commands

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
