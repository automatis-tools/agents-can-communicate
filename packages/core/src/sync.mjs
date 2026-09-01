import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { classifySessionPresence } from "./sessions.mjs";
import { overlaps } from "./claims.mjs";

const DEFAULT_LIMIT = 100;

// The shape every event carries, and the only thing a caller may ask to resume
// from. `null` means the beginning, which is what a session with no cursor yet
// has.
const CURSOR = /^[0-9]{16}$/;

// The two a caller may ask for. An unknown one used to become `delta`, so
// `--scope ful` answered the one question the full scope exists for - "show me
// everything, I cannot see the rest of the system" - with a delta carrying no
// snapshot at all, and the agent concluded there was nothing to see.
const SCOPES = Object.freeze(["delta", "full"]);

function assertScope(scope) {
  if (scope != null && !SCOPES.includes(scope)) {
    throw new AccError(EXIT.USAGE,
      `scope is one of ${SCOPES.join(", ")}; leave it out for ${SCOPES[0]}`, { scope });
  }
}

function assertCursor(cursor) {
  if (typeof cursor !== "string" || !CURSOR.test(cursor)) {
    throw new AccError(EXIT.USAGE,
      "a cursor is the 16-digit sequence a previous sync returned; "
      + "leave it out to start from the beginning",
      { cursor });
  }
}

function projectPublicSnapshot({ workstreams, tasks, decisions, ...publicSnapshot }) {
  return publicSnapshot;
}
// Attention is computed from explicit rules, never from a hidden classifier.
// Lower priority sorts first.
//
// Exported so a test can prove every kind listed here is reachable. A fifth
// entry once sat here with no rule behind it, which read as a feature in review
// and produced nothing at runtime.
export const ATTENTION_PRIORITY = Object.freeze({
  direct_request: 1,
  claim_conflict: 2,
  request_stalled: 3,
  claim_expired: 4,
  claim_contended: 5,
  unread_note: 6,
});

function directRequests(snapshot, participantId) {
  const items = [];
  for (const receipt of snapshot.receipts ?? []) {
    if (receipt.recipientParticipantId !== participantId) continue;
    if (receipt.state === "acknowledged" || receipt.state === "failed") continue;
    const message = (snapshot.messages ?? []).find(item => item.messageId === receipt.messageId);
    if (message === undefined || !message.requiresAck) continue;
    items.push({ kind: "direct_request", priority: ATTENTION_PRIORITY.direct_request,
      sourceId: message.messageId, summary: message.subject });
  }
  return items;
}

/**
 * A note that was delivered once and then left unanswered.
 *
 * A `note` carries no acknowledgement obligation, so unlike a `requiresAck`
 * message it raises no direct_request and, once injected, drops out of the
 * inbox for good. Agents put decisions in notes anyway, and one delivered that
 * way was missed for three hours because nothing stood behind it. This is the
 * single low-priority breadcrumb that keeps a delivered-but-unacknowledged note
 * recoverable: it fires only while the receipt reads `injected`, so the runner
 * advancing it to `seen` after one showing makes it one-shot rather than a
 * standing nag - the very noise a reader learns to skip. A `queued` note is
 * about to be shown in full this turn and needs no breadcrumb yet.
 *
 * Only the recipient's, and named by message id so `acc inbox --message` or
 * `acc ack --message` can act on it without a workspace-wide lookup.
 */
function unreadNotes(snapshot, participantId) {
  const items = [];
  for (const receipt of snapshot.receipts ?? []) {
    if (receipt.recipientParticipantId !== participantId) continue;
    if (receipt.state !== "injected") continue;
    const message = (snapshot.messages ?? [])
      .find(item => item.messageId === receipt.messageId);
    // A requiresAck message already carries a standing direct_request; a second
    // line here would be two reminders for one obligation.
    if (message === undefined || message.requiresAck) continue;
    items.push({ kind: "unread_note", priority: ATTENTION_PRIORITY.unread_note,
      sourceId: message.messageId,
      summary: `a note you have not acknowledged - \`acc inbox --message `
        + `${message.messageId}\` to read it` });
  }
  return items;
}

/**
 * A claim of yours that has run out.
 *
 * A lease lapses on the clock, and nothing said so. Measured: while it held, a
 * peer's write into the file was refused; three seconds later the same write
 * went through, and the holder's turn was identical before and after. It went on
 * working on a file it believed it had reserved, and everyone else was free to
 * change it.
 *
 * Only for the session that took it, and only while that session is the one
 * asking: a lapsed claim is news to its owner and nobody else's business.
 * Re-claiming refreshes the lease and clears this; releasing it clears it too.
 */
