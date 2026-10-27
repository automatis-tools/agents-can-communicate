# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, ca1ac9fc7e803646c728353c00f84e0a7dbc0db2, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: ca1ac9fc7e803646c728353c00f84e0a7dbc0db2
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `05eebd41ac71f19ea966819f92dc4115d6f1889b7301ae4a5373bd3ce358a23f`. **benchmark**.

- baseline fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`
- candidate fixture: `cbcfcb7d2bd9f1b9b0a1ad847da37a7a9e7be3c0ba25d38d4f1584d490181cbd`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.672334 | 4.202698 | 3.073542 | 17.131375 | 9.144255 | - |
| candidate | 100 | 3.578708 | 0.518157 | 3.021875 | 13.607541 | 8.81904 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.02 (range 0.41..1.378 over 10 rounds).

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

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `7dc7175a35e17fcd1a2674998b15e88cbe16615fa60ee0ec99e24e4effde4321`. **benchmark**.

- baseline fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`
- candidate fixture: `ab57760ee67bd746cd5bb829e75574601db69dce0c711a0ed602ff052e5fe09d`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 4.843625 | 0.53099 | 4.35625 | 39.499833 | 32.340225 | - |
| candidate | 100 | 5.094521 | 0.757719 | 4.518167 | 11.921917 | 6.696694 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Paired by round, candidate median / baseline median: 1.016 (range 0.154..1.161 over 10 rounds).

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

