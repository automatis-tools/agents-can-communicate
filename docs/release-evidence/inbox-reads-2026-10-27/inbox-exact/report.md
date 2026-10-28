# Cost comparison: inbox

- Baseline: `0eb0d3d3`, 0eb0d3d3f864d3dd8bdada63fbeaf842d89cfeb0, sources `daaf22f3c5ef332833779eb967b40d769149e7b2e0878359681336fa225a2a97`
- Candidate: `d65c9ac8`, d65c9ac801ece46dc00c59c3108e7d67afc953c9, sources `c868281e1fe25b574b6e10b29e9a69a579c0c2dc661192f727e020f271e5c521`
- Harness: d65c9ac801ece46dc00c59c3108e7d67afc953c9
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: real
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"index":"warm","seed":1}

Scenario hash `b1f3554133814d9015c2405487b7f9173de54d05644168231b2c57544366b884`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 34.192771 | 29.883833 | 5.347625 | 94.059041 | 87.700454 | - |
| candidate | 100 | 31.77177 | 34.474573 | 1.951292 | 63.664209 | 55.149487 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.934 (range 0.471..1.097 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 72 | 5 |
| pageReads | 2 | 11 |
| readBytes | 53215 | 34445 |
| stateByKind.message | 32 | 1 |
| stateByKind.receipt | 32 | 1 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 4 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"index":"cold","seed":1}

Scenario hash `18caf1bdb02e9d8a5b52f57431aabed012e1d5435dcba304818970152a496de0`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 33.860125 | 30.828427 | 5.152958 | 130.713084 | 93.866382 | - |
| candidate | 100 | 29.205917 | 29.538374 | 1.9315 | 61.456208 | 53.503702 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.89 (range 0.416..1.238 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 2 | 13 |
| readBytes | 53215 | 79094 |
| stateByKind.message | 32 | 33 |
| stateByKind.receipt | 32 | 33 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 68 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"index":"rebuilt","seed":1}

Scenario hash `2c13041ad58e7c14d66d3afbd08aec86102e6cd4d3856c9acdfe271f4413e32e`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 33.396209 | 35.059438 | 5.408667 | 62.282833 | 51.629442 | - |
| candidate | 100 | 29.30825 | 25.768844 | 2.038 | 63.512166 | 52.701189 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.908 (range 0.659..1.27 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 2 | 13 |
| readBytes | 53215 | 79550 |
| stateByKind.message | 32 | 33 |
| stateByKind.receipt | 32 | 33 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 68 |

## {"probe":"inbox","messages":30,"backlog":0,"operation":"exact","limit":20,"mix":true,"index":"unavailable","seed":1}

Scenario hash `0d8ff646a8e5acc80581c6a3a6cdce6d68dd121123a70aef4292518bb0c6bce6`. **benchmark**.

- baseline fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`
- candidate fixture: `1093ea081e2916690d7b77d7cd0de3b45251db508d6dd6b86a2d83e0cf25d53b`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 31.975958 | 31.015698 | 5.058166 | 105.7905 | 73.450168 | - |
| candidate | 100 | 29.52148 | 28.318593 | 2.0145 | 71.504625 | 60.370871 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.917 (range 0.634..1.238 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 71 | 71 |
| enumerations.metadata/readdir | 4 | 4 |
| enumerations.metadata/readdirEntries | 72 | 74 |
| pageReads | 0 | 6 |
| readBytes | 40457 | 63814 |
| stateByKind.message | 32 | 33 |
| stateByKind.receipt | 32 | 33 |
| stateByKind.session | 4 | 2 |
| stateReads | 68 | 68 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"index":"warm","seed":1}

Scenario hash `009bb3e0be4307d9c1e7cb4b3b57e17a5429f443086a44e0af8add6ec1b3bf2c`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 61.469167 | 34.698301 | 32.041042 | 104.159 | 90.956807 | - |
| candidate | 100 | 35.315584 | 37.998511 | 2.1905 | 73.530375 | 56.58861 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.568 (range 0.452..0.664 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 612 | 5 |
| pageReads | 2 | 5 |
| readBytes | 306361 | 12525 |
| stateByKind.message | 302 | 1 |
| stateByKind.receipt | 302 | 1 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 4 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"index":"cold","seed":1}

Scenario hash `e32afa9b5a510c23e09cb9e864e19186dc31cfe6c357f0a0d13e5f6c2dc71ea9`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 60.765605 | 30.782604 | 31.832583 | 125.427208 | 87.492086 | - |
| candidate | 100 | 38.281959 | 44.295927 | 2.186208 | 236.244625 | 83.5293 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.597 (range 0.466..0.673 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 612 | 5 |
| pageReads | 2 | 0 |
| readBytes | 306361 | 7411 |
| stateByKind.message | 302 | 1 |
| stateByKind.receipt | 302 | 1 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 4 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"index":"rebuilt","seed":1}

Scenario hash `357cbdf89f8b5972eb5c1b669ea4528babbe8ffa9693d14ec82a8c5964dca168`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 62.653979 | 34.215063 | 31.799625 | 91.937958 | 74.378488 | - |
| candidate | 100 | 40.02127 | 45.061313 | 2.200666 | 115.252292 | 85.5087 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.597 (range 0.443..0.701 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 612 | 5 |
| pageReads | 2 | 0 |
| readBytes | 306361 | 7867 |
| stateByKind.message | 302 | 1 |
| stateByKind.receipt | 302 | 1 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 4 |

## {"probe":"inbox","messages":30,"backlog":270,"operation":"exact","limit":20,"mix":true,"index":"unavailable","seed":1}

Scenario hash `e1f41b1e99c3b558511d33395e0a563747bc53d860d049969f48f401f5150ffc`. **benchmark**.

- baseline fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`
- candidate fixture: `34410714f6e2dfa975312d2bc218e89bb0f818344996386fe05864ab6c41f10e`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 60.851479 | 29.927052 | 32.080791 | 80.362541 | 72.505035 | - |
| candidate | 100 | 39.986271 | 41.176052 | 2.2075 | 91.912625 | 81.670556 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.6 (range 0.505..0.763 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 339 | 339 |
| enumerations.metadata/readdir | 4 | 1 |
| enumerations.metadata/readdirEntries | 612 | 5 |
| pageReads | 0 | 0 |
| readBytes | 303963 | 7411 |
| stateByKind.message | 302 | 1 |
| stateByKind.receipt | 302 | 1 |
| stateByKind.session | 4 | 2 |
| stateReads | 608 | 4 |

