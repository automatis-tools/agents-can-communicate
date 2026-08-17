import { classifySessionPresence } from "./sessions.mjs";
import { overlaps } from "./claims.mjs";

const DEFAULT_LIMIT = 100;

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

function coordinatorGaps(snapshot) {
  return (snapshot.workstreams ?? [])
    .filter(workstream => workstream.state === "open"
      && workstream.coordinatorSessionId === null)
    .map(workstream => ({ kind: "coordinator_missing",
      priority: ATTENTION_PRIORITY.coordinator_missing,
      sourceId: workstream.workstreamId, summary: workstream.title }));
}

export function computeAttention(snapshot, { session, participantId, now }) {
  return [
    ...directRequests(snapshot, participantId),
    ...claimConflicts(snapshot, session, now),
    ...unblockedTasks(snapshot, session, participantId),
    ...coordinatorGaps(snapshot),
  ].sort((left, right) => left.priority - right.priority
    || left.sourceId.localeCompare(right.sourceId));
}

export function createSyncService(ports, sessions) {
  const { store, clock } = ports;

  /**
   * Any session may request the full Workspace scope. Peer equality is a
   * knowledge property: no session receives a reduced
   * view because of its role. The bounded delta is only the ambient default.
   */
  async function sync(input = {}) {
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
      participantId: session?.participantId ?? input.participantId, now });

    const roster = snapshot.sessions.map(item => ({
      sessionId: item.sessionId,
      participantId: item.participantId,
      parentSessionId: item.parentSessionId,
      harness: item.harness,
      presence: classifySessionPresence(item, now),
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
