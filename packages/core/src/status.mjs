import { classifySessionPresence } from "./sessions.mjs";
import { computeAttention } from "./sync.mjs";

/**
 * Protection level, reported from what is actually enforceable.
 *
 * A guarded claim only protects anything if every live session can be stopped
 * from writing through it. One MCP client with no hooks, or one harness whose
 * model edits through the shell, and the claim is advice - so the workspace is
 * advisory however the claims were written. Reporting "guarded" there would
 * promise enforcement that demonstrably is not present.
 */
function protectionOf(claims, live) {
  if (claims.length === 0) return "none";
  const enforceable = live.every(item => item.session.enforcement === "guarded");
  if (!enforceable) return "advisory";
  return claims.every(claim => claim.enforcement === "guarded") ? "guarded" : "advisory";
}

/**
 * The two things the write guard has to know, and nothing else.
 *
 * `collectStatus` answers a person's question and reads the whole store to do
 * it. The guard asks a much smaller one - who holds a live claim, and what is
 * that owner called - in front of *every file an agent writes*. Reading
 * everything there made the cost grow with the number of messages the workspace
 * had ever carried: measured at about 1.4ms per stored record, so a workspace
 * with a few thousand crosses the hook's five-second budget, after which it
 * fails open and the write goes through unguarded.
 *
 * Sessions and claims are bounded by what is live. Messages, receipts, tasks and
 * events are not bounded by anything, and none of them decides whether a write
 * is allowed.
 */
export function createGuardStateService(ports) {
  const { store, clock } = ports;

  return async function guardState(input = {}) {
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const snapshot = await store.snapshot(workspaceId, { kinds: ["workspace", "session", "claim"] });
    const sessions = snapshot.workspace !== null
      ? snapshot.sessions
      : await store.ephemeral.list("session");

    return {
      claims: snapshot.claims
        .filter(claim => Date.parse(claim.expiresAt) > Date.parse(now)),
      participants: sessions.map(session => ({
        sessionId: session.sessionId,
        participantId: session.participantId,
        // So the guard can tell whether this session has looked alive recently
        // without a second read. Bounded like the rest of what it asks for.
        heartbeatAt: session.heartbeatAt,
      })),
    };
  };
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
      protection: protectionOf(claims, live),
      // Who is here, unless the caller asks for everyone who ever was. A closed
      // session is never removed - a message is attributed to its sender, and
      // the roster is where "which worktree was that agent in" is answered - so
      // after a month of work this listed sixty entries for one live session.
      // `acc status --all` is how the worktree-cleanup question is asked.
      participants: sessionRecords
        .filter(session => input.all === true
          || classifySessionPresence(session, now) !== "offline")
        .map(session => ({
        sessionId: session.sessionId,
        participantId: session.participantId,
        harness: session.harness,
        parentSessionId: session.parentSessionId,
        checkoutRoot: session.checkoutRoot ?? null,
        branch: session.branch ?? null,
        enforcement: session.enforcement ?? "advisory",
        lifecycle: session.lifecycle ?? "manual",
        presence: classifySessionPresence(session, now),
        intent: intents.find(intent => intent.sessionId === session.sessionId)?.summary ?? null,
      })),
      workstreams: snapshot.workstreams.map(workstream => ({
        workstreamId: workstream.workstreamId,
        title: workstream.title,
        state: workstream.state,
        coordinatorSessionId: workstream.coordinatorSessionId,
      })),
      // The owner is named twice on purpose. Every command that reaches a peer
      // takes a participant id, so a claim that gave only a session id sent the
      // reader back through the roster to answer "who is holding this, and how
      // do I ask them for it". The session id stays because it is what
      // `acc release --authority` acts on, and because two sessions of one
      // participant are still two holders.
      claims: claims.map(claim => ({
        claimId: claim.claimId,
        resource: claim.resource,
        mode: claim.mode,
        enforcement: claim.enforcement,
        ownerSessionId: claim.ownerSessionId,
        // Read from every session on record, not only the live ones: a claim
        // outliving its session is exactly when this question gets asked.
        ownerParticipantId: sessionRecords
          .find(session => session.sessionId === claim.ownerSessionId)?.participantId ?? null,
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
