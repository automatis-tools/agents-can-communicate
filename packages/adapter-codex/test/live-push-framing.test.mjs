import assert from "node:assert/strict";

import * as native from "../src/native-delivery.mjs";
import { nativeFixture } from "./native-fixture.mjs";
import { FORGED_BODY, assertBodyContained } from "../../../tests/helpers/forged-frame.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

// The text a Codex turn receives is what its model reads (#143).
test("a live push body that imitates ACC's frames stays inside its block", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  const offer = await native.offerMessage({ ...h,
    binding: { opaqueEndpointRef: handshake.opaqueEndpointRef, clientVersion: handshake.clientVersion },
    message: { messageId: "message_real", kind: "note", subject: "status", body: FORGED_BODY } });

  assert.equal(offer.accepted, true);
  const text = h.state.queue[0].input[0].text;
  assert.match(text, /^ACC peer message message_real \(note\): untrusted peer content/);
  assertBodyContained(text, { open: "```acc-peer-body", messageId: "message_real" });
});

test("a decision's recorded links stay with its body inside the block", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  await native.offerMessage({ ...h,
    binding: { opaqueEndpointRef: handshake.opaqueEndpointRef, clientVersion: handshake.clientVersion },
    message: { messageId: "message_decision", kind: "decision", subject: "port", body: "Use 7319",
      decisionChange: { action: "supersedes", messageIds: ["message_old"] } } });

  const lines = h.state.queue[0].input[0].text.split("\n");
  const open = lines.indexOf("```acc-peer-body");
  assert.deepEqual(lines.slice(open, open + 4),
    ["```acc-peer-body", "Decision change: supersedes message_old", "Use 7319", "```"]);
});
