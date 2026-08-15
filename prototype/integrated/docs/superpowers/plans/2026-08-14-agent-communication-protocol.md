# Agent Communication Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free local mailbox CLI that lets independent agents in every worktree register, exchange acknowledged messages, claim scopes, publish handoffs, and monitor one shared ignored bus.

**Architecture:** A thin Node CLI delegates to focused ES modules. Runtime state lives as atomic JSON records under the common checkout's ignored `.agents/` directory; immutable messages, receipts, acknowledgements, handoffs, and audit records are never edited in place, while each agent is the sole writer of its own registry and presence records. The primary PR deliberately excludes CI workflow changes; after the user merges it, a separate shared-file micro-PR will add the canonical Node test command.

**Tech Stack:** Node.js 22+ standard library only, ECMAScript modules, `node:test`, Git worktrees, JSON schema validation implemented locally.

## Global Constraints

- Work only in `.gitworktrees/ops-agent-comms-protocol` on branch `ops/agent-comms-protocol`; the main checkout remains read-only.
- Runtime has no npm dependencies and does not introduce `package.json` or `node_modules` requirements.
- The protocol version and every persisted record schema version are exactly `1`.
- Default heartbeat is 15 seconds, stale threshold is 45 seconds, fallback inbox scan is 2 seconds, claim lease is 1,800 seconds, and stale claim-lock threshold is 60 seconds.
- Runtime state is plaintext and must never contain secrets, tokens, or credentials.
- `.agents/` is local transport only; accepted contracts and decisions still go through Git and the existing plan documents.
- Every new executable gate must be demonstrated against a real bad input before its final GREEN run.
- `git add`, `git commit`, and `git push` are separate commands; never use `--no-verify`.
- No `.github/workflows/` change belongs in this primary branch.
- Keep every implementation module below 300 lines; if one crosses the limit, split by responsibility rather than adding a size exception.

---

## File Map

### Runtime

- `tools/agents/comms.mjs` — executable entry point, global option handling, command dispatch, and exit-code mapping only.
- `tools/agents/lib/errors.mjs` — `CommsError` plus the stable exit-code constants.
- `tools/agents/lib/args.mjs` — strict command-line parsing, repeated options, stdin/body selection, and human-versus-JSON output selection.
- `tools/agents/lib/paths.mjs` — shared-root discovery and complete bus directory layout.
- `tools/agents/lib/atomic-json.mjs` — strict JSON reads, exclusive atomic publication, fsync, same-filesystem replacement, listing, and immutable receipt helpers.
- `tools/agents/lib/schema.mjs` — protocol, registry, presence, message, acknowledgement, claim, handoff, and lock validation.
- `tools/agents/lib/attachments.mjs` — allowed-root resolution plus SHA-256 and byte-size evidence for message and handoff attachments.
- `tools/agents/lib/identity.mjs` — `init`, `register`, `resume`, and `close` lifecycle.
- `tools/agents/lib/messages.mjs` — `send`, `broadcast`, `inbox`, `ack`, and `reply`.
- `tools/agents/lib/presence.mjs` — heartbeat lifecycle, `watch`, and one-shot `wait`.
- `tools/agents/lib/claims.mjs` — scope normalization, overlap detection, leases, claim lock, claim, and release.
- `tools/agents/lib/handoff.mjs` — committed and explicitly uncommitted handoff creation and validation.
- `tools/agents/lib/status.mjs` — aggregate status, doctor diagnostics, and narrowly scoped repair operations.
- `tools/agents/lib/prompt.mjs` — committed-template loading and literal placeholder substitution.

### Tests

- `tests/tools/agent_comms/helpers.mjs` — isolated bus fixture, fake clock, CLI subprocess helper, and JSON readers used by all protocol tests.
- `tests/tools/agent_comms/errors.test.mjs` — stable exit codes and structured protocol errors.
- `tests/tools/agent_comms/paths.test.mjs` — environment override and common-dir discovery.
- `tests/tools/agent_comms/atomic-json.test.mjs` — atomicity, exclusivity, and corrupt JSON behavior.
- `tests/tools/agent_comms/schema.test.mjs` — strict versions, types, enums, ids, and attachment paths.
- `tests/tools/agent_comms/attachments.test.mjs` — allowed roots, existence, checksum, size, and committed-artifact metadata.
- `tests/tools/agent_comms/identity.test.mjs` — init/register/resume/close and duplicate identity.
- `tests/tools/agent_comms/messages.test.mjs` — concurrent delivery, seen/ack/archive/reply/broadcast, and crash recovery.
- `tests/tools/agent_comms/presence.test.mjs` — heartbeat, watcher uniqueness, stale/offline transitions, delivery, and timeout.
- `tests/tools/agent_comms/claims.test.mjs` — path and named-contract overlap, lease extension, stale claims, and lock recovery.
- `tests/tools/agent_comms/handoff.test.mjs` — evidence completeness and ready-to-merge semantics.
- `tests/tools/agent_comms/status.test.mjs` — counts, fail flags, corruption, stale locks, repair, and required agents.
- `tests/tools/agent_comms/args.test.mjs` — strict options, repeated values, body sources, and usage errors.
- `tests/tools/agent_comms/prompt.test.mjs` — byte-for-byte template rendering and checkpoint coverage.
- `tests/tools/agent_comms/integration.test.mjs` — black-box multi-process and linked-worktree acceptance.

### Documentation and bootstrap

- `docs/AGENT_COMMS.md` — lifecycle, command reference, semantics, recovery, and troubleshooting.
- `docs/AGENT_COMMS_PROMPT.md` — canonical copy-paste prompt with four literal placeholders.
- `AGENTS.md` — mandatory local-agent bootstrap and checkpoint polling rule.
- `.gitignore` — ignore the checkout-shared `.agents/` directory.

