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

const CURSOR = /^[0-9]{16}$/;
const EVENT_PAGE = 500;

function assertBefore(before) {
  if (typeof before !== "string" || !CURSOR.test(before)) {
    throw new AccError(EXIT.USAGE,
      "before is the 16-digit cursor a previous sync returned", { before });
  }
  return before;
}

/**
 * Read the log up to the boundary, counting it and naming what it recorded.
 *
 * The boundary is a cursor rather than a date on purpose: a cursor is what
 * `sync` already returns and what a peer already holds, so an operator trimming
 * to one names the same point its readers name. A duration would have to be
 * resolved to a sequence anyway, and the resolution could move between the
 * report and the apply.
 */
async function readBelow(store, workspaceId, before) {
  const messageIds = new Set();
  let events = 0;
  let cursor = null;
  for (;;) {
    const page = await store.eventsSince(workspaceId, cursor, EVENT_PAGE);
    if (page.events.length === 0) break;
    let past = false;
    for (const event of page.events) {
      if (event.sequence > before) {
        past = true;
        break;
      }
      events += 1;
      if (event.type === "message.recorded") messageIds.add(event.payload.messageId);
    }
    if (past) break;
    cursor = page.cursor;
  }
  return { events, messageIds };
}

/**
 * A message is resolved when nobody is still owed it.
 *
 * Offered is not read and retrieved is not model attention, so only an
 * acknowledged receipt settles the obligation. A recipient that no longer
 * exists cannot acknowledge anything, and holding the message for it would
 * keep the whole thread forever.
 */
function resolvedMessages(envelopes, messageIds) {
  const participants = new Set(of(envelopes, "participant").map(envelope => envelope.id));
  const open = new Set(of(envelopes, "receipt").map(envelope => envelope.record)
    .filter(receipt => receipt.state !== "acknowledged"
      && participants.has(receipt.recipientParticipantId))
    .map(receipt => receipt.messageId));
  return of(envelopes, "message")
    .filter(envelope => messageIds.has(envelope.id) && !open.has(envelope.id));
}

/**
 * Which records describe work that has stopped for good.
 *
 * Only `offline` qualifies for a session, which is a confirmed dead pid or a
 * full day without a heartbeat. `stale` is a session that has gone quiet, and a
 * quiet session is still someone's.
 */
function eligibleSessions(envelopes, now, pidIsAlive) {
  // A live claim names the session that holds it, and that name is how a peer
  // blocked by the claim finds someone to ask. Removing the session leaves the
  // claim reading as owned by nobody, so a session keeping a live lease stays
  // however long it has been quiet. Its claim expiring makes both eligible.
  const holding = new Set(of(envelopes, "claim")
    .filter(envelope => Date.parse(envelope.record.expiresAt) > Date.parse(now))
    .map(envelope => envelope.record.ownerSessionId));
  return of(envelopes, "session")
    .filter(envelope => !holding.has(envelope.id)
      && classifySessionPresence(envelope.record, now, pidIsAlive) === "offline");
}

/**
 * A participant is kept while anything still points at it.
 *
 * `removedSessions` is what this pass actually takes, not what it could take.
 * The difference matters when an operator names classes: asked for participants
 * alone, every session stays, so every participant is still pointed at and none
 * is eligible. Judging by what is merely *eligible* would remove a participant
 * and leave its sessions naming a roster entry that is gone.
 *
 * Messages are not pruned unless a boundary says so, and the roster is where
 * "who sent this" is answered, so a name on a surviving message stays too.
 */
function eligibleParticipants(envelopes, removedSessions, messages) {
  const surviving = new Set(of(envelopes, "session")
    .filter(envelope => !removedSessions.has(envelope.id))
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
    // The sessions this pass will actually remove, which is empty when the
    // operator asked for other classes only.
    const removedSessions = new Set(wants("sessions") ? doomedSessions : []);
    const participants = wants("participants")
      ? eligibleParticipants(envelopes, removedSessions, of(envelopes, "message")
        .map(envelope => envelope.record))
      : [];

    // History is named by a boundary rather than by a class, because there is
    // no such thing as an event that has stopped being true - only one the
    // operator has decided nobody will read again.
    const before = input.before === undefined ? null : assertBefore(input.before);
    const below = before === null ? { events: 0, messageIds: new Set() }
      : await readBelow(store, workspaceId, before);
    const messages = before === null ? [] : resolvedMessages(envelopes, below.messageIds);
    const doomedMessages = new Set(messages.map(envelope => envelope.id));
    const receipts = of(envelopes, "receipt")
      .filter(envelope => doomedMessages.has(envelope.record.messageId));

    const named = { sessions: wants("sessions") ? sessions : [], intents, claims, participants,
      messages, receipts };
    const entries = Object.values(named).flat()
      .map(({ kind, id, generation }) => ({ kind, id, generation }));
    return { workspaceId,
      before,
      counts: { ...Object.fromEntries(Object.entries(named)
        .map(([name, list]) => [name, list.length])), events: below.events },
      entries };
  }

  /**
   * Reclaim what the plan named, or report it and change nothing.
   *
   * The dry run is the default because this is the one command that takes
   * records out of the store. A caller that means it says so.
   */
  async function prune(input = {}) {
    let plan = await planPrune(input);
    if (input.apply !== true) {
      return { ...plan, applied: false, reclaimed: 0, skipped: 0, remaining: false,
        trimmedThrough: null };
    }
    // Decided again inside the writer mutex, and that second reading is the one
    // acted on. Eligibility here is relational - a participant is eligible
    // because no session of theirs survives - and a generation proves only that
    // one record did not change. A session opening between the report and the
    // apply changes the answer without changing any record this had named.
    let decided = plan;
    const result = await store.reclaimRecords(async () => {
      decided = await planPrune(input);
      return decided.entries;
    }, { limit: input.limit, deadlineAt: input.deadlineAt });
    if (decided.before === null) {
      return { ...decided, applied: true, ...result, trimmedThrough: null };
    }
    plan = decided;
    // Records first, then the log. A message removed while its recording event
    // survives reads as history describing a record that is gone, which is
    // ordinary. The reverse - an event log that starts after a message it never
    // mentions - is the gap the floor is there to report.
    const trimmed = await store.trimHistory(plan.before,
      { limit: input.limit, deadlineAt: input.deadlineAt });
    return { ...plan, applied: true,
      reclaimed: result.reclaimed + trimmed.reclaimed,
      skipped: result.skipped,
      trimmedThrough: trimmed.trimmedThrough,
      remaining: result.remaining || trimmed.remaining };
  }

  return { planPrune, prune };
}
