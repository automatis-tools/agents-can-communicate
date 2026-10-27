# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `eb503ff9710642e443b107aaf1b2fe4e55d9a127adbe7494419b8112cdf69b2e`. **benchmark**.

- baseline fixture: `e99d2cde1f0f2a937616bc6baec43e746fb3c8ef762ff0f8cea8a9b36e482dbf`
- candidate fixture: `e99d2cde1f0f2a937616bc6baec43e746fb3c8ef762ff0f8cea8a9b36e482dbf`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.281146 | 0.287979 | 7.029541 | 11.180791 | 10.359843 | - |
| candidate | 100 | 7.260959 | 0.295791 | 7.002458 | 11.818583 | 8.71474 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 8 | 8 |
| messageVisits | 2016 | 2016 |
| messages | 1008 | 1008 |
| receiptVisits | 1014048 | 1014048 |
| receipts | 1008 | 1008 |
| sessionVisits | 15 | 15 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `79274dbff63a8d5a3b900fd1ed8e62881815f3e26ab0bae9b3d0e38e42045c12`. **benchmark**.

- baseline fixture: `fee97c20e2294de5f6f8cea792725670450d69e4baa3a608e4d12d15e42dd9c2`
- candidate fixture: `fee97c20e2294de5f6f8cea792725670450d69e4baa3a608e4d12d15e42dd9c2`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 263.213437 | 50.966344 | 210.256166 | 478.009083 | 459.838358 | - |
| candidate | 100 | 261.97748 | 62.801156 | 209.717042 | 486.51225 | 454.347625 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 8 | 8 |
| messageVisits | 16016 | 16016 |
| messages | 8008 | 8008 |
| receiptVisits | 64112048 | 64112048 |
| receipts | 8008 | 8008 |
| sessionVisits | 15 | 15 |