---

### Task 1: Durable bus foundation and strict schemas

**Files:**

- Create: `tools/agents/lib/errors.mjs`
- Create: `tools/agents/lib/paths.mjs`
- Create: `tools/agents/lib/atomic-json.mjs`
- Create: `tools/agents/lib/schema.mjs`
- Create: `tests/tools/agent_comms/helpers.mjs`
- Create: `tests/tools/agent_comms/errors.test.mjs`
- Create: `tests/tools/agent_comms/paths.test.mjs`
- Create: `tests/tools/agent_comms/atomic-json.test.mjs`
- Create: `tests/tools/agent_comms/schema.test.mjs`

**Interfaces:**

- Produces `EXIT = Object.freeze({ OK: 0, USAGE: 2, TIMEOUT: 3, DATA: 4, CONFLICT: 5, REQUIRED: 6 })`.
- Produces `class CommsError extends Error { constructor(message, exitCode, details = null) }`.
- Produces `resolveBusDir({ cwd, env, runGit }) -> Promise<string>` and `createBusPaths(busDir) -> Readonly<object>`.
- Produces `ensureBusLayout(paths) -> Promise<void>`.
- Produces `readJsonStrict(filePath, validate)`, `writeJsonAtomic(filePath, value, { tmpDir, exclusive })`, `listJsonFiles(dirPath)`, and `moveFileAtomic(source, destination)`.
- Produces all `validate*` functions consumed by later modules; every validator returns the original value or throws `CommsError` with exit code `4`.
- Test helper exports are `createBusFixture()`, `createGitWorktreeFixture()`, `createFakeClock(startIso)`, `runCli(fixture, argv, options)`, `pathExists(path)`, `seedOpenAgent(context, input)`, `seedPresence(context, input)`, and `seedMessage(context, input)`. Small semantic builders such as `validMessage()` or `registration()` are declared locally in the test that uses them.

- [ ] **Step 1: Write discovery tests that prove main and linked worktrees converge**

```js
test("environment override wins", async () => {
  const bus = await resolveBusDir({
    cwd: fixture.root,
    env: { PW2_AGENT_BUS_DIR: fixture.bus },
    runGit: failIfCalled,
  });
  assert.equal(bus, fixture.bus);
});

test("main and linked worktree resolve one shared bus", async () => {
  assert.equal(await fixture.resolveFrom(fixture.main), fixture.bus);
  assert.equal(await fixture.resolveFrom(fixture.worktree), fixture.bus);
});

test("exit codes are stable", () => {
  assert.deepEqual(EXIT, { OK: 0, USAGE: 2, TIMEOUT: 3, DATA: 4, CONFLICT: 5, REQUIRED: 6 });
  assert.equal(new CommsError("bad data", EXIT.DATA).exitCode, 4);
});
```

- [ ] **Step 2: Run the discovery tests and capture the RED**

Run: `node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs`

Expected: exit `1`, with `ERR_MODULE_NOT_FOUND` for `tools/agents/lib/paths.mjs`.

- [ ] **Step 3: Implement explicit override and conservative Git common-dir discovery**

```js
export async function resolveBusDir({ cwd, env = process.env, runGit }) {
  if (env.PW2_AGENT_BUS_DIR) return path.resolve(env.PW2_AGENT_BUS_DIR);
  const commonDir = path.resolve(cwd, (await runGit(cwd)).trim());
  if (path.basename(commonDir) !== ".git") {
    throw new CommsError("cannot infer checkout root; set PW2_AGENT_BUS_DIR", EXIT.DATA);
  }
  return path.join(path.dirname(commonDir), ".agents");
}
```

`createBusPaths()` must expose `protocol`, `registry`, `presence`, `inbox`, `seen`, `acknowledgements`, `claims`, `handoffs`, `archive`, `artifacts`, `locks`, `quarantine`, and `tmp`. `ensureBusLayout()` creates all directories and never deletes an existing record.

- [ ] **Step 4: Run discovery tests GREEN**

Run: `node --test tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs`

Expected: all path tests pass and exit `0`.

- [ ] **Step 5: Write atomic storage and schema tests**

```js
test("exclusive writes never replace an immutable record", async () => {
  await writeJsonAtomic(target, { value: 1 }, { tmpDir, exclusive: true });
  await assert.rejects(
    writeJsonAtomic(target, { value: 2 }, { tmpDir, exclusive: true }),
    error => error.exitCode === EXIT.CONFLICT,
  );
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { value: 1 });
});

test("unknown message versions fail loudly", () => {
  assert.throws(
    () => validateMessage({ ...validMessage, schema_version: 2 }),
    error => error.exitCode === EXIT.DATA,
  );
});
```

Add cases for malformed JSON, invalid agent ids, every message/severity enum, absolute attachment paths, paths escaping the repository, invalid SHA-256, absent required fields, and wrong scalar/array types.

- [ ] **Step 6: Run storage/schema tests and capture the RED**

Run: `node --test tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs`

Expected: exit `1` because the storage and validation exports do not exist.

- [ ] **Step 7: Implement durable writes and strict validators**

`writeJsonAtomic()` must serialize once, open a unique file under `tmpDir` with flag `wx`, write the complete buffer, call `FileHandle.sync()`, and close it. Mutable records publish with same-filesystem rename. Immutable `exclusive` records publish with `fs.link(temp, destination)`, Node's atomic no-replace operation on the same filesystem, then unlink the temp name. This avoids both overwrite races and a visible empty/partial destination; a reader only opens the final `.json` path. Sync the destination directory after publication.

