# Development evidence: comparable cost probes

Captured on the night of October 26 to 27, 2026 (Toronto time), on macOS 27.0.0 arm64 (Apple M5
Max, 18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for
#304. It changes no packed file, so no package was built, and the package version remains
`0.12.2`.

## What was compared

`node scripts/measure/run.mjs` compared two sides under the same conditions:
- the baseline, tag `v0.12.2` (`718ea7c3`), exported with `git archive` and installed apart with
  `npm ci`;
- the candidate, this branch's checkout at `ca1ac9fc`, clean.

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
because building 2,000 events with real flushes takes minutes. Each report states its setting
and the `NODE_OPTIONS` the children got.

Each `report.md` was rendered from its `run.json` by `scripts/measure/report.mjs` at `f5edb45e`,
which adds the paired ratio. `node scripts/measure/report.mjs <run.json>` renders one again.

## Results

The medians are in milliseconds. The paired ratio is the candidate's median over the baseline's,
round by round, and its median over the 10 rounds. The counts are diagnostics from the observed
call of each child, and both sides counted the same.

| Probe and scenario | Baseline median | Candidate median | Paired ratio | Diagnostic counts |
|---|---:|---:|---:|---|
| attention, 1,000 pending requests | 7.31 | 7.30 | 0.995 | 1,024,143 receipt visits |
| attention, 8,000 pending requests | 248.0 | 250.0 | 1.005 | 64,192,143 receipt visits |
| attention, 1,000 acknowledged requests | 7.27 | 7.28 | 0.994 | 1,024,143 receipt visits |
| attention, 8,000 acknowledged requests | 273.0 | 247.2 | 0.992 | 64,192,143 receipt visits |
| inbox exact read, 30 messages, no backlog | 44.5 | 44.6 | 0.992 | 64 primary reads, 65 event entries listed |
| inbox exact read, 30 messages, backlog 270 | 51.7 | 55.2 | 1.009 | 604 primary reads, 338 event entries listed |
| inbox page of 1, 30 messages, no backlog | 5.77 | 5.97 | 1.045 | 64 primary reads, 57 event entries listed |
| inbox page of 1, 30 messages, backlog 270 | 33.83 | 35.77 | 0.993 | 604 primary reads, 331 event entries listed |
| transaction read, 100 events | 1.90 | 1.85 | 0.978 | 2 primary reads, 111 event entries listed |
| transaction read, 2,000 events | 3.31 | 3.34 | 1.025 | 2 primary reads, 2,011 event entries listed |
| transaction read, pending journal, 100 events | 3.67 | 3.58 | 1.020 | 2 primary reads, 114 event entries listed |
| transaction read, pending journal, 2,000 events | 4.84 | 5.09 | 1.016 | 2 primary reads, 2,014 event entries listed |

For equal code the paired ratios lie between 0.978 and 1.045.

The pooled medians of one scenario, attention with 8,000 acknowledged requests, differ by a
tenth for equal code. Both sides took about 245 ms in rounds 0 to 6. In rounds 7 to 9 the load
average rose from about 5 to about 17, and five of those six children took between 359 and
926 ms. The baseline had three of the slow children and the candidate two, so the pooled medians
moved apart. The paired ratio stays at 0.992. Read the paired ratio, not the pooled medians.

Each attention scenario returned its 12 witness items and nothing else, as its shares require:
4 outbound and 4 inbound witnesses, and 4 recipients that are unavailable in four different ways.
The validator checked those items on every call.

These counts reproduce the costs that #305, #306 and #307 describe:
- Attention visits receipts quadratically, also when every request is acknowledged.
- An inbox call reads every message and receipt in the store to return one, including the
  backlog addressed to another participant. The 2026-10-13 analysis counted 63 and 603.
- A read-only transaction lists the whole event history. An inbox page, which commits nothing,
  lists it too.

`messageVisits` is twice the number of messages in every attention scenario, because
`computeAttention` copies the messages before it uses them, and the count sees that copy only.
The validators never use these counts.

### Transaction reads

Before each read, another store instance stepped the target's receipt once, so the event history
grew during a child. That is why each read listed more entries than the scenario's history: 11
steps came before the observed read of a plain run, because acknowledged receipts have no step,
and 14 before that of a pending-journal run.

In the pending-journal runs, each step stopped after its journal, and the measured store had been
opened before it. Every read returned the state that the stopped step had decided. The product's
read finishes an open journal before it reads, and the tests show that the receipt record alone
still holds the old state. Finishing the step is the extra cost over a plain read: 3.67 ms
against 1.90 ms at 100 events, and 5,794 bytes read against 3,204.

### Exact inbox reads have two costs

The exact scenario's mix cycles the reader's receipts through queued, offered, retrieved and
acknowledged. A read of a queued or offered message moves its receipt and publishes an event, with
real `fsync`. A read of a retrieved or acknowledged message changes nothing. Every child reads
the same messages in the same order, so the sides stay comparable, but the samples are bimodal.
The median by sample position, across the children of each side:

| Exact read | No backlog | Backlog 270 |
|---|---:|---:|
| without a transition | 6.2-7.3 | 33.3-33.9 |
| with a transition | 44.9-47.2 | 71.5-74.2 |

The backlog adds about 27 ms to either kind. The receipt states that the fixture holds at each
position confirm the split, at every position of both scenarios. These figures come from
`samplesNs` in [inbox-exact/run.json](cost-probes-2026-10-26/inbox-exact/run.json).

### Tails

The p95 column comes from exactly 100 samples per side. On this loaded machine it is noisy: for
the pending-journal read with 2,000 events, equal code gave 32.3 ms and 6.7 ms. The reports leave
p99 out as insufficient evidence, because it needs 1,000 samples per side.

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

- One machine was measured, at 1-minute load averages from 4.9 to 26.9. The load around each
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
