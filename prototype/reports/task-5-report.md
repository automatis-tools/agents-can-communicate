# Task 5 report — ownership claims and recoverable claim locking

Status: COMPLETE

Commit: `b5ce4cc feat: add agent ownership claims`

## Scope

- Added `tools/agents/lib/claims.mjs`.
- Added `tests/tools/agent_comms/claims.test.mjs`.
- No existing production or test files were changed.

## Implemented contracts

- `normalizeScope()` and segment-aware `scopesOverlap()` for paths plus exact named contracts.
- `claimScope()` with same-agent renewal, cross-agent overlap conflict, 30-minute default lease, and no automatic stale takeover.
- `releaseScope()` for exact owner-only release.
- `releaseOwnedClaims()` as the owner-scoped callback used by identity close.
- `extendClaims()` as the watcher heartbeat callback.
- `forceReleaseStaleScope()` restricted to an open registry whose role is exactly `orchestrator`; active claims are refused and stale removals receive an immutable audit first.
- `repairStaleClaimLock()` restricted to locks older than 60 seconds whose recorded PID is dead; immutable audit is written before removal.
- Global claim operations use atomic `mkdir(.agents/locks/claims.lock)`, then a strict fsynced `owner.json`, and always clean up the acquired lock in `finally`.

## TDD and gate evidence

Initial RED:

```text
node --test tests/tools/agent_comms/claims.test.mjs
ERR_MODULE_NOT_FOUND: tools/agents/lib/claims.mjs
exit 1
```

Real duplicate-claim mutation RED (foreign-owner predicate intentionally inverted, then restored):

```text
node --test --test-name-pattern='overlapping claim by another agent' tests/tools/agent_comms/claims.test.mjs
AssertionError: Missing expected rejection.
exit 1
```

The retained test has `visual` holding `game/presentation`; `models` requesting
`game/presentation/camera` must reject with `EXIT.CONFLICT === 5`.

Audit-order mutation RED (repair audit intentionally moved after removal, then restored):

```text
node --test --test-name-pattern='failed repair audit' tests/tools/agent_comms/claims.test.mjs
AssertionError: false !== true
exit 1
```

This proves a failed immutable audit must leave the stale lock and `owner.json` intact.

## Fresh verification

```text
node --check tools/agents/lib/claims.mjs
node --check tests/tools/agent_comms/claims.test.mjs
node --test tests/tools/agent_comms/claims.test.mjs
15 tests, 15 pass, 0 fail, exit 0
node --test tests/tools/agent_comms/*.test.mjs
99 tests, 99 pass, 0 fail, exit 0
git diff --cached --check
exit 0
```

Size gate:

```text
297 tools/agents/lib/claims.mjs
293 tests/tools/agent_comms/claims.test.mjs
```

## Self-review

- Claim conflict inspection occurs only after the lock owner record is durably published.
- Stale claims remain conflicts during ordinary claiming.
- Foreign release cannot occur through ordinary release or owner-scoped close cleanup.
- Both forced stale-claim release and stale-lock repair fail closed when immutable audit publication fails.
- No dependency, schema, path, identity, or presence contract changes were required.

## Fix Round 1 — repair CAS, scope canonicalization, acquisition cleanup

Status: COMPLETE

Commit: `513c1d5 fix: make claim lock repair race-safe`

### Focused RED

```text
node --test --test-name-pattern='trailing slash|published owner cleanup|delayed second repair' tests/tools/agent_comms/claims.test.mjs
3 tests: 0 pass, 2 fail, 1 cancelled, exit 1
- trailing slash: expected one claim, observed two (`2 !== 1`)
- published owner cleanup: missing expected injected rejection
- deterministic repair barrier: timed out because repair did not rename the lock directory
```

### Changes

- Path scopes ending in `/` now canonicalize to the same scope without the trailing slash; renewal retains one record and one file.
- Claim-lock acquisition accepts a narrow injected owner writer for regression testing. If publication throws after creating `owner.json`, cleanup removes the published owner and directory while rethrowing the original error.
- Stale-lock repair validates its audit and writes it before active-lock mutation.
- Repair derives a deterministic SHA-256 quarantine-directory name from the canonical validated owner tuple and atomically renames the entire `claims.lock` directory. The stale `owner.json` remains inside that quarantine directory.
- Rename contention (`EEXIST`, `ENOTEMPTY`, or `ENOENT`) triggers a strict active-owner re-read and returns `false`; it never unlinks or moves a replacement lock.
- Added a controlled two-repairer barrier: both inspect owner A, one quarantines A, a live owner B acquires the active path, and the delayed repair cannot move B because A's deterministic nonempty destination already exists.

### Fresh GREEN evidence

```text
node --check tools/agents/lib/claims.mjs
node --check tests/tools/agent_comms/claims.test.mjs
exit 0

node --test tests/tools/agent_comms/claims.test.mjs
17 tests, 17 pass, 0 fail, exit 0

node --test tests/tools/agent_comms/*.test.mjs
101 tests, 101 pass, 0 fail, exit 0

git diff --cached --check
exit 0

wc -l tools/agents/lib/claims.mjs tests/tools/agent_comms/claims.test.mjs
298 tools/agents/lib/claims.mjs
299 tests/tools/agent_comms/claims.test.mjs
```

### Review conclusions

- Age remains strict `> 60_000 ms` and recorded PID must be dead before repair.
- Audit failure leaves the active lock untouched.
- The deterministic race test preserves live replacement owner `models` at `.agents/locks/claims.lock/owner.json` and stale owner `visual` under `.agents/quarantine/claims-lock-stale-<sha256>/owner.json`.
- Ordinary stale claims remain unavailable; watcher extension and identity-close callbacks are unchanged.