```js
export function validateAgentId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(value)) {
    throw new CommsError("invalid agent id", EXIT.DATA, { value });
  }
  return value;
}
```

Validators must reject unknown keys for protocol-owned records so misspelled fields cannot silently bypass a gate. Attachment validation accepts normalized repo-relative paths and normalized `.agents/artifacts` paths only.

- [ ] **Step 8: Demonstrate the corrupt-data gate and restore GREEN**

Create malformed JSON only inside the test fixture, run the atomic test, and retain the assertion that `readJsonStrict()` returns exit code `4`. Then run:

`node --test tests/tools/agent_comms/paths.test.mjs tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs`

Expected: all foundation tests pass and exit `0`.

- [ ] **Step 9: Commit the foundation**

```bash
git add tools/agents/lib/errors.mjs tools/agents/lib/paths.mjs tools/agents/lib/atomic-json.mjs tools/agents/lib/schema.mjs tests/tools/agent_comms/helpers.mjs tests/tools/agent_comms/errors.test.mjs tests/tools/agent_comms/paths.test.mjs tests/tools/agent_comms/atomic-json.test.mjs tests/tools/agent_comms/schema.test.mjs
git commit -m "feat: add durable agent bus foundation"
```

---

### Task 2: Bus initialization and agent identity lifecycle

**Files:**

- Create: `tools/agents/lib/identity.mjs`
- Create: `tests/tools/agent_comms/identity.test.mjs`

**Interfaces:**

- Consumes `createBusPaths`, `ensureBusLayout`, `readJsonStrict`, `writeJsonAtomic`, identity schemas, `CommsError`, and `EXIT` from Task 1.
- Produces `initBus(context) -> Promise<ProtocolRecord>`.
- Produces `registerAgent(context, input) -> Promise<RegistryRecord>`.
- Produces `closeAgent(context, agentId) -> Promise<RegistryRecord>`.
- `context` is `{ paths, now: () => Date, pidIsAlive: (pid) => boolean, gitState: (cwd) => Promise<{ branch, head }>, releaseOwnedClaims: (agentId) => Promise<void> }`; tests inject a no-op claim releaser until Task 5 provides the real implementation.

- [ ] **Step 1: Write lifecycle tests**

```js
test("a live duplicate id is rejected", async () => {
  await registerAgent(context, registration("visual", worktreeA));
  await writeLivePresence(context, "visual", 1234);
  await assert.rejects(
    registerAgent(context, registration("visual", worktreeB)),
    error => error.exitCode === EXIT.CONFLICT,
  );
});

test("resume requires the same worktree and task", async () => {
  const first = await registerAgent(context, registration("models", worktreeA));
  const resumed = await registerAgent(context, { ...first, resume: true });
  assert.equal(resumed.agent_id, "models");
  await assert.rejects(
    registerAgent(context, { ...first, task: "M2.8", resume: true }),
    error => error.exitCode === EXIT.CONFLICT,
  );
});
```

Also cover an initialized record exactly shaped as `{ schema_version: 1, protocol_version: 1, checkout_id, checkout_root, initialized_at }`, idempotent compatible `init`, refusal to replace protocol version `2`, captured branch/HEAD, registration becoming stale without heartbeat, `close` refusal while a live watcher exists, and close releasing only that agent's claims. `checkout_id` is the SHA-256 of the canonical realpath of the Git common directory, so copied display names cannot alias one bus.

- [ ] **Step 2: Run lifecycle tests and capture the RED**

Run: `node --test tests/tools/agent_comms/identity.test.mjs`

Expected: exit `1` with missing `identity.mjs`.

- [ ] **Step 3: Implement lifecycle state transitions**

```js
export async function registerAgent(context, input) {
  const agentId = validateAgentId(input.agentId);
  const existing = await readRegistryIfPresent(context.paths, agentId);
  assertRegistrationAllowed(existing, input, await readPresenceIfPresent(context.paths, agentId), context);
  const git = await context.gitState(input.worktree);
  const record = makeRegistryRecord(input, git, context.now().toISOString());
  await writeJsonAtomic(context.paths.registryFile(agentId), record, {
    tmpDir: context.paths.tmp,
    exclusive: existing === null,
  });
  return record;
}
```

`closeAgent()` first proves the watcher PID is not live, marks the registry record `closed`, writes presence `offline`, and calls the injected `releaseOwnedClaims(agentId)` without deleting registry history. Task 8 wires this callback to Task 5's implementation.

- [ ] **Step 4: Demonstrate duplicate-live-identity refusal**

Temporarily point the duplicate test at two different worktrees with the same live id. Run the focused test and record exit `1` with an asserted conflict. Keep that test permanently, then run the complete identity file.

Run: `node --test tests/tools/agent_comms/identity.test.mjs`

Expected: all identity tests pass and exit `0`.

- [ ] **Step 5: Commit identity lifecycle**

```bash
git add tools/agents/lib/identity.mjs tests/tools/agent_comms/identity.test.mjs
git commit -m "feat: add agent identity lifecycle"
```

---

### Task 3: Immutable messaging, receipts, acknowledgements, and broadcast

**Files:**

- Create: `tools/agents/lib/messages.mjs`
- Create: `tools/agents/lib/attachments.mjs`
- Create: `tests/tools/agent_comms/messages.test.mjs`
- Create: `tests/tools/agent_comms/attachments.test.mjs`

**Interfaces:**

