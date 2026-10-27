# Development evidence: comparable cost probes

Captured on the evening of October 26, 2026 (Toronto time), on macOS 27.0.0 arm64 (Apple M5 Max,
18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for #304. It
changes no packed file, so no package was built, and the package version remains `0.12.2`.

## What was compared

`node scripts/measure/run.mjs` compared two sides under the same conditions:
- the baseline, tag `v0.12.2` (`718ea7c3`), exported with `git archive` and installed apart with
  `npm ci`;
- the candidate, this branch's checkout at `8cdf7d29`, clean.

The harness was the same commit, also clean. Both sides carry the same package sources,
manifests, lockfile and `bin/`, so their `sourcesHash` is the same:
`924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`. The comparison therefore
shows what the harness reports for equal code.

Each run alternated the sides over 10 rounds. In each round, every side built its own fixture in
a fresh process, warmed up with 3 calls, timed 10, and observed one more. Every call got its own
input, and every call was validated. That gives 100 samples per side and scenario. All 240
children validated every call, and in each scenario both sides built the same fixture digest.
Every scenario was labelled a **benchmark**.

Durability was real `fsync`, except in the two transaction runs. Those runs skipped flushes,
because building 2,000 events with real flushes takes minutes and a read flushes nothing. Each
report states its setting and the `NODE_OPTIONS` the children got.

## Results

The medians are in milliseconds. The counts are diagnostics from the observed call of each child,
and both sides counted the same.

| Probe and scenario | Baseline median | Candidate median | Diagnostic counts |
|---|---:|---:|---|
| attention, 1,000 pending requests | 7.28 | 7.26 | 1,014,048 receipt visits |
| attention, 8,000 pending requests | 263.2 | 262.0 | 64,112,048 receipt visits |
| attention, 1,000 acknowledged requests | 7.43 | 7.38 | 1,014,048 receipt visits |
| attention, 8,000 acknowledged requests | 258.3 | 254.5 | 64,112,048 receipt visits |
| inbox exact read, 30 messages, no backlog | 44.3 | 43.6 | 64 primary reads, 65 event entries listed |
| inbox exact read, 30 messages, backlog 270 | 68.2 | 68.7 | 604 primary reads, 338 event entries listed |
| inbox page of 1, 30 messages, no backlog | 5.63 | 5.53 | 64 primary reads, 57 event entries listed |
| inbox page of 1, 30 messages, backlog 270 | 33.20 | 32.97 | 604 primary reads, 331 event entries listed |
| transaction read, 100 events | 2.04 | 2.23 | 2 primary reads, 100 event entries listed |
| transaction read, 2,000 events | 3.58 | 3.35 | 2 primary reads, 2,000 event entries listed |
| transaction read, pending journal, 100 events | 1.92 | 1.92 | 2 primary reads, 101 event entries listed |
| transaction read, pending journal, 2,000 events | 3.45 | 3.31 | 2 primary reads, 2,001 event entries listed |

Each attention scenario returned its 8 witness items and nothing else, as its shares require. The
validator checked those items on every call.

These counts reproduce the costs that #305, #306 and #307 describe:
- Attention visits receipts quadratically, also when every request is acknowledged.
- An inbox call reads every message and receipt in the store to return one, including the
  backlog addressed to another participant. The 2026-10-13 analysis counted 63 and 603.
- A read-only transaction lists the whole event history. An inbox page, which commits nothing,
  lists it too.

In the pending-journal runs, every read of the decided message returned `offered`. The decided
write was finished once, which adds the one event that is listed beyond the history.

The validators never use these counts.

### Exact inbox reads have two costs

The exact scenario's mix cycles the reader's receipts through queued, offered, retrieved and
acknowledged. A read of a queued or offered message moves its receipt and publishes an event, with
real `fsync`. A read of a retrieved or acknowledged message changes nothing. Every child reads
the same messages in the same order, so the sides stay comparable, but the samples are bimodal.
The median by sample position, across the baseline's children:

| Exact read | No backlog | Backlog 270 |
|---|---:|---:|
| without a transition | 6.5-7.7 | 33.7-36.7 |
| with a transition | 45.3-48.3 | 71.3-75.6 |

The backlog adds about 27 ms to either kind. These figures come from `samplesNs` in
[inbox-exact/run.json](cost-probes-2026-10-26/inbox-exact/run.json). The receipt states that the
fixture holds at each position confirm the split, at every position of both scenarios.

### Tails

The p95 column comes from exactly 100 samples per side. On this loaded machine it is noisy: for
the transaction read with 100 events, equal code gave 9.8 ms and 18.2 ms. The reports leave p99
out as insufficient evidence, because it needs 1,000 samples per side.

## Raw data

Each directory below holds the run's `run.json` and its `report.md`. A `run.json` holds every raw
sample, the host, the sides, the harness, the load around each child and the fixture digests:
- [attention, pending](cost-probes-2026-10-26/attention-pending/report.md)
- [attention, acknowledged](cost-probes-2026-10-26/attention-acknowledged/report.md)
- [inbox, exact](cost-probes-2026-10-26/inbox-exact/report.md)
- [inbox, page](cost-probes-2026-10-26/inbox-page/report.md)
- [transaction, read](cost-probes-2026-10-26/transaction-read/report.md)
- [transaction, read with a pending journal](cost-probes-2026-10-26/transaction-pending/report.md)

## Limits

- One machine was measured, at 1-minute load averages from 4.2 to 28.3. The load around each
  child is in `run.json`. Absolute times move with the load, so compare sides within one run,
  never across runs.
- The comparisons are function and store-API calls in a fresh process, not CLI or hook end-to-end
  latency.
- The transaction runs skipped flushes, and their reports say so.
- The store I/O probe observes descriptor reads, through file handles. It does not yet observe
  direct promise-based reads (#347), so a primary-read count is a lower bound: the true count
  can be higher.
- A side that memoizes an answer by content across the calls of one process could pass the
  validators. See the design's limits.
