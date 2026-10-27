# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 1ae97c784d804e0d1d685d1333e9f86002f76d5a, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 1ae97c784d804e0d1d685d1333e9f86002f76d5a
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `07df3381855de06f79cf76f2f7beea0c8864ca78389311a869d5b662e9c11f36`. **benchmark**.

- baseline fixture: `fa7979553f13a4177c397d2a6c6c192eb9074e6ce564482811d25a76b42d7b55`
- candidate fixture: `fa7979553f13a4177c397d2a6c6c192eb9074e6ce564482811d25a76b42d7b55`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.480145 | 0.26375 | 6.859459 | 9.164791 | 8.184073 | - |
| candidate | 100 | 7.507041 | 0.351771 | 6.800334 | 11.245708 | 8.225971 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.002 (range 0.931..1.027 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 2068 | 2068 |
| messages | 1034 | 1034 |
| receiptVisits | 1049510 | 1049510 |
| receipts | 1034 | 1034 |
| sessionVisits | 61 | 61 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `bb9ce0a36a933dabc99f655cc1decb40e886d8eef8c655e4d1f1b39a8fa95adc`. **benchmark**.

- baseline fixture: `b390b319dfa8fa9858b7ae748427b793489105bd18e0624aa7413ad8f37652ea`
- candidate fixture: `b390b319dfa8fa9858b7ae748427b793489105bd18e0624aa7413ad8f37652ea`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 260.388604 | 156.53325 | 209.154125 | 459.899375 | 439.477298 | - |
| candidate | 100 | 270.271354 | 173.1625 | 209.353834 | 444.074417 | 433.880993 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.035 (range 0.94..1.157 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 16068 | 16068 |
| messages | 8034 | 8034 |
| receiptVisits | 64392510 | 64392510 |
| receipts | 8034 | 8034 |
| sessionVisits | 61 | 61 |

