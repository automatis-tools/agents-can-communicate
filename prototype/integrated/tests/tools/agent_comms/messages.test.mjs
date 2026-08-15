import assert from "node:assert/strict";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { describeAttachment } from "../../../tools/agents/lib/attachments.mjs";
import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  ackMessage, broadcastMessage, listInbox, markSeen, replyToMessage, sendMessage,
} from "../../../tools/agents/lib/messages.mjs";
import {
  validateAcknowledgement,
  validateSeenReceipt,
} from "../../../tools/agents/lib/schema.mjs";
import {
  broadcastRequest,
  createMessagingFixture,
  messageRequest,
  messageUuid,
  pathExists,
  replyRequest,
  seedAcknowledgement,
  seedSeenReceipt,
} from "./helpers.mjs";

test("sent message has compact timestamp, sender head, and full UUID", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  assert.equal(message.id, `20260814T180000.000Z-visual-${messageUuid(1)}`);
  assert.equal(message.sender_head, "a".repeat(40));
  assert.equal(message.reply_to, null);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
});

test("unregistered sender and unknown recipient are rejected before delivery", async t => {
  const { context } = await createMessagingFixture(t);
  await assert.rejects(sendMessage(context, messageRequest({ from: "unknown" })),
    error => error.exitCode === EXIT.CONFLICT);
  await assert.rejects(sendMessage(context, messageRequest({ to: "unknown" })),
    error => error.exitCode === EXIT.CONFLICT);
  assert.deepEqual(await listInbox(context, { agentId: "models" }), []);
});

test("body text, body file, and stdin produce equivalent message bodies", async t => {
  const { context, root } = await createMessagingFixture(t);
  const body = "Line one\nLine two — shell-safe.\n";
  const bodyFile = path.join(root, "message.txt");
  await writeFile(bodyFile, body);
  const direct = await sendMessage(context, messageRequest({ body }));
  const fromFile = await sendMessage(context, messageRequest({ body: undefined, bodyFile }));
  const fromStdin = await sendMessage(context, messageRequest({ body: undefined, stdin: body }));
  assert.deepEqual([direct.body, fromFile.body, fromStdin.body], [body, body, body]);
});

test("inbox filters by type and severity without changing stored messages", async t => {
  const { context } = await createMessagingFixture(t);
  await sendMessage(context, messageRequest({ type: "question", severity: "info" }));
  await sendMessage(context, messageRequest({ type: "blocker", severity: "blocker" }));
  await sendMessage(context, messageRequest({ type: "status", severity: "info" }));
  const questions = await listInbox(context, { agentId: "models", types: ["question"] });
  const blockers = await listInbox(context, { agentId: "models", severities: ["blocker"] });
  assert.deepEqual(questions.map(item => item.message.type), ["question"]);
  assert.deepEqual(blockers.map(item => item.message.type), ["blocker"]);
  assert.equal((await listInbox(context, { agentId: "models" })).length, 3);
});

test("seen is delivery while acknowledgement is completion", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await markSeen(context, message, "models");
  assert.equal((await listInbox(context, { agentId: "models" }))[0].state, "seen");
  const ack = await ackMessage(context, { agentId: "models", messageId: message.id });
  assert.deepEqual(await listInbox(context, { agentId: "models" }), []);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), true);
  const stored = JSON.parse(await readFile(context.paths.ackFile(message.id, "models"), "utf8"));
  assert.deepEqual(validateAcknowledgement(stored), ack);
});

test("reply is a new message linked to the original", async t => {
  const { context } = await createMessagingFixture(t);
  const original = await sendMessage(context, messageRequest());
  const reply = await replyToMessage(context, replyRequest(original.id));
  assert.equal(reply.to, "visual");
  assert.equal(reply.reply_to, original.id);
  assert.equal((await listInbox(context, { agentId: "visual" }))[0].message.id, reply.id);
});

test("one hundred parallel sends lose no messages", async t => {
  const { context } = await createMessagingFixture(t);
  await Promise.all(Array.from({ length: 100 }, (_, index) => sendMessage(
    { ...context, randomUUID: () => messageUuid(index + 1) },
    messageRequest({ subject: `Message ${index}` }),
  )));
  const inbox = await listInbox(context, { agentId: "models" });
  assert.equal(inbox.length, 100);
  assert.equal(new Set(inbox.map(item => item.message.id)).size, 100);
});

test("message files are immutable exclusive records", async t => {
  const { context } = await createMessagingFixture(t, { randomUUID: () => messageUuid(1) });
  await sendMessage(context, messageRequest());
  await assert.rejects(sendMessage(context, messageRequest({ body: "replacement" })),
    error => error.exitCode === EXIT.CONFLICT);
  assert.equal((await listInbox(context, { agentId: "models" }))[0].message.body,
    messageRequest().body);
});

test("broadcast snapshots active peers into separate addressed copies", async t => {
  const { context } = await createMessagingFixture(t, {
    agentIds: ["visual", "models", "physics", "inactive"],
    listActiveAgentIds: async () => ["visual", "models", "physics"],
  });
  const copies = await broadcastMessage(context, broadcastRequest());
  assert.deepEqual(copies.map(message => message.to), ["models", "physics"]);
  assert.equal(new Set(copies.map(message => message.id)).size, 2);
  assert.equal((await listInbox(context, { agentId: "models" })).length, 1);
  assert.equal((await listInbox(context, { agentId: "physics" })).length, 1);
  assert.equal((await listInbox(context, { agentId: "inactive" })).length, 0);
  assert.equal((await listInbox(context, { agentId: "visual" })).length, 0);
});

