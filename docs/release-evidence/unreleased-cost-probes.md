# Development evidence: comparable cost probes

Captured on October 26, 2026, on macOS 27.0.0 arm64 (Apple M5 Max, 18 cores, 128 GiB), with
Node 26.5.1 (V8 14.6.202.34). This is development evidence for #304. It changes no packed file,
so no package was built, and the package version remains `0.12.2`.

## What was compared

`node scripts/measure/run.mjs` compared two sides under the same conditions:
- the baseline, tag `v0.12.2` (`718ea7c3`), exported with `git archive` and installed apart with
  `npm ci`;
- the candidate, this branch's checkout (`d5b6372d`, clean).

Both sides carry the same package sources, so their `sourcesHash` is the same:
`2a8ac0650cb90aaba85c8fbb681cf1dc886e1a7e4c582a980b136ae57e7ea029`. The comparison therefore
shows what the harness reports for equal code.

Each run alternated the sides over 10 rounds. In each round every side built its own fixture in a
fresh process, validated every call, warmed up with 3 calls and timed 10. That gives 100 samples
per side and scenario, and every scenario was labelled a **benchmark**. Durability was real
`fsync` throughout, except in the transaction run. That run skipped flushes, because building
2,000 events with real flushes takes minutes and a read flushes nothing. Each report states
its setting.

## Results

The medians are in milliseconds. The counts are diagnostics from one untimed call per child, and
both sides counted the same.

| Probe and scenario | Baseline median | Candidate median | Diagnostic counts |
|---|---:|---:|---|
| attention, 1,000 pending requests | 6.55 | 6.53 | 1,002,000 receipt visits |
| attention, 8,000 pending requests | 196.5 | 194.7 | 64,016,000 receipt visits |
| attention, 1,000 acknowledged requests | 6.48 | 6.48 | 1,002,000 receipt visits |
| attention, 8,000 acknowledged requests | 190.7 | 189.7 | 64,016,000 receipt visits |
| inbox exact read, 30 messages | 45.7 | 45.6 | 64 primary reads |
| inbox exact read, 300 messages | 71.5 | 71.7 | 604 primary reads |
| inbox page of 1, 30 messages | 5.73 | 5.66 | 64 primary reads |
| inbox page of 1, 300 messages | 33.97 | 33.44 | 604 primary reads |
| transaction read, 100 events | 1.81 | 1.82 | 2 primary reads, 100 event entries listed |
| transaction read, 2,000 events | 3.40 | 3.13 | 2 primary reads, 2,000 event entries listed |

These counts reproduce the costs that #305, #306 and #307 describe:
- Attention visits receipts quadratically, also when every request is acknowledged.
- An inbox call reads every message and receipt to return one.
- A read-only transaction lists the whole event history.

The validators never use these counts. Every call on both sides passed validation.

The p95 column comes from exactly 100 samples per side. The reports leave p99 out as
insufficient evidence, because it needs 1,000 samples per side.

## Raw data

Each directory below holds the run's `run.json` (every raw sample, the host, the sides and the
fixture digests) and its `report.md`:
- [attention, pending](cost-probes-2026-10-26/attention-pending/report.md)
- [attention, acknowledged](cost-probes-2026-10-26/attention-acknowledged/report.md)
- [inbox, exact](cost-probes-2026-10-26/inbox-exact/report.md)
- [inbox, page](cost-probes-2026-10-26/inbox-page/report.md)
- [transaction, read](cost-probes-2026-10-26/transaction-read/report.md)

## Limits

- One machine was measured, at load averages from 4.5 to 12. The load around each child is in
  `run.json`.
- The comparisons are function and store-API calls in a fresh process, not CLI or hook end-to-end
  latency.
- The transaction run skipped flushes, and its report says so.
- The store I/O probe observes descriptor reads, through file handles. It does not yet observe
  direct promise-based reads (#347), so a primary-read count is a lower bound: the true count
  can be higher.
