# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 1ae97c784d804e0d1d685d1333e9f86002f76d5a, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 1ae97c784d804e0d1d685d1333e9f86002f76d5a
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"seed":1}

Scenario hash `f888c080a80e43414b9dcfbe1a35836341dc9acf9de4c67dca72d763c5e4dbde`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.520354 | 0.419843 | 5.083875 | 11.483625 | 6.329742 | - |
| candidate | 100 | 5.523958 | 0.510146 | 5.012916 | 6.729125 | 6.215904 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.009 (range 0.864..1.103 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 72 |
| pageReads | 0 | 0 |
| readBytes | 37224 | 37224 |
| stateByKind.message | 32 | 32 |
| stateByKind.receipt | 32 | 32 |
| stateByKind.session | 4 | 4 |
| stateReads | 68 | 68 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"seed":1}

Scenario hash `6630ceb0a10eaf7fcfa3a41825cfe64c3da0101513a40bda8581261b50dd6ecd`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 33.406708 | 1.847667 | 31.858375 | 53.319542 | 37.102804 | - |
| candidate | 100 | 33.383 | 1.773438 | 31.764542 | 45.027666 | 37.479177 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.011 (range 0.939..1.059 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 612 |
| pageReads | 0 | 0 |
| readBytes | 300730 | 300730 |
| stateByKind.message | 302 | 302 |
| stateByKind.receipt | 302 | 302 |
| stateByKind.session | 4 | 4 |
| stateReads | 608 | 608 |

