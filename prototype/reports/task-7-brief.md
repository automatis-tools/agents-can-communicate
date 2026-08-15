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
