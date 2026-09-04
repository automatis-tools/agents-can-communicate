import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";

import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

const NOW = "2026-09-01T21:00:00.000Z";
const WORKSPACE = "workspace_router_receipts";
const PLATFORM = `${process.platform}-${process.arch}`;

const adapterWith = offerMessage => ({
  id: "fixture_adapter",
  client: { command: "fixture-client" },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [{ result: "pass", client: "fixture-client",
    version: "1.2.3", platform: PLATFORM, capability: "delivery.livePush" }] },
  nativeDelivery: { minimumByPlatform: { [PLATFORM]: "1.2.3" },
    anchors: [{ platform: PLATFORM, version: "1.2.3", protocolContract: "fixture-native-v1" }],
    knownBad: [], activationKinds: ["shell-bootstrap"] },
  offerMessage,
});

async function fixture(offerMessage) {
  const clock = createFakeClock(NOW);
  const ids = createFakeIds();
  const store = createMemoryStore({ clock, ids, workspaceId: WORKSPACE });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sender = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "sender", sessionId: "session_sender", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const recipient = await service.openSession({ workspaceId: WORKSPACE,
    participantId: "models", sessionId: "session_models", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  const adapter = adapterWith(offerMessage);
  const router = createDeliveryRouter({ service,
    adapters: { fixture_adapter: adapter }, clock });
  return { clock, recipient, router, sender, service, store };
}

const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

const publish = (service, session) => service.publishDeliveryBinding({
  sessionId: session.sessionId, generation: session.generation,
  adapterId: "fixture_adapter", clientVersion: "1.2.3", availableModes: ["livePush"],
  livePolicy: "actionable", opaqueEndpointRef: `endpoint:${session.sessionId}`,
  leaseUntil: "2026-09-01T21:01:00.000Z",
});

const send = (f, suffix, toParticipantIds = ["models"]) => f.service.sendMessage({
  ...owner(f.sender), clientMessageId: `client_${suffix}`, toParticipantIds,
  kind: "question", obligation: "reply", subject: `Question ${suffix}`,
  body: "Please answer.", artifacts: [], inReplyTo: null, handoff: null,
});

const events = async f => (await f.store.eventsSince(WORKSPACE, null, 100)).events
  .filter(event => ["message.offer_succeeded", "message.offer_failed"].includes(event.type));

test("sequential offered, retrieved, and acknowledged receipts skip native transport", async () => {
  let calls = 0;
  const f = await fixture(async ({ binding }) => {
    calls += 1;
    return { accepted: true, transport: "codex-app-server",
      clientVersion: binding.clientVersion };
  });
  await publish(f.service, f.recipient);

  const offered = await send(f, "offered");
  assert.equal((await f.router.offer(offered))[0].outcome, "offered");
  assert.deepEqual(await f.router.offer(offered), [{ recipientParticipantId: "models",
    outcome: "offered", transport: "durable" }]);

  const retrieved = await send(f, "retrieved");
  await f.service.readInbox({ ...owner(f.recipient), messageId: retrieved.messageId });
  assert.deepEqual(await f.router.offer(retrieved), [{ recipientParticipantId: "models",
    outcome: "retrieved", transport: "durable" }]);

  const acknowledged = await send(f, "acknowledged");
  await f.service.acknowledgeMessage({ ...owner(f.recipient),
    messageId: acknowledged.messageId });
  assert.deepEqual(await f.router.offer(acknowledged), [{ recipientParticipantId: "models",
    outcome: "acknowledged", transport: "durable" }]);

  assert.equal(calls, 1);
  assert.deepEqual((await events(f)).map(event => event.type), ["message.offer_succeeded"]);
});

for (const state of ["retrieved", "acknowledged"]) {
  test(`accepted transport remains successful when receipt concurrently becomes ${state}`,
    async () => {
      let f;
      const offerMessage = async ({ binding, message }) => {
        if (state === "retrieved") await f.service.readInbox({ ...owner(f.recipient),
          messageId: message.messageId });
        else await f.service.acknowledgeMessage({ ...owner(f.recipient),
          messageId: message.messageId });
        return { accepted: true, transport: "codex-app-server",
          clientVersion: binding.clientVersion };
      };
      f = await fixture(offerMessage);
      await publish(f.service, f.recipient);
      const message = await send(f, `race_${state}`);

      assert.deepEqual(await f.router.offer(message), [{ recipientParticipantId: "models",
        outcome: "offered", transport: "codex-app-server" }]);
      assert.equal((await f.service.readReceipt({ messageId: message.messageId,
        recipientParticipantId: "models" })).state, state);
      assert.equal((await events(f)).some(event => event.type === "message.offer_failed"), false);
    });
}

test("one settled recipient does not suppress another recipient's queued offer", async () => {
  const calls = [];
  const f = await fixture(async ({ binding }) => {
    calls.push(binding.sessionId);
    return { accepted: true, transport: "codex-app-server",
      clientVersion: binding.clientVersion };
  });
  const other = await f.service.openSession({ workspaceId: WORKSPACE,
    participantId: "other", sessionId: "session_other", harness: "fixture",
    heartbeatCadenceMs: 30_000 });
  await publish(f.service, f.recipient);
  await publish(f.service, other);
  const message = await send(f, "isolated", ["models", "other"]);
  await f.service.acknowledgeMessage({ ...owner(f.recipient), messageId: message.messageId });

  assert.deepEqual(await f.router.offer(message), [
    { recipientParticipantId: "models", outcome: "acknowledged", transport: "durable" },
    { recipientParticipantId: "other", outcome: "offered", transport: "codex-app-server" },
  ]);
  assert.deepEqual(calls, [other.sessionId]);
});
