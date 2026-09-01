import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt }
  from "@agents-can-communicate/protocol";

import { receiptId } from "./conversations.mjs";

export const SAFE_OFFER_ERROR_CODES = Object.freeze([
  "ambiguous_recipient_sessions",
  "delivery_disabled",
  "recipient_busy",
  "recipient_unavailable",
  "transport_error",
  "transport_rejected",
  "unsupported_client_version",
]);

function missingReceipt(messageId, recipientParticipantId) {
  return new AccError(EXIT.CONFLICT, "no receipt exists for that recipient",
    { messageId, recipientParticipantId });
}

function requireAddressedReceipt(tx, messageId, recipientParticipantId) {
  const receipt = tx.get("receipt", receiptId(messageId, recipientParticipantId));
  if (receipt === null) throw missingReceipt(messageId, recipientParticipantId);
  const message = tx.get("message", messageId);
  if (message === null || message.toParticipantIds.length === 0) {
    throw new AccError(EXIT.CONFLICT, "room messages are not eligible for live offers",
      { messageId, recipientParticipantId });
  }
  return receipt;
}

export function createReceiptService(ports) {
  const { store, clock, ids } = ports;

  async function recordOfferSucceeded(input) {
    const now = clock.now();
    return store.transaction(tx => {
      const id = receiptId(input.messageId, input.recipientParticipantId);
      const receipt = requireAddressedReceipt(tx, input.messageId,
        input.recipientParticipantId);
      const target = tx.get("session", input.targetSessionId);
      if (target === null || target.state !== "open"
        || target.participantId !== input.recipientParticipantId
        || target.generation !== input.targetGeneration) {
        throw new AccError(EXIT.CONFLICT,
          "the offer target is not this recipient's open session generation",
          { targetSessionId: input.targetSessionId,
            recipientParticipantId: input.recipientParticipantId });
      }
      const offered = { ...receipt, state: advanceReceipt(receipt.state, "offered"),
        updatedAt: now };
      tx.put("receipt", id, offered, tx.generationOf("receipt", id));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: receipt.workspaceId, actorSessionId: target.sessionId,
        type: "message.offer_succeeded", occurredAt: now,
        payload: { messageId: input.messageId,
          recipientParticipantId: input.recipientParticipantId,
          targetSessionId: input.targetSessionId,
          targetGeneration: input.targetGeneration,
          transport: input.transport, adapterId: input.adapterId,
          clientVersion: input.clientVersion } });
      return offered;
    }, { kinds: ["session", "message", "receipt"], deadlineAt: input.deadlineAt });
  }

  async function recordOfferFailed(input) {
    if (!SAFE_OFFER_ERROR_CODES.includes(input.safeErrorCode)) {
      throw new AccError(EXIT.DATA, "safeErrorCode is not in the closed offer error set",
        { safeErrorCode: input.safeErrorCode });
    }
    const now = clock.now();
    return store.transaction(tx => {
      const receipt = requireAddressedReceipt(tx, input.messageId,
        input.recipientParticipantId);
      return tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: receipt.workspaceId, actorSessionId: input.actorSessionId,
        type: "message.offer_failed", occurredAt: now,
        payload: { messageId: input.messageId,
          recipientParticipantId: input.recipientParticipantId,
          transport: input.transport, adapterId: input.adapterId,
          clientVersion: input.clientVersion, safeErrorCode: input.safeErrorCode } });
    }, { kinds: ["message", "receipt"] });
  }

  return { recordOfferSucceeded, recordOfferFailed };
}
