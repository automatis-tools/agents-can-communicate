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
