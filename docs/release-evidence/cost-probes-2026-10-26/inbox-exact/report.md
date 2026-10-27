# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `bfe1e0a7cf9ec9addd766822ed0f3fc8f34bad2fdb423c7569b4af5f7903518c`. **benchmark**.

- baseline fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`
- candidate fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 44.292646 | 40.129239 | 5.327916 | 91.31425 | 66.592362 | - |
| candidate | 100 | 43.645521 | 39.743896 | 5.170334 | 66.777458 | 50.088789 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 65 | 65 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 68 | 68 |
| pageReads | 2 | 2 |
| readBytes | 50299 | 50299 |
| stateByKind.message | 30 | 30 |
| stateByKind.receipt | 30 | 30 |
| stateByKind.session | 4 | 4 |
| stateReads | 64 | 64 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `d7fac8c8b306b0a3a2dc2a7409191995edbd8fe45a669384bd7ad7d3019afeb0`. **benchmark**.

- baseline fixture: `54f785cb35cc9f6573fbddbcfb406bde867b9ef3a199ebfc0bac288e6acc59db`
- candidate fixture: `54f785cb35cc9f6573fbddbcfb406bde867b9ef3a199ebfc0bac288e6acc59db`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 68.165625 | 38.928803 | 31.204167 | 109.421458 | 89.698332 | - |
| candidate | 100 | 68.747563 | 39.186156 | 32.343875 | 99.59475 | 81.056414 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 338 | 338 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 608 | 608 |
| pageReads | 2 | 2 |
| readBytes | 304268 | 304268 |
| stateByKind.message | 300 | 300 |
| stateByKind.receipt | 300 | 300 |
| stateByKind.session | 4 | 4 |
| stateReads | 604 | 604 |

