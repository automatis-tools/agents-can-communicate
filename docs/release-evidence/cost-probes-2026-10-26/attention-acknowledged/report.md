# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, ca1ac9fc7e803646c728353c00f84e0a7dbc0db2, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: ca1ac9fc7e803646c728353c00f84e0a7dbc0db2
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `63e5c386f57554f6009fa51cd6d2b1d3937707c987a0de4c416a326bfd714dcd`. **benchmark**.

- baseline fixture: `5e0c7f6911fd2e4d5324fc593a00e1c536a8f754ade14e940333aa24ee07d33e`
- candidate fixture: `5e0c7f6911fd2e4d5324fc593a00e1c536a8f754ade14e940333aa24ee07d33e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.265791 | 0.290948 | 7.039167 | 49.685791 | 12.248 | - |
| candidate | 100 | 7.282292 | 0.293489 | 6.983958 | 12.759416 | 11.64994 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.994 (range 0.938..1.024 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 12 | 12 |
| messageVisits | 2026 | 2026 |
| messages | 1013 | 1013 |
| receiptVisits | 1024143 | 1024143 |
| receipts | 1013 | 1013 |
| sessionVisits | 24 | 24 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `8e21686ec3779a002bb79bde8ab0fa935330bfe8cb4e7e804ce00d4d886c456e`. **benchmark**.

- baseline fixture: `ece7438134c1d28b665170e22460a67d978d2407b1d21131632416350b467dce`
- candidate fixture: `ece7438134c1d28b665170e22460a67d978d2407b1d21131632416350b467dce`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 273.023792 | 163.058426 | 209.164125 | 616.7395 | 477.347133 | - |
| candidate | 100 | 247.171646 | 175.817625 | 208.232666 | 1439.997375 | 842.037175 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.992 (range 0.69..2.107 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 12 | 12 |
| messageVisits | 16026 | 16026 |
| messages | 8013 | 8013 |
| receiptVisits | 64192143 | 64192143 |
| receipts | 8013 | 8013 |
| sessionVisits | 24 | 24 |

