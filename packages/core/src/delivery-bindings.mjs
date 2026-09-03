import { AccError, EXIT, SCHEMA_VERSION, validateRecord }
  from "@agents-can-communicate/protocol";

function conflict(sessionId) {
  return new AccError(EXIT.CONFLICT,
    "cannot publish a delivery binding for anything but this open session generation",
    { sessionId });
}

export function createDeliveryBindingService(ports, sessions) {
  const { store, clock } = ports;

  async function currentBindings(now) {
    const bindings = await store.ephemeral.list("deliveryBinding");
    const current = [];
    for (const binding of bindings) {
      const located = await sessions.locateSession(binding.sessionId);
      if (located?.record.state !== "open"
        || located.record.generation !== binding.generation) continue;
      // A retirement is final. It is kept as a record rather than deleted so a
      // stale generation cannot race a successor's publication, and it must
      // never be read back as a live endpoint.
      if (binding.retiredAt !== null && binding.retiredAt !== undefined) continue;
      current.push({ binding, participantId: located.record.participantId,
        reachable: Date.parse(binding.leaseUntil) > Date.parse(now) });
    }
    return current.sort((left, right) =>
      left.binding.sessionId.localeCompare(right.binding.sessionId));
  }

  async function publishDeliveryBinding(input) {
    const located = await sessions.locateSession(input.sessionId);
    if (located?.record.state !== "open" || located.record.generation !== input.generation) {
      throw conflict(input.sessionId);
    }
    let binding;
    try {
      binding = validateRecord("deliveryBinding", {
        schemaVersion: SCHEMA_VERSION,
        sessionId: input.sessionId,
        generation: input.generation,
        adapterId: input.adapterId,
        clientVersion: input.clientVersion,
        availableModes: Array.isArray(input.availableModes)
          ? [...input.availableModes] : input.availableModes,
        livePolicy: input.livePolicy,
        opaqueEndpointRef: input.opaqueEndpointRef,
        leaseUntil: input.leaseUntil,
        retiredAt: null,
      });
    } catch (error) {
      if (error?.details?.field === "opaqueEndpointRef") {
        throw new AccError(error.code, error.message, { field: "opaqueEndpointRef" });
      }
      throw error;
    }
    await store.ephemeral.update("deliveryBinding", binding.sessionId, async () => {
      // This check runs while the ephemeral key's writer lock is held. A stale
      // publisher that passed the earlier check cannot replace a successor's
      // endpoint after that successor becomes current.
      const current = await sessions.locateSession(input.sessionId);
      if (current?.record.state !== "open"
        || current.record.generation !== input.generation) {
        throw conflict(input.sessionId);
      }
      return binding;
    });
    const stillCurrent = await sessions.locateSession(input.sessionId);
    if (stillCurrent?.record.state !== "open"
      || stillCurrent.record.generation !== input.generation) {
      // Do not delete here: a successor generation may have published between
      // our put and this recheck. A stale record is filtered on every read and
      // is safe; deleting a successor's endpoint is not.
      throw conflict(input.sessionId);
    }
    return binding;
  }

  // Clearing is an in-place retirement under the same writer lock as
  // publication. The store's update contract has no deletion sentinel and its
  // delete() takes the same mutex, so this is the one atomic form: a stale
  // generation cannot retire a successor's endpoint, and an absent or
  // already-retired binding stays as it is.
  //
  // The retirement is recorded as its own fact rather than as an expired lease.
  // Expiry and retirement used to be the same edit, so a channel still renewing
  // its endpoint could extend a binding the session had already given up.
  async function clearDeliveryBinding({ sessionId, generation }) {
    await store.ephemeral.update("deliveryBinding", sessionId, async current => {
      if (current === null || current === undefined) return null;
      if (current.generation !== generation) throw conflict(sessionId);
      if (current.retiredAt !== null && current.retiredAt !== undefined) return null;
      const now = clock.now();
      return { ...current, leaseUntil: now, retiredAt: now };
    });
  }

  /**
   * Extend the lease on a binding whose endpoint is still being served.
   *
   * Only the process holding the endpoint knows it is alive, and for a client
   * with no heartbeat nothing else refreshes this record: measured on a real
   * Claude 2.1.259 session, the channel kept its registration renewed while
   * this lease went stale about a minute after the last turn, and the router
   * stopped offering to a session that was still serving.
   *
   * Narrow on purpose. It moves the lease and nothing else, refuses anything
   * but the current open generation, and will not revive a retired binding.
   */
  async function refreshDeliveryBinding({ sessionId, generation, leaseUntil }) {
    const located = await sessions.locateSession(sessionId);
    if (located?.record.state !== "open" || located.record.generation !== generation) {
      throw conflict(sessionId);
    }
    await store.ephemeral.update("deliveryBinding", sessionId, async current => {
      if (current === null || current === undefined) return null;
      if (current.generation !== generation) throw conflict(sessionId);
      if (current.retiredAt !== null && current.retiredAt !== undefined) return null;
      return validateRecord("deliveryBinding", { ...current, leaseUntil });
    });
  }

  async function listDeliveryBindings({ participantId, now }) {
    return (await currentBindings(now))
      .filter(item => item.participantId === participantId && item.reachable)
      .map(item => item.binding);
  }

  return { publishDeliveryBinding, clearDeliveryBinding, refreshDeliveryBinding,
    listDeliveryBindings, currentBindings };
}
