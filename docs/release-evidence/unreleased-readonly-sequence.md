# Development evidence: reads without the event log

Captured on October 27, 2026, late in the evening (Toronto time), on macOS 27.0.1 arm64 (Apple
M5 Max, 18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for
#307. It was not published, and the package version remains `0.12.2`.

## What changed

Every transaction found the next event sequence before its callback ran. To find it, the
transaction listed the whole `events/` directory, also when it only read records. A
transaction now finds the sequence when it commits an event or a journal:
- the search runs under the writer mutex, as before;
- the events take the sequence in the order they were appended.

A transaction that only reads lists no event. The same holds for one that writes a single
record without an event, such as a heartbeat.

`tx.append` still checks an event where it is appended. The event it returns gets its sequence
when the transaction commits. Its only reader, `recordOfferFailed`, reads the event after the
commit. The memory store that the core tests use does the same, so code that read the sequence
inside a callback would fail there too. The maintainer chose this change over keeping a
synchronous sequence, which would have needed a new journal record format.

## Correctness

- `packages/storage-filesystem/test/transaction-sequence.test.mjs` pins these points:
  - a read lists no event;
  - events take consecutive sequences in append order;
  - a failed callback uses no sequence;
  - an exhausted sequence refuses a write and leaves reads working;
  - a malformed event fails where it is appended;
  - no transaction takes a sequence past `Number.MAX_SAFE_INTEGER`.
- The shared store contract pins, for both stores, that a commit refused for an invalid event
  uses no sequence.
- A fresh review compared the old and new store code. It ran six processes that mixed the two
  versions: 145 events with reads, failed callbacks and heartbeats interleaved. The log was
  gapless, each sequence was unique, and each transaction's events were contiguous.
- The review also covered these areas, with no difference found:
  - crashes after the journal and between two event publications, in both directions between
    the versions;
  - the journal ceiling;
  - the retention floor after a full trim;
  - prune.
- The same script produced byte-identical event, state and journal files on both versions.
- The review found two defects, both fixed:
  - the memory store left a sequence gap after a refused commit;
  - the exhaustion check covered only a transaction's first sequence.

  The second defect is older than this change.
- The transaction probe gains a write mutation, `skips-a-sequence`. It publishes the offer's
  event one sequence later than the log's next one, and the validator refuses it. With the
  existing mutations (`skip-commit`, `two-commits`, `leaves-journal`, `stale-state`,
  `advances-on-read`, `skips-journal`), the probe now detects both skipped commits and events
  out of order.

## Comparison

`node scripts/measure/run.mjs --probe transaction --set operation=read` compared two sides:
- the baseline, `main` at `8cbc35f7`;
- the candidate, this branch at `59c297a2`.

Both sides were exported and installed apart. The later commit `60bc92db` changes only the
write path, after the read path measured here. It adds the exhaustion check for a
transaction's last sequence, and it changes the memory store.

The fixture held 30 messages and a history of 100 or 10,000 events, which leaves the reads
the same. Each call read one receipt through `readReceipt` after another process had stepped
it. Each child builds its own history, 250 intent events to a transaction. Flushes were
skipped with `--fsync skipped`, because a history of 10,000 events with real flushes takes
several minutes to build in every child. A read flushes nothing either way.

The run alternated the sides over 10 rounds, with 3 warm-up calls and 10 timed calls per
child, which gives 100 samples per side and scenario. All 40 children validated every call.
Both sides built the same fixture in each scenario, and both scenarios were labelled a
**benchmark**. Other work on the machine kept the load average between 27 and 129, so the
ranges are wide.

| Event history | Baseline median | Candidate median | Paired ratio | Event files listed | Records read |
|---:|---:|---:|---:|---|---|
| 100 | 9.84 ms | 8.46 ms | 0.733 (0.396-3.513) | 111 → 0 | 2 → 2 |
| 10,000 | 28.80 ms | 6.53 ms | 0.203 (0.064-0.612) | 10,011 → 0 | 2 → 2 |

The baseline's time grows with the history it lists. The candidate's does not: beside 10,000
events it took 6.5 ms, against 8.5 ms beside 100, within this run's noise. The two records read
are the same on both sides.

Reads that meet another writer's open journal, and writes, were not measured. The run was
stopped there:
- such a read finishes the journal at the start of the transaction, before any sequence is
  needed, so it takes the same path as the reads above;
- a write still lists the log when it commits, as it did before its callback.

The probe's tests cover both paths for correctness.

The report has the p95 values and the load around each child:
[reads](readonly-sequence-2026-10-28/transaction-read/report.md).

## Package

`node scripts/verify-package.mjs` built `agents-can-communicate-0.12.2.tgz` from `60bc92db`:
628,383 bytes, 380 entries, sha256
`2683bdca07d20209cb7595672b38fdf409774ef8afae1888ff627b7d318e63e1`. It passed package
verification, including doctor, a workspace without Git, and install with uninstall.

## Limits

- One machine was measured, under heavy load. Compare within a run, never across runs.
- These are function calls in a fresh process, not hook end-to-end latency.
- A write still lists the event log once, when it commits.
