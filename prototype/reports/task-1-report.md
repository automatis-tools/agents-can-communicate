# Task 1 report — Durable bus foundation and strict schemas

## Status

Implementation, local verification, self-review, and the required commit are complete.

## Implementation details

- Added stable protocol exit codes and `CommsError` with structured details.
- Added bus discovery that honors `PW2_AGENT_BUS_DIR` before Git lookup, rejects ambiguous non-`.git` common directories, and maps main plus linked worktrees to one checkout-local `.agents` bus.
- Added a frozen bus-path contract and idempotent creation of every v1 runtime directory without deleting existing records.
- Added strict JSON reads, deterministic JSON listings, same-filesystem atomic moves, durable temp-file writes with `wx` + file sync, rename publication for mutable records, hard-link no-replace publication for immutable records, and destination-directory sync.
- Added strict validators for agent ids, hashes, repository paths, scopes, attachments, protocol, registry, presence, messages, seen receipts, acknowledgements, claims, handoffs, and locks. Protocol-owned records reject unknown keys, and every validator returns its original value or throws `CommsError` with exit code 4.
- Added reusable isolated test fixtures for buses, real linked Git worktrees, fake clocks, CLI subprocesses, existence checks, and later protocol record seeding.

## Files changed

- `tools/agents/lib/errors.mjs`
- `tools/agents/lib/paths.mjs`
- `tools/agents/lib/atomic-json.mjs`
- `tools/agents/lib/schema.mjs`
- `tests/tools/agent_comms/helpers.mjs`
- `tests/tools/agent_comms/errors.test.mjs`
- `tests/tools/agent_comms/paths.test.mjs`
- `tests/tools/agent_comms/atomic-json.test.mjs`
- `tests/tools/agent_comms/schema.test.mjs`

No approved specification, implementation-plan, main-checkout, workflow, dependency, or unrelated file was changed.

## RED evidence

### Error contract pre-cycle

Command:

```text
node --test tests/tools/agent_comms/errors.test.mjs
```

Observed exit: `1`

Key output:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../tools/agents/lib/errors.mjs'
✖ tests/tools/agent_comms/errors.test.mjs
ℹ pass 0
ℹ fail 1
```

Why expected: the behavior-first error tests existed before the error module.

### Required discovery RED

Command:

```text
node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs
```

Observed exit: `1`

Key output:

```text
✔ exit codes are stable
✔ protocol errors retain structured details
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../tools/agents/lib/paths.mjs'
✖ tests/tools/agent_comms/paths.test.mjs
ℹ pass 2
ℹ fail 1
```

Why expected: `errors.mjs` had completed its own RED/GREEN cycle, while `paths.mjs` did not exist. The failure therefore proved the discovery tests were loading the intended missing production boundary.

### Required storage/schema RED

Command:

```text
node --test tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs
```

Observed exit: `1`

Key output:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../tools/agents/lib/atomic-json.mjs'
✖ tests/tools/agent_comms/atomic-json.test.mjs
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../tools/agents/lib/schema.mjs'
✖ tests/tools/agent_comms/schema.test.mjs
ℹ pass 0
ℹ fail 2
```

Why expected: both test files were written before their runtime modules, so the missing exports failed loudly at the real module boundary.

### Test-helper regression RED

Command:

```text
node --test --test-name-pattern='main and linked' tests/tools/agent_comms/paths.test.mjs
```

Observed exit: `1`

Key output:

```text
TypeError [Error]: resolveBusDir is not a function
at Object.resolveFrom (.../helpers.mjs:36:48)
ℹ pass 0
ℹ fail 1
```

Why expected: the test was changed to exercise the brief's exact `fixture.resolveFrom(cwd)` helper interface, exposing that the first helper draft incorrectly required the resolver as a second argument. Binding the real resolver inside the fixture restored the documented API.

## GREEN evidence

### Discovery GREEN

