# ACC Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the certified prototype into a project-agnostic, package-shaped core that supports Workspace, Session, Intent, Workstream, Task, Claim, Message, Decision, Artifact, Handoff, sync, status, and doctor without vendor or Git requirements.

**Architecture:** Preserve behavior through ports rather than rewriting the entire prototype at once. Protocol schemas remain dependency-free ESM, core services depend on injected clock/ID/storage/project ports, and the first storage adapter wraps the reconciled filesystem implementation. CLI composes packages and exposes stable JSON envelopes.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, npm workspaces, dependency-free runtime during extraction.

**Spec:** `docs/superpowers/specs/2026-08-15-standalone-acc-design.md` §§6–10 plus `docs/ARCHITECTURE.md` and `docs/PROTOCOL.md` (canonical interfaces and vocabulary).

## Global Constraints

- Precondition: `prototype/integrated/COMBINED_VERIFICATION.md` is green and committed.
- Use `.mjs` and JSDoc during extraction; do not combine a TypeScript migration with semantic changes.
- Core cannot import Git commands, vendor names, hook formats, or Papercut paths.
- Runtime state is outside the project directory.
- Git enriches discovery but is not required.
- Keep each production module and focused test file below 300 lines.
- Every state transition and validation gate needs RED then GREEN evidence.

---

### Task 1: Establish package boundaries and test harness

**Files:**
- Modify: `package.json`
- Create: `packages/protocol/package.json`
- Create: `packages/core/package.json`
- Create: `packages/storage-filesystem/package.json`
- Create: `packages/cli/package.json`
- Create: `tests/helpers/temp-workspace.mjs`
- Create: `tests/package-boundaries.test.mjs`

**Interfaces:**
- Produces npm workspaces `@agents-can-communicate/protocol`, `core`, `storage-filesystem`, and `cli`

- [ ] **Step 1: Write package-boundary RED**

Create `tests/package-boundaries.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

test("core does not import adapters, git, or project-specific modules", async () => {
  const violations = await scanImports("packages/core");
  assert.deepEqual(violations, []);
});
```

Implement `scanImports` in the test to parse static import lines and reject adapter paths, `child_process`, `PW2_`, and `papercut` tokens.

- [ ] **Step 2: Run RED**

```bash
node --test tests/package-boundaries.test.mjs
```

Expected: failure because package directories or scanner targets do not exist.

- [ ] **Step 3: Add workspace manifests**

Root `package.json` gains:

```json
"workspaces": ["packages/*"],
"scripts": {
  "test": "node --test tests packages",
  "check": "find packages -name '*.mjs' -print0 | xargs -0 -n1 node --check"
}
```

Node's test runner searches directory arguments recursively for `*.test.mjs`, so the script stays correct while packages and test folders are still being created; shell globs would pass unmatched patterns through and fail. It never descends into `prototype/` because only `tests` and `packages` are listed.

Each package manifest sets `private: true`, `type: module`, and explicit `exports`. Do not add runtime dependencies.

- [ ] **Step 4: Add temp Workspace helper**

```js
export async function withTempWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), "acc-workspace-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
```

- [ ] **Step 5: Run GREEN and commit**

```bash
npm test -- --test-name-pattern="core does not import"
git add package.json packages tests
git commit -m "build: establish standalone package boundaries"
```

---

### Task 2: Extract protocol identifiers, errors, and envelopes

**Files:**
- Create: `packages/protocol/src/errors.mjs`
- Create: `packages/protocol/src/ids.mjs`
- Create: `packages/protocol/src/envelopes.mjs`
- Create: `packages/protocol/src/index.mjs`
- Create: `packages/protocol/test/errors.test.mjs`
- Create: `packages/protocol/test/ids.test.mjs`
- Create: `packages/protocol/test/envelopes.test.mjs`

**Interfaces:**
- Produces:

```js
export class AccError extends Error { constructor(code, message, details = {}) }
export const EXIT = Object.freeze({ OK: 0, USAGE: 2, DATA: 4, CONFLICT: 5, ATTENTION: 6 });
export function createId(kind, randomBytes): string;
export function assertPortableId(value, label): string;
export function ok(data, meta = {}): object;
export function failure(error): object;
```

- [ ] **Step 1: Port and generalize failing tests**

