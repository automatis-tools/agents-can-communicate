# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `4de70cf77abb9f8c8df866e3b35a25f41dffeb3ac8476bcaf21dd4b2f1d3a39d`. **benchmark**.

- baseline fixture: `23ca3c74508daafced573a2112d510ab2698ff155b5da2c79ed5e009a98bdd98`
- candidate fixture: `23ca3c74508daafced573a2112d510ab2698ff155b5da2c79ed5e009a98bdd98`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 2.035499 | 1.106947 | 1.606375 | 43.143417 | 9.775329 | - |
| candidate | 100 | 2.22725 | 2.037219 | 1.63575 | 29.421417 | 18.211569 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 100 | 100 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3046 | 3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `073fc8318993111b73c4577d4c15bcbd92053cc27890101be30da7e87c3a28ef`. **benchmark**.

- baseline fixture: `57a23fc48f1c9ae1636fef74b7ac4cf0239d216e54c974cbf61c2f2d614bada4`
- candidate fixture: `57a23fc48f1c9ae1636fef74b7ac4cf0239d216e54c974cbf61c2f2d614bada4`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.582458 | 4.421177 | 2.908583 | 41.294334 | 22.556471 | - |
| candidate | 100 | 3.350875 | 1.217281 | 2.844625 | 11.302583 | 8.18605 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2000 | 2000 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3046 | 3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

