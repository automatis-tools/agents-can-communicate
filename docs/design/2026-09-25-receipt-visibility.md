# Receipt visibility: what the sender can see after a send

Issue #134. A sender learns a message's delivery state once, in the send result. Every later
change happens out of its sight. This design shows each recipient's receipt to anyone who reads
the exact message, counts messages that a transport accepted and nobody retrieved, and gives a
live offer that nothing followed up one repeat through the next-turn hook.

## Problem

`acc sync --scope history --message <id>` returns the message record and no receipt fields
(`packages/core/src/sync.mjs:50`). `acc status --json` counts sessions, claims and messages
(`packages/core/src/status.mjs:147-150`). The receipt model already separates `queued`,
`offered`, `retrieved` and `acknowledged`, but the only reader of another participant's receipt
is `sync --scope full`, which returns the whole store.

A sender therefore cannot tell a message the peer's client accepted from one the peer's model
answered, and a live offer that a transport accepted and then lost has no recovery path when
the message carries no obligation.

## Evidence

A read-only census of every workspace store on the maintainer's machine, 2026-09-25, 109
receipts after the 0.7.0 prune:

| State | Count | Detail |
|---|---|---|
| `acknowledged` | 69 | 49 of them were offered first |
| `queued` | 32 | never offered; recipients that never had another turn |
| `retrieved` | 5 | |
| `offered` | 3 | all three are answers with obligation `none`, offered live: one through `claude-channel`, two through `codex-app-server` |

From a successful offer to the first retrieval or acknowledgement: median 36 seconds, 90th
percentile 14 minutes, maximum 24 minutes (49 pairs).

Three facts from the code decide the shape of the design:

- Next-turn offers are recorded only after the hook's stdout carried the body
  (`packages/hook-runner/src/runner.mjs:356`). That is the strongest delivery evidence ACC has
  short of a model action. A live offer records transport acceptance only.
- The skill tells a model that a body already in its context is complete and that fetching it
  again buys nothing. `offered` without `retrieved` is therefore the normal final state of a
  message delivered with its body. Repeating every such message would fight the skill.
- An obligation message already has a standing reminder every turn until it is acknowledged
  (`packages/core/src/attention.mjs`, `reminderMessageIds`). A live-offered message with
  obligation `none` has nothing after the offer: if the transport accepted it and the model
  never saw it, it lives only in `acc inbox`.

## Compatibility constraint

`validateRecord` rejects an unknown event type and an unknown record field on read
(`packages/protocol/src/schema.mjs:140-160`), and the store validates every event it lists. A
new event type or a new receipt field would make ACC 0.7.0, running in the same workspace during
a managed update or from a second install, fail on its next `sync`. So this design:

- adds no event type. A repeat is another `message.offer_succeeded`, whose payload is an open
  object, with `repeat: true`;
- adds no receipt field. Offer facts go in the receipt's `extensions` object, which every
  version accepts and every receipt transition preserves by spreading the record;
- keeps `STORE_VERSION` at 6.

## Design

### 1. Offer facts on the receipt

`recordOfferSucceeded` writes, in the same transaction that moves a receipt to `offered`:

```json
"extensions": { "offer": { "transport": "codex-app-server", "at": "<timestamp>", "repeatedAt": null } }
```

`transport` is the safe transport name the router or hook already records in the success event.
A receipt offered by an older ACC has no `extensions.offer`; readers report `offer: null` for it.

### 2. Receipts on an exact history read

An exact read returns a top-level `receipts` array next to `items`, one entry per recipient,
sorted by `recipientParticipantId`:

```json
{ "recipientParticipantId": "codex", "state": "offered", "updatedAt": "<timestamp>",
  "offer": { "transport": "codex-app-server", "at": "<timestamp>", "repeatedAt": null } }
```

`updatedAt` is the time of the last state change. Any participant may read it: `sync --scope
full` already returns every receipt, and knowledge in a workspace is symmetric. Summary pages
are unchanged. The message record in `items` is unchanged, so the router, which reads a decision
back through the same call, keeps offering the record it offered before.

### 3. Unretrieved counts in status

Each participant row in `collectStatus` gets `unretrieved: { queued, offered }`: receipts
addressed to that participant in each state, current decisions only. `counts.unretrieved` holds
the same two numbers for the whole workspace. The text line appends
`; <n> offered, not retrieved` when that number is above zero. `queued` is reported beside
`offered` because a sender reading "0 offered" must be able to tell "nothing waits" from
"nothing was ever offered".

### 4. One repeat of a live offer

A direct message is **due for a repeat** for its recipient when all of these hold:

- the receipt is `offered`;
- `extensions.offer.transport` is a live transport, i.e. anything other than `next-turn`;
- `extensions.offer.repeatedAt` is `null`;
- at least `REPEAT_OFFER_AFTER_MS` (15 minutes) has passed since `extensions.offer.at`.

Fifteen minutes sits above the 90th percentile of the time models took to act on an offer.

`nextTurnDelivery` returns due messages as `repeatMessages`, after `queuedMessages`, and leaves
them out of `liveOfferedMessageIds` and `reminderMessageIds` for that call, so the projection
shows them the way it shows a queued message. The projector renders a repeat as a normal
untrusted peer block with one ACC-written line before the subject:

```text
repeat: offered via codex-app-server at <timestamp>; no retrieval recorded
```

Repeats come after new bodies, so the byte budget drops a repeat before a new message; a
dropped repeat stays due and gets the usual recovery line.

Only `beforeTurn` includes repeats. `turnEnd` continues a turn at the cost of a model call, and
a repeat is never a reason to do that.

When the hook's stdout carries a repeat, the same post-write commit that records next-turn
offers calls `recordOfferSucceeded` with `repeat: true`. In one transaction it checks that the
receipt is still due, sets `extensions.offer.repeatedAt`, and appends `message.offer_succeeded`
with `transport: "next-turn"` and `repeat: true`. A receipt that was retrieved, acknowledged or
already repeated in between is left unchanged and nothing is appended. The receipt stays
`offered`, so the repeat is an event, never a second message and never a state change.

Each receipt is repeated at most once. A model that already handled the message sees one
duplicate block labelled as a repeat. A Codex turn that outlasts the threshold can show the
repeat in the same turn the daemon runs the queued original; the label makes that visible.

### 5. Documentation

- `docs/CONCEPTS.md`: the sender can read receipts; offered is not read and retrieved is not
  model attention, next to the new fields.
- `docs/PROTOCOL.md`: `extensions.offer`, the repeat rule, the threshold, the event payload.
- `docs/CLI.md`: the exact history read's `receipts`, the status fields and text.
- `docs/ARCHITECTURE.md`: repeats in the projection order.
- Every shipped skill: one sentence for the sender (how to check a receipt) and one for the
  recipient (what a `repeat:` line means).
- The `acc_sync` MCP tool description names the receipts on an exact read.

## Testing

- Core: exact history read returns receipts with and without `extensions.offer`; status counts
  per participant and per workspace; `recordOfferSucceeded` writes offer facts; the repeat rule
  at, before and after the threshold, for next-turn, live, room, already repeated, retrieved and
  acknowledged receipts; a repeat commit that lost a race appends nothing.
- Projector: the repeat line renders inside the untrusted block and is escaped like any header;
  repeats lose the budget before new bodies.
- Hook runner: `beforeTurn` commits a repeat after stdout; `turnEnd` never continues for one.
- Compatibility: a store written by this version validates under the 0.7.0 schema.
