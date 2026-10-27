# Development evidence: comparable cost probes

Captured on October 27, 2026, around noon (Toronto time), on macOS 27.0.0 arm64 (Apple M5 Max,
18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for #304. It
changes no packed file, so no package was built, and the package version remains `0.12.2`.

## What was compared

`node scripts/measure/run.mjs` compared two sides under the same conditions:
- the baseline, tag `v0.12.2` (`718ea7c3`), exported with `git archive` and installed apart with
  `npm ci`;
- the candidate, this branch's checkout at `31231946`, clean.

The harness was the same commit, also clean, and it rendered each `report.md`. Both sides carry
the same package sources, manifests, lockfile and `bin/`, so their `sourcesHash` is the same:
`924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`. The comparison therefore
shows what the harness reports for equal code.

Each run alternated the sides over 10 rounds. In each round, every side built its own fixture in
a fresh process, warmed up with 3 calls, timed 10, and observed one more. Every call got its own
input, and every call was validated. That gives 100 samples per side and scenario. All 240
children validated every call, and in each scenario both sides built the same fixture digest.
Every scenario was labelled a **benchmark**.

Durability was real `fsync`, except in the transaction run. That run skipped flushes, because
building 2,000 events with real flushes takes minutes. Each report states its setting and the
`NODE_OPTIONS` the children got. `node scripts/measure/report.mjs <run.json>` renders a report
again from its raw data.

## Results

The medians are in milliseconds, computed as the reports compute them. The paired ratio is the
candidate's median over the baseline's in each round; the table gives the median of the 10
ratios. The counts are diagnostics from the observed call of each child, and both sides counted
the same.

| Probe and scenario | Baseline median | Candidate median | Paired ratio | Diagnostic counts |
|---|---:|---:|---:|---|
| attention, 1,000 pending requests | 7.63 | 7.56 | 0.998 | 1,049,510 receipt visits |
| attention, 8,000 pending requests | 272.3 | 271.0 | 0.994 | 64,392,510 receipt visits |
| attention, 1,000 acknowledged requests | 7.37 | 7.39 | 1.001 | 1,049,510 receipt visits |
| attention, 8,000 acknowledged requests | 248.8 | 248.9 | 0.992 | 64,392,510 receipt visits |
| inbox exact read, 30 messages, no backlog | 44.5 | 45.4 | 1.097 | 68 primary reads, 71 event entries listed |
| inbox exact read, 30 messages, backlog 270 | 76.9 | 76.6 | 0.980 | 608 primary reads, 339 event entries listed |
| inbox page of 1, 30 messages, no backlog | 6.08 | 6.06 | 1.008 | 68 primary reads, 62 event entries listed |
| inbox page of 1, 30 messages, backlog 270 | 35.98 | 34.94 | 0.970 | 608 primary reads, 330 event entries listed |
| transaction read, 100 events | 2.01 | 1.91 | 0.982 | 2 primary reads, 111 event entries listed |
| transaction read, 100 events, pending journal | 3.73 | 3.71 | 0.991 | 2 primary reads, 114 event entries listed |
| transaction read, 2,000 events | 3.44 | 3.51 | 1.013 | 2 primary reads, 2,011 event entries listed |
| transaction read, 2,000 events, pending journal | 5.09 | 5.28 | 1.022 | 2 primary reads, 2,014 event entries listed |

For equal code, the median paired ratios lie between 0.970 and 1.097. Single rounds spread wider,
from 0.357 to 2.847, both in the transaction reads with 100 events: a spike inside one round
moves that round's ratio, and the median of the rounds does not follow it. The reports give each
scenario's range.

The 1.097 is noise, and it shows where the noise floor lies on this machine. The exact read writes
with real `fsync`. In rounds 3, 5 and 8 of that scenario the load average stood between 12 and 27.
Five of those six children took between 77 and 139 ms against about 45 ms in the other rounds,
and the candidate's more than the baseline's in each of the three rounds. A difference of a tenth in a scenario bound by `fsync` is therefore not evidence
on a machine this loaded. Measure such a scenario at a lower load, or with more rounds.

Each attention scenario returned its 22 witness items and nothing else, as its shares require:
- 4 outbound and 4 inbound witnesses;
- 6 recipients that are unavailable in different ways;
- 4 messages left for ended sessions: the newest five of eight, less the one already noticed;
- the decision that replaced another;
- 3 claims: one conflicting, one contended and one expired.

The validator checked those items on every call.

These counts reproduce the costs that #305, #306 and #307 describe:
- Attention visits receipts quadratically, also when every request is acknowledged.
- An inbox call reads every message and receipt in the store to return one, including the
  backlog addressed to another participant. The 2026-10-13 analysis counted 63 and 603. The
  fixtures here hold two more messages for the reader, a decision and the decision that replaced
  it.
- A read-only transaction lists the whole event history. An inbox page, which commits nothing,
  lists it too.

`messageVisits` is twice the number of messages in every attention scenario, because
`computeAttention` copies the messages before it uses them, and the count sees that copy only.
The validators never use these counts.

### Transaction reads

All four transaction scenarios ran in one run, so they compare with each other. Before each
read, another store instance stepped the target's receipt once, so the event history grew
during a child. That is why each read listed more entries than the scenario's history. In a
plain run, 11 steps came before the observed read, because acknowledged receipts have no step;
in a pending-journal run, 14.

In the pending-journal scenarios, each step stopped after its journal, and the measured store had
been opened before it. Every read returned the state that the stopped step had decided. The
product's read finishes an open journal before it reads, and the tests show that the receipt
record alone still holds the old state. Finishing the step is what a pending-journal read adds to
a plain one, in the same run:
- 3.73 ms against 2.01 ms at 100 events, and 5.09 ms against 3.44 ms at 2,000;
- 5,793 bytes read against 3,203.

### Exact inbox reads have two costs

The exact scenario's mix cycles the reader's receipts through queued, offered, retrieved and
acknowledged. A read of a queued or offered message moves its receipt and publishes an event, with
real `fsync`. A read of a retrieved or acknowledged message changes nothing. Every child reads
the same messages in the same order, so the sides stay comparable, but the samples are bimodal.
The median at each sample position, over the children of each side, as the reports compute a
median:

| Exact read | No backlog | Backlog 270 |
|---|---:|---:|
| without a transition | 6.36-8.43 | 36.29-44.11 |
| with a transition | 44.10-54.52 | 76.34-91.15 |

The backlog adds about 30 ms to either kind. The receipt states that the fixture holds at each
position confirm the split, at every position of both scenarios. These figures come from
`samplesNs` in [inbox-exact/run.json](cost-probes-2026-10-26/inbox-exact/run.json).

### Tails

The p95 column comes from exactly 100 samples per side. On this loaded machine it is noisy: for
the transaction read with 100 events, equal code gave 4.1 ms and 8.0 ms. The reports leave p99 out
as insufficient evidence, because it needs 1,000 samples per side.

## Raw data

Each directory below holds the run's `run.json` and its `report.md`. A `run.json` holds every raw
sample, the host, the sides, the harness, the load around each child and the fixture digests:
- [attention, pending](cost-probes-2026-10-26/attention-pending/report.md)
- [attention, acknowledged](cost-probes-2026-10-26/attention-acknowledged/report.md)
- [inbox, exact](cost-probes-2026-10-26/inbox-exact/report.md)
- [inbox, page](cost-probes-2026-10-26/inbox-page/report.md)
- [transaction, read, with and without a pending journal](cost-probes-2026-10-26/transaction-read/report.md)

## Limits

- One machine was measured, at 1-minute load averages from 4.1 to 32.1. The load around each
  child is in `run.json`. Absolute times move with the load, so compare within one run, never
  across runs.
- The comparisons are function and store-API calls in a fresh process, not CLI or hook end-to-end
  latency.
- The transaction run skipped flushes, and its report says so.
- The store I/O probe observes descriptor reads, through file handles. It does not yet observe
  direct promise-based reads (#347), so a primary-read count is a lower bound: the true count
  can be higher.
- A side that memoizes an answer by content across the calls of one process could pass the
  validators. See the design's limits.
