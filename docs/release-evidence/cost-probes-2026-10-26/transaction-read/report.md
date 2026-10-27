# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 31231946630526483270adbf21b62c5aa0d47ecf, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 31231946630526483270adbf21b62c5aa0d47ecf
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `4de70cf77abb9f8c8df866e3b35a25f41dffeb3ac8476bcaf21dd4b2f1d3a39d`. **benchmark**.

- baseline fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`
- candidate fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 2.008333 | 0.579605 | 1.586959 | 6.142625 | 4.054869 | - |
| candidate | 100 | 1.911375 | 0.496739 | 1.555042 | 53.713333 | 7.99419 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.982 (range 0.816..2.847 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 111 | 111 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3203..3204 | 3203..3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `05eebd41ac71f19ea966819f92dc4115d6f1889b7301ae4a5373bd3ce358a23f`. **benchmark**.

- baseline fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`
- candidate fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.725167 | 0.775875 | 3.015792 | 66.404292 | 10.285854 | - |
| candidate | 100 | 3.710354 | 0.619094 | 3.104042 | 8.733917 | 5.204506 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.991 (range 0.357..1.219 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 114 | 114 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 5793..5794 | 5793..5794 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `073fc8318993111b73c4577d4c15bcbd92053cc27890101be30da7e87c3a28ef`. **benchmark**.

- baseline fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`
- candidate fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.443 | 0.605313 | 2.965416 | 9.694459 | 5.721825 | - |
| candidate | 100 | 3.506209 | 0.506032 | 3.025542 | 14.704375 | 9.370832 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.013 (range 0.853..1.738 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2011 | 2011 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3203..3204 | 3203..3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `7dc7175a35e17fcd1a2674998b15e88cbe16615fa60ee0ec99e24e4effde4321`. **benchmark**.

- baseline fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`
- candidate fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 5.094146 | 0.699729 | 4.45675 | 36.830208 | 8.408314 | - |
| candidate | 100 | 5.283042 | 0.944511 | 4.487 | 10.974834 | 7.887241 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.022 (range 0.887..1.298 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2014 | 2014 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 5793..5794 | 5793..5794 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

