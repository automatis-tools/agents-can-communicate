# Cost comparison: attention

- Baseline: `3b6aab72`, 3b6aab722b13cf4d11d4c724133edb329add1371, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 6f1dcb37dddf8b35940915b6eec80ac5a198d4ab, sources `daaf22f3c5ef332833779eb967b40d769149e7b2e0878359681336fa225a2a97`
- Harness: 6f1dcb37dddf8b35940915b6eec80ac5a198d4ab
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `07df3381855de06f79cf76f2f7beea0c8864ca78389311a869d5b662e9c11f36`. **benchmark**.

- baseline fixture: `fa7979553f13a4177c397d2a6c6c192eb9074e6ce564482811d25a76b42d7b55`
- candidate fixture: `fa7979553f13a4177c397d2a6c6c192eb9074e6ce564482811d25a76b42d7b55`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.719917 | 2.72451 | 6.959167 | 25.337833 | 17.375499 | - |
| candidate | 100 | 0.586084 | 0.201865 | 0.415834 | 1.270708 | 0.969268 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.07 (range 0.051..0.089 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 2068 | 2068 |
| messages | 1034 | 1034 |
| receiptVisits | 1049510 | 3102 |
| receipts | 1034 | 1034 |
| sessionVisits | 61 | 61 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `bb9ce0a36a933dabc99f655cc1decb40e886d8eef8c655e4d1f1b39a8fa95adc`. **benchmark**.

- baseline fixture: `b390b319dfa8fa9858b7ae748427b793489105bd18e0624aa7413ad8f37652ea`
- candidate fixture: `b390b319dfa8fa9858b7ae748427b793489105bd18e0624aa7413ad8f37652ea`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 339.75875 | 182.672979 | 210.235125 | 2000.564167 | 1027.532937 | - |
| candidate | 100 | 4.374396 | 1.446459 | 3.088667 | 67.898125 | 8.378712 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.015 (range 0.008..0.019 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 16068 | 16068 |
| messages | 8034 | 8034 |
| receiptVisits | 64392510 | 24102 |
| receipts | 8034 | 8034 |
| sessionVisits | 61 | 61 |

## {"probe":"attention","ownRequests":16000,"fanout":1,"acknowledgedShare":0,"offlineShare":0,"inboundObligations":0,"witnesses":4,"leftRule":"limit","seed":1}

Scenario hash `955dfb5b4bd1af093962ad700ad4eee2e285b71b2cc1b3dac84153e24361739c`. **benchmark**.

- baseline fixture: `4a92a4aa97f8dc5898aff8fde80c321611afa4a5875f5384c4f674aa34cabcfa`
- candidate fixture: `4a92a4aa97f8dc5898aff8fde80c321611afa4a5875f5384c4f674aa34cabcfa`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 1057.586479 | 162.279115 | 891.141792 | 4811.558458 | 1991.815937 | - |
| candidate | 100 | 8.773938 | 2.69702 | 5.903375 | 78.496458 | 18.667723 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.008 (range 0.007..0.012 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 22 | 22 |
| messageVisits | 32068 | 32068 |
| messages | 16034 | 16034 |
| receiptVisits | 256784510 | 48102 |
| receipts | 16034 | 16034 |
| sessionVisits | 61 | 61 |

