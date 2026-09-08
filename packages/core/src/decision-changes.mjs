import { AccError, EXIT, assertDecisionChange } from "@agents-can-communicate/protocol";

// Resolve inherited recipients before retry comparison. Target messages and
// their recipient sets are immutable, so receipt advancement cannot alter a retry.
export function prepareDecisionChange(tx, input, session) {
  if (input.decisionChange !== undefined) {
    throw new AccError(EXIT.USAGE, "send a decision change using supersedes or withdraws");
  }
  if (input.supersedes === undefined && input.withdraws === undefined) return input;
  if (input.kind !== "decision" || (input.supersedes !== undefined && input.withdraws !== undefined)) {
    throw new AccError(EXIT.USAGE, "only decisions accept either supersedes or withdraws, never both");
  }
  const decisionChange = assertDecisionChange({
    action: input.supersedes === undefined ? "withdraw" : "replace",
    messageIds: input.supersedes ?? input.withdraws,
  });
  decisionChange.messageIds = [...decisionChange.messageIds].sort();
  const targets = decisionChange.messageIds.map(messageId => {
    const message = tx.get("message", messageId);
    if (message?.kind !== "decision" || message.workspaceId !== session.workspaceId) {
      throw new AccError(EXIT.DATA, "a decision change must reference existing decisions in this workspace",
        { messageId });
    }
    return message;
  });
  if (new Set(input.toParticipantIds).size !== input.toParticipantIds.length) {
    throw new AccError(EXIT.USAGE, "a participant may be addressed only once");
  }
  const targetIds = new Set(decisionChange.messageIds);
  const inherited = [...targets.map(message => message.fromParticipantId),
    ...tx.list("receipt", receipt => targetIds.has(receipt.messageId))
      .map(receipt => receipt.recipientParticipantId)]
    .filter(participantId => participantId !== session.participantId);
  return { ...input, decisionChange,
    toParticipantIds: [...new Set([...input.toParticipantIds, ...inherited])].sort() };
}
