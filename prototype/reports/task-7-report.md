# Task 7 report — orchestrator status, doctor, and safe repair

## Outcome

Implemented strict status, diagnostics, and bounded repair. Validated acknowledgements are joined to their validated inbox/archive message, so senders can observe completion without trusting receipt filenames. Status distinguishes agent liveness, message delivery and acknowledgement, claims, blockers, handoffs, audit integrity, and corrupt paths.

Normal doctor remains read-only. Repair is limited to immutable corrupt records, acknowledgement-backed archive completion, Task 5 stale claim-lock repair, and stale watcher ownership. Mutable registry, presence, claim, and lock corruption is reported but not quarantined without the corresponding writer lock.

## Round 1 review fixes

1. Corrupt quarantine now hard-links a snapshot first, verifies bytes plus inode generation, validates that the snapshot is still corrupt, publishes the immutable audit only after verification, and unlinks only the verified generation. A replacement B is retained.
2. Watcher acquire, release, and stale-owner repair share one per-agent atomic filesystem mutex. Two repairers cannot pass the final comparison concurrently with a new owner B.
3. Missing `protocol.json` is `PROTOCOL_MISSING`, status exits 4, and doctor stays non-ok until init.
4. Corrupt-data enforcement takes precedence over requested stale/pending enforcement: 4 before 6.
5. Open registries without heartbeat are offline through 45,000 ms and stale after that boundary using `updated_at`.
6. Claim filenames must equal SHA-256(scope); duplicate scopes invalidate every duplicate generation.
7. Every doctor audit is inventoried on every status/doctor run and strictly bound to its filename, source, quarantine file, and checksum. Corrupt audits make doctor non-ok and block repair.
8. Unknown or missing protocol fails closed before every mutation. Quarantining a corrupt protocol also stops the repair pass until init.
9. Ack-backed archive recovery uses exclusive hard-link publication. Existing destinations must be byte-identical before source unlink; mismatches preserve both records and fail as data corruption.

## Round 2 review fixes

1. Every repair pass is serialized by one crash-recoverable doctor mutex. Its owner is atomically published as a strict PID/token/timestamp record. Two-doctor regressions publish a replacement protocol through `initBus` and a replacement seen receipt after the first unlink; in both cases the queued doctor re-reads state and preserves B.
2. Watcher lifecycle and owner repair now use the same strict per-agent mutex implementation. Status reports live, young, stale, and corrupt mutexes. Explicit doctor repair audits then atomically renames only dead mutexes older than 60 seconds; concurrent two-repairer/new-owner coverage proves the replacement generation remains active.
3. Claim filename SHA-256(scope) binding and duplicate-scope rejection moved into the authoritative reader used by claim, release, close-release, extension, and force-release mutations. Corrupt stores fail with exit 4 before claim records change.
4. Either an unknown `schema_version` or `protocol_version` blocks the doctor before it acquires a mutex or performs any other mutation.
5. Existing doctor audits validate the filename-derived canonical quarantine path and immutable source descriptor before reading the target, then require a regular non-symlink quarantine file.
6. Ack archive publication treats an `EEXIST` followed by a missing source as idempotent only when the strict destination record equals the expected message.

## Round 3 review fixes

1. Initial archive-link `ENOENT` now requires a pre-existing strict destination equal to the expected message. An equal destination is idempotent; a conflicting or missing destination is data corruption and the inbox is preserved.
2. Watcher mutex inventory examines every matching basename regardless of filesystem type. Blocking regular files, symlinks, malformed directories, and invalid agent names are reported corrupt and never repaired.
3. Every `mutex-audit-*` is inventoried on every status/doctor run. Its filename digest, strict target, byte checksum, canonical quarantine directory, and moved owner are bound together; orphan audits and quarantines fail closed and block all repairs.
4. Doctor quarantine and mutex owner reads now open with `O_NOFOLLOW`, verify a regular file with `fstat`, and read through that same handle. Mutex reads also verify the containing directory generation before and after the handle read.

## Round 4 review fixes

1. Mutex repair storage inventory now examines every basename beginning `mutex-audit-` or `mutex-stale-`, including malformed names without canonical extensions or digests. Malformed and orphan targets are reported at their actual paths and block every repair pass.
2. Direct archive-link `ENOENT` validation now opens the destination once with `O_NOFOLLOW`, verifies a regular file through that handle, and parses and validates the bytes read from the same handle. A destination swapped to a symlink is rejected as data corruption while the inbox record is preserved.
3. Enforcement now treats corrupt doctor and watcher mutex states as data corruption even when no path appears in the top-level `corrupt` array.

## TDD and gate-failure evidence

