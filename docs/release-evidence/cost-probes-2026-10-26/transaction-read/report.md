# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, ca1ac9fc7e803646c728353c00f84e0a7dbc0db2, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: ca1ac9fc7e803646c728353c00f84e0a7dbc0db2
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `4de70cf77abb9f8c8df866e3b35a25f41dffeb3ac8476bcaf21dd4b2f1d3a39d`. **benchmark**.

- baseline fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`
- candidate fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 1.900083 | 1.874031 | 1.611417 | 8.606375 | 6.768331 | - |
| candidate | 100 | 1.847166 | 0.315572 | 1.616417 | 5.752791 | 3.859108 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.978 (range 0.255..1.093 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 111 | 111 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3204 | 3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `073fc8318993111b73c4577d4c15bcbd92053cc27890101be30da7e87c3a28ef`. **benchmark**.

- baseline fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`
- candidate fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.314 | 1.627073 | 2.936125 | 23.709083 | 8.682465 | - |
| candidate | 100 | 3.343376 | 0.603313 | 3.047084 | 13.588958 | 9.657267 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.025 (range 0.432..2.57 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2011 | 2011 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3204 | 3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

