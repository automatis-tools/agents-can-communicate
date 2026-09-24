# Store retention: operator cleanup and a bounded automatic reclaim

Issue #133. A workspace store grows for as long as it is used and offers no way to get anything
back. This design gives the store one reclaim rule, one automatic pass for what is provably
unread, and one operator command for everything that carries meaning.

## Problem

A workspace that runs for days accumulates records that nothing will read again. Sessions that
stopped answering are classified `offline` and hidden from `status`, but their records, their
intents and their expired claims stay. The event log grows by one file per event and is listed in
full by every read and by every write. Nothing retires a completed transaction journal.

There is no operator command that retires an offline participant, drops expired claims, or trims
history to a chosen point. A user who wants a clean roster has to delete files the store owns,
which `docs/SECURITY_MODEL.md` forbids and which would leave the journal and the retention
markers describing records that are no longer there.

## Evidence

One workspace on the maintainer's machine, measured 2026-09-24 against a copy of the live store:

| Area | Entries | Live |
|---|---|---|
| `state/session` | 45 | 1 |
| `state/claim` | 256 | 0 |
| `state/intent` | 12 | 2 |
| `state/participant` | 38 | - |
| `state/message` | 70 | - |
| `events/` | 870 | - |
| `journal/` | 2,334 | 1 at most |
| `retained/` | 9,581 | - |
| total | | 52 MB |

Four findings from the code, each checked by following every reference:

- `retireJournalEntry` calls `retainFile`, which by construction never unlinks. A completed
  journal entry is therefore kept forever. `readOpenJournals` reads the single active-journal
  pointer and never lists the directory, so those 2,334 entries cost no read - they are disk.
- `completeJournal` writes `retained/journal/<transactionId>.json`, and nothing reads it. This is
  the same shape as the accepted stage in issue #192: written in one place, read in none.
- `nextSequence` lists every file in `events/` on **every transaction**, and `eventsSince` lists
  them again on every read. This is the growth that reaches a reader.
- `listState` reads a record file and then asks whether its generation has a deletion marker. A
  marker-based deletion therefore adds a file and makes the listing slower.

That last point is the constraint the whole design turns on.

## Principle

**In this store, deleting and reclaiming are opposite operations.** `tx.remove` publishes an
append-only marker under `retained/`; the record stops being visible and the store grows. Getting
space back means the bytes and their markers both have to go.

Two rules follow, and the design does not depart from either:

1. **Never unlink a live name.** Node exposes `unlink` only by pathname, so a checked parent can
   be replaced between the check and the call. Reclaiming moves doomed entries into a detached
   directory with `rename` and then discards that directory whole - the method issue #192
   established and shipped.
2. **Automatic only for what is provably unread.** A completed journal entry and a superseded
   ephemeral marker have no reader; a pass may remove them without asking. Participants, claims,
   messages and history carry meaning, and a coordination tool that silently forgets what happened
   stops being evidence. Those wait for an operator.

## Design

### The reclaim primitive

One operation, used by every area:

1. Under the writer mutex, create a detached directory under `tmp/`, named uniquely.
2. `rename` each doomed entry into it, counting each move against a budget.
3. `rename` nothing else; a live name is never removed in place.
4. Discard the detached directory whole.

A crash at any point leaves either the entry where it was or a detached directory that the next
pass discards. Readers do not take the writer mutex, but they never observe a missing *directory*
- only an entry that vanished between listing and reading, which `readJsonIfPresent` already
answers with `null` and every caller already skips.

A directory rebuild - build the survivors aside, then swap - was considered and rejected. Swapping
needs two renames, and between them `state/` does not exist. Readers take no mutex and
`listDirectoryEntries` answers `ENOENT` with an empty list, so the store would briefly read as
*empty* rather than as busy. Moving doomed entries out has no such window.

### What the automatic pass reclaims

The daily pass that issue #192 added already runs under the writer mutex on store open, is bounded
per pass, and records only a finished pass so a budget-limited one stays due. It gains two classes:

- **Completed journal entries.** `journal/<transactionId>.json` whose completion marker exists,
  and the completion marker itself. Neither has a reader.
- **Superseded ephemeral markers.** Every marker under `retained/ephemeral/<kind>/<id>/` except
  the newest. `latestEphemeralMarker` reads only the newest and lists the rest to find it, so
  removing them is both safe and a direct read win.

Nothing else is automatic. The pass keeps its existing budget, and the two new classes share it.

### What the operator command reclaims

`acc prune`. **It reports and changes nothing unless `--apply` is given** - a destructive operator
command defaults to the dry run, rather than offering one. The dry run lists, per class, what
would go.

| Class | Eligible when | Flag |
|---|---|---|
| Sessions | presence is `offline` | `--sessions` |
| Intents | their session is eligible | with sessions |
| Claims | expired | `--claims` |
| Participants | every session of theirs is eligible and none is live | `--participants` |
| Events | sequence at or below a boundary | `--history-before <cursor>` |
| Messages and receipts | resolved and below the same boundary | with `--history-before` |

