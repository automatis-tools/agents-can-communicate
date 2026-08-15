# Task 4 report — presence heartbeat, watcher, and dormant wait

## Status

Implemented Task 4 presence state derivation, long-lived watcher lifecycle, and one-shot dormant waiting. The implementation consumes the reviewed Task 2/3 identity and messaging contracts and keeps claim renewal behind the injected `extendOwnedClaims(agentId)` callback; it does not add claim logic or CLI signal handling.

## RED evidence

Command:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `1`. Node reported `ERR_MODULE_NOT_FOUND` for `tools/agents/lib/presence.mjs`; the Task 4 production module did not exist. This was captured after the complete 234-line deterministic presence/watcher test file was added and before production code was written.

## GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `0`; 9 passed, 0 failed.

Full protocol regression:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 75 passed, 0 failed.

Static and structural checks:

```text
node --check tools/agents/lib/presence.mjs
node --check tests/tools/agent_comms/presence.test.mjs
git diff --check
wc -l tools/agents/lib/presence.mjs tests/tools/agent_comms/presence.test.mjs
```

Result: all commands exit `0` with no diagnostics. The implementation is 265 lines and its matching test file is 234 lines, both below the 300-line limit.

## Files

- `tools/agents/lib/presence.mjs`
- `tests/tools/agent_comms/presence.test.mjs`

## Requirement evidence

- `presenceState()` reports live heartbeats through 45 seconds as online, older live-PID heartbeats as stale, and explicit offline/dead-PID records as offline.
- `startWatcher()` requires an open registration, rejects an existing live watcher, writes validated online presence with the watcher PID, and writes offline presence during both normal stop and startup failure cleanup.
- The watcher performs its initial inbox scan before returning, listens with `fs.watch`, and independently scans on the default 2-second fallback interval.
- Each unseen id is output as the exact `{ event: "message", message, state: "unseen" }` object once per process. A seen receipt is published only after the async output callback succeeds; no acknowledgement is created.
- Restart coverage proves unseen work is output while seen-but-unacknowledged messages remain visible through `listInbox()`.
- Presence is refreshed on the default 15-second interval. Initial acquisition and each heartbeat call the injected `extendOwnedClaims(agentId)` boundary.
- `stop()` is idempotent through one terminal promise, closes the filesystem watcher and timers, waits for queued scans/heartbeats, writes offline, and resolves `done`.
- `waitForMessage()` uses an immediate scan, filesystem notifications, and a 2-second fallback; deterministic tests prove unseen delivery versus `null` timeout without real sleeps.

## Self-review

- Checked output ordering: the watcher awaits the output callback, records the id in its process-local set, then calls the existing strict `markSeen()` implementation.
- Checked concurrency: filesystem and fallback scans share one serialized promise chain, so coalesced or overlapping events cannot print the same message concurrently.
- Checked shutdown ordering: event sources close first, in-flight scan and heartbeat chains settle, and only then is offline presence published.
- Checked error cleanup: a failed initial output leaves no seen receipt and restores offline presence; later async failures stop the watcher and reject `done`.
- Checked scope: no schema, claim, CLI, signal, registry, message, or shared helper implementation was changed.
- Checked mutation coverage conceptually: wrong stale threshold, missing PID check, missing immediate/fallback scan, premature seen write, missing heartbeat/claim extension, duplicate output, missing offline write, and timeout/delivery confusion each change an asserted behavior.

## Concerns

None blocking. Task 5 must provide real claim extension behind the injected callback, and Task 8 must wire runtime stdout/bell handling plus awaited signal-driven `stop()` as planned.

Commit: `2ea32e4` (`feat: add agent presence watcher`).

## Fix Round 1

### Findings addressed

1. Watcher acquisition now publishes an immutable per-agent ownership record with a unique token while holding an atomic `mkdir` guard in `.agents/locks`. Concurrent starts serialize at that guard; any live ownership/presence PID blocks takeover. Dead-owner recovery, heartbeat publication, and stop/offline publication all re-read ownership under the same guard. A former owner whose token no longer matches cannot overwrite or remove its successor.
2. `waitForMessage()` establishes filesystem watching first, completes the initial real inbox scan (plus any filesystem scan queued during it), and only then arms timeout/fallback scheduling if no unseen message was found. A zero timeout cannot beat a pre-existing unseen message, and a message arriving while the first scan is deliberately held is recovered by the queued filesystem scan.
3. The heartbeat interval is armed immediately after successful ownership acquisition, before claim extension and initial delivery scanning/output. A deterministic blocked-output test advances 46 seconds, observes heartbeats at 15/30/45 seconds, and proves the live ownership still rejects a contender.

The reviewed Task 3 `markSeen()` idempotence commit `f8d672d` was preserved unchanged and is exercised by the complete regression suite.

