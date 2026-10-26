import assert from "node:assert/strict";
import test from "node:test";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

// Discussion #180: Claude asked Codex for a review and its session ended; Codex's
// answer stayed queued, and the next Claude session was never told it existed.
const WORKSPACE = "workspace_left_messages";

function makeService() {
  const clock = createFakeClock("2026-10-25T12:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return { clock, store, service: createCoordinationService({ store, clock, ids: createFakeIds(),
    pidIsAlive: () => false }) };
}

const opening = participantId => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness: "test", heartbeatCadenceMs: 60_000 });
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function reviewLeftBehind(service, clock) {
  const claudeA = await service.openSession(opening("claude_a"));
  const codex = await service.openSession(opening("codex"));
  const request = await service.sendMessage({ ...owner(claudeA), clientMessageId: "review",
    toParticipantIds: ["codex"], kind: "request", obligation: "reply",
    subject: "review the feature", body: "Report concrete issues; do not edit." });
  const { reply } = await service.replyToMessage({ ...owner(codex), messageId: request.messageId,
    clientMessageId: "findings", body: "Two edge cases are untested." });
  await service.closeSession({ ...owner(claudeA), workspaceId: WORKSPACE });
  clock.advance(60_000);
  return { claudeA, codex, request, reply };
}

const leftItems = async (service, session) =>
  (await service.sync({ ...owner(session), workspaceId: WORKSPACE })).attention
    .filter(item => item.kind === "left_for_ended_session");

test("a later session is told about an answer left for a session that ended", async () => {
  const { service, clock } = makeService();
  const { reply } = await reviewLeftBehind(service, clock);
  const claudeB = await service.openSession(opening("claude_b"));

  const items = await leftItems(service, claudeB);

  assert.deepEqual(items.map(item => item.sourceId), [reply.messageId]);
  assert.match(items[0].summary, /waiting for claude_a/);
  assert.match(items[0].summary, new RegExp(`sync --scope history --message ${reply.messageId}`));
  assert.equal((await service.readReceipt({ messageId: reply.messageId,
    recipientParticipantId: "claude_a" })).state, "queued");
});

test("the sender of the left message is not told about it", async () => {
  const { service, clock } = makeService();
  const { codex } = await reviewLeftBehind(service, clock);

  assert.deepEqual(await leftItems(service, codex), []);
});

test("a recipient whose session is only paused is not reported", async () => {
  const { service, clock } = makeService();
  const paused = await service.openSession(opening("claude_a"));
  const codex = await service.openSession(opening("codex"));
  await service.sendMessage({ ...owner(codex), clientMessageId: "note",
    toParticipantIds: ["claude_a"], kind: "note", obligation: "none",
    subject: "schema verified", body: "No migration is planned." });
  clock.advance(5 * 60_000);
  await service.heartbeatSession({ ...owner(codex), workspaceId: WORKSPACE });
  const claudeB = await service.openSession(opening("claude_b"));

  const presence = (await service.collectStatus({ workspaceId: WORKSPACE })).participants
    .find(item => item.participantId === "claude_a").presence;
  assert.equal(presence, "stale", `fixture expected a paused recipient, got ${presence}`);
  assert.deepEqual(await leftItems(service, claudeB), []);
  assert.ok(paused);
});

test("a session is told about a left message once, and another session still is", async () => {
  const { service, clock } = makeService();
  const { reply } = await reviewLeftBehind(service, clock);
  const claudeB = await service.openSession(opening("claude_b"));
  const claudeC = await service.openSession(opening("claude_c"));

  await service.recordNotices({ ...owner(claudeB), workspaceId: WORKSPACE,
    messageIds: [reply.messageId] });

  assert.deepEqual(await leftItems(service, claudeB), []);
  assert.deepEqual((await leftItems(service, claudeC)).map(item => item.sourceId), [reply.messageId]);
});

test("only the five newest left messages are reported", async () => {
  const { service, clock } = makeService();
  const claudeA = await service.openSession(opening("claude_a"));
  const codex = await service.openSession(opening("codex"));
  const sent = [];
  for (let index = 0; index < 7; index += 1) {
    sent.push(await service.sendMessage({ ...owner(codex), clientMessageId: `note_${index}`,
      toParticipantIds: ["claude_a"], kind: "note", obligation: "none",
      subject: `finding ${index}`, body: `Finding number ${index}.` }));
    clock.advance(1_000);
  }
  await service.closeSession({ ...owner(claudeA), workspaceId: WORKSPACE });
  const claudeB = await service.openSession(opening("claude_b"));

  const items = await leftItems(service, claudeB);

  // The newest five are chosen; attention keeps its usual order within a priority.
  assert.deepEqual(items.map(item => item.sourceId),
    sent.slice(2).map(message => message.messageId).sort());
});

test("a left message older than seven days is not reported", async () => {
  const { service, clock } = makeService();
  await reviewLeftBehind(service, clock);
  clock.advance(7 * 24 * 60 * 60_000);
  const claudeB = await service.openSession(opening("claude_b"));

  assert.deepEqual(await leftItems(service, claudeB), []);
});

test("a superseded decision left for an ended session is not reported, its successor is", async () => {
  const { service, clock } = makeService();
  const claudeA = await service.openSession(opening("claude_a"));
  const codex = await service.openSession(opening("codex"));
  const first = await service.sendMessage({ ...owner(codex), clientMessageId: "port_1",
    toParticipantIds: ["claude_a"], kind: "decision", obligation: "acknowledge",
    subject: "Port choice", body: "Use port 7319." });
  const second = await service.sendMessage({ ...owner(codex), clientMessageId: "port_2",
    toParticipantIds: ["claude_a"], kind: "decision", obligation: "acknowledge",
    supersedes: [first.messageId], subject: "Port choice", body: "Use port 7320." });
  await service.closeSession({ ...owner(claudeA), workspaceId: WORKSPACE });
  clock.advance(60_000);
  const claudeB = await service.openSession(opening("claude_b"));

  assert.deepEqual((await leftItems(service, claudeB)).map(item => item.sourceId),
    [second.messageId]);
});

test("a room-wide status lists every left message", async () => {
  const { service, clock } = makeService();
  const { reply } = await reviewLeftBehind(service, clock);

  const attention = (await service.collectStatus({ workspaceId: WORKSPACE })).attention
    .filter(item => item.kind === "left_for_ended_session");

  assert.deepEqual(attention.map(item => item.sourceId), [reply.messageId]);
});

test("a session remembers the sixty-four newest notices it was given", async () => {
  const { service } = makeService();
  const claudeB = await service.openSession(opening("claude_b"));
  const ids = Array.from({ length: 70 }, (_, index) => `message_notice_${String(index).padStart(2, "0")}`);

  await service.recordNotices({ ...owner(claudeB), workspaceId: WORKSPACE, messageIds: ids.slice(0, 40) });
  const record = await service.recordNotices({ ...owner(claudeB), workspaceId: WORKSPACE,
    messageIds: ids.slice(40) });

  assert.deepEqual(record.extensions.noticedLeftMessages, ids.slice(6));
});
