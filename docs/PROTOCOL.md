# Protocol

The protocol is the vendor-neutral contract shared by core, CLI, MCP, storage, and every
adapter. Version 0.2 uses store schema version `3` and deliberately rejects v0.1 state.
There is no compatibility reader, conversion, archive path, or automatic deletion.

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
- A participant is the stable recipient of a message.
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
that arrive later can inspect room history through a full sync but do not receive
retroactive receipts. Room records are never eligible for live push.

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

An attempt records ids, target generation, transport name, adapter, client version,
timestamp, and a safe closed error code. It never copies the peer body into diagnostics.
Receipt `offered` is committed only after the transport accepts bytes. A failed attempt
leaves the receipt queued.

## Inbox, reply, and acknowledgement

`inbox` returns unresolved messages owned by the calling participant and advances only
that participant's receipt to `retrieved`. An exact message id is the recovery path after
compaction or an over-budget projection.

`reply` verifies that ownership, records an `answer` in the original thread, and advances
the original receipt to `acknowledged` in one transaction. Only after that durable commit
may the answer be offered to the original author. A transport error cannot roll back it.

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
- `actionable`: questions, requests, and addressed handoffs may use live push;
- `all`: every addressed kind may use live push.

Default is `off`. Policy never creates a capability. The router still requires a current
reachable binding, one unambiguous recipient generation, a passing exact-version
certification, and adapter acceptance. The current Codex and Claude captures do not meet
those requirements; all shipped native live routes therefore fall back durably.

## Attention and sync

Bounded sync returns events after a cursor plus explicit attention. Full sync is a
forensic workspace snapshot, not the normal way to recover one message. Attention is
limited to six explicit rules: `reply_required`, `acknowledgement_required`,
`recipient_unavailable`, `claim_conflict`, `claim_contended`, and `claim_expired`.

Next: [CLI](CLI.md) · [MCP](MCP.md) · [Architecture](ARCHITECTURE.md)
