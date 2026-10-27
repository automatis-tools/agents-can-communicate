# Cost comparison: transaction

- Baseline: baseline (718ea7c3df73891605182f6e1c74366026e67898)
- Candidate: candidate (d5b6372d594153bf4cdc91f77b901974addbf1e9)
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","seed":1}

Scenario hash `b376f2b9b265b8bd54672fd4377faef1167d2cc168afde7b28e61311f66dd2c1`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 1.814187 | 0.262063 | 1.608417 | 8.633625 | 2.423877 | - |
| candidate | 100 | 1.820437 | 0.414865 | 1.601125 | 6.229834 | 3.026598 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 100 | 100 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3045..3046 | 3045..3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","seed":1}

Scenario hash `852b4f7c6b9422f2b5b43e9c73d907e2ac70318fc1e5d0e454005baa48e67555`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.3985 | 0.967552 | 2.826166 | 10.772792 | 5.808071 | - |
| candidate | 100 | 3.129542 | 0.708156 | 2.82975 | 46.639792 | 24.949156 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2000 | 2000 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3045..3046 | 3045..3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