test("broadcast acknowledgement is independent for each recipient", async t => {
  const { context } = await createMessagingFixture(t, {
    agentIds: ["visual", "models", "physics"],
    listActiveAgentIds: async () => ["models", "physics"],
  });
  const copies = await broadcastMessage(context, broadcastRequest());
  const modelsCopy = copies.find(message => message.to === "models");
  await ackMessage(context, { agentId: "models", messageId: modelsCopy.id });
  assert.equal((await listInbox(context, { agentId: "models" })).length, 0);
  assert.equal((await listInbox(context, { agentId: "physics" })).length, 1);
});

test("acknowledgement written before a crash hides work and resumes archive", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const ack = await seedAcknowledgement(context, message);
  assert.deepEqual(await listInbox(context, { agentId: "models" }), []);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
  assert.deepEqual(await ackMessage(context, { agentId: "models", messageId: message.id }), ack);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), false);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), true);
});

test("send rejects a structurally valid attachment whose file is missing", async t => {
  const { context } = await createMessagingFixture(t);
  const missing = { path: "docs/missing.txt", sha256: "0".repeat(64), size: 10,
    ephemeral: false };
  await assert.rejects(sendMessage(context, messageRequest({ attachments: [missing] })),
    error => error.exitCode === EXIT.DATA);
  assert.deepEqual(await listInbox(context, { agentId: "models" }), []);
});

test("reply rejects an attachment symlink outside the repository", async t => {
  const { context, repo, root } = await createMessagingFixture(t);
  const original = await sendMessage(context, messageRequest());
  const external = path.join(root, "external.txt");
  await writeFile(external, "outside\n");
  await symlink(external, path.join(repo, "linked.txt"));
  const linked = { path: "linked.txt", sha256: "0".repeat(64), size: 8, ephemeral: false };
  await assert.rejects(replyToMessage(context, replyRequest(original.id,
    { attachments: [linked] })), error => error.exitCode === EXIT.DATA);
  assert.deepEqual(await listInbox(context, { agentId: "visual" }), []);
});

test("broadcast rejects stale attachment evidence before delivery", async t => {
  const { context, repo } = await createMessagingFixture(t, {
    agentIds: ["visual", "models", "physics"],
    listActiveAgentIds: async () => ["models", "physics"],
  });
  const evidencePath = path.join(repo, "evidence.txt");
  await writeFile(evidencePath, "evidence\n");
  const stale = await describeAttachment(context, { path: "evidence.txt", ephemeral: false });
  await writeFile(evidencePath, "changed evidence\n");
  await assert.rejects(broadcastMessage(context, broadcastRequest({ attachments: [stale] })),
    error => error.exitCode === EXIT.DATA);
  assert.deepEqual(await listInbox(context, { agentId: "models" }), []);
  assert.deepEqual(await listInbox(context, { agentId: "physics" }), []);
});

test("markSeen rejects a fabricated or altered message", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const fabricated = { ...message, id: `${message.id}-fabricated` };
  await assert.rejects(markSeen(context, { ...message, body: "altered" }, "models"),
    error => error.exitCode === EXIT.DATA);
  await assert.rejects(markSeen(context, fabricated, "models"),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await pathExists(context.paths.seenFile(message.id, "models")), false);
  assert.equal(await pathExists(context.paths.seenFile(fabricated.id, "models")), false);
});

test("markSeen is idempotent for concurrent delivery of one persisted message", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const receipts = await Promise.all([
    markSeen(context, message, "models"),
    markSeen(context, message, "models"),
  ]);
  const stored = JSON.parse(
    await readFile(context.paths.seenFile(message.id, "models"), "utf8"),
  );
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(validateSeenReceipt(stored), receipts[0]);
});

test("markSeen rejects an existing receipt for another recipient", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await seedSeenReceipt(context, message, { recipient: "visual" });
  await assert.rejects(markSeen(context, message, "models"),
    error => error.exitCode === EXIT.DATA);
});

test("markSeen rejects a corrupt existing receipt", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await writeFile(context.paths.seenFile(message.id, "models"), "not-json\n");
  await assert.rejects(markSeen(context, message, "models"),
    error => error.exitCode === EXIT.DATA);
});

test("inbox rejects a seen receipt bound to another message", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await seedSeenReceipt(context, message, { message_id: `${message.id}-other` });
  await assert.rejects(listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA);
});

test("inbox rejects corrupt acknowledgement instead of hiding work", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await writeFile(context.paths.ackFile(message.id, "models"), "not-json\n");
  await assert.rejects(listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA);
});

test("inbox and ack reject acknowledgement bound to another message", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message, { message_id: `${message.id}-other` });
  await assert.rejects(listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA);
  await assert.rejects(ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
});

test("inbox rejects a seen receipt addressed to the wrong recipient", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await seedSeenReceipt(context, message, { recipient: "visual" });
  await assert.rejects(listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA);
});

test("inbox and ack reject acknowledgement addressed to the wrong recipient", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  await seedAcknowledgement(context, message, { recipient: "visual" });
  await assert.rejects(listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA);
  await assert.rejects(ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA);
  assert.equal(await pathExists(context.paths.inboxFile("models", message.id)), true);
});
