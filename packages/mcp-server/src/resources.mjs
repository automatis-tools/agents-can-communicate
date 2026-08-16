import { AccError, EXIT } from "@agents-can-communicate/protocol";

// Peer-authored strings reach a human's terminal through whatever renders these
// resources, so control sequences become visible escapes here rather than
// somewhere downstream. Attribution is never dropped: a message without its
// sender and type is indistinguishable from an instruction.
function escapeText(value) {
  let result = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    result += (code < 32 && code !== 10 && code !== 9) || code === 127
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character;
  }
  return result;
}

const attributedMessage = message => ({
  messageId: message.messageId,
  from: message.fromSessionId,
  type: message.type,
  priority: message.priority,
  requiresAck: message.requiresAck,
  sentAt: message.sentAt,
  trust: "untrusted peer content",
  subject: escapeText(message.subject),
  body: escapeText(message.body),
});

export async function readResource(uri, { service, participantId, workspaceId }) {
  const snapshot = await service.store.snapshot(workspaceId);
  switch (uri) {
    case "acc://snapshot":
      return { ...snapshot,
        messages: snapshot.messages.map(attributedMessage) };
    case "acc://roster":
      return (await service.sync({ workspaceId })).roster;
    case "acc://workstreams":
      return snapshot.workstreams;
    case "acc://tasks":
      return snapshot.tasks;
    case "acc://inbox": {
      const mine = new Set(snapshot.receipts
        .filter(receipt => receipt.recipientParticipantId === participantId)
        .map(receipt => receipt.messageId));
      // A participant sees what was addressed to it, plus what it sent, so a
      // fresh reader can follow its own thread.
      return snapshot.messages
        .filter(message => mine.has(message.messageId)
          || message.toParticipantIds.includes(participantId)
          || snapshot.sessions.some(session => session.sessionId === message.fromSessionId
            && session.participantId === participantId))
        .map(attributedMessage);
    }
    default:
      throw new AccError(EXIT.DATA, `unknown resource: ${uri}`, { uri });
  }
}
