import { AccError, EXIT, SCHEMA_VERSION, advanceDelivery, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";
import { writeTask } from "./tasks.mjs";

const receiptId = (messageId, recipient) => `${messageId}--${recipient}`;

// Peer content is data, never authority. Messages carry attribution and a
// typed intent; nothing in a body can change policy or promote a proposal.
/**
 * Everyone this workspace has ever seen.
 *
 * Participants are created when a session attaches and are never removed, so
 * "has been here" is the right test and "is here now" is not: work is addressed
 * to a participant precisely so it survives their session ending.
 *
 * Before anything durable is written the participants live in the ephemeral
 * area, which is where a workspace with one session keeps everything.
 */
async function knownParticipants(store, workspaceId) {
  const snapshot = await store.snapshot(workspaceId,
    { kinds: ["workspace", "participant"] });
  const durable = snapshot.workspace !== null
    ? snapshot.participants
    : await store.ephemeral.list("participant");
  return new Set(durable.map(participant => participant.participantId));
}

/**
 * A recipient nobody has ever been is a typo, and saying "sent" to one is the
 * worst answer available: `acc message --to physcis` reported success, the
 * message went nowhere, and the agent that meant `physics` had no way to find
 * out. `acc request` was worse - it made a task addressed to nobody, and the
 * requester waited for an agent that does not exist.
 *
 * It also bounds the recipient list by construction. Nothing did: one message
 * naming three thousand participants took 24.8 seconds, wrote three thousand
 * receipts, and left every session in that workspace paying 5.1 seconds to
 * attach and take one turn - past the point where a hook gives up and allows
 * whatever it was guarding.
 */
async function assertKnownRecipients(store, workspaceId, recipients) {
  const known = await knownParticipants(store, workspaceId);
  const strangers = [...new Set(recipients)].filter(name => !known.has(name));
  if (strangers.length === 0) return;
  // Not a usage error: the command is well formed and the workspace disagrees
  // with it. Which matters beyond tidiness - the gate that runs every documented
  // command holds them to being *accepted*, and every example names a peer that
  // a fresh sandbox has never seen.
  throw new AccError(EXIT.DATA,
    `no participant here is called ${strangers.join(", ")}. `
    + `This workspace has: ${[...known].sort().join(", ") || "nobody else yet"}`,
    { strangers, known: [...known].sort() });
}

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
    await assertKnownRecipients(store, workspaceId, recipients);

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

  async function recordDecision(input) {
    const session = await requireOpenSession(input, "record a decision");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, reason: "durable_object" });
    // A peer proposal never becomes a human-authority decision on its own.
    if (input.authority === "human" && input.humanConfirmed !== true) {
      throw new AccError(EXIT.CONFLICT,
        "human authority requires an explicit human confirmation", { authority: "human" });
    }
    const now = clock.now();
    const decisionId = createId("decision");
    const record = validateRecord("decision", {
      schemaVersion: SCHEMA_VERSION,
      decisionId,
      workspaceId,
      workstreamId: input.workstreamId ?? null,
      title: input.title,
      outcome: input.outcome,
      authority: input.authority,
      decidedBy: input.decidedBy ?? [session.participantId],
      evidence: input.evidence ?? [],
      supersedes: input.supersedes ?? null,
      decidedAt: now,
    });
    await store.transaction(async tx => {
      if (record.supersedes !== null && tx.get("decision", record.supersedes) === null) {
        throw new AccError(EXIT.DATA, "the superseded decision does not exist",
          { supersedes: record.supersedes });
      }
      tx.put("decision", decisionId, record);
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "decision.recorded", occurredAt: now,
        payload: { decisionId, authority: record.authority } });
    }, { kinds: ["decision"] });
    return record;
  }

  /**
   * Produce a handoff and release what this session owned. The semantic summary
   * is written while the model is still active; session end only closes
   * lifecycle ownership.
   */
  async function finishSession(input) {
    const session = await requireOpenSession(input, "finish");
    const workspaceId = session.workspaceId;
    await ensureMaterialised(ports, { workspaceId, reason: "durable_object" });
    const now = clock.now();
    const handoffId = createId("handoff");
    const owned = (await store.snapshot(workspaceId, { kinds: ["claim"] })).claims
      .filter(claim => claim.ownerSessionId === session.sessionId);
    const record = validateRecord("handoff", {
      schemaVersion: SCHEMA_VERSION,
      handoffId,
      workspaceId,
      fromSessionId: session.sessionId,
      toParticipantId: input.toParticipantId ?? null,
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

  /**
   * Ask another agent to do something.
   *
   * One write, because the two halves are useless apart. A task addressed to
   * someone who was never told about it is work nobody knows exists, and a
   * message describing work that was never recorded is a request with nothing
   * to point at.
   *
   * The recipient learns about it twice over, and both paths already existed:
   * the task raises a `task_unblocked` attention item for the participant it
   * names, and the message reaches their turn as quoted peer text.
   */
  async function requestWork(input) {
    const session = await requireOpenSession(input, "request work");
    const workspaceId = session.workspaceId;
    const recipient = input.toParticipantId;
    if (typeof recipient !== "string" || recipient === "") {
      throw new AccError(EXIT.USAGE, "a request needs a recipient participant");
    }
    await ensureMaterialised(ports, { workspaceId, descriptor: input.descriptor,
      reason: "durable_object" });
    await assertKnownRecipients(store, workspaceId, [recipient]);
    const now = clock.now();
    const messageId = createId("message");
    let task = null;
    let message = null;

    await store.transaction(async tx => {
      task = writeTask(tx, { session, workspaceId, now, ids,
        input: { ...input, assigneeParticipantId: recipient,
          requestedByParticipantId: session.participantId } });
      message = validateRecord("message", {
        schemaVersion: SCHEMA_VERSION,
        messageId,
        workspaceId,
        fromSessionId: session.sessionId,
        fromParticipantId: session.participantId,
        toParticipantIds: [recipient],
        type: "work_request",
        subject: input.title,
        body: input.detail ?? input.title,
        priority: input.priority ?? "normal",
        workstreamId: task.workstreamId,
        taskId: task.taskId,
        inReplyTo: input.inReplyTo ?? null,
        // A request is a question, so the sender is entitled to know whether it
        // was taken up. Silence and refusal are different answers.
        requiresAck: true,
        artifacts: input.artifacts ?? [],
        sentAt: now,
      });
      tx.put("message", messageId, message);
      tx.put("receipt", receiptId(messageId, recipient), validateRecord("receipt", {
        schemaVersion: SCHEMA_VERSION,
        messageId,
        workspaceId,
        recipientParticipantId: recipient,
        state: "queued",
        updatedAt: now,
      }));
      tx.append({ schemaVersion: SCHEMA_VERSION, eventId: ids.next("event"), workspaceId,
        actorSessionId: session.sessionId, type: "work.requested", occurredAt: now,
        payload: { taskId: task.taskId, messageId, recipient } });
    // `writeTask` runs on this handle, so what it reads is read here.
    }, { kinds: ["message", "receipt", "session", "task", "workstream"] });
    return { task, message };
  }

  return { sendMessage, markDelivery, pendingMessages, requestWork, recordDecision,
    finishSession };
}
