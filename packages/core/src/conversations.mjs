import { isDeepStrictEqual } from "node:util";

import { AccError, EXIT, SCHEMA_VERSION, validateRecord }
  from "@agents-can-communicate/protocol";

import { projectReleasedClaim, reconstructFinishRetry } from "./finish-retries.mjs";
import { ensureMaterialised } from "./materialisation.mjs";

export const receiptId = (messageId, participantId) => `${messageId}--${participantId}`;

const identityOf = message =>
  `${message.workspaceId}--${message.fromParticipantId}--${message.clientMessageId}`;

const logicalContent = message => ({
  toParticipantIds: message.toParticipantIds,
  kind: message.kind,
  obligation: message.obligation,
  subject: message.subject,
  body: message.body,
  inReplyTo: message.inReplyTo,
  artifacts: message.artifacts,
  handoff: message.handoff,
});

const normalizedContent = input => logicalContent({
  toParticipantIds: input.toParticipantIds ?? [],
  kind: input.kind,
  obligation: input.obligation,
  subject: input.subject,
  body: input.body,
  inReplyTo: input.inReplyTo ?? null,
  artifacts: input.artifacts ?? [],
  handoff: input.handoff ?? null,
});

function existingMessage(tx, session, input) {
  const identity = `${session.workspaceId}--${session.participantId}--${input.clientMessageId}`;
  const existing = tx.list("message", message => identityOf(message) === identity).at(0);
  if (existing !== undefined
    && !isDeepStrictEqual(logicalContent(existing), normalizedContent(input))) {
    throw new AccError(EXIT.CONFLICT,
      "clientMessageId was already used with different message content",
      { clientMessageId: input.clientMessageId, messageId: existing.messageId });
  }
  return existing;
}

function assertCurrentSession(tx, session, action) {
  const current = tx.get("session", session.sessionId);
  if (current === null || current.state !== "open"
    || current.generation !== session.generation) {
    throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
      { sessionId: session.sessionId });
  }
}

function addressedRecipients(tx, message, session) {
  if (message.toParticipantIds.length === 0) {
    return [...new Set(tx.list("session", item => item.state === "open"
      && item.participantId !== session.participantId)
      .map(item => item.participantId))].sort();
  }
  const unique = [...new Set(message.toParticipantIds)];
  if (unique.length !== message.toParticipantIds.length) {
    throw new AccError(EXIT.USAGE, "a participant may be addressed only once", {});
  }
  const known = new Set(tx.list("participant").map(item => item.participantId));
  const strangers = unique.filter(participantId => !known.has(participantId));
  if (strangers.length > 0) {
    throw new AccError(EXIT.DATA,
      `no participant here is called ${strangers.join(", ")}. `
      + `This workspace has: ${[...known].sort().join(", ") || "nobody else yet"}`,
    { strangers, known: [...known].sort() });
  }
  return unique;
}

function threadFor(tx, messageId, inReplyTo) {
  if (inReplyTo === null) return messageId;
  const parent = tx.get("message", inReplyTo);
  if (parent === null) {
    throw new AccError(EXIT.DATA, "the message being replied to does not exist",
      { inReplyTo });
  }
  return parent.threadId;
}

export function recordMessageInTransaction({ tx, session, input, now, messageId, ids,
  action = "send a message" }) {
  assertCurrentSession(tx, session, action);
  const existing = existingMessage(tx, session, input);
  if (existing !== undefined) {
    return { message: existing, recipientParticipantIds: [], created: false };
  }

  const inReplyTo = input.inReplyTo ?? null;
  const message = validateRecord("message", {
    schemaVersion: SCHEMA_VERSION,
    messageId,
    threadId: threadFor(tx, messageId, inReplyTo),
    clientMessageId: input.clientMessageId,
    workspaceId: session.workspaceId,
    fromParticipantId: session.participantId,
    fromSessionId: session.sessionId,
    toParticipantIds: input.toParticipantIds ?? [],
    kind: input.kind,
    obligation: input.obligation,
    subject: input.subject,
    body: input.body,
    inReplyTo,
    artifacts: input.artifacts ?? [],
    handoff: input.handoff ?? null,
    sentAt: now,
  });
  const recipientParticipantIds = addressedRecipients(tx, message, session);
  tx.put("message", messageId, message);
  for (const participantId of recipientParticipantIds) {
    tx.put("receipt", receiptId(messageId, participantId), validateRecord("receipt", {
      schemaVersion: SCHEMA_VERSION,
      messageId,
      workspaceId: session.workspaceId,
      recipientParticipantId: participantId,
      state: "queued",
      updatedAt: now,
    }));
  }
  tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
    workspaceId: session.workspaceId, actorSessionId: session.sessionId,
    type: "message.recorded", occurredAt: now,
    payload: { messageId, threadId: message.threadId, recipientParticipantIds } });
  return { message, recipientParticipantIds, created: true };
}

