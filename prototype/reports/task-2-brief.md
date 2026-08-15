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
