# Session Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ACC tell a session whose process has died from one that is merely idle, so the roster stops accumulating sessions that will never speak again.

**Architecture:** The hook records the client's process id when a session opens, resolved by walking the process ancestry until it finds the binary its own adapter declares. Presence classification then pairs that pid with two age floors, mirroring `writer-mutex.mjs`, which reclaims a lock that is dead *and* old. Nothing is written back to the session record: only the derived presence changes, and `offline` already means "drop off the roster".

**Tech Stack:** Node 24, ESM, `node:test`, zero runtime dependencies, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-28-session-liveness-design.md`

## Global Constraints

- Node 24, ESM only, zero runtime dependencies. No new packages.
- `packages/core/src/**` and `packages/protocol/src/**` must not import `child_process` or anything matching `adapter-`. Enforced by `tests/package-boundaries.test.mjs`, which scans only those two packages' `src` trees. `packages/hook-runner/src/**` is not scanned and may spawn.
- `process.kill(pid, 0)` needs no import, so the liveness check itself is legal inside `core`.
- No backward compatibility is required. Confirmed by the maintainer: pre-release, one local tester, the store may be deleted. Do not write a migration.
- Record fixtures do not exist anywhere in the repository, and every `schemaVersion: 1` literal in the tree belongs to the project-config file (`acc.workspace.json`) or the installer plan — both separate schemas. Do not touch them when bumping the record `SCHEMA_VERSION`.
- Run the whole suite with `npm test` from the repository root. Run one file with `node --test <path>`, also from the root, so workspace package resolution works.
- Never pass `--no-verify`. `git add`, `git commit` and `git push` are always separate commands. No Claude Code attribution in commit messages.

---

## File Structure

**Created:**
- `packages/core/src/pid.mjs` — one exported function, `defaultPidIsAlive`. Isolated so the ambient `process.kill` call has exactly one home and tests can substitute it everywhere else.
- `packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs` — the classification rule, all six branches.
- `packages/hook-runner/src/client-pid.mjs` — ancestry walk. Takes the process table as an injected argument; contains no spawning itself so it is testable without processes.
- `packages/hook-runner/src/process-table.mjs` — the one place that spawns `ps`. Separated from the walk because spawning is the part that cannot be unit-tested.
- `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs` — the walk against synthetic tables.

**Modified:**
- `packages/protocol/src/schema.mjs` — `pid` field on the session record; `SCHEMA_VERSION` 1 → 2.
- `packages/core/src/sessions.mjs` — the rule, the two floors, the required probe parameter, `pid` on the built record, and `assertReplaceable`'s default probe.
- `packages/core/src/service.mjs` — accept and pass the `pidIsAlive` port.
- `packages/core/src/{sync,status,claims,tasks,workstreams}.mjs` — destructure `pidIsAlive` from ports and pass it at each of the nine call sites.
- `packages/core/src/index.mjs` — export `defaultPidIsAlive`.
- `packages/hook-runner/src/runner.mjs` — resolve the pid at `sessionStart` and pass it to `openSession`.
- `docs/PROTOCOL.md`, `docs/CONCEPTS.md`, `docs/DESIGN_DECISIONS.md` — the record gained a field and presence gained a meaning.

---

### Task 1: The classification rule

Presence learns to reach `offline` for a session whose process is gone. This task deliberately ends with every caller updated, because making the probe parameter required breaks all nine call sites at once and the suite must be green at the commit.

**Files:**
- Create: `packages/core/src/pid.mjs`
- Create: `packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs`
- Modify: `packages/core/src/sessions.mjs:8-20` (constants and the classifier), `:66-72` (`assertReplaceable`)
- Modify: `packages/core/src/service.mjs:18-19`
- Modify: `packages/core/src/sync.mjs:207`, `packages/core/src/status.mjs:61`, `packages/core/src/claims.mjs:34`, `packages/core/src/tasks.mjs:87`, `packages/core/src/workstreams.mjs:11`
- Modify: `packages/core/src/index.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `defaultPidIsAlive(pid: number | null): boolean` from `packages/core/src/pid.mjs`
  - `classifySessionPresence(session: object, now: string, pidIsAlive: (pid: number) => boolean): "online" | "stale" | "offline"` — third parameter is now **required** and throws `AccError(EXIT.USAGE)` when absent
  - `createCoordinationService({ store, clock, ids, pidIsAlive?, policies? })` — `pidIsAlive` defaults to `defaultPidIsAlive`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { classifySessionPresence } from "../src/sessions.mjs";

const NOW = "2026-08-28T12:00:00.000Z";
const CADENCE = 60_000;

const ago = ms => new Date(Date.parse(NOW) - ms).toISOString();

const session = (overrides = {}) => ({
  sessionId: "session_a", state: "open", heartbeatCadenceMs: CADENCE,
  heartbeatAt: NOW, pid: null, ...overrides });

const alive = () => true;
const dead = () => false;

test("a closed session is offline whatever its pid says", () => {
  assert.equal(classifySessionPresence(session({ state: "closed", pid: 42 }), NOW, alive),
    "offline");
});

test("a session whose process is gone is offline, not stale", () => {
  // The point of the whole change: without a pid this is `online`, because it
  // beat a moment ago. The process is what tells us otherwise.
  assert.equal(classifySessionPresence(session({ pid: 42 }), NOW, dead), "offline");
});

test("a live process idle past the unknown floor stays on the roster", () => {
  // A kimi session beats only when its user takes a turn, so an hour of silence
  // is ordinary. The unknown floor must not apply when the pid answers.
  assert.equal(classifySessionPresence(
    session({ pid: 42, heartbeatAt: ago(90 * 60_000) }), NOW, alive), "stale");
});

test("a live process past the hard floor is offline anyway", () => {
  // pids are recycled, so "alive" can be a different program wearing the same
  // number. Twenty-five hours of silence is not a session anyone is using.
  assert.equal(classifySessionPresence(
    session({ pid: 42, heartbeatAt: ago(25 * 60 * 60_000) }), NOW, alive), "offline");
});

test("an unknown pid is judged by age alone", () => {
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(10_000) }), NOW, dead),
    "online");
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(5 * 60_000) }), NOW, dead),
    "stale");
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(31 * 60_000) }), NOW, dead),
    "offline");
});

test("omitting the probe fails loudly rather than checking nothing", () => {
  // A defaulted probe would let a forgotten call site disable the check while
  // everything still looked correct.
  assert.throws(() => classifySessionPresence(session(), NOW),
    error => error.code === EXIT.USAGE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs`
Expected: FAIL. The `pid`-driven cases return `online`/`stale` instead of `offline`, and the last case does not throw.

- [ ] **Step 3: Create the liveness helper**

Create `packages/core/src/pid.mjs`:

```javascript
/**
 * Whether a process with this id exists.
 *
 * Signal 0 runs the existence and permission checks without delivering
 * anything. `ESRCH` is the only answer that means gone: `EPERM` says the
 * process is there and owned by somebody else, which is still there.
 *
 * Deliberately not shared with the writer lock's copy in the storage package.
 * `core` may not import storage (tests/package-boundaries.test.mjs), and the two
 * ask the question about different subjects - a lock owner mid-write, and a
 * session that may have ended hours ago.
 */
