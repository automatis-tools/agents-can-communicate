import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { projectContextResult } from "@agents-can-communicate/adapter-sdk";
import { runHook } from "@agents-can-communicate/hook-runner";
import { completeHookOutput, writeOutput } from "../../bin/acc-hook.mjs";

// Kept cohesive above 300 lines because every case shares one durable
// two-session hook fixture and jointly proves the stdout/deadline/receipt
// boundary; splitting would duplicate the real process composition under test.

const adapter = {
  id: "test",
  client: { command: "test-client", certificationName: "test-client",
    versionArgs: ["--version"] },
  capabilities: { delivery: { nextTurn: true } },
  certification: { evidence: [{ client: "test-client", version: "1.0.0",
    platform: `${process.platform}-${process.arch}`, capability: "delivery.nextTurn",
    result: "pass" }] },
  normalizeHook: payload => payload,
  injectOutcome: context => ({ stdout: context, exitCode: 0 }),
  renderContext: sync => projectContextResult(sync).text,
  renderContextResult: (sync, options) => projectContextResult(sync, options),
};

const noProcessTable = async () => new Map();
const event = (kind, cwd, sessionId) => ({ kind, cwd, sessionId,
  model: null, parentSessionId: null, tool: null, targets: [] });

async function fixture(t, { clientVersion = "1.0.0", selectedAdapter = adapter } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-offer-write-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-offer-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  const invoke = (kind, sessionId, options = {}) => runHook({ adapterId: "test",
    payload: event(kind, root, sessionId), adapters: { test: selectedAdapter }, dataHome,
    readProcessTable: noProcessTable, probeClientVersion: async () => clientVersion,
    ...options });
  const recipient = await invoke("sessionStart", "recipient-session");
  const sender = await invoke("sessionStart", "sender-session");
  const recipientId = recipient.sessions
    .find(item => item.sessionId === recipient.accSessionId).participantId;
  const message = await sender.service.sendMessage({ sessionId: sender.accSessionId,
    generation: sender.generation, clientMessageId: "client_offer_after_write",
    toParticipantIds: [recipientId], kind: "question", obligation: "reply",
    subject: "Write boundary", body: "Commit only after these bytes cross." });
  const receipt = async () => (await recipient.service.store.snapshot(
    recipient.service.store.workspaceId)).receipts
    .find(item => item.messageId === message.messageId);
  return { invoke, message, receipt, recipient, recipientId, sender };
}

test("renderer existence cannot deliver for an adapter with no certified capabilities", async t => {
  const unsupported = { ...adapter, capabilities: {}, certification: { evidence: [] } };
  const { invoke, receipt } = await fixture(t, { selectedAdapter: unsupported });
  const result = await invoke("beforeTurn", "recipient-session");

  assert.doesNotMatch(result.stdout, /Commit only after these bytes cross/);
  assert.match(result.stderr, /pending message.*withheld/);
  await result.commitOffers();
  assert.equal((await receipt()).state, "queued");
});

test("next-turn offer stays queued until the stdout writer completes", async t => {
  const { invoke, message, receipt } = await fixture(t);
  const written = [];
  const writeOutput = async output => {
    written.push(output);
    assert.equal((await receipt()).state, "queued",
      "the receipt advanced while stdout was still crossing its boundary");
  };

  const result = await invoke("beforeTurn", "recipient-session");
  assert.equal((await receipt()).state, "queued");
  await writeOutput(result.stdout);
  assert.equal((await receipt()).state, "queued");
  await result.commitOffers();

  assert.equal((await receipt()).state, "offered");
  assert.equal(written.length, 1);
  assert.match(written[0], new RegExp(message.messageId));
});

test("the offer records the exact client version observed for the recipient session", async t => {
  const { invoke, message, sender } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session");
  await result.commitOffers();

  const events = (await sender.service.store.eventsSince(
    sender.service.store.workspaceId, null, 100)).events;
  const offered = events.find(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === message.messageId);
  assert.equal(offered.payload.clientVersion, "1.0.0");
});

for (const [label, clientVersion] of [["unknown", null], ["uncertified", "9.9.9"]]) {
  test(`${label} client versions withhold next-turn bodies and offers`, async t => {
    const { invoke, message, receipt } = await fixture(t, { clientVersion });
    const result = await invoke("beforeTurn", "recipient-session");

    assert.doesNotMatch(result.stdout, /Commit only after these bytes cross/);
    assert.match(result.stderr, /pending message.*withheld/);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(message.messageId));
    await result.commitOffers();
    assert.equal((await receipt()).state, "queued");
  });
}

