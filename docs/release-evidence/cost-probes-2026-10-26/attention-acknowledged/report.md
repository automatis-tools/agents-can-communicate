# Cost comparison: attention

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"attention","ownRequests":1000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `63e5c386f57554f6009fa51cd6d2b1d3937707c987a0de4c416a326bfd714dcd`. **benchmark**.

- baseline fixture: `9202b632d48dafd293d3d5d0b2c5a3b61f63ac6423d5ef3f4fba4575b99f2559`
- candidate fixture: `9202b632d48dafd293d3d5d0b2c5a3b61f63ac6423d5ef3f4fba4575b99f2559`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 7.427666 | 0.877885 | 6.924792 | 11.958166 | 9.917996 | - |
| candidate | 100 | 7.382292 | 0.889948 | 6.9125 | 11.480042 | 9.610673 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 8 | 8 |
| messageVisits | 2016 | 2016 |
| messages | 1008 | 1008 |
| receiptVisits | 1014048 | 1014048 |
| receipts | 1008 | 1008 |
| sessionVisits | 9 | 9 |

## {"probe":"attention","ownRequests":8000,"fanout":1,"acknowledgedShare":1,"offlineShare":0.5,"inboundObligations":0,"witnesses":4,"seed":1}

Scenario hash `8e21686ec3779a002bb79bde8ab0fa935330bfe8cb4e7e804ce00d4d886c456e`. **benchmark**.

- baseline fixture: `d065af78474a949f65bba4148b9059074bd1261bce29f98d50d59bb06b74b4de`
- candidate fixture: `d065af78474a949f65bba4148b9059074bd1261bce29f98d50d59bb06b74b4de`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 258.291417 | 54.712156 | 207.404333 | 553.705666 | 454.306368 | - |
| candidate | 100 | 254.530875 | 40.769657 | 208.524709 | 470.952917 | 437.843416 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| items | 8 | 8 |
| messageVisits | 16016 | 16016 |
| messages | 8008 | 8008 |
| receiptVisits | 64112048 | 64112048 |
| receipts | 8008 | 8008 |
| sessionVisits | 9 | 9 |