export function defaultPidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
```

- [ ] **Step 4: Replace the classifier**

In `packages/core/src/sessions.mjs`, replace the block from `const STALE_CADENCE_MULTIPLE = 3;` through the end of `classifySessionPresence` with:

```javascript
const STALE_CADENCE_MULTIPLE = 3;

// Two floors, because they answer different questions and neither subsumes the
// other. UNKNOWN_EXPIRY_MS is the "cannot tell" branch: records written before
// pids were recorded, platforms with no process table, an ancestry that did not
// resolve. HARD_EXPIRY_MS exists because pids are recycled - the hazard
// writer-mutex.mjs:72 documents - so a session whose number was reissued to
// something unrelated would otherwise read as alive forever.
const UNKNOWN_EXPIRY_MS = 30 * 60_000;
const HARD_EXPIRY_MS = 24 * 60 * 60_000;

const ageBand = (session, age) =>
  age <= session.heartbeatCadenceMs * STALE_CADENCE_MULTIPLE ? "online" : "stale";

/**
 * @returns {"online" | "stale" | "offline"}
 */
export function classifySessionPresence(session, now, pidIsAlive) {
  // Required rather than defaulted. A probe that defaults to "everyone is
  // alive" turns a forgotten call site into a check that silently passes, which
  // is the failure this repository has already shipped twice.
  if (typeof pidIsAlive !== "function") {
    throw new AccError(EXIT.USAGE, "classifySessionPresence requires a pidIsAlive probe",
      { sessionId: session?.sessionId ?? null });
  }
  if (session.state === "closed") return "offline";
  const age = Date.parse(now) - Date.parse(session.heartbeatAt);
  if (age > HARD_EXPIRY_MS) return "offline";
  const pid = session.pid ?? null;
  // A pid that answers outranks the unknown floor: a live but idle session is
  // exactly what kimi looks like between turns.
  if (pid !== null) return pidIsAlive(pid) ? ageBand(session, age) : "offline";
  return age > UNKNOWN_EXPIRY_MS ? "offline" : ageBand(session, age);
}
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `node --test packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full suite to see the call sites break**

Run: `npm test`
Expected: FAIL. Every path through `sync`, `status`, `claims`, `tasks` and `workstreams` now throws "classifySessionPresence requires a pidIsAlive probe". This is the required parameter doing its job; the next steps supply it.

- [ ] **Step 7: Add the port to the service**

In `packages/core/src/service.mjs`, add the import and widen the factory:

```javascript
import { defaultPidIsAlive } from "./pid.mjs";
```

```javascript
export function createCoordinationService({ store, clock, ids,
  pidIsAlive = defaultPidIsAlive, policies = {} }) {
  // Defaulted here, where the default is a real implementation, and required in
  // the classifier, where a default could only be a lie.
  const ports = { ...assertPorts({ store, clock, ids }), pidIsAlive };
```

- [ ] **Step 8: Thread the port through the five services**

One line each. In `packages/core/src/sync.mjs:207`, `packages/core/src/status.mjs:61`, `packages/core/src/claims.mjs:34`, `packages/core/src/tasks.mjs:87` and `packages/core/src/workstreams.mjs:11`, add `pidIsAlive` to the existing destructure:

```javascript
const { store, clock, pidIsAlive } = ports;          // sync.mjs, status.mjs
const { store, clock, ids, pidIsAlive } = ports;     // claims.mjs, tasks.mjs, workstreams.mjs
```

In `packages/core/src/sessions.mjs`, add it to the destructure in `createSessionService`:

```javascript
const { store, clock, ids, pidIsAlive } = ports;
```

- [ ] **Step 9: Pass the probe at all nine call sites**

Append `, pidIsAlive` to each existing `classifySessionPresence(...)` call:

- `packages/core/src/sync.mjs:159`, `:161`, `:251`
- `packages/core/src/status.mjs:76`, `:92`, `:102`
- `packages/core/src/claims.mjs:55`
- `packages/core/src/workstreams.mjs:66`
- `packages/core/src/tasks.mjs:129`

For example, `sync.mjs:161` becomes:

```javascript
    .filter(session => classifySessionPresence(session, now, pidIsAlive) === "online")
```

- [ ] **Step 10: Give `assertReplaceable` a real default probe**

In `packages/core/src/sessions.mjs`, replace `assertReplaceable` with:

```javascript
  function assertReplaceable(existing, probe) {
    if (existing.record.state === "closed") return;
    // Presence staleness alone never replaces ownership: an idle-but-open
    // session may resume at any moment. Only a session judged gone permits a
    // replacement generation - which, before pids, nothing could ever be.
    const live = probe ?? (record =>
      classifySessionPresence(record, clock.now(), pidIsAlive) !== "offline");
    if (live(existing.record)) {
      throw new AccError(EXIT.CONFLICT, "the session id is already live",
        { sessionId: existing.record.sessionId });
    }
  }
```

- [ ] **Step 11: Export the helper**

In `packages/core/src/index.mjs`, beside the existing `classifySessionPresence` export:

```javascript
export { defaultPidIsAlive } from "./pid.mjs";
```

- [ ] **Step 12: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. Existing sessions carry no `pid`, so they take the unknown branch and every existing expectation about fresh heartbeats holds.

- [ ] **Step 13: Commit**

```bash
git add packages/core/src/pid.mjs packages/core/src/sessions.mjs packages/core/src/service.mjs packages/core/src/sync.mjs packages/core/src/status.mjs packages/core/src/claims.mjs packages/core/src/tasks.mjs packages/core/src/workstreams.mjs packages/core/src/index.mjs packages/core/test/a-dead-session-is-not-a-stale-one.test.mjs
```

```bash
git commit -m "feat: presence can tell a dead session from an idle one"
```

---

### Task 2: The session record carries a pid

**Files:**
- Modify: `packages/protocol/src/schema.mjs:5` (`SCHEMA_VERSION`), `:79-82` (the session record)
- Modify: `packages/core/src/sessions.mjs` (`sessionRecord`)
- Test: `packages/core/test/sessions.test.mjs`

**Interfaces:**
- Consumes: `classifySessionPresence` reading `session.pid` (Task 1).
- Produces: `openSession({ ..., pid?: number | null })` stores `pid`, defaulting to `null`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/sessions.test.mjs`:

```javascript
test("a session records the process behind it, or null when nobody knows", async () => {
  const { service } = makeService();

  const known = await service.openSession(opening({ pid: 4321 }));
  const unknown = await service.openSession(opening({ participantId: "participant_b",
    pid: undefined }));

  // null is a first-class answer here, not a missing value: it is what the
  // ancestry walk returns when it cannot name the client.
  assert.equal(known.pid, 4321);
  assert.equal(unknown.pid, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/core/test/sessions.test.mjs`
Expected: FAIL with `session.pid is not a known field` — the validator rejects undeclared keys.

- [ ] **Step 3: Declare the field and bump the version**

In `packages/protocol/src/schema.mjs`, change line 5:

```javascript
export const SCHEMA_VERSION = 2;
```

and add `pid` to the session record:

```javascript
  session: { sessionId: id, participantId: id, workspaceId: id, generation: id,
    harness: line, state: oneOf("open", "closed"), parentSessionId: nullable(id),
    checkoutRoot: nullable(line), branch: nullable(line),
    // The process behind this session, when it can be named. Null means nobody
    // knows - no process table, or an ancestry that did not resolve - and is
    // read as "judge this one by age alone", never as "dead".
    pid: nullable(positiveInteger),
    enforcement: oneOf("guarded", "advisory"), lifecycle: oneOf("managed", "manual"),
    heartbeatCadenceMs: positiveInteger, startedAt: timestamp, heartbeatAt: timestamp },
```

The version bump is not ceremony. Without it a pre-existing record fails with `session requires pid`, which reads as corruption; with it the same record fails with `unknown schemaVersion: 1`, which is what actually happened.

- [ ] **Step 4: Store the value**

In `packages/core/src/sessions.mjs`, inside `sessionRecord`, beside `checkoutRoot`:

```javascript
  pid: input.pid ?? null,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test packages/core/test/sessions.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. No record fixtures exist in the repository, and every `schemaVersion: 1` literal in the tree belongs to `acc.workspace.json` or the installer plan, which are separate schemas and must stay at 1.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/schema.mjs packages/core/src/sessions.mjs packages/core/test/sessions.test.mjs
```

```bash
git commit -m "feat: the session record names the process behind it"
```

---

### Task 3: Finding the client behind the hook

**Files:**
- Create: `packages/hook-runner/src/client-pid.mjs`
- Create: `packages/hook-runner/src/process-table.mjs`
- Create: `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveClientPid({ table, from, command, maxHops? }): number | null` from `client-pid.mjs`, where `table` is `Map<number, { ppid: number, comm: string }>`
  - `readProcessTable({ run?, timeoutMs? }): Promise<Map<number, { ppid: number, comm: string }>>` from `process-table.mjs`

- [ ] **Step 1: Write the failing test**

Create `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

import { resolveClientPid } from "../src/client-pid.mjs";

// pid -> parent and executable, the shape `ps -o pid=,ppid=,comm=` gives us.
const table = entries => new Map(entries.map(([pid, ppid, comm]) => [pid, { ppid, comm }]));

test("finds the client when the hook is its direct child", () => {
  const processes = table([[100, 1, "claude"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), 100);
});

test("finds the client through an intervening shell", () => {
  // Measured on a real machine: a hook's parent is /bin/zsh and the client is
  // its grandparent, so stopping at the parent would record a process that dies
  // with the hook.
  const processes = table([[100, 1, "claude"], [150, 100, "/bin/zsh"], [200, 150, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), 100);
});

test("matches on the basename, since ps reports some entries with a path", () => {
  const processes = table([[100, 1, "/usr/local/bin/kimi"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "kimi" }), 100);
});

test("returns null when no ancestor is the client", () => {
  const processes = table([[100, 1, "sshd"], [200, 100, "node"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), null);
});

test("returns null on an empty table", () => {
  assert.equal(resolveClientPid({ table: new Map(), from: 200, command: "claude" }), null);
});

test("gives up rather than looping on a cyclic table", () => {
  // A pid table read while processes are exiting can disagree with itself.
  const processes = table([[100, 200, "a"], [200, 100, "b"]]);
  assert.equal(resolveClientPid({ table: processes, from: 200, command: "claude" }), null);
});

test("stops after the hop limit", () => {
  const deep = table(Array.from({ length: 40 },
    (unused, index) => [index + 1, index + 2, "sh"])
    .concat([[41, 1, "claude"]]));
  assert.equal(resolveClientPid({ table: deep, from: 1, command: "claude", maxHops: 5 }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`
Expected: FAIL, cannot find module `../src/client-pid.mjs`.

- [ ] **Step 3: Write the walk**

Create `packages/hook-runner/src/client-pid.mjs`:

```javascript
import path from "node:path";

// Deep enough for a client that wraps its hook in a shell and a launcher, short
// enough that a table which disagrees with itself cannot spin.
const MAX_HOPS = 16;

/**
 * The pid of the client this hook is running for, or null when nobody knows.
 *
 * The hook is not the client's child. Measured on macOS, a process spawned by
 * Claude Code has parent `/bin/zsh` and grandparent `claude`, so `process.ppid`
 * names a shell that dies with the hook. Walking until the adapter's own
 * declared binary appears is what makes the answer specific rather than a guess
 * about which ancestors are "real".
 *
 * Null is a first-class answer: it means judge this session by age alone.
 */
export function resolveClientPid({ table, from, command, maxHops = MAX_HOPS }) {
  const seen = new Set();
  let current = from;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const entry = table.get(current);
    if (entry === undefined || seen.has(current)) return null;
    seen.add(current);
    // `ps` reports some entries bare (`claude`) and some with a path
    // (`/bin/zsh`), so the comparison has to be on the basename.
    if (path.basename(entry.comm) === command) return current;
    if (entry.ppid === current || entry.ppid <= 1) return null;
    current = entry.ppid;
  }
  return null;
}
```

Note that the walk checks the process it is *at* before stepping up, so a hook that is itself the client (no wrapper) still resolves.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the spawning half**

Create `packages/hook-runner/src/process-table.mjs`:

```javascript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A hook runs in front of someone's turn. Reading the table is worth a few
// hundred milliseconds once per session and nothing at all if it is slow.
const DEFAULT_TIMEOUT_MS = 1_000;

const LINE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

/**
 * Every process on this machine, as pid -> parent and executable.
 *
 * Returns an empty map rather than throwing when the platform has no `ps`
 * (Windows) or the call fails. An empty table resolves no client, which is the
 * "nobody knows" answer the caller already handles.
 */
export async function readProcessTable({ run: exec = run,
  timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec("ps", ["-o", "pid=,ppid=,comm=", "-A"],
      { timeout: timeoutMs });
    const table = new Map();
    for (const line of stdout.split("\n")) {
      const match = LINE.exec(line);
      if (match === null) continue;
      table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3] });
    }
    return table;
  } catch {
    return new Map();
  }
}
```

- [ ] **Step 6: Add a test for the parser**

Append to `packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`:

```javascript
import { readProcessTable } from "../src/process-table.mjs";

test("parses a ps table, including commands containing spaces", async () => {
  const stdout = "  100     1 claude\n  150   100 /bin/zsh\n"
    + "  200   150 /Applications/Some App.app/Contents/MacOS/app\n";
  const table = await readProcessTable({ run: async () => ({ stdout }) });

  assert.equal(table.get(100).comm, "claude");
  assert.equal(table.get(150).ppid, 100);
  assert.equal(table.get(200).comm, "/Applications/Some App.app/Contents/MacOS/app");
});

test("a platform without ps yields an empty table rather than an error", async () => {
  const table = await readProcessTable({ run: async () => { throw new Error("ENOENT"); } });
  assert.equal(table.size, 0);
});
```

- [ ] **Step 7: Run the tests**

Run: `node --test packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures. `packages/hook-runner` is outside the boundary scan, so importing `child_process` here is legal — confirm by checking `tests/package-boundaries.test.mjs` still passes.

- [ ] **Step 9: Commit**

```bash
git add packages/hook-runner/src/client-pid.mjs packages/hook-runner/src/process-table.mjs packages/hook-runner/test/finding-the-client-behind-the-hook.test.mjs
```

```bash
git commit -m "feat: name the client process behind a hook"
```

---

### Task 4: The hook records the pid

**Files:**
- Modify: `packages/hook-runner/src/runner.mjs:157-176` (`sessionStart`)
- Test: `packages/hook-runner/test/runner.test.mjs`

**Interfaces:**
- Consumes: `resolveClientPid` and `readProcessTable` (Task 3); `openSession({ pid })` (Task 2).
- Produces: session records written by hooks carry a `pid`.

- [ ] **Step 1: Give the test's fake adapter a client to look for**

The two fake adapters in `packages/hook-runner/test/runner.test.mjs` declare no
`client`, so the walk would have no binary name to match. Add one to the `kimi`
fixture, matching what the real adapter declares:

```javascript
const kimi = {
  id: "kimi",
  client: { command: "kimi", versionArgs: ["--version"] },
  normalizeHook: payload => payload,
```

- [ ] **Step 2: Write the failing test**

Append to `packages/hook-runner/test/runner.test.mjs`. `run()` returns the
service, and the session of a lone attach lives in the ephemeral area:

```javascript
test("a session opened by a hook names the client process", async t => {
  const place = await workspace(t);
  // The walk starts at this test process, so the synthetic table has to be
  // rooted there. Naming `kimi` two hops up proves the shell in between is
  // stepped over, which is the case a real machine actually produces.
  const table = new Map([
    [process.pid, { ppid: 900, comm: "node" }],
    [900, { ppid: 100, comm: "/bin/zsh" }],
    [100, { ppid: 1, comm: "kimi" }],
  ]);

  const started = await run("kimi", event("sessionStart"), place,
    { readProcessTable: async () => table });

  const record = await started.service.store.ephemeral.get("session",
    started.accSessionId);
  assert.equal(record.pid, 100);
});

test("a session still opens when the client cannot be named", async t => {
  const place = await workspace(t);

  const started = await run("kimi", event("sessionStart"), place,
    { readProcessTable: async () => new Map() });

  const record = await started.service.store.ephemeral.get("session",
    started.accSessionId);
  // Null, not a failure: an unnameable client must never stop a session opening.
  assert.equal(started.exitCode, 0);
  assert.equal(record.pid, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test packages/hook-runner/test/runner.test.mjs`
Expected: FAIL — `stored.pid` is `null` in the first test, because nothing resolves it yet.

- [ ] **Step 4: Wire it into sessionStart**

In `packages/hook-runner/src/runner.mjs`, add the imports:

```javascript
import { resolveClientPid } from "./client-pid.mjs";
import { readProcessTable as defaultReadProcessTable } from "./process-table.mjs";
```

Accept the reader in `runHook`'s options so tests can substitute it, defaulting to the real one:

```javascript
export async function runHook({ adapterId, payload, adapters, dataHome, env,
  readProcessTable = defaultReadProcessTable, ...
```

Pass it down to the handler alongside the other context, then inside `sessionStart`, before `openSession`:

```javascript
    // Once per session, never per turn. A client that cannot be found yields
    // null, and the session is then judged by age alone - which is exactly the
    // behaviour every session had before this existed.
    const command = adapter.client?.command ?? null;
    const pid = command === null ? null
      : resolveClientPid({ table: await readProcessTable(), from: process.pid, command });
```

and add `pid,` to the `openSession` argument object beside `checkoutRoot`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test packages/hook-runner/test/runner.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add packages/hook-runner/src/runner.mjs packages/hook-runner/test/runner.test.mjs
```

```bash
git commit -m "feat: hooks record the client process when a session opens"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/PROTOCOL.md`, `docs/CONCEPTS.md`, `docs/DESIGN_DECISIONS.md`

- [ ] **Step 1: Document the field**

In `docs/PROTOCOL.md`, beside the existing sentence about `checkoutRoot` and `branch` (line 20), add:

```markdown
- A session records the process behind it — `pid` — when the hook can name one, and
  `null` when it cannot. Null means "judge this session by age alone"; it never
  means the session is dead.
```

- [ ] **Step 2: Document the presence meaning**

In `docs/CONCEPTS.md`, wherever presence is described, state the rule in prose: a session is `offline` when it is closed, when its process is gone, or when it has been silent long enough that nobody can tell — thirty minutes with no pid, a day with one.

- [ ] **Step 3: Record the decision**

In `docs/DESIGN_DECISIONS.md`, add to the "Settled" table:

```markdown
| Presence reads the process, never writes the record | A pid answers "gone" at once and an age floor answers what a pid cannot, including its own reuse. Nothing is written back: in a system with no session in charge, a bystander editing another session's record is authority it does not have. |
```

The existing row "No heartbeat helper in v1" stands and must not be removed. Add a sentence to this new row's reason making the distinction explicit: what was rejected was a process beating on a session's behalf; this asks about a process that is already there.

- [ ] **Step 4: Run the docs tests**

Run: `npm test`
Expected: PASS. `tests/docs` checks documentation claims against the code, so a wrong statement here fails the suite.

- [ ] **Step 5: Commit**

```bash
git add docs/PROTOCOL.md docs/CONCEPTS.md docs/DESIGN_DECISIONS.md
```

```bash
git commit -m "docs: record how presence tells dead from idle"
```

---

## Verifying the whole change by hand

The unit tests cannot show the thing the change is for. After Task 5, on a machine with ACC installed:

1. Delete the store — the schema bump makes every existing record invalid: `rm -rf ~/Library/Application\ Support/acc/workspaces`
2. Start a client, run `acc status`, confirm the session appears with `presence: online`.
3. Kill the client's process outright, so no session-end hook can fire.
4. From another session in the same workspace, run `acc status`. The killed session must be gone from the roster, and `acc status --all` must still list it.
5. Confirm `acc doctor` no longer reports it under "not answering".