function expiredClaims(snapshot, session, now) {
  if (session == null) return [];
  return (snapshot.claims ?? [])
    .filter(claim => claim.ownerSessionId === session.sessionId
      && Date.parse(claim.expiresAt) <= Date.parse(now))
    .map(claim => ({ kind: "claim_expired", priority: ATTENTION_PRIORITY.claim_expired,
      sourceId: claim.claimId,
      summary: `${claim.resource} - your claim has run out, and peers can write to it` }));
}

function claimConflicts(snapshot, session, now) {
  const mine = (snapshot.intents ?? []).find(intent => intent.sessionId === session?.sessionId);
  if (mine === undefined) return [];
  return (snapshot.claims ?? [])
    .filter(claim => claim.ownerSessionId !== session.sessionId
      && Date.parse(claim.expiresAt) > Date.parse(now)
      && mine.resourceHints.some(hint => overlaps(hint, claim.resource)))
    .map(claim => ({ kind: "claim_conflict", priority: ATTENTION_PRIORITY.claim_conflict,
      sourceId: claim.claimId,
      summary: `${claim.resource} is claimed by ${claim.ownerSessionId}` }));
}

/**
 * A resource I hold that a peer has said they intend to touch.
 *
 * The mirror of `claimConflicts`. That one reads my own intent and warns me when
 * what I mean to touch is already claimed. This one reads a peer's intent and
 * warns me, the holder, that someone is heading for what I claimed. Without it
 * intent's only wired reader faced inward: it protected the one declaring intent
 * and told the claim holder nothing, so a claim was a wall nobody was told they
 * were walking into. A claim is advisory - it does not stop the write - so being
 * told early is the whole of the protection it offers.
 *
 * Only my own claims, and never my own intent against them: declaring intent on
 * what you already hold is not someone reaching for it. The peer is named by
 * participant where the roster knows it, because a session id cannot be used
 * with `--to` and an id a reader cannot act on is the trap the projector warns of.
 */
function claimContended(snapshot, session, now) {
  if (session === null || session === undefined) return [];
  const theirs = (snapshot.intents ?? [])
    .filter(intent => intent.sessionId !== session.sessionId);
  const nameOf = sessionId => (snapshot.sessions ?? [])
    .find(item => item.sessionId === sessionId)?.participantId ?? "a peer";
  return (snapshot.claims ?? [])
    .filter(claim => claim.ownerSessionId === session.sessionId
      && Date.parse(claim.expiresAt) > Date.parse(now))
    .flatMap(claim => {
      const eyeing = theirs.find(intent =>
        (intent.resourceHints ?? []).some(hint => overlaps(hint, claim.resource)));
      return eyeing === undefined ? [] : [{
        kind: "claim_contended", priority: ATTENTION_PRIORITY.claim_contended,
        sourceId: claim.claimId,
        summary: `${claim.resource} - ${nameOf(eyeing.sessionId)} means to work on what you hold` }];
    });
}

/**
 * A question nobody is left to answer.
 *
 * An agent asked a peer a direct question, the peer's session ended without
 * answering, and the asker's next turn was empty. Not "still waiting" - empty.
 * Measured, with the only other agent gone and an unanswered question standing
 * between them.
 */
function unansweredQuestions(snapshot, participantId, onlineParticipants) {
  const items = [];
  for (const receipt of snapshot.receipts ?? []) {
    if (receipt.state === "acknowledged" || receipt.state === "failed") continue;
    const message = (snapshot.messages ?? [])
      .find(item => item.messageId === receipt.messageId);
    if (message === undefined || !message.requiresAck) continue;
    if (message.fromParticipantId !== participantId) continue;
    // Not answered yet by someone who is here is ordinary waiting, and saying so
    // every turn would be noise the reader learns to skip.
    if (onlineParticipants.has(receipt.recipientParticipantId)) continue;
    items.push({ kind: "request_stalled", priority: ATTENTION_PRIORITY.request_stalled,
      sourceId: message.messageId,
      summary: `${message.subject} - ${receipt.recipientParticipantId} is not here to answer` });
  }
  return items;
}

