import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt }
  from "@agents-can-communicate/protocol";

import { receiptId, recordMessageInTransaction } from "./conversations.mjs";
import { messagePage, messageSummary } from "./message-pages.mjs";
import { decisionView, isCurrentDecision } from "./decision-state.mjs";

const listable = (message, receipt) => receipt.state === "queued" || receipt.state === "offered"
  || (receipt.state === "retrieved" && message.obligation !== "none");

export function createInboxService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireOpen(input, action, tx) {
    // A solo inbox may have no durable session yet. Inside a transaction the
    // same writer lock also protects this ephemeral read from replacement.
    const current = tx === undefined
      ? (await sessions.locateSession(input.sessionId, input.workspaceId))?.record
      : tx.get("session", input.sessionId)
        ?? await store.ephemeral.get("session", input.sessionId);
    if (current == null || current.state !== "open"
      || current.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return current;
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

  async function listInbox(input) {
    const session = await requireOpen(input, "list the inbox");
    return store.transaction(async tx => {
      await requireOpen(input, "list the inbox", tx);
      const receipts = new Map(tx.list("receipt", receipt =>
        receipt.recipientParticipantId === session.participantId)
        .map(receipt => [receipt.messageId, receipt]));
      const all = tx.list("message"), view = decisionView(all);
      const messages = all.filter(message => receipts.has(message.messageId)).map(view);
      return messagePage(messages, input, {
        include: message => isCurrentDecision(message) && listable(message, receipts.get(message.messageId)),
        project: message => ({ message: messageSummary(message),
          receipt: receipts.get(message.messageId) }),
      });
    }, { kinds: ["session", "message", "receipt"] });
  }

  async function readInbox(input) {
    const session = await requireOpen(input, "read the inbox");
    const now = clock.now();
    return store.transaction(async tx => {
      await requireOpen(input, "read the inbox", tx);
      const all = tx.list("message"), view = decisionView(all);
      const messages = new Map(all.map(item => [item.messageId, view(item)]));
      let selected = tx.list("receipt", receipt =>
        receipt.recipientParticipantId === session.participantId)
        .filter(receipt => messages.has(receipt.messageId));
      if (input.messageId === undefined) {
        selected = selected.filter(receipt => listable(messages.get(receipt.messageId), receipt)
          && isCurrentDecision(messages.get(receipt.messageId)));
      } else {
        selected = selected.filter(receipt => receipt.messageId === input.messageId);
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
      // An exact read can inspect a resolved message. Inspection must neither
      // move its receipt backward nor refresh its timestamp or emit an event.
      return selected.map(receipt => receipt.state === "acknowledged"
        ? { message: messages.get(receipt.messageId), receipt }
        : { ...advanceOwned(tx, session, receipt.messageId, "retrieved", now),
          message: messages.get(receipt.messageId) });
    }, { kinds: ["session", "message", "receipt"] });
  }

  async function acknowledgeMessage(input) {
    const session = await requireOpen(input, "acknowledge a message");
    const now = clock.now();
    return store.transaction(async tx => {
      await requireOpen(input, "acknowledge a message", tx);
      return advanceOwned(tx, session, input.messageId, "acknowledged", now).receipt;
    }, { kinds: ["session", "message", "receipt"] });
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

  return { listInbox, readInbox, replyToMessage, acknowledgeMessage };
}
