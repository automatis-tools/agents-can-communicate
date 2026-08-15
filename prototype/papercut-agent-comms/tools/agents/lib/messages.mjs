import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

import { verifyAttachment } from "./attachments.mjs";
import {
  listJsonFiles,
  moveFileAtomic,
  readJsonStrict,
  writeJsonAtomic,
} from "./atomic-json.mjs";
import { CommsError, EXIT } from "./errors.mjs";
import { requireOpenAgent } from "./identity.mjs";
import {
  MESSAGE_TYPES,
  SEVERITIES,
  validateAcknowledgement,
  validateMessage,
  validateSeenReceipt,
} from "./schema.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function messageId(timestamp, sender, uuid) {
  return `${timestamp.replaceAll("-", "").replaceAll(":", "")}-${sender}-${uuid}`;
}

async function bodyFrom(input) {
  const sources = [input.body, input.bodyFile, input.stdin]
    .filter(value => value !== undefined);
  if (sources.length !== 1) {
    throw new CommsError("message requires exactly one body source", EXIT.DATA);
  }
  if (input.body !== undefined) return input.body;
  if (input.stdin !== undefined) return input.stdin;
  try {
    return await readFile(input.bodyFile, "utf8");
  } catch (error) {
    throw new CommsError("cannot read message body file", EXIT.DATA, {
      filePath: input.bodyFile,
      cause: error.message,
    });
  }
}

function buildMessage(context, input, sender, body) {
  const createdAt = context.now().toISOString();
  return {
    schema_version: 1,
    id: messageId(createdAt, input.from, (context.randomUUID ?? randomUUID)()),
    from: input.from,
    to: input.to,
    type: input.type,
    severity: input.severity,
    subject: input.subject,
    body,
    task: input.task ?? sender.task,
    reply_to: input.replyTo ?? null,
    requires_ack: input.requiresAck ?? false,
    created_at: createdAt,
    sender_head: sender.head,
    attachments: input.attachments ?? [],
  };
}

function assertMessageId(value) {
  if (typeof value !== "string" || value.length === 0
    || value.includes("/") || value.includes("\\")) {
    throw new CommsError("invalid message id", EXIT.DATA, { value });
  }
  return value;
}

function selected(value, allowed, name) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(item => !allowed.includes(item))) {
    throw new CommsError(`invalid ${name} filter`, EXIT.DATA, { value });
  }
  return new Set(value);
}

