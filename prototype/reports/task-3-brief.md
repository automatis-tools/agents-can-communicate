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
