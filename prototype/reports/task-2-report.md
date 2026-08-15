# Task 2 report — Bus initialization and agent identity lifecycle

## Implementation

- Added `tools/agents/lib/identity.mjs` with durable bus initialization, registration, resume checks, stale/live presence checks, and close transitions.
- `initBus()` hashes the canonical Git common-directory path, preserves a compatible existing protocol record, and rejects an unknown protocol version without replacing it.
- `registerAgent()` captures injected Git branch/HEAD data and rejects a duplicate identity only while its online watcher has both a live PID and a heartbeat no older than 45 seconds.
- `closeAgent()` refuses a live watcher, preserves registry history as closed, writes offline presence, and delegates only that agent id to the injected claim releaser.

## Files

- `tools/agents/lib/identity.mjs`
- `tests/tools/agent_comms/identity.test.mjs`

## RED evidence

Command:

```text
node --test tests/tools/agent_comms/identity.test.mjs
```

Output before implementation:

```text
exit 1
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../tools/agents/lib/identity.mjs'
```

Duplicate-live-identity failure demonstration after implementation:

```text
exit 1
CommsError: agent id already has a live watcher
exitCode: 5
```

## GREEN evidence

Focused command:

```text
node --test tests/tools/agent_comms/identity.test.mjs
```

Output:

```text
8 tests passed, 0 failed; exit 0
```

Regression command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Output:

```text
34 tests passed, 0 failed; exit 0
```

Also passed `git diff --check`.

## Self-review

- Protocol records are schema-validated before publication and are never replaced when an incompatible version is present.
- The checkout identity uses `realpath(<checkout-root>/.git)` before SHA-256, avoiding display-path aliases.
- The lifecycle module is 165 lines, uses only Node standard-library APIs, and keeps storage/schema concerns in the Task 1 modules.
- Tests assert externally visible records and state transitions, including a real conflicting second registration, instead of mocked call behavior.

## Concerns

None. The injected `releaseOwnedClaims(agentId)` remains the intentional Task 5 integration boundary.

## Integration Fix Round 1

### RED

Command:

```text
node --test tests/tools/agent_comms/identity.test.mjs
```

Exact output before the export was added:

```text
exit 1
SyntaxError: The requested module '../../../tools/agents/lib/identity.mjs' does not provide an export named 'requireOpenAgent'
```

### GREEN

Focused command:

```text
node --test tests/tools/agent_comms/identity.test.mjs
```

Exact summary:

```text
tests 10
pass 10
fail 0
duration_ms 369.214375
exit 0
```

Full protocol regression:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Exact summary:

```text
tests 36
pass 36
fail 0
duration_ms 412.890042
exit 0
```

`requireOpenAgent(context, agentId)` strictly validates and reads the registry, returns only records with `status: "open"`, and returns conflict exit code 5 for missing or closed registrations. It intentionally does not inspect presence, so stale/offline registered recipients remain directly addressable.

## Integration Fix Round 2

Added `requireOpenAgent accepts stale and offline open registrations`. Its table-driven cases keep the registry open while (1) an online watcher heartbeat is 45,001 ms old and PID remains alive, and (2) presence is explicitly offline. Both must return the actual open registry record.

No synthetic RED was run: this is a missing positive regression for behavior the current implementation already deliberately provides. The Integration Fix Round 1 missing-export RED remains the demonstrated liveness check for this public API boundary.

Focused command:

```text
node --test tests/tools/agent_comms/identity.test.mjs
```

Exact output summary:

```text
tests 11
pass 11
fail 0
duration_ms 400.074541
exit 0
```

Full protocol command:

```text
node --test tests/tools/agent_comms/*.test.mjs
```

Exact output summary:

```text
tests 37
pass 37
fail 0
duration_ms 441.661833
exit 0
```
