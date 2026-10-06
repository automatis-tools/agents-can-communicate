# Indexed transaction evidence for #241

Local implementation: store contract 7, based on `c2816d40`.
Production implementation measured at `ac2a58b8`; the final performance guard
adds no shipped implementation changes. Captured on macOS with Node 24.4.0,
2026-10-05 local / 2026-10-06 UTC. Windows measurement remains outstanding.

## Actual installed artifacts

The published `agents-can-communicate@0.9.0` archive was fetched once from the
public npm registry. Its SHA-256 matches the release's recorded value:

`df4700148f5710536155af47b05a0f211d5c8a5d09dee5c945e2b5a5303881c6`

Its SHA-512 also matches registry integrity. Both artifacts were installed in
private consumers with lifecycle scripts disabled. The candidate changes only
copied package metadata to private version `0.9.99`; repository versions stay
unchanged. Candidate archive SHA-256:

`a35b7c49fe0c611bb497c7a0e9a5f4547280b008d46a091605932898dea0f1f9`

The real old binary creates a version-6 store and records a message. An actual
managed old MCP process acquires a version-6 PID lease and responds to initialize.
Updating against the private registry stages the verified candidate without
activation. Its management entry refuses migration while that old process lives.
After SIGTERM, process exit and an ESRCH liveness check, explicit migration:

- changes identity 6 to 7 and preserves original message bytes;
- performs no registry request or runtime activation;
- preserves the original message ID on retry;
- permits acknowledgement after explicit candidate activation.

An unmanaged old binary, given a copy of the migrated workspace and no manager,
refuses a new store open. This does not prove an already-open unmanaged old
library handle is fenced: the operator must stop such callers before migration.
Ordinary packed gates also prove fail-open hooks diagnose the migration remedy
without changing identity or returning a failing process exit.

## Matched filesystem observations

One sequential before/after pair ran without another local heavy test runner.
Both use the actual installed package modules, the same two-participant fixture,
same records and IDs, and actual root-scoped descriptor operations. The observer
changes neither store methods nor durability. No elapsed-time threshold is a gate.

| Sequential sends | Old cumulative primary reads | Candidate cumulative primary reads | Old last-send reads | Candidate last-send reads |
| --- | ---: | ---: | ---: | ---: |
| 20 | 500 | 120 | 44 | 6 |
| 40 | 1800 | 240 | 84 | 6 |
| 60 | 3900 | 360 | 124 | 6 |

| Candidate warmed send | Index page reads | Published index pages | Index bytes published | Index flushes | All flushes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 | 7 | 4 | 8574 | 0 | 11 |
| 40 | 9 | 6 | 3917 | 0 | 11 |
| 60 | 10 | 6 | 5317 | 0 | 11 |

Primary reads no longer grow with unrelated history. Page writes copy only the
affected bounded paths. Total candidate page publications at 20/40/60 are
80/203/323, rather than a whole index rewrite on every send. The first send has
6 primary reads, 4 page publications and 1062 published index bytes.

| Operation at 60 messages | Old primary reads | Candidate primary reads | Old elapsed ms | Candidate elapsed ms |
| --- | ---: | ---: | ---: | ---: |
| readReceipt | 120 | 2 | 34.087 | 8.751 |
| successful offer | 122 | 3 | 73.125 | 54.646 |
| acknowledgement | 123 | 4 | 70.511 | 52.189 |
| failed offer | 122 | 3 | 64.153 | 40.045 |
| receipt after reopen | 120 | 2 | 30.853 | 7.456 |
| message retry after reopen | 126 | 7 | 39.287 | 10.850 |

The 60-send sequence took 4210.55 ms before and 3674.16 ms after in this one
pair. This is a local observation, not a whole-suite or Windows speedup claim.
Flush counts remain unchanged; the savings remove unrelated primary reads.

A separately forced cache recovery at the same 60-message fixture reads 127
primary records and publishes 154 pages / 36887 index bytes, with no index
flushes. Recovery is intentionally measured separately from steady operation.

## Gates and mutation evidence

`tests/process/transaction-read-cost.test.mjs` asserts matched 20/40/60 primary
counts, receipt 2/3/4 counts, cold lookup isolation, and zero index flushes. The
helper reports primary records, index pages/bytes, journal and retention IO,
metadata and elapsed time separately. Every intercepted builtin is restored.

Each following mutation produces a relevant assertion failure, with sources
restored before positive verification:

- force eager loading: last-send primary reads 44 versus 84;
- trust stale cache epoch: a newly written key is missed;
- omit generic new-key delta: an indexed key move is missed;
- bypass generation comparison: a stale put is accepted;
- ignore a deletion marker: a removed record reappears;
- bypass exact-read containment: a junction read is accepted;
- omit the final identity switch: migration leaves version 6;
- bypass migration holders: a live old holder is ignored;
- flush cache publications: the zero-index-flush guard fails.

Prune gates also reject omitted authority fencing, deletion of reachable pages,
omitted POSIX primary-directory sync, and a deadline applied to the final idle
publication. They cover partial moves, retry-key reuse, history trimming,
recovery, and deferring an unfinishable cache traversal to the daily pass.

Full drivers, mutation patches/assertions, artifact provenance and raw IO are
retained separately at `/private/tmp/acc-241-evidence.l9riuq`. No benchmark
driver, downloaded old package or network request enters ordinary test runs.
