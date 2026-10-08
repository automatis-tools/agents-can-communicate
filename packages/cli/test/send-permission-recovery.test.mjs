import assert from "node:assert/strict";
import test from "node:test";
import { recordedText } from "../src/main.mjs";

test("a permission fallback names the recorded retry key and an approved execution path", () => {
  const text = recordedText({ messageId: "message_original", clientMessageId: "client_original" },
    [{ outcome: "queued", recipientParticipantId: "receiver", errorCode: "transport_permission_denied" }]);
  assert.match(text, /recorded message_original/);
  assert.match(text, /--client-message-id "client_original"/);
  assert.match(text, /same command.*approved execution/);
  assert.doesNotMatch(text, /run acc doctor/);
});

test("the retry key is shell-quoted rather than evaluated as a command", () => {
  const text = recordedText({ messageId: "message_original", clientMessageId: 'client_$(touch injected)' },
    [{ outcome: "queued", errorCode: "transport_permission_denied" }]);
  assert.match(text, /--client-message-id "client_\\\$\(touch injected\)"/);
});
