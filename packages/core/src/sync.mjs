import { classifySessionPresence } from "./sessions.mjs";
import { overlaps } from "./claims.mjs";

const DEFAULT_LIMIT = 100;

// Attention is computed from explicit rules, never from a hidden classifier.
// Lower priority sorts first.
const PRIORITY = Object.freeze({
  direct_request: 1,
  claim_conflict: 2,
  task_unblocked: 3,
  coordinator_missing: 4,
  nearby_intent: 5,
});

function directRequests(snapshot, participantId) {
  const items = [];
  for (const receipt of snapshot.receipts ?? []) {
    if (receipt.recipientParticipantId !== participantId) continue;
    if (receipt.state === "acknowledged" || receipt.state === "failed") continue;
    const message = (snapshot.messages ?? []).find(item => item.messageId === receipt.messageId);
    if (message === undefined || !message.requiresAck) continue;
    items.push({ kind: "direct_request", priority: PRIORITY.direct_request,
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
    .map(claim => ({ kind: "claim_conflict", priority: PRIORITY.claim_conflict,
      sourceId: claim.claimId,
      summary: `${claim.resource} is claimed by ${claim.ownerSessionId}` }));
}

function unblockedTasks(snapshot, session) {
  return (snapshot.tasks ?? [])
    .filter(task => task.state === "pending" && task.assigneeSessionId === session?.sessionId)
    .map(task => ({ kind: "task_unblocked", priority: PRIORITY.task_unblocked,
      sourceId: task.taskId, summary: task.title }));
}

function coordinatorGaps(snapshot) {
  return (snapshot.workstreams ?? [])
    .filter(workstream => workstream.state === "open"
      && workstream.coordinatorSessionId === null)
    .map(workstream => ({ kind: "coordinator_missing", priority: PRIORITY.coordinator_missing,
      sourceId: workstream.workstreamId, summary: workstream.title }));
}

export function computeAttention(snapshot, { session, participantId, now }) {
  return [
    ...directRequests(snapshot, participantId),
    ...claimConflicts(snapshot, session, now),
    ...unblockedTasks(snapshot, session),
    ...coordinatorGaps(snapshot),
  ].sort((left, right) => left.priority - right.priority
    || left.sourceId.localeCompare(right.sourceId));
}

export function createSyncService(ports, sessions) {
  const { store, clock } = ports;

  /**
   * Any session may request the full Workspace scope. Peer equality is a
   * knowledge property (approved 2026-08-15): no session receives a reduced
   * view because of its role. The bounded delta is only the ambient default.
   */
  async function sync(input = {}) {
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const located = input.sessionId === undefined
      ? null
      : await sessions.locateSession(input.sessionId, workspaceId);
    const session = located?.record ?? null;

    const snapshot = await store.snapshot(workspaceId);
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

    // Solo zero-overhead (approved 2026-08-15): one live session, no claims and
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
