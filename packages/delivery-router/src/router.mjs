const SAFE_ERRORS = new Set(["ambiguous_recipient_sessions", "delivery_disabled",
  "recipient_busy", "recipient_unavailable", "transport_error", "transport_rejected",
  "unsupported_client_version"]);
const NAMED_LIVE_TRANSPORTS = new Set(["claude-channel", "codex-app-server"]);

const adaptersById = adapters => adapters instanceof Map
  ? adapters
  : new Map((Array.isArray(adapters) ? adapters : Object.values(adapters ?? {}))
    .map(adapter => [adapter.id, adapter]));

// Everything that closes or advances a conversation is actionable: a question
// or request asks for work, an answer or decision resolves it, a handoff
// transfers it. A note informs and waits for the next turn. Room messages
// have no recipient and are never offered live.
const ACTIONABLE = new Set(["question", "request", "answer", "decision", "handoff"]);
const permits = (policy, kind) => policy === "all"
  || (policy === "actionable" && ACTIONABLE.has(kind));

// Compatibility was decided twice already - at bootstrap by the probe and at
// SessionStart by the generation-bound handshake that published this binding.
// The router validates binding identity and the adapter's answer; it does not
// impose a third, exact-version rule that would reject a client the handshake
// admitted.
const liveCapable = (adapter, binding) => adapter !== undefined
  && adapter.capabilities?.delivery?.livePush === true
  && adapter.nativeDelivery !== undefined
  && binding.availableModes.includes("livePush");

const durable = (recipientParticipantId, errorCode) => ({ recipientParticipantId,
  outcome: "queued", transport: "durable", errorCode });

const settled = receipt => ({ recipientParticipantId: receipt.recipientParticipantId,
  outcome: receipt.state, transport: "durable" });

function safeTransport(value, opaqueEndpointRef) {
  if (NAMED_LIVE_TRANSPORTS.has(value) && value !== opaqueEndpointRef) return value;
  // Both markers are fixed router vocabulary. The alternate prevents even a
  // coincidental endpoint value equal to the primary redaction from escaping.
  return opaqueEndpointRef === "live-adapter" ? "native-live" : "live-adapter";
}

export function createDeliveryRouter({ service, adapters, clock }) {
  const registry = adaptersById(adapters);

  async function recordFailure(binding, message, participantId, transport, safeErrorCode) {
    await service.recordOfferFailed({ messageId: message.messageId,
      recipientParticipantId: participantId, targetSessionId: binding.sessionId,
      targetGeneration: binding.generation,
      transport: safeTransport(transport, binding.opaqueEndpointRef), adapterId: binding.adapterId,
      clientVersion: binding.clientVersion, safeErrorCode }).catch(() => null);
  }

  async function offerTo(message, participantId, now) {
    const receipt = await service.readReceipt({ messageId: message.messageId,
      recipientParticipantId: participantId });
    if (receipt.state !== "queued") return settled(receipt);
    const liveSessions = await service.listLiveSessions({ participantId, now });
    if (liveSessions.length === 0) return durable(participantId, "recipient_unavailable");
    if (liveSessions.length > 1) {
      return durable(participantId, "ambiguous_recipient_sessions");
    }
    const [target] = liveSessions;
    const bindings = (await service.listDeliveryBindings({ participantId, now }))
      .filter(binding => binding.sessionId === target.sessionId
        && binding.generation === target.generation);
    if (bindings.length === 0) return durable(participantId, "recipient_unavailable");
    const permitted = bindings.filter(binding => binding.livePolicy !== "off"
      && permits(binding.livePolicy, message.kind));
    if (permitted.length === 0) return durable(participantId, "delivery_disabled");
    const reachable = permitted.filter(binding => binding.availableModes.includes("livePush"));
    if (reachable.length === 0) return durable(participantId, "recipient_unavailable");
    const capable = reachable.map(binding => ({ binding,
      adapter: registry.get(binding.adapterId) }))
      .filter(({ binding, adapter }) => liveCapable(adapter, binding));
    if (capable.length === 0) {
      return durable(participantId, "unsupported_client_version");
    }
    if (capable.length > 1) {
      return durable(participantId, "ambiguous_recipient_sessions");
    }

    const { binding, adapter } = capable[0];
    let response;
    try {
      // The store root is this workspace's runtime dir; the adapter resolves its
      // opaque endpoint id under it. Passed as data, never as a leak into core:
      // the router does not read what the adapter does with it.
      response = await adapter.offerMessage({ binding, message,
        runtimeDir: service.store?.root });
    } catch {
      await recordFailure(binding, message, participantId, "live-adapter", "transport_error");
      return durable(participantId, "transport_error");
    }
    const transport = safeTransport(response?.transport, binding.opaqueEndpointRef);
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
