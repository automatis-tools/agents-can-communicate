import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { projectContextResult } from "@agents-can-communicate/adapter-sdk";
import { runHook } from "@agents-can-communicate/hook-runner";
import { createStoreIoProbe } from "../helpers/store-io-probe.mjs";

// What one hook reads, counted on the real store. A turn used to read every
// message and receipt the workspace held three times - twice for its context and
// once more for a status nothing used - and its heartbeat read every session the
// workspace ever had. In real workspaces that was 1.2 s to 6 s a hook, past the
// five-second budget in one of them, where the hook fails open (#298).
const adapter = {
  id: "test",
  client: { command: "test-client", certificationName: "test-client", versionArgs: ["--version"] },
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence: [{ client: "test-client", version: "1.0.0",
    platform: `${process.platform}-${process.arch}`, capability: "delivery.nextTurn",
    result: "pass" }] },
  normalizeHook: payload => payload,
  injectOutcome: context => ({ stdout: context, exitCode: 0 }),
  renderContext: sync => projectContextResult(sync).text,
  renderContextResult: (sync, options) => projectContextResult(sync, options),
};
const MESSAGES = 30;
const PEERS = 12;
// Setup is not what is measured, and a loaded machine must not fail it open.
const UNHURRIED = { budgetMs: 30_000 };
const event = (kind, cwd, sessionId) => ({ kind, cwd, sessionId,
  model: null, parentSessionId: null, tool: null, targets: [] });

test("a turn reads each message and receipt once, and its heartbeat one session", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hook-reads-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hook-reads-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const invoke = (kind, sessionId, options = {}) => runHook({ adapterId: "test",
    payload: event(kind, root, sessionId), adapters: { test: adapter }, dataHome,
    readProcessTable: async () => new Map(), probeClientVersion: async () => "1.0.0",
    ...UNHURRIED, ...options });
  const recipient = await invoke("sessionStart", "recipient-session", { includeSessions: true });
  const sender = await invoke("sessionStart", "sender-session");
  for (let i = 0; i < PEERS; i += 1) await invoke("sessionStart", `peer-session-${i}`);
  const recipientId = recipient.sessions
    .find(item => item.sessionId === recipient.accSessionId).participantId;
  const messages = [];
  for (let i = 0; i < MESSAGES; i += 1) {
    messages.push(await sender.service.sendMessage({ sessionId: sender.accSessionId, generation: sender.generation,
      clientMessageId: `client_read_cost_${i}`, toParticipantIds: [recipientId], kind: "note",
      obligation: "none", subject: `Backlog ${i}`, body: "A message the turn has to consider." }));
  }
  const store = recipient.service.store;
  const stored = await store.snapshot(store.workspaceId);
  assert.equal(stored.messages.length, MESSAGES);
  assert.equal(stored.sessions.length, PEERS + 2);

  const probe = createStoreIoProbe(store.root);
  t.after(() => probe.stop());
  const turn = await probe.capture(() => invoke("beforeTurn", "recipient-session"));
  t.diagnostic(JSON.stringify(turn.stateByKind));
  assert.equal(turn.result.failed, undefined, turn.result.reason);
  assert.equal(turn.result.timedOut, undefined);
  assert.deepEqual(turn.result.sessions, [],
    "fourteen sessions are present, and the hook entry point asks for none of them");
  assert.match(turn.result.stdout, /A message the turn has to consider\./);
  const rendered = messages.find(message => turn.result.stdout.includes(message.messageId));
  assert.ok(rendered, "stdout identifies an actual sent message");
  await turn.result.commitOffers();
  // Services retain their hook deadline; use this turn, not the setup hook.
  const receipt = await turn.result.service.readReceipt({ messageId: rendered.messageId,
    recipientParticipantId: recipientId });
  assert.equal(receipt.messageId, rendered.messageId);
  assert.equal(receipt.recipientParticipantId, recipientId);
  assert.equal(receipt.state, "offered");
  assert.equal(turn.stateByKind.message, MESSAGES, "each message is read once a turn");
  assert.equal(turn.stateByKind.receipt, stored.receipts.length, "each receipt is read once a turn");
  // The turn's one read of the store lists every session once; finding this
  // session and its heartbeat read only their own record.
  assert.ok(turn.stateByKind.session <= stored.sessions.length + 3,
    `a turn read ${turn.stateByKind.session} session records of ${stored.sessions.length}`);

  const beat = await probe.capture(() => turn.result.service.heartbeatSession({
    sessionId: recipient.accSessionId, generation: recipient.generation }));
  assert.equal(beat.result.sessionId, recipient.accSessionId);
  assert.equal(beat.result.generation, recipient.generation);
  assert.deepEqual(beat.stateByKind, { session: 1 }, "a heartbeat reads its own session alone");
});
