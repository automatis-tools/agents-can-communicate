import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// A real installed hook process with a version-only client shim. This checks
// projection and receipts, not whether a native model notices the reminder.
test("an installed hook compacts a prior session's backlog without resolving it", async t => {
  const packed = await createPackedAcc(t);
  await packed.setClientVersions({ claude: "2.1.233", codex: "0.0.0" });
  const load = name => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", "index.mjs")));
  const [{ createCoordinationService }, { openFilesystemStore }, { createId },
    { discoverWorkspace, createGitProbe, runtimePaths }] = await Promise.all(
    ["core", "storage-filesystem", "protocol", "cli"].map(load));
  const descriptor = await discoverWorkspace({ cwd: packed.project, env: packed.env,
    gitProbe: createGitProbe({ env: packed.env }) });
  const clock = { now: () => "2026-08-01T12:00:00.000Z" };
  const ids = { next: kind => createId(kind, randomBytes) };
  const paths = runtimePaths({ dataHome: packed.dataHome, workspaceId: descriptor.id,
    workspaceRoots: descriptor.roots });
  const store = await openFilesystemStore({ root: paths.root, clock, ids,
    workspaceId: descriptor.id });
  const service = createCoordinationService({ store, clock, ids });
  const open = participantId => service.openSession({ participantId, harness: "cli",
    heartbeatCadenceMs: 30_000, descriptor, workspaceId: descriptor.id });
  const owner = session => ({ sessionId: session.sessionId, generation: session.generation });
  const reader = await open("reader");
  const sender = await open("sender");
  const oldIds = [];
  for (let i = 0; i < 60; i += 1) {
    const message = await service.sendMessage({ ...owner(sender), clientMessageId: `old-${i}`,
      toParticipantIds: ["reader"], kind: i < 40 ? "request" : "decision",
      obligation: i < 40 ? "reply" : "acknowledge", subject: `Earlier review ${i}`,
      body: `Original review request ${i}; still unresolved.` });
    oldIds.push(message.messageId);
    if (i % 2 === 0) await service.readInbox({ ...owner(reader), messageId: message.messageId });
    else await service.recordOfferSucceeded({ messageId: message.messageId,
      recipientParticipantId: "reader", targetSessionId: reader.sessionId,
      targetGeneration: reader.generation, transport: "next-turn",
      adapterId: "claude_code", clientVersion: "2.1.233" });
  }
  await service.closeSession(owner(reader));
  await service.closeSession(owner(sender));
  await packed.start({ adapterId: "claude_code", participantId: "reader",
    harnessSessionId: "native-reader" });
  const freshSender = await packed.acc(["attach", "--participant", "sender"]);
  const body = "CURRENT_DECISION: use port 4317 for the new integration; review this change.";
  const fresh = await packed.acc(["request", "--session", freshSender.sessionId,
    "--generation", freshSender.generation, "--to", "reader", "--title", "Current review",
    "--detail", body]);
  const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
  const before = await snapshot();
  const oldReceipts = state => state.receipts.filter(item => oldIds.includes(item.messageId));
  assert.equal(oldReceipts(before).filter(item => item.state === "offered").length, 30);
  assert.equal(oldReceipts(before).filter(item => item.state === "retrieved").length, 30);
  const turn = async () => {
    const output = await packed.beforeTurn({ adapterId: "claude_code",
      harnessSessionId: "native-reader" });
    assert.equal(output.stderr, "");
    return JSON.parse(output.stdout).hookSpecificOutput.additionalContext;
  };
  const first = await turn();
  assert.ok(first.includes(body), "old obligations displaced the fresh request's whole body");
  assert.match(first, /40 replies/);
  assert.match(first, /20 acknowledgements/);
  assert.ok(first.includes(`[reply_required] ${fresh.message.messageId}`),
    "a queued request is still an individual urgent item");
  assert.ok(Buffer.byteLength(first) < 1_000);
  for (let i = 0; i < 3; i += 1) {
    const context = await turn();
    assert.ok(Buffer.byteLength(context) < 400, "repeated context grew with the backlog");
    assert.match(context, /41 replies/);
    assert.match(context, /20 acknowledgements/);
    assert.match(context, /`acc inbox`/);
    assert.ok(!context.includes(body), "an offered body was offered again");
    assert.ok(oldIds.every(id => !context.includes(id)));
  }
  const after = await snapshot();
  assert.deepEqual(oldReceipts(after), oldReceipts(before));
  assert.equal(after.receipts.find(item => item.messageId === fresh.message.messageId).state,
    "offered", "a summary must neither retrieve nor acknowledge a message");
  const flags = /^ACC CLI \(append\): (--session \S+ --generation \S+)$/m.exec(first)[1]
    .split(" ");
  const status = await packed.acc(["status", ...flags]);
  assert.equal(status.attention.filter(item => ["reply_required", "acknowledgement_required"]
    .includes(item.kind)).length, 61);
  const inbox = await packed.acc(["inbox", ...flags]);
  assert.equal(inbox.length, 61);
  assert.equal(inbox.find(item => item.message.messageId === oldIds[0]).message.body,
    "Original review request 0; still unresolved.");
});
