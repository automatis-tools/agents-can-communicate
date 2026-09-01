import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { overlaps } from "./claims.mjs";
import { classifySessionPresence } from "./sessions.mjs";

export const ATTENTION_PRIORITY = Object.freeze({
  reply_required: 1,
  acknowledgement_required: 2,
  recipient_unavailable: 3,
  claim_conflict: 4,
  claim_contended: 5,
  claim_expired: 6,
});

function obligationItems(snapshot, participantId) {
  const messages = new Map((snapshot.messages ?? []).map(item => [item.messageId, item]));
  return (snapshot.receipts ?? []).flatMap(receipt => {
    if (receipt.recipientParticipantId !== participantId
      || receipt.state === "acknowledged") return [];
    const message = messages.get(receipt.messageId);
    const kind = message?.obligation === "reply" ? "reply_required"
      : message?.obligation === "acknowledge" ? "acknowledgement_required" : null;
    const action = kind === "reply_required" ? "a reply" : "acknowledgement";
    return kind === null ? [] : [{ kind, priority: ATTENTION_PRIORITY[kind],
      sourceId: message.messageId,
      summary: `message ${message.messageId} from ${message.fromParticipantId} is a `
        + `${message.kind} requiring ${action}` }];
  });
}

function presenceByParticipant(snapshot, now, pidIsAlive) {
  const online = new Set();
  for (const session of snapshot.sessions ?? []) {
    if (classifySessionPresence(session, now, pidIsAlive) === "online") {
      online.add(session.participantId);
    }
  }
  return online;
}

function unavailableRecipients(snapshot, participantId, now, pidIsAlive) {
  const online = presenceByParticipant(snapshot, now, pidIsAlive);
  const receipts = snapshot.receipts ?? [];
  return (snapshot.messages ?? []).flatMap(message => {
    if (message.fromParticipantId !== participantId || message.toParticipantIds?.length === 0
      || message.obligation === "none") return [];
    return receipts.filter(receipt => receipt.messageId === message.messageId
      && receipt.state !== "acknowledged"
      && !online.has(receipt.recipientParticipantId))
      .map(receipt => ({ kind: "recipient_unavailable",
        priority: ATTENTION_PRIORITY.recipient_unavailable,
        sourceId: message.messageId,
        summary: `${message.subject} - ${receipt.recipientParticipantId} is unavailable` }));
  });
}

function expiredClaims(snapshot, session, now) {
  if (session == null) return [];
  return (snapshot.claims ?? []).filter(claim => claim.ownerSessionId === session.sessionId
    && Date.parse(claim.expiresAt) <= Date.parse(now))
    .map(claim => ({ kind: "claim_expired", priority: ATTENTION_PRIORITY.claim_expired,
      sourceId: claim.claimId,
      summary: `${claim.resource} - your claim has run out, and peers can write to it` }));
}

function claimConflicts(snapshot, session, now) {
  const mine = (snapshot.intents ?? []).find(intent => intent.sessionId === session?.sessionId);
  if (mine === undefined) return [];
  return (snapshot.claims ?? []).filter(claim => claim.ownerSessionId !== session.sessionId
    && Date.parse(claim.expiresAt) > Date.parse(now)
    && mine.resourceHints.some(hint => overlaps(hint, claim.resource)))
    .map(claim => ({ kind: "claim_conflict", priority: ATTENTION_PRIORITY.claim_conflict,
      sourceId: claim.claimId,
      summary: `${claim.resource} is claimed by ${claim.ownerSessionId}` }));
}

function claimContended(snapshot, session, now) {
  if (session == null) return [];
  const peerIntents = (snapshot.intents ?? [])
    .filter(intent => intent.sessionId !== session.sessionId);
  return (snapshot.claims ?? []).filter(claim => claim.ownerSessionId === session.sessionId
    && Date.parse(claim.expiresAt) > Date.parse(now)).flatMap(claim => {
    const peer = peerIntents.find(intent => intent.resourceHints
      .some(hint => overlaps(hint, claim.resource)));
    if (peer === undefined) return [];
    const participant = (snapshot.sessions ?? [])
      .find(item => item.sessionId === peer.sessionId)?.participantId ?? "a peer";
    return [{ kind: "claim_contended", priority: ATTENTION_PRIORITY.claim_contended,
      sourceId: claim.claimId,
      summary: `${claim.resource} - ${participant} means to work on what you hold` }];
  });
}

export function computeAttention(snapshot, { session, participantId, now, pidIsAlive }) {
  if (typeof pidIsAlive !== "function") {
    throw new AccError(EXIT.USAGE, "computeAttention requires a pidIsAlive probe", {});
  }
  return [
    ...obligationItems(snapshot, participantId),
    ...unavailableRecipients(snapshot, participantId, now, pidIsAlive),
    ...claimConflicts(snapshot, session, now),
    ...claimContended(snapshot, session, now),
    ...expiredClaims(snapshot, session, now),
  ].sort((left, right) => left.priority - right.priority
    || left.sourceId.localeCompare(right.sourceId));
}
