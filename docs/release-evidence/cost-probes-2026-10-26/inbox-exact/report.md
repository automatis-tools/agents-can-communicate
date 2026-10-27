# Cost comparison: inbox

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, ca1ac9fc7e803646c728353c00f84e0a7dbc0db2, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: ca1ac9fc7e803646c728353c00f84e0a7dbc0db2
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"seed":1}

Scenario hash `bfe1e0a7cf9ec9addd766822ed0f3fc8f34bad2fdb423c7569b4af5f7903518c`. **benchmark**.

- baseline fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`
- candidate fixture: `1a2cb129af3cb4626e3d8768aa414a4fc2211332680c8bf46d98a26bd15a2f4e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 44.454667 | 39.001448 | 5.713583 | 69.529 | 62.511825 | - |
| candidate | 100 | 44.632021 | 38.883021 | 5.73275 | 78.205333 | 55.268635 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.992 (range 0.867..1.027 over 10 rounds).

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
| baseline | 100 | 51.736021 | 39.207125 | 32.323166 | 78.060042 | 75.117771 | - |
| candidate | 100 | 55.177334 | 39.152615 | 32.422667 | 95.843 | 75.498635 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.009 (range 0.974..1.099 over 10 rounds).

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

