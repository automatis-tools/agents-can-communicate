import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";

// Lazy workspace materialisation. Attachment is
// universal; durable state is not created merely because a session opened
// somewhere. A lone session writes ephemeral presence and Intent only. The
// workspace materialises exactly once - at the second live session or the first
// durable object - and whatever exists ephemerally at that moment is recorded
// durably in the same transaction.
//
// Ephemeral and durable records share one shape, so materialisation is a copy
// rather than a translation. A translation step is where the two views drift.

const EPHEMERAL_KINDS = Object.freeze([
  { kind: "participant", key: "participantId", event: null },
  { kind: "session", key: "sessionId", event: "session.opened" },
  { kind: "intent", key: "sessionId", event: "intent.published" },
]);

export async function isMaterialised(store, workspaceId) {
  // One record answers this, and it is asked before every durable write.
  return (await store.snapshot(workspaceId, { kinds: ["workspace"] })).workspace !== null;
}

/**
 * `opening` is a second live session that opens here, in the transaction that
 * materialises, instead of first writing an ephemeral copy of itself to be
 * copied and retired a moment later. It opens only while the session it joins
 * is still live under the lock; otherwise it would be a lone session, which
 * leaves no durable trace, and nothing is written: the result is false and the
 * caller opens it ephemerally.
 */
export async function materialise({ store, clock, ids },
  { workspaceId, descriptor, reason, opening = null }) {
  const now = clock.now();
  const staged = [];
  let joined = true;

  await store.transaction(async tx => {
    // Ephemeral writers use this same mutex. Reading before taking it could
    // resurrect a closed owner or replace an intent with an older snapshot.
    for (const entry of EPHEMERAL_KINDS) {
      staged.push({ ...entry, records: await store.ephemeral.list(entry.kind) });
    }
    if (opening !== null && tx.get("workspace", workspaceId) === null
      && !staged.find(entry => entry.kind === "session").records.some(record =>
        record.state === "open" && record.sessionId !== opening.session.sessionId)) {
      joined = false;
      staged.length = 0;
      return;
    }
    const actorSessionId = staged.find(entry => entry.kind === "session")?.records.at(-1)?.sessionId
      ?? "session_bootstrap";
    // Asked again inside the lock. `ensureMaterialised` asks before taking it,
    // which is a check-then-act across processes: agents starting together in a
    // workspace neither had opened - the ordinary way two agents start - all saw
    // "not materialised", and every one but the first was refused with
    // `workspace ... changed under this transaction` and could not attach.
    const already = tx.get("workspace", workspaceId) !== null;
    if (!already) {
      tx.put("workspace", workspaceId, {
        schemaVersion: SCHEMA_VERSION,
        workspaceId,
        displayName: descriptor?.displayName ?? workspaceId,
        source: descriptor?.source ?? "directory",
        roots: descriptor?.roots ?? [],
        createdAt: now,
      });
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId, type: "workspace.materialised", occurredAt: now,
        payload: { reason } });
    }

    // The opening session's own ephemeral copy - left by a process that died
    // mid-open - is what the opening replaces, not a session to promote first:
    // promoting it would record the session opening twice.
    const own = opening === null ? null : staged.find(entry => entry.kind === "session")
      .records.find(record => record.sessionId === opening.session.sessionId) ?? null;
    for (const entry of staged) {
      for (const record of entry.records) {
        if (record === own) continue;
        // Whoever got here first may have promoted this record already, and
        // promoting is a copy: the ephemeral and durable shapes are the same,
        // so the one already there is the one this would write.
        if (tx.get(entry.kind, record[entry.key]) !== null) continue;
        tx.put(entry.kind, record[entry.key], record);
        if (entry.event === null) continue;
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
          actorSessionId: record.sessionId, type: entry.event, occurredAt: now,
          payload: { sessionId: record.sessionId } });
      }
    }

    if (opening !== null) {
      const { participant, session } = opening;
      const current = tx.get("session", session.sessionId) ?? own;
      opening.assertAvailable(current);
      if (tx.get("participant", participant.participantId) === null) {
        tx.put("participant", participant.participantId, participant);
      }
      tx.put("session", session.sessionId, session, tx.generationOf("session", session.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "session.opened", occurredAt: now,
        payload: { replaced: current?.generation ?? null } });
    }
  // The promoted kinds are named by the loop above, not written literally in
  // the body, so they are derived rather than repeated: a new ephemeral kind
  // added to that list is read here without anyone remembering to say so.
  }, { kinds: ["workspace", ...EPHEMERAL_KINDS.map(entry => entry.kind)] });

  if (!joined) return false;
  // The ephemeral copies are retired only after the durable transaction
  // committed, so a crash in between leaves a recoverable duplicate rather than
  // a hole.
  for (const entry of staged) {
    for (const record of entry.records) {
      await store.ephemeral.delete(entry.kind, record[entry.key]);
    }
  }
  return true;
}

export async function ensureMaterialised(ports, { workspaceId, descriptor, reason }) {
  if (await isMaterialised(ports.store, workspaceId)) return true;
  await materialise(ports, { workspaceId, descriptor, reason });
  return true;
}
