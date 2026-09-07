import { AccError, EXIT, SCHEMA_VERSION, assertPortableId, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { isMaterialised, materialise } from "./materialisation.mjs";

const sessionRecord = (input, now, generation) => validateRecord("session", {
  schemaVersion: SCHEMA_VERSION,
  sessionId: input.sessionId,
  participantId: input.participantId,
  workspaceId: input.workspaceId,
  generation,
  harness: input.harness,
  state: "open",
  parentSessionId: input.parentSessionId ?? null,
  checkoutRoot: input.checkoutRoot ?? null,
  branch: input.branch ?? null,
  pid: input.pid ?? null,
  // Both default to the weaker reading. A session that declares nothing is a
  // session nothing intercepts - an MCP client, or a CLI user - and claiming
  // otherwise would promise enforcement that is not there.
  enforcement: input.enforcement ?? "advisory",
  lifecycle: input.lifecycle ?? "manual",
  heartbeatCadenceMs: input.heartbeatCadenceMs,
  startedAt: now,
  heartbeatAt: now,
});

const participantRecord = (input, now) => validateRecord("participant", {
  schemaVersion: SCHEMA_VERSION,
  participantId: input.participantId,
  workspaceId: input.workspaceId,
  displayName: input.displayName ?? input.participantId,
  kind: input.participantKind ?? "agent",
  createdAt: now,
});

// Opening owns acquisition in both stores. Lifecycle updates remain in sessions.mjs.
export function createSessionOpener(ports, locate) {
  const { store, clock, ids, pidIsAlive } = ports;

  function assertReplaceable(existing, probe) {
    if (existing.record.state === "closed") return;
    // Presence staleness alone never replaces ownership: an idle-but-open
    // session may resume at any moment, and a wrong "gone" verdict there
    // self-corrects the moment that session next takes a turn. A wrong
    // replacement does not self-correct - it takes the generation, and the
    // original session's own heartbeats fail with CONFLICT from then on. So
    // only a pid confirmed dead is authority to replace; "we cannot tell" -
    // a session with no recorded pid - is never enough, however long the
    // silence.
    const live = probe ?? (record => (record.pid ?? null) === null
      || pidIsAlive(record.pid));
    if (live(existing.record)) {
      throw new AccError(EXIT.CONFLICT, "the session id is already live",
        { sessionId: existing.record.sessionId });
    }
  }

  async function openSession(input) {
    const workspaceId = input.workspaceId ?? store.workspaceId;
    assertPortableId(workspaceId, "workspace id");
    if (store.workspaceId !== undefined && workspaceId !== store.workspaceId) {
      throw new AccError(EXIT.CONFLICT, "cannot open a session in a different workspace",
        { workspaceId, storeWorkspaceId: store.workspaceId });
    }
    assertPortableId(input.participantId, "participant id");
    const sessionId = input.sessionId ?? createId("session");
    const existing = await locate(sessionId, workspaceId);
    if (existing !== null) assertReplaceable(existing, input.probe);

    const now = clock.now();
    const session = sessionRecord({ ...input, workspaceId, sessionId }, now,
      ids.next("generation"));
    const participant = participantRecord({ ...input, workspaceId }, now);

    const openDurable = async () => {
      await store.transaction(async tx => {
        const current = tx.get("session", sessionId);
        if (current !== null) assertReplaceable({ record: current }, input.probe);
        const replaced = current?.generation ?? null;
        if (tx.get("participant", participant.participantId) === null) {
          tx.put("participant", participant.participantId, participant);
        }
        tx.put("session", sessionId, session, tx.generationOf("session", sessionId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
          actorSessionId: sessionId, type: "session.opened", occurredAt: now,
          payload: { replaced } });
      }, { kinds: ["participant", "session"] });
      return session;
    };
    if (await isMaterialised(store, workspaceId)) return openDurable();

    // Preparing a participant must not rename one that already exists, or
    // recreate an ephemeral copy after promotion has taken ownership.
    await store.ephemeral.update("participant", participant.participantId, async current =>
      await isMaterialised(store, workspaceId) ? null : current ?? participant);
    const opened = await store.ephemeral.update("session", sessionId, async current => {
      // Check even when no copy remains: promotion may have retired it while
      // this opener waited. Only the durable transaction may acquire that id now.
      if (await isMaterialised(store, workspaceId)) return null;
      if (current !== null) assertReplaceable({ record: current }, input.probe);
      return session;
    });
    if (opened === null) return openDurable();
    // The approved trigger is the SECOND live session, not the first: a lone
    // session must be able to open and close without leaving a trace.
    const live = (await store.ephemeral.list("session")).filter(item => item.state === "open");
    // Another opener may have promoted us after acquisition; completing the
    // idempotent pass also retires any copies that are still pending cleanup.
    if (live.length > 1 || await isMaterialised(store, workspaceId)) {
      await materialise(ports, { workspaceId, descriptor: input.descriptor,
        reason: "second_live_session" });
    }
    return session;
  }

  return openSession;
}
