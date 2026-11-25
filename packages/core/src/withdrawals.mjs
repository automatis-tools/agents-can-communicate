import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt } from "@agents-can-communicate/protocol";

import { receiptId, recordMessageInTransaction } from "./conversations.mjs";
import { assertExactTransaction } from "./ports.mjs";
import { publicReceipt } from "./receipts.mjs";

// Withdrawing a pending question or request (#145). The withdrawal closes each
// receipt that still owes an answer, as an acknowledgement does, and marks it in
// `extensions.withdrawn`: ACC 0.15 shares the store and refuses an unknown receipt
// state, record field or event type, and an acknowledged receipt is one it already
// leaves out of the inbox and of attention. A note in the same thread tells each
// of those recipients why, since one may already be working on it.

const WITHDRAWABLE = new Set(["question", "request"]);
const SUBJECT_MAX = 500;

const conflict = (message, details) => new AccError(EXIT.CONFLICT, message, details);

export function createWithdrawalService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function receiptsOf(tx, workspaceId, messageId) {
    const receipts = [];
    for (const id of await tx.lookup("receiptsByMessage", [workspaceId, messageId])) {
      const receipt = await tx.load("receipt", id);
      if (receipt?.messageId === messageId && receipt.workspaceId === workspaceId) receipts.push(receipt);
    }
    return receipts.sort((a, b) => a.recipientParticipantId.localeCompare(b.recipientParticipantId));
  }

  // A repeated client key returns what it recorded, also once nothing is pending.
  async function recordedRetry(tx, session, input) {
    if (input.clientMessageId === undefined) return null;
    for (const id of await tx.lookup("messageByClientKey",
      [session.workspaceId, session.participantId, input.clientMessageId])) {
      const note = await tx.load("message", id);
      if (note?.extensions?.withdraws === input.messageId
        && note.fromParticipantId === session.participantId) return note;
    }
    return null;
  }

  async function withdrawMessage(input) {
    const session = (await sessions.locateSession(input.sessionId, input.workspaceId))?.record;
    if (session == null || session.state !== "open" || session.generation !== input.generation) {
      throw conflict("cannot withdraw a message from this session generation",
        { sessionId: input.sessionId });
    }
    const now = clock.now();
    const noteId = ids.next("message");
    return store.transaction(async tx => {
      assertExactTransaction(tx);
      const original = await tx.load("message", input.messageId);
      if (original === null || original.workspaceId !== session.workspaceId) {
        throw conflict("no message with that id is in this workspace", { messageId: input.messageId });
      }
      if (original.fromParticipantId !== session.participantId) {
        throw conflict("only the participant that sent a message can withdraw it",
          { messageId: input.messageId, fromParticipantId: original.fromParticipantId });
      }
      if (!WITHDRAWABLE.has(original.kind)) {
        throw conflict(`a ${original.kind} cannot be withdrawn; only a question or a request can`
          + (original.kind === "decision" ? " (withdraw a decision with message --withdraws)" : ""),
        { messageId: input.messageId, kind: original.kind });
      }
      const receipts = await receiptsOf(tx, session.workspaceId, original.messageId);
      const retried = await recordedRetry(tx, session, input);
      if (retried !== null) {
        return { note: retried, created: false, withdrawn: receipts
          .filter(receipt => receipt.extensions?.withdrawn?.messageId === retried.messageId)
          .map(publicReceipt) };
      }
      const pending = receipts.filter(receipt => receipt.state !== "acknowledged");
      if (pending.length === 0) {
        throw conflict("every recipient already answered or acknowledged this message",
          { messageId: original.messageId });
      }
      const recorded = await recordMessageInTransaction({ tx, session, now, messageId: noteId, ids,
        action: "withdraw a message", input: {
          clientMessageId: input.clientMessageId ?? `withdraw_${noteId}`,
          toParticipantIds: pending.map(receipt => receipt.recipientParticipantId),
          kind: "note", obligation: "none",
          subject: [...`Withdrawn: ${original.subject}`].slice(0, SUBJECT_MAX).join(""),
          body: input.reason, inReplyTo: original.messageId, artifacts: [], handoff: null,
          extensions: { withdraws: original.messageId },
        } });
      const withdrawn = pending.map(receipt => {
        const id = receiptId(original.messageId, receipt.recipientParticipantId);
        // Spread, never rebuilt: an older or newer ACC may keep its own facts here.
        const closed = { ...receipt, state: advanceReceipt(receipt.state, "acknowledged"), updatedAt: now,
          extensions: { obligation: original.obligation, ...receipt.extensions,
            withdrawn: { messageId: recorded.message.messageId, at: now } } };
        tx.put("receipt", id, closed, tx.generationOf("receipt", id));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: session.workspaceId, actorSessionId: session.sessionId,
          type: "message.acknowledged", occurredAt: now,
          payload: { messageId: original.messageId, recipientParticipantId: receipt.recipientParticipantId,
            withdrawnBy: recorded.message.messageId } });
        return publicReceipt(closed);
      });
      return { note: recorded.message, created: true, withdrawn };
    }, { kinds: ["participant", "session", "message", "receipt"], exactKinds: ["message", "receipt"] });
  }

  return { withdrawMessage };
}
