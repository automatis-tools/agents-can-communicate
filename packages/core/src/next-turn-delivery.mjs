export async function nextTurnDelivery(store, input = {}) {
  if (typeof input.participantId !== "string" || input.participantId === "") {
    return { queuedMessages: [], liveOfferedMessageIds: [], reminderMessageIds: [],
      roomMessageIds: [] };
  }
  const snapshot = await store.snapshot(input.workspaceId ?? store.workspaceId,
    { kinds: ["message", "receipt"] });
  const receiptByMessage = new Map(snapshot.receipts
    .filter(item => item.recipientParticipantId === input.participantId)
    .map(item => [item.messageId, item]));
  const eligible = snapshot.messages.filter(message => receiptByMessage.has(message.messageId)
    && message.fromSessionId !== input.exceptSessionId)
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt)
      || left.messageId.localeCompare(right.messageId));
  return {
    queuedMessages: eligible.filter(message =>
      receiptByMessage.get(message.messageId).state === "queued"),
    liveOfferedMessageIds: eligible.filter(message => message.toParticipantIds.length > 0
      && receiptByMessage.get(message.messageId).state === "offered")
      .map(message => message.messageId),
    // A missing body is not evidence of delivery: a degraded adapter may have
    // withheld it. Only this recipient's durable receipt permits a reminder.
    reminderMessageIds: eligible.filter(message => message.obligation !== "none"
      && ["offered", "retrieved"].includes(receiptByMessage.get(message.messageId).state))
      .map(message => message.messageId),
    roomMessageIds: eligible.filter(message => message.toParticipantIds.length === 0)
      .map(message => message.messageId),
  };
}