test("committing the same prepared offers twice is idempotent", async t => {
  const { invoke, message, receipt, sender } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session");

  await result.commitOffers();
  await result.commitOffers();

  assert.equal((await receipt()).state, "offered");
  const events = (await sender.service.store.eventsSince(
    sender.service.store.workspaceId, null, 100)).events;
  assert.equal(events.filter(item => item.type === "message.offer_succeeded"
    && item.payload.messageId === message.messageId).length, 1);
});

test("a rejected offer commit leaves that receipt queued", async t => {
  const { invoke, receipt, recipient } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session");
  await recipient.service.closeSession({ sessionId: recipient.accSessionId,
    generation: recipient.generation });

  await assert.rejects(result.commitOffers, /target|generation|open session/);

  assert.equal((await receipt()).state, "queued");
});

test("an expired hook budget refuses to start an offer commit", async t => {
  const { invoke, receipt } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session", { budgetMs: 1_000 });
  await new Promise(resolve => setTimeout(resolve, 1_050));

  await assert.rejects(result.commitOffers, /budget exhausted/);

  assert.equal((await receipt()).state, "queued");
});

test("a retrieved obligation is never described as live-offered", async t => {
  const { invoke, message, receipt, recipient } = await fixture(t);
  await recipient.service.readInbox({ sessionId: recipient.accSessionId,
    generation: recipient.generation, messageId: message.messageId });
  assert.equal((await receipt()).state, "retrieved");

  const result = await invoke("beforeTurn", "recipient-session");

  assert.match(result.stdout, new RegExp(message.messageId));
  assert.doesNotMatch(result.stdout, /live-offered/);
  await result.commitOffers();
  assert.equal((await receipt()).state, "retrieved");
});

test("an actually offered obligation becomes the compact recovery breadcrumb", async t => {
  const { invoke, message, receipt } = await fixture(t);
  const first = await invoke("beforeTurn", "recipient-session");
  await first.commitOffers();
  assert.equal((await receipt()).state, "offered");

  const second = await invoke("beforeTurn", "recipient-session");

  assert.match(second.stdout, new RegExp(`live-offered peer question remains unresolved; `
    + `\`acc inbox --message ${message.messageId}\``));
  assert.doesNotMatch(second.stdout, /Commit only after these bytes cross/);
});

test("one turn offers every fitting addressed receipt and never a room receipt", async t => {
  const { invoke, recipient, recipientId, sender } = await fixture(t);
  const other = await invoke("sessionStart", "other-recipient-session");
  const otherId = other.sessions.find(item => item.sessionId === other.accSessionId).participantId;
  const send = (clientMessageId, toParticipantIds, subject) => sender.service.sendMessage({
    sessionId: sender.accSessionId, generation: sender.generation, clientMessageId,
    toParticipantIds, kind: "note", obligation: "none", subject, body: `${subject} body`,
  });
  const direct = await send("client_direct", [recipientId], "direct");
  const shared = await send("client_shared", [recipientId, otherId], "shared");
  const room = await send("client_room", [], "room-only");

  const result = await invoke("beforeTurn", "recipient-session");
  assert.match(result.stdout, new RegExp(direct.messageId));
  assert.match(result.stdout, new RegExp(shared.messageId));
  assert.doesNotMatch(result.stdout, new RegExp(room.messageId));
  const attention = await recipient.service.sync({ sessionId: recipient.accSessionId,
    scope: "delta" });
  assert.equal(attention.attention.some(item => item.sourceId === room.messageId), false,
    "a valid room note created live obligation attention");
  await result.commitOffers();

  const receipts = (await sender.service.store.snapshot(sender.service.store.workspaceId))
    .receipts;
  const state = (messageId, participantId) => receipts.find(item =>
    item.messageId === messageId && item.recipientParticipantId === participantId)?.state;
  assert.equal(state(direct.messageId, recipientId), "offered");
  assert.equal(state(shared.messageId, recipientId), "offered");
  assert.equal(state(shared.messageId, otherId), "queued");
  assert.equal(state(room.messageId, recipientId), "queued");
});

test("an adapter that emits no stdout cannot commit an offer", async t => {
  const { invoke, receipt } = await fixture(t);
  const silent = { ...adapter, injectOutcome: () => ({ stdout: "", exitCode: 0 }) };
  const result = await invoke("beforeTurn", "recipient-session",
    { adapters: { test: silent } });

  await result.commitOffers();

  assert.equal(result.stdout, "");
  assert.equal((await receipt()).state, "queued");
});

