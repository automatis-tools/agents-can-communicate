import { AccError, EXIT, SCHEMA_VERSION, validateRecord }
  from "@agents-can-communicate/protocol";

import { isMaterialised } from "./materialisation.mjs";

// Intent answers "what is this session doing now?". It is awareness, not
// authorisation: an edit intent never substitutes for a claim, which is why
// resourceHints are advisory strings rather than reservations.
export function createIntentService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOwner(sessionId, workspaceId, generation) {
    const existing = await sessions.locateSession(sessionId, workspaceId);
    if (existing === null) {
      throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
    }
    if (existing.record.generation !== generation) {
      throw new AccError(EXIT.CONFLICT, "intent belongs to a replaced session generation",
        { sessionId, expected: generation, actual: existing.record.generation });
    }
    if (existing.record.state !== "open") {
      throw new AccError(EXIT.CONFLICT, "a closed session cannot publish intent", { sessionId });
    }
    return existing;
  }

  async function setIntent(input) {
    const owner = await requireOwner(input.sessionId, input.workspaceId, input.generation);
    const workspaceId = owner.record.workspaceId;
    const now = clock.now();
    const intent = validateRecord("intent", {
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      workspaceId,
      summary: input.summary,
      mode: input.mode,
      resourceHints: input.resourceHints ?? [],
      workstreamId: input.workstreamId ?? null,
      state: input.state ?? "active",
      updatedAt: now,
    });

    if (!await isMaterialised(store, workspaceId)) {
      await store.ephemeral.put("intent", input.sessionId, intent);
      return intent;
    }
    await store.transaction(async tx => {
      tx.put("intent", input.sessionId, intent, tx.generationOf("intent", input.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: input.sessionId, type: "intent.published", occurredAt: now,
        payload: { mode: intent.mode, state: intent.state } });
    });
    return intent;
  }

  async function clearIntent(input) {
    const owner = await requireOwner(input.sessionId, input.workspaceId, input.generation);
    const workspaceId = owner.record.workspaceId;
    if (!await isMaterialised(store, workspaceId)) {
      await store.ephemeral.delete("intent", input.sessionId);
      return;
    }
    const now = clock.now();
    await store.transaction(async tx => {
      const current = tx.get("intent", input.sessionId);
      if (current === null) return;
      tx.put("intent", input.sessionId, { ...current, state: "done", updatedAt: now },
        tx.generationOf("intent", input.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: input.sessionId, type: "intent.cleared", occurredAt: now, payload: {} });
    });
  }

  return { setIntent, clearIntent };
}
