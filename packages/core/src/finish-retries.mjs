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

function correlatedReleaseIndexes(events, recordedIndex, closedIndex, session, message) {
  const close = events[closedIndex];
  const payload = close.payload;
  const keys = Object.keys(payload).sort();
  const expectedKeys = ["cause", "messageId", "releasedClaimIds", "sessionGeneration"];
  if (keys.length !== expectedKeys.length
    || !keys.every((key, index) => key === expectedKeys[index])
    || payload.cause !== "finish"
    || payload.messageId !== message.messageId
    || payload.sessionGeneration !== session.generation
    || !Array.isArray(payload.releasedClaimIds)
    || payload.releasedClaimIds.some(claimId => typeof claimId !== "string")
    || new Set(payload.releasedClaimIds).size !== payload.releasedClaimIds.length) {
    throw conflict(message);
  }

  const between = events.slice(recordedIndex + 1, closedIndex);
  if (between.length !== payload.releasedClaimIds.length
    || between.some(event => event.type !== "claim.released"
      || event.actorSessionId !== session.sessionId
      || event.payload.authority !== null
      || event.payload.reason !== null)) {
    throw conflict(message);
  }
  const actualIds = between.map(event => event.payload.claimId);
  if (actualIds.some((claimId, index) => claimId !== payload.releasedClaimIds[index])) {
    throw conflict(message);
  }
  return actualIds.map((claimId, offset) => recordedIndex + offset + 1);
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
  const releaseIndexes = correlatedReleaseIndexes(events, recordedIndex, closedIndex,
    session, message);
  const releasedClaims = releaseIndexes.map(index => claimProjection(events, index));
  if (releasedClaims.includes(null)) throw conflict(message);
  const snapshot = await store.snapshot(workspaceId, { kinds: ["claim"] });
  if (snapshot.claims.some(claim => claim.ownerSessionId === session.sessionId)) {
    throw conflict(message);
  }
  return releasedClaims;
}
