# Cost comparison: transaction

- Baseline: `8cbc35f7`, 8cbc35f741b8269ee5dddfed7a190384d951c459, sources `5b0dcfda10d76da438ad9185e668b3702a8ee73230d5470896a2a07c4c5e1432`
- Candidate: `59c297a2`, 59c297a2e29c3a2ad418ef96e309a4668b352c03, sources `a0b768b884d0dc095ae343355d4e7bc61c3dc4237795b4dc25770a0a2a193051`
- Harness: 7792901dee2c6a3dbb3e117534d717c1a0a50a36
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import <repo>/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `4de70cf77abb9f8c8df866e3b35a25f41dffeb3ac8476bcaf21dd4b2f1d3a39d`. **benchmark**.

- baseline fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`
- candidate fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 9.837771 | 13.048521 | 2.617917 | 410.041042 | 114.144271 | - |
| candidate | 100 | 8.464334 | 8.7875 | 2.125833 | 202.159875 | 68.197614 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.733 (range 0.396..3.513 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | null |
| enumerations.events/readdirEntries | 111 | null |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 5 | 5 |
| events | 100 | 100 |
| readBytes | 3232 | 3232 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":10000,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `868d0b1fb005477e43bc14d4d0a0493336d80204fc7b8bcace25b8109c1c3513`. **benchmark**.

- baseline fixture: `87948a326a6e96b7e7ca6e97854a287a81da8396f50a7598f93d2f7d723a13aa`
- candidate fixture: `87948a326a6e96b7e7ca6e97854a287a81da8396f50a7598f93d2f7d723a13aa`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 28.802396 | 13.714688 | 18.722833 | 329.89875 | 99.320443 | - |
| candidate | 100 | 6.528146 | 4.835916 | 1.922083 | 39.714417 | 20.867677 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.203 (range 0.064..0.612 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | null |
| enumerations.events/readdirEntries | 10011 | null |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 5 | 5 |
| events | 10000 | 10000 |
| readBytes | 3231..3232 | 3232 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

