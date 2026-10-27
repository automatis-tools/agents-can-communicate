# Cost comparison: transaction

- Baseline: `v0.12.2`, 718ea7c3df73891605182f6e1c74366026e67898, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Candidate: `worktree`, 8cdf7d2953e09515baa1c41180d002dea058863f, sources `924f5fae1b052249c790d310bc0a071c85145ecde5be9e83bf07870e60bc68d4`
- Harness: 8cdf7d2953e09515baa1c41180d002dea058863f
- Host: v26.5.1, Darwin, arm64, Apple M5 Max, 18 cores
- Durability: fsync: skipped; NODE_OPTIONS `--import file:///Users/mmykola87/work/automatis-tools/agents-can-communicate/agents-can-communicate/.gitworktrees/feat-comparable-cost-probes/scripts/test-skip-fsync.mjs`
- Settings: 10 rounds, 10 samples per child, 3 warm-up calls

## {"probe":"transaction","messages":30,"events":100,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `05eebd41ac71f19ea966819f92dc4115d6f1889b7301ae4a5373bd3ce358a23f`. **benchmark**.

- baseline fixture: `23ca3c74508daafced573a2112d510ab2698ff155b5da2c79ed5e009a98bdd98`
- candidate fixture: `23ca3c74508daafced573a2112d510ab2698ff155b5da2c79ed5e009a98bdd98`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 1.92373 | 0.348625 | 1.576208 | 7.310875 | 3.686015 | - |
| candidate | 100 | 1.920354 | 0.819354 | 1.63025 | 7.151917 | 5.91579 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 101 | 101 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 100 | 100 |
| readBytes | 3046 | 3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

## {"probe":"transaction","messages":30,"events":2000,"operation":"read","pendingJournal":true,"seed":1}

Scenario hash `7dc7175a35e17fcd1a2674998b15e88cbe16615fa60ee0ec99e24e4effde4321`. **benchmark**.

- baseline fixture: `57a23fc48f1c9ae1636fef74b7ac4cf0239d216e54c974cbf61c2f2d614bada4`
- candidate fixture: `57a23fc48f1c9ae1636fef74b7ac4cf0239d216e54c974cbf61c2f2d614bada4`

| Side | n | median ms | IQR ms | min ms | max ms | p95 ms | p99 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 100 | 3.445083 | 0.78373 | 2.86 | 8.216292 | 5.430875 | - |
| candidate | 100 | 3.306855 | 0.997521 | 2.908125 | 8.386 | 5.894548 | - |

Tails not reported - baseline p99: insufficient evidence: 100 samples, 1000 needed; candidate p99: insufficient evidence: 100 samples, 1000 needed.

Diagnostic operation counts (what each side touched; never a validity condition):

| Observation | baseline | candidate |
|---|---:|---:|
| enumerations.events/readdir | 1 | 1 |
| enumerations.events/readdirEntries | 2001 | 2001 |
| enumerations.metadata/readdir | 1 | 1 |
| enumerations.metadata/readdirEntries | 6 | 6 |
| events | 2000 | 2000 |
| readBytes | 3046 | 3046 |
| stateByKind.message | 1 | 1 |
| stateByKind.receipt | 1 | 1 |
| stateReads | 2 | 2 |

