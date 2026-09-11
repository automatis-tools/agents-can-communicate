import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeliveryRouter } from "@agents-can-communicate/delivery-router";

import { main, recordAndOffer } from "../src/main.mjs";

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

test("the CLI composition root supplies the resolved data home to its router", async t => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-router-cwd-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-router-data-")));
  t.after(() => Promise.all([cwd, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));
  let routedDataHome;
  const output = { write: (_text, done) => { done?.(); return true; } };

  const code = await main(["status", "--cwd", cwd, "--json"], {
    cwd, env: { HOME: cwd, ACC_DATA_HOME: dataHome }, platform: process.platform,
    stdout: output, stderr: output, clock: { now: () => "2026-09-07T12:00:00.000Z" },
    ids: { next: kind => `${kind}_router` },
    createDeliveryRouter: input => { routedDataHome = input.dataHome; return null; },
  });

  assert.equal(code, 0);
  assert.equal(routedDataHome, dataHome);
});

const PLATFORM = `${process.platform}-${process.arch}`;
// The version recorded on the binding, and the newer one the process that
// answers the offer is actually serving. Both satisfy the captured minimum, so
// the drift between them is admitted by the contract rule and would have been
// refused by the exact-identity rule this branch replaces.
const BOUND = "1.2.3";
const SERVING = "1.2.4";

function routed(policy, kind, { bindingPolicy = "all", failed = false } = {}) {
  let offers = 0;
  const receipt = { recipientParticipantId: "models", state: "queued" };
  const binding = { sessionId: "session_models", generation: "generation_models",
    adapterId: "fixture", clientVersion: BOUND, availableModes: ["livePush"],
    livePolicy: bindingPolicy, opaqueEndpointRef: "opaque", leaseUntil: "2099-01-01T00:00:00.000Z" };
  const service = { store: { root: "/runtime" },
    readReceipt: async () => receipt,
    listLiveSessions: async () => [{ sessionId: binding.sessionId,
      generation: binding.generation }],
    listDeliveryBindings: async () => [binding],
    recordOfferFailed: async () => {},
    recordOfferSucceeded: async () => { receipt.state = "offered"; } };
  // The contract a real adapter declares, in the shape defineAdapter accepts:
  // a per-platform minimum that is itself a passing capture, the anchor that
  // proves it, an explicit denylist, and the activation kinds the installer may
  // be asked for. A declaration missing any of it is rejected at definition
  // time, so a fixture without one routes through nothing a shipped adapter
  // could ever reach.
  const adapter = { id: "fixture", client: { command: "fixture-client" },
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ result: "pass", client: "fixture-client", version: BOUND,
      platform: PLATFORM, capability: "delivery.livePush" }] },
    nativeDelivery: { minimumByPlatform: { [PLATFORM]: BOUND },
      anchors: [{ platform: PLATFORM, version: BOUND, protocolContract: "fixture-native-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"],
      policySource: "installation-record" },
    offerMessage: async ({ binding: offered }) => {
      offers += 1;
      assert.equal(offered.livePolicy, policy);
      assert.equal(offered.clientVersion, BOUND);
      return { accepted: true, transport: "codex-app-server", clientVersion: SERVING };
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

// Every row that expects "offered" also proves the contract rule at this seam:
// the fixture answers with a version above the captured minimum but different
// from the one on the binding, which only a captured contract admits.
test("CLI delivery follows current recorded off, actionable, all, reader failure, "
  + "and a serving version above the bound one", async () => {
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
