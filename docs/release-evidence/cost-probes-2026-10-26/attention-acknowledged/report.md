# Cost comparison: attention

- Baseline: baseline (718ea7c3df73891605182f6e1c74366026e67898)
- Candidate: candidate (d5b6372d594153bf4cdc91f77b901974addbf1e9)
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"seed":1}

Scenario hash `3836650496f1b91eb042c246dc58572b0ec11efcbe5fced3ecc1f2b2204dd09a`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 6.47873 | 0.182885 | 6.318417 | 9.445042 | 7.075354 | - |
| candidate | 100 | 6.4805 | 0.148646 | 6.333583 | 7.918834 | 7.453673 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 0 | 0 |
| messageVisits | 2000 | 2000 |
| messages | 1000 | 1000 |
| receiptVisits | 1002000 | 1002000 |
| receipts | 1000 | 1000 |
| sessionVisits | 9 | 9 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"seed":1}

Scenario hash `6d0a991e77dd3f4c5d14d39ffc5bd736595a8eb385c595ac3cf21418b9805d3b`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 190.683583 | 6.257728 | 183.206542 | 223.89025 | 216.69394 | - |
| candidate | 100 | 189.730145 | 7.10849 | 183.288125 | 227.412041 | 213.182304 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 0 | 0 |
| messageVisits | 16000 | 16000 |
| messages | 8000 | 8000 |
| receiptVisits | 64016000 | 64016000 |
| receipts | 8000 | 8000 |
| sessionVisits | 9 | 9 |

