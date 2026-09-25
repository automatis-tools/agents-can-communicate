import { decisionView, isCurrentDecision } from "./decision-state.mjs";
import { dueForRepeat, offerFacts } from "./receipts.mjs";

export async function nextTurnDelivery(store, input = {}) {
  if (typeof input.participantId !== "string" || input.participantId === "") {
    return { queuedMessages: [], liveOfferedMessageIds: [], reminderMessageIds: [],
      roomMessageIds: [], repeatMessages: [], repeatOffers: [] };
  }
  const snapshot = await store.snapshot(input.workspaceId ?? store.workspaceId,
    { kinds: ["message", "receipt"] });
  const receiptByMessage = new Map(snapshot.receipts
    .filter(item => item.recipientParticipantId === input.participantId)
    .map(item => [item.messageId, item]));
  const eligible = snapshot.messages.map(decisionView(snapshot.messages))
    .filter(message => isCurrentDecision(message) && receiptByMessage.has(message.messageId)
    && message.fromSessionId !== input.exceptSessionId)
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt)
      || left.messageId.localeCompare(right.messageId));
  // Only a caller that will show them asks. A repeat taken out of the reminder
  // lists and then never shown would be the one message this turn forgot.
  const repeatMessages = input.repeats === true
    ? eligible.filter(message => dueForRepeat(message,
      receiptByMessage.get(message.messageId), input.now))
    : [];
  const repeating = new Set(repeatMessages.map(message => message.messageId));
  return {
    queuedMessages: eligible.filter(message =>
      receiptByMessage.get(message.messageId).state === "queued"),
    liveOfferedMessageIds: eligible.filter(message => message.toParticipantIds.length > 0
      && receiptByMessage.get(message.messageId).state === "offered"
      && !repeating.has(message.messageId))
      .map(message => message.messageId),
    // A missing body is not evidence of delivery: a degraded adapter may have
    // withheld it. Only this recipient's durable receipt permits a reminder.
    reminderMessageIds: eligible.filter(message => message.obligation !== "none"
      && ["offered", "retrieved"].includes(receiptByMessage.get(message.messageId).state)
      && !repeating.has(message.messageId))
      .map(message => message.messageId),
    roomMessageIds: eligible.filter(message => message.toParticipantIds.length === 0)
      .map(message => message.messageId),
    // After the queued bodies, so a new message wins the byte budget first.
    repeatMessages,
    repeatOffers: repeatMessages.map(message => {
      const { transport, at } = offerFacts(receiptByMessage.get(message.messageId));
      return { messageId: message.messageId, transport, at };
    }),
  };
}
