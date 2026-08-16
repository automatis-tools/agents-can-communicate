import { AccError, EXIT, SCHEMA_VERSION, advanceDelivery, createId, validateRecord }
  from "@agents-can-communicate/protocol";

import { ensureMaterialised } from "./materialisation.mjs";

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
    });
    return record;
  }

  async function markDelivery(input) {
    const session = await requireOpenSession(input, "update delivery");
    const now = clock.now();
    let record = null;
    await store.transaction(async tx => {
      const id = receiptId(input.messageId, input.recipientParticipantId);
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
          recipientParticipantId: input.recipientParticipantId } });
    });
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
    });
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
    const owned = (await store.snapshot(workspaceId)).claims
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
    });
    for (const claim of owned) {
      await claims.releaseClaim({ claimId: claim.claimId, sessionId: session.sessionId,
        generation: session.generation, workspaceId });
    }
    return record;
  }

  return { sendMessage, markDelivery, recordDecision, finishSession };
}