```text
$ node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

### Storage/schema GREEN including corrupt-data gate

The malformed JSON exists only under the temporary test fixture. The permanent assertion requires `readJsonStrict()` to reject it with exit code 4 and the offending file path.

```text
$ node --test tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs
✔ malformed JSON fails the corrupt-data gate
ℹ tests 16
ℹ pass 16
ℹ fail 0
```

### Required final foundation command

```text
$ node --test tests/tools/agent_comms/paths.test.mjs tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs
ℹ tests 21
ℹ pass 21
ℹ fail 0
```

### Complete Task 1 suite

```text
$ node --test tests/tools/agent_comms/*.test.mjs
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

### Syntax and structure

```text
$ for file in tools/agents/lib/*.mjs tests/tools/agent_comms/*.mjs; do node --check "$file" || exit 1; done
[exit 0, no output]

$ wc -l tools/agents/lib/*.mjs
128 tools/agents/lib/atomic-json.mjs
 17 tools/agents/lib/errors.mjs
 71 tools/agents/lib/paths.mjs
295 tools/agents/lib/schema.mjs
```

All runtime modules are below the required 300-line limit. Runtime imports use only the Node standard library and local modules.

## Self-review

- Re-read Task 1 and the approved design/plan without modifying them.
- Confirmed the exact stable exit-code map and agent-id regex.
- Confirmed main and linked worktree discovery uses the real Git common directory and canonical fixture paths.
- Confirmed exclusive publication uses `link`, not a check-then-rename race, and preserves the first immutable record under conflict.
- Confirmed temp files are fully written, file-synced, closed, published on the same caller-selected filesystem, removed after publication/conflict, and followed by destination-directory sync.
- Confirmed readers and listings never inspect temporary files.
- Confirmed every protocol-owned record rejects unknown keys and validators preserve object identity.
- Confirmed required coverage for all message/severity enums, malformed JSON, invalid ids, missing fields, wrong scalar/array types, absolute/escaping/non-normalized attachment paths, invalid SHA-256, and unknown versions.
- Confirmed only the nine Task 1 implementation/test files are intended for commit.

## Concerns

None at handoff.

## Commit

`458b83c feat: add durable agent bus foundation`

## Fix Round 1

### Review findings addressed

1. `validateRepoPath()` now rejects the exact `..` path in addition to paths beginning with `../`, closing the remaining repository-root escape.
2. `validateHandoff()` now requires at least one verification record. Readiness and state must agree for committed and uncommitted handoffs, and any non-zero verification exit code prevents `ready_to_merge: true`.

### Covering test file

- `tests/tools/agent_comms/schema.test.mjs`
  - `repository paths reject the exact parent-directory escape`
  - `handoffs require at least one verification record`
  - `handoff readiness matches its state and verification results`

### RED command and exact output

```text
$ node --test --test-name-pattern='repository paths|handoffs require|committed handoff' tests/tools/agent_comms/schema.test.mjs
✖ repository paths reject the exact parent-directory escape (0.724667ms)
✖ handoffs require at least one verification record (1.07ms)
✖ committed handoff readiness matches its state and verification results (0.1415ms)
ℹ tests 3
ℹ suites 0
ℹ pass 0
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 35.168625

✖ failing tests:

test at tests/tools/agent_comms/schema.test.mjs:168:1
✖ repository paths reject the exact parent-directory escape (0.724667ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.

test at tests/tools/agent_comms/schema.test.mjs:224:1
✖ handoffs require at least one verification record (1.07ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.

test at tests/tools/agent_comms/schema.test.mjs:228:1
✖ committed handoff readiness matches its state and verification results (0.1415ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception.
```

Observed exit: `1`. Each failure was expected because the validator returned normally for the reviewed invalid input rather than throwing exit code 4.

### Focused GREEN command and exact output

```text
$ node --test tests/tools/agent_comms/schema.test.mjs
✔ agent ids enforce the version-one lexical contract (0.526834ms)
✔ every message type and severity enum is accepted (0.976792ms)
✔ unknown message versions fail loudly (0.06075ms)
✔ messages reject absent required fields and wrong scalar or array types (0.179041ms)
✔ protocol-owned records reject unknown keys (0.070042ms)
✔ attachments accept only normalized allowed relative paths (0.191958ms)
✔ repository paths reject the exact parent-directory escape (0.040792ms)
✔ attachments reject invalid checksums, sizes, and commit combinations (0.109834ms)
✔ identity and lifecycle records validate without cloning (0.242416ms)
✔ handoffs require at least one verification record (0.159625ms)
✔ handoff readiness matches its state and verification results (0.591667ms)
✔ receipt, claim, handoff, and lock records are strict (0.16025ms)
ℹ tests 12
ℹ suites 0
ℹ pass 12
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 49.43225
```

Observed exit: `0`.

### Full Task 1 GREEN command and exact output

```text
$ node --test tests/tools/agent_comms/*.test.mjs
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 247.176333
```

Observed exit: `0`. The full output listed all 26 named tests as passing, including the three Fix Round 1 cases.

### Syntax, diff, and size command and exact output

```text
$ node --check tools/agents/lib/schema.mjs && node --check tests/tools/agent_comms/schema.test.mjs && git diff --check && wc -l tools/agents/lib/schema.mjs
     299 tools/agents/lib/schema.mjs
```

Observed exit: `0`; the syntax and diff checks emitted no diagnostics. The runtime module remains below 300 lines.

### Changed files

- `tools/agents/lib/schema.mjs`
- `tests/tools/agent_comms/schema.test.mjs`

### Self-review

- Confirmed `.` and exact `..` are rejected, as are existing absolute, `../`, non-normalized, and backslash paths.
- Confirmed an empty verification array is rejected only after its type/items are validated.
- Confirmed committed handoffs map `ready_to_merge: true` to `READY` and `false` to `NOT_READY`.
- Confirmed a failed verification is allowed only on a not-ready committed handoff, preserving evidence without allowing a false merge-ready claim.
- Confirmed uncommitted handoffs remain `UNCOMMITTED` and never merge-ready; both contradictory uncommitted states are covered negatively.
- Confirmed a passing committed handoff may remain `NOT_READY`, allowing limitations beyond test results to block readiness.
- Confirmed no file outside the schema implementation, its test, and this ignored report changed.

### Fix commit

`d1cd54a fix: tighten agent bus schemas`
