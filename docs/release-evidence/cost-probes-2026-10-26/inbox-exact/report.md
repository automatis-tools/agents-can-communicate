# Cost comparison: inbox

- Baseline: baseline (718ea7c3df73891605182f6e1c74366026e67898)
- Candidate: candidate (d5b6372d594153bf4cdc91f77b901974addbf1e9)
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":1,"seed":1}

Scenario hash `48e1c05a48f3ec3c251c4288b73838af1d1a3d90ad72d406e56743d8d427a2ba`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 45.68325 | 3.482375 | 35.717375 | 109.272709 | 61.356135 | - |
| candidate | 100 | 45.596938 | 2.483126 | 41.691125 | 144.414 | 61.775871 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 47 | 47 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 68 | 68 |
| pageReads | 2 | 2 |
| readBytes | 48993 | 48993 |
| stateByKind.message | 30 | 30 |
| stateByKind.receipt | 30 | 30 |
| stateByKind.session | 4 | 4 |
| stateReads | 64 | 64 |

## {"probe":"inbox","messages":300,"backlog":0,"operation":"exact","limit":1,"seed":1}

Scenario hash `794e469710736e85de1310f1b7c011e8e421bff03f1622e607a785fe03b2af8a`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 71.485167 | 2.409073 | 64.226584 | 115.765625 | 78.247341 | - |
| candidate | 100 | 71.669459 | 3.49002 | 62.502833 | 92.48825 | 83.241881 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 317 | 317 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 608 | 608 |
| pageReads | 2 | 2 |
| readBytes | 303091 | 303091 |
| stateByKind.message | 300 | 300 |
| stateByKind.receipt | 300 | 300 |
| stateByKind.session | 4 | 4 |
| stateReads | 604 | 604 |

