import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "../src/errors.mjs";
import { SCHEMA_VERSION, validateRecord } from "../src/schema.mjs";
import { MESSAGE_KINDS, OBLIGATIONS, VALID_OBLIGATIONS, assertMessageSemantics }
  from "../src/conversations.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const MESSAGE = {
  schemaVersion: SCHEMA_VERSION,
  messageId: "message_a", threadId: "message_a", clientMessageId: "client_a",
  workspaceId: "workspace_a", fromParticipantId: "participant_a",
  fromSessionId: "session_a", toParticipantIds: ["participant_b"],
  kind: "question", obligation: "reply", subject: "API name", body: "Which one?",
  inReplyTo: null, artifacts: [], handoff: null, sentAt: NOW,
};
const HANDOFF = { status: "partial", completed: [], remaining: ["router"], blockers: [],
  verification: [] };

test("conversation kinds and obligations are closed", () => {
  assert.deepEqual(MESSAGE_KINDS, ["note", "question", "request", "answer", "decision",
    "handoff"]);
  assert.deepEqual(OBLIGATIONS, ["none", "acknowledge", "reply"]);
  assert.deepEqual(VALID_OBLIGATIONS, {
    note: ["none"], question: ["reply"], request: ["reply"], answer: ["none"],
    decision: ["none", "acknowledge"], handoff: ["none", "acknowledge"],
  });
});

test("the semantic matrix rejects mismatched kind and obligation", () => {
  assert.throws(() => validateRecord("message",
    { ...MESSAGE, kind: "note", obligation: "reply" }), /obligation/);
  assert.throws(() => validateRecord("message",
    { ...MESSAGE, kind: "request", obligation: "acknowledge" }), /obligation/);
});

test("room messages are non-actionable notes, decisions, or handoffs", () => {
  assert.throws(() => validateRecord("message",
    { ...MESSAGE, toParticipantIds: [], kind: "question" }), /room/);
  assert.throws(() => validateRecord("message",
    { ...MESSAGE, toParticipantIds: [], kind: "decision", obligation: "acknowledge" }), /room/);
  for (const [kind, handoff] of [["note", null], ["decision", null], ["handoff", HANDOFF]]) {
    assert.equal(validateRecord("message", { ...MESSAGE, toParticipantIds: [], kind,
      obligation: "none", handoff }).kind, kind);
  }
});

test("thread roots use their message id and carry no reply pointer", () => {
  assert.throws(() => assertMessageSemantics({ ...MESSAGE, threadId: "message_root" }),
    error => error.code === EXIT.DATA && /threadId/.test(error.message));
  assert.throws(() => assertMessageSemantics({ ...MESSAGE, inReplyTo: "message_root" }),
    error => error.code === EXIT.DATA && /inReplyTo/.test(error.message));
});

test("thread replies retain the root and name the message they answer", () => {
  const answer = { ...MESSAGE, messageId: "message_b", threadId: "message_a",
    clientMessageId: "client_b", kind: "answer", obligation: "none",
    inReplyTo: "message_a" };
  assert.equal(validateRecord("message", answer), answer);
  assert.throws(() => validateRecord("message", { ...answer, inReplyTo: null }), /inReplyTo/);
  assert.throws(() => validateRecord("message", { ...answer, threadId: "message_b" }), /answer/);
});

test("handoff payload exists only on handoff messages", () => {
  assert.throws(() => validateRecord("message", { ...MESSAGE, handoff: HANDOFF }), /handoff/);
  assert.throws(() => validateRecord("message", { ...MESSAGE, kind: "handoff",
    obligation: "acknowledge", handoff: null }), /handoff/);
  assert.throws(() => validateRecord("message", { ...MESSAGE, kind: "handoff",
    obligation: "none", handoff: HANDOFF }), /addressed handoff/);
  assert.equal(validateRecord("message", { ...MESSAGE, kind: "handoff",
    obligation: "acknowledge", handoff: HANDOFF }).handoff, HANDOFF);
});