- Consumes Task 1 storage/schema APIs and Task 2 open-registry checks.
- Produces `describeAttachment(context, input) -> Promise<AttachmentRecord>` and `verifyAttachment(context, record) -> Promise<void>`.
- Produces `sendMessage(context, input) -> Promise<MessageRecord>`.
- Produces `listInbox(context, input) -> Promise<Array<InboxItem>>` where each item is `{ message, state: "unseen" | "seen" }`.
- Produces `markSeen(context, message, recipient)`, `ackMessage(context, input)`, `replyToMessage(context, input)`, and `broadcastMessage(context, input)`.
- `context.randomUUID()` is injected for deterministic unit tests and uses `crypto.randomUUID` in production.

- [ ] **Step 1: Write message state-machine and concurrency tests**

```js
test("seen is delivery, ack is completion", async () => {
  const message = await sendMessage(context, requestFromVisualToModels);
  await markSeen(context, message, "models");
  assert.equal((await listInbox(context, { agentId: "models" }))[0].state, "seen");
  await ackMessage(context, { agentId: "models", messageId: message.id });
  assert.equal((await listInbox(context, { agentId: "models" })).length, 0);
  assert.equal(await exists(context.paths.ackFile(message.id, "models")), true);
  assert.equal(await exists(context.paths.archiveFile("models", message.id)), true);
});

test("one hundred parallel senders lose no messages", async () => {
  await Promise.all(Array.from({ length: 100 }, (_, index) =>
    sendMessage(contextFor(index), messageInput(index))));
  const inbox = await listInbox(context, { agentId: "models" });
  assert.equal(inbox.length, 100);
  assert.equal(new Set(inbox.map(item => item.message.id)).size, 100);
});
```

Also cover unregistered sender, unknown recipient, filters, stdin/body-file equivalence at the API boundary, reply linkage, sender-visible ack, separate broadcast copies, inactive recipients excluded from broadcast, per-recipient broadcast acknowledgement, and an ack record left in inbox after a simulated crash.

Write attachment tests proving that a repo-relative committed file and a file inside `.agents/artifacts` receive the actual SHA-256 and byte size, while an absolute external path, `../` escape, missing file, mismatched checksum, and ephemeral attachment with a commit SHA are rejected.

- [ ] **Step 2: Run message tests and capture the RED**

Run: `node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs`

Expected: exit `1` with missing message exports.

- [ ] **Step 3: Implement immutable message delivery**

```js
export async function sendMessage(context, input) {
  await requireOpenAgent(context, input.from);
  await requireOpenAgent(context, input.to);
  const message = validateMessage(buildMessage(context, input));
  await writeJsonAtomic(context.paths.inboxFile(input.to, message.id), message, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  return message;
}
```

Message ids use the compact UTC timestamp, sender id, and full UUID. `markSeen` and acknowledgement records are immutable exclusive writes. `ackMessage` writes the ack first and then moves the message; if the ack already exists it still completes the move. `listInbox` excludes acked messages even if a crash left their source files in inbox. Broadcast snapshots active recipients and calls the same delivery primitive once per recipient.

`describeAttachment()` resolves symlinks before applying allowed-root checks, streams the file through `createHash("sha256")`, reads byte size from `stat`, and returns normalized paths only. `verifyAttachment()` recomputes both values rather than trusting caller input.

- [ ] **Step 4: Run concurrency and lifecycle GREEN**

Run: `node --test tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs`

Expected: 100 unique messages, all state-machine cases pass, exit `0`.

- [ ] **Step 5: Commit messaging**

```bash
git add tools/agents/lib/attachments.mjs tools/agents/lib/messages.mjs tests/tools/agent_comms/attachments.test.mjs tests/tools/agent_comms/messages.test.mjs
git commit -m "feat: add acknowledged agent messaging"
```

---

### Task 4: Presence heartbeat, watcher, and dormant wait

**Files:**

- Create: `tools/agents/lib/presence.mjs`
- Create: `tests/tools/agent_comms/presence.test.mjs`

**Interfaces:**

- Consumes registry checks, message listing/seen receipts, schemas, and atomic storage.
- Produces `presenceState(record, now, pidIsAlive) -> "online" | "stale" | "offline"`.
- Produces `startWatcher(context, input) -> Promise<{ stop: () => Promise<void>, done: Promise<void> }>`; `context.extendOwnedClaims` is an injected no-op until Task 5 is wired by Task 8.
- Produces `waitForMessage(context, input) -> Promise<MessageRecord | null>`; `null` maps to exit code `3` in the CLI.
- Watcher output callback receives one validated object `{ event: "message", message, state: "unseen" }` per message id.

- [ ] **Step 1: Write deterministic presence and watcher tests**

```js
test("heartbeat transitions online to stale to offline", () => {
  const record = presenceAt("2026-08-14T18:00:00.000Z", 42, "online");
  assert.equal(presenceState(record, instant(44), () => true), "online");
  assert.equal(presenceState(record, instant(46), () => true), "stale");
  assert.equal(presenceState(record, instant(46), () => false), "offline");
});

test("wait distinguishes delivery from timeout", async () => {
  assert.equal(await waitForMessage(fastContext, { agentId: "visual", timeoutMs: 5 }), null);
  const pending = waitForMessage(fastContext, { agentId: "visual", timeoutMs: 100 });
  await sendMessage(fastContext, messageToVisual);
  assert.equal((await pending).subject, messageToVisual.subject);
});
```

Also test rejection of a second live watcher, immediate scan before filesystem events, 2-second fallback scanning through an injected scheduler, one print per process, restart behavior for unseen versus seen-but-unacked, heartbeat writes every 15 seconds, claim extension callback, and offline write on `stop()`.

- [ ] **Step 2: Run presence tests and capture the RED**

Run: `node --test tests/tools/agent_comms/presence.test.mjs`

Expected: exit `1` with missing presence exports.

- [ ] **Step 3: Implement watcher and wait without relying solely on `fs.watch`**

