### Task 5: Ownership claims and recoverable claim locking

**Files:**

- Create: `tools/agents/lib/claims.mjs`
- Create: `tests/tools/agent_comms/claims.test.mjs`

**Interfaces:**

- Produces `normalizeScope(scope) -> { kind: "path" | "contract", value: string }`.
- Produces `scopesOverlap(left, right) -> boolean`.
- Produces `claimScope(context, input)`, `releaseScope(context, input)`, `forceReleaseStaleScope(context, input)`, `extendClaims(context, agentId)`, and `repairStaleClaimLock(context)`.
- Claim-lock record is `{ schema_version: 1, owner_agent, pid, acquired_at }` inside `.agents/locks/claims.lock/owner.json`.

- [ ] **Step 1: Write exact overlap and lock tests**

```js
test("path overlap uses segments rather than string prefixes", () => {
  assert.equal(scopesOverlap("game/presentation", "game/presentation/camera"), true);
  assert.equal(scopesOverlap("game/presentation", "game/presentations"), false);
});

test("named contracts overlap only on exact normalized name", () => {
  assert.equal(scopesOverlap("contract:tank-registration-v1", "contract:tank-registration-v1"), true);
  assert.equal(scopesOverlap("contract:tank-registration-v1", "contract:tank-registration-v2"), false);
});
```

Add tests for same-agent idempotent renewal, different-agent conflict, stale claim remaining unavailable, watcher lease extension, owner-only release, orchestrator-only forced release of a stale foreign claim with immutable audit record, refusal to force-release an active claim, atomic `mkdir` contention, a live lock never repaired, and a dead-PID lock younger than 60 seconds never repaired.

- [ ] **Step 2: Run claim tests and capture the RED**

Run: `node --test tests/tools/agent_comms/claims.test.mjs`

Expected: exit `1` with missing claim exports.

- [ ] **Step 3: Implement normalization, conflict detection, and lock discipline**

```js
export function scopesOverlap(leftInput, rightInput) {
  const left = normalizeScope(leftInput);
  const right = normalizeScope(rightInput);
  if (left.kind !== right.kind) return false;
  if (left.kind === "contract") return left.value === right.value;
  const a = left.value.split("/");
  const b = right.value.split("/");
  return a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]);
}
```

Acquire the global critical section using `mkdir(claims.lock)`. Write and fsync `owner.json` before inspecting claims. Always release the lock directory in `finally`. A stale claim is reported as conflict rather than overwritten. `forceReleaseStaleScope()` requires an open registry record whose role is exactly `orchestrator`, proves the target claim is stale, writes an immutable audit record, and only then removes it. `repairStaleClaimLock()` succeeds only when the lock is older than 60 seconds and `pidIsAlive(pid)` is false; it writes an immutable audit record before removal.

- [ ] **Step 4: Demonstrate duplicate-claim refusal**

Run a test where `visual` holds `game/presentation` and `models` requests `game/presentation/camera`. Record the asserted conflict with exit code `5`; retain the test and run:

`node --test tests/tools/agent_comms/claims.test.mjs`

Expected: all claim tests pass and exit `0`.

- [ ] **Step 5: Commit claims**

```bash
git add tools/agents/lib/claims.mjs tests/tools/agent_comms/claims.test.mjs
git commit -m "feat: add agent ownership claims"
```

---
