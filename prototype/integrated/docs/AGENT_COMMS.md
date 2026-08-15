# Local agent communication protocol

This is the operator guide for the local, Git-ignored `.agents/` mailbox bus.
It coordinates independent agent sessions on one checkout and machine. It does
not replace `AGENTS.md`, `TRACKS.md`, committed contracts, Git, PR review, or
the user's merge decision.

## Discovery and startup

`comms.mjs` uses the absolute `PW2_AGENT_BUS_DIR` when supplied. Otherwise it
asks Git for the absolute common `.git` directory and uses its checkout parent
as the bus root: `<checkout-root>/.agents/`. Main and linked worktrees therefore
share one bus. If that root cannot be determined unambiguously, set the explicit
absolute override. The runtime directory is intentionally ignored and must
never be committed.

Read [the canonical bootstrap prompt](AGENT_COMMS_PROMPT.md), or print a
substituted copy with:

```bash
node tools/agents/comms.mjs prompt --id visual --role visual --task M2.7 --ownership game/presentation
```

Start each working agent with `init`, `register`, an initial `inbox` poll, and a
dedicated long-lived `watch` process. Keep its output visible. `watch` emits
JSONL and a terminal signal, maintains heartbeat, and must be stopped before
`close`. It cannot force host software to inject output into an active reasoning
turn, so every agent must poll at the eight checkpoints in the canonical prompt.
Failure to register or run the watcher blocks local parallel work; it does not
apply to a solitary read-only session.

## Lifecycle and commands

All normal commands are `node tools/agents/comms.mjs <command>`. Add `--json`
where supported for one machine-readable JSON value; watcher output is JSONL.

| Command | Operation |
| --- | --- |
| `init` | Create or validate the shared protocol layout. |
| `register --id --role --task [--ownership ...] [--client ...] [--resume]` | Open a unique agent identity for its worktree/task. |
| `prompt --id --role --task --ownership scope [--ownership scope ...]` | Print the canonical prompt with literal values substituted; every ownership scope must contain non-whitespace content. |
| `inbox --id [--type ...] [--severity ...]` | List unacknowledged mail and mark successfully presented entries seen. |
| `watch --id [--heartbeat seconds] [--scan-interval seconds]` | Block, maintain presence, and print unseen events. |
| `wait --id [--timeout seconds] [--scan-interval seconds]` | One-shot wait for an unseen event; use only when no other work is available. |
| `send --from --to --type --severity --subject (--body \| --body-file \| stdin)` | Send one addressed immutable message. Attachments may repeat. |
| `broadcast --from --severity --subject ...` | Send an individually addressable copy to every active peer. |
| `reply --from --message --type --severity --subject ...` | Send a linked response; use it for answers, progress, or pending explanations. |
| `ack --id --message` | Persist receipt/handling acknowledgement and archive the message. |
| `claim --id --scope --reason [--lease seconds]` | Claim a path or named contract before editing it. |
| `release --id --scope` | Release your own claim. |
| `release --id --scope --force-stale --owner agent` | Orchestrator-only audited release of a stale foreign claim. |
| `handoff --id --to --task --result --branch --base ...` | Create typed handoff mail plus immutable evidence record. |
| `status [--fail-on-stale] [--fail-on-pending]` | Report protocol, agents, mail, claims, and handoffs; optionally enforce checks. |
| `doctor [--require-live id,...] [--repair]` | Diagnose corruption/state; repair only safe stale or corrupt transport records. |
| `close --id` | Stop an identity after its watcher is stopped; releases owned claims but retains history. |

Use `--body-file` or stdin for multi-line text to avoid shell quoting. Message
types are `status`, `question`, `contract_request`, `contract_response`,
`blocker`, `handoff`, and `broadcast`; severities are `info`, `action`, and
`blocker`.

### Mandatory message and handoff forms

Use `--requires-ack` whenever the recipient must explicitly complete or record
the work; it is accepted by `send`, `broadcast`, and `reply`:

```bash
node tools/agents/comms.mjs send --from visual --to models --type contract_request --severity action --subject "slots" --body "Need stable names" --requires-ack
node tools/agents/comms.mjs broadcast --from orchestrator --severity action --subject "checkpoint" --body "Poll inbox" --requires-ack
node tools/agents/comms.mjs reply --from models --message MESSAGE_ID --type contract_response --severity info --subject "slots" --body "hull_paper" --requires-ack
```

