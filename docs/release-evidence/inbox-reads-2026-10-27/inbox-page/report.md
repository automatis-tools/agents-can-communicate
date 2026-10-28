# Cost comparison: inbox

- Baseline: `0eb0d3d3`, 0eb0d3d3f864d3dd8bdada63fbeaf842d89cfeb0, sources `daaf22f3c5ef332833779eb967b40d769149e7b2e0878359681336fa225a2a97`
- Candidate: `d65c9ac8`, d65c9ac801ece46dc00c59c3108e7d67afc953c9, sources `c868281e1fe25b574b6e10b29e9a69a579c0c2dc661192f727e020f271e5c521`
- Harness: d65c9ac801ece46dc00c59c3108e7d67afc953c9
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"index":"warm","seed":1}

Scenario hash `50c2b85aa8b5c7c5b7fd6cc48f635a1bc1adf1f7db9f37c63087ed4c1d28b812`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.432146 | 0.245448 | 5.124583 | 6.051417 | 5.74214 | - |
| candidate | 100 | 5.637666 | 0.268741 | 5.290292 | 6.392791 | 6.068362 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.04 (range 1.016..1.054 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 72 | 5 |
| pageReads | 0 | 5 |
| readBytes | 37224 | 43757 |
| stateByKind.message | 32 | 25 |
| stateByKind.receipt | 32 | 25 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 52 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"index":"cold","seed":1}

Scenario hash `02ff9cfd3a3cfab2d0550eaa6641be8d022fa01a67430a1d6589bbd70b2a2f27`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.450895 | 0.264229 | 5.097209 | 8.425458 | 5.822971 | - |
| candidate | 100 | 10.090104 | 0.473209 | 9.60725 | 11.449125 | 10.753076 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.863 (range 1.803..1.928 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 0 | 14 |
| readBytes | 37224 | 103274 |
| stateByKind.message | 32 | 57 |
| stateByKind.receipt | 32 | 57 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 116 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"index":"rebuilt","seed":1}

Scenario hash `eeae1d75d83cc52130e6d36b8af320bde8ce603d80116ccb0cc05963c2432a91`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.473416 | 0.270875 | 5.033042 | 9.566291 | 6.513126 | - |
| candidate | 100 | 10.223062 | 0.443688 | 9.561167 | 11.692167 | 10.993944 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.858 (range 1.717..1.897 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 0 | 14 |
| readBytes | 37224 | 103730 |
| stateByKind.message | 32 | 57 |
| stateByKind.receipt | 32 | 57 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 116 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"page","limit":1,"mix":true,"index":"unavailable","seed":1}

Scenario hash `d22777295025a18867ade46818e6c5cfa5a19ce7bd80834d889749f7c9cfd9b9`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.48575 | 0.292052 | 5.037625 | 6.383166 | 6.075717 | - |
| candidate | 100 | 9.668876 | 0.424865 | 8.912042 | 11.271583 | 10.687694 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.757 (range 1.692..1.797 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 62 | 62 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 0 | 10 |
| readBytes | 37224 | 90499 |
| stateByKind.message | 32 | 57 |
| stateByKind.receipt | 32 | 57 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 116 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"index":"warm","seed":1}

Scenario hash `a1b4b4b52147e450fe6c461b9d024df99cd2ceecf55f43049d00f5d183eaf77d`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 32.447187 | 0.727063 | 31.291833 | 35.764708 | 33.719571 | - |
| candidate | 100 | 5.634729 | 0.243948 | 5.347291 | 9.685958 | 6.597338 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.174 (range 0.171..0.201 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 612 | 5 |
| pageReads | 0 | 5 |
| readBytes | 300730 | 35571 |
| stateByKind.message | 302 | 25 |
| stateByKind.receipt | 302 | 25 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 52 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"index":"cold","seed":1}

Scenario hash `941b129032377597b2b410b56f35823226bc38fed054d7b1549deabc3957941b`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 32.565312 | 0.800001 | 31.496834 | 53.685708 | 33.869292 | - |
| candidate | 100 | 44.193999 | 1.227469 | 42.413375 | 47.635209 | 46.140125 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.36 (range 1.332..1.393 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 614 |
| pageReads | 0 | 112 |
| readBytes | 300730 | 596654 |
| stateByKind.message | 302 | 327 |
| stateByKind.receipt | 302 | 327 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 656 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"index":"rebuilt","seed":1}

Scenario hash `e25df55e98bec33e9ca7f9809957d139bc75b1ed9e9a5e263ac05e2c40f3b1fe`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 32.54748 | 0.897427 | 31.523042 | 41.081959 | 33.955463 | - |
| candidate | 100 | 44.678292 | 1.166292 | 42.630416 | 48.103916 | 46.429335 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.372 (range 1.334..1.396 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 614 |
| pageReads | 0 | 112 |
| readBytes | 300730 | 597110 |
| stateByKind.message | 302 | 327 |
| stateByKind.receipt | 302 | 327 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 656 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"page","limit":1,"mix":true,"index":"unavailable","seed":1}

Scenario hash `06e97aed50fa0509269c0f8d795de3bcd005d7fc637cf8f3451349cf30d7e1ec`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 32.562041 | 0.751021 | 31.715417 | 34.483459 | 33.53456 | - |
| candidate | 100 | 43.471958 | 1.145458 | 41.999667 | 55.9075 | 46.669131 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.333 (range 1.3..1.355 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 330 | 330 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 612 | 614 |
| pageReads | 0 | 108 |
| readBytes | 300730 | 592209 |
| stateByKind.message | 302 | 327 |
| stateByKind.receipt | 302 | 327 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 656 |

