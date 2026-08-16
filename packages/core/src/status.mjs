import { classifySessionPresence } from "./sessions.mjs";
import { computeAttention } from "./sync.mjs";

// Protection level is reported from what adapters actually declared, never
// inferred. An unguarded workspace says so rather than implying enforcement it
// cannot deliver.
function protectionOf(claims) {
  if (claims.length === 0) return "none";
  return claims.every(claim => claim.enforcement === "guarded") ? "guarded" : "advisory";
}

export function createStatusService(ports, sessions) {
  const { store, clock } = ports;

  async function collectStatus(input = {}) {
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const snapshot = await store.snapshot(workspaceId);

    // A workspace that has not materialised still has a truthful status: its
    // sessions and intents live in the ephemeral area.
    const durable = snapshot.workspace !== null;
    const sessionRecords = durable
      ? snapshot.sessions
      : await store.ephemeral.list("session");
    const intents = durable ? snapshot.intents : await store.ephemeral.list("intent");
    const live = sessionRecords
      .map(session => ({ session, presence: classifySessionPresence(session, now) }))
      .filter(item => item.presence !== "offline");
    const claims = snapshot.claims
      .filter(claim => Date.parse(claim.expiresAt) > Date.parse(now));

    return {
      workspaceId,
      materialised: durable,
      protection: protectionOf(claims),
      participants: sessionRecords.map(session => ({
        sessionId: session.sessionId,
        participantId: session.participantId,
        harness: session.harness,
        parentSessionId: session.parentSessionId,
        presence: classifySessionPresence(session, now),
        intent: intents.find(intent => intent.sessionId === session.sessionId)?.summary ?? null,
      })),
      workstreams: snapshot.workstreams.map(workstream => ({
        workstreamId: workstream.workstreamId,
        title: workstream.title,
        state: workstream.state,
        coordinatorSessionId: workstream.coordinatorSessionId,
      })),
      claims: claims.map(claim => ({
        claimId: claim.claimId,
        resource: claim.resource,
        mode: claim.mode,
        enforcement: claim.enforcement,
        ownerSessionId: claim.ownerSessionId,
        expiresAt: claim.expiresAt,
      })),
      attention: computeAttention(snapshot, { session: null,
        participantId: input.participantId, now }),
      counts: {
        live: live.length,
        stale: live.filter(item => item.presence === "stale").length,
        claims: claims.length,
        tasks: snapshot.tasks.length,
        messages: snapshot.messages.length,
      },
    };
  }

  return { collectStatus, locateSession: sessions.locateSession };
}
