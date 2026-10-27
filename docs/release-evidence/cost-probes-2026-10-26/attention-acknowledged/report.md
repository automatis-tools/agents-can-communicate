# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 31231946630526483270adbf21b62c5aa0d47ecf, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 31231946630526483270adbf21b62c5aa0d47ecf
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `ae7e2e26acdbcda9d56b7055a07410122d5d3362fbb5c4daac0984465628c7d8`. **benchmark**.

- baseline fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`
- candidate fixture: `dc97d19967d8ebd3748b0aefc505a1836fcc06d209e4ee20b238479296e1c878`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.367355 | 0.264999 | 6.840958 | 9.50875 | 8.041161 | - |
| candidate | 100 | 7.390104 | 0.289281 | 6.813 | 8.052459 | 7.777382 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.001 (range 0.916..1.047 over 10 rounds).

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
| baseline | 100 | 248.824812 | 104.833906 | 207.815833 | 548.303833 | 439.31646 | - |
| candidate | 100 | 248.935334 | 37.349084 | 208.131917 | 486.472708 | 436.450901 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.992 (range 0.73..1.12 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 16068 | 16068 |
| messages | 8034 | 8034 |
| receiptVisits | 64392510 | 64392510 |
| receipts | 8034 | 8034 |
| sessionVisits | 53 | 53 |

