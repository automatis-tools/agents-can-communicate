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

function escapePeerValue(value) {
  if (typeof value === "string") return escapeText(value);
  if (Array.isArray(value)) return value.map(escapePeerValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, escapePeerValue(child)]));
  }
  return value;
}

const attributedMessage = message => ({
  ...escapePeerValue(message),
  trust: "untrusted peer content",
});

export async function readResource(uri, { service, participantId, workspaceId, session }) {
  switch (uri) {
    case "acc://snapshot": {
      const { snapshot } = await service.sync({ workspaceId, scope: "full" });
      return { ...snapshot, messages: snapshot.messages.map(attributedMessage) };
    }
    case "acc://roster":
      return (await service.sync({ workspaceId })).roster;
    case "acc://inbox": {
      if (session === undefined) {
        throw new AccError(EXIT.DATA, "the inbox resource requires a resolved session",
          { participantId });
      }
      const inbox = await service.readInbox({ workspaceId, sessionId: session.sessionId,
        generation: session.generation });
      return inbox.map(item => attributedMessage(item.message));
    }
    default:
      throw new AccError(EXIT.DATA, `unknown resource: ${uri}`, { uri });
  }
}
