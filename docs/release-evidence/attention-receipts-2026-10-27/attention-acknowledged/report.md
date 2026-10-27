# Cost comparison: attention

- Baseline: `3b6aab72`, 3b6aab722b13cf4d11d4c724133edb329add1371, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 6f1dcb37dddf8b35940915b6eec80ac5a198d4ab, sources `daaf22f3c5ef332833779eb967b40d769149e7b2e0878359681336fa225a2a97`
- Harness: 6f1dcb37dddf8b35940915b6eec80ac5a198d4ab
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `ae7e2e26acdbcda9d56b7055a07410122d5d3362fbb5c4daac0984465628c7d8`. **benchmark**.

- baseline fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`
- candidate fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.443146 | 0.339302 | 6.884708 | 8.374459 | 7.94741 | - |
| candidate | 100 | 0.504667 | 0.141615 | 0.365917 | 1.021125 | 0.919171 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.064 (range 0.058..0.113 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 2068 | 2068 |
| messages | 1034 | 1034 |
| receiptVisits | 1049510 | 3102 |
| receipts | 1034 | 1034 |
| sessionVisits | 53 | 53 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `7e2200dfc3419dda2e7a956f15a6cff05e7fb8697a2b660a74316f8ac3898fde`. **benchmark**.

- baseline fixture: `2100331feec6f8af871658abf97d693bb6f811390bce3fc7cf62442fb79460a9`
- candidate fixture: `2100331feec6f8af871658abf97d693bb6f811390bce3fc7cf62442fb79460a9`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 251.863563 | 41.626198 | 209.515666 | 587.8555 | 436.015105 | - |
| candidate | 100 | 3.366541 | 0.634761 | 2.606 | 6.100667 | 5.109706 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.013 (range 0.009..0.018 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 16068 | 16068 |
| messages | 8034 | 8034 |
| receiptVisits | 64392510 | 24102 |
| receipts | 8034 | 8034 |
| sessionVisits | 53 | 53 |

## {"probe":"attention","ownRequests":16000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `a14bc1f85536f67eb1d715f24cdcffbb2002b925403bba33300dd8a254f96b46`. **benchmark**.

- baseline fixture: `4e257bc8629f49561fa4185327e7efde242423cb3447f3bff85261abc6fb168e`
- candidate fixture: `4e257bc8629f49561fa4185327e7efde242423cb3447f3bff85261abc6fb168e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 998.219687 | 60.270052 | 867.560125 | 1595.323875 | 1160.424371 | - |
| candidate | 100 | 7.046896 | 1.618865 | 5.5495 | 9.174917 | 8.450108 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.007 (range 0.007..0.008 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 32068 | 32068 |
| messages | 16034 | 16034 |
| receiptVisits | 256784510 | 48102 |
| receipts | 16034 | 16034 |
| sessionVisits | 53 | 53 |

