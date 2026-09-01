import { AccError, EXIT } from "@agents-can-communicate/protocol";

const PAGE_SIZE = 256;

export const projectReleasedClaim = claim => ({
  claimId: claim.claimId,
  resource: claim.resource,
  mode: claim.mode,
});

function conflict(message) {
  return new AccError(EXIT.CONFLICT,
    "clientMessageId belongs to a different finish generation",
    { clientMessageId: message.clientMessageId, messageId: message.messageId });
}

async function allEvents(store, workspaceId) {
  const events = [];
  let cursor = null;
  while (true) {
    const page = await store.eventsSince(workspaceId, cursor, PAGE_SIZE);
    if (page.events.length === 0) return events;
    events.push(...page.events);
    cursor = page.cursor;
  }
}

function claimProjection(events, releaseIndex) {
  const release = events[releaseIndex];
  const claimId = release.payload.claimId;
  const facts = events.slice(0, releaseIndex + 1).findLast(event =>
    (event.type === "claim.acquired" || event.type === "claim.renewed")
      && event.payload.claimId === claimId
      && typeof event.payload.resource === "string");
  return facts === undefined ? null : {
    claimId,
    resource: facts.payload.resource,
    mode: facts.payload.mode,
  };
}

export async function reconstructFinishRetry({ store, workspaceId, session, message }) {
  const events = await allEvents(store, workspaceId);
  const recordedIndex = events.findIndex(event => event.type === "message.recorded"
    && event.payload.messageId === message.messageId
    && event.actorSessionId === session.sessionId);
  if (session.state !== "closed" || recordedIndex === -1) throw conflict(message);

  const laterOpen = events.slice(recordedIndex + 1).some(event =>
    event.type === "session.opened" && event.actorSessionId === session.sessionId);
  if (laterOpen) throw conflict(message);

  const closedOffset = events.slice(recordedIndex + 1).findIndex(event =>
    event.type === "session.closed" && event.actorSessionId === session.sessionId);
  if (closedOffset === -1) throw conflict(message);
  const closedIndex = recordedIndex + closedOffset + 1;
  const releaseIndexes = events.map((event, index) => ({ event, index }))
    .filter(({ event, index }) => index > recordedIndex && index < closedIndex
      && event.type === "claim.released"
      && event.actorSessionId === session.sessionId)
    .map(({ index }) => index);
  const releasedClaims = releaseIndexes.map(index => claimProjection(events, index));
  if (releasedClaims.includes(null)) throw conflict(message);
  return releasedClaims;
}
