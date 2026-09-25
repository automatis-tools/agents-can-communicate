# Unreleased store retention and operator cleanup

Issue #133. A workspace store grew for as long as it was used and offered no way to get
anything back. This adds one reclaim rule, one bounded automatic pass for what is provably
unread, and one operator command for everything that carries meaning.

## What a real store looked like

One workspace on the maintainer's machine, measured 2026-09-24:

| Area | Files |
|---|---|
| `events/` | 876 |
| `journal/` | 2,381 |
| `retained/` | 9,628 |
| `state/` | 511 |
| `tmp/` | 754 |
| **total** | **14,150** |

6.3 MB of content. The occupied space is far larger, because 14,150 files of a few hundred
bytes each cost a filesystem block apiece: `du` reported 56 MB.

Three findings from the code, each checked by following every reference:

- `retireJournalEntry` calls `retainFile`, which by construction never unlinks, so a completed
  transaction entry was kept forever. All 2,381 were completed; `retained/journal` held a
  matching completion marker for every one.
- `completeJournal` writes those markers and **nothing reads them**. The same shape as the
  accepted stage in issue #192: written in one place, read in none.
- `listState` reads a record and then asks whether its generation has a deletion marker, so
  removing records through `tx.remove` would add a file and make listings slower.

## After

The same store, on a copy, after `acc prune --apply` and `acc doctor --repair`:

| Area | Before | After |
|---|---|---|
| `events/` | 876 | 876 |
| `journal/` | 2,381 | 2 |
| `retained/` | 9,628 | 207 |
| `state/` | 511 | 351 |
| `tmp/` | 754 | 1 |
| **total** | **14,150** | **1,437** |

The two remaining journal files are the active-journal authority pair, which is not an entry.
The one remaining `tmp/` file is a partial from a failed publication, which issue #192
established is evidence and is never removed. `events/` is untouched because no boundary was
named: history is trimmed only when an operator names a cursor.

The reporting run named 47 sessions, 11 intents, 80 claims and 22 participants, and changed
nothing. Applying it reclaimed 194 files. Afterwards the store still reads: one live
participant, 70 messages, no live claims, and no leftover detached directory.

## What runs without being asked

A retired journal entry has no reader, and a superseded ephemeral marker is skipped by the only
function that looks at them, so a bounded pass reclaims both when a store is opened - the daily
pass issue #192 added, under the same writer mutex and sharing one budget. A pass that stops at
its budget leaves its marker unwritten, so the next open carries on rather than waiting out the
interval.

Everything else waits for `acc prune`, which reports and changes nothing without `--apply`.

## What is deliberately refused

- A `stale` session. Only `offline` qualifies - a confirmed dead pid, or 24 hours of silence -
  because a quiet session is still someone's.
- A claim renewed between the report and the apply. Eligibility is read outside the writer mutex
  and applied inside it, so every entry carries the envelope generation that proves it is still
  the record that was judged. A changed record is skipped, not removed.
- A participant named on a surviving message, because the roster is where "who sent this" is
  answered.
- A message anyone is still owed. A receipt that is `queued`, `offered` or `retrieved` keeps its
  message: offered is not read, and retrieved is not model attention.
- The workspace record, in every case.

## The history boundary

`--before` takes a 16-digit cursor, the same one `sync` returns. The floor is raised before a
single event file moves, because a floor ahead of the trim reports a boundary for events still
present - which costs a reader nothing - while a trim ahead of the floor is a silent gap.

Only an empty events directory consults the floor, so the path every transaction runs pays
nothing for retention. A log trimmed away entirely is the case the floor exists for: without it
the sequence would restart at 1 and hand out a number a peer already holds a cursor for. A test
covers exactly that.

## What the review caught

The pull-request review found three holes that no test here had, each confirmed against the code
before it was changed:

- A publication that began before the sweep swapped `stage/` aside failed a write whose bytes
  were already linked into place. This is what failed on macOS in CI - a race, not a flake.
- Eligibility is relational: a participant is eligible because no session of theirs survives. A
  session opening between the report and the apply changes that answer without changing any
  record the report named, so an entry's generation cannot catch it. The decision is now taken
  again inside the writer mutex.
- A session holding a live claim was removed, leaving the claim reading as owned by nobody - and
  that name is how a peer blocked by the claim finds someone to ask.

A fourth: a 16-digit sequence reaches past `Number.MAX_SAFE_INTEGER`, so allocating from a floor
that high would repeat a sequence a peer already holds a cursor for. The store refuses instead.

## Limits

An ACC older than this release does not know about `trimmedThrough`. Served a cursor below the
boundary it returns what it can find, without reporting that anything is missing. That is why
trimming history is an explicit operator act and never automatic, and why the command says so.

Trimming is not reversible. The dry run is the default for that reason.

## Exact local artifact

- Source: clean commit `d60d2f650845ab90d9fd273909991273fa78a536`.
- Archive: `agents-can-communicate-0.6.3.tgz`, packed from that commit.
- Size: 464,209 bytes; 311 packed entries.
- SHA-256: `d60d2f650845ab90d9fd273909991273fa78a536256`.
- Package version remains `0.6.3`; this is an unpublished development artifact.

`npm test` on this tree: 2,533 passing, 0 failing, 1 skipped, of 2,534.
