# Inbox reads without the backlog

Date: 2026-10-27. Issue #306, epic #303. The maintainer's decisions:
- ACC 0.12.x processes must never be slowed or misled by the change;
- an index cache shared by two formats must not live on forever: the change ends in one cache,
  through a migration;
- the migration is automatic.

## Why

An exact inbox read and a page both list every message and every receipt in the workspace,
then keep the reader's. A hook that reads one message therefore reads the whole backlog
addressed to other participants, and the reader's own acknowledged history. The 2026-10-13
analysis counted 63 and 603 primary reads to return one item from 30 and 300 messages; the #304
probe counts 68 and 608 for 30 reader messages beside a backlog of 0 and 270.

## Store contract 8

The change is store contract 8. Contract 7's index cache, `indexes/v1`, holds two indexes, and
ACC 0.12 refuses a manifest there with any other set. Two caches written by two versions would
each go stale at every write of the other, so the versions do not share a store:
- `STORE_VERSION` becomes 8. A runtime declares the contract it speaks, and the activation of a
  contract-8 runtime waits until no live process holds contract 7, as every contract change does.
- Right after the activation, and on every later worker pass, the existing automatic store
  upgrade migrates each contract-7 (or 6) store that no live older client holds, under the
  admission mutex. `acc doctor --migrate-store` does the same by hand. A hook never migrates.
- A contract-8 store is refused by older ACC, and a contract-7 store by this one until it is
  migrated, with `store_migration_required`.

The migration, under the writer mutex: finishes decided journals, verifies every primary record
and event, writes each receipt's message obligation into it (below), builds the complete
`indexes/v2` cache, removes `indexes/v1`, and durably switches the identity last. A migration
interrupted before the switch leaves a contract-7 store, and the next pass starts again.

## What changes

### Exact retrieval

The target's identities are known: the message id and the reader. The read loads the reader's
session, the message and the reader's receipt for it by id. A decision needs its decision group
for its status, so for a decision the read also walks that group (below). Nothing else is read.

### Pages

A page needs the reader's listable messages, newest first. Two new transaction indexes select
them:
- `receiptsByRecipientState`: receipts by workspace, recipient and state, for the receipts that
  can still be listed. An acknowledged receipt never can, and neither can a note the reader has
  retrieved, so neither is in the index: its groups follow what is waiting, not the history. A
  receipt keeps its message's obligation in `extensions.obligation` for this. The migration
  writes it into every receipt, and a retrieval writes it into any receipt still without it. A
  receipt without one stays in the index while retrieved, since it may still be listable.
- `decisionsByTarget`: for each decision, one key per decision it replaces or withdraws. A
  decision's status depends on its whole group - the decisions it names and the ones that name
  it, to any distance, whoever they were addressed to. The page walks each group from the
  reader's decisions: named decisions by id, naming ones by this index. No other decision is read.

The page loads those receipts, their messages and their decision groups by id. A cursor names a
message that may have been acknowledged since the last page, so the page loads it and the
reader's receipt for it by id, as the anchor; the anchor must still be addressed to the reader.
The rest of the page - filtering, order, the byte budget, the summaries - is `messagePage` as
before.

A read without a message id, which retrieves every listable message, uses the same selection.

### What read surfaces show

`extensions.obligation` is ACC's bookkeeping for the index, and a page counts the bytes of every
receipt it carries. Every receipt a service operation returns - inbox pages and reads,
acknowledgements, replies, receipt reads and offers - and `sync --scope full` therefore leave it
out, and a receipt with nothing else in `extensions` shows none, exactly as before.

## The `indexes/v2` cache

The cache holds four indexes: `messageByClientKey` and `receiptsByMessage` as before, and the
two above. Its manifest has `indexVersion` 2 and exactly those roots.

### Groups

An index maps a tuple to the group of record IDs under it.
- A group of up to eight IDs is written into its leaf entry, so the many tuples with one or two
  records each - a client key, a message's receipts, a decision's successors - cost no page of
  their own. In contract 7 every group was a page, and a cold rebuild of 5,000 messages wrote
  about 11,000 of them.
- A larger group is a page, and beyond 32 IDs it branches on the digest of each ID, like the
  tuple tree, so a change copies only the route to that ID. As a chain of content-addressed pages
  it rewrote every page in front of the change: a group of 4000 cost 184,460 page writes to
  build. A queued group grows that large for a participant whose session has ended.
- A rebuilt tree keeps only its reachable pages.

### Lookups

A store instance keeps the manifest it validated and the pages it decoded for the journal
generation they belong to; pages are content-addressed and never change. A walk over a long
decision chain therefore makes one lookup per decision from memory, where each lookup read the
manifest and its roots again.

Every lookup takes one of four paths, and each must stay correct:
- **warm**: a valid manifest; the lookup reads index pages and verifies each record it selects;
- **cold**: no manifest, after a prune or a damaged cache; the lookup rebuilds every index from
  all message and receipt records, publishes the cache, and answers from it;
- **rebuilt**: a stale manifest; the same rebuild;
- **unavailable**: the rebuilt cache cannot be published, as in a client sandbox that keeps the
  data home read-only; the lookup answers from the tree it built in memory, and the store keeps
  that tree for its generation, so a page's four lookups rebuild once.

Cold, rebuilt and unavailable lookups read the whole workspace once, as every inbox read does in
contract 7. The saving is on the warm path. An exact read of anything but a decision makes no
lookup at all.

## Measurement

The #304 inbox probe gains `index`: `warm` (the default), `cold`, `rebuilt` or `unavailable`.
Before each call it removes the v2 manifest, makes it stale, or arranges that publication fails,
so each path's cost is measured on its own. The baseline keeps no v2 cache, and the setting
changes nothing for it.

## Not in scope

- Read-only transactions that enumerate the event history: #307.
- Running contract 7 and 8 side by side: the activation rule prevents it.
