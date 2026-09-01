import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt }
  from "@agents-can-communicate/protocol";

import { receiptId, recordMessageInTransaction } from "./conversations.mjs";

const listable = (message, receipt) => receipt.state === "queued" || receipt.state === "offered"
  || (receipt.state === "retrieved" && message.obligation !== "none");

export function createInboxService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOpen(input, action) {
    const located = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (located === null || located.record.state !== "open"
      || located.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return located.record;
  }

  function requireOwnedReceipt(tx, session, messageId) {
    const message = tx.get("message", messageId);
    const id = receiptId(messageId, session.participantId);
    const receipt = tx.get("receipt", id);
    if (message === null || receipt === null) {
      throw new AccError(EXIT.CONFLICT,
        "that message is not addressed to this participant",
        { messageId, participantId: session.participantId });
    }
    return { id, message, receipt };
  }

  function advanceOwned(tx, session, messageId, state, now) {
    const owned = requireOwnedReceipt(tx, session, messageId);
    const nextState = advanceReceipt(owned.receipt.state, state);
    if (nextState === owned.receipt.state) {
      return { message: owned.message, receipt: owned.receipt };
    }
    const receipt = { ...owned.receipt, state: nextState, updatedAt: now };
    tx.put("receipt", owned.id, receipt, tx.generationOf("receipt", owned.id));
    tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
      workspaceId: session.workspaceId, actorSessionId: session.sessionId,
      type: `message.${state}`, occurredAt: now,
      payload: { messageId, recipientParticipantId: session.participantId } });
    return { message: owned.message, receipt };
  }

  async function readInbox(input) {
    const session = await requireOpen(input, "read the inbox");
    const now = clock.now();
    return store.transaction(tx => {
      const messages = new Map(tx.list("message").map(item => [item.messageId, item]));
      let selected = tx.list("receipt", receipt =>
        receipt.recipientParticipantId === session.participantId)
        .filter(receipt => messages.has(receipt.messageId));
      if (input.messageId === undefined) {
        selected = selected.filter(receipt => listable(messages.get(receipt.messageId), receipt));
      } else {
        selected = selected.filter(receipt => receipt.messageId === input.messageId
          && receipt.state !== "acknowledged");
        if (selected.length === 0) {
          throw new AccError(EXIT.CONFLICT,
            "that message is not recoverable by this participant",
            { messageId: input.messageId, participantId: session.participantId });
        }
      }
      selected.sort((left, right) => {
        const a = messages.get(left.messageId);
        const b = messages.get(right.messageId);
        return a.sentAt.localeCompare(b.sentAt) || a.messageId.localeCompare(b.messageId);
      });
      return selected.map(receipt => advanceOwned(tx, session, receipt.messageId,
        "retrieved", now));
    }, { kinds: ["message", "receipt"] });
  }

  async function acknowledgeMessage(input) {
    const session = await requireOpen(input, "acknowledge a message");
    const now = clock.now();
    return store.transaction(tx => advanceOwned(tx, session, input.messageId,
      "acknowledged", now).receipt,
    { kinds: ["message", "receipt"] });
  }

  async function replyToMessage(input) {
    const session = await requireOpen(input, "reply to a message");
    const now = clock.now();
    const replyId = ids.next("message");
    return store.transaction(tx => {
      const original = requireOwnedReceipt(tx, session, input.messageId);
      const matchingReply = tx.list("message", message =>
        message.workspaceId === session.workspaceId
        && message.fromParticipantId === session.participantId
        && message.clientMessageId === input.clientMessageId).at(0);
      if (original.receipt.state === "acknowledged" && matchingReply === undefined) {
        throw new AccError(EXIT.CONFLICT, "that message is already resolved",
          { messageId: input.messageId });
      }
      const recorded = recordMessageInTransaction({ tx, session, now, messageId: replyId, ids,
        action: "reply to a message", input: {
          clientMessageId: input.clientMessageId,
          toParticipantIds: [original.message.fromParticipantId],
          kind: "answer",
          obligation: "none",
          subject: input.subject ?? `Re: ${original.message.subject}`,
          body: input.body,
          inReplyTo: original.message.messageId,
          artifacts: input.artifacts ?? [],
          handoff: null,
        } });
      const receipt = advanceOwned(tx, session, input.messageId, "acknowledged", now).receipt;
      return { reply: recorded.message, receipt };
    }, { kinds: ["participant", "session", "message", "receipt"] });
  }

  return { readInbox, replyToMessage, acknowledgeMessage };
}
