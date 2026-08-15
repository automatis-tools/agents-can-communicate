# Prototype migration

## Source

The preserved prototype came from:

```text
repository: /Users/mmykola87/work/papercut-warzone-2
branch:     ops/agent-comms-protocol
base:       bd54f8a11fe414cfa25c851a52fe65afe5233262
head:       9a866cf16f97a0aa1af7ea792acc79bc02278633
```

The source implementation added 51 paths containing a dependency-free Node.js CLI, local filesystem bus, tests, project prompt, and operator documentation.

## Preserved material

- `prototype/papercut-agent-comms/tools/agents/`: baseline runtime.
- `prototype/papercut-agent-comms/tests/tools/agent_comms/`: baseline regression suite.
- `prototype/papercut-agent-comms/docs/`: original design, plan, prompt, and guide.
- `prototype/reports/`: original task briefs, reports, and progress ledger.
- `migration/patches/`: four later staged hardening sets.

## Reusable behavior

- strict schema validation and explicit exit codes;
- checkout-scoped identity;
- open/close lifecycle;
- heartbeat, watch, and wait;
- send, reply, seen, acknowledge, archive, and broadcast;
- attachments and evidence-bound handoffs;
- generic path claims with stale handling;
- status and doctor;
- corruption and race-condition tests;
- JSON and human CLI modes.

## Papercut coupling to remove

- `PW2_AGENT_BUS_DIR` environment naming;
- mandatory `AGENTS.md`/Papercut documentation assumptions;
- Git common-directory identity as a core requirement;
- project task and scope vocabulary;
- repository-local runtime state;
- Papercut command examples and prompt wording;
- Git-shaped handoff requirements for all projects;
- CLI path `tools/agents/comms.mjs` as the public package layout.

## Hardening sets

### 0001 — prompt and docs

Adds missing canonical prompt requirements, shell-safe prompt rendering, and focused liveness tests.

### 0002 — lifecycle and CLI

Adds strict protocol gating for normal commands, foreign-workspace protection, open-identity lifecycle serialization, live-only broadcast, JSON error purity, signal behavior, and ephemeral handoff support.

### 0003 — storage and messages

Adds no-follow and managed-root validation, safer IDs, filename/record binding, no-replace archives, path containment, symlinked-layout rejection, and process-level concurrency tests.

### 0004 — doctor and recovery

Adds recovery-audit inventory, claim and mutex crash replay, root-aware doctor validation, and repair blocking on ambiguous artifacts.

## Integration hazards

The patches share a common base but overlap. They are not a linear patch series.

Known intersections:

- lifecycle and storage both modify `comms.mjs`, `identity.mjs`, and `watcher-ownership.mjs`;
- storage and doctor both modify `claims.mjs`, `repair-mutex.mjs`, and `status.mjs`;
- storage changes read helpers to require explicit managed-root arguments;
- doctor's new audit scanners were written against pre-storage read signatures;
- lifecycle semantics must be ported onto storage's root-aware APIs, not resolved by choosing one side;
- doctor scanners must pass `context.paths.root` through every read/list helper after storage integration.

## Required combined regressions

Before extraction is accepted, test at least:

1. foreign-workspace protocol blocks every non-init command before mutation;
2. malformed or unknown foreign protocol also blocks `doctor --repair`;
3. `init` validates an existing protocol identity before creating or changing layout;
4. lifecycle register/close/start shares one ownership critical section;
5. broadcast recipients are live, not merely registered open;
6. managed-root reads reject symlinked parent directories;
7. inbox and archive filenames bind to message IDs;
8. acknowledgements cannot overwrite immutable archives;
9. two doctors plus a concurrent publisher cannot delete the publisher's new generation;
10. audit-published/pre-mutation claim and mutex operations replay safely;
11. all recovery artifacts are continuously inventoried;
12. unknown protocol/schema versions fail closed before any repair.

## Recommended integration order

1. Copy the exact baseline into an isolated integration branch.
2. Apply storage/messages behavior first because it changes low-level read/write signatures.
3. Port lifecycle/CLI semantics manually onto the root-aware storage APIs.
4. Port doctor/recovery semantics and update every helper call to the new signatures.
5. Apply prompt/docs behavior.
6. Run focused tests for each original patch set.
7. Add and run the combined regressions above.
8. Run the complete protocol suite and prove critical gates fail under deliberate mutation.
9. Only then begin project-agnostic extraction.

## Residual hardening note

A deliberately adversarial same-user process can transiently swap and restore an ancestor directory between pathname checks. The prior review classified this as residual hardening rather than a release-blocking defect because a portable dependency-free Node fix is not small. Preserve the documented limitation unless the storage backend changes.