No flag means every class. Each eligible record is removed with its retention markers, so the
record and its bookkeeping leave together.

A message is **resolved** when every receipt for it is `acknowledged`, or its recipient no longer
exists in the store. Anything less is unresolved and stays.

The boundary is a cursor, not a date. A cursor is what `sync` already returns and what a peer
already holds, so an operator trimming to one is naming the same point its readers name. A
duration would have to be resolved to a sequence anyway, and the resolution could move between
the dry run and the apply.

Safety rules, refused rather than skipped, so a mistake is loud:

- A live or stale participant, session or claim is never removed. Only `offline` qualifies, which
  is 24 hours without a heartbeat, or a confirmed dead pid.
- A message is never removed while any receipt for it is `queued` or `offered` and its recipient
  still exists. Offered is not read; removing it would lose a message a model never saw.
- The `workspace` record is never removed.
- A participant is kept while any message attributes work to it and that message survives, so the
  roster can still answer who sent what.

### The history boundary

Trimming events needs a floor, because `nextSequence` derives the next sequence from the last file
present. Trimming the oldest events is safe on its own, but an emptied directory would restart the
sequence at 1 and collide with a cursor a peer still holds.

A `retention` record stores `trimmedThrough`, the highest sequence removed. It is read by:

- `nextSequence`, which starts above `max(last event, trimmedThrough)`;
- `eventsSince`, which, when the caller's cursor is at or below `trimmedThrough`, returns the
  events it still has **and** reports `trimmedThrough` so the caller knows its cursor preceded the
  boundary. A short read is never presented as a complete one.

`sync` carries that field through to its caller. This is the "reads after the trim are consistent
and report the trim boundary" requirement in issue #133.

### Reporting

`acc doctor` reports the counts this design acts on: eligible sessions, expired claims, completed
journal entries, superseded markers, and the current `trimmedThrough`. A store carrying an
accumulation says so before anyone asks.

### Documentation

One page states the numbers an operator needs to predict what `prune` will do, because they are
currently spread across the code and three documents: the presence limit that makes a session
`offline` (24 hours without a heartbeat, or a confirmed dead pid), the claim lease default (30
minutes), the automatic pass and what it may reclaim, and every `acc prune` flag with its
default. `docs/CLI.md` gains the command; the numbers live with it and the other documents link
there rather than restating them.

## Compatibility

No store layout version is introduced and nothing refuses to open a store. The `retention` record
is additive; a store without one reads as `trimmedThrough: null`, which is what every existing
store is.

One asymmetry is deliberate and has to be stated: an **older ACC** reading a pruned store does not
know about `trimmedThrough`. It will serve a cursor below the boundary by returning the events it
can find, without reporting that anything is missing. Pruning history is therefore an explicit
operator act, never automatic, and the command says so in its output.

## Security

Reclaiming runs inside the store, under the writer mutex, through the same publication path as
every other write. It does not widen what a caller may address: every path is validated against
the managed root exactly as `assertManagedDirectory` already requires, and no entry outside the
store's own directories is ever renamed or discarded.

`acc prune` acts on the workspace the caller resolves, never on another, and never on a store it
did not open.

## Testing

- The automatic pass reclaims completed journal entries and superseded markers, leaves the active
  journal and the newest marker, and respects its budget.
- A budget-limited pass stays due, as issue #192 established.
- Each safety rule refuses: a live session, a stale session, a live claim, a message with a queued
  or offered receipt, the workspace record.
- The dry run changes nothing - byte-for-byte, the store is identical afterwards.
- A cursor at or below `trimmedThrough` is answered with the boundary reported.
- `nextSequence` does not reuse a sequence after every event is trimmed.
- Crash points through the existing `failAt` seam: after the detached directory exists, after some
  entries moved, before the discard.
- A copy of a real store is pruned and still reads: participants, messages, claims and events that
  survived are all readable, and the reclaimed count matches what the dry run predicted.

## Out of scope

- A retention *policy* that runs on a schedule. Thresholds are command flags with documented
  defaults; nothing trims history on a timer.
- Compacting the event log into segments. Trimming by boundary is enough for the growth measured
  here, and segmentation would change the cursor contract.
- Quarantining corrupt records. `docs/design` and the store both take the position that repair
  refuses to move a corrupt record, and this design does not reopen it.

## Risks

- **History a peer still needed.** A peer offline longer than the boundary loses the events it had
  not read. The boundary is explicit, the dry run shows the count, and `trimmedThrough` makes the
  loss visible rather than silent.
- **A prune during active work.** The writer mutex serialises the pass against writers, but a
  long-running reader can still observe entries leaving. Every reader already tolerates a record
  that disappears between listing and reading; the tests exercise it deliberately.
- **An older ACC on a pruned store.** Stated above. It reads short without saying so, which is the
  strongest argument for keeping history pruning manual.
