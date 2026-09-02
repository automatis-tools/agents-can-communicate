import assert from "node:assert/strict";
import test from "node:test";

import { recordAndOffer } from "../src/server.mjs";

test("the MCP composition seam offers only after durable reply recording", async () => {
  const order = [];
  const reply = { messageId: "message_reply", toParticipantIds: ["sender"] };
  const result = await recordAndOffer({
    record: async () => {
      order.push("record");
      return { reply, receipt: { state: "acknowledged" } };
    },
    selectMessage: recorded => recorded.reply,
    router: { offer: async message => {
      assert.equal(message, reply);
      order.push("offer");
      return [{ recipientParticipantId: "sender", outcome: "queued",
        transport: "durable", errorCode: "recipient_unavailable" }];
    } },
  });

  assert.deepEqual(order, ["record", "offer"]);
  assert.equal(result.recorded.reply, reply);
  assert.equal(result.delivery[0].errorCode, "recipient_unavailable");
});

test("room results skip the MCP live-delivery router", async () => {
  let offered = false;
  const result = await recordAndOffer({
    record: async () => ({ messageId: "message_room", toParticipantIds: [] }),
    router: { offer: async () => { offered = true; return []; } },
  });

  assert.equal(offered, false);
  assert.deepEqual(result.delivery, []);
});

test("an MCP router diagnostic cannot change durable command success", async () => {
  const message = { messageId: "message_request", toParticipantIds: ["models"] };
  const result = await recordAndOffer({ record: async () => message,
    router: { offer: async () => { throw new Error("secret transport detail"); } } });

  assert.equal(result.recorded, message);
  assert.deepEqual(result.delivery, [{ recipientParticipantId: "models",
    outcome: "queued", transport: "durable", errorCode: "transport_error" }]);
  assert.equal(JSON.stringify(result).includes("secret transport detail"), false);
});
