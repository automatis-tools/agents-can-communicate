import { AccError, EXIT, SCHEMA_VERSION, assertPortableId, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised, isMaterialised, materialise } from "./materialisation.mjs";

// A hook-only adapter heartbeats only when its harness gives it a turn, so the
// staleness window is a multiple of the cadence the session itself declared
// rather than one global constant (docs/ARCHITECTURE.md, presence freshness).
const STALE_CADENCE_MULTIPLE = 3;

// Two floors, because they answer different questions and neither subsumes the
// other. UNKNOWN_EXPIRY_MS is the "cannot tell" branch: records written before
// pids were recorded, platforms with no process table, an ancestry that did not
// resolve. HARD_EXPIRY_MS exists because pids are recycled - the hazard
// writer-mutex.mjs:72 documents - so a session whose number was reissued to
// something unrelated would otherwise read as alive forever.
const UNKNOWN_EXPIRY_MS = 30 * 60_000;
const HARD_EXPIRY_MS = 24 * 60 * 60_000;

const ageBand = (session, age) =>
  age <= session.heartbeatCadenceMs * STALE_CADENCE_MULTIPLE ? "online" : "stale";

/**
 * @param {{ state: string, heartbeatAt: string, heartbeatCadenceMs: number,
 *   pid?: number | null }} session The record to classify. `pid` absent or
 *   `null` means nobody knows whether the process is alive - never that it is
 *   dead - so age alone judges it.
 * @param {string} now An ISO timestamp, compared against `session.heartbeatAt`.
 * @param {(pid: number) => boolean} pidIsAlive Required, not defaulted: the one
 *   thing that lets `offline` be reached before the age floors do. Called only
 *   when `session.pid` is a real pid, never with `null`.
 * @returns {"online" | "stale" | "offline"}
 * @throws {AccError} EXIT.USAGE when pidIsAlive is not a function.
 */
export function classifySessionPresence(session, now, pidIsAlive) {
  // Required rather than defaulted. A probe that defaults to "everyone is
  // alive" turns a forgotten call site into a check that silently passes, which
  // is the failure this repository has already shipped twice.
  if (typeof pidIsAlive !== "function") {
    throw new AccError(EXIT.USAGE, "classifySessionPresence requires a pidIsAlive probe",
      { sessionId: session?.sessionId ?? null });
  }
  if (session.state === "closed") return "offline";
  const age = Date.parse(now) - Date.parse(session.heartbeatAt);
  if (age > HARD_EXPIRY_MS) return "offline";
  const pid = session.pid ?? null;
  // A pid that answers outranks the unknown floor: a live but idle session is
  // exactly what kimi looks like between turns.
  if (pid !== null) return pidIsAlive(pid) ? ageBand(session, age) : "offline";
  return age > UNKNOWN_EXPIRY_MS ? "offline" : ageBand(session, age);
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

export function createSessionService(ports) {
  const { store, clock, ids, pidIsAlive } = ports;
  const workspaceOf = input => input.workspaceId ?? store.workspaceId;

  async function locate(sessionId, workspaceId) {
    const ephemeral = await store.ephemeral.get("session", sessionId);
    if (ephemeral !== null) return { record: ephemeral, durable: false };
    const resolved = workspaceId ?? store.workspaceId;
    if (resolved === undefined) return null;
    const durable = (await store.snapshot(resolved, { kinds: ["session"] })).sessions
      .find(session => session.sessionId === sessionId) ?? null;
    return durable === null ? null : { record: durable, durable: true };
  }

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
      }, { kinds: ["participant", "session"] });
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
      tx.put("session", sessionId, beaten, tx.generationOf("session", sessionId)),
    { kinds: ["session"] });
    return beaten;
  }

  /**
   * Continue the exact session named by a harness binding.
   *
   * Some clients emit SessionStart again after compacting their model context.
   * The binding is already the continuation token: it names both the session
   * and its generation. Refreshing that record preserves one identity without
   * pretending an unrelated or closed generation is still ours.
   *
   * Returns null when the binding can no longer be resumed, so the hook may
   * open a genuinely new session. No semantic event is appended: compaction is
   * not a second agent arriving.
   */
  async function resumeSession({ sessionId, workspaceId, generation, ...metadata }) {
    const resume = current => {
      if (current === null || current.state !== "open"
        || current.generation !== generation) return null;
      return { ...current,
      pid: metadata.pid ?? null,
      checkoutRoot: metadata.checkoutRoot ?? current.checkoutRoot,
      branch: metadata.branch ?? current.branch,
      enforcement: metadata.enforcement ?? current.enforcement,
      lifecycle: metadata.lifecycle ?? current.lifecycle,
      heartbeatCadenceMs: metadata.heartbeatCadenceMs ?? current.heartbeatCadenceMs,
      heartbeatAt: clock.now(),
      };
    };

    // The compare and replacement happen under the ephemeral store's writer
    // lock. A close or a replacement generation can win before this update or
    // after it, but can never be overwritten from a record read beforehand.
    const ephemeral = await store.ephemeral.update("session", sessionId, resume);
    if (ephemeral !== null) return ephemeral;

    // Re-read and validate inside the durable transaction for the same reason.
    // Using generationOf only as the put token is insufficient: it protects
    // the envelope write, not the semantic generation carried by the record.
    const resolvedWorkspace = workspaceId ?? store.workspaceId;
    if (resolvedWorkspace === undefined) return null;
    return store.transaction(async tx => {
      const current = tx.get("session", sessionId);
      const resumed = resume(current);
      if (resumed === null) return null;
      tx.put("session", sessionId, resumed, tx.generationOf("session", sessionId));
      return resumed;
    }, { kinds: ["session"] });
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
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: closed.workspaceId, actorSessionId: sessionId, type: "session.closed",
        occurredAt: now, payload: {} });
    }, { kinds: ["session"] });
    return closed;
  }

  async function listLiveSessions({ participantId, workspaceId, now = clock.now() }) {
    const resolved = workspaceId ?? store.workspaceId;
    const snapshot = resolved === undefined ? null
      : await store.snapshot(resolved, { kinds: ["workspace", "session"] });
    const records = snapshot?.workspace === null
      ? await store.ephemeral.list("session")
      : snapshot?.sessions ?? await store.ephemeral.list("session");
    return records
      .filter(session => session.participantId === participantId
        && classifySessionPresence(session, now, pidIsAlive) !== "offline")
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map(session => ({ sessionId: session.sessionId, generation: session.generation }));
  }

  return {
    openSession,
    resumeSession,
    heartbeatSession,
    closeSession,
    listLiveSessions,
    locateSession: locate,
    ensureMaterialised: options => ensureMaterialised(ports, options),
  };
}
