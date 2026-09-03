import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "../src/errors.mjs";
import { RECORD_KINDS, SCHEMA_VERSION, validateRecord } from "../src/schema.mjs";

const NOW = "2026-08-16T01:00:00.000Z";
const base = fields => ({ schemaVersion: SCHEMA_VERSION, ...fields });

const MESSAGE = base({
  messageId: "message_a", threadId: "message_a", clientMessageId: "client_a",
  workspaceId: "workspace_a", fromParticipantId: "participant_a",
  fromSessionId: "session_a", toParticipantIds: ["participant_b"],
  kind: "question", obligation: "reply", subject: "API name", body: "Which one?",
  inReplyTo: null, artifacts: [], handoff: null, sentAt: NOW,
});

const VALID = {
  workspace: base({ workspaceId: "workspace_a", displayName: "Example",
    source: "directory", roots: ["/tmp/example"], createdAt: NOW }),
  participant: base({ participantId: "participant_a", workspaceId: "workspace_a",
    displayName: "visual", kind: "agent", createdAt: NOW }),
  session: base({ sessionId: "session_a", participantId: "participant_a",
    workspaceId: "workspace_a", generation: "generation_a", harness: "codex",
    state: "open", parentSessionId: null, checkoutRoot: null, branch: null, pid: null,
    enforcement: "guarded", lifecycle: "managed", heartbeatCadenceMs: 30_000,
    startedAt: NOW, heartbeatAt: NOW }),
  intent: base({ sessionId: "session_a", workspaceId: "workspace_a",
    summary: "reviewing the claim model", mode: "review", resourceHints: [],
    state: "active", updatedAt: NOW }),
  claim: base({ claimId: "claim_a", workspaceId: "workspace_a",
    ownerSessionId: "session_a", resource: "file:src/main.mjs", mode: "exclusive",
    enforcement: "advisory", reason: "editing", acquiredAt: NOW,
    expiresAt: NOW, generation: "generation_a" }),
  message: MESSAGE,
  receipt: base({ messageId: "message_a", workspaceId: "workspace_a",
    recipientParticipantId: "participant_b", state: "queued", updatedAt: NOW }),
  event: base({ sequence: "0000000000000001", eventId: "event_a",
    workspaceId: "workspace_a", actorSessionId: "session_a", type: "session.opened",
    occurredAt: NOW, payload: {} }),
};

const DELIVERY_BINDING = base({
  sessionId: "session_a", generation: "generation_a", adapterId: "codex",
  clientVersion: "1.2.3", availableModes: ["nextTurn", "livePush", "replyRoute"],
  livePolicy: "actionable", opaqueEndpointRef: "socket_a", leaseUntil: NOW,
  retiredAt: null,
});

test("durable record kinds are exactly the v0.2 snapshot vocabulary", () => {
  assert.deepEqual([...RECORD_KINDS].sort(), Object.keys(VALID).sort());
  assert.equal(RECORD_KINDS.includes("deliveryBinding"), false);
});

for (const [kind, fixture] of Object.entries(VALID)) {
  test(`${kind} accepts its minimal v0.2 fixture`, () => {
    assert.deepEqual(validateRecord(kind, fixture), fixture);
  });

  test(`${kind} rejects every missing required field`, () => {
    for (const field of Object.keys(fixture)) {
      const broken = { ...fixture };
      delete broken[field];
      assert.throws(() => validateRecord(kind, broken),
        error => error.code === EXIT.DATA && error.message.includes(field),
        `${kind} accepted a record with no ${field}`);
    }
  });

  test(`${kind} rejects unknown fields and schema versions`, () => {
    assert.throws(() => validateRecord(kind, { ...fixture, smuggled: 1 }),
      error => error.code === EXIT.DATA && error.message.includes("smuggled"));
    assert.throws(() => validateRecord(kind, { ...fixture, schemaVersion: 2 }),
      error => error.code === EXIT.DATA && error.message.includes("schemaVersion"));
  });

  test(`${kind} accepts forward-compatible metadata only under extensions`, () => {
    const extended = { ...fixture, extensions: { vendorHint: "anything" } };
    assert.deepEqual(validateRecord(kind, extended), extended);
  });
}

