import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { createCoordinationService } from "../src/service.mjs";
import { createFakeClock, createFakeIds, createMemoryStore }
  from "../../../tests/helpers/memory-store.mjs";

/**
 * Addressing a peer by the client it runs in.
 *
 * Every shipped example taught `--to models` or `--to claude_code`, and neither
 * resolved: recipients were exact participant ids only, so an agent following
 * its own skill got `no participant here is called claude_code` on its first
 * attempt to reach anyone - and the skill tells it to give up quietly on a
 * failed command. The examples were wrong for eighteen months of instructions
 * nobody could follow.
 *
 * A client name is what an agent actually knows about its peers: the roster it
 * is handed says `codex`, not `codex-fbqX8o`. So one live session of a client
 * resolves; several refuse and name them, the way `--session` already does,
 * because guessing which of two Codex sessions was meant is how a message ends
 * up answered by the wrong one.
 */
const WORKSPACE = "workspace_addressing";

function makeService() {
  const clock = createFakeClock("2026-09-04T09:00:00.000Z");
  const store = createMemoryStore({ clock, ids: createFakeIds(), workspaceId: WORKSPACE });
  return createCoordinationService({ store, clock, ids: createFakeIds() });
}

const opening = (participantId, harness) => ({ workspaceId: WORKSPACE, participantId,
  displayName: participantId, harness, heartbeatCadenceMs: 60_000 });

const send = (service, session, to, clientMessageId = "client_1") => service.sendMessage({
  sessionId: session.sessionId, generation: session.generation, clientMessageId,
  toParticipantIds: [to], kind: "question", obligation: "reply",
  subject: "s", body: "b", inReplyTo: null, artifacts: [], handoff: null });

test("one live session of a client is addressable by the client's name", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));
  await service.openSession(opening("codex-bbb", "codex"));

  const message = await service.sendMessage({ sessionId: asker.sessionId,
    generation: asker.generation, clientMessageId: "client_1",
    toParticipantIds: ["codex"], kind: "question", obligation: "reply",
    subject: "s", body: "b", inReplyTo: null, artifacts: [], handoff: null });

  // The record names the participant, not the alias that reached it: a stored
  // message that says `codex` would address nobody when it is read back.
  assert.deepEqual(message.toParticipantIds, ["codex-bbb"]);
});

test("an exact participant id still wins over a client name", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));
  // A participant may be renamed through ACC_PARTICIPANT, including to something
  // that looks like a client name. The exact id is never overruled by a guess.
  await service.openSession(opening("codex", "codex"));
  await service.openSession(opening("codex-bbb", "codex"));

  const message = await send(service, asker, "codex");

  assert.deepEqual(message.toParticipantIds, ["codex"]);
});

test("two sessions of one client refuse rather than pick one", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));
  await service.openSession(opening("codex-bbb", "codex"));
  await service.openSession(opening("codex-ccc", "codex"));

  await assert.rejects(send(service, asker, "codex"), error => {
    assert.equal(error.code, EXIT.USAGE);
    assert.match(error.message, /which of 2 codex sessions/);
    // Naming them is what makes the refusal actionable rather than a dead end.
    assert.match(error.message, /codex-bbb/);
    assert.match(error.message, /codex-ccc/);
    return true;
  });
});

test("a client nobody is running is still an unknown recipient", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));

  await assert.rejects(send(service, asker, "codex"), error => {
    assert.equal(error.code, EXIT.DATA);
    assert.match(error.message, /no participant here is called codex/);
    return true;
  });
});

test("a client name never resolves to the sender itself", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));

  // Otherwise the one client you are certain is running - your own - becomes the
  // easiest thing to address by accident.
  await assert.rejects(send(service, asker, "claude_code"), error => {
    assert.equal(error.code, EXIT.DATA);
    return true;
  });
});

test("a retry with the same client name is the same message, not a conflict", async () => {
  const service = makeService();
  const asker = await service.openSession(opening("claude_code-aaa", "claude_code"));
  await service.openSession(opening("codex-bbb", "codex"));

  const first = await send(service, asker, "codex");
  const again = await send(service, asker, "codex");

  // Resolution happens before the idempotency comparison, so the retry matches
  // the stored content instead of reading as a different message.
  assert.equal(again.messageId, first.messageId);
});