async function readMessageIfPresent(filePath) {
  try {
    return await readJsonStrict(filePath, validateMessage);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function messageForRecipient(context, recipient, id) {
  const inboxPath = context.paths.inboxFile(recipient, id);
  const archivePath = context.paths.archiveFile(recipient, id);
  const inboxMessage = await readMessageIfPresent(inboxPath);
  if (inboxMessage !== null) return { message: inboxMessage, inboxPath, archivePath };
  const archivedMessage = await readMessageIfPresent(archivePath);
  if (archivedMessage !== null) return { message: archivedMessage, inboxPath, archivePath };
  throw new CommsError("message does not exist for recipient", EXIT.DATA, {
    messageId: id,
    recipient,
  });
}

export async function sendMessage(context, input) {
  const sender = await requireOpenAgent(context, input.from);
  await requireOpenAgent(context, input.to);
  const body = await bodyFrom(input);
  const message = validateMessage(buildMessage(context, input, sender, body));
  await Promise.all(message.attachments.map(record => verifyAttachment(context, record)));
  await writeJsonAtomic(context.paths.inboxFile(input.to, message.id), message, {
    tmpDir: context.paths.tmp,
    exclusive: true,
  });
  return message;
}

export async function listInbox(context, input) {
  const recipient = (await requireOpenAgent(context, input.agentId)).agent_id;
  const types = selected(input.types, MESSAGE_TYPES, "type");
  const severities = selected(input.severities, SEVERITIES, "severity");
  const files = await listJsonFiles(context.paths.inboxDir(recipient));
  const items = [];
  for (const filePath of files) {
    const message = await readJsonStrict(filePath, validateMessage);
    if (message.to !== recipient) {
      throw new CommsError("inbox message has wrong recipient", EXIT.DATA, { filePath });
    }
    const acknowledgement = await receiptIfPresent(
      context.paths.ackFile(message.id, recipient),
      validateAcknowledgement,
    );
    if (acknowledgement !== null) {
      assertReceiptBinding(acknowledgement, message.id, recipient, "acknowledgement");
      continue;
    }
    if (types !== null && !types.has(message.type)) continue;
    if (severities !== null && !severities.has(message.severity)) continue;
    const seen = await receiptIfPresent(
      context.paths.seenFile(message.id, recipient),
      validateSeenReceipt,
    );
    if (seen !== null) assertReceiptBinding(seen, message.id, recipient, "seen receipt");
    const state = seen === null ? "unseen" : "seen";
    items.push({ message, state });
  }
  return items;
}

export async function markSeen(context, message, recipient) {
  const validMessage = validateMessage(message);
  const agent = await requireOpenAgent(context, recipient);
  if (validMessage.to !== agent.agent_id) {
    throw new CommsError("only the message recipient can mark it seen", EXIT.CONFLICT);
  }
  const persisted = await readMessageIfPresent(
    context.paths.inboxFile(agent.agent_id, validMessage.id),
  );
  if (persisted === null || !isDeepStrictEqual(persisted, validMessage)) {
    throw new CommsError("seen receipt requires the persisted inbox message", EXIT.DATA, {
      messageId: validMessage.id,
      recipient: agent.agent_id,
    });
  }
  const receipt = validateSeenReceipt({
    schema_version: 1,
    message_id: validMessage.id,
    recipient: agent.agent_id,
    seen_at: context.now().toISOString(),
  });
  const filePath = context.paths.seenFile(validMessage.id, agent.agent_id);
  try {
    await writeJsonAtomic(filePath, receipt, {
      tmpDir: context.paths.tmp,
      exclusive: true,
    });
  } catch (error) {
    if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
    const existing = await readJsonStrict(filePath, validateSeenReceipt);
    assertReceiptBinding(existing, validMessage.id, agent.agent_id, "seen receipt");
    return existing;
  }
  return receipt;
}

async function receiptIfPresent(filePath, validate) {
  try {
    return await readJsonStrict(filePath, validate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertReceiptBinding(receipt, messageId, recipient, name) {
  if (receipt.message_id !== messageId || receipt.recipient !== recipient) {
    throw new CommsError(`${name} does not match its message`, EXIT.DATA, {
      messageId,
      recipient,
    });
  }
}

export async function ackMessage(context, input) {
  const recipient = (await requireOpenAgent(context, input.agentId)).agent_id;
  const id = assertMessageId(input.messageId);
  const stored = await messageForRecipient(context, recipient, id);
  if (stored.message.to !== recipient) {
    throw new CommsError("only the message recipient can acknowledge it", EXIT.CONFLICT);
  }
  let acknowledgement = await receiptIfPresent(
    context.paths.ackFile(id, recipient),
    validateAcknowledgement,
  );
  if (acknowledgement !== null) {
    assertReceiptBinding(acknowledgement, id, recipient, "acknowledgement");
  }
  if (acknowledgement === null) {
    acknowledgement = validateAcknowledgement({
      schema_version: 1,
      message_id: id,
      recipient,
      acknowledged_at: context.now().toISOString(),
    });
    try {
      await writeJsonAtomic(context.paths.ackFile(id, recipient), acknowledgement, {
        tmpDir: context.paths.tmp,
        exclusive: true,
      });
    } catch (error) {
      if (!(error instanceof CommsError) || error.exitCode !== EXIT.CONFLICT) throw error;
      acknowledgement = await readJsonStrict(
        context.paths.ackFile(id, recipient),
        validateAcknowledgement,
      );
      assertReceiptBinding(acknowledgement, id, recipient, "acknowledgement");
    }
  }
  if (await exists(stored.inboxPath)) {
    try {
      await moveFileAtomic(stored.inboxPath, stored.archivePath);
    } catch (error) {
      if (error.code !== "ENOENT" || !(await exists(stored.archivePath))) throw error;
    }
  }
  return acknowledgement;
}

export async function replyToMessage(context, input) {
  const sender = (await requireOpenAgent(context, input.from)).agent_id;
  const original = (await messageForRecipient(
    context,
    sender,
    assertMessageId(input.messageId),
  )).message;
  return sendMessage(context, {
    ...input,
    to: original.from,
    replyTo: original.id,
  });
}

export async function broadcastMessage(context, input) {
  await requireOpenAgent(context, input.from);
  const active = [...new Set(await context.listActiveAgentIds())]
    .filter(agentId => agentId !== input.from)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(active.map(to => sendMessage(context, {
    ...input,
    to,
    type: "broadcast",
  })));
}
