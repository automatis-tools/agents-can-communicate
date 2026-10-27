# Inbox reads without the backlog

Date: 2026-10-27. Issue #306, epic #303. The maintainer chose to keep ACC 0.12.x writers that
share a data home correct (a separate `indexes/v2`).

## Why

An exact inbox read and a page both list every message and every receipt in the workspace,
then keep the reader's. A hook that reads one message therefore reads the whole backlog
addressed to other participants, and the reader's own acknowledged history. The 2026-10-13
analysis counted 63 and 603 primary reads to return one item from 30 and 300 messages; the #304
probe counts 68 and 608 for 30 reader messages beside a backlog of 0 and 270.

## What changes

### Exact retrieval

The target's identities are known: the message id and the reader. The read loads the reader's
session, the message and the reader's receipt for it by id. A decision needs its decision group
for its status, so for a decision the read also loads every decision (below). Nothing else is
read.

### Pages

A page needs the reader's listable messages, newest first. Two new transaction indexes select
them:
- `receiptsByRecipientState`: receipts by workspace, recipient and state. A page looks up the
  reader's `queued`, `offered` and `retrieved` receipts. Acknowledged history is never read.
- `messagesByKind`: messages by workspace and kind. A page and an exact read of a decision look
  up every decision, because a decision's status depends on its whole group, whoever it was
  addressed to.

The page loads those receipts, their messages and the decisions by id. A cursor names a message
that may have been acknowledged since the last page, so the page loads it and the reader's
receipt for it by id, as the anchor; the anchor must still be addressed to the reader. The rest
of the page - filtering, order, the byte budget, the summaries - is `messagePage` as before.

A read without a message id, which retrieves every listable message, uses the same selection.

### The index cache moves to `indexes/v2`

ACC 0.12.x accepts an index manifest only in `indexes/v1`, with exactly its two indexes. A
manifest there with four would be refused, rebuilt with two by the older writer, and refused
again by the newer one. The new index set therefore lives in `indexes/v2`, with its own pages,
manifest and reclaim progress:
- An older writer never touches `indexes/v2`. Its commits advance the journal generation, so
  the next newer reader finds the v2 manifest stale and rebuilds it from the primary records.
  It is never read stale.
- The newer version neither reads nor writes `indexes/v1`. An older reader finds v1 stale and
  rebuilds it, as it does after any writer that does not know the cache.
- `indexes/v1` stays on disk while any older version may use it.

`indexVersion` in the v2 manifest is 2, and its roots are exactly the four indexes.

## Index paths

Every lookup already takes one of four paths, and each must stay correct:
- **warm**: a valid manifest; the lookup reads index pages and verifies each record it selects;
- **cold**: no manifest; the lookup rebuilds every index from all message and receipt records,
  publishes the cache, and answers from it;
- **rebuilt**: a stale manifest, after a writer that does not maintain v2; the same rebuild;
- **unavailable**: the rebuilt cache cannot be published; the lookup answers from the tree it
  built in memory, and the next lookup rebuilds again.

Cold, rebuilt and unavailable lookups read the whole workspace once, as every read does today.
The saving is on the warm path, which a workspace reaches after its first lookup.

## Measurement

The #304 inbox probe gains `index`: `warm` (the default), `cold`, `rebuilt` or `unavailable`.
Before each call it removes the v2 manifest, makes it stale, or arranges that publication fails,
so each path's cost is measured on its own. The baseline has no v2 cache, and the setting changes
nothing for it.

## Not in scope

- Read-only transactions that enumerate the event history: #307.
- Narrowing the decision group to the decisions connected to the reader's. It needs an index of
  decision targets, and decisions are a small share of messages.
- Removing `indexes/v1`.
