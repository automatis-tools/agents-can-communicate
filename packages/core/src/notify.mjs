import { SCHEMA_VERSION, advanceDelivery, createId, validateRecord }
  from "@agents-can-communicate/protocol";

const receiptId = (messageId, recipient) => `${messageId}--${recipient}`;

/**
 * Tell whoever asked for a task what became of it.
 *
 * A request is a question, so it deserves an answer: taken up, declined, or
 * finished. Before this the task recorded who it was for and not who was
 * waiting, so nothing could be said back and the asker had to poll and diff
 * task states to find out.
 *
 * It is a message rather than an attention rule on purpose. Messages carry
 * delivery state, so the answer is put in front of the asker exactly once
 * instead of repeating in every turn until they act on it.
 *
 * Written into the caller's transaction: an accepted task whose acceptance was
 * never sent is the same silence this exists to remove.
 */
export function writeWorkResponse(tx, { task, actor, workspaceId, now, ids, outcome,
  reason = null }) {
  const asker = task.requestedByParticipantId;
  // Nobody asked, or the asker is doing it themselves - there is no one to tell.
  if (asker === null || asker === undefined || asker === actor.participantId) return null;

  const messageId = createId("message");
  // The subject already carries the outcome and the title. The body says who
  // and which task, so the asker can follow it up without going and looking.
  const head = `${outcome} by ${actor.participantId} (task ${task.taskId})`;
  const body = reason === null ? head : `${head}\n\n${reason}`;
  const record = validateRecord("message", {
    schemaVersion: SCHEMA_VERSION,
    messageId,
    workspaceId,
    fromSessionId: actor.sessionId,
    toParticipantIds: [asker],
    type: "work_response",
    subject: `${outcome}: ${task.title}`,
    body,
    priority: "normal",
    workstreamId: task.workstreamId,
    taskId: task.taskId,
    inReplyTo: null,
    // The asker is being told, not asked. Requiring an acknowledgement here
    // would leave every finished request sitting in someone's attention list.
    requiresAck: false,
    artifacts: [],
    sentAt: now,
  });
  tx.put("message", messageId, record);
  tx.put("receipt", receiptId(messageId, asker), validateRecord("receipt", {
    schemaVersion: SCHEMA_VERSION,
    messageId,
    workspaceId,
    recipientParticipantId: asker,
    state: "queued",
    updatedAt: now,
  }));
  tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
    actorSessionId: actor.sessionId, type: `work.${outcome}`, occurredAt: now,
    payload: { taskId: task.taskId, messageId, asker } });
  return record;
}

/**
 * Close the request a task came from, once it has been answered.
 *
 * `acc request` marks its message as needing an acknowledgement, which raises a
 * `direct_request` attention item for the recipient. Finishing the work did not
 * clear it, and nothing else could: the operation existed in the core and was
 * reachable from no surface. So every completed request left a line repeating in
 * the doer's turn for good.
 *
 * Doing the work is the acknowledgement. An explicit `acc ack` exists for
 * messages that are not tied to a task.
 */
export function closeRequestReceipt(tx, { task, actor, now, ids }) {
  for (const message of tx.list("message")) {
    if (message.taskId !== task.taskId || message.type !== "work_request") continue;
    if (!message.toParticipantIds.includes(actor.participantId)) continue;
    const id = `${message.messageId}--${actor.participantId}`;
    const existing = tx.get("receipt", id);
    if (existing === null || existing.state === "acknowledged") continue;
    const record = { ...existing, state: advanceDelivery(existing.state, "acknowledged"),
      updatedAt: now };
    tx.put("receipt", id, record, tx.generationOf("receipt", id));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
      workspaceId: existing.workspaceId, actorSessionId: actor.sessionId,
      type: "message.acknowledged", occurredAt: now,
      payload: { messageId: message.messageId,
        recipientParticipantId: actor.participantId } });
  }
}
