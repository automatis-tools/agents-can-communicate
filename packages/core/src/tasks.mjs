import { AccError, EXIT, SCHEMA_VERSION, createId, transitionTask as stepTask, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";
import { classifySessionPresence } from "./sessions.mjs";
import { closeRequestReceipt, writeWorkResponse } from "./notify.mjs";

// Dependency completion unblocks tasks deterministically, inside the same
// transaction that completed the dependency. It must never depend on a model
// remembering to re-evaluate the graph.
//
// Exported because a caller may supply its own task id - an adapter mirroring
// an external tracker, for instance - and that is the only way a create can
// close a cycle. Without an explicit id the guard would be unreachable.
export function wouldCycle(tasks, taskId, dependsOn) {
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  const seen = new Set();
  const stack = [...dependsOn];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

const blockedBy = (task, byId) => task.dependsOn
  .filter(id => (byId.get(id)?.state ?? "pending") !== "done");

/**
 * Write one task inside a transaction the caller already owns.
 *
 * Separated so that `acc request` - which creates the task and tells the
 * recipient about it - can do both as one write. A request that produced a task
 * and then failed to mention it would leave work addressed to an agent that was
 * never told, which is worse than no request at all.
 */
export function writeTask(tx, { input, session, workspaceId, now, ids }) {
  const taskId = input.taskId ?? createId("task");
  const existing = tx.list("task");
  const dependsOn = input.dependsOn ?? [];
  for (const dependency of dependsOn) {
    if (tx.get("task", dependency) === null) {
      throw new AccError(EXIT.DATA, "a dependency does not exist", { dependency });
    }
  }
  if (wouldCycle(existing, taskId, dependsOn)) {
    throw new AccError(EXIT.DATA, "the dependency graph would contain a cycle", { taskId });
  }
  // A workstream is optional - "finish these tests for me" should not require
  // inventing a project first - but a named one has to exist, or the task hangs
  // off nothing and nobody notices.
  const workstreamId = input.workstreamId ?? null;
  if (workstreamId !== null && tx.get("workstream", workstreamId) === null) {
    throw new AccError(EXIT.DATA, "the workstream does not exist", { workstreamId });
  }
  const record = validateRecord("task", {
    schemaVersion: SCHEMA_VERSION,
    taskId,
    workstreamId,
    workspaceId,
    title: input.title,
    detail: input.detail ?? null,
    state: blockedBy({ dependsOn }, new Map(existing.map(task => [task.taskId, task])))
      .length > 0 ? "blocked" : "pending",
    // Addressed to a participant, so the request survives that agent closing
    // its terminal. Whoever picks it up is recorded separately.
    assigneeParticipantId: input.assigneeParticipantId ?? null,
    assigneeSessionId: null,
    requestedByParticipantId: input.requestedByParticipantId ?? null,
    dependsOn,
    acceptance: input.acceptance ?? [],
    createdAt: now,
  });
  tx.put("task", taskId, record);
  tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
    actorSessionId: session.sessionId, type: "task.created", occurredAt: now,
    payload: { taskId, state: record.state,
      assigneeParticipantId: record.assigneeParticipantId } });
  return record;
}

