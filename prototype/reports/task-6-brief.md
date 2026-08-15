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
