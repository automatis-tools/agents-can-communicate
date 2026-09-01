import { AccError, EXIT, SCHEMA_VERSION, advanceDelivery, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";
import { assertKnownParticipants } from "./participants.mjs";

const receiptId = (messageId, recipient) => `${messageId}--${recipient}`;

// Peer content is data, never authority. Messages carry attribution and a
// typed intent; nothing in a body can change policy or promote a proposal.
export function createCommunicationService(ports, sessions, claims) {
  const { store, clock, ids } = ports;

  async function requireOpenSession(input, action) {
    const existing = await sessions.locateSession(input.sessionId, input.workspaceId);
    if (existing === null || existing.record.state !== "open"
      || existing.record.generation !== input.generation) {
      throw new AccError(EXIT.CONFLICT, `cannot ${action} from this session generation`,
        { sessionId: input.sessionId });
    }
    return existing.record;
  }

  async function sendMessage(input) {
    const session = await requireOpenSession(input, "send a message");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    const now = clock.now();
    const messageId = createId("message");
    const recipients = input.toParticipantIds ?? [];
    if (recipients.length === 0) {
      throw new AccError(EXIT.USAGE, "a message needs at least one recipient", { messageId });
    }
    const record = validateRecord("message", {
      schemaVersion: SCHEMA_VERSION,
      messageId,
      workspaceId,
      fromSessionId: session.sessionId,
      fromParticipantId: session.participantId,
      toParticipantIds: recipients,
      type: input.type,
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? "normal",
      workstreamId: input.workstreamId ?? null,
      taskId: input.taskId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      requiresAck: input.requiresAck === true,
      artifacts: input.artifacts ?? [],
      sentAt: now,
    });
    // After the record is validated, so a body carrying control characters is
    // refused for what it is rather than for who it was addressed to.
    await assertKnownParticipants(store, workspaceId, recipients);

    await store.transaction(async tx => {
      tx.put("message", messageId, record);
      // One receipt per recipient: a receipt from one recipient can never move
      // another recipient's state.
      for (const recipient of recipients) {
        tx.put("receipt", receiptId(messageId, recipient), validateRecord("receipt", {
          schemaVersion: SCHEMA_VERSION,
          messageId,
          workspaceId,
          recipientParticipantId: recipient,
          state: "queued",
          updatedAt: now,
        }));
      }
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "message.sent", occurredAt: now,
        payload: { messageId, type: record.type, recipients } });
    }, { kinds: ["message", "receipt"] });
    return record;
  }

  async function markDelivery(input) {
    const session = await requireOpenSession(input, "update delivery");
    // Your own receipt, unless you say otherwise and mean it. A session
    // advancing another participant's receipt would be reporting that someone
    // else had read something.
    const recipient = input.recipientParticipantId ?? session.participantId;
    if (recipient !== session.participantId) {
      throw new AccError(EXIT.CONFLICT, "a session can only mark its own receipt",
        { recipient, participantId: session.participantId });
    }
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const id = receiptId(input.messageId, recipient);
      const existing = tx.get("receipt", id);
      if (existing === null) {
        throw new AccError(EXIT.DATA, "no receipt exists for that recipient", { id });
      }
      // Monotonic by construction: the protocol state machine refuses to move
      // backwards, so an acknowledgement can never be downgraded to seen.
      record = { ...existing, state: advanceDelivery(existing.state, input.state),
        updatedAt: now };
      tx.put("receipt", id, record, tx.generationOf("receipt", id));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"),
        workspaceId: existing.workspaceId, actorSessionId: session.sessionId,
        type: `message.${record.state}`, occurredAt: now,
        payload: { messageId: input.messageId,
          recipientParticipantId: recipient } });
    }, { kinds: ["receipt"] });
    return record;
  }

  /**
   * Produce a handoff and release what this session owned. The semantic summary
   * is written while the model is still active; session end only closes
   * lifecycle ownership.
   */
  /**
   * What the successor needs, in the order they need it: what this was for, how
   * far it got, what is left, and what is in the way.
   */
  function describeHandoff(record) {
    const section = (label, items) => (items.length === 0
      ? [] : [`${label}:`, ...items.map(item => `- ${item}`)]);
    return [
      // The goal is the subject; repeating it here costs a line of everyone's
      // turn to say the same thing twice.
      record.status,
      ...section("done", record.completed),
      // Not "left": the status line above already uses that word for how far
      // this got, and the two meanings sat one line apart.
      ...section("still to do", record.remaining),
      ...section("in the way", record.blockers),
      ...section("released", record.claimsToRelease),
    ].join("\n");
  }

  async function finishSession(input) {
    const session = await requireOpenSession(input, "finish");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, reason: "durable_object" });
    const now = clock.now();
    const handoffId = createId("handoff");
    const owned = (await store.snapshot(workspaceId, { kinds: ["claim"] })).claims
      .filter(claim => claim.ownerSessionId === session.sessionId);
    const successor = input.toParticipantId ?? null;
    // The same rule as addressing anything else: handing your work to a name
    // nobody has is a typo, and the summary is the last thing this session will
    // ever say.
    if (successor !== null) await assertKnownParticipants(store, workspaceId, [successor]);
    const record = validateRecord("handoff", {
      schemaVersion: SCHEMA_VERSION,
      handoffId,
      workspaceId,
      fromSessionId: session.sessionId,
      toParticipantId: successor,
      goal: input.goal,
      status: input.status ?? "partial",
      completed: input.completed ?? [],
      remaining: input.remaining ?? [],
      blockers: input.blockers ?? [],
      claimsToRelease: owned.map(claim => claim.resource),
      verification: input.verification ?? [],
      artifacts: input.artifacts ?? [],
      createdAt: now,
    });

    await store.transaction(async tx => {
      tx.put("handoff", handoffId, record);
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "handoff.created", occurredAt: now,
        payload: { handoffId, released: record.claimsToRelease } });
    }, { kinds: ["handoff"] });

    // A handoff nobody is told about is a note to the store. Written, durable,
    // and reaching the agent it names through nothing at all: not their turn,
    // not their attention, not `acc status` - only a full snapshot they would
    // have to scan for their own name. The message type for this has been in the
    // schema all along, and this is the half that was never built.
    if (successor !== null) {
      await sendMessage({
        sessionId: session.sessionId, generation: input.generation,
        toParticipantIds: [successor], type: "handoff",
        subject: `handing over: ${record.goal}`,
        body: describeHandoff(record),
        descriptor: input.descriptor,
      });
    }

    for (const claim of owned) {
      await claims.releaseClaim({ claimId: claim.claimId, sessionId: session.sessionId,
        generation: session.generation, workspaceId });
    }
    return record;
  }

  /**
   * Messages addressed to this participant that nothing has shown a model yet.
   *
   * `queued` is where `sendMessage` leaves a receipt. Anything further along has
   * already been put in front of the recipient, and delivery states only move
   * forward - so re-injecting would misreport what happened rather than repeat
   * harmlessly.
   *
   * A session never receives its own message back. Another session of the same
   * participant does, because it is a different reader.
   */
  async function pendingMessages(input = {}) {
    const participantId = input.participantId;
    if (typeof participantId !== "string" || participantId === "") return [];
    const workspaceId = input.workspaceId ?? store.workspaceId;
    // Messages and receipts are the two unbounded kinds and this read needs
    // both. Nothing else, though, and it runs in front of every turn.
    const snapshot = await store.snapshot(workspaceId,
      { kinds: ["message", "receipt"] });
    const waiting = new Set((snapshot.receipts ?? [])
      .filter(receipt => receipt.recipientParticipantId === participantId
        && (receipt.state === "queued" || receipt.state === "recorded"))
      .map(receipt => receipt.messageId));
    return (snapshot.messages ?? [])
      .filter(message => waiting.has(message.messageId)
        && message.fromSessionId !== input.exceptSessionId)
      // Oldest first, and the id breaks ties so two messages sent in the same
      // millisecond still project in a stable order.
      .sort((left, right) => left.sentAt.localeCompare(right.sentAt)
        || left.messageId.localeCompare(right.messageId));
  }

  async function requestWork(input) {
    return sendMessage({
      sessionId: input.sessionId,
      generation: input.generation,
      toParticipantIds: [input.toParticipantId],
      type: "work_request",
      subject: input.title,
      body: input.detail ?? input.title,
      requiresAck: true,
      descriptor: input.descriptor,
    });
  }

  return { sendMessage, markDelivery, pendingMessages, requestWork, finishSession };
}