export function createTaskService(ports, workstreams) {
  const { store, clock, ids } = ports;

  async function createTask(input) {
    const session = await workstreams.requireOpenSession(input, "create a task");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      record = writeTask(tx, { input, session, workspaceId, now, ids });
    });
    return record;
  }

  async function claimTask(input) {
    const session = await workstreams.requireOpenSession(input, "claim a task");
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("task", input.taskId);
      if (existing === null) {
        throw new AccError(EXIT.DATA, "the task does not exist", { taskId: input.taskId });
      }
      if (existing.assigneeSessionId !== null
        && existing.assigneeSessionId !== session.sessionId) {
        // A holder that is gone is not a holder. Closing a session hands its
        // work back, so this is the crash case: no session end ever arrived and
        // presence has decayed. Staleness alone does not release it - that is
        // the same rule claims follow, because an idle agent may be thinking
        // rather than dead - but it can be taken over deliberately.
        const holder = tx.get("session", existing.assigneeSessionId);
        const presence = holder === null
          ? "offline"
          : classifySessionPresence(holder, now);
        if (presence === "online") {
          throw new AccError(EXIT.CONFLICT, "the task already has an assignee",
            { taskId: input.taskId, assigneeSessionId: existing.assigneeSessionId });
        }
        if (presence === "stale" && input.force !== true) {
          throw new AccError(EXIT.CONFLICT,
            "the task is held by a session that has gone quiet; take it with force",
            { taskId: input.taskId, assigneeSessionId: existing.assigneeSessionId,
              presence });
        }
      }
      // Work addressed to one participant is not picked up by another. Taking
      // an unaddressed task is open to anyone, which is what makes a request
      // with no named recipient a request to the room.
      if (existing.assigneeParticipantId !== null
        && existing.assigneeParticipantId !== session.participantId) {
        throw new AccError(EXIT.CONFLICT, "the task is addressed to another participant",
          { taskId: input.taskId,
            assigneeParticipantId: existing.assigneeParticipantId });
      }
      record = { ...existing, assigneeSessionId: session.sessionId,
        assigneeParticipantId: existing.assigneeParticipantId ?? session.participantId,
        state: stepTask(existing.state, "in_progress") };
      // Whoever asked is waiting on an answer, and "someone is on it" is one.
      writeWorkResponse(tx, { task: record, actor: session,
        workspaceId: session.workspaceId, now, ids, outcome: "accepted" });
      tx.put("task", input.taskId, record, tx.generationOf("task", input.taskId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "task.claimed", occurredAt: now, payload: { taskId: input.taskId } });
    });
    return record;
  }

  async function transitionTask(input) {
    const session = await workstreams.requireOpenSession(input, "transition a task");
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("task", input.taskId);
      if (existing === null) {
        throw new AccError(EXIT.DATA, "the task does not exist", { taskId: input.taskId });
      }
      record = { ...existing, state: stepTask(existing.state, input.state) };
      tx.put("task", input.taskId, record, tx.generationOf("task", input.taskId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "task.transitioned", occurredAt: now,
        payload: { taskId: input.taskId, state: record.state } });

      if (record.state === "done" || record.state === "review") {
        writeWorkResponse(tx, { task: record, actor: session,
          workspaceId: session.workspaceId, now, ids, outcome: record.state });
      }
      // Doing the work answers the request that asked for it.
      if (record.state === "done") closeRequestReceipt(tx, { task: record, actor: session, now, ids });
      if (record.state !== "done") return;
      // Unblock dependents here, in the same transaction, so the graph is
      // never left in a state that needs someone to notice it later.
      const byId = new Map(tx.list("task").map(task => [task.taskId, task]));
      byId.set(record.taskId, record);
      for (const dependent of byId.values()) {
        if (dependent.state !== "blocked") continue;
        if (blockedBy(dependent, byId).length > 0) continue;
        const unblocked = { ...dependent, state: "pending" };
        tx.put("task", dependent.taskId, unblocked,
          tx.generationOf("task", dependent.taskId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: session.workspaceId, actorSessionId: session.sessionId,
          type: "task.unblocked", occurredAt: now, payload: { taskId: dependent.taskId } });
      }
    });
    return record;
  }

  /**
   * Refuse a request, with a reason.
   *
   * The task returns to unclaimed rather than being deleted: the work is still
   * wanted, it is just not this agent's. Leaving a request pending forever was
   * the only way to say no, and it looks identical to not having read it.
   */
  async function declineTask(input) {
    const session = await workstreams.requireOpenSession(input, "decline a task");
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const existing = tx.get("task", input.taskId);
      if (existing === null) {
        throw new AccError(EXIT.DATA, "the task does not exist", { taskId: input.taskId });
      }
      record = { ...existing, assigneeParticipantId: null, assigneeSessionId: null,
        state: "pending" };
      tx.put("task", input.taskId, record, tx.generationOf("task", input.taskId));
      writeWorkResponse(tx, { task: existing, actor: session,
        workspaceId: session.workspaceId, now, ids, outcome: "declined",
        reason: input.reason ?? null });
      // Refusing is also an answer, so the request stops demanding one.
      closeRequestReceipt(tx, { task: existing, actor: session, now, ids });
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "task.declined", occurredAt: now,
        payload: { taskId: input.taskId, reason: input.reason ?? null } });
    });
    return record;
  }

  return { createTask, claimTask, transitionTask, declineTask };
}
