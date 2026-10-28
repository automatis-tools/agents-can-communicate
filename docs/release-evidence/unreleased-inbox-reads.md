# Development evidence: inbox reads without the backlog

Captured on October 27, 2026, in the evening (Toronto time), on macOS 27.0.1 arm64 (Apple M5
Max, 18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for
#306. It was not published, and the package version remains `0.12.2`.

## What changed

An exact inbox read and a page listed every message and every receipt in the workspace, then
kept the reader's. They now load the reader's own records:
- an exact read loads the reader's session, the message and the reader's receipt for it by id,
  and, for a decision, the decisions of its group;
- a page selects the reader's receipts that can still be listed through the new
  `receiptsByRecipientState` index, and walks each decision group through `decisionsByTarget`.

The two indexes live in a new cache, `indexes/v2`, and the change is store contract 8. ACC 0.12
refuses a cache with other indexes, and two caches written by two versions would each go stale
at every write of the other, so the versions never share a store. As with contract 7, the
activation of the new runtime waits until no live process holds contract 7. Then ACC migrates
each store by itself:
- it writes the message obligation into each note its reader has retrieved;
- it builds `indexes/v2` and removes `indexes/v1`;
- it switches the store identity last.

## Correctness

- **Real stores.** The maintainer's 63 stores were copied, then read twice per store:
  - Readers: the published 0.12.2 on one copy at contract 7, and this branch on another copy
    after its own migration.
  - Clock and ids: the same fake clock and the same ids on both sides.
  - Reads: for every recipient of every receipt (2,454 receipts), a session was opened, every
    page was read, then each of the recipient's messages exactly, then every page again.
  - Result: all 63 results were byte-identical, and every message file kept its bytes. The
    largest store (502 messages, 1,311 receipts, 71 recipients) took 256 s to read with 0.12.2
    and 87 s with this branch. That includes the exact reads, whose cost does not depend on
    the backlog.
- **Upgrade from 0.12.2.** An isolated install of the published 0.12.2 had a contract-7 store,
  and its live MCP server held contract 7. That install updated itself to this branch, packed
  as 0.12.99, through a local registry:
  - While the holder ran, `acc update` and `acc doctor` named it, and the store stayed on 7.
  - `acc doctor --migrate-store` refused the migration (exit 5) until 0.12.99 was active.
  - After the holder exited, the next command activated 0.12.99 and migrated the store, in 0.8 to
    1.4 s over four runs.
  - `indexes/v1` was removed and `indexes/v2` built.
  - The message files kept their bytes. The retrieved note gained only its obligation, and
    every other receipt kept its bytes.
  - Each inbox listed what 0.12.2 listed, and a replaced decision read exactly still named its
    successor.
  - 0.12.2 code then refused the store (exit 4, `unknown store version`).
- **Review.** A fresh reviewer compared the new inbox code with the code before over 14 random
  seeds: every kind, chains of replaced and withdrawn decisions, room messages, kind filters,
  cursors on acknowledged messages and the four index paths. Every page chain matched, with
  the same items, order, decision status, byte budget, `nextCursor` and errors. A 6,000-step
  property test of the ID groups crossed the inline and page bounds both ways. The four defects
  the review found are fixed: the receipt backfill flushes its bytes, the explicit migration
  waits for the new runtime, a condemned cache is removed within the sweep's budget, and the
  hook's fail-open line names no contract.

## Activation on the maintainer's machine

The candidate's activation check, read from a copy of the maintainer's data home, finds four
blockers for contract 8: the Codex app-server daemon, two Claude Code sessions and Codex in
ChatGPT.app. All four are live clients that hold contract 7. No binding without a process,
no reused process id and no zombie holds the activation.

The migration of the largest store took 2.8 to 3.6 s on a copy, at a load average of 8 to 13. It
verifies 6,702 events and 3,857 records and writes 533 index pages, which is what the 6-to-7
migration did too.
Only 40 of its 1,311 receipts are rewritten. Before the review, every receipt was, and that cost
8 to 12 s.

## Comparison

`node scripts/measure/run.mjs --probe inbox` compared two sides under the same conditions:
- the baseline, `main` at `0eb0d3d3` before this change, exported and installed apart;
- the candidate, this branch at `d65c9ac8`, exported and installed apart.

The fixture held 30 messages to the reader, mixing notes, questions and decisions in every
receipt state, beside a backlog of 0 or 270 messages to another participant. Exact reads each
read a message not read before; pages had a limit of 1. The `index` setting put the cache in each
path before every call: `warm`, `cold` (no manifest), `rebuilt` (a stale manifest) or
`unavailable` (the manifest cannot be published). The baseline keeps no such cache, and the
setting changes nothing for it.

Each run alternated the sides over 10 rounds, with 3 warm-up calls and 10 timed calls per child,
which gives 100 samples per side and scenario. All 320 children validated every call, both sides
built the same fixture in every scenario, and every scenario was labelled a **benchmark**. The
load average was between 3.2 and 19.5.

The medians are in milliseconds. The paired ratio is the candidate's median over the baseline's
in each round; the table gives the median of the 10 ratios and their range. Reads are the
primary records one call read, then the index pages.

| Call | Backlog | Index | Baseline | Candidate | Paired ratio | Records read | Pages read |
|---|---:|---|---:|---:|---:|---|---:|
| exact | 0 | warm | 34.19 | 31.77 | 0.934 (0.471-1.097) | 68 → 4 | 11 |
| exact | 0 | cold | 33.86 | 29.21 | 0.890 (0.416-1.238) | 68 → 68 | 13 |
| exact | 0 | rebuilt | 33.40 | 29.31 | 0.908 (0.659-1.270) | 68 → 68 | 13 |
| exact | 0 | unavailable | 31.98 | 29.52 | 0.917 (0.634-1.238) | 68 → 68 | 6 |
| exact | 270 | warm | 61.47 | 35.32 | 0.568 (0.452-0.664) | 608 → 4 | 5 |
| exact | 270 | cold | 60.77 | 38.28 | 0.597 (0.466-0.673) | 608 → 4 | 0 |
| exact | 270 | rebuilt | 62.65 | 40.02 | 0.597 (0.443-0.701) | 608 → 4 | 0 |
| exact | 270 | unavailable | 60.85 | 39.99 | 0.600 (0.505-0.763) | 608 → 4 | 0 |
| page | 0 | warm | 5.43 | 5.64 | 1.040 (1.016-1.054) | 68 → 52 | 5 |
| page | 0 | cold | 5.45 | 10.09 | 1.863 (1.803-1.928) | 68 → 116 | 14 |
| page | 0 | rebuilt | 5.47 | 10.22 | 1.858 (1.717-1.897) | 68 → 116 | 14 |
| page | 0 | unavailable | 5.49 | 9.67 | 1.757 (1.692-1.797) | 68 → 116 | 10 |
| page | 270 | warm | 32.45 | 5.63 | 0.174 (0.171-0.201) | 608 → 52 | 5 |
| page | 270 | cold | 32.57 | 44.19 | 1.360 (1.332-1.393) | 608 → 656 | 112 |
| page | 270 | rebuilt | 32.55 | 44.68 | 1.372 (1.334-1.396) | 608 → 656 | 112 |
| page | 270 | unavailable | 32.56 | 43.47 | 1.333 (1.300-1.355) | 608 → 656 | 108 |

On the warm path, which every read takes while the cache follows the journal, a read no longer
grows with the backlog:
- A page reads the same 52 records beside 0 or 270 other messages, and takes 5.6 ms both times,
  where the baseline took 5.4 and 32.5 ms.
- An exact read of a message reads its session, the message and its receipt. A decision also
  reads its group. Beside 270 other messages it reads 4 records instead of 608, and its time is
  mostly the receipt's own write.

Exact reads beside no backlog (0.89 to 0.93) and the other exact rows are shown with their wide
ranges: their time is mostly the flushes of the receipt they move.

A cold, rebuilt or unavailable page reads every record once, as the baseline does on every
call. It then builds the index and publishes it, which costs 4.6 ms more beside no backlog and
12 ms more beside 270 messages. After a cold or rebuilt call the cache is published and the next
call is warm. An unavailable cache, as in a client sandbox that keeps the data home read-only,
is rebuilt once per process and journal generation. The probe lets every page publish and fails
only the manifest, so it measures more writes than a read-only data home allows.

The first measurement of this branch, at `b87b2304`, read the selected records one after another
and built each rebuilt tree one key at a time. Its small warm page took 10.5 ms against 5.5 ms,
and its cold pages 2.2 to 3.1 times the baseline. `d65c9ac8` reads sixteen records at a time, as a
listing does (#298), and builds a rebuilt tree in one pass.

The p95 values come from exactly 100 samples per side; the reports leave p99 out as insufficient
evidence. Each report has them, with the load around each child in its `run.json`:
- [exact reads](inbox-reads-2026-10-27/inbox-exact/report.md)
- [pages](inbox-reads-2026-10-27/inbox-page/report.md)

## Package

`node scripts/verify-package.mjs` built `agents-can-communicate-0.12.2.tgz` from `d65c9ac8`:
627,901 bytes, 380 entries, sha256
`a30407e9a95ea41292f1ad949cb4190baee4062c9812135ab91f82fe3a62a2b4`. It passed package
verification, including doctor, a workspace without Git, and install with uninstall.

## Limits

- One machine was measured, under load. Compare within a run, never across runs.
- The probe measures function calls in a fresh process, not hook end-to-end latency.
- Read-only transactions that enumerate the event history are #307.
