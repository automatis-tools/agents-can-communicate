import { AccError, EXIT } from "./errors.mjs";

export const VALID_OBLIGATIONS = Object.freeze({
  note: Object.freeze(["none"]),
  question: Object.freeze(["reply"]),
  request: Object.freeze(["reply"]),
  answer: Object.freeze(["none"]),
  decision: Object.freeze(["none", "acknowledge"]),
  handoff: Object.freeze(["none", "acknowledge"]),
});

export const MESSAGE_KINDS = Object.freeze(Object.keys(VALID_OBLIGATIONS));
export const OBLIGATIONS = Object.freeze(["none", "acknowledge", "reply"]);

const data = (message, details) => {
  throw new AccError(EXIT.DATA, message, details);
};

export function assertMessageSemantics(message) {
  const room = message.toParticipantIds.length === 0;
  if (room && !["note", "decision", "handoff"].includes(message.kind)) {
    data(`a room message cannot have kind ${message.kind}`, { kind: message.kind });
  }
  if (room && message.obligation !== "none") {
    data("a room message must have obligation none", { obligation: message.obligation });
  }

  const valid = VALID_OBLIGATIONS[message.kind] ?? [];
  if (!valid.includes(message.obligation)) {
    data(`message obligation ${message.obligation} is invalid for ${message.kind}`,
      { kind: message.kind, obligation: message.obligation });
  }

  const root = message.threadId === message.messageId;
  if (message.kind === "answer" && message.inReplyTo === null) {
    data("an answer requires inReplyTo", { messageId: message.messageId });
  }
  if (message.kind === "answer" && root) {
    data("an answer cannot be a thread root", { messageId: message.messageId });
  }
  if (message.inReplyTo === null && !root) {
    data("a thread root requires threadId to equal messageId",
      { threadId: message.threadId, messageId: message.messageId });
  }
  if (message.inReplyTo !== null && root) {
    data("a thread root must have inReplyTo null", { inReplyTo: message.inReplyTo });
  }

  if (message.kind === "handoff" && message.handoff === null) {
    data("a handoff message requires a handoff payload", { messageId: message.messageId });
  }
  if (!room && message.kind === "handoff" && message.obligation !== "acknowledge") {
    data("an addressed handoff requires acknowledgement",
      { messageId: message.messageId, obligation: message.obligation });
  }
  if (message.kind !== "handoff" && message.handoff !== null) {
    data(`a ${message.kind} message must have handoff null`, { kind: message.kind });
  }
  return message;
}
