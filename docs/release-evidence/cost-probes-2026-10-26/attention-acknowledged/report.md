# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 1ae97c784d804e0d1d685d1333e9f86002f76d5a, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 1ae97c784d804e0d1d685d1333e9f86002f76d5a
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `ae7e2e26acdbcda9d56b7055a07410122d5d3362fbb5c4daac0984465628c7d8`. **benchmark**.

- baseline fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`
- candidate fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.478854 | 0.424406 | 6.831541 | 8.192958 | 8.047856 | - |
| candidate | 100 | 7.379874 | 0.330396 | 6.8195 | 11.857209 | 8.356176 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.995 (range 0.952..1.092 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 2068 | 2068 |
| messages | 1034 | 1034 |
| receiptVisits | 1049510 | 1049510 |
| receipts | 1034 | 1034 |
| sessionVisits | 53 | 53 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `7e2200dfc3419dda2e7a956f15a6cff05e7fb8697a2b660a74316f8ac3898fde`. **benchmark**.

- baseline fixture: `2100331feec6f8af871658abf97d693bb6f811390bce3fc7cf62442fb79460a9`
- candidate fixture: `2100331feec6f8af871658abf97d693bb6f811390bce3fc7cf62442fb79460a9`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 248.274812 | 36.840708 | 210.810041 | 476.647417 | 439.994798 | - |
| candidate | 100 | 252.774625 | 36.970053 | 208.818875 | 459.557 | 426.708315 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.005 (range 0.986..1.089 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 16068 | 16068 |
| messages | 8034 | 8034 |
| receiptVisits | 64392510 | 64392510 |
| receipts | 8034 | 8034 |
| sessionVisits | 53 | 53 |

