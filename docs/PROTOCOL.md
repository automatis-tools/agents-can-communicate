# Protocol

Use this page when implementing or checking a boundary shared by core, CLI, MCP, storage,
and adapters. Protocol version 0.2 uses store schema version `3` and deliberately rejects
v0.1 state. There is no compatibility reader, conversion, archive path, or automatic
deletion.

## Durable records

The store accepts only these durable kinds:

```text
workspace · participant · session · intent · claim · message · receipt · event
```

`deliveryBinding` is validated but ephemeral. It is tied to one open session generation
and never written inside a repository.

## Identity

```text
Workspace
└── Participant
    └── Session generation
```

- A workspace is one local coordination room.
- A participant is the recipient address for a message. A hooked session gets a default
  address derived from its client session id; only an explicitly supplied participant id
  is stable across unrelated client conversations.
- A session is one client conversation. Its unguessable generation token proves that a
  later mutation still belongs to the current opening.

Sessions carry harness, checkout, branch, optional pid, enforcement, and lifecycle facts.
The `managed` lifecycle value means ACC hooks can report presence changes; it does not mean
ACC owns or controls the external client.

## Intent and claims

Intent contains `summary`, `mode`, `resourceHints`, `state`, and `updatedAt`. It is
awareness only.

Claims contain the owner session and generation, canonical resource URI, shared or
exclusive mode, advisory or guarded enforcement, reason, and lease timestamps. Claim
acquisition and conflict detection are atomic. Presence becoming stale never releases a
claim; expiry or an explicit release does.

## Message envelope

Every message contains:

```text
messageId
threadId
clientMessageId
workspaceId
fromParticipantId
fromSessionId
toParticipantIds
kind
obligation
subject
body
inReplyTo
artifacts
handoff
sentAt
```

`clientMessageId` is an idempotency key scoped to workspace plus sender participant. A
retry with the same logical content returns the original message. Reusing the key with
different content is a data error. CLI and MCP generate a key when omitted and return it
inside the message so an uncertain caller can retry explicitly.

An empty `toParticipantIds` creates a room record. At commit time, core resolves every
known peer participant with an open session and creates a receipt for each. Participants
that arrive later can inspect room records through history sync but do not receive
retroactive receipts. Those already-present recipients get the normal inbox and certified
next-turn path; a successful next-turn write advances their room receipt to `offered`.
Room records are never eligible for native live push.

## Decision lifecycle

A decision may additionally carry `decisionChange` with exactly two fields:
`action` (`replace` or `withdraw`) and `messageIds` (1..16 unique portable IDs of
existing decisions in the same workspace). Generic send inputs use `supersedes`
or `withdraws`; the durable payload is built after transactional validation.
The sorted target set participates in idempotency. The author may be any owned
participant; attribution does not confer system authority.

Targets and their receipts are immutable. Changes inherit target receipt recipients
and target authors, excluding the changing author from inherited recipients. Extra
explicit recipients are merged, sorted, and persisted in `toParticipantIds` before
recording. This also notifies offline readers and makes live routing use the same set.
No old receipt is acknowledged, deleted, or advanced by a lifecycle change.

Explicit links form a graph. Within a connected group, terminal records are heads;
multiple heads mean a conflict, even if their prose looks similar. A change may target
an already replaced decision, creating a competing branch. Resolve branches by
explicitly linking a new change to all their current heads. A withdrawal is itself
a terminal record; superseding it explicitly records a new decision.

Decision summaries and exact read copies expose `decisionStatus`:

| Field | Meaning |
|---|---|
| `state` | `current` for a terminal choice; `withdrawn` for a terminal cancellation or history with only cancelled heads; otherwise `superseded` |
| `isHead` | no recorded successor links to this record |
| `conflicted` / `headCount` | whether the group has multiple terminal positions and their count |
| `currentMessageId` | sole current head, or null if there is no unique head |
| `groupId` | derived representative root ID for finding related heads; may change when groups are joined |

This metadata is never persisted. `history` + kind `decision` + `current: true`
lists heads, including withdrawals and conflicts, using the same summary budget.
Ordinary inbox, bulk reads, automatic delivery and attention omit non-head decisions;
exact inbox/history retain them. Timestamps and acknowledgements never choose a winner.
A decision without an explicit successor may still be factually stale.

Next-turn context and each native offer use a lifecycle snapshot; text already shown
or in flight cannot be recalled. Changes get their own delivery receipts. Native
transport carries the change/status inside its existing untrusted text envelope.

The optional field preserves reading of existing schema-3 records by this build.
Older ACC builds cannot interpret these semantics and may reject new records with
unknown fields. Upgrade participating ACC installations together; this is not a
forward-compatible promise or an automatic state migration.

## Kinds and obligations

| Kind | Valid obligation | Addressing |
|---|---|---|
| `note` | `none` | addressed or room |
| `question` | `reply` | addressed only |
| `request` | `reply` | addressed only |
| `answer` | `none` | addressed reply only |
| `decision` | `none`, or `acknowledge` | addressed or room; room must use `none` |
| `handoff` | `acknowledge`, or `none` | addressed must acknowledge; room must use `none` |

