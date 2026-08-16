import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  ackMessage,
  listInbox,
  replyToMessage,
  sendMessage,
} from "../../../tools/agents/lib/messages.mjs";
import {
  createMessagingFixture,
  messageRequest,
  pathExists,
  replyRequest,
} from "./helpers.mjs";

test("inbox records are bound to their filename", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const canonical = context.paths.inboxFile("models", message.id);
  const alias = context.paths.inboxFile("models", `${message.id}-alias`);
  await rename(canonical, alias);

  await assert.rejects(
    listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("archived records are bound to recipient directory and filename", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const aliasId = `${message.id}-alias`;
  const alias = context.paths.archiveFile("models", aliasId);
  await mkdir(context.paths.archiveDir("models"), { recursive: true });
  await rename(context.paths.inboxFile("models", message.id), alias);

  await assert.rejects(
    ackMessage(context, { agentId: "models", messageId: aliasId }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("archived records cannot claim a different recipient directory", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const misplaced = context.paths.archiveFile("visual", message.id);
  await mkdir(context.paths.archiveDir("visual"), { recursive: true });
  await rename(context.paths.inboxFile("models", message.id), misplaced);

  await assert.rejects(
    ackMessage(context, { agentId: "visual", messageId: message.id }),
    error => error.exitCode === EXIT.DATA,
  );
});

test("acknowledgement rejects a symlinked inbox record without publishing a receipt", async t => {
  const { context, root } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const backing = path.join(root, "backing-message.json");
  await rename(inboxPath, backing);
  await symlink(backing, inboxPath);

  await assert.rejects(
    ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await pathExists(context.paths.ackFile(message.id, "models")), false);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), false);
});

async function replaceRecipientDirectory(directory, external) {
  await mkdir(external);
  await rm(directory, { recursive: true });
  await symlink(external, directory);
}

test("inbox listing rejects a recipient directory replaced by a symlink", async t => {
  const { context, root } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const bytes = await readFile(inboxPath);
  const external = path.join(root, "external-inbox-list");
  await replaceRecipientDirectory(context.paths.inboxDir("models"), external);
  const externalFile = path.join(external, `${message.id}.json`);
  await writeFile(externalFile, bytes);

  await assert.rejects(
    listInbox(context, { agentId: "models" }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readFile(externalFile), bytes);
});

test("ack rejects a symlinked inbox parent without mutating external state", async t => {
  const { context, root } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const bytes = await readFile(inboxPath);
  const external = path.join(root, "external-inbox-ack");
  await replaceRecipientDirectory(context.paths.inboxDir("models"), external);
  const externalFile = path.join(external, `${message.id}.json`);
  await writeFile(externalFile, bytes);

  await assert.rejects(
    ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readFile(externalFile), bytes);
  assert.equal(await pathExists(context.paths.ackFile(message.id, "models")), false);
  assert.equal(await pathExists(context.paths.archiveFile("models", message.id)), false);
});

test("ack rejects a symlinked archive parent without publishing a receipt", async t => {
  const { context, root } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const bytes = await readFile(inboxPath);
  const external = path.join(root, "external-archive-ack");
  await mkdir(external);
  const externalFile = path.join(external, `${message.id}.json`);
  await rename(inboxPath, externalFile);
  await symlink(external, context.paths.archiveDir("models"));

  await assert.rejects(
    ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.deepEqual(await readFile(externalFile), bytes);
  assert.equal(await pathExists(context.paths.ackFile(message.id, "models")), false);
});

test("acknowledgement never overwrites conflicting archive evidence", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const archivePath = context.paths.archiveFile("models", message.id);
  const conflicting = `${JSON.stringify({ ...message, body: "conflicting evidence" }, null, 2)}\n`;
  await mkdir(context.paths.archiveDir("models"), { recursive: true });
  await writeFile(archivePath, conflicting);

  await assert.rejects(
    ackMessage(context, { agentId: "models", messageId: message.id }),
    error => error.exitCode === EXIT.DATA,
  );
  assert.equal(await pathExists(inboxPath), true);
  assert.equal(await readFile(archivePath, "utf8"), conflicting);
});

test("acknowledgement accepts only a byte-identical existing archive", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const archivePath = context.paths.archiveFile("models", message.id);
  const original = await readFile(inboxPath);
  await mkdir(context.paths.archiveDir("models"), { recursive: true });
  await writeFile(archivePath, original);

  await ackMessage(context, { agentId: "models", messageId: message.id });

  assert.equal(await pathExists(inboxPath), false);
  assert.deepEqual(await readFile(archivePath), original);
});

test("concurrent acknowledgements finish one immutable archive", async t => {
  const { context } = await createMessagingFixture(t);
  const message = await sendMessage(context, messageRequest());
  const inboxPath = context.paths.inboxFile("models", message.id);
  const archivePath = context.paths.archiveFile("models", message.id);
  const original = await readFile(inboxPath);

  const acknowledgements = await Promise.all(Array.from({ length: 12 }, () =>
    ackMessage(context, { agentId: "models", messageId: message.id })));

  assert.ok(acknowledgements.every(value => value.message_id === message.id));
  assert.equal(await pathExists(inboxPath), false);
  assert.deepEqual(await readFile(archivePath), original);
});

test("message commands reject control and path-hostile ids as data", async t => {
  const { context } = await createMessagingFixture(t);
  for (const messageId of ["bad\0id", "bad\nid", "colon:id", "..", "trailing."]) {
    await assert.rejects(
      ackMessage(context, { agentId: "models", messageId }),
      error => error.exitCode === EXIT.DATA,
    );
    await assert.rejects(
      replyToMessage(context, replyRequest(messageId)),
      error => error.exitCode === EXIT.DATA,
    );
  }
});