- Original Task 7 RED: missing `status.mjs` caused focused exit 1.
- Round 1 initial focused run: 8 failures out of 9 review fixtures. The watcher interleaving initially escaped, so a mutex-ownership assertion was added and independently failed (`false !== true`) before implementation.
- Observed root-cause failures included replacement B deletion (`ENOENT`), missing protocol returning 0 instead of 4, corrupt+pending returning 6 instead of 4, absent-heartbeat registries never becoming stale, duplicate claims accepted active, corrupt audits ignored, unknown protocol permitting archive/lock mutation, and archive race not rejecting.
- Corrupt-protocol continuation fixture failed with three repairs instead of protocol-only repair, then passed after fail-closed ordering.
- Equal-content archive cleanup was mutation-checked by disabling source unlink: the focused test failed (`false !== true`), then passed after restoring the implementation.
- Round 2 claims RED: all 3 authoritative mutation fixtures accepted a canonical+wrong-name duplicate instead of rejecting it.
- Round 2 status/storage RED: 4/4 fixtures failed for unknown schema mutation protection, quarantine symlink rejection, archive `EEXIST`/source-`ENOENT`, and mutex state reporting.
- Round 2 mutex RED: the new strict mutex API was absent; after the first implementation, the existing watcher race exposed deterministic temporary-path token reuse. The mutex now has a dedicated UUID source and atomically publishes a prepared owner directory.
- Round 2 concurrency RED: both two-doctor fixtures timed out because the unlink seam was not yet writer-observable. After wiring the exact unlink point, both prove only one doctor reaches the corrupt snapshot while init/seen publishes B.
- Round 2 stale doctor RED: repair succeeded but omitted its repair record (`false !== true`); the final report now includes `repair_stale_doctor_mutex`.
- Round 3 initial RED: 8 of 9 fixtures failed. The failures reproduced conflicting direct-`ENOENT` acceptance, ignored file/symlink mutexes, four ignored mutex-audit corruptions, and both deterministic pathname-swap races. The equal direct-`ENOENT` fixture was the required positive control.
- Round 3 orphan RED: after adding audit validation, the missing-audit/missing-target pair exposed one remaining failure—an orphan moved mutex directory was ignored. Inventory now reports the orphan target path.
- Round 4 mutex-storage RED: both malformed basename fixtures were ignored, so the doctor archived acknowledgement-backed work instead of reporting and preserving it (2 failed, 0 passed).
- Round 4 archive RED: direct `ENOENT` accepted an equal destination that was swapped to a symlink at the strict-open seam (`Missing expected rejection`; 1 failed, 0 passed).
- Round 4 enforcement RED: corrupt doctor and watcher mutex status both returned exit 0 instead of exit 4 (2 failed, 0 passed).

## Verification

- `node --test tests/tools/agent_comms/{claims-integrity,repair-mutex,status-round2,doctor-race,status-review,status}.test.mjs` — 40 passed, 0 failed, exit 0.
- `node --test tests/tools/agent_comms/{status-round3,status-round2,doctor-race,repair-mutex,claims-integrity,status-review,status,presence,claims}.test.mjs` — 83 passed, 0 failed, exit 0.
- `node --test tests/tools/agent_comms/*.test.mjs` — 158 passed, 0 failed, exit 0.
- Round 4 focused status/doctor/repair suite — 53 passed, 0 failed, exit 0.
- `node --test tests/tools/agent_comms/*.test.mjs` after Round 4 — 163 passed, 0 failed, exit 0.
- Syntax checks for every changed/new `.mjs` file — exit 0.
- `git diff --check` — exit 0.

## Structural review and plan-owned split

The original two runtime responsibilities could not remain explicit and safe in one sub-300-line module. The narrow split is recorded here:

- `tools/agents/lib/status.mjs`: 299 lines — aggregation, diagnostics, orchestration.
- `tools/agents/lib/doctor-storage.mjs`: 179 lines — immutable snapshot/audit/archive storage.
- `tools/agents/lib/doctor-protocol.mjs`: 12 lines — raw compatibility preflight.
- `tools/agents/lib/status-locks.mjs`: 41 lines — mutex status and doctor routing.
- `tools/agents/lib/repair-mutex.mjs`: 173 lines — strict atomic doctor/watcher mutex ownership, audit inventory, and stale repair.
- `tools/agents/lib/safe-file.mjs`: 24 lines — same-handle no-follow regular-file reads.
- `tools/agents/lib/claim-records.mjs`: 36 lines — canonical claim inventory shared by status and mutations.
- `tools/agents/lib/claims.mjs`: 288 lines — claim mutations and stale claim-lock repair.
- `tools/agents/lib/presence.mjs`: 203 lines — watcher lifecycle only.
- `tools/agents/lib/watcher-ownership.mjs`: 117 lines — ownership validation using the shared mutex boundary.
- `tests/tools/agent_comms/status.test.mjs`: 298 lines — original Task 7 contract.
- `tests/tools/agent_comms/status-review.test.mjs`: 261 lines — Round 1 race/integrity regressions.
- `tests/tools/agent_comms/status-round2.test.mjs`: 125 lines — schema, audit, archive, and mutex repair regressions.
- `tests/tools/agent_comms/status-round3.test.mjs`: 150 lines — direct-ENOENT, blocking-path, audit-inventory, and no-follow regressions.
- `tests/tools/agent_comms/status-round4.test.mjs`: 94 lines — exhaustive mutex-storage, direct-ENOENT symlink, and corrupt-mutex enforcement regressions.
- `tests/tools/agent_comms/doctor-race.test.mjs`: 82 lines — two-doctor publisher interleavings.
- `tests/tools/agent_comms/repair-mutex.test.mjs`: 110 lines — mutex ownership, boundary, audit, and CAS coverage.
- `tests/tools/agent_comms/claims-integrity.test.mjs`: 42 lines — authoritative mutation rejection.
- `tests/tools/agent_comms/schema.test.mjs`: 299 lines — strict contract coverage.

All runtime modules and tests are strictly below 300 lines. Stale agents/claims, live or young locks, unknown protocol versions, replacement owners, conflicting archive destinations, and mutable corrupt records are never silently deleted.
