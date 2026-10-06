import { isDeepStrictEqual } from "node:util";
import { AccError, EXIT } from "@agents-can-communicate/protocol";

const logicalContent = message => ({
  toParticipantIds: message.toParticipantIds,
  kind: message.kind,
  obligation: message.obligation,
  subject: message.subject,
  body: message.body,
  inReplyTo: message.inReplyTo,
  artifacts: message.artifacts,
  handoff: message.handoff,
  decisionChange: message.decisionChange ?? null,
});

const normalizedContent = input => logicalContent({
  toParticipantIds: input.toParticipantIds ?? [],
  kind: input.kind,
  obligation: input.obligation,
  subject: input.subject,
  body: input.body,
  inReplyTo: input.inReplyTo ?? null,
  artifacts: input.artifacts ?? [],
  handoff: input.handoff ?? null,
  decisionChange: input.decisionChange,
});

export async function findMessageRetry(tx, session, input) {
  const candidates = await tx.lookup("messageByClientKey",
    [session.workspaceId, session.participantId, input.clientMessageId]);
  for (const id of candidates) {
    const existing = await tx.load("message", id);
    if (existing === null || existing.workspaceId !== session.workspaceId
      || existing.fromParticipantId !== session.participantId
      || existing.clientMessageId !== input.clientMessageId) continue;
    if (!isDeepStrictEqual(logicalContent(existing), normalizedContent(input))) {
      throw new AccError(EXIT.CONFLICT,
        "clientMessageId was already used with different message content",
        { clientMessageId: input.clientMessageId, messageId: existing.messageId });
    }
    return existing;
  }
}
