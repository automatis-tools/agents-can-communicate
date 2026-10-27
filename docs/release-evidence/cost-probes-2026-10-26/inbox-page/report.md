# Cost comparison: inbox

- Baseline: baseline (718ea7c3df73891605182f6e1c74366026e67898)
- Candidate: candidate (d5b6372d594153bf4cdc91f77b901974addbf1e9)
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"seed":1}

Scenario hash `ec30eaaab7f03b1f8f3ca5aceff2193ab1d3beacb29e394c48e66abbcf00def7`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.73375 | 1.093395 | 5.008875 | 12.164708 | 11.387596 | - |
| candidate | 100 | 5.656646 | 0.693281 | 5.099084 | 22.388333 | 8.493498 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 34 | 34 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 68 | 68 |
| pageReads | 0 | 0 |
| readBytes | 33795 | 33795 |
| stateByKind.message | 30 | 30 |
| stateByKind.receipt | 30 | 30 |
| stateByKind.session | 4 | 4 |
| stateReads | 64 | 64 |

## {"probe":"inbox","messages":300,"backlog":0,"operation":"page","limit":1,"seed":1}

Scenario hash `d5d7fe84a2824b1d37109138ed61036939a174d03897040f4b9fbac40413ab63`. **benchmark**.

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 33.966646 | 3.605687 | 31.676667 | 72.927292 | 56.074475 | - |
| candidate | 100 | 33.441313 | 2.106083 | 31.079209 | 39.008167 | 36.881954 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 304 | 304 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 608 | 608 |
| pageReads | 0 | 0 |
| readBytes | 297445 | 297445 |
| stateByKind.message | 300 | 300 |
| stateByKind.receipt | 300 | 300 |
| stateByKind.session | 4 | 4 |
| stateReads | 604 | 604 |

