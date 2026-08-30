import { AccError, EXIT, SCHEMA_VERSION, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";
import { classifySessionPresence } from "./sessions.mjs";

// A workstream groups related collaboration. It may have zero or one
// coordinator lease, and the coordinator plans - it is never the transport,
// the durable owner, or an information gatekeeper.
export function createWorkstreamService(ports, sessions) {
  const { store, clock, ids, pidIsAlive } = ports;

  async function requireOpenSession(input, action) {
    const existing = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (existing === null || existing.record.state !== "open"
      || existing.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return existing.record;
  }

  async function createWorkstream(input) {
    const session = await requireOpenSession(input, "create a workstream");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    const now = clock.now();
    const workstreamId = createId("workstream");
    const record = validateRecord("workstream", {
      schemaVersion: SCHEMA_VERSION,
      workstreamId,
      workspaceId,
      title: input.title,
      objective: input.objective,
      // A workstream never acquires a coordinator merely by being created.
      coordinatorSessionId: null,
      state: "open",
      createdAt: now,
    });
    await store.transaction(async tx => {
      tx.put("workstream", workstreamId, record);
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "workstream.created", occurredAt: now,
        payload: { workstreamId } });
    }, { kinds: ["workstream"] });
    return record;
  }

  async function acquireCoordinator(input) {
    const session = await requireOpenSession(input, "coordinate");
    const now = clock.now();
    const snapshot = await store.snapshot(session.workspaceId,
      { kinds: ["session", "workstream"] });
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("workstream", input.workstreamId);
      if (existing === null) {
        throw new AccError(EXIT.CONFLICT, "the workstream does not exist",
          { workstreamId: input.workstreamId });
      }
      const held = existing.coordinatorSessionId;
      if (held !== null && held !== session.sessionId) {
        const holder = snapshot.sessions.find(item => item.sessionId === held);
        const presence = holder === undefined ? "offline"
          : classifySessionPresence(holder, now, pidIsAlive);
        // A coordinator lease is replaced only when the holder is genuinely
        // gone or policy says so - not because a peer would like the role.
        if (presence !== "offline" && input.authority !== "human"
          && input.authority !== "policy") {
          throw new AccError(EXIT.CONFLICT, "the workstream already has a coordinator",
            { workstreamId: input.workstreamId, coordinatorSessionId: held,
              coordinatorPresence: presence });
        }
      }
      record = { ...existing, coordinatorSessionId: session.sessionId };
      tx.put("workstream", input.workstreamId, record,
        tx.generationOf("workstream", input.workstreamId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "workstream.coordinator_acquired", occurredAt: now,
        payload: { workstreamId: input.workstreamId, replaced: held } });
    }, { kinds: ["workstream"] });
    return record;
  }

  async function releaseCoordinator(input) {
    const session = await requireOpenSession(input, "release coordination");
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("workstream", input.workstreamId);
      if (existing === null || existing.coordinatorSessionId !== session.sessionId) {
        throw new AccError(EXIT.CONFLICT, "only the coordinator may release the lease",
          { workstreamId: input.workstreamId });
      }
      record = { ...existing, coordinatorSessionId: null };
      tx.put("workstream", input.workstreamId, record,
        tx.generationOf("workstream", input.workstreamId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "workstream.coordinator_released", occurredAt: now,
        payload: { workstreamId: input.workstreamId } });
    }, { kinds: ["workstream"] });
    return record;
  }

  return { createWorkstream, acquireCoordinator, releaseCoordinator, requireOpenSession };
}