```js
export function presenceState(record, now, pidIsAlive) {
  if (record.status === "offline" || !pidIsAlive(record.pid)) return "offline";
  return now.getTime() - Date.parse(record.heartbeat_at) > 45_000 ? "stale" : "online";
}
```

`startWatcher()` must acquire the id by writing presence with watcher PID, perform an immediate scan, use both `fs.watch` and a 2-second interval, update heartbeat every 15 seconds, extend owned claims on heartbeat, write one complete JSONL object plus `\u0007`, then create the seen receipt. It never acknowledges a message. Signal handling is installed by the executable entry point, which awaits `stop()` before exit.

- [ ] **Step 4: Demonstrate stale required presence in the focused tests**

Advance the fake clock beyond 45 seconds while the recorded PID remains live and assert the state is `stale`. Restore the clock fixture and run:

`node --test tests/tools/agent_comms/presence.test.mjs`

Expected: all presence tests pass and exit `0`.

- [ ] **Step 5: Commit presence**

```bash
git add tools/agents/lib/presence.mjs tests/tools/agent_comms/presence.test.mjs
git commit -m "feat: add agent presence watcher"
```

---

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

### Task 6: Evidence-bearing handoffs

**Files:**

- Create: `tools/agents/lib/handoff.mjs`
- Create: `tests/tools/agent_comms/handoff.test.mjs`

**Interfaces:**

- Produces `createHandoff(context, input) -> Promise<{ record, message }>`.
- Required committed input is `{ from, to, task, result, branch, commit, base, changedPaths, verification, contracts, followUp, artifacts, limitations, uncommitted: false }`.
- Verification entries are `{ command, exitCode, summary }`; artifacts reuse the strict attachment schema.

- [ ] **Step 1: Write handoff validation tests**

```js
test("committed handoff requires branch, commit, base, paths, and verification", async () => {
  await assert.rejects(
    createHandoff(context, { ...validHandoff, verification: [] }),
    error => error.exitCode === EXIT.DATA && error.message.includes("verification"),
  );
});

test("uncommitted handoff is never ready to merge", async () => {
  const { record } = await createHandoff(context, { ...validHandoff, commit: null, uncommitted: true });
  assert.equal(record.ready_to_merge, false);
  assert.equal(record.state, "UNCOMMITTED");
});
```

Cover commit/base as full 40-character hexadecimal SHA values, repo-relative changed paths, per-artifact checksum/size, follow-up agent ids, immutable handoff record, and typed `handoff` message requiring acknowledgement.

- [ ] **Step 2: Run handoff tests and capture the RED**

Run: `node --test tests/tools/agent_comms/handoff.test.mjs`

Expected: exit `1` with missing handoff export.

- [ ] **Step 3: Implement handoff record plus addressed message**

```js
export async function createHandoff(context, input) {
  const record = validateHandoff(buildHandoff(context, input));
  await writeJsonAtomic(context.paths.handoffFile(record.id), record, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  const message = await sendMessage(context, handoffMessage(record));
  return { record, message };
}
```

The message body summarizes result, commit state, verification, and limitations; its `attachments` match the record. A committed handoff with any failed verification may exist, but `ready_to_merge` must be false.

- [ ] **Step 4: Demonstrate the evidence gate and restore GREEN**

Run the missing-verification case and retain its asserted exit code `4`. Then run:

`node --test tests/tools/agent_comms/handoff.test.mjs`

Expected: all handoff tests pass and exit `0`.

- [ ] **Step 5: Commit handoffs**

```bash
git add tools/agents/lib/handoff.mjs tests/tools/agent_comms/handoff.test.mjs
git commit -m "feat: add evidence-bearing agent handoffs"
```

---

### Task 7: Orchestrator status, diagnostics, and safe repair

**Files:**

- Create: `tools/agents/lib/status.mjs`
- Create: `tests/tools/agent_comms/status.test.mjs`

**Interfaces:**

- Produces `collectStatus(context) -> Promise<StatusReport>`.
- Produces `runDoctor(context, input) -> Promise<DoctorReport>`.
- Produces `enforcementExit(report, options) -> 0 | 4 | 6`.
- `StatusReport` begins with `protocol: { schema_version: 1, protocol_version: 1, checkout_id }` and contains exact arrays and counts for live/stale/offline agents, unseen, seen-but-unacked, required-unacked, blockers, active/stale claims, and handoffs.
- `DoctorReport` is `{ ok, issues, repairs }`; each issue is `{ code, severity, path, message }`.

- [ ] **Step 1: Write status and doctor tests**

```js
test("seen required action stays pending until ack", async () => {
  const message = await seedRequiredAction(context);
  await markSeen(context, message, "models");
  const report = await collectStatus(context);
  assert.equal(report.counts.seen_but_unacked, 1);
  assert.equal(report.counts.required_unacked, 1);
});

test("doctor reports a corrupt message instead of skipping it", async () => {
  await writeFile(context.paths.inboxFile("models", "broken"), "{not-json");
  const report = await runDoctor(context, {});
  assert.equal(report.ok, false);
  assert.equal(report.issues[0].code, "CORRUPT_JSON");
});
```

Also cover `--require-live`, stale registry, pending blocker, informational unacked message not failing enforcement, acked-but-not-archived recovery, compatible init state, unknown protocol version, stale lock, quarantine only under repair, and immutable repair audit records.

- [ ] **Step 2: Run status tests and capture the RED**

Run: `node --test tests/tools/agent_comms/status.test.mjs`

Expected: exit `1` with missing status exports.

- [ ] **Step 3: Implement aggregation and narrowly scoped repair**

