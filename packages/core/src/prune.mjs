import { AccError, EXIT } from "@agents-can-communicate/protocol";

import { classifySessionPresence } from "./sessions.mjs";

// What an operator can ask to reclaim. The workspace record is deliberately
// absent: removing it would not clean a workspace, it would erase one.
export const PRUNE_CLASSES = Object.freeze(["sessions", "intents", "claims", "participants"]);

function assertClasses(classes) {
  for (const name of classes) {
    if (!PRUNE_CLASSES.includes(name)) {
      throw new AccError(EXIT.USAGE,
        `prune class is one of ${PRUNE_CLASSES.join(", ")}`, { class: name });
    }
  }
}

const of = (envelopes, kind) => envelopes.filter(envelope => envelope.kind === kind);

/**
 * Which records describe work that has stopped for good.
 *
 * Only `offline` qualifies for a session, which is a confirmed dead pid or a
 * full day without a heartbeat. `stale` is a session that has gone quiet, and a
 * quiet session is still someone's.
 */
function eligibleSessions(envelopes, now, pidIsAlive) {
  return of(envelopes, "session")
    .filter(envelope => classifySessionPresence(envelope.record, now, pidIsAlive) === "offline");
}

/**
 * A participant is kept while anything still points at it.
 *
 * Messages are not pruned here, so every message that exists is one that
 * survives, and the roster is where "who sent this" is answered. A participant
 * whose sessions are all gone and whose name appears on no message is a name
 * nothing can reach any more.
 */
function eligibleParticipants(envelopes, doomedSessions, messages) {
  const surviving = new Set(of(envelopes, "session")
    .filter(envelope => !doomedSessions.has(envelope.id))
    .map(envelope => envelope.record.participantId));
  const named = new Set(messages.flatMap(message =>
    [message.fromParticipantId, ...message.toParticipantIds]));
  return of(envelopes, "participant")
    .filter(envelope => !surviving.has(envelope.id) && !named.has(envelope.id));
}

export function createPruneService(ports) {
  const { store, clock, pidIsAlive } = ports;

  /**
   * What `prune` would reclaim, as records rather than as counts.
   *
   * The plan is computed outside the writer mutex and applied inside it, so
   * every entry carries the generation that proves it is still the record this
   * judged. A claim renewed in between is skipped by the store rather than
   * removed.
   */
  async function planPrune(input = {}) {
    const classes = input.classes ?? PRUNE_CLASSES;
    assertClasses(classes);
    const workspaceId = input.workspaceId ?? store.workspaceId;
    const now = clock.now();
    const envelopes = await store.stateEnvelopes(workspaceId);
    const wants = name => classes.includes(name);

    const sessions = wants("sessions") || wants("intents") || wants("participants")
      ? eligibleSessions(envelopes, now, pidIsAlive)
      : [];
    const doomedSessions = new Set(sessions.map(envelope => envelope.id));

    // An intent belongs to one session and outlives nothing. Its session going
    // means the answer to "what is this session doing" has no one left to ask.
    const intents = wants("intents")
      ? of(envelopes, "intent").filter(envelope => doomedSessions.has(envelope.record.sessionId))
      : [];
    const claims = wants("claims")
      ? of(envelopes, "claim")
        .filter(envelope => Date.parse(envelope.record.expiresAt) <= Date.parse(now))
      : [];
    const participants = wants("participants")
      ? eligibleParticipants(envelopes, doomedSessions, of(envelopes, "message")
        .map(envelope => envelope.record))
      : [];

    const named = { sessions: wants("sessions") ? sessions : [], intents, claims, participants };
    const entries = Object.values(named).flat()
      .map(({ kind, id, generation }) => ({ kind, id, generation }));
    return { workspaceId,
      counts: Object.fromEntries(Object.entries(named).map(([name, list]) => [name, list.length])),
      entries };
  }

  /**
   * Reclaim what the plan named, or report it and change nothing.
   *
   * The dry run is the default because this is the one command that takes
   * records out of the store. A caller that means it says so.
   */
  async function prune(input = {}) {
    const plan = await planPrune(input);
    if (input.apply !== true) {
      return { ...plan, applied: false, reclaimed: 0, skipped: 0, remaining: false };
    }
    const result = await store.reclaimRecords(plan.entries,
      { limit: input.limit, deadlineAt: input.deadlineAt });
    return { ...plan, applied: true, ...result };
  }

  return { planPrune, prune };
}
