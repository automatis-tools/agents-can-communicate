import assert from "node:assert/strict";
import test from "node:test";

import { projectContextResult } from "../src/context-projector.mjs";

const fresh = { messageId: "message_new", threadId: "message_new",
  fromParticipantId: "peer", fromSessionId: "session_peer", kind: "note",
  obligation: "none", subject: "Current decision", body: "Use port 4317." };

function backlog(replies, acknowledgements) {
  const attention = Array.from({ length: replies + acknowledgements }, (_, i) => ({
    kind: i < replies ? "reply_required" : "acknowledgement_required",
    priority: i < replies ? 1 : 2, sourceId: `message_old_${i}`,
    summary: `message message_old_${i} from peer requires a response`,
  }));
  return { attention, reminderMessageIds: attention.map(item => item.sourceId) };
}

test("repeated obligations leave room for a complete new body and retain only a count", () => {
  for (const count of [60, 1_000]) {
    const input = backlog(count - 20, 20);
    const result = projectContextResult({ ...input, messages: [fresh] });
    assert.ok(result.text.includes(fresh.body), "the standing backlog hid a new body");
    assert.deepEqual(result.offeredMessageIds, [fresh.messageId]);
    assert.match(result.text, new RegExp(`${count - 20} replies`));
    assert.match(result.text, /20 acknowledgements/);
    assert.match(result.text, /`acc inbox`/);
    assert.doesNotMatch(result.text, /message_old_/);
    assert.deepEqual(result.includedAttentionIds, [], "counts do not show individual items");
    assert.ok(Buffer.byteLength(result.text) < 500, result.text);
  }
});

test("at a tight budget a whole new body takes precedence over the standing reminder", () => {
  // 250 bytes fit the complete block and header, but not a backlog summary too.
  const result = projectContextResult({ ...backlog(60, 0), messages: [fresh] },
    { budgetBytes: 250 });
  assert.ok(result.text.includes(fresh.body), result.text);
  assert.deepEqual(result.offeredMessageIds, [fresh.messageId]);
  assert.equal(result.text.split("\n").filter(line => line.startsWith("```")).length, 2);
  assert.ok(Buffer.byteLength(result.text) <= 250);
});

test("only receipt-backed reply and acknowledgement reminders can be compacted", () => {
  const input = backlog(40, 20);
  input.attention.push(
    { kind: "reply_required", priority: 1, sourceId: "message_queued",
      summary: "New review request" },
    { kind: "claim_conflict", priority: 4, sourceId: "claim_conflict",
      summary: "file:src/api.mjs overlaps a peer claim" });
  input.reminderMessageIds.push("claim_conflict");
  const result = projectContextResult(input);
  assert.match(result.text, /message_queued New review request/);
  assert.match(result.text, /claim_conflict.*file:src\/api.mjs/);
  assert.match(result.text, /40 replies/);
  assert.match(result.text, /20 acknowledgements/);
  assert.deepEqual(result.includedAttentionIds, ["message_queued", "claim_conflict"]);
  assert.deepEqual(result.offeredMessageIds, []);
  assert.ok(Buffer.byteLength(result.text) < 400, result.text);
});