```js
export function enforcementExit(report, options) {
  if (options.failOnStale && report.agents.stale.length > 0) return EXIT.REQUIRED;
  if (options.failOnPending && report.messages.required_unacked.length > 0) return EXIT.REQUIRED;
  if (report.corrupt.length > 0) return EXIT.DATA;
  return EXIT.OK;
}
```

Normal doctor is read-only. Repair may only: finish archive moves already backed by acknowledgement, move corrupt JSON to quarantine with an audit record, and invoke the proven stale-lock repair. It never removes stale agents, claims, registry history, or an unknown protocol version.

- [ ] **Step 4: Demonstrate stale-required and corrupt-message failures**

Run the two focused fixtures through `enforcementExit`: stale required watcher must produce `6`; corrupt message must produce `4`. Retain both tests, restore valid fixture data, then run:

`node --test tests/tools/agent_comms/status.test.mjs`

Expected: all status tests pass and exit `0`.

- [ ] **Step 5: Commit status and doctor**

```bash
git add tools/agents/lib/status.mjs tests/tools/agent_comms/status.test.mjs
git commit -m "feat: add agent bus diagnostics"
```

---

### Task 8: Strict CLI and machine-readable output

**Files:**

- Create: `tools/agents/lib/args.mjs`
- Create: `tools/agents/comms.mjs`
- Modify: `tests/tools/agent_comms/helpers.mjs`
- Create: `tests/tools/agent_comms/args.test.mjs`
- Create: `tests/tools/agent_comms/integration.test.mjs`

**Interfaces:**

- `parseArgs(argv) -> { command, options }`; unknown commands/options and missing values throw usage exit `2`.
- `main(argv, runtime) -> Promise<number>` where runtime injects `cwd`, `env`, stdin, stdout, stderr, time, PID liveness, UUID, scheduler, and Git query.
- Human commands write only human text; `--json` writes exactly one JSON value; `watch` writes JSONL only.
- Repeated-value grammar is fixed: `register --ownership <scope>` may repeat; `send`/`reply` use exactly one of `--body`, `--body-file`, or stdin and may repeat `--attachment <repo-path>` or `--ephemeral-attachment <artifact-path>`; `handoff` repeats `--changed <path>`, `--follow-up <agent>`, and `--artifact <path>`, while structured verification/contracts and limitations are supplied by `--verification-file`, `--contracts-file`, and `--limitations-file`; `release --force-stale` also requires `--owner <agent>`.

- [ ] **Step 1: Write parser and black-box CLI tests for every currently implemented command and exit code**

```js
test("wait timeout exits three without stderr noise", async () => {
  const result = await runCli(fixture, ["wait", "--id", "visual", "--timeout", "0.01"]);
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "");
});

test("json status is one parseable value", async () => {
  const result = await runCli(fixture, ["status", "--json"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).protocol, { schema_version: 1 });
});

test("unknown options are usage errors", () => {
  assert.throws(
    () => parseArgs(["status", "--mystery"]),
    error => error.exitCode === EXIT.USAGE,
  );
});
```

Exercise `init`, `register`, `close`, `send` with body/body-file/stdin, `broadcast`, `inbox`, `ack`, `reply`, `watch`, `wait`, `claim`, `release`, `handoff`, `status`, and `doctor`. Assert exit codes `0`, `2`, `3`, `4`, `5`, and `6` through actual subprocesses. Verify `comms.mjs` is executable and its shebang is `#!/usr/bin/env node`. Task 9 adds and tests `prompt` after the committed template exists.

`release` accepts `--force-stale --owner <agent>` only when `--id` belongs to the registered orchestrator; ordinary release remains owner-only.

- [ ] **Step 2: Run black-box tests and capture the RED**

Run: `node --test tests/tools/agent_comms/integration.test.mjs`

Expected: exit `1` because the executable and parser do not exist.

- [ ] **Step 3: Implement strict parsing and thin dispatch**

```js
const COMMANDS = Object.freeze({
  init: runInit,
  register: runRegister,
  close: runClose,
  send: runSend,
  broadcast: runBroadcast,
  inbox: runInbox,
  ack: runAck,
  reply: runReply,
  watch: runWatch,
  wait: runWait,
  claim: runClaim,
  release: runRelease,
  handoff: runHandoff,
  status: runStatus,
  doctor: runDoctorCommand,
});
```

The executable catches only `CommsError`, prints its message to stderr, and returns its stable exit code; unexpected exceptions print a stack and return `1`. It discovers bus paths once and passes a shared context to command modules. `SIGINT` and `SIGTERM` call the active watcher's async `stop()` before process exit.

- [ ] **Step 4: Run complete protocol tests GREEN**

Run: `node --test tests/tools/agent_comms/*.test.mjs`

Expected: all protocol tests pass and exit `0`.

- [ ] **Step 5: Commit executable CLI**

```bash
git add tools/agents/comms.mjs tools/agents/lib/args.mjs tests/tools/agent_comms/helpers.mjs tests/tools/agent_comms/args.test.mjs tests/tools/agent_comms/integration.test.mjs
git commit -m "feat: expose agent communication CLI"
```

---

### Task 9: Canonical bootstrap prompt and operator documentation

**Files:**

- Create: `tools/agents/lib/prompt.mjs`
- Create: `tests/tools/agent_comms/prompt.test.mjs`
- Create: `docs/AGENT_COMMS.md`
- Create: `docs/AGENT_COMMS_PROMPT.md`
- Modify: `AGENTS.md`
- Modify: `.gitignore`
- Modify: `tools/agents/comms.mjs`

**Interfaces:**

- Produces `renderPrompt({ templatePath, agentId, role, task, ownership }) -> Promise<string>`.
- Template contains exactly `<AGENT_ID>`, `<ROLE>`, `<TASK>`, and `<OWNERSHIP>` as replaceable tokens.
- CLI command is `node tools/agents/comms.mjs prompt --id visual --role visual --task M2.7 --ownership game/presentation`.

