# Combined hardening verification

This snapshot reconciles all four archived hardening sets on the preserved
Papercut layout. It is the certified source for standalone extraction. It is not
the standalone package layout.

## Provenance

| Item | Value |
|---|---|
| Baseline commit | `9a866cf16f97a0aa1af7ea792acc79bc02278633` |
| Verified at HEAD | `c7057365ac91fdd344338d505eba44b0a58f37b4` |
| Branch | `chore/prototype-reconciliation` |
| Node | `v24.4.0` |
| Platform | `Darwin 25.5.0 arm64`, 18 CPUs |

Integration commits, in order:

```text
1689407 chore: create integrated protocol snapshot
0f16446 fix: harden integrated message storage
e192939 fix: harden integrated agent lifecycle
862b0cd fix: complete integrated recovery audits
c705736 fix: complete integrated protocol prompt
```

## Final verification

All commands were run from the repository root unless noted.

| Command | Result |
|---|---|
| `npm run test:integrated` | **269 tests, 269 pass, 0 fail**, exit 0, three consecutive runs (~50 s each) |
| `find prototype/integrated/tools/agents -name '*.mjs' \| xargs -n1 node --check` | exit 0 |
| `git diff --check` | exit 0 |
| line-count policy, `$1 >= 300` | exit 0; the largest file is 299 lines |

Per-area combined regressions:

| File | Result |
|---|---|
| `combined-hardening-lifecycle.test.mjs` | 7 tests, 7 pass |
| `combined-hardening-storage.test.mjs` | 6 tests, 6 pass |
| `combined-hardening-doctor.test.mjs` | 4 tests, 4 pass |

Test growth across the reconciliation: 181 baseline → 210 after storage → 232
after lifecycle → 251 after doctor → 252 after prompt → 269 with the combined
regressions.

## Coverage of the twelve required combined regressions

Each case in `docs/MIGRATION.md` under "Required combined regressions" is
exercised in exactly one combined file.

| # | Case | Where |
|---|---|---|
| 1 | foreign-workspace protocol blocks every non-init command before mutation | lifecycle |
| 2 | malformed or unknown foreign protocol also blocks `doctor --repair` | lifecycle |
| 3 | `init` validates an existing protocol identity before creating layout | lifecycle |
| 4 | lifecycle register/close/start shares one ownership critical section | lifecycle |
| 5 | broadcast recipients are live, not merely registered open | lifecycle |
| 6 | managed-root reads reject symlinked parent directories | storage |
| 7 | inbox and archive filenames bind to message IDs | storage |
| 8 | acknowledgements cannot overwrite immutable archives | storage |
| 9 | two doctors plus a concurrent publisher cannot delete the new generation | doctor |
| 10 | audit-published/pre-mutation claim and mutex operations replay safely | doctor |
| 11 | all recovery artifacts are continuously inventoried | doctor |
| 12 | unknown protocol/schema versions fail closed before any repair | lifecycle |

Case 1 enumerates all fourteen gated command forms, asserts exit 4, asserts JSON
stdout purity where the command supports `--json` (`watch` does not), and
compares a base64 snapshot of the entire foreign workspace tree before and after
each attempt.

## Mutation evidence

Every protection group was proven live by neutralising an exact production
predicate, observing the named failure, and restoring the file immediately.

The central finding is that **no single predicate carries a group**. Each group
is defence in depth, and a single-predicate mutation is not sufficient to make
the combined tests fail. That is a property worth recording, not a gap.

### Storage group

| Mutation | Outcome |
|---|---|
| `safe-directory.mjs`: `!details.isDirectory() \|\| details.isSymbolicLink()` neutralised | 6/6 still pass |
| `safe-directory.mjs`: canonical `realpath(current) !== expected` neutralised | 6/6 still pass |
| **both neutralised** | **2 fail**: cases 6a and 6b |

With both barriers gone, `acc status` exits 0 and returns a full status payload
containing the registry records read through the symlinked parent, and the
assertion prints that payload. Restored, 6/6 pass.

### Lifecycle group

| Mutation | Outcome |
|---|---|
| `comms.mjs`: the `requireCheckoutProtocol` call for every non-`init`/`prompt` command neutralised | **2 fail**: cases 1 and 2 |

