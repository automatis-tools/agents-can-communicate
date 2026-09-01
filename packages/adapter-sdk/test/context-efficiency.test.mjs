import assert from "node:assert/strict";
import test from "node:test";

import { projectContext } from "../src/context-projector.mjs";

const session = (sessionId, participantId, presence) => ({ sessionId, participantId,
  harness: "codex", presence, branch: "main" });
const message = (messageId, subject, body) => ({ messageId, threadId: messageId,
  fromParticipantId: "peer", fromSessionId: "session_peer",
  toParticipantIds: ["reader"], kind: "question", obligation: "reply", subject, body });

test("ambient peer presence is a compact skill trigger, not a workspace dump", () => {
  const projected = projectContext({ cursor: "0000000000000042", solo: false,
    roster: [
      session("session_old", "codex-one", "stale"),
      session("session_current", "codex-one", "online"),
      session("session_two", "claude-two", "online"),
    ],
    claims: Array.from({ length: 30 }, (_, index) => ({
      resource: `file:generated/${index}/**`, enforcement: "guarded", enforceable: false,
      ownerParticipantId: index % 2 === 0 ? "codex-one" : "claude-two",
    })),
    attention: [], messages: [],
  });

  assert.ok(Buffer.byteLength(projected, "utf8") <= 200, projected);
  assert.match(projected, /ACC/i);
  assert.match(projected, /skill/i);
  assert.match(projected, /2 peer participants?/i);
  assert.doesNotMatch(projected, /session_old|session_current|generated\/0/);
});

test("an addressed message remains actionable and carries its stable id", () => {
  const projected = projectContext({ cursor: "7", solo: true, roster: [], claims: [],
    attention: [], messages: [message("message_target", "API shape",
      "Should inbox mark this seen?")] });

  assert.match(projected, /message_target/);
  assert.match(projected, /Should inbox mark this seen\?/);
});

test("overflow points to the exact inbox item instead of a full workspace sync", () => {
  const projected = projectContext({ cursor: "8", solo: false,
    roster: [session("session_peer", "peer", "online")], claims: [], attention: [],
    messages: [message("message_oversized", "Large", "x".repeat(2_000))] },
  { budgetBytes: 220 });

  assert.match(projected, /acc inbox --message message_oversized/);
  assert.doesNotMatch(projected, /sync --scope full/);
  assert.ok(Buffer.byteLength(projected, "utf8") <= 220, projected);
});
