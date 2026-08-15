# ACC Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the certified prototype into a project-agnostic, package-shaped core that supports Workspace, Session, Intent, Workstream, Task, Claim, Message, Decision, Artifact, Handoff, sync, status, and doctor without vendor or Git requirements.

**Architecture:** Preserve behavior through ports rather than rewriting the entire prototype at once. Protocol schemas remain dependency-free ESM, core services depend on injected clock/ID/storage/project ports, and the first storage adapter wraps the reconciled filesystem implementation. CLI composes packages and exposes stable JSON envelopes.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, npm workspaces, dependency-free runtime during extraction.

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
  "test": "node --test tests/*.test.mjs tests/*/*.test.mjs packages/*/test/*.test.mjs",
  "check": "find packages -name '*.mjs' -print0 | xargs -0 -n1 node --check"
}
```

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

Reject unknown schema versions and unknown required enum values. Preserve optional forward-compatible metadata only under a named `extensions` object.

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
```

`CoordinationTransaction` is the object exposing `append`, `get`, `put`, and `list` above. `CoordinationService` is an object whose methods are added in Tasks 6–8; the factory freezes injected ports and exposes no global singleton.

- [ ] **Step 1: Write RED for atomic event/state behavior**

The memory store test performs a transaction that writes state then throws. Assert neither record nor event is visible afterward.

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/service-contract.test.mjs
```

- [ ] **Step 3: Implement the memory contract and service factory**

Use copied maps inside a transaction and swap only after callback success. Production core accepts no global clock or random source.

- [ ] **Step 4: Add optimistic generation conflict test**

Two transactions start from generation A. The first publishes B; the second write expecting A fails with `EXIT.CONFLICT` and emits no event.

- [ ] **Step 5: Verify and commit**

```bash
node --test packages/core/test/service-contract.test.mjs
git add packages/core tests/helpers
git commit -m "feat: add coordination storage port"
```

---

### Task 5: Extract Workspace discovery and runtime paths

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
 * locks: string, quarantine: string }} RuntimePaths */
```

- [ ] **Step 1: Write discovery RED fixtures**

Test explicit config, Git common-dir with two worktrees, plain directory, moved configured Workspace, relative override rejection, symlinked config rejection, and state paths outside Workspace.

- [ ] **Step 2: Run RED**

```bash
node --test packages/cli/test/{workspace-discovery,runtime-paths}.test.mjs
```

- [ ] **Step 3: Implement non-Git discovery first**

Canonicalize the selected root and derive a stable directory-source ID. Runtime path uses the platform user-data root and portable Workspace ID.

- [ ] **Step 4: Add optional Git enrichment**

`gitProbe` is injected. Failure or absence returns a directory descriptor, not an error. Multiple worktrees share a Git source ID while keeping different `worktreeRoot` fields.

- [ ] **Step 5: Mutation proof and commit**

Temporarily place runtime state under `cwd/.agents`; the outside-Workspace test must fail. Restore.

```bash
git add packages/cli
git commit -m "feat: discover standalone workspaces"
```

---

### Task 6: Implement participant, session, and Intent services

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
setIntent(input): Promise<WorkIntent>
clearIntent(input): Promise<void>
```

- [ ] **Step 1: Write lifecycle and Intent RED**

Test unique generation, duplicate-live rejection, stale generation replacement policy, old-close cannot close successor, heartbeat boundary, exact Intent owner, and no raw prompt field accepted.

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/{sessions,intents}.test.mjs
```

- [ ] **Step 3: Implement transactional lifecycle**

Every lifecycle mutation checks Workspace and generation inside one store transaction. A Session close transitions state; it does not delete durable history.

- [ ] **Step 4: Implement Intent rules**

Intent summary is bounded, non-empty, and attached to the exact session. `resourceHints` are advisory strings validated as portable resource URIs.

- [ ] **Step 5: Demonstrate old-generation RED and commit**

Temporarily remove the generation check from close. The successor-preservation test must fail. Restore.

```bash
git add packages/core
git commit -m "feat: track sessions and work intent"
```

---

### Task 7: Implement workstreams, tasks, and claims

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
```

- [ ] **Step 1: Write RED for optional coordination**

Test Workspace with Intents but no Workstream, Workstream with no coordinator, coordinator lease replacement only after policy permits it, task dependency unblocking, and global claim conflict across two Workstreams.

- [ ] **Step 2: Run RED**

```bash
node --test packages/core/test/{workstreams,tasks,claims}.test.mjs
```

- [ ] **Step 3: Implement Workstream and task graph**

Coordinator is a scoped lease. Completing a dependency updates derived claimability in the same transaction. Circular dependencies are rejected.

- [ ] **Step 4: Implement generic claims**

Claims compare canonical resource namespace plus adapter-provided overlap key. Workspace-global conflict is independent of Workstream ID.

- [ ] **Step 5: Concurrent claim process test**

Add `tests/process/concurrent-claim.test.mjs` that starts independent processes against the filesystem store. Exactly one exclusive contender succeeds; the others return conflict.

- [ ] **Step 6: Verify mutation and commit**

Neutralize Workstream-independent claim lookup; the cross-workstream test must fail. Restore.

```bash
git add packages/core tests/process
git commit -m "feat: coordinate workstreams tasks and claims"
```

---

### Task 8: Implement communication, sync, status, and CLI composition

**Files:**
- Create: `packages/core/src/communication.mjs`
- Create: `packages/core/src/sync.mjs`
- Create: `packages/core/src/status.mjs`
- Create: `packages/core/test/communication.test.mjs`
- Create: `packages/core/test/sync.test.mjs`
- Create: `packages/cli/src/main.mjs`
- Create: `packages/cli/src/args.mjs`
- Create: `packages/cli/test/integration.test.mjs`
- Create: `bin/acc.mjs`

**Interfaces:**
- Produces high-level operations `sync`, `work`, `claim`, `message`, `task`, `finish`, `status`, `doctor`
- Produces stable `--json` envelopes from `@agents-can-communicate/protocol`

- [ ] **Step 1: Write communication and sync RED**

Test typed message, per-recipient delivery state, immutable acknowledgement, Decision authority, artifact digest, handoff evidence, cursor replay, attention ordering, and bounded projection.

- [ ] **Step 2: Write CLI RED**

Spawn `node bin/acc.mjs --json status` in a temp non-Git Workspace. Expected initial failure: missing executable. Add cases for malformed stdin, conflicting body sources, unknown command, and pure JSON error output.

- [ ] **Step 3: Implement communication and sync**

Use one transaction for message plus recipient queues. Sync returns a new cursor and priority-sorted attention without changing delivery to seen unless the caller explicitly confirms injection/visibility.

- [ ] **Step 4: Implement CLI composition**

`bin/acc.mjs` delegates to `packages/cli/src/main.mjs` and exits with `AccError.code`. Human errors use stderr; JSON mode writes exactly one JSON object to stdout and no human diagnostics.

- [ ] **Step 5: Run focused and complete tests**

```bash
node --test packages/core/test/{communication,sync,status}.test.mjs packages/cli/test/integration.test.mjs
npm test
npm run check
git diff --check
```

- [ ] **Step 6: Project-specific token scan**

```bash
rg -n 'PW2_|Papercut|papercut-warzone|docs/plan|game/' packages bin tests
```

Expected: no matches outside an explicit migration fixture.

- [ ] **Step 7: Commit**

```bash
git add packages bin tests package.json
git commit -m "feat: expose standalone coordination core"
```
