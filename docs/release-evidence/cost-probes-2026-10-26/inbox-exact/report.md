# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 1ae97c784d804e0d1d685d1333e9f86002f76d5a, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 1ae97c784d804e0d1d685d1333e9f86002f76d5a
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `bfe1e0a7cf9ec9addd766822ed0f3fc8f34bad2fdb423c7569b4af5f7903518c`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 43.882708 | 38.372782 | 5.201042 | 49.354208 | 46.480227 | - |
| candidate | 100 | 43.970458 | 38.455083 | 5.175666 | 49.804 | 46.084148 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.999 (range 0.992..1.025 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 72 |
| pageReads | 2 | 2 |
| readBytes | 53215 | 53215 |
| stateByKind.message | 32 | 32 |
| stateByKind.receipt | 32 | 32 |
| stateByKind.session | 4 | 4 |
| stateReads | 68 | 68 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `d7fac8c8b306b0a3a2dc2a7409191995edbd8fe45a669384bd7ad7d3019afeb0`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 70.437062 | 37.802188 | 32.284958 | 78.765166 | 74.344723 | - |
| candidate | 100 | 71.210499 | 38.950635 | 32.082 | 100.468209 | 78.860877 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.013 (range 0.984..1.047 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 612 |
| pageReads | 2 | 2 |
| readBytes | 306361 | 306361 |
| stateByKind.message | 302 | 302 |
| stateByKind.receipt | 302 | 302 |
| stateByKind.session | 4 | 4 |
| stateReads | 608 | 608 |

