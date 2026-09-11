import { evaluateVersionContract } from "@agents-can-communicate/adapter-sdk";

import { refreshExpiredBinding } from "./refresh-binding.mjs";

const SAFE_ERRORS = new Set(["ambiguous_recipient_sessions", "delivery_disabled",
  "recipient_busy", "recipient_unavailable", "transport_error", "transport_rejected", "transport_permission_denied",
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
const LIVE_POLICIES = new Set(["off", "actionable", "all"]);
const permits = (policy, kind) => policy === "all"
  || (policy === "actionable" && ACTIONABLE.has(kind));

// A native-delivery contract is captured per platform, and the only platform a
// router can judge an offer against is the one it is running on - which is why
// both entrypoints pass exactly this value. Leaving the parameter optional made
// its absence silently disable every live offer: `undefined` reached the
// contract check as "platform_not_captured" and the offer was refused as an
// unsupported client version. Default it here instead, so a router that is
// handed nothing behaves as the host it runs on. Injection stays available for
// callers that need to judge against another platform.
const HOST_PLATFORM = `${process.platform}-${process.arch}`;

// evaluateVersionContract answers two different questions with one field.
// "below_minimum_version", "known_bad_version", "version_unavailable" and
// "prerelease_not_captured" are a capture reading the reported version and
// refusing it. "platform_not_captured" is the opposite: a complete, valid
// declaration that records nothing for the platform this router runs on. That
// is not a malformed adapter, it is the ordinary shape of every shipped
// adapter away from darwin-arm64 - the only platform any of them has captured
// - so reading it as a refusal disables live delivery on Linux entirely.
//
// "native_delivery_unsupported" is absent deliberately: liveCapable already
// required a nativeDelivery declaration before an offer was attempted, so the
// contract check is never handed an adapter without one.
const UNCAPTURED_PLATFORM = "platform_not_captured";

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

export function createDeliveryRouter({ service, adapters, clock, platform = HOST_PLATFORM,
  readLivePolicy }) {
  const registry = adaptersById(adapters);

  async function policyFor(adapter, binding) {
    if (adapter?.nativeDelivery?.policySource !== "installation-record") {
      return LIVE_POLICIES.has(binding.livePolicy) ? binding.livePolicy : "off";
    }
    if (typeof readLivePolicy !== "function") return "off";
    try {
      const policy = await readLivePolicy({ adapter, binding });
      return LIVE_POLICIES.has(policy) ? policy : "off";
    } catch {
      return "off";
    }
  }

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
    // Core keeps its existing 24-hour presence hard expiry. Refreshing an
    // endpoint lease never sends a hook heartbeat: a daemon is reachability,
    // not evidence that this particular session thread is still present.
    const liveSessions = await service.listLiveSessions({ participantId, now });
    if (liveSessions.length === 0) return durable(participantId, "recipient_unavailable");
    if (liveSessions.length > 1) {
      return durable(participantId, "ambiguous_recipient_sessions");
    }
    const [target] = liveSessions;
    const bindings = (await service.listDeliveryBindings({
      participantId, now, includeExpired: true }))
      .filter(binding => binding.sessionId === target.sessionId
        && binding.generation === target.generation);
    if (bindings.length === 0) return durable(participantId, "recipient_unavailable");
    const evaluated = await Promise.all(bindings.map(async binding => {
      const adapter = registry.get(binding.adapterId);
      return { binding, adapter, policy: await policyFor(adapter, binding) };
    }));
    const permitted = evaluated.filter(({ policy }) => permits(policy, message.kind));
    if (permitted.length === 0) return durable(participantId, "delivery_disabled");
    const reachable = permitted.filter(({ binding }) => binding.availableModes.includes("livePush"));
    if (reachable.length === 0) return durable(participantId, "recipient_unavailable");
    const capable = reachable.filter(({ binding, adapter }) => liveCapable(adapter, binding));
    if (capable.length === 0) {
      return durable(participantId, "unsupported_client_version");
    }
    if (capable.length > 1) {
      return durable(participantId, "ambiguous_recipient_sessions");
    }

    let { binding } = capable[0];
    const { adapter } = capable[0];
    if (Date.parse(binding.leaseUntil) <= Date.parse(now)) {
      const refreshed = await refreshExpiredBinding({ service, adapter, binding,
        runtimeDir: service.store?.root, platform, clock });
      if (!refreshed) return durable(participantId, "recipient_unavailable");
      const current = (await service.listDeliveryBindings({
        participantId, now: clock.now() })).filter(item => item.sessionId === binding.sessionId
          && item.generation === binding.generation
          && item.adapterId === binding.adapterId
          && item.clientVersion === binding.clientVersion
          && item.opaqueEndpointRef === binding.opaqueEndpointRef);
      if (current.length !== 1) return durable(participantId, "recipient_unavailable");
      [binding] = current;
    }
    const currentPolicy = await policyFor(adapter, binding);
    if (!permits(currentPolicy, message.kind)) {
      return durable(participantId, "delivery_disabled");
    }
    // A refresh RPC or policy read can overlap another session opening. The
    // receiver must still be the sole live session when we hand off to transport.
    const currentSessions = await service.listLiveSessions({ participantId, now: clock.now() });
    if (currentSessions.length > 1) return durable(participantId, "ambiguous_recipient_sessions");
    if (currentSessions.length !== 1 || currentSessions[0].sessionId !== binding.sessionId
      || currentSessions[0].generation !== binding.generation) {
      return durable(participantId, "recipient_unavailable");
    }
    // Every recipient gets a fresh decision snapshot after async lookup. A
    // previous recipient may have replaced it while processing their offer.
    // A send already in flight cannot be recalled by a later peer assertion.
    if (message.kind === "decision") {
      message = (await service.sync({ scope: "history", messageId: message.messageId })).items[0];
      if (!message.decisionStatus.isHead) return settled(await service.readReceipt({
        messageId: message.messageId, recipientParticipantId: participantId }));
    }
    // Consent and session reads can outlive retirement or a re-handshake in
    // the same generation. Core filters retired, expired and stale-generation
    // bindings; require the selected identity and live mode immediately before
    // transport, with no further awaited policy/session work in between.
    const currentBindings = (await service.listDeliveryBindings({
      participantId, now: clock.now() })).filter(item => item.sessionId === binding.sessionId
        && item.generation === binding.generation
        && item.adapterId === binding.adapterId
        && item.clientVersion === binding.clientVersion
        && item.opaqueEndpointRef === binding.opaqueEndpointRef
        && item.availableModes.includes("livePush")
        && Date.parse(item.leaseUntil) > Date.parse(clock.now()));
    if (currentBindings.length !== 1) return durable(participantId, "recipient_unavailable");
    const currentBinding = { ...currentBindings[0], livePolicy: currentPolicy };
    let response;
    try {
      // The store root is this workspace's runtime dir; the adapter resolves its
      // opaque endpoint id under it. Passed as data, never as a leak into core:
      // the router does not read what the adapter does with it.
      response = await adapter.offerMessage({ binding: currentBinding, message,
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
    // Compatibility was already decided at bind time; a serving version that
    // still satisfies the adapter's captured contract keeps offering, even
    // when it differs from the value recorded when the binding was created.
    // Only a version below the captured minimum or on the denylist refuses.
    // When the contract captured nothing for this platform there is no
    // minimum to judge against, so the offer keeps the rule this path had
    // before the contract gate existed: the version that answered must be the
    // one the binding recorded. defineAdapter rejecting a partial declaration
    // does not make this unreachable - a complete, valid contract that names
    // only darwin-arm64 says nothing about linux-x64, and that is every
    // shipped adapter on Linux.
    const versionRule = evaluateVersionContract(adapter, { clientVersion: response.clientVersion, platform });
    const admitted = versionRule.reasonCode === null
      || (versionRule.reasonCode === UNCAPTURED_PLATFORM
        && response.clientVersion === binding.clientVersion);
    if (!admitted) {
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
    if (message.kind === "decision") {
      message = (await service.sync({ scope: "history", messageId: message.messageId })).items[0];
      if (!message.decisionStatus.isHead) {
        return Promise.all(message.toParticipantIds.map(async recipientParticipantId => settled(
          await service.readReceipt({ messageId: message.messageId, recipientParticipantId }))));
      }
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