Cases 3 and 12 correctly keep passing under this mutation, because `initBus`
asserts checkout identity itself and `validateProtocol` rejects unknown versions
wherever the protocol is read. The independence is deliberate. Restored, 7/7.

### Doctor group

| Mutation | Outcome |
|---|---|
| `status.mjs`: outer `corruptAudit` gate neutralised | 4/4 still pass |
| `status.mjs`: both `corruptAudit` and the mutex-held `lockedCorruptAudit` recheck neutralised | **1 fail**: case 11 |

Exact failure:

```text
✖ 11: every recovery artifact family is inventoried and blocks unrelated repair
  Error [CommsError]: corrupt claim recovery audit
      at repairPendingForceReleases (tools/agents/lib/claims.mjs:258:42)
      at async performRepairs (tools/agents/lib/status.mjs:254:19)
```

A third barrier inside `repairPendingForceReleases` fires once the two doctor
gates are gone, so repair still fails closed rather than acting on ambiguous
recovery state. Restored, 4/4 pass.

### Earlier per-task mutation evidence

| Gate | Mutation | Failure |
|---|---|---|
| watcher SIGTERM lifecycle | drop the `SIGTERM` registration in `signal-stop.mjs` | `watcher did not stop gracefully: {"code":null,"signal":"SIGTERM"}` |
| stdin liveness | make `messageInput` read stdin unconditionally | `send waited for stdin for 30000ms despite an explicit body source` |
| init layout ordering | move `ensureBusLayout` ahead of the identity assertion | `init mutated a foreign checkout bus` |
| force-release replay | remove the scanner check **and** the replay generation check | replay runs and the replacement claim generation is unlinked |

## Corrections made during reconciliation

1. The preserved SIGTERM test terminated the watcher after a fixed 80 ms. Watcher
   ownership is published at ~103 ms and online presence at ~109 ms, so the child
   died from the default signal disposition (`code: null, signal: "SIGTERM"`)
   before installing its handler. Replaced with a bounded condition wait on the
   ownership lock plus an online presence record carrying the child's own pid.
2. `explicit body sources ... with stdin left open` encoded a liveness property
   as a 300 ms latency budget. Measured: 40-64 ms idle, 175-840 ms under suite
   load, always exit 0. Replaced with a 30 s liveness ceiling.
3. That ceiling initially made the suite four times slower, because
   `Promise.race` does not cancel the loser and the timer kept the runner alive.
   Clearing it returned `cli-round1.test.mjs` from 31 s to 2.87 s.
4. The archived doctor scanners passed their injected opener in the managed-root
   position. Under the ported storage API that made every recovery artifact read
   fail, and since every scanner wraps its read in `catch { corrupt.add(...) }`,
   the reconciled tree would have declared all recovery artifacts corrupt. Root
   is now threaded through every managed read; a multi-line scan verifies it.

## Remaining limitations

1. **Ancestor-swap race.** A deliberately adversarial same-user process can
   transiently swap and restore an ancestor directory between pathname checks.
   Preserved from `docs/MIGRATION.md` as documented residual hardening; a
   portable dependency-free Node fix is not small. Revisit if the storage
   backend changes.
2. **Suite wall time is contention-bound.** No single test file exceeds ~4.2 s in
   isolation, but the suite saturates 18 cores with CLI subprocesses, so
   individual test durations inflate roughly tenfold under parallel execution.
   This is throughput, not a defect; it does matter for any future CI timeout.
3. **Some focused commands are working-directory sensitive.** The prompt CLI
   resolves its template relative to the process working directory, so focused
   commands must run from `prototype/integrated`, the way `npm run
   test:integrated` does. Running the plan's Task 5 focused command from the
   repository root produces one spurious failure.
4. **Papercut vocabulary is intentionally retained.** `PW2_AGENT_BUS_DIR`,
   checkout identity, agent/task wording, and the `tools/agents/comms.mjs` path
   are unchanged here by design. Renaming belongs to the extraction plan.
5. **Not certified beyond this platform.** All evidence is from one macOS arm64
   host on Node 24.4.0. No Linux or Windows run exists yet.
