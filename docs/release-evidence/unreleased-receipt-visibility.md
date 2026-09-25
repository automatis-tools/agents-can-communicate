# Unreleased receipt visibility for the sender

Issue #134. A sender learned a message's delivery state once, in the send result. This shows
every recipient's receipt on an exact history read, counts what each participant has not
fetched in `status`, and repeats a live offer that nothing followed, once, through the next
turn.

## What real stores held

Every workspace store on the maintainer's machine, read without writing, 2026-09-25, 109
receipts after the 0.7.0 prune:

| State | Receipts |
|---|---|
| `acknowledged` | 69 |
| `queued` | 32 |
| `retrieved` | 5 |
| `offered` | 3 |

The three `offered` receipts are answers with obligation `none`, offered live: one through
`claude-channel`, two through `codex-app-server`. After a successful offer, the first retrieval
or acknowledgement came at a median of 36 seconds, a 90th percentile of 14 minutes and a
maximum of 24 minutes, over 49 pairs. The 15-minute repeat threshold sits above that 90th
percentile.

## What a sender now sees

```json
{ "scope": "history", "view": "message", "items": [ "<the message>" ],
  "receipts": [ { "recipientParticipantId": "beta", "state": "retrieved",
    "updatedAt": "2026-09-25T05:09:05.276Z",
    "offer": { "transport": "codex-app-server", "at": "2026-09-25T05:09:04.060Z",
      "repeatedAt": "2026-09-25T05:25:04.196Z" } } ],
  "nextCursor": null }
```

`acc status`, while that receipt was still offered:

```text
2 live; 0 claim(s); protection none; 1 offered, not retrieved
```

## Why a next-turn offer is never repeated

The skill tells a model that a body already in its context is complete and that fetching it
again buys nothing, so `offered` without `retrieved` is the normal end of a message delivered
with its body. A next-turn offer is recorded only after the hook's output carried that body. A
live offer proves that a transport accepted the bytes. Only a live offer is repeated, once, and
only before a turn: an end-of-turn continuation costs a model call, and a repeat never buys one.

## Mixed versions

An older ACC validates every event type and every receipt field on read. A new event type or a
new receipt field would therefore make 0.7.0, running in the same workspace during a managed
update or from a second install, fail on its next `sync`. Offer facts are written to the
receipt's `extensions`, and a repeat is another `message.offer_succeeded` whose payload carries
`repeat: true`. `STORE_VERSION` stays 6.

Checked with the published package, not with this tree's schema: `npm pack
agents-can-communicate@0.7.0`, run against a store this build wrote, with a live offer and its
repeat recorded through the branch's core:

```text
0.7.0  sync --scope full events: ["workspace.materialised","session.opened","session.opened",
       "message.recorded","message.offer_succeeded","message.offer_succeeded(repeat)"]
0.7.0  receipt: {... "state":"offered", "extensions":{"offer":{"transport":"codex-app-server",
       "at":"2026-09-25T05:09:04.060Z","repeatedAt":"2026-09-25T05:25:04.196Z"}}}
0.7.0  status counts: {"live":2,"stale":0,"claims":0,"messages":1}
0.7.0  inbox --message receipt: {... "state":"retrieved", "extensions":{"offer":{...,
       "repeatedAt":"2026-09-25T05:25:04.196Z"}}}
branch history receipts: [{"recipientParticipantId":"beta","state":"retrieved", ...,
       "offer":{"transport":"codex-app-server", ..., "repeatedAt":"2026-09-25T05:25:04.196Z"}}]
```

0.7.0 read every event and receipt, and its own transition to `retrieved` kept the offer facts,
because every receipt transition spreads the record it replaces.

## Limits

- A receipt offered by an older ACC has no offer facts. It reads as `offer: null` and is never
  repeated.
- A Codex turn that outlasts the threshold can show the repeat in the same turn the daemon runs
  the queued original. The `repeat:` line makes that visible to the model.
- A model that already handled a live-offered message it never acknowledged sees one
  duplicate block, labelled as a repeat.
- A repeat is recorded once per receipt. As with a first offer, two sessions of one participant
  can both show it before either commits, and a hook that runs out of time after writing does
  not commit it.
- The status suffix counts every offered receipt, including next-turn offers of notes that
  were shown whole and never fetched. That is what `offered` means; the exact history read
  names the transport.

## Exact local artifact

- Source: clean commit `11a7f535346d1bd67735a1b19ddc8af27cc82843`.
- Archive: `agents-can-communicate-0.7.0.tgz`, packed from that commit.
- Size: 468,803 bytes; 311 packed entries.
- SHA-256: `251c182236046e2a3b3db7816a1830f3eb76a09e7535793c08043df1a6ff6fac`.
- Package version remains `0.7.0`; this is an unpublished development artifact.