### RED evidence

Primary focused command:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result before production changes: exit `1`; 7 passed, 4 failed.

- Concurrent starts both fulfilled (`2 !== 1`).
- The old watcher's `stop()` replaced successor presence (`4242 !== 4343`).
- Blocked initial output left the heartbeat at `18:00:00` instead of `18:00:45`.
- Eager zero-timeout returned `null` for a pre-existing unseen message.

The slow-output test initially used a bounded event-loop poll to detect entry into the output callback; that harness failed before the intended assertion. It was replaced with a deterministic deferred callback signal, after which the retained RED was the expected stale heartbeat assertion above.

Additional event-during-initial-scan command:

```text
node --test --test-name-pattern="wait prioritizes" tests/tools/agent_comms/presence.test.mjs
```

Result before wiring the controlled real-inbox boundary: exit `1`; the initial scan did not enter the held real `listInbox()` wrapper (`true !== false`). After wiring, the same test proves that the filesystem event queues behind the held initial snapshot and delivers the newly written message.

### GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `0`; 11 passed, 0 failed.

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 80 passed, 0 failed. This includes the upstream idempotent-seen regressions.

Static and structural checks:

```text
node --check tools/agents/lib/presence.mjs
node --check tests/tools/agent_comms/presence.test.mjs
git diff --check
wc -l tools/agents/lib/presence.mjs tests/tools/agent_comms/presence.test.mjs
```

Result: all exit `0` with no diagnostics; both files are 299 lines, below the 300-line limit.

One full-suite run exposed a test-harness bound: 100 `setImmediate` yields were insufficient for real filesystem setup under parallel Node tests. Raising the condition-based yield budget to 1,000 (still no sleeping) made the same focused and full commands pass; no production change was made for that harness failure.

### Fix-round self-review

- Verified every ownership mutation is serialized by the per-agent atomic directory guard, and every presence write after acquisition is conditional on the current immutable token.
- Verified live PID checks ignore heartbeat age for takeover, so recovery cannot silently steal from a live but slow owner; corrupt ownership data also fails closed through strict reading.
- Verified the old-owner test separately exercises safe `stop()` after takeover and rejected heartbeat after a later takeover.
- Verified heartbeat scheduling uses its own promise chain and timer, independent of scan/output serialization.
- Verified wait has no scan/watch gap: the filesystem watcher exists before the first scan, events queue on the same scan chain, and timeout is absent until that chain drains.
- Confirmed the diff does not change messages, claims, schemas, CLI signals, or default 15-second heartbeat / 45-second stale / 2-second fallback values.

### Fix-round concerns

None blocking. The ownership guard intentionally fails closed if a process crashes while holding its very short critical section; no automatic live-owner or ambiguous-lock theft was added. The previously ledgered JSONL/BEL Minor remains out of scope as instructed.

Fix commit: `f925e7f` (`fix: serialize agent watcher ownership`).

## Fix Round 2

### Findings addressed

1. Removed the short-lived `.guard` critical section. Each watcher now publishes one lifetime, immutable per-agent owner record with the exact metadata `{schema_version, agent_id, token, pid, acquired_at}` using the existing exclusive atomic JSON publication.
2. Acquisition strictly reads a conflicting owner. A live owner PID rejects takeover regardless of heartbeat age. A dead owner is atomically renamed into the bus quarantine directory under its unique token and retained as audit evidence before exclusive acquisition is retried. `ENOENT` from a competing recovery retries normally.
3. Heartbeat and stop strictly re-read the owner record and require the lifetime token before changing presence. A former watcher whose record has been replaced therefore cannot heartbeat, publish offline presence, or remove the successor's owner record.
4. Malformed owner records fail closed with `EXIT.DATA`. The round retains the prior watcher-before-scan, zero-timeout initial-scan priority, event-during-scan, and heartbeat-during-blocked-output behavior unchanged.

### RED evidence

Focused command run after adding the ownership regressions and before changing production:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `1`; 11 passed, 3 failed.

- The published owner still used `ownership_id` instead of the required `token` metadata key.
- Simulated short-guard contention caused the incumbent heartbeat/termination path to fail with `CommsError: watcher ownership is busy`, so its 15-second heartbeat was not preserved.
- Dead-owner recovery deleted the former record instead of retaining one stale audit record (`0 !== 1`).

The simultaneous dead-owner recoverer and malformed-owner cases already rejected safely in the previous implementation; they were retained as explicit concurrency and corruption boundary coverage while the three failures above supplied the production RED.

### GREEN evidence

Fresh focused command from the final files:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `0`; 14 passed, 0 failed.

Fresh full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 83 passed, 0 failed.

Static and structural commands:

