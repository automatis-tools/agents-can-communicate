import assert from "node:assert/strict";
import test from "node:test";

import { deriveClaudeCapture } from "../../scripts/spikes/claude-channel-fixture.mjs";
import { validateCapture } from "../../scripts/spikes/delivery-capture.mjs";

const at = (seconds) => `2026-09-02T21:16:${String(seconds).padStart(2, "0")}.000Z`;
const LOG = [
  { event: "endpoint_listening", at: at(0) },
  { event: "notification_accepted", at: at(7), messageId: "message_idle", kind: "question" },
  { event: "reply_routed", at: at(39), messageId: "message_idle", delivered: false },
  { event: "duplicate_suppressed", at: at(57), messageId: "message_idle" },
  { event: "notification_accepted", at: at(58), messageId: "message_busy", kind: "question" },
  { event: "reply_routed", at: at(59), messageId: "message_busy", delivered: false },
  { event: "endpoint_closed", at: at(59) },
];
const base = { version: "2.1.258", platform: "darwin-arm64", fixture: "claude-code-2.1.258-channel",
  idleId: "message_idle", busyId: "message_busy", busy: "queued_after_turn", fallback: "queued",
  limitations: ["darwin-arm64 only"] };

test("a complete log plus attested verdicts derives a passing capture", () => {
  const capture = deriveClaudeCapture({ ...base, observations: LOG });
  assert.deepEqual(validateCapture(capture), capture);
  assert.equal(capture.result, "pass");
  assert.deepEqual([capture.idle, capture.busy, capture.reply, capture.duplicate, capture.fallback],
    ["offered", "queued_after_turn", "routed", "same_message_id", "queued"]);
  assert.equal(capture.observedAt, at(59));
  assert.equal(capture.protocolContract, "claude-code-channel-mcp-v1");
});

test("a verdict the log cannot support stays unobserved and fails the capture", () => {
  const noBusyReply = LOG.filter((item) => !(item.event === "reply_routed"
    && item.messageId === "message_busy"));
  const capture = deriveClaudeCapture({ ...base, observations: noBusyReply });
  assert.equal(capture.busy, "unobserved");
  assert.equal(capture.result, "fail");
  const twice = [...LOG, { event: "notification_accepted", at: at(10), messageId: "message_idle" }];
  assert.equal(deriveClaudeCapture({ ...base, observations: twice }).idle, "unobserved");
  assert.equal(deriveClaudeCapture({ ...base, observations: twice }).duplicate, "unobserved");
  const noClose = LOG.filter((item) => item.event !== "endpoint_closed");
  assert.equal(deriveClaudeCapture({ ...base, observations: noClose }).fallback, "unobserved");
  assert.equal(deriveClaudeCapture({ ...base, observations: LOG, busy: "unobserved" }).result, "fail");
});

test("a rejected-busy verdict needs a rejection and no busy notification", () => {
  const rejected = [...LOG.filter((item) => item.messageId !== "message_busy"),
    { event: "envelope_rejected", at: at(58), reasonCode: "recipient_busy" }];
  assert.equal(deriveClaudeCapture({ ...base, observations: rejected, busy: "rejected_busy" }).busy,
    "rejected_busy");
  assert.equal(deriveClaudeCapture({ ...base, observations: LOG, busy: "rejected_busy" }).busy,
    "unobserved");
});

test("a launch outside the install-time bootstrap can never pass", () => {
  const capture = deriveClaudeCapture({ ...base, observations: LOG,
    launchMode: "manual-vendor-invocation" });
  assert.equal(capture.result, "fail");
  assert.equal(capture.launchMode, "manual-vendor-invocation");
});