- [ ] **Step 1: Write prompt contract tests**

```js
test("rendered prompt is the committed template with literal substitutions", async () => {
  const template = await readFile(templatePath, "utf8");
  const rendered = await renderPrompt({
    templatePath,
    agentId: "visual-m2-7",
    role: "visual",
    task: "M2.7",
    ownership: "game/presentation",
  });
  const expected = template
    .replaceAll("<AGENT_ID>", "visual-m2-7")
    .replaceAll("<ROLE>", "visual")
    .replaceAll("<TASK>", "M2.7")
    .replaceAll("<OWNERSHIP>", "game/presentation");
  assert.equal(rendered, expected);
});
```

Assert the rendered prompt contains all eight polling checkpoints, refuses work after failed register/watcher startup, requires peer acknowledgement before shared-contract edits, requires replies and acknowledgements for action/blocker messages, and requires handoff plus close even when blocked.

- [ ] **Step 2: Run prompt tests and capture the RED**

Run: `node --test tests/tools/agent_comms/prompt.test.mjs`

Expected: exit `1` because template and renderer do not exist.

- [ ] **Step 3: Write the canonical prompt and operational guide**

The prompt must tell an agent to execute this lifecycle with its substituted values:

```bash
node tools/agents/comms.mjs init
node tools/agents/comms.mjs register --id <AGENT_ID> --role <ROLE> --task <TASK> --ownership <OWNERSHIP>
node tools/agents/comms.mjs inbox --id <AGENT_ID>
node tools/agents/comms.mjs watch --id <AGENT_ID>
```

It explicitly says the blocking watcher runs in a dedicated long-lived terminal/process whose output remains visible to the agent. It then states the checkpoint polls, the host limitation that watcher output may not interrupt an active reasoning turn, claim-before-edit rule, `reply`/`ack` distinction, handoff evidence requirements, and orderly watcher stop followed by `close`.

`docs/AGENT_COMMS.md` must document discovery, lifecycle, every CLI command, message states, status categories, claims, handoffs, stable exit codes, plaintext/security boundary, stale thresholds, corruption/repair behavior, host push limitation, and the separate-CI rollout.

- [ ] **Step 4: Implement literal template rendering and wire `prompt`**

```js
export async function renderPrompt(input) {
  const template = await readFile(input.templatePath, "utf8");
  return template
    .replaceAll("<AGENT_ID>", input.agentId)
    .replaceAll("<ROLE>", input.role)
    .replaceAll("<TASK>", input.task)
    .replaceAll("<OWNERSHIP>", input.ownership);
}
```

Reject values containing a NUL byte. Validate the id with the shared schema. Keep the template as the sole source of prompt prose.

Add `prompt: runPrompt` to the executable's command map and add a black-box case proving stdout equals `renderPrompt()` exactly and stderr is empty.

- [ ] **Step 5: Add mandatory bootstrap to `AGENTS.md` and ignore runtime state**

Add an early section named `Локальний протокол зв'язку агентів` that requires reading `docs/AGENT_COMMS.md`, generating or following the canonical prompt, registering, polling at the documented checkpoints, respecting claims, and closing presence. State that inability to start the protocol is a blocker for local parallel-agent work, but does not apply to a solitary read-only session.

Add exactly this ignore entry near other project-local state:

```gitignore
# Спільна локальна mailbox-шина агентів; transport state ніколи не комітиться.
.agents/
```

- [ ] **Step 6: Run prompt and documentation contract tests GREEN**

Run: `node --test tests/tools/agent_comms/prompt.test.mjs tests/tools/agent_comms/integration.test.mjs`

Expected: prompt is byte-for-byte derived from the committed template, bootstrap checkpoints are present, CLI command passes, exit `0`.

- [ ] **Step 7: Prove `.agents/` is ignored from main and linked worktree contexts**

Run from the task worktree:

```bash
git check-ignore -v ../../.agents/protocol.json
git status --short
```

Run from the main checkout:

```bash
git check-ignore -v .agents/protocol.json
git status --short
```

Expected: both paths resolve to the new `.agents/` rule; runtime records do not appear in status. Existing unrelated status in main must be reported, not changed.

- [ ] **Step 8: Commit prompt, docs, and bootstrap**

```bash
git add tools/agents/lib/prompt.mjs tools/agents/comms.mjs tests/tools/agent_comms/prompt.test.mjs docs/AGENT_COMMS.md docs/AGENT_COMMS_PROMPT.md AGENTS.md .gitignore
git commit -m "docs: require local agent communication"
```

---

### Task 10: Live multi-agent acceptance and primary PR

**Files:**

- Modify only if a verified defect is found: files already introduced by Tasks 1–9.
- Create runtime evidence only under ignored `.agents/artifacts/`; do not stage it.

**Interfaces:**

- Validates the public CLI as a user or independent agent will invoke it.
- Produces no committed runtime state and no `.github/workflows/` changes.

- [ ] **Step 1: Run static and focused verification**

```bash
node --check tools/agents/comms.mjs
node --test tests/tools/agent_comms/*.test.mjs
git diff --check main...HEAD
```

Expected: all commands exit `0` and every protocol test file executes.

- [ ] **Step 2: Demonstrate the required live failures through the executable**

Using a fresh temp bus via `PW2_AGENT_BUS_DIR`, demonstrate and retain command/output excerpts for:

1. malformed inbox JSON → `doctor` exit `4`;
2. overlapping claim by a second agent → `claim` exit `5`;
3. required watcher older than 45 seconds → `doctor --require-live visual` exit `6`;
4. handoff without verification evidence → `handoff` exit `4`.

