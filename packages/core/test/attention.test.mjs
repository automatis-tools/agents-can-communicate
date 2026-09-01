import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { ATTENTION_PRIORITY, computeAttention } from "../src/attention.mjs";

const NOW = "2026-09-01T19:00:00.000Z";
const options = (overrides = {}) => ({ session: { sessionId: "session_a" },
  participantId: "participant_a", now: NOW, pidIsAlive: () => true, ...overrides });
const open = (sessionId, participantId) => ({ sessionId, participantId, state: "open",
  heartbeatAt: NOW, heartbeatCadenceMs: 60_000, pid: null });

test("recipient obligations produce only their matching attention vocabulary", () => {
  const snapshot = {
    messages: [
      { messageId: "message_reply", subject: "Answer me", obligation: "reply" },
      { messageId: "message_ack", subject: "Confirm this", obligation: "acknowledge" },
      { messageId: "message_none", subject: "FYI", obligation: "none" },
    ],
    receipts: [
      { messageId: "message_reply", recipientParticipantId: "participant_a", state: "queued" },
      { messageId: "message_ack", recipientParticipantId: "participant_a", state: "retrieved" },
      { messageId: "message_none", recipientParticipantId: "participant_a", state: "queued" },
    ],
    sessions: [], claims: [], intents: [],
  };

  assert.deepEqual(computeAttention(snapshot, options()).map(item => item.kind),
    ["reply_required", "acknowledgement_required"]);
});

test("acknowledged obligations and another participant's receipts are quiet", () => {
  const snapshot = {
    messages: [{ messageId: "message_a", subject: "Answer", obligation: "reply" }],
    receipts: [
      { messageId: "message_a", recipientParticipantId: "participant_a",
        state: "acknowledged" },
      { messageId: "message_a", recipientParticipantId: "participant_b", state: "queued" },
    ],
    sessions: [], claims: [], intents: [],
  };

  assert.deepEqual(computeAttention(snapshot, options()), []);
});

test("recipient_unavailable belongs to the sender and only for unresolved addressed peers", () => {
  const snapshot = {
    messages: [
      { messageId: "message_required", fromParticipantId: "participant_a",
        toParticipantIds: ["participant_b"], subject: "Respond", obligation: "reply" },
      { messageId: "message_room", fromParticipantId: "participant_a", toParticipantIds: [],
        subject: "Room", obligation: "none" },
      { messageId: "message_theirs", fromParticipantId: "participant_c",
        toParticipantIds: ["participant_b"], subject: "Not mine", obligation: "reply" },
    ],
    receipts: [
      { messageId: "message_required", recipientParticipantId: "participant_b",
        state: "queued" },
      { messageId: "message_room", recipientParticipantId: "participant_b", state: "queued" },
      { messageId: "message_theirs", recipientParticipantId: "participant_b", state: "queued" },
    ],
    sessions: [], claims: [], intents: [],
  };

  const attention = computeAttention(snapshot, options());
  assert.deepEqual(attention.map(item => item.kind), ["recipient_unavailable"]);
  assert.equal(attention[0].sourceId, "message_required");
});

test("an open recipient session suppresses recipient_unavailable", () => {
  const snapshot = {
    messages: [{ messageId: "message_a", fromParticipantId: "participant_a",
      toParticipantIds: ["participant_b"], subject: "Respond", obligation: "reply" }],
    receipts: [{ messageId: "message_a", recipientParticipantId: "participant_b",
      state: "queued" }],
    sessions: [open("session_b", "participant_b")], claims: [], intents: [],
  };

  assert.deepEqual(computeAttention(snapshot, options()), []);
});

test("claim-derived attention remains reachable and the vocabulary is closed", () => {
  const snapshot = {
    messages: [], receipts: [],
    intents: [
      { sessionId: "session_a", resourceHints: ["file:src/**"] },
      { sessionId: "session_b", resourceHints: ["file:held.mjs"] },
    ],
    claims: [
      { claimId: "claim_conflict", ownerSessionId: "session_b", resource: "file:src/a.mjs",
        expiresAt: "2026-09-01T20:00:00.000Z" },
      { claimId: "claim_contended", ownerSessionId: "session_a", resource: "file:held.mjs",
        expiresAt: "2026-09-01T20:00:00.000Z" },
      { claimId: "claim_expired", ownerSessionId: "session_a", resource: "file:old.mjs",
        expiresAt: "2026-09-01T18:00:00.000Z" },
    ],
    sessions: [open("session_b", "participant_b")],
  };

  const produced = computeAttention(snapshot, options());
  assert.deepEqual(produced.map(item => item.kind),
    ["claim_conflict", "claim_contended", "claim_expired"]);
  assert.deepEqual(Object.keys(ATTENTION_PRIORITY), ["reply_required",
    "acknowledgement_required", "recipient_unavailable", "claim_conflict",
    "claim_contended", "claim_expired"]);
});

test("attention refuses to infer presence without a liveness probe", () => {
  assert.throws(() => computeAttention({ sessions: [] }, { session: null,
    participantId: "participant_a", now: NOW }), error => error.code === EXIT.USAGE);
});
