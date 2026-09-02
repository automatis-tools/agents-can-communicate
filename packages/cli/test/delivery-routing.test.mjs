import assert from "node:assert/strict";
import test from "node:test";

import { recordAndOffer } from "../src/main.mjs";

const message = { messageId: "message_a", toParticipantIds: ["models"] };

test("the CLI composition seam records before it offers", async () => {
  const order = [];
  const result = await recordAndOffer({
    record: async () => { order.push("record"); return message; },
    router: { offer: async value => {
      assert.equal(value, message);
      order.push("offer");
      return [{ recipientParticipantId: "models", outcome: "offered",
        transport: "fixture-live" }];
    } },
  });

  assert.deepEqual(order, ["record", "offer"]);
  assert.equal(result.recorded, message);
  assert.equal(result.delivery[0].outcome, "offered");
});

test("a CLI router diagnostic keeps the durable command successful", async () => {
  const result = await recordAndOffer({ record: async () => message,
    router: { offer: async () => { throw new Error("secret transport detail"); } } });

  assert.equal(result.recorded, message);
  assert.deepEqual(result.delivery, [{ recipientParticipantId: "models",
    outcome: "queued", transport: "durable", errorCode: "transport_error" }]);
  assert.equal(JSON.stringify(result).includes("secret transport detail"), false);
});