Remove only the exact temporary fixture after each demonstration. Do not mutate source to fake a RED.

- [ ] **Step 3: Run cross-worktree live acceptance**

Initialize the real ignored bus once, then invoke the branch CLI with `cwd` in the main checkout and in this linked worktree. Register `orchestrator-probe`, `visual-probe`, `models-probe`, and `physics-probe` with distinct tasks and ownership scopes. Start watchers for all four and verify `status --json` reports them online.

Send a `contract_request` from `visual-probe` to `models-probe`, observe one watcher JSONL event, reply from `models-probe`, acknowledge the request, and verify the sender-visible acknowledgement. Claim `game/presentation` as `visual-probe`, prove `models-probe` cannot claim `game/presentation/camera`, then release it. Create a committed-form handoff with a real branch/base SHA and passing verification summary. Stop watchers, close all four probe identities, and verify their status is offline with no active claims.

- [ ] **Step 4: Verify existing project gates remain green**

```bash
gdformat --check game/ tests/ content/
gdlint game/ tests/ content/
./tools/ci/check_gdscript.sh game tests content
./tools/ci/run_tests.sh tests/
./tools/ci/check_sim_invariants.sh game/sim
```

Expected: formatting/lint/static/invariant commands exit `0`; gdUnit wrapper executes every declared suite and case with zero failures.

- [ ] **Step 5: Audit scope, structure, and cleanliness**

```bash
find tools/agents/lib -name '*.mjs' -print0 | xargs -0 wc -l
git diff --name-only main...HEAD
git diff --check main...HEAD
git status --short
```

Expected: every runtime module is below 300 lines; only the file map declared in this plan changed; diff check is clean; task worktree is clean; `.agents/` is absent from tracked and untracked status.

- [ ] **Step 6: Request two-stage review and fix verified findings**

Use `superpowers:requesting-code-review`. First reviewer checks exact conformance to the approved design and this plan. Second reviewer checks implementation quality, race safety, recovery semantics, tests, and documentation. For every accepted finding, reproduce the defect before changing code, add or strengthen a failing test, implement the narrow correction, and rerun the focused plus full protocol suites.

- [ ] **Step 7: Push the primary branch**

```bash
git push -u origin ops/agent-comms-protocol
```

Expected: pre-push gates pass and the branch is published without modifying `main`.

- [ ] **Step 8: Open the primary PR**

Create a PR whose description includes:

- task name `OPS — local agent communication protocol`;
- concise user-facing behavior;
- each acceptance criterion with command evidence;
- protocol-test and existing Godot-suite summaries;
- the four demonstrated RED failures and their exit codes;
- cross-worktree live acceptance result;
- statement that `.agents/` contains local plaintext transport state and is ignored;
- explicit note that CI wiring is deferred to the required post-merge shared-file micro-PR.

End the handoff with the PR link. Do not merge it.

---

## Post-Merge Follow-up Boundary

After the user merges the primary PR, create a new branch and new plan for one shared-file micro-PR that modifies only `.github/workflows/ci.yml` (and a directly necessary CI test script if the existing workflow cannot count Node tests reliably). Its gate must invoke `node --test tests/tools/agent_comms/*.test.mjs`, prove a deliberately failing Node test makes CI non-zero, and leave all existing Godot checks intact. Do not begin that micro-PR from this branch.

## Execution amendment — accepted review support files

This amendment reconciles the original per-task `Create`/`Modify` lists with
the files added during the plan's mandatory review-and-fix rounds. It changes
no behavioral requirement, interface, acceptance criterion, or rollout
boundary. The additional files remain within the original
`tools/agents/lib/` runtime and `tests/tools/agent_comms/` test ownership map.

Runtime support files introduced to keep each module below 300 lines while
isolating accepted race-safety, integrity, recovery, and lifecycle fixes:

- Create: `tools/agents/lib/claim-records.mjs` — strict claim record loading,
  digest binding, and duplicate-scope validation extracted from claims.
- Create: `tools/agents/lib/doctor-protocol.mjs` — protocol-version diagnosis
  separated from repair orchestration.
- Create: `tools/agents/lib/doctor-storage.mjs` — exhaustive storage inventory
  and corrupt-record classification separated from status presentation.
- Create: `tools/agents/lib/repair-mutex.mjs` — crash-recoverable, audited
  repair mutex ownership and stale-generation handling.
- Create: `tools/agents/lib/safe-file.mjs` — no-follow regular-file reads used
  by accepted symlink and swap-race fixes.
- Create: `tools/agents/lib/signal-stop.mjs` — latched SIGINT/SIGTERM watcher
  shutdown separated from CLI dispatch.
- Create: `tools/agents/lib/status-locks.mjs` — watcher/doctor lock
  classification separated from the status aggregate.
- Create: `tools/agents/lib/watcher-ownership.mjs` — atomic lifetime watcher
  ownership and generation-safe release separated from presence delivery.

Regression files added for the accepted TDD review findings and kept separate
by concern rather than growing the original suites past the structure ceiling:

- Create: `tests/tools/agent_comms/claims-integrity.test.mjs`
- Create: `tests/tools/agent_comms/cli-round1.test.mjs`
- Create: `tests/tools/agent_comms/doctor-race.test.mjs`
- Create: `tests/tools/agent_comms/repair-mutex.test.mjs`
- Create: `tests/tools/agent_comms/status-review.test.mjs`
- Create: `tests/tools/agent_comms/status-round2.test.mjs`
- Create: `tests/tools/agent_comms/status-round3.test.mjs`
- Create: `tests/tools/agent_comms/status-round4.test.mjs`
