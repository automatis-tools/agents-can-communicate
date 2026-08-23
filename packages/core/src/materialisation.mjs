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

export async function materialise({ store, clock, ids }, { workspaceId, descriptor, reason }) {
  const now = clock.now();
  const staged = [];
  for (const entry of EPHEMERAL_KINDS) {
    staged.push({ ...entry, records: await store.ephemeral.list(entry.kind) });
  }
  const actorSessionId = staged.find(entry => entry.kind === "session")?.records.at(-1)?.sessionId
    ?? "session_bootstrap";

  await store.transaction(async tx => {
    tx.put("workspace", workspaceId, {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      displayName: descriptor?.displayName ?? workspaceId,
      source: descriptor?.source ?? "directory",
      roots: descriptor?.roots ?? [],
      createdAt: now,
    });
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
      actorSessionId, type: "workspace.materialised", occurredAt: now, payload: { reason } });

    for (const entry of staged) {
      for (const record of entry.records) {
        tx.put(entry.kind, record[entry.key], record);
        if (entry.event === null) continue;
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
          actorSessionId: record.sessionId, type: entry.event, occurredAt: now,
          payload: { sessionId: record.sessionId } });
      }
    }
  // The promoted kinds are named by the loop above, not written literally in
  // the body, so they are derived rather than repeated: a new ephemeral kind
  // added to that list is read here without anyone remembering to say so.
  }, { kinds: ["workspace", ...EPHEMERAL_KINDS.map(entry => entry.kind)] });

  // The ephemeral copies are retired only after the durable transaction
  // committed, so a crash in between leaves a recoverable duplicate rather than
  // a hole.
  for (const entry of staged) {
    for (const record of entry.records) {
      await store.ephemeral.delete(entry.kind, record[entry.key]);
    }
  }
}

export async function ensureMaterialised(ports, { workspaceId, descriptor, reason }) {
  if (await isMaterialised(ports.store, workspaceId)) return true;
  await materialise(ports, { workspaceId, descriptor, reason });
  return true;
}