Port ID and error tests from the integrated prototype. Replace Papercut names and assert rejection of separators, control characters, empty values, and non-canonical IDs.

- [ ] **Step 2: Run RED**

```bash
node --test packages/protocol/test/{errors,ids,envelopes}.test.mjs
```

Expected: module-not-found failures.

- [ ] **Step 3: Implement minimal protocol modules**

Use lowercase kind prefixes and URL-safe random payloads:

```js
export function createId(kind, randomBytes = defaultRandomBytes) {
  assertPortableId(kind, "kind");
  return `${kind}_${randomBytes(16).toString("base64url")}`;
}
```

JSON failure envelopes include `ok: false`, stable `code`, human `message`, and structured `details` without stack traces.

The reconciled prototype also defines `TIMEOUT: 3` and uses `REQUIRED: 6` where this table says `ATTENTION: 6`. Keep numeric slot 3 reserved for timeout semantics rather than reassigning it, and map `REQUIRED` to `ATTENTION` when porting tests, so ported process tests keep their exit-code meaning.

- [ ] **Step 4: Mutation proof**

Temporarily permit `/` in `assertPortableId`. Run `ids.test.mjs`; expected failure names path-safety behavior. Restore and rerun green.

- [ ] **Step 5: Verify and commit**

```bash
node --test packages/protocol/test/*.test.mjs
git add packages/protocol
git commit -m "feat: define standalone protocol envelopes"
```

---

### Task 3: Define schemas and state machines

**Files:**
- Create: `packages/protocol/src/schema.mjs`
- Create: `packages/protocol/src/states.mjs`
- Create: `packages/protocol/test/schema.test.mjs`
- Create: `packages/protocol/test/states.test.mjs`

**Interfaces:**
- Produces validators for Workspace, Participant, Session, Intent, Workstream, Task, Claim, Message, Receipt, Decision, Artifact, Handoff, and Event
- Produces:

```js
transitionTask(current, next): string
advanceDelivery(current, next): string
validateRecord(kind, value): object
```

The schema module also exports these JSDoc shapes for later tasks:

```js
/** @typedef {{ sequence: string, eventId: string, workspaceId: string,
 * actorSessionId: string, type: string, occurredAt: string, payload: object }} AccEvent */
/** @typedef {{ cursor: string, events: AccEvent[] }} EventPage */
/** @typedef {{ kind: string, priority: number, sourceId: string, summary: string }} AttentionItem */
/** @typedef {{ workspace: object, participants: object[], sessions: object[],
 * intents: object[], workstreams: object[], tasks: object[], claims: object[] }} WorkspaceSnapshot */
```

- [ ] **Step 1: Write table-driven RED tests**

Include valid minimal fixtures and one invalid fixture per required field. Test task transition rules and monotonic delivery:

```js
assert.equal(advanceDelivery("queued", "seen"), "seen");
assert.throws(() => advanceDelivery("acknowledged", "injected"), AccError);
```

- [ ] **Step 2: Run RED**

```bash
node --test packages/protocol/test/{schema,states}.test.mjs
```

- [ ] **Step 3: Implement strict validators**

Reject unknown schema versions and unknown required enum values. Preserve optional forward-compatible metadata only under a named `extensions` object. Keep record and field names mappable to the A2A Agent Card, Task, Message, and Artifact concepts (spec §11) without importing any A2A transport.

- [ ] **Step 4: Mutation proof**

Neutralize the delivery-order comparison. The backwards-delivery test must fail. Restore and run green.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat: define coordination state schemas"
```

---

### Task 4: Introduce storage and transaction ports

**Files:**
- Create: `packages/core/src/ports.mjs`
- Create: `packages/core/src/service.mjs`
- Create: `packages/core/test/service-contract.test.mjs`
- Create: `tests/helpers/memory-store.mjs`

**Interfaces:**
- Produces:

```js
createCoordinationService({ store, clock, ids, policies }): CoordinationService
store.transaction(callback): Promise<unknown>
tx.append(event): void
tx.get(kind, id): object | null
tx.put(kind, id, record, expectedGeneration): void
tx.list(kind, predicate): object[]
store.eventsSince(workspaceId, cursor, limit): Promise<EventPage>
store.snapshot(workspaceId): Promise<WorkspaceSnapshot>
```

`CoordinationTransaction` is the object exposing `append`, `get`, `put`, and `list` above. `CoordinationService` is an object whose methods are added in Tasks 7–9; the factory freezes injected ports and exposes no global singleton.

- [ ] **Step 1: Write RED for atomic event/state behavior**

The memory store test performs a transaction that writes state then throws. Assert neither record nor event is visible afterward.

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/service-contract.test.mjs
```