function stalledRequests(snapshot, participantId, now, pidIsAlive) {
  // Classified once per session and reused below, for the same reason
  // collectStatus takes one reading: classifySessionPresence calls pidIsAlive,
  // a real process.kill(pid, 0) syscall for a session with a recorded pid, so
  // it is not pure given `now` any more. A second classifying pass here could
  // disagree with the first - a client exiting between them would leave `live`
  // saying "online" while a freshly-computed `onlineParticipants` had already
  // dropped it, inside one attention computation.
  const live = new Map((snapshot.sessions ?? [])
    .map(session => [session.sessionId, classifySessionPresence(session, now, pidIsAlive)]));
  const onlineParticipants = new Set((snapshot.sessions ?? [])
    .filter(session => live.get(session.sessionId) === "online")
    .map(session => session.participantId));
  return unansweredQuestions(snapshot, participantId, onlineParticipants);
}

export function computeAttention(snapshot, { session, participantId, now, pidIsAlive }) {
  // Required unconditionally, not only when there happen to be sessions to
  // classify: `stalledRequests` reaches `classifySessionPresence` only inside a
  // map/filter over `snapshot.sessions`, so an empty or absent roster let a
  // missing probe through with nothing to trip over it - the same silent pass
  // the classifier's own required parameter exists to close, one layer up.
  if (typeof pidIsAlive !== "function") {
    throw new AccError(EXIT.USAGE, "computeAttention requires a pidIsAlive probe", {});
  }
  return [
    ...directRequests(snapshot, participantId),
    ...unreadNotes(snapshot, participantId),
    ...claimConflicts(snapshot, session, now),
    ...claimContended(snapshot, session, now),
    ...expiredClaims(snapshot, session, now),
    ...stalledRequests(snapshot, participantId, now, pidIsAlive),
  ].sort((left, right) => left.priority - right.priority
    || left.sourceId.localeCompare(right.sourceId));
}

export function createSyncService(ports, sessions) {
  const { store, clock, pidIsAlive } = ports;

  /**
   * Any session may request the full Workspace scope. Peer equality is a
   * knowledge property: no session receives a reduced
   * view because of its role. The bounded delta is only the ambient default.
   */
  async function sync(input = {}) {
    // A cursor that is not a cursor answered "nothing new", every time, for as
    // long as it was held. `eventsSince` compares sequences as strings, so
    // `not-a-cursor` sorts after every event there has ever been - and an
    // adapter holding a corrupt one, or an agent that invented one, saw a quiet
    // workspace rather than a mistake. `"0000000000000001; DROP"` was quietly
    // taken as the sequence it starts with.
    if (input.cursor != null) assertCursor(input.cursor);
    assertScope(input.scope);
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const located = input.sessionId === undefined
      ? null
      : await sessions.locateSession(input.sessionId, workspaceId);
    const session = located?.record ?? null;

    const durable = await store.snapshot(workspaceId);
    // A workspace that has not materialised still has a truthful roster: its
    // sessions live in the ephemeral area. Reading only the durable snapshot
    // would make a lone session invisible to itself, and would disagree with
    // what `status` reports from the same state.
    const snapshot = durable.workspace !== null
      ? durable
      : { ...durable,
        sessions: await store.ephemeral.list("session"),
        intents: await store.ephemeral.list("intent") };
    const page = await store.eventsSince(workspaceId, input.cursor ?? null,
      input.limit ?? DEFAULT_LIMIT);
    const attention = computeAttention(snapshot, { session,
      participantId: session?.participantId ?? input.participantId, now, pidIsAlive });

    const roster = snapshot.sessions.map(item => ({
      sessionId: item.sessionId,
      participantId: item.participantId,
      parentSessionId: item.parentSessionId,
      harness: item.harness,
      branch: item.branch ?? null,
      presence: classifySessionPresence(item, now, pidIsAlive),
    }));

    // Solo zero-overhead: one live session, no claims and
    // no attention means an empty result, not a "nothing to report" banner.
    const peers = roster.filter(item => item.sessionId !== session?.sessionId
      && item.presence !== "offline");
    const solo = peers.length === 0 && attention.length === 0
      && snapshot.claims.length === 0;

    return {
      cursor: page.cursor,
      scope: input.scope === "full" ? "full" : "delta",
      solo,
      attention,
      roster,
      events: page.events,
      ...(input.scope === "full" ? { snapshot: projectPublicSnapshot(snapshot) } : {}),
    };
  }

  return { sync };
}
