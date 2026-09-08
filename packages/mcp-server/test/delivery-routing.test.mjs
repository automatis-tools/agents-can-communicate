import assert from "node:assert/strict";
import test from "node:test";

import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";

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

function routed(policy, kind, { bindingPolicy = "all", failed = false } = {}) {
  let offers = 0;
  const receipt = { recipientParticipantId: "models", state: "queued" };
  const binding = { sessionId: "session_models", generation: "generation_models",
    adapterId: "fixture", clientVersion: "1.2.3", availableModes: ["livePush"],
    livePolicy: bindingPolicy, opaqueEndpointRef: "opaque", leaseUntil: "2099-01-01T00:00:00.000Z" };
  const service = { store: { root: "/runtime" },
    readReceipt: async () => receipt,
    listLiveSessions: async () => [{ sessionId: binding.sessionId,
      generation: binding.generation }],
    listDeliveryBindings: async () => [binding],
    recordOfferFailed: async () => {},
    recordOfferSucceeded: async () => { receipt.state = "offered"; } };
  const adapter = { id: "fixture", capabilities: { delivery: { livePush: true } },
    nativeDelivery: { policySource: "installation-record" },
    offerMessage: async ({ binding: offered }) => {
      offers += 1;
      assert.equal(offered.livePolicy, policy);
      return { accepted: true, transport: "codex-app-server",
        clientVersion: offered.clientVersion };
    } };
  const router = createDeliveryRouter({ service, adapters: { fixture: adapter },
    clock: { now: () => "2026-09-07T12:00:00.000Z" },
    readLivePolicy: async () => {
      if (failed) throw new Error("reader failed");
      return policy;
    } });
  return { offers: () => offers, receipt, router,
    message: { messageId: `message_${policy}_${kind}`, toParticipantIds: ["models"], kind } };
}

test("MCP delivery follows current recorded off, actionable, all, and reader failure", async () => {
  for (const [policy, kind, expected, options] of [
    ["off", "question", "queued", { bindingPolicy: "all" }],
    ["actionable", "note", "queued"],
    ["actionable", "question", "offered"],
    ["actionable", "request", "offered"],
    ["actionable", "answer", "offered"],
    ["all", "note", "offered", { bindingPolicy: "actionable" }],
    ["all", "question", "queued", { failed: true }],
  ]) {
    const f = routed(policy, kind, options);
    const result = await recordAndOffer({ record: async () => f.message, router: f.router });
    assert.equal(result.recorded, f.message, `${policy} ${kind}`);
    assert.equal(result.delivery[0].outcome, expected, `${policy} ${kind}`);
    assert.equal(f.receipt.state, expected, `${policy} ${kind}`);
    assert.equal(f.offers(), expected === "offered" ? 1 : 0, `${policy} ${kind}`);
  }
});
