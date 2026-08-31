import { AccError, EXIT, SCHEMA_VERSION, advanceDelivery, createId, validateRecord }
  from "@agents-can-communicate/protocol";

const receiptId = (messageId, recipient) => `${messageId}--${recipient}`;
const unresolved = (message, receipt) => receipt.state === "recorded"
  || receipt.state === "queued"
  || (message.requiresAck && (receipt.state === "injected" || receipt.state === "seen"));

/** Narrow, recipient-owned message reads and replies. */
export function createInboxService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOpen(input, action) {
    const existing = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (existing === null || existing.record.state !== "open"
      || existing.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return existing.record;
  }

  async function readInbox(input) {
    const session = await requireOpen(input, "read the inbox");
    const snapshot = await store.snapshot(session.workspaceId,
      { kinds: ["message", "receipt"] });
    const messages = new Map(snapshot.messages.map(message => [message.messageId, message]));
    let addressed = snapshot.receipts
      .filter(receipt => receipt.recipientParticipantId === session.participantId)
      .map(receipt => ({ message: messages.get(receipt.messageId), receipt }))
      .filter(item => item.message !== undefined);
    if (input.messageId !== undefined) {
      addressed = addressed.filter(item => item.message.messageId === input.messageId
        && item.receipt.state !== "acknowledged" && item.receipt.state !== "failed");
      if (addressed.length === 0) {
        throw new AccError(EXIT.CONFLICT,
          "that message is not recoverable by this participant",
          { messageId: input.messageId, participantId: session.participantId });
      }
    } else {
      addressed = addressed.filter(item => unresolved(item.message, item.receipt));
    }
    addressed.sort((left, right) => left.message.sentAt.localeCompare(right.message.sentAt)
      || left.message.messageId.localeCompare(right.message.messageId));
    if (addressed.length === 0) return [];

    const now = clock.now();
    const shown = [];
    await store.transaction(async tx => {
      for (const item of addressed) {
        const id = receiptId(item.message.messageId, session.participantId);
        const current = tx.get("receipt", id);
        const receipt = { ...current, state: advanceDelivery(current.state, "seen"),
          updatedAt: now };
        tx.put("receipt", id, receipt, tx.generationOf("receipt", id));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: session.workspaceId, actorSessionId: session.sessionId,
          type: "message.seen", occurredAt: now,
          payload: { messageId: item.message.messageId,
            recipientParticipantId: session.participantId } });
        shown.push({ message: item.message, receipt });
      }
    }, { kinds: ["receipt"] });
    return shown;
  }

  async function replyToMessage(input) {
    const session = await requireOpen(input, "reply to a message");
    const now = clock.now();
    const replyId = createId("message");
    let result = null;
    await store.transaction(async tx => {
      const original = tx.get("message", input.messageId);
      const ownReceiptId = receiptId(input.messageId, session.participantId);
      const originalReceipt = tx.get("receipt", ownReceiptId);
      if (original === null || originalReceipt === null
        || !original.toParticipantIds.includes(session.participantId)) {
        throw new AccError(EXIT.CONFLICT,
          "that message is not addressed to this participant",
          { messageId: input.messageId, participantId: session.participantId });
      }
      if (originalReceipt.state === "acknowledged" || originalReceipt.state === "failed") {
        throw new AccError(EXIT.CONFLICT, "that message is already resolved",
          { messageId: input.messageId, state: originalReceipt.state });
      }
      const reply = validateRecord("message", {
        schemaVersion: SCHEMA_VERSION,
        messageId: replyId,
        workspaceId: session.workspaceId,
        fromSessionId: session.sessionId,
        fromParticipantId: session.participantId,
        toParticipantIds: [original.fromParticipantId],
        type: input.type ?? "answer",
        subject: input.subject ?? `Re: ${original.subject}`,
        body: input.body,
        priority: input.priority ?? "normal",
        workstreamId: original.workstreamId,
        taskId: original.taskId,
        inReplyTo: original.messageId,
        requiresAck: false,
        artifacts: input.artifacts ?? [],
        sentAt: now,
      });
      const acknowledged = { ...originalReceipt,
        state: advanceDelivery(originalReceipt.state, "acknowledged"), updatedAt: now };
      const replyReceipt = validateRecord("receipt", {
        schemaVersion: SCHEMA_VERSION,
        messageId: replyId,
        workspaceId: session.workspaceId,
        recipientParticipantId: original.fromParticipantId,
        state: "queued",
        updatedAt: now,
      });
      tx.put("message", replyId, reply);
      tx.put("receipt", receiptId(replyId, original.fromParticipantId), replyReceipt);
      tx.put("receipt", ownReceiptId, acknowledged,
        tx.generationOf("receipt", ownReceiptId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "message.sent", occurredAt: now,
        payload: { messageId: replyId, type: reply.type,
          recipients: reply.toParticipantIds } });
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "message.acknowledged", occurredAt: now,
        payload: { messageId: original.messageId,
          recipientParticipantId: session.participantId } });
      result = { reply, receipt: acknowledged };
    }, { kinds: ["message", "receipt"] });
    return result;
  }

  return { readInbox, replyToMessage };
}
