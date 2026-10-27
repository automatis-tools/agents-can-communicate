# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 1ae97c784d804e0d1d685d1333e9f86002f76d5a, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 1ae97c784d804e0d1d685d1333e9f86002f76d5a
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `4de70cf77abb9f8c8df866e3b35a25f41dffeb3ac8476bcaf21dd4b2f1d3a39d`. **benchmark**.

- baseline fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`
- candidate fixture: `2600aed6c3ee5b572663f1a921174934581f7a064091aea4e8071be8a2cf144f`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 1.716583 | 0.110936 | 1.589959 | 3.537291 | 2.016377 | - |
| candidate | 100 | 1.752876 | 0.170687 | 1.564459 | 6.525208 | 3.51494 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.032 (range 0.978..1.315 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 111 | 111 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3204 | 3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `05eebd41ac71f19ea966819f92dc4115d6f1889b7301ae4a5373bd3ce358a23f`. **benchmark**.

- baseline fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`
- candidate fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.320104 | 0.243822 | 3.071291 | 5.58875 | 3.818025 | - |
| candidate | 100 | 3.355 | 0.294947 | 3.040625 | 4.948541 | 3.846858 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.027 (range 0.946..1.084 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 114 | 114 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 5794 | 5794 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":false,"seed":1}

Scenario hash `073fc8318993111b73c4577d4c15bcbd92053cc27890101be30da7e87c3a28ef`. **benchmark**.

- baseline fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`
- candidate fixture: `462b2fdeee878dcde18cc7e0e9bc0c6281e5e118bcc4c9159af089a42c61d1d9`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.168479 | 0.261135 | 2.888375 | 4.271167 | 3.858919 | - |
| candidate | 100 | 3.067792 | 0.137782 | 2.910083 | 5.486875 | 3.635597 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.964 (range 0.939..1.034 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2011 | 2011 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3204 | 3204 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `7dc7175a35e17fcd1a2674998b15e88cbe16615fa60ee0ec99e24e4effde4321`. **benchmark**.

- baseline fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`
- candidate fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 4.72525 | 0.340979 | 4.390709 | 13.2955 | 9.692477 | - |
| candidate | 100 | 4.664645 | 0.383532 | 4.357041 | 13.014 | 10.116061 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 0.992 (range 0.48..2.172 over 10 rounds).

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2014 | 2014 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 5794 | 5794 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

