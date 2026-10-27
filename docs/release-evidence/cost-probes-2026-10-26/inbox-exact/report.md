# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 31231946630526483270adbf21b62c5aa0d47ecf, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 31231946630526483270adbf21b62c5aa0d47ecf
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `bfe1e0a7cf9ec9addd766822ed0f3fc8f34bad2fdb423c7569b4af5f7903518c`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 44.54173 | 35.084594 | 5.505458 | 129.878167 | 94.429371 | - |
| candidate | 100 | 45.405042 | 27.517135 | 6.211875 | 257.340166 | 151.01279 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.097 (range 0.905..1.933 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 72 |
| pageReads | 2 | 2 |
| readBytes | 53214..53215 | 53214..53215 |
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
| baseline | 100 | 76.941 | 44.036563 | 32.8085 | 294.666459 | 185.485477 | - |
| candidate | 100 | 76.604833 | 37.832614 | 32.895958 | 269.766 | 191.275527 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.98 (range 0.482..1.366 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 612 |
| pageReads | 2 | 2 |
| readBytes | 306360..306361 | 306361 |
| stateByKind.message | 302 | 302 |
| stateByKind.receipt | 302 | 302 |
| stateByKind.session | 4 | 4 |
| stateReads | 608 | 608 |

