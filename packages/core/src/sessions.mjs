import { AccError, EXIT, SCHEMA_VERSION, assertPortableId, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised, isMaterialised, materialise } from "./materialisation.mjs";
import { writeWorkResponse } from "./notify.mjs";

// A hook-only adapter heartbeats only when its harness gives it a turn, so the
// staleness window is a multiple of the cadence the session itself declared
// rather than one global constant (docs/ARCHITECTURE.md, presence freshness).
const STALE_CADENCE_MULTIPLE = 3;

/**
 * @returns {"online" | "stale" | "offline"}
 */
export function classifySessionPresence(session, now, probe = () => true) {
  if (session.state === "closed") return "offline";
  if (!probe(session)) return "offline";
  const age = Date.parse(now) - Date.parse(session.heartbeatAt);
  return age <= session.heartbeatCadenceMs * STALE_CADENCE_MULTIPLE ? "online" : "stale";
}

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

export function createSessionService(ports) {
  const { store, clock, ids } = ports;
  const workspaceOf = input => input.workspaceId ?? store.workspaceId;

  async function locate(sessionId, workspaceId) {
    const ephemeral = await store.ephemeral.get("session", sessionId);
    if (ephemeral !== null) return { record: ephemeral, durable: false };
    const resolved = workspaceId ?? store.workspaceId;
    if (resolved === undefined) return null;
    const durable = (await store.snapshot(resolved)).sessions
      .find(session => session.sessionId === sessionId) ?? null;
    return durable === null ? null : { record: durable, durable: true };
  }

  function assertReplaceable(existing, probe) {
    if (existing.record.state === "closed") return;
    // Presence staleness alone never replaces ownership: an idle-but-open
    // session may resume at any moment. Only a liveness probe reporting the
    // owner gone permits a replacement generation.
    if (probe === undefined || probe(existing.record)) {
      throw new AccError(EXIT.CONFLICT, "the session id is already live",
        { sessionId: existing.record.sessionId });
    }
  }

  function assertGeneration(existing, generation, action) {
    if (existing.record.generation !== generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} a replaced session generation`,
        { sessionId: existing.record.sessionId, expected: generation,
          actual: existing.record.generation });
    }
  }

  async function openSession(input) {
    const workspaceId = workspaceOf(input);
    assertPortableId(workspaceId, "workspace id");
    assertPortableId(input.participantId, "participant id");
    const sessionId = input.sessionId ?? createId("session");
    const existing = await locate(sessionId, workspaceId);
    if (existing !== null) assertReplaceable(existing, input.probe);

    const now = clock.now();
    const session = sessionRecord({ ...input, workspaceId, sessionId }, now,
      ids.next("generation"));
    const participant = participantRecord({ ...input, workspaceId }, now);

    if (await isMaterialised(store, workspaceId)) {
      await store.transaction(async tx => {
        const replaced = tx.get("session", sessionId)?.generation ?? null;
        if (tx.get("participant", participant.participantId) === null) {
          tx.put("participant", participant.participantId, participant);
        }
        tx.put("session", sessionId, session, tx.generationOf("session", sessionId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
          actorSessionId: sessionId, type: "session.opened", occurredAt: now,
          payload: { replaced } });
      });
      return session;
    }

    await store.ephemeral.put("participant", participant.participantId, participant);
    await store.ephemeral.put("session", sessionId, session);
    // The approved trigger is the SECOND live session, not the first: a lone
    // session must be able to open and close without leaving a trace.
    const live = (await store.ephemeral.list("session")).filter(item => item.state === "open");
    if (live.length > 1) {
      await materialise(ports, { workspaceId, descriptor: input.descriptor,
        reason: "second_live_session" });
    }
    return session;
  }

  async function heartbeatSession({ sessionId, workspaceId, generation }) {
    const existing = await locate(sessionId, workspaceId);
    if (existing === null) throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
    assertGeneration(existing, generation, "heartbeat");
    const beaten = { ...existing.record, heartbeatAt: clock.now() };

    // Heartbeats never append to the semantic event feed: only open, close, and
    // presence transitions surface through cursor sync (spec section 6.4).
    if (!existing.durable) {
      await store.ephemeral.put("session", sessionId, beaten);
      return beaten;
    }
    await store.transaction(async tx =>
      tx.put("session", sessionId, beaten, tx.generationOf("session", sessionId)));
    return beaten;
  }

  async function closeSession({ sessionId, workspaceId, generation }) {
    const existing = await locate(sessionId, workspaceId);
    if (existing === null) throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
    assertGeneration(existing, generation, "close");
    const now = clock.now();
    const closed = { ...existing.record, state: "closed", heartbeatAt: now };

    if (!existing.durable) {
      // An ephemeral-only workspace vanishes with its sessions: nothing durable
      // was written, so nothing has to be cleaned up later.
      await store.ephemeral.delete("session", sessionId);
      await store.ephemeral.delete("intent", sessionId);
      return closed;
    }

    await store.transaction(async tx => {
      tx.put("session", sessionId, closed, tx.generationOf("session", sessionId));
      // Work in progress goes back on the table. A task held by a session that
      // has gone stayed `in_progress` forever, nobody else could take it, and
      // whoever asked for it was never told - a request handed to an agent that
      // closed its terminal simply vanished.
      for (const task of tx.list("task")) {
        if (task.assigneeSessionId !== sessionId) continue;
        if (task.state === "done") continue;
        const released = { ...task, assigneeSessionId: null, state: "pending" };
        tx.put("task", task.taskId, released, tx.generationOf("task", task.taskId));
        writeWorkResponse(tx, { task, actor: closed, workspaceId: closed.workspaceId,
          now, ids, outcome: "released",
          reason: "the session working on this closed before finishing it" });
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: closed.workspaceId, actorSessionId: sessionId,
          type: "task.released", occurredAt: now, payload: { taskId: task.taskId } });
      }
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: closed.workspaceId, actorSessionId: sessionId, type: "session.closed",
        occurredAt: now, payload: {} });
    });
    return closed;
  }

  return {
    openSession,
    heartbeatSession,
    closeSession,
    locateSession: locate,
    ensureMaterialised: options => ensureMaterialised(ports, options),
  };
}
