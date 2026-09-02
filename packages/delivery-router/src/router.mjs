import { effectiveCapabilities } from "@agents-can-communicate/adapter-sdk";

const PLATFORM = `${process.platform}-${process.arch}`;
const SAFE_ERRORS = new Set(["ambiguous_recipient_sessions", "delivery_disabled",
  "recipient_busy", "recipient_unavailable", "transport_error", "transport_rejected",
  "unsupported_client_version"]);

const adaptersById = adapters => adapters instanceof Map
  ? adapters
  : new Map((Array.isArray(adapters) ? adapters : Object.values(adapters ?? {}))
    .map(adapter => [adapter.id, adapter]));

const permits = (policy, kind) => policy === "all"
  || (policy === "actionable" && ["question", "request", "handoff"].includes(kind));

const durable = (recipientParticipantId, errorCode) => ({ recipientParticipantId,
  outcome: "queued", transport: "durable", errorCode });

function safeTransport(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 100
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : "adapter";
}

export function createDeliveryRouter({ service, adapters, clock }) {
  const registry = adaptersById(adapters);

  async function recordFailure(binding, message, participantId, transport, safeErrorCode) {
    await service.recordOfferFailed({ messageId: message.messageId,
      recipientParticipantId: participantId, actorSessionId: binding.sessionId,
      transport: safeTransport(transport), adapterId: binding.adapterId,
      clientVersion: binding.clientVersion, safeErrorCode }).catch(() => null);
  }

  async function offerTo(message, participantId, now) {
    const bindings = await service.listDeliveryBindings({ participantId, now });
    if (bindings.length === 0) return durable(participantId, "recipient_unavailable");
    const permitted = bindings.filter(binding => binding.livePolicy !== "off"
      && permits(binding.livePolicy, message.kind));
    if (permitted.length === 0) return durable(participantId, "delivery_disabled");
    const reachable = permitted.filter(binding => binding.availableModes.includes("livePush"));
    if (reachable.length === 0) return durable(participantId, "recipient_unavailable");
    const certified = reachable.map(binding => ({ binding,
      adapter: registry.get(binding.adapterId) }))
      .filter(({ binding, adapter }) => adapter !== undefined
        && effectiveCapabilities(adapter,
          { clientVersion: binding.clientVersion, platform: PLATFORM }).delivery.livePush);
    if (certified.length === 0) {
      return durable(participantId, "unsupported_client_version");
    }
    if (certified.length > 1) {
      return durable(participantId, "ambiguous_recipient_sessions");
    }

    const { binding, adapter } = certified[0];
    let response;
    try {
      response = await adapter.offerMessage({ binding, message });
    } catch {
      await recordFailure(binding, message, participantId, "adapter", "transport_error");
      return durable(participantId, "transport_error");
    }
    const transport = safeTransport(response?.transport);
    if (response?.accepted !== true) {
      const code = SAFE_ERRORS.has(response?.safeErrorCode)
        ? response.safeErrorCode : "transport_rejected";
      await recordFailure(binding, message, participantId, transport, code);
      return durable(participantId, code);
    }
    if (response.clientVersion !== binding.clientVersion) {
      await recordFailure(binding, message, participantId, transport,
        "unsupported_client_version");
      return durable(participantId, "unsupported_client_version");
    }
    try {
      await service.recordOfferSucceeded({ messageId: message.messageId,
        recipientParticipantId: participantId, targetSessionId: binding.sessionId,
        targetGeneration: binding.generation, transport, adapterId: binding.adapterId,
        clientVersion: binding.clientVersion });
    } catch {
      await recordFailure(binding, message, participantId, transport, "transport_error");
      return durable(participantId, "transport_error");
    }
    return { recipientParticipantId: participantId, outcome: "offered", transport };
  }

  async function offer(message) {
    if (!Array.isArray(message?.toParticipantIds) || message.toParticipantIds.length === 0) {
      return [];
    }
    const now = clock.now();
    const outcomes = [];
    for (const participantId of message.toParticipantIds) {
      outcomes.push(await offerTo(message, participantId, now));
    }
    return outcomes;
  }

  return Object.freeze({ offer });
}
