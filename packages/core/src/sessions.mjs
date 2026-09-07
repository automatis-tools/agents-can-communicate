import { AccError, EXIT, SCHEMA_VERSION }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised, isMaterialised } from "./materialisation.mjs";
import { createSessionOpener } from "./session-opening.mjs";

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

export function createSessionService(ports) {
  const { store, clock, ids, pidIsAlive } = ports;

  async function locate(sessionId, workspaceId) {
    const ephemeral = await store.ephemeral.get("session", sessionId);
    const resolved = workspaceId ?? store.workspaceId ?? ephemeral?.workspaceId;
    if (resolved === undefined) return null;
    const durable = (await store.snapshot(resolved, { kinds: ["session"] })).sessions
      .find(session => session.sessionId === sessionId) ?? null;
    if (durable !== null) return { record: durable, durable: true };
    return ephemeral !== null && ephemeral.workspaceId === resolved
      ? { record: ephemeral, durable: false } : null;
  }

  function assertGeneration(existing, generation, action, workspaceId) {
    if (workspaceId !== undefined && existing.record.workspaceId !== workspaceId) {
      throw new AccError(EXIT.CONFLICT, "session is not open in this workspace",
        { sessionId: existing.record.sessionId, workspaceId });
    }
    if (existing.record.generation !== generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} a replaced session generation`,
        { sessionId: existing.record.sessionId, expected: generation,
          actual: existing.record.generation });
    }
  }

  async function heartbeatSession({ sessionId, workspaceId, generation }) {
    const beat = current => {
      if (current === null) return null;
      assertGeneration({ record: current }, generation, "heartbeat", workspaceId ?? store.workspaceId);
      if (current.state !== "open") {
        throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
      }
      return { ...current, heartbeatAt: clock.now() };
    };
    // Heartbeats never append to the semantic event feed: only open, close, and
    // presence transitions surface through cursor sync. Read and validate under
    // the writer lock, so a pending heartbeat cannot restore an old generation.
    // Promoted copies may await cleanup; their durable record already owns writes.
    const ephemeral = await store.ephemeral.update("session", sessionId, async current =>
      current !== null && !await isMaterialised(store, current.workspaceId) ? beat(current) : null);
    if (ephemeral !== null) return ephemeral;
    return store.transaction(tx => {
      const beaten = beat(tx.get("session", sessionId));
      if (beaten === null) throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
      tx.put("session", sessionId, beaten, tx.generationOf("session", sessionId));
      return beaten;
    }, { kinds: ["session"] });
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
    const ephemeral = await store.ephemeral.update("session", sessionId, async current =>
      current !== null && !await isMaterialised(store, current.workspaceId) ? resume(current) : null);
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
    const close = current => {
      assertGeneration({ record: current }, generation, "close", workspaceId ?? store.workspaceId);
      return { ...current, state: "closed", heartbeatAt: clock.now() };
    };
    let ephemeral = null;
    await store.ephemeral.delete("session", sessionId, async current => {
      if (await isMaterialised(store, current.workspaceId)) return false;
      ephemeral = close(current);
      return true;
    });
    if (ephemeral !== null) {
      // Cleanup is a separate locked write; a successor may have appeared since
      // the close. Its intent must survive the old session's delayed cleanup.
      await store.ephemeral.delete("intent", sessionId,
        async () => await store.ephemeral.get("session", sessionId) === null);
      return ephemeral;
    }
    return store.transaction(tx => {
      const current = tx.get("session", sessionId);
      if (current === null) throw new AccError(EXIT.CONFLICT, "session is not open", { sessionId });
      const closed = close(current);
      tx.put("session", sessionId, closed, tx.generationOf("session", sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: closed.workspaceId, actorSessionId: sessionId, type: "session.closed",
        occurredAt: closed.heartbeatAt, payload: {} });
      return closed;
    }, { kinds: ["session"] });
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
    openSession: createSessionOpener(ports, locate),
    resumeSession,
    heartbeatSession,
    closeSession,
    listLiveSessions,
    locateSession: locate,
    ensureMaterialised: options => ensureMaterialised(ports, options),
  };
}