The generic `message` boundary accepts only `note`, `question`, `request`, and `decision`.
An `answer` must be made through `reply`, which supplies the thread link. A `handoff` must
be made through `finish`, which supplies the structured payload.

A request has no accepted, running, or done state. The reply resolves its communication
obligation; execution evidence belongs in the answer or handoff.

## Threads

The root message uses its own id as the thread id:

```text
threadId = messageId
inReplyTo = null
```

An answer carries the same `threadId` and the original message id in `inReplyTo`. There is
no mutable thread record or hidden thread status.

## Receipt lifecycle

Every resolved recipient gets an independent receipt:

```text
queued -> offered -> retrieved -> acknowledged
```

`recorded` is the send boundary's success result: the message is durable. It is not a
receipt state. `queued` is the distinct per-recipient fact created in the same transaction,
so one recorded room or multi-recipient message can have zero or several queued receipts.

- `queued` proves the durable message and receipt committed.
- `offered` proves bytes crossed ACC's transport boundary or the target client accepted a
  certified native call.
- `retrieved` proves the participant explicitly received the body through inbox or an
  equally strong certified adapter signal.
- `acknowledged` proves that participant acknowledged or replied.

Offered is not read. Retrieved is not model attention. Reply is not task completion.

Forward skips are allowed when the stronger observation implies the weaker ones. Repeating
a state is idempotent; moving backward is rejected. There is no `seen` state because ACC
cannot inspect model attention, and no terminal delivery `failed` state because the
durable path remains available.

## Offer attempts

Delivery attempts are immutable events, not receipt states:

```text
message.offer_succeeded
message.offer_failed
```

Every attempt identifies `messageId`, `recipientParticipantId`, `targetSessionId`, and
`targetGeneration`, followed by the transport name, adapter, client version, and timestamp.
A failed attempt additionally carries a safe closed error code. Core validates the target
as that recipient's recorded session generation and derives event attribution from it; the
router cannot substitute the sender or omit the selected binding. Attempts never copy the
peer body into diagnostics.
Receipt `offered` is committed only after the transport accepts bytes. A failed attempt
leaves the receipt queued.

## Inbox, reply, and acknowledgement

Without an id, public `inbox` lists bounded summary pages for unresolved messages owned
by the calling participant, without changing receipts. An exact read returns the complete
message and advances only that participant's receipt to `retrieved`. It is the narrow
recovery and inspection path, including after compaction or acknowledgement. Reading an
acknowledged message preserves its receipt, timestamp, and event history; it does not put
the message back into the unresolved inbox. Ownership and current-generation checks still
apply to every read.

`reply` verifies that ownership, records an `answer` in the original thread, and advances
the original receipt to `acknowledged` in one transaction. Only after that durable commit
may the answer be offered to the original author. A transport error cannot roll back it.
CLI and MCP reply results expose both facts: `message` and `delivery` describe the outgoing
answer, while `receipt` describes the caller's acknowledgement of the original message.

`ack` advances the caller's receipt without creating a reply. It exposes no state override;
callers cannot claim that a transport offered or a participant retrieved a message.

## Handoff

`finish` creates a `handoff` with structured `status`, `completed`, `remaining`,
`blockers`, and `verification`, releases the sender session's claims, and ends its ACC
presence. An addressed handoff requires acknowledgement. A room handoff does not. Neither
form closes or otherwise controls the external AI client.

## Delivery binding and recipient policy

A live-capable adapter may publish one ephemeral binding for its exact session generation:

```text
sessionId · generation · adapterId · clientVersion · availableModes
livePolicy · opaqueEndpointRef · leaseUntil
```

The recipient owns `livePolicy` because native push may start a model turn:

- `off`: inbox and normal next-turn paths only;
- `actionable`: questions, requests, answers, decisions, and addressed handoffs may use live push;
- `all`: every addressed kind may use live push.

Default is `off`. Policy never creates a capability. The router still requires a current
reachable binding, one unambiguous recipient generation, supported client evidence, and
adapter acceptance. Claude Code live delivery on macOS arm64 uses a captured 2.1.258
minimum plus a current feature probe and per-session protocol handshake; it was confirmed
again on 2.1.260. Codex's queue transport was captured but withdrawn because its required
mode hides the session workspace. Every unavailable or refused route falls back durably.

## Attention and sync

Default sync returns a bounded event page after a 16-digit cursor plus explicit attention.
History sync returns read-only message summaries (20 items by default, at most 12,000
formatted JSON bytes) and complete-message-id cursors, or one exact full message. Neither
history mode changes receipts. Full sync adds an unbounded forensic workspace snapshot.
Message discovery and exact-read contracts are in [CLI](CLI.md) and [MCP](MCP.md). Attention is
limited to six explicit rules: `reply_required`, `acknowledgement_required`,
`recipient_unavailable`, `claim_conflict`, `claim_contended`, and `claim_expired`.

Next: [CLI](CLI.md) · [MCP](MCP.md) · [Architecture](ARCHITECTURE.md)
