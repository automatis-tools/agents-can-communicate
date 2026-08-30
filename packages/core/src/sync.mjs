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

// Attention is computed from explicit rules, never from a hidden classifier.
// Lower priority sorts first.
//
// Exported so a test can prove every kind listed here is reachable. A fifth
// entry once sat here with no rule behind it, which read as a feature in review
// and produced nothing at runtime.
export const ATTENTION_PRIORITY = Object.freeze({
  direct_request: 1,
  claim_conflict: 2,
  task_unblocked: 3,
  coordinator_missing: 4,
  request_stalled: 5,
  claim_expired: 6,
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
 * Work waiting on me.
 *
 * Addressed by participant, so a request survives the recipient restarting -
 * the next session of that agent is told about it. A task already taken by one
 * of my sessions matches too, since that session may have been replaced.
 *
 * Unaddressed tasks are deliberately absent. Anyone may take one, but pushing
 * every open task into every turn is how a coordination layer becomes noise.
 */
function unblockedTasks(snapshot, session, participantId) {
  const mine = task => (task.assigneeParticipantId !== null
    && task.assigneeParticipantId === participantId)
    || (task.assigneeSessionId !== null && task.assigneeSessionId === session?.sessionId);
  return (snapshot.tasks ?? [])
    .filter(task => task.state === "pending" && mine(task))
    .map(task => ({ kind: "task_unblocked", priority: ATTENTION_PRIORITY.task_unblocked,
      sourceId: task.taskId, summary: task.title }));
}

/**
 * Work you asked for that nobody is doing any more.
 *
 * A task taken by a session that then crashed stayed `in_progress` for good:
 * the requester was told nothing and nobody else could take it. Unlike the
 * one-shot answers a request produces, this repeats until it is resolved,
 * because it stays true until someone picks the work back up.
 */
/**
 * A question nobody is left to answer.
 *
 * The task rule below tells a requester when work they asked for is going
 * nowhere. A `requiresAck` message had no such rule, and a message is the other
 * half of the same act: an agent asked a peer a direct question, the peer's
 * session ended without answering, and the asker's next turn was empty. Not
 * "still waiting" - empty. Measured, with the only other agent gone and an
 * unanswered question standing between them.
 *
 * The same kind as the task case, because it is the same fact about the world:
 * you asked, and there is nobody there.
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
  const live = new Map((snapshot.sessions ?? [])
    .map(session => [session.sessionId, classifySessionPresence(session, now, pidIsAlive)]));
  const onlineParticipants = new Set((snapshot.sessions ?? [])
    .filter(session => classifySessionPresence(session, now, pidIsAlive) === "online")
    .map(session => session.participantId));
  const goingNowhere = task => {
    // Taken by someone who has gone quiet.
    if (task.state === "in_progress") {
      return task.assigneeSessionId !== null
        && live.get(task.assigneeSessionId) !== "online";
    }
    // Or waiting on an agent that is not here - including one that closed and
    // never came back, which leaves the work addressed to nobody at all.
    return task.state === "pending" && task.assigneeParticipantId !== null
      && !onlineParticipants.has(task.assigneeParticipantId);
  };
  return [
    ...(snapshot.tasks ?? [])
      .filter(task => task.requestedByParticipantId === participantId
        && goingNowhere(task))
      .map(task => ({ kind: "request_stalled", priority: ATTENTION_PRIORITY.request_stalled,
        sourceId: task.taskId,
        summary: `${task.title} - nobody is working on it` })),
    ...unansweredQuestions(snapshot, participantId, onlineParticipants),
  ];
}

function coordinatorGaps(snapshot) {
  return (snapshot.workstreams ?? [])
    .filter(workstream => workstream.state === "open"
      && workstream.coordinatorSessionId === null)
    .map(workstream => ({ kind: "coordinator_missing",
      priority: ATTENTION_PRIORITY.coordinator_missing,
      sourceId: workstream.workstreamId, summary: workstream.title }));
}

export function computeAttention(snapshot, { session, participantId, now, pidIsAlive }) {
  return [
    ...directRequests(snapshot, participantId),
    ...claimConflicts(snapshot, session, now),
    ...expiredClaims(snapshot, session, now),
    ...unblockedTasks(snapshot, session, participantId),
    ...coordinatorGaps(snapshot),
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
      ...(input.scope === "full" ? { snapshot } : {}),
    };
  }

  return { sync };
}
