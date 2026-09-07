import { AccError, EXIT, SCHEMA_VERSION, validateRecord }
  from "@agents-can-communicate/protocol";

import { isMaterialised } from "./materialisation.mjs";

// Intent answers "what is this session doing now?". It is awareness, not
// authorisation: an edit intent never substitutes for a claim, which is why
// resourceHints are advisory strings rather than reservations.
export function createIntentService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOwner(sessionId, workspaceId, generation, tx) {
    const current = tx === undefined
      ? (await sessions.locateSession(sessionId, workspaceId))?.record
      : tx.get("session", sessionId);
    if (current == null) {
      throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
    }
    if (current.generation !== generation) {
      throw new AccError(EXIT.CONFLICT, "intent belongs to a replaced session generation",
        { sessionId, expected: generation, actual: current.generation });
    }
    if (current.state !== "open") {
      throw new AccError(EXIT.CONFLICT, "a closed session cannot publish intent", { sessionId });
    }
    return current;
  }

  async function setIntent(input) {
    const owner = await requireOwner(input.sessionId, input.workspaceId, input.generation);
    const workspaceId = owner.workspaceId;
    const now = clock.now();
    const intent = validateRecord("intent", {
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      workspaceId,
      summary: input.summary,
      mode: input.mode,
      resourceHints: input.resourceHints ?? [],
      state: input.state ?? "active",
      updatedAt: now,
    });

    if (!await isMaterialised(store, workspaceId)) {
      const written = await store.ephemeral.update("intent", input.sessionId, async () => {
        // Promotion may have won since the branch above. Never publish a new
        // ephemeral copy that durable readers cannot see or cleanup could erase.
        if (await isMaterialised(store, workspaceId)) return null;
        await requireOwner(input.sessionId, workspaceId, input.generation);
        return intent;
      });
      if (written !== null) return written;
    }
    await store.transaction(async tx => {
      await requireOwner(input.sessionId, workspaceId, input.generation, tx);
      tx.put("intent", input.sessionId, intent, tx.generationOf("intent", input.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: input.sessionId, type: "intent.published", occurredAt: now,
        payload: { mode: intent.mode, state: intent.state } });
    }, { kinds: ["session", "intent"] });
    return intent;
  }

  async function clearIntent(input) {
    const owner = await requireOwner(input.sessionId, input.workspaceId, input.generation);
    const workspaceId = owner.workspaceId;
    if (!await isMaterialised(store, workspaceId)) {
      let cleared = false;
      await store.ephemeral.delete("intent", input.sessionId, async () => {
        if (await isMaterialised(store, workspaceId)) return false;
        await requireOwner(input.sessionId, workspaceId, input.generation);
        cleared = true;
        return true;
      });
      if (cleared) return;
      // A missing intent bypasses the delete guard. A close may have removed
      // it, or promotion may have moved it to durable storage while we waited.
      await requireOwner(input.sessionId, workspaceId, input.generation);
      if (!await isMaterialised(store, workspaceId)) return;
    }
    const now = clock.now();
    await store.transaction(async tx => {
      await requireOwner(input.sessionId, workspaceId, input.generation, tx);
      const current = tx.get("intent", input.sessionId);
      if (current === null) return;
      tx.put("intent", input.sessionId, { ...current, state: "done", updatedAt: now },
        tx.generationOf("intent", input.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: input.sessionId, type: "intent.cleared", occurredAt: now, payload: {} });
    }, { kinds: ["session", "intent"] });
  }

  return { setIntent, clearIntent };
}