test("the entry point commits only after the stdout callback succeeds", async () => {
  const order = [];
  const stdout = { write(output, callback) {
    order.push(`write:${output}`);
    setImmediate(() => { order.push("callback"); callback(); });
  } };
  const result = { stdout: "payload", commitOffers: async () => {
    assert.deepEqual(order, ["write:payload", "callback"]);
    order.push("commit");
  } };

  await completeHookOutput(result, { stdout, stderr: { write() {} } });

  assert.deepEqual(order, ["write:payload", "callback", "commit"]);
});

test("the entry point cannot claim offered before its real payload crosses", async t => {
  const { invoke, receipt } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session");
  let stateDuringWrite = null;
  const stdout = { write(_output, callback) {
    setImmediate(async () => {
      stateDuringWrite = (await receipt()).state;
      callback();
    });
  } };

  await completeHookOutput(result, { stdout, stderr: { write() {} } });

  assert.equal(stateDuringWrite, "queued",
    "the entry point claimed offered before its stdout callback");
  assert.equal((await receipt()).state, "offered");
});

test("a stdout callback error leaves offers uncommitted and fails open", async () => {
  let commits = 0;
  const diagnostics = [];
  const stdout = { write(_output, callback) {
    setImmediate(() => callback(new Error("pipe rejected")));
  } };
  const stderr = { write(output, callback) { diagnostics.push(output); callback?.(); } };

  const outcome = await completeHookOutput({ stdout: "payload",
    commitOffers: async () => { commits += 1; } }, { stdout, stderr });

  assert.equal(commits, 0);
  assert.equal(outcome.exitCode, 0);
  assert.match(diagnostics.join(""), /stdout write failed/);
});

test("a synchronous stdout throw leaves offers uncommitted and fails open", async () => {
  let commits = 0;
  const diagnostics = [];
  const stdout = { write() { throw new Error("closed stream"); } };
  const stderr = { write(output, callback) { diagnostics.push(output); callback?.(); } };

  const outcome = await completeHookOutput({ stdout: "payload",
    commitOffers: async () => { commits += 1; } }, { stdout, stderr });

  assert.equal(commits, 0);
  assert.equal(outcome.exitCode, 0);
  assert.match(diagnostics.join(""), /stdout write failed/);
});

test("a stdout writer that never calls back times out without committing", async () => {
  let commits = 0;
  const diagnostics = [];
  const stdout = { write() { return true; } };
  const stderr = { write(output, callback) { diagnostics.push(output); callback?.(); } };
  const completion = completeHookOutput({ stdout: "payload", deadlineAt: Date.now() + 25,
    commitOffers: async () => { commits += 1; } }, { stdout, stderr });

  const outcome = await Promise.race([completion,
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 150))]);

  assert.notEqual(outcome, "still waiting", "stdout completion exceeded its hook deadline");
  assert.equal(outcome.exitCode, 0);
  assert.equal(commits, 0);
  assert.match(diagnostics.join(""), /stdout write failed/);
});

test("a contended offer deadline cannot publish after commit rejects", async t => {
  const { invoke, receipt, recipient } = await fixture(t);
  const result = await invoke("beforeTurn", "recipient-session", { budgetMs: 1_500 });
  let releaseWriter;
  let announceWriter;
  const writerHeld = new Promise(resolve => { announceWriter = resolve; });
  const blocker = recipient.service.store.transaction(async () => {
    announceWriter();
    await new Promise(resolve => { releaseWriter = resolve; });
  }, { kinds: [] });
  await writerHeld;

  await assert.rejects(result.commitOffers(), /budget|deadline|store lock/);
  assert.equal((await receipt()).state, "queued");
  releaseWriter();
  await blocker;
  await new Promise(resolve => setTimeout(resolve, 500));

  assert.equal((await receipt()).state, "queued",
    "the rejected offer transaction published after its deadline");
});

test("a commit failure is bounded on stderr and the hook still succeeds", async () => {
  const diagnostics = [];
  const stdout = { write(_output, callback) { callback(); } };
  const stderr = { write(output, callback) { diagnostics.push(output); callback?.(); } };
  const detail = "x".repeat(5_000);

  const outcome = await completeHookOutput({ stdout: "payload", stderr: "existing",
    commitOffers: async () => { throw new Error(detail); } }, { stdout, stderr });

  assert.equal(outcome.exitCode, 0);
  assert.match(diagnostics.join(""), /offer commit failed/);
  assert.equal(Buffer.byteLength(diagnostics.join(""), "utf8") <= 600, true);
});

test("writeOutput waits for the callback rather than the write return value", async () => {
  let completed = false;
  const stream = { write(_output, callback) {
    setImmediate(() => { completed = true; callback(); });
    return true;
  } };

  await writeOutput(stream, "payload");

  assert.equal(completed, true);
});