test("delivery bindings are validated without joining the durable record kinds", () => {
  assert.deepEqual(validateRecord("deliveryBinding", DELIVERY_BINDING), DELIVERY_BINDING);
  const native = { ...DELIVERY_BINDING,
    availableModes: ["nextTurn", "livePush", "idleWake", "busyQueue", "replyRoute"] };
  assert.deepEqual(validateRecord("deliveryBinding", native), native);
  assert.throws(() => validateRecord("deliveryBinding",
    { ...DELIVERY_BINDING, availableModes: ["livePush", "livePush"] }),
  error => error.code === EXIT.DATA && error.message.includes("availableModes")
    && /repeat/.test(error.message));
  assert.throws(() => validateRecord("deliveryBinding",
    { ...DELIVERY_BINDING, availableModes: ["telepathy"] }),
  error => error.code === EXIT.DATA && error.message.includes("availableModes"));
  assert.throws(() => validateRecord("deliveryBinding",
    { ...DELIVERY_BINDING, livePolicy: "implicit" }),
  error => error.code === EXIT.DATA && error.message.includes("livePolicy"));
  // Retirement is a fact of its own, not an expired lease: a channel that is
  // still renewing must not be able to express "given up" by moving a date.
  const retired = { ...DELIVERY_BINDING, retiredAt: NOW };
  assert.deepEqual(validateRecord("deliveryBinding", retired), retired);
  assert.throws(() => validateRecord("deliveryBinding",
    { ...DELIVERY_BINDING, retiredAt: "yesterday" }),
  error => error.code === EXIT.DATA && error.message.includes("retiredAt"));
});

test("intent rejects the removed orchestration handle", () => {
  assert.throws(() => validateRecord("intent",
    { ...VALID.intent, workstreamId: "workstream_a" }),
  error => error.code === EXIT.DATA && error.message.includes("workstreamId"));
});

test("message artifacts and structured handoffs reject unknown nested fields", () => {
  const artifact = { kind: "file", uri: "file:build/report.json", description: "report" };
  const handoff = { status: "partial", completed: ["schema"], remaining: ["router"],
    blockers: [], verification: [artifact] };
  const message = { ...MESSAGE, kind: "handoff", obligation: "acknowledge",
    artifacts: [artifact], handoff };
  assert.deepEqual(validateRecord("message", message), message);
  assert.throws(() => validateRecord("message", { ...message,
    handoff: { ...handoff, taskId: "task_a" } }), /taskId/);
});

test("only the closed v0.2 event vocabulary is accepted", () => {
  const messageEvents = ["message.recorded", "message.offered", "message.retrieved",
    "message.acknowledged", "message.offer_succeeded", "message.offer_failed"];
  for (const type of messageEvents) {
    assert.equal(validateRecord("event", { ...VALID.event, type }).type, type);
  }
  for (const type of ["message.sent", "message.seen", "message.injected", "message.failed",
    "task.created", "work.requested", "decision.recorded", "handoff.created"]) {
    assert.throws(() => validateRecord("event", { ...VALID.event, type }),
      error => error.code === EXIT.DATA, `accepted removed event ${type}`);
  }
});

test("unknown kinds, invalid identifiers, timestamps, and resource URIs are rejected", () => {
  assert.throws(() => validateRecord("task", {}),
    error => error.code === EXIT.DATA && error.message.includes("task"));
  assert.throws(() => validateRecord("session", { ...VALID.session, sessionId: "../escape" }),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateRecord("workspace", { ...VALID.workspace, createdAt: "yesterday" }),
    error => error.code === EXIT.DATA);
  assert.throws(() => validateRecord("claim", { ...VALID.claim, resource: "src/main.mjs" }),
    error => error.code === EXIT.DATA);
});
