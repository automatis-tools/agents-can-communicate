# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 31231946630526483270adbf21b62c5aa0d47ecf, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 31231946630526483270adbf21b62c5aa0d47ecf
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"seed":1}

Scenario hash `f888c080a80e43414b9dcfbe1a35836341dc9acf9de4c67dca72d763c5e4dbde`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 6.081105 | 0.765343 | 5.151041 | 7.779166 | 7.129056 | - |
| candidate | 100 | 6.062271 | 0.658656 | 5.244333 | 10.617583 | 9.104627 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.008 (range 0.912..1.052 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 72 |
| pageReads | 0 | 0 |
| readBytes | 37223..37224 | 37222..37224 |
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
| baseline | 100 | 35.977333 | 4.123791 | 32.462375 | 50.011209 | 43.843327 | - |
| candidate | 100 | 34.937937 | 2.512011 | 31.971041 | 46.467125 | 42.052448 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.97 (range 0.875..1.142 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 612 |
| pageReads | 0 | 0 |
| readBytes | 300729..300730 | 300729..300730 |
| stateByKind.message | 302 | 302 |
| stateByKind.receipt | 302 | 302 |
| stateByKind.session | 4 | 4 |
| stateReads | 608 | 608 |

