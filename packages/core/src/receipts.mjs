import { AccError, EXIT, SCHEMA_VERSION, advanceReceipt }
  from "@agents-can-communicate/protocol";

import { receiptId } from "./conversations.mjs";

// How long a live offer may stand with nothing after it before the next turn
// shows the body once more. Above the 90th percentile of the time models took
// to retrieve, acknowledge or answer an offered message on real stores.
export const REPEAT_OFFER_AFTER_MS = 15 * 60 * 1000;

/**
 * How and when a transport accepted this receipt's message, if anyone recorded it.
 *
 * Kept in `extensions` because a new receipt field would fail validation in an
 * older ACC reading the same store. A receipt that an older ACC offered carries
 * nothing here, and reads as `null`: unknown, never guessed.
 */
export function offerFacts(receipt) {
  const offer = receipt?.extensions?.offer;
  if (offer === null || typeof offer !== "object" || Array.isArray(offer)
    || typeof offer.transport !== "string" || typeof offer.at !== "string"
    || !Number.isFinite(Date.parse(offer.at))) return null;
  return { transport: offer.transport, at: offer.at,
    repeatedAt: offer.repeatedAt == null ? null : String(offer.repeatedAt) };
}

/**
 * A live transport accepted this message, and nothing followed for long enough.
 *
 * A next-turn offer is recorded only after the hook's stdout carried the body,
 * which is as close to the model as ACC can see, so it is never repeated. A live
 * offer proves a transport took the bytes. Once, the next turn shows it again.
 */
export function dueForRepeat(message, receipt, now) {
  const offer = offerFacts(receipt);
  return message != null && message.toParticipantIds.length > 0
    && receipt?.state === "offered" && offer !== null
    && offer.transport !== "next-turn" && offer.repeatedAt === null
    && Date.parse(now) - Date.parse(offer.at) >= REPEAT_OFFER_AFTER_MS;
}

export const SAFE_OFFER_ERROR_CODES = Object.freeze([
  "ambiguous_recipient_sessions",
  "delivery_disabled",
  "recipient_busy",
  "recipient_unavailable",
  "transport_error",
  "transport_rejected",
  "transport_permission_denied",
  "unsupported_client_version",
]);

function missingReceipt(messageId, recipientParticipantId) {
  return new AccError(EXIT.CONFLICT, "no receipt exists for that recipient",
    { messageId, recipientParticipantId });
}

function requireReceipt(tx, messageId, recipientParticipantId) {
  const receipt = tx.get("receipt", receiptId(messageId, recipientParticipantId));
  if (receipt === null) throw missingReceipt(messageId, recipientParticipantId);
  const message = tx.get("message", messageId);
  if (message === null) throw missingReceipt(messageId, recipientParticipantId);
  return { message, receipt };
}

function requireOfferableReceipt(tx, input, { allowRoomNextTurn }) {
  const found = requireReceipt(tx, input.messageId, input.recipientParticipantId);
  if (found.message.toParticipantIds.length === 0
    && (!allowRoomNextTurn || input.transport !== "next-turn")) {
    throw new AccError(EXIT.CONFLICT, "room messages are not eligible for live offers",
      { messageId: input.messageId, recipientParticipantId: input.recipientParticipantId });
  }
  return found.receipt;
}

function requireTarget(tx, input, { mustBeOpen }) {
  const target = tx.get("session", input.targetSessionId);
  if (target === null || (mustBeOpen && target.state !== "open")
    || target.participantId !== input.recipientParticipantId
    || target.generation !== input.targetGeneration) {
    throw new AccError(EXIT.CONFLICT,
      "the offer target is not this recipient's session generation",
      { targetSessionId: input.targetSessionId,
        recipientParticipantId: input.recipientParticipantId });
  }
  return target;
}

export function createReceiptService(ports) {
  const { store, clock, ids } = ports;

  async function readReceipt(input) {
    return store.transaction(tx => requireReceipt(tx, input.messageId,
      input.recipientParticipantId).receipt, { kinds: ["message", "receipt"] });
  }

  async function recordOfferSucceeded(input) {
    const repeat = input.repeat === true;
    if (repeat && input.transport !== "next-turn") {
      throw new AccError(EXIT.DATA, "a repeated offer travels only through the next turn",
        { messageId: input.messageId, transport: input.transport });
    }
    const now = clock.now();
    return store.transaction(tx => {
      const id = receiptId(input.messageId, input.recipientParticipantId);
      const receipt = requireOfferableReceipt(tx, input, { allowRoomNextTurn: true });
      const target = requireTarget(tx, input, { mustBeOpen: true });
      const success = extra => tx.append({ schemaVersion: SCHEMA_VERSION,
        eventId: ids.next("event"), workspaceId: receipt.workspaceId,
        actorSessionId: target.sessionId, type: "message.offer_succeeded", occurredAt: now,
        payload: { messageId: input.messageId,
          recipientParticipantId: input.recipientParticipantId,
          targetSessionId: input.targetSessionId,
          targetGeneration: input.targetGeneration,
          transport: input.transport, adapterId: input.adapterId,
          clientVersion: input.clientVersion, ...extra } });
      if (repeat) {
        // Judged again under the writer: a retrieval, an acknowledgement or
        // another hook's repeat may have landed since this one was selected.
        // The receipt keeps its state and its time; only the attempt is new.
        if (!dueForRepeat(tx.get("message", input.messageId), receipt, now)) return receipt;
        const repeated = { ...receipt, extensions: { ...receipt.extensions,
          offer: { ...offerFacts(receipt), repeatedAt: now } } };
        tx.put("receipt", id, repeated, tx.generationOf("receipt", id));
        success({ repeat: true });
        return repeated;
      }
      // A retrieval or acknowledgement may win after a transport accepted but
      // before this transaction acquired the writer. That stronger truth must
      // remain in place. The same rule makes a repeated successful commit a
      // read-only operation rather than another success event.
      if (receipt.state !== "queued") return receipt;
      const offered = { ...receipt, state: advanceReceipt(receipt.state, "offered"),
        updatedAt: now, extensions: { ...receipt.extensions,
          offer: { transport: input.transport, at: now, repeatedAt: null } } };
      tx.put("receipt", id, offered, tx.generationOf("receipt", id));
      success({});
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
      const receipt = requireOfferableReceipt(tx, input, { allowRoomNextTurn: false });
      const target = requireTarget(tx, input, { mustBeOpen: false });
      return tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: receipt.workspaceId, actorSessionId: target.sessionId,
        type: "message.offer_failed", occurredAt: now,
        payload: { messageId: input.messageId,
          recipientParticipantId: input.recipientParticipantId,
          targetSessionId: target.sessionId,
          targetGeneration: target.generation,
          transport: input.transport, adapterId: input.adapterId,
          clientVersion: input.clientVersion, safeErrorCode: input.safeErrorCode } });
    }, { kinds: ["session", "message", "receipt"] });
  }

  return { readReceipt, recordOfferSucceeded, recordOfferFailed };
}