- [ ] **Step 3: Implement the memory contract and service factory**

Use copied maps inside a transaction and swap only after callback success. Implement `snapshot` from the materialized maps. Production core accepts no global clock or random source.

- [ ] **Step 4: Add optimistic generation conflict test**

Two transactions start from generation A. The first publishes B; the second write expecting A fails with `EXIT.CONFLICT` and emits no event.

- [ ] **Step 5: Verify and commit**

```bash
node --test packages/core/test/service-contract.test.mjs
git add packages/core tests/helpers
git commit -m "feat: add coordination storage port"
```

---

### Task 5: Extract the filesystem storage adapter and recovery

**Files:**
- Create: `packages/storage-filesystem/src/store.mjs`
- Create: `packages/storage-filesystem/src/atomic-json.mjs`
- Create: `packages/storage-filesystem/src/safe-file.mjs`
- Create: `packages/storage-filesystem/src/safe-directory.mjs`
- Create: `packages/storage-filesystem/src/record-id.mjs`
- Create: `packages/storage-filesystem/src/recovery.mjs`
- Create: `packages/storage-filesystem/test/store-contract.test.mjs`
- Create: `packages/storage-filesystem/test/recovery.test.mjs`
- Create: `tests/process/store-concurrency.test.mjs`
- Modify: `packages/core/test/service-contract.test.mjs`

**Interfaces:**
- Consumes: `CoordinationStore`/`CoordinationTransaction` ports from Task 4; reconciled storage behavior preserved under `prototype/integrated/tools/agents/lib/`
- Produces:

```js
openFilesystemStore({ root, clock, ids }): Promise<CoordinationStore>
diagnoseFilesystemStore({ root }): Promise<RepairReport>
repairFilesystemStore({ root, clock }): Promise<RepairReport>
/** @typedef {{ healthy: boolean, repaired: string[], blocked: string[],
 * corrupt: string[] }} RepairReport */
```

`diagnoseFilesystemStore` is read-only; `repairFilesystemStore` applies only unambiguous repairs and fails closed on everything listed under `blocked` or `corrupt`.

- [ ] **Step 1: Make the store contract suite store-agnostic**

Refactor `packages/core/test/service-contract.test.mjs` so every contract test runs through an exported factory runner:

```js
export function runStoreContract(name, makeStore) {
  test(`${name}: transaction rollback hides state and events`, async () => { /* existing body */ });
  test(`${name}: stale generation write fails with EXIT.CONFLICT`, async () => { /* existing body */ });
}
```

Keep the memory-store invocation in the same file. Create `packages/storage-filesystem/test/store-contract.test.mjs` that calls `runStoreContract("filesystem", () => openFilesystemStore({ root, clock, ids }))` inside a temp directory from `withTempWorkspace`.

- [ ] **Step 2: Run RED**

```bash
node --test packages/storage-filesystem/test/store-contract.test.mjs
```

Expected: module-not-found failure for `openFilesystemStore`.

- [ ] **Step 3: Port the reconciled storage behavior**

Port from `prototype/integrated/tools/agents/lib/` without changing semantics: atomic write plus no-replace publication (`atomic-json.mjs`), no-follow regular-file reads and managed-root containment (`safe-file.mjs`, `safe-directory.mjs`), record/filename binding (`record-id.mjs`), and the directory-based owner mutex from `repair-mutex.mjs` as the per-workspace writer mutex (owner file with pid, token, and acquisition time; stale takeover only under its existing rules). Preserve injected opener and directory-reader seams as final arguments.

