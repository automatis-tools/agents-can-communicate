import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "../../../tools/agents/lib/errors.mjs";
import {
  validateAcknowledgement,
  validateMessage,
  validateSeenReceipt,
} from "../../../tools/agents/lib/schema.mjs";

const timestamp = "2026-08-14T18:00:00.000Z";

function message(id, replyTo = null) {
  return {
    schema_version: 1,
    id,
    from: "visual",
    to: "models",
    type: "question",
    severity: "action",
    subject: "subject",
    body: "body",
    task: "M2.7",
    reply_to: replyTo,
    requires_ack: true,
    created_at: timestamp,
    sender_head: "a".repeat(40),
    attachments: [],
  };
}

function receipt(messageId, seen) {
  return {
    schema_version: 1,
    message_id: messageId,
    recipient: "models",
    [seen ? "seen_at" : "acknowledged_at"]: timestamp,
  };
}

test("message and receipt ids use a portable path-safe alphabet", () => {
  const unsafe = [
    "bad\0id",
    "bad\nid",
    "../escape",
    "back\\slash",
    "colon:id",
    "question?mark",
    "star*name",
    "white space",
    ".hidden",
    "trailing.",
    "NUL",
    "com1.log",
    "a".repeat(217),
  ];
  for (const id of unsafe) {
    assert.throws(() => validateMessage(message(id)), error => error.exitCode === EXIT.DATA);
    assert.throws(() => validateMessage(message("valid-id", id)),
      error => error.exitCode === EXIT.DATA);
    assert.throws(() => validateSeenReceipt(receipt(id, true)),
      error => error.exitCode === EXIT.DATA);
    assert.throws(() => validateAcknowledgement(receipt(id, false)),
      error => error.exitCode === EXIT.DATA);
  }
});

test("generated-style message ids remain valid", () => {
  const id = "20260814T180000.000Z-visual-00000000-0000-4000-8000-000000000001";
  assert.equal(validateMessage(message(id)).id, id);
  assert.equal(validateSeenReceipt(receipt(id, true)).message_id, id);
});
