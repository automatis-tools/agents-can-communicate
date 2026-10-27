# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, ca1ac9fc7e803646c728353c00f84e0a7dbc0db2, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: ca1ac9fc7e803646c728353c00f84e0a7dbc0db2
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `eb503ff9710642e443b107aaf1b2fe4e55d9a127adbe7494419b8112cdf69b2e`. **benchmark**.

- baseline fixture: `8b79f4ff8226c41aa4406ea44b64b877bfece0b634547905ce4bef345ef7b3a1`
- candidate fixture: `8b79f4ff8226c41aa4406ea44b64b877bfece0b634547905ce4bef345ef7b3a1`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.311209 | 0.185105 | 6.66475 | 13.229583 | 11.137915 | - |
| candidate | 100 | 7.2995 | 0.199469 | 6.623625 | 12.169167 | 10.916517 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.995 (range 0.974..1.018 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 12 | 12 |
| messageVisits | 2026 | 2026 |
| messages | 1013 | 1013 |
| receiptVisits | 1024143 | 1024143 |
| receipts | 1013 | 1013 |
| sessionVisits | 30 | 30 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `79274dbff63a8d5a3b900fd1ed8e62881815f3e26ab0bae9b3d0e38e42045c12`. **benchmark**.

- baseline fixture: `1a99ee3894fad4956b541b6b00c883c1d92a33f0a90aef9e1dc504769caa4edb`
- candidate fixture: `1a99ee3894fad4956b541b6b00c883c1d92a33f0a90aef9e1dc504769caa4edb`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 248.004458 | 37.863323 | 209.324667 | 458.231416 | 423.003429 | - |
| candidate | 100 | 250.017854 | 38.573969 | 208.996 | 681.098958 | 422.681202 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.005 (range 0.875..1.175 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 12 | 12 |
| messageVisits | 16026 | 16026 |
| messages | 8013 | 8013 |
| receiptVisits | 64192143 | 64192143 |
| receipts | 8013 | 8013 |
| sessionVisits | 30 | 30 |