The event log is new code built on those ported primitives — the prototype has no event feed. Inside the writer mutex a transaction allocates the next sequence number, writes one write-ahead journal entry listing every intended record and event publication (the generalization of the prototype's claims-audit pattern), publishes each file with no-replace semantics, and then retires the journal entry. Event filenames embed the zero-padded sequence so lexicographic directory order equals event order; the cursor is the last consumed sequence. A failed callback publishes nothing and appends no event.

- [ ] **Step 4: Port recovery and audits**

Port the reconciled claims-audit and recovery-audit semantics into `recovery.mjs`: an audit with the exact still-active source generation and absent destination is pending and replayable; a replacement generation, mismatched bytes, orphan target, or conflicting destination is corrupt and blocks repair. Neither function mutates a store whose protocol identity or schema version does not validate.

- [ ] **Step 5: Add the crash-window replay test**

In `packages/storage-filesystem/test/recovery.test.mjs`, use the injected failure seam to abort a transaction (a) after the journal entry is written but before any publication, and (b) after the event file is published but before the state record. Reopening the store, and running `repairFilesystemStore`, must either complete the journaled publications exactly or roll them back; `eventsSince` never exposes a partially published transaction, and running repair twice changes nothing.

- [ ] **Step 6: Run focused GREEN**

```bash
node --test packages/storage-filesystem/test/*.test.mjs packages/core/test/service-contract.test.mjs
```

Expected: the same contract suite passes against both memory and filesystem stores; recovery and crash-window tests pass.

- [ ] **Step 7: Add the process-level concurrency test**

`tests/process/store-concurrency.test.mjs` spawns independent Node child processes that perform conflicting `put` calls with the same expected generation against one filesystem store. Exactly one process succeeds; every other exits with `EXIT.CONFLICT`; the event log afterward has no gaps and no duplicate sequence numbers.

- [ ] **Step 8: Mutation proof**

Temporarily allow replacement in the publication step through the injected seam. The no-replace contract test and the concurrency test must fail by name. Restore production behavior and rerun green.

- [ ] **Step 9: Commit**

```bash
git add packages/storage-filesystem packages/core tests/process
git commit -m "feat: extract filesystem coordination store"
```

---

### Task 6: Extract Workspace discovery and runtime paths

**Files:**
- Create: `packages/cli/src/workspace-discovery.mjs`
- Create: `packages/cli/src/runtime-paths.mjs`
- Create: `packages/cli/test/workspace-discovery.test.mjs`
- Create: `packages/cli/test/runtime-paths.test.mjs`

**Interfaces:**
- Produces:

```js
discoverWorkspace({ cwd, explicitConfig, env, gitProbe }): Promise<WorkspaceDescriptor>
runtimePaths({ dataHome, workspaceId }): RuntimePaths
```

`WorkspaceDescriptor` uses the exact shape in `docs/ARCHITECTURE.md`. `RuntimePaths` is:

```js
/** @typedef {{ root: string, protocol: string, events: string, state: string,
 * locks: string, quarantine: string, ephemeral: string }} RuntimePaths */
```

`ephemeral` holds presence and Intent records for workspaces that have not yet materialized durable state (`docs/ARCHITECTURE.md`, “Lazy workspace materialization”).

- [ ] **Step 1: Write discovery RED fixtures**

Test explicit config, Git common-dir with two worktrees, plain directory, moved configured Workspace, relative override rejection, symlinked config rejection, and state paths outside Workspace.

- [ ] **Step 2: Run RED**

```bash
node --test packages/cli/test/{workspace-discovery,runtime-paths}.test.mjs
```

- [ ] **Step 3: Implement non-Git discovery first**

Canonicalize the selected root and derive a stable directory-source ID. Runtime path uses the platform user-data root and portable Workspace ID. Keep `workspace-discovery.mjs` free of CLI side effects — no argument parsing, no `process.exit`, no stdout — because `packages/mcp-server` and native adapters import it directly.

- [ ] **Step 4: Add optional Git enrichment**

`gitProbe` is injected. Failure or absence returns a directory descriptor, not an error. Multiple worktrees share a Git source ID while keeping different `worktreeRoot` fields.

- [ ] **Step 5: Mutation proof and commit**

Temporarily place runtime state under `cwd/.agents`; the outside-Workspace test must fail. Restore.

```bash
git add packages/cli
git commit -m "feat: discover standalone workspaces"
```

---

### Task 7: Implement participant, session, and Intent services

**Files:**
- Create: `packages/core/src/sessions.mjs`
- Create: `packages/core/src/intents.mjs`
- Create: `packages/core/test/sessions.test.mjs`
- Create: `packages/core/test/intents.test.mjs`

**Interfaces:**
- Produces:

```js
openSession(input): Promise<Session>
heartbeatSession(input): Promise<Session>
closeSession(input): Promise<Session>
classifySessionPresence(session, now, probe): "online" | "stale" | "offline"
setIntent(input): Promise<WorkIntent>
clearIntent(input): Promise<void>
```

- [ ] **Step 1: Write lifecycle and Intent RED**

Test unique generation, duplicate-live rejection, stale generation replacement policy, old-close cannot close successor, heartbeat boundary, exact Intent owner, and no raw prompt field accepted. Also test presence classification: a recent heartbeat is `online`; a heartbeat older than the session's declared cadence window is `stale` (hook-only adapters cannot heartbeat while the harness is idle, so `stale` is a normal truthful state, not an error); a closed session or a failed liveness probe is `offline`.

Also test lazy materialization (approved 2026-08-15): a lone session with no durable objects leaves only ephemeral presence and Intent records; the workspace materializes durable state exactly once — when a second live session attaches or the first durable object is created — and current presence and Intents are recorded durably at that moment; closing the only session of an ephemeral-only workspace leaves nothing behind.

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/{sessions,intents}.test.mjs
```

- [ ] **Step 3: Implement transactional lifecycle**

Every lifecycle mutation checks Workspace and generation inside one store transaction. A Session close transitions state; it does not delete durable history. `heartbeatSession` updates an ephemeral presence view without appending to the semantic event feed (spec §6.4); only open/close and online/stale/offline transitions surface through cursor sync.

`openSession` writes ephemeral presence while the workspace has no durable state. Materialization is a single transaction that establishes protocol identity, starts the event log, and records current presence and Intents; it is triggered by the second live session or the first durable object, never by a lone quiet session.

- [ ] **Step 4: Implement Intent rules**

Intent summary is bounded, non-empty, and attached to the exact session. `resourceHints` are advisory strings validated as portable resource URIs.

- [ ] **Step 5: Demonstrate old-generation RED and commit**

Temporarily remove the generation check from close. The successor-preservation test must fail. Restore.

```bash
git add packages/core
git commit -m "feat: track sessions and work intent"
```

---

### Task 8: Implement workstreams, tasks, and claims

**Files:**
- Create: `packages/core/src/workstreams.mjs`
- Create: `packages/core/src/tasks.mjs`
- Create: `packages/core/src/claims.mjs`
- Create: `packages/core/test/workstreams.test.mjs`
- Create: `packages/core/test/tasks.test.mjs`
- Create: `packages/core/test/claims.test.mjs`

**Interfaces:**
- Produces:

```js
createWorkstream(input): Promise<Workstream>
acquireCoordinator(input): Promise<Workstream>
createTask(input): Promise<Task>
claimTask(input): Promise<Task>
transitionTask(input): Promise<Task>
acquireClaim(input): Promise<ResourceClaim>
renewClaim(input): Promise<ResourceClaim>
releaseClaim(input): Promise<void>
forceReleaseClaim(input): Promise<void>
```

- [ ] **Step 1: Write RED for optional coordination**

Test Workspace with Intents but no Workstream, Workstream with no coordinator, coordinator lease replacement only after policy permits it, task dependency unblocking, and global claim conflict across two Workstreams. Also test claim lease expiry (an expired claim stops conflicting and its old generation cannot renew), staleness metadata (a conflict against a claim whose owner session is stale reports that staleness but still blocks until expiry or force release), and force-release authority (a peer session cannot force-release; a human or policy actor can).

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/{workstreams,tasks,claims}.test.mjs
```

- [ ] **Step 3: Implement Workstream and task graph**

Coordinator is a scoped lease. Completing a dependency updates derived claimability in the same transaction. Circular dependencies are rejected.

- [ ] **Step 4: Implement generic claims**

Claims compare canonical resource namespace plus adapter-provided overlap key. Workspace-global conflict is independent of Workstream ID.

Port the prototype's lease semantics: every claim carries `expiresAt` and renewal demands the exact owner generation. Replace the prototype's orchestrator-only force release with the standalone authority model — `forceReleaseClaim` requires human or policy authority (a coordinator lease does not extend outside its Workstream) and appends an audit event recording actor, reason, and the replaced generation. Presence staleness alone never auto-releases a claim.

- [ ] **Step 5: Concurrent claim process test**

Add `tests/process/concurrent-claim.test.mjs` that starts independent processes against the filesystem store from Task 5. Exactly one exclusive contender succeeds; the others return conflict.

- [ ] **Step 6: Verify mutation and commit**

Neutralize Workstream-independent claim lookup; the cross-workstream test must fail. Restore.

```bash
git add packages/core tests/process
git commit -m "feat: coordinate workstreams tasks and claims"
```

---

### Task 9: Implement communication, sync, status, and CLI composition

**Files:**
- Create: `packages/core/src/communication.mjs`
- Create: `packages/core/src/sync.mjs`
- Create: `packages/core/src/status.mjs`
- Create: `packages/core/test/communication.test.mjs`
- Create: `packages/core/test/sync.test.mjs`
- Create: `packages/core/test/status.test.mjs`
- Create: `packages/cli/src/main.mjs`
- Create: `packages/cli/src/args.mjs`
- Create: `packages/cli/src/doctor-command.mjs`
- Create: `packages/cli/test/integration.test.mjs`
- Create: `bin/acc.mjs`

**Interfaces:**
- Consumes: session lifecycle services from Task 7 (`openSession`, `heartbeatSession`, `closeSession`) and `diagnoseFilesystemStore`/`repairFilesystemStore` from Task 5
- Produces high-level operations `sync`, `work`, `claim`, `message`, `task`, `finish`, `status`, `doctor`
- Produces adapter-facing lifecycle commands `attach`, `heartbeat`, `detach` (they map to `openSession`, `heartbeatSession`, `closeSession`; they are not advertised as model tools)
- Produces stable `--json` envelopes from `@agents-can-communicate/protocol`

- [ ] **Step 1: Write communication and sync RED**

Test typed message, per-recipient delivery state, immutable acknowledgement, Decision authority, artifact digest, handoff evidence, cursor replay, attention ordering, and bounded projection. Also test full-scope sync (peer equality, approved 2026-08-15): any session requests `scope: "full"` and receives the complete Workspace snapshot including another participant's collapsed child sessions; the ambient default remains a bounded delta; no session gets a reduced full view because of its role. Also test the solo case (solo zero-overhead, approved 2026-08-15): a Workspace with one live session, no claims, and no messages yields empty attention and an empty bounded projection.

- [ ] **Step 2: Write CLI RED**

Spawn `node bin/acc.mjs --json status` in a temp non-Git Workspace. Expected initial failure: missing executable. Add cases for malformed stdin, conflicting body sources, unknown command, and pure JSON error output.

- [ ] **Step 3: Implement communication and sync**

Use one transaction for message plus recipient queues. Sync returns a new cursor and priority-sorted attention without changing delivery to seen unless the caller explicitly confirms injection/visibility. `sync` accepts `scope: "delta" | "full"`; the full scope returns `store.snapshot(workspaceId)` with collapsed child sessions included and is available to every session equally.

- [ ] **Step 4: Implement CLI composition**

`bin/acc.mjs` delegates to `packages/cli/src/main.mjs` and exits with `AccError.code`. Human errors use stderr; JSON mode writes exactly one JSON object to stdout and no human diagnostics.

`attach` opens a session and prints the session ID plus generation token so the adapter can later heartbeat and `detach` the exact generation; `detach` with a stale generation fails with `EXIT.CONFLICT`. `doctor` composes `diagnoseFilesystemStore` (read-only) with core health rules; `doctor --repair` calls `repairFilesystemStore` and fails closed when the report lists `blocked` or `corrupt` entries.

- [ ] **Step 5: Run focused and complete tests**

```bash
node --test packages/core/test/{communication,sync,status}.test.mjs packages/cli/test/integration.test.mjs
npm test
npm run check
git diff --check
```

- [ ] **Step 6: Project-specific token scan**

```bash
rg -n 'PW2_|Papercut|papercut-warzone|docs/plan|game/|orchestrator' packages bin tests
```

Expected: no matches outside an explicit migration fixture.

- [ ] **Step 7: Commit**

```bash
git add packages bin tests package.json
git commit -m "feat: expose standalone coordination core"
```
