import { SCHEMA_VERSION, createId, validateRecord } from "@agents-can-communicate/protocol";

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
