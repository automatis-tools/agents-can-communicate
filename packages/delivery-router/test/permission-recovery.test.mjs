import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "@agents-can-communicate/core";
import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds, createMemoryStore } from "../../../tests/helpers/memory-store.mjs";

for (const expired of [false, true]) {
  test(`permission recovery preserves one message with ${expired ? "an expired" : "a current"} binding`, async () => {
    const clock = createFakeClock("2026-10-08T12:00:00.000Z");
    const ids = createFakeIds();
    const workspaceId = "workspace_permission_recovery";
    const store = createMemoryStore({ clock, ids, workspaceId });
    const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
    const sender = await service.openSession({ workspaceId, participantId: "sender", harness: "fixture",
      heartbeatCadenceMs: 30_000 });
    const receiver = await service.openSession({ workspaceId, participantId: "receiver", harness: "fixture",
      heartbeatCadenceMs: 30_000 });
    const binding = { sessionId: receiver.sessionId, generation: receiver.generation,
      adapterId: "fixture", clientVersion: "1.0.0", availableModes: ["livePush"],
      livePolicy: "actionable", opaqueEndpointRef: "private-endpoint",
      leaseUntil: "2026-10-08T12:01:00.000Z" };
    await service.publishDeliveryBinding(binding);
    let denied = true, offers = 0;
    const adapter = { id: "fixture", capabilities: { delivery: { livePush: true } },
      nativeDelivery: { minimum: "1.0.0", anchors: [{ version: "1.0.0", protocolContract: "fixture-v1" }],
        activationKinds: ["native-service"], knownBad: [] },
      refreshNativeSession: async () => ({ supported: !denied, clientVersion: "1.0.0",
        protocolContract: "fixture-v1", modes: denied ? [] : ["livePush"],
        opaqueEndpointRef: denied ? null : binding.opaqueEndpointRef,
        leaseUntil: denied ? null : "2026-10-08T12:04:00.000Z",
        reasonCode: denied ? "transport_permission_denied" : null }),
      offerMessage: async () => {
        if (denied) return { accepted: false, transport: "codex-app-server", clientVersion: "1.0.0",
          safeErrorCode: "transport_permission_denied" };
        offers += 1;
        return { accepted: true, transport: "codex-app-server", clientVersion: "1.0.0" };
      },
    };
    const router = createDeliveryRouter({ service, clock, adapters: [adapter],
      readLivePolicy: async () => "actionable" });
    if (expired) clock.advance(60_001);
    const input = { sessionId: sender.sessionId, generation: sender.generation,
      clientMessageId: "client_permission_retry", toParticipantIds: ["receiver"], kind: "question",
      obligation: "reply", subject: "Synthetic permission recovery", body: "Please acknowledge." };
    const first = await service.sendMessage(input);
    assert.equal((await router.offer(first))[0].errorCode, "transport_permission_denied");
    assert.equal((await service.readReceipt({ messageId: first.messageId,
      recipientParticipantId: "receiver" })).state, "queued");
    const failed = (await store.eventsSince(workspaceId, null, 100)).events
      .find(event => event.type === "message.offer_failed");
    assert.equal(failed.payload.safeErrorCode, "transport_permission_denied");
    assert.equal(JSON.stringify(failed).includes("private-endpoint"), false);
    denied = false;
    const retried = await service.sendMessage(input);
    assert.equal(retried.messageId, first.messageId);
    assert.equal((await router.offer(retried))[0].outcome, "offered");
    await router.offer(retried);
    assert.equal(offers, 1);
    const events = (await store.eventsSince(workspaceId, null, 100)).events;
    assert.equal(events.filter(event => event.type === "message.recorded").length, 1);
    assert.equal(events.filter(event => event.type === "message.offer_succeeded").length, 1);
  });
}