`handoff` requires all of `--id`, `--to`, `--task`, `--result`, `--branch`,
`--base`, `--verification-file`, `--contracts-file`, and `--limitations-file`,
plus either `--commit SHA` or `--uncommitted` (never both). `--changed`,
`--follow-up`, `--artifact`, and `--ephemeral-artifact` may repeat. Use
`--artifact` for a committed repository file and `--ephemeral-artifact` for
ignored evidence under `.agents/artifacts/`. A committed handoff is:

```bash
node tools/agents/comms.mjs handoff --id visual --to orchestrator --task M2.7 --result ready --branch m2/visual --commit COMMIT_SHA --base BASE_SHA --changed game/presentation/view.gd --verification-file verification.json --contracts-file contracts.json --limitations-file limitations.json
```

An uncommitted diagnostic handoff replaces `--commit COMMIT_SHA` with
`--uncommitted`; it cannot be ready-to-merge. `verification.json` is a nonempty
array of `{ "command", "exitCode", "summary" }` objects. `contracts.json` is
an object with `added`, `changed`, and `consumed` string arrays.
`limitations.json` is a string array. The files are validated before handoff
publication, so include failed verification evidence rather than omitting it.

## States, delivery, and coordination

An open registry record plus fresh online presence is live. Presence becomes
stale after 45 seconds without heartbeat; the watcher heartbeats every 15
seconds and polls the filesystem every two seconds as a fallback. A watcher may
be offline, stale, or live. A message is unseen until delivered to terminal
output, seen-but-unacked after presentation, and archived only after `ack`.
`requires_ack` action/blocker mail is required-unacked and makes pending checks
red; a seen receipt never substitutes for acknowledgement.

Before the first edit and at each documented checkpoint, inspect `inbox`. Claim
the exact file scope or `contract:name-vN` before editing. Claims overlap on
path segments; `game/presentation` conflicts with its child but not
`game/presentations`. A claim is an explicit warning, not permission to violate
track ownership. Request and receive a peer acknowledgement before a shared
contract edit. `reply` communicates the answer or blocked progress; `ack`
closes its delivery/action state. Required action and blocker messages need both
when a substantive response is necessary.

## Handoffs and closure

Every task, including a blocked one, ends with a handoff and closure. The
handoff must name the result, task, branch, commit/base (or explicit
uncommitted state), changed paths, verification commands with exit summaries,
contracts added/changed/consumed, follow-up agent ids, artifact paths/checksums,
and known limitations. A failed verification cannot be ready-to-merge. After
handoff, release claims, stop `watch` orderly with SIGINT/SIGTERM, and `close`.

## Exit codes and recovery

| Exit | Meaning |
| --- | --- |
| `0` | Command succeeded. |
| `2` | CLI usage error. |
| `3` | `wait` timed out with no event. |
| `4` | Invalid, missing, or corrupt protocol data. |
| `5` | Identity, claim, or lock conflict. |
| `6` | Required agent is stale/offline or a required acknowledgement is pending. |

With `--json`, success and failure each produce exactly one JSON value on
stdout. Failures use `{ "error": { "message", "exit_code", "details" } }` and
leave stderr empty; human mode prints the error on stderr.

Records are plaintext local files: never send secrets, tokens, credentials, or
personal data that does not belong in the repository. JSON schema/version
errors fail closed with exit 4. `doctor --repair` quarantines corrupt immutable
records and may repair proven stale locks or complete safe archive transitions;
it never silently resets a bus, steals a live claim, or migrates an unknown
schema. Investigate the reported path, use `status`/`doctor`, and coordinate
with the orchestrator before any repair affecting shared work.

The transport rejects symlinked managed paths, canonical escapes, and observed
directory-generation changes. Its security boundary is cooperative same-user
agents: portable dependency-free Node cannot make path traversal atomic against
a deliberately adversarial local process that swaps and restores an ancestor
directory between checks. Do not use the bus as a secret store or cross-user
security boundary.

## Rollout boundary

This v1 transport is local and has no network, daemon, or external dependency.
It is deliberately not CI infrastructure: runtime `.agents/` state is ignored,
and CI rollout is a separate follow-up after local acceptance proves the
operator flow. Host-specific push adapters remain out of scope; polling is the
portable delivery guarantee.

The feature-worktree proof is `git check-ignore -v .agents/protocol.json`; it
must name the `.agents/` entry in `.gitignore`. The shared bus itself lives
outside a linked worktree, so do not use an outside-worktree `../../.agents`
path with Git. After this change is merged, run the same feature-local command
from the main checkout to prove the tracked ignore rule there as well.
