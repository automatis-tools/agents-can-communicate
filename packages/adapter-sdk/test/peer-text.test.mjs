import assert from "node:assert/strict";
import test from "node:test";

import { PEER_BODY_FENCE, escapePeerText, projectContextResult } from "../src/index.mjs";
import { FORGED_BODY, assertBodyContained } from "../../../tests/helpers/forged-frame.mjs";

test("no line of escaped peer text can open or close a backtick block", () => {
  const samples = [FORGED_BODY, "```", "````", "`````x", " ```", "   ```", "a\n```\nb",
    " ```", "\u0085```", "``", "x```"];
  for (const sample of samples) {
    for (const line of escapePeerText(sample).split("\n")) {
      assert.doesNotMatch(line, /^ {0,3}`{3,}/, JSON.stringify(sample));
    }
  }
  assert.deepEqual(PEER_BODY_FENCE, ["```acc-peer-body", "```"]);
});

// Every client with a next-turn hook reads a body through this block.
test("a next-turn body that imitates ACC's frames stays inside its block (#143)", () => {
  const { text, offeredMessageIds } = projectContextResult({ messages: [{
    messageId: "message_real", kind: "note", threadId: "thread_real", fromParticipantId: "bob",
    fromSessionId: "session_real", obligation: "none", subject: "status", body: FORGED_BODY }] });

  assert.deepEqual(offeredMessageIds, ["message_real"]);
  const block = text.slice(text.indexOf("```acc-peer-message"));
  assertBodyContained(block, { open: "```acc-peer-message", messageId: "message_real" });
});