```text
node --check tools/agents/lib/presence.mjs
node --check tests/tools/agent_comms/presence.test.mjs
git diff --check
wc -l tools/agents/lib/presence.mjs tests/tools/agent_comms/presence.test.mjs
```

All commands exited `0` with no diagnostics. Line counts are 287 for `presence.mjs` and 299 for `presence.test.mjs`, both below the 300-line limit.

### Files

- `tools/agents/lib/presence.mjs`
- `tests/tools/agent_comms/presence.test.mjs`

### Fix-round self-review

- Verified acquisition has no retry count and no heartbeat-age takeover path: only a strictly valid record whose PID is reported dead is recoverable.
- Verified stale records use the former immutable token in a unique quarantine path and are never silently unlinked.
- Verified one of two simultaneous recovery attempts owns the final exclusive record and the other rejects with a live-owner conflict.
- Verified a rejected contender cannot suppress the incumbent's scheduled 15-second heartbeat, and an owner that loses its token cannot stop or heartbeat over two successive owners.
- Verified strict owner validation checks exact keys, canonical token shape, agent id, PID, and acquisition timestamp; malformed data propagates as `EXIT.DATA`.
- Confirmed the round does not change claims, schemas, CLI signals, message behavior, initial scan ordering, or the default 15-second heartbeat / 45-second stale / 2-second fallback values.

### Fix-round concerns

None blocking. The previously ledgered JSONL/BEL Minor remains intentionally out of scope for this round.

Fix commit: `bacc00c` (`fix: use lifetime watcher ownership`).

## Fix Round 3

### Correction implemented

The lifetime immutable owner file remains the sole exclusive watcher lock, but `startWatcher()` no longer repairs, renames, or deletes an existing owner. On exclusive-create conflict it strictly reads the record, verifies that the record's `agent_id` matches the agent encoded by the owner path, and returns `EXIT.CONFLICT` regardless of PID liveness. A missing record after the exclusive conflict still returns conflict, so a start that raced before the incumbent's final owner removal cannot turn into an implicit retry.

Heartbeat and stop retain strict agent/token ownership checks. Heartbeat only writes presence. Normal stop drains scans and heartbeats, writes offline presence, and removes its matching owner as the final mutation; only a later start can publish a successor. Dead/stale owner repair is left to the planned Task 7 doctor workflow, with the original owner bytes preserved for diagnosis.

### RED evidence

Focused command after replacing the recovery expectations and before production changes:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `1`; 13 passed, 2 failed.

- Against a dead owner, the two contender outcomes were `rejected, fulfilled` instead of both `rejected`; the auto-recovery rename/retry path admitted one successor.
- A structurally valid owner whose `agent_id` disagreed with `watcher-models.json` returned `EXIT.CONFLICT` instead of the required `EXIT.DATA`.

The deterministic normal-stop/start ordering test and former-token heartbeat/stop protection were already green against the current lifecycle and remain as regression coverage.

### GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/presence.test.mjs
```

Result: exit `0`; 15 passed, 0 failed.

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Result: exit `0`; 84 passed, 0 failed.

Static and structural commands:

```text
node --check tools/agents/lib/presence.mjs
node --check tests/tools/agent_comms/presence.test.mjs
git diff --check
wc -l tools/agents/lib/presence.mjs tests/tools/agent_comms/presence.test.mjs
```

All commands exited `0` with no diagnostics. Line counts are 279 for `presence.mjs` and 299 for `presence.test.mjs`, both below the 300-line limit.

### Files

- `tools/agents/lib/presence.mjs`
- `tests/tools/agent_comms/presence.test.mjs`

### Fix-round self-review

- Verified acquisition contains no PID-liveness branch, retry loop, stale-path construction, quarantine move, or deletion of a conflicting owner.
- Verified both simultaneous contenders against a simulated dead owner return `EXIT.CONFLICT`, the owner file remains byte-for-byte identical, and the quarantine directory remains empty.
- Verified strict owner reads enforce the owner-path agent identity for acquisition, heartbeat, and stop; malformed and mismatched records fail `EXIT.DATA`.
- Verified the former-token test replaces owner and presence state, advances the old heartbeat, and proves neither successor artifact is changed when old-watcher termination attempts offline cleanup.
- Verified stop retains ownership while a queued output is deliberately blocked, a concurrent start conflicts, and a successor starts only after stop has completed offline publication and final owner removal.
- Confirmed initial scan ordering, 15-second heartbeat, 45-second stale classification, 2-second fallback, claim callback boundary, messages, claims, schemas, and CLI wiring remain unchanged.

### Fix-round concerns

None blocking. Dead owner repair is intentionally deferred to Task 7 doctor, and the previously ledgered JSONL/BEL Minor remains out of scope.

Fix commit: `0429973` (`fix: preserve stale watcher ownership`).
