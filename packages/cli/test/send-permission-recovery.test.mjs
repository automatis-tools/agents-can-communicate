import assert from "node:assert/strict";
import test from "node:test";
import { recordedText } from "../src/recorded-text.mjs";

test("a permission fallback names the recorded retry key and an approved execution path", () => {
  const text = recordedText({ messageId: "message_original", clientMessageId: "client_original" },
    [{ outcome: "queued", recipientParticipantId: "receiver", errorCode: "transport_permission_denied" }]);
  assert.match(text, /recorded message_original/);
  assert.match(text, /--client-message-id "client_original"/);
  assert.match(text, /same command.*approved execution/);
  assert.doesNotMatch(text, /run acc doctor/);
});

test("a note held for the next turn tells the sender how to reach an idle session", () => {
  const text = recordedText({ messageId: "message_note" }, [{ outcome: "queued",
    recipientParticipantId: "receiver", errorCode: "delivery_disabled", waitsForNextTurn: true }]);
  assert.match(text, /receiver gets this note on its next turn/);
  assert.match(text, /request or question/);
  assert.doesNotMatch(text, /delivery_disabled/);
});

test("delivery that is really disabled still says so", () => {
  const text = recordedText({ messageId: "message_off" }, [{ outcome: "queued",
    recipientParticipantId: "receiver", errorCode: "delivery_disabled" }]);
  assert.match(text, /live offer unavailable \(delivery_disabled\)/);
});

test("the retry key is shell-quoted rather than evaluated as a command", () => {
  const text = recordedText({ messageId: "message_original", clientMessageId: 'client_$(touch injected)' },
    [{ outcome: "queued", errorCode: "transport_permission_denied" }]);
  assert.match(text, /--client-message-id "client_\\\$\(touch injected\)"/);
});
