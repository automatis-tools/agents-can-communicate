# Development evidence: attention reads each receipt once

Captured on October 27, 2026, in the afternoon (Toronto time), on macOS 27.0.0 arm64 (Apple M5
Max, 18 cores, 128 GiB), with Node 26.5.1 (V8 14.6.202.34). This is development evidence for
#305. It was not published, and the package version remains `0.12.2`.

## What changed

To find the recipients of a request who are not online, `computeAttention` filtered every
receipt once for each request the session had sent. Acknowledged receipts were filtered too,
because the filter compared the message id before it looked at the state. The work therefore
grew with the product of the session's requests and the workspace's receipts.

The receipts are now read once. Each receipt that is neither acknowledged nor held by an online
recipient is kept under its request, in the order the receipts come. The requests are then
walked in their own order. The items, their order and their summaries are the same as before.

## Correctness

- A fresh reviewer ran 100,000 random small snapshots through the old and the new computation,
  with duplicate message ids, receipts without a message, messages without recipients, several
  sessions per recipient and replaced decisions. Both computations gave the same items in the
  same order for every snapshot. Three deliberately broken copies gave hundreds of differences
  per 5,000 snapshots, so the comparison does catch a change.
- `packages/core/test/attention.test.mjs` pins fanout, presence, receipt order, a note, a room
  message and a replaced decision. It also bounds the field reads of every receipt and message
  record, wherever the computation reads them: at most twelve per receipt and 24 per message.
  The old computation reads 164,000 receipt fields for 400 receipts and fails that bound.
- In the comparison below, every call on both sides was validated by the #304 attention probe:
  its witnesses, its presence and decision rules, and its claims. That probe's tests, including
  its grouped alternative and its negative mutations, pass against this code.

## Comparison

`node scripts/measure/run.mjs --probe attention` compared two sides under the same conditions:
- the baseline, `main` at `3b6aab72` before this change, exported and installed apart;
- the candidate, this branch at `6f1dcb37`, clean. The later commit `5b90eb75` changes only
  the tests, so the packed attention code is the code that was measured.

Each run alternated the sides over 10 rounds, with 3 warm-up calls and 10 timed calls per child,
which gives 100 samples per side and scenario. All 120 children validated every call, both sides
built the same fixture in every scenario, and every scenario was labelled a **benchmark**. The
load average was between 5.2 and 26.8. The scenarios held one recipient per request and no
inbound obligations, beside the probe's 22 witness items.

The medians are in milliseconds. The paired ratio is the candidate's median over the baseline's
in each round; the table gives the median of the 10 ratios and their range. The receipt visits
are the probe's diagnostic count of reads of the snapshot's receipt array in one call.

| Own requests | Receipts | Baseline median | Candidate median | Paired ratio | Receipt visits |
|---:|---:|---:|---:|---:|---|
| 1,000 pending | 1,034 | 7.72 | 0.59 | 0.070 (0.051-0.089) | 1,049,510 → 3,102 |
| 8,000 pending | 8,034 | 339.76 | 4.37 | 0.015 (0.008-0.019) | 64,392,510 → 24,102 |
| 16,000 pending | 16,034 | 1,057.59 | 8.77 | 0.008 (0.007-0.012) | 256,784,510 → 48,102 |
| 1,000 acknowledged | 1,034 | 7.44 | 0.50 | 0.064 (0.058-0.113) | 1,049,510 → 3,102 |
| 8,000 acknowledged | 8,034 | 251.86 | 3.37 | 0.013 (0.009-0.018) | 64,392,510 → 24,102 |
| 16,000 acknowledged | 16,034 | 998.22 | 7.05 | 0.007 (0.007-0.008) | 256,784,510 → 48,102 |

The baseline's receipt visits grow with the square of the receipts, and its time with them. The
candidate reads each receipt three times, once for each concern, and its time grows in step with
the fixture: about half a millisecond per thousand requests. Fully acknowledged history cost the
baseline nearly as much as pending history, as the issue described: 252 ms against 340 ms at
8,000 requests, and 998 ms against 1,058 ms at 16,000. For the candidate it is as small as
pending history.

The p95 values come from exactly 100 samples per side; the reports leave p99 out as insufficient
evidence. Each report has them, with the load around each child in its `run.json`:
- [pending requests](attention-receipts-2026-10-27/attention-pending/report.md)
- [acknowledged requests](attention-receipts-2026-10-27/attention-acknowledged/report.md)

## Package

`node scripts/verify-package.mjs` built `agents-can-communicate-0.12.2.tgz` from `5b90eb75`:
621,745 bytes, 380 entries, sha256
`eda33a3331fbe663260634037738f3d49163cc64366f07fac55298fa3a84ec8e`. It passed package
verification, including doctor, a workspace without Git, and install with uninstall.

## Limits

- One machine was measured, under load. Compare within a run, never across runs.
- These are function calls in a fresh process, not hook end-to-end latency. A hook also reads the
  store; that cost is #306 and #307.
- The receipt-visit count sees reads of the snapshot's own array. The unit test counts field reads
  of every record instead, which a pass over a copy cannot avoid.
