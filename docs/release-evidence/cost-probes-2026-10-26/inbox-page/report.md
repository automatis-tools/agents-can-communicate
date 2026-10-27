# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"seed":1}

Scenario hash `f888c080a80e43414b9dcfbe1a35836341dc9acf9de4c67dca72d763c5e4dbde`. **benchmark**.

- baseline fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`
- candidate fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.629729 | 0.76503 | 4.814292 | 11.392583 | 9.477812 | - |
| candidate | 100 | 5.534167 | 0.428458 | 4.930208 | 7.931667 | 6.46915 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 57 | 57 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 68 | 68 |
| pageReads | 0 | 0 |
| readBytes | 35119 | 35119 |
| stateByKind.message | 30 | 30 |
| stateByKind.receipt | 30 | 30 |
| stateByKind.session | 4 | 4 |
| stateReads | 64 | 64 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"seed":1}

Scenario hash `6630ceb0a10eaf7fcfa3a41825cfe64c3da0101513a40bda8581261b50dd6ecd`. **benchmark**.

- baseline fixture: `54f785cb35cc9f6573fbddbcfb406bde867b9ef3a199ebfc0bac288e6acc59db`
- candidate fixture: `54f785cb35cc9f6573fbddbcfb406bde867b9ef3a199ebfc0bac288e6acc59db`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 33.195292 | 2.16522 | 31.6875 | 54.169125 | 40.122299 | - |
| candidate | 100 | 32.972625 | 1.094666 | 31.721708 | 44.582625 | 36.490708 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 331 | 331 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 608 | 608 |
| pageReads | 0 | 0 |
| readBytes | 298643 | 298643 |
| stateByKind.message | 300 | 300 |
| stateByKind.receipt | 300 | 300 |
| stateByKind.session | 4 | 4 |
| stateReads | 604 | 604 |