function handoffBody(goal, handoff) {
  const section = (label, items) => items.length === 0
    ? [] : [`${label}:`, ...items.map(item => `- ${item}`)];
  return [goal, handoff.status,
    ...section("completed", handoff.completed),
    ...section("remaining", handoff.remaining),
    ...section("blockers", handoff.blockers)].join("\n");
}

export function createConversationService(ports, sessions) {
  const { store, clock, ids } = ports;

  async function requireSession(input, action, { open = true } = {}) {
    const located = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (located === null || located.record.generation !== input.generation
      || (open && located.record.state !== "open")) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return located.record;
  }

  async function sendMessage(input) {
    const session = await requireSession(input, "send a message");
    await ensureMaterialised(ports, { workspaceId: session.workspaceId,
      descriptor: input.descriptor, reason: "durable_object" });
    return store.transaction(tx => recordMessageInTransaction({ tx, session, input,
      now: clock.now(), messageId: ids.next("message"), ids }).message,
    { kinds: ["participant", "session", "message", "receipt"] });
  }

  async function finishSession(input) {
    const located = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (located === null || located.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, "cannot finish from this session generation",
        { sessionId: input.sessionId });
    }
    const session = located.record;
    await ensureMaterialised(ports, { workspaceId: session.workspaceId,
      descriptor: input.descriptor, reason: "durable_object" });
    const handoff = {
      status: input.status ?? "partial",
      completed: input.completed ?? [],
      remaining: input.remaining ?? [],
      blockers: input.blockers ?? [],
      verification: input.verification ?? [],
    };
    const messageInput = {
      clientMessageId: input.clientMessageId,
      toParticipantIds: input.toParticipantId === undefined ? [] : [input.toParticipantId],
      kind: "handoff",
      obligation: input.toParticipantId === undefined ? "none" : "acknowledge",
      subject: input.goal,
      body: handoffBody(input.goal, handoff),
      inReplyTo: null,
      artifacts: input.artifacts ?? [],
      handoff,
    };
    const now = clock.now();
    const outcome = await store.transaction(tx => {
      const current = tx.get("session", session.sessionId);
      if (current === null || current.generation !== session.generation) {
        throw new AccError(EXIT.CONFLICT, "cannot finish from this session generation",
          { sessionId: session.sessionId });
      }
      const existing = existingMessage(tx, session, messageInput);
      if (existing !== undefined) {
        if (existing.fromSessionId !== session.sessionId) {
          throw new AccError(EXIT.CONFLICT,
            "clientMessageId belongs to a different finish generation",
            { clientMessageId: input.clientMessageId, messageId: existing.messageId });
        }
        return { retry: true, message: existing, session: current };
      }
      if (current.state !== "open") {
        throw new AccError(EXIT.CONFLICT, "cannot finish from this session generation",
          { sessionId: session.sessionId });
      }
      const releasedClaims = tx.list("claim",
        claim => claim.ownerSessionId === session.sessionId);
      const recorded = recordMessageInTransaction({ tx, session, now,
        messageId: ids.next("message"), ids, action: "finish",
        input: messageInput });
      for (const claim of releasedClaims) {
        tx.remove("claim", claim.claimId, tx.generationOf("claim", claim.claimId));
        tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
          workspaceId: session.workspaceId, actorSessionId: session.sessionId,
          type: "claim.released", occurredAt: now,
          payload: { claimId: claim.claimId, authority: null, reason: null,
            replacedGeneration: claim.generation } });
      }
      const closed = { ...current, state: "closed", heartbeatAt: now };
      tx.put("session", session.sessionId, closed,
        tx.generationOf("session", session.sessionId));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: session.workspaceId, actorSessionId: session.sessionId,
        type: "session.closed", occurredAt: now, payload: {} });
      return { retry: false, message: recorded.message,
        releasedClaims: releasedClaims.map(projectReleasedClaim), session: closed };
    }, { kinds: ["participant", "session", "claim", "message", "receipt"] });
    if (!outcome.retry) {
      return { message: outcome.message, releasedClaims: outcome.releasedClaims,
        session: outcome.session };
    }
    const releasedClaims = await reconstructFinishRetry({ store,
      workspaceId: session.workspaceId, session: outcome.session, message: outcome.message });
    return { message: outcome.message, releasedClaims, session: outcome.session };
  }

  async function pendingMessages(input = {}) {
    if (typeof input.participantId !== "string" || input.participantId === "") return [];
    const snapshot = await store.snapshot(input.workspaceId ?? store.workspaceId,
      { kinds: ["message", "receipt"] });
    const queued = new Set(snapshot.receipts
      .filter(item => item.recipientParticipantId === input.participantId
        && item.state === "queued").map(item => item.messageId));
    return snapshot.messages.filter(message => queued.has(message.messageId)
      && message.fromSessionId !== input.exceptSessionId)
      .sort((left, right) => left.sentAt.localeCompare(right.sentAt)
        || left.messageId.localeCompare(right.messageId));
  }

  return { sendMessage, finishSession, pendingMessages };
}
