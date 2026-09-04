import assert from "node:assert/strict";
import test from "node:test";

import { deriveCodexCapture } from "../../scripts/spikes/codex-queue-fixture.mjs";
import { validateCapture } from "../../scripts/spikes/delivery-capture.mjs";

const THREAD = "01a063ed-a384-7fe2-b443-7fedf1593f6b";
const result = (at, threadStatus, submission, clientUserMessageId, duplicate = false) => ({
  at, supported: true, clientVersion: "0.152.1", serverVersion: "0.152.1",
  protocolContract: "codex-app-server-thread-queue-v1", modes: ["livePush", "idleWake", "busyQueue"],
  threadId: THREAD, threadStatus,
  queue: { accepted: true, duplicate, queuedSubmissionId: submission, clientUserMessageId },
  reasonCode: null, stage: "complete",
});
const down = { at: "2026-09-02T21:32:19.320Z", supported: false, clientVersion: "0.152.1",
  serverVersion: null, protocolContract: "codex-app-server-thread-queue-v1", modes: [],
  threadId: null, threadStatus: null, queue: null, reasonCode: "transport_unavailable",
  stage: "initialize" };
const base = {
  idle: result("2026-09-02T21:26:37.315Z", "idle", "qs_1", "message_idle"),
  busy: result("2026-09-02T21:31:05.498Z", "active", "qs_2", "message_busy"),
  busyRetry: result("2026-09-02T21:31:05.574Z", "active", "qs_2", "message_busy", true),
  fallback: down,
  idleAnswer: "message_answer1", busyAnswer: "message_answer2", fallbackReceipt: "queued",
  busyAfterTurn: true, version: "0.152.1", platform: "darwin-arm64",
  fixture: "codex-cli-0.152.1-queue", limitations: ["darwin-arm64 only"],
};

test("complete results plus the attested busy verdict derive a passing capture", () => {
  const capture = deriveCodexCapture(base);
  assert.deepEqual(validateCapture(capture), capture);
  assert.equal(capture.result, "pass");
  assert.deepEqual([capture.idle, capture.busy, capture.reply, capture.duplicate, capture.fallback],
    ["offered", "queued_after_turn", "routed", "same_message_id", "queued"]);
  assert.equal(capture.observedAt, "2026-09-02T21:32:19.320Z");
  assert.equal(capture.client, "codex-cli");
});

test("each branch stays unobserved without its measured support", () => {
  assert.equal(deriveCodexCapture({ ...base, idleAnswer: undefined }).idle, "unobserved");
  assert.equal(deriveCodexCapture({ ...base, idle: { ...base.idle, threadStatus: "active" } }).idle,
    "unobserved");
  assert.equal(deriveCodexCapture({ ...base, busyAfterTurn: false }).busy, "unobserved");
  assert.equal(deriveCodexCapture({ ...base, busy: { ...base.busy, threadStatus: "idle" } }).busy,
    "unobserved");
  assert.equal(deriveCodexCapture({ ...base,
    busyRetry: result("2026-09-02T21:31:05.574Z", "active", "qs_3", "message_busy", false) }).duplicate, "unobserved");
  assert.equal(deriveCodexCapture({ ...base,
    busyRetry: result("2026-09-02T21:31:05.574Z", "active", "qs_9", "message_busy", true) }).duplicate, "unobserved");
  assert.equal(deriveCodexCapture({ ...base, fallbackReceipt: "unobserved" }).fallback, "unobserved");
  assert.equal(deriveCodexCapture({ ...base, fallback: { ...down, reasonCode: "request_timeout" } })
    .fallback, "unobserved");
  assert.equal(deriveCodexCapture({ ...base, busyAnswer: undefined }).result, "fail");
});

test("an explicit busy rejection is recorded as rejected_busy", () => {
  const rejected = { ...base.busy, supported: false, queue: null, reasonCode: "recipient_busy",
    stage: "queue" };
  const capture = deriveCodexCapture({ ...base, busy: rejected, busyRetry: rejected });
  assert.equal(capture.busy, "rejected_busy");
  assert.equal(capture.duplicate, "unobserved");
});
