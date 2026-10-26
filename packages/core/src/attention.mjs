import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { overlaps } from "./claims.mjs";
import { classifySessionPresence } from "./sessions.mjs";
import { decisionView, isCurrentDecision } from "./decision-state.mjs";
import { isCurrentIntent } from "./intents.mjs";

export const ATTENTION_PRIORITY = Object.freeze({
  reply_required: 1,
  acknowledgement_required: 2,
  recipient_unavailable: 3,
  claim_conflict: 4,
  claim_contended: 5,
  claim_expired: 6,
  left_for_ended_session: 7,
});

// A message left for a participant whose sessions have all ended is reported to
// the other sessions in the room for a week, five at most (#320).
export const LEFT_MESSAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const LEFT_MESSAGE_LIMIT = 5;

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

// Nothing reads a message whose recipient has no session left: a new session of
// the same client is another participant and inherits no inbox. The other
// participants are told, once each; the receipt stays the recipient's (#320).
// The summary carries validated ids only: a subject is peer-written, and this
// line speaks in ACC's voice outside any quoted peer block.
function leftForEndedSessions(snapshot, { session, participantId, now, pidIsAlive }) {
  const present = new Set((snapshot.sessions ?? [])
    .filter(item => classifySessionPresence(item, now, pidIsAlive) !== "offline")
    .map(item => item.participantId));
  // Once per participant: a resumed conversation opens another session of the
  // same participant, and its transcript already holds the notice.
  const noticed = new Set([session, ...(snapshot.sessions ?? [])
    .filter(item => participantId !== undefined && item.participantId === participantId)]
    .flatMap(item => item?.extensions?.noticedLeftMessages ?? []));
  // One pass over the receipts, so a hook's cost stays linear in what the
  // workspace holds (#298).
  const waiting = new Map();
  for (const receipt of snapshot.receipts ?? []) {
    if (!["queued", "offered"].includes(receipt.state)
      || present.has(receipt.recipientParticipantId)) continue;
    if (!waiting.has(receipt.messageId)) waiting.set(receipt.messageId, []);
    waiting.get(receipt.messageId).push(receipt.recipientParticipantId);
  }
  const qualifying = (snapshot.messages ?? []).filter(message => {
    const age = Date.parse(now) - Date.parse(message.sentAt);
    // A sender wrote it, and a co-recipient holds it in its own inbox.
    return waiting.has(message.messageId) && message.toParticipantIds?.length > 0
      && message.fromParticipantId !== participantId
      && !message.toParticipantIds.includes(participantId) && age < LEFT_MESSAGE_WINDOW_MS;
  }).sort((left, right) => right.sentAt.localeCompare(left.sentAt));
  // The newest are chosen before the ones already told are dropped. Dropping
  // first let a backlog longer than the noticed list cycle through it forever.
  return qualifying.slice(0, LEFT_MESSAGE_LIMIT)
    .filter(message => !noticed.has(message.messageId))
    .map(message => ({ kind: "left_for_ended_session",
      priority: ATTENTION_PRIORITY.left_for_ended_session, sourceId: message.messageId,
      summary: `${message.kind} from ${message.fromParticipantId} waiting for `
        + `${waiting.get(message.messageId).join(", ")}, whose sessions have ended; `
        + `read it with \`acc sync --scope history --message ${message.messageId}\`` }));
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
  // Both kinds read resourceHints as a statement of what a session means to
  // touch. Finishing that work retracts the statement, so a done record must
  // not keep raising conflicts on either side of it.
  const mine = (snapshot.intents ?? []).find(intent => intent.sessionId === session?.sessionId
    && isCurrentIntent(intent));
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
    .filter(intent => intent.sessionId !== session.sessionId && isCurrentIntent(intent));
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
  snapshot = { ...snapshot, messages: (snapshot.messages ?? [])
    .map(decisionView(snapshot.messages ?? [])).filter(isCurrentDecision) };
  return [
    ...obligationItems(snapshot, participantId),
    ...unavailableRecipients(snapshot, participantId, now, pidIsAlive),
    ...claimConflicts(snapshot, session, now),
    ...claimContended(snapshot, session, now),
    ...expiredClaims(snapshot, session, now),
    ...leftForEndedSessions(snapshot, { session, participantId, now, pidIsAlive }),
  ].sort((left, right) => left.priority - right.priority
    || left.sourceId.localeCompare(right.sourceId));
}
