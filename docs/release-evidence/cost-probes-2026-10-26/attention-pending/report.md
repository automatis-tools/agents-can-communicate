# Cost comparison: attention

- Baseline: baseline (718ea7c3df73891605182f6e1c74366026e67898)
- Candidate: candidate (d5b6372d594153bf4cdc91f77b901974addbf1e9)
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"seed":1}

Scenario hash `9a35f899f3f9812cd98fcec59cf82e92ce581198077647698b81c7edd762a4d4`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 6.552208 | 0.428521 | 6.337875 | 8.002958 | 7.331991 | - |
| candidate | 100 | 6.532146 | 0.314416 | 6.312125 | 8.224083 | 7.250721 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 0 | 0 |
| messageVisits | 2000 | 2000 |
| messages | 1000 | 1000 |
| receiptVisits | 1002000 | 1002000 |
| receipts | 1000 | 1000 |
| sessionVisits | 15 | 15 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"seed":1}

Scenario hash `f880e77b3e7e68a46c8723f6582996d89a3052709f09dc8344b601acd27d98a5`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 196.498625 | 6.242365 | 191.008625 | 234.750792 | 217.637156 | - |
| candidate | 100 | 194.736771 | 5.956261 | 191.310666 | 222.938375 | 208.716169 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 0 | 0 |
| messageVisits | 16000 | 16000 |
| messages | 8000 | 8000 |
| receiptVisits | 64016000 | 64016000 |
| receipts | 8000 | 8000 |
| sessionVisits | 15 | 15 |

