import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { PROTOCOL_VERSION } from "@agents-can-communicate/mcp-server";

import { runHook } from "@agents-can-communicate/hook-runner";

import { PROTOCOL_META, connectMcp } from "../helpers/mcp-client.mjs";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

/**
 * The lowest tier ACC supports: a generic MCP client with no hooks at all.
 *
 * It can read the workspace and take part in it, and nothing intercepts what it
 * does. The requirement being certified here is not that it works - it is that
 * the workspace says so out loud, because a peer holding a guarded claim needs
 * to know the claim is advice while this client is connected.
 */
async function workspace(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcponly-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-mcponly-data-")));
  t.after(() => Promise.all([rm(cwd, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  return { cwd, dataHome };
}

const cli = async ({ cwd, dataHome }, args) => {
  const { stdout } = await run(process.execPath, [acc, ...args, "--cwd", cwd, "--json"],
    { env: { ...process.env, ACC_DATA_HOME: dataHome, GIT_DIR: "", GIT_WORK_TREE: "" } });
  return JSON.parse(stdout).data;
};

const meta = PROTOCOL_META(PROTOCOL_VERSION);

test("an MCP-only client can read the workspace and take part in it", async t => {
  const place = await workspace(t);
  const client = connectMcp({ ...place, participant: "mcp_reader" });
  t.after(() => client.close());

  const synced = await client.request("tools/call",
    { name: "acc_sync", arguments: { scope: "full" }, _meta: meta });
  assert.equal(synced.error, undefined, JSON.stringify(synced.error));

  const spoke = await client.request("tools/call",
    { name: "acc_work", arguments: { summary: "reading the claim model", mode: "explore" },
      _meta: meta });
  assert.equal(spoke.error, undefined, JSON.stringify(spoke.error));
});

test("status labels the MCP participant as unguarded and unmanaged", async t => {
  const place = await workspace(t);
  const client = connectMcp({ ...place, participant: "mcp_reader" });
  t.after(() => client.close());
  await client.request("tools/call", { name: "acc_sync", arguments: {}, _meta: meta });

  const status = await cli(place, ["status"]);

  // The whole point of the tier. This client has no hooks: nothing stops its
  // writes and nothing closes its session, and the roster has to say that
  // rather than listing it beside sessions that are genuinely guarded.
  const mcp = status.participants.find(p => p.harness === "mcp");
  assert.notEqual(mcp, undefined, "the MCP client never appeared on the roster");
  assert.equal(mcp.enforcement, "advisory");
  assert.equal(mcp.lifecycle, "manual");
});

test("a guarded workspace degrades to advisory when an MCP client joins", async t => {
  const place = await workspace(t);
  // A participant that genuinely can be stopped, declared the way a real
  // adapter declares it. A CLI participant would not do here: it is advisory by
  // nature, so the workspace would never have been guarded and the change this
  // test is about could not be observed.
  const guarding = { id: "guarding", normalizeHook: payload => payload,
    capabilities: { guards: { beforeWrite: true }, lifecycle: { sessionEnd: true } },
    renderContext: () => "", denyOutcome: reason => ({ stdout: reason }) };
  const attached = await runHook({ adapterId: "guarding", adapters: { guarding },
    dataHome: place.dataHome,
    payload: { kind: "sessionStart", sessionId: "harness-1", cwd: place.cwd,
      model: null, parentSessionId: null, tool: null, targets: [] } });
  await attached.service.acquireClaim({ sessionId: attached.accSessionId,
    generation: attached.generation, resource: "file:src/**", mode: "exclusive",
    enforcement: "guarded", reason: "porting" });

  const before = await cli(place, ["status"]);
  assert.equal(before.protection, "guarded");

  const client = connectMcp({ ...place, participant: "mcp_reader" });
  t.after(() => client.close());
  await client.request("tools/call", { name: "acc_sync", arguments: {}, _meta: meta });
  const after = await cli(place, ["status"]);

  // The claim did not change and is still recorded as guarded. What changed is
  // that someone joined who can write straight through it, so the workspace can
  // no longer honestly report enforcement.
  assert.equal(after.protection, "advisory");
  assert.equal(after.claims.length, 1);
  assert.equal(after.claims[0].enforcement, "guarded",
    "the claim's own declaration was rewritten; only the verdict should change");
});

test("the MCP client sees the peer's claim, so it can choose to respect it", async t => {
  const place = await workspace(t);
  const peer = await cli(place, ["attach", "--participant", "editor", "--harness", "cli"]);
  await cli(place, ["claim", "--session", peer.sessionId, "--generation", peer.generation,
    "--resource", "file:src/**", "--enforcement", "guarded", "--reason", "porting"]);

  const client = connectMcp({ ...place, participant: "mcp_reader" });
  t.after(() => client.close());
  const synced = await client.request("tools/call",
    { name: "acc_sync", arguments: { scope: "full" }, _meta: meta });

  // Unenforceable is not the same as invisible. At this tier coordination is
  // the client's own choice, which it can only make if it can see the claim.
  const text = JSON.stringify(synced.result);
  assert.equal(text.includes("file:src/**"), true,
    "the claim was not visible to the MCP client");
});

/**
 * A poll is this client's turn.
 *
 * The hook runtime hands a session its pending messages when it builds a turn.
 * An MCP client has no turn and no hook, and no tool handed it anything: it saw
 * a `direct_request` line carrying a subject and an id, and to read what a peer
 * had actually said it had to ask for the whole snapshot and search every
 * message in the workspace for its own name. The receipt stayed `queued` for as
 * long as the client ran, so the sender was told its message had not been
 * delivered by an agent that had answered it.
 */
async function mailed(t, { requiresAck = true } = {}) {
  const place = await workspace(t);
  const client = connectMcp({ ...place, participant: "mcp_reader" });
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const out = await client.request("tools/call", { name, arguments: args, _meta: meta });
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    return JSON.parse(out.result.content[0].text);
  };
  await call("acc_work", { summary: "reading", mode: "explore" });

  const sender = await cli(place, ["attach", "--participant", "sender", "--harness", "cli"]);
  await cli(place, ["message", "--session", sender.sessionId,
    "--generation", sender.generation, "--to", "mcp_reader",
    "--subject", "which way should the hull clamp?", "--body", "Blocking me.",
    ...(requiresAck ? ["--requires-ack"] : [])]);
  const receipts = async () => (await cli(place, ["sync", "--session", sender.sessionId,
    "--scope", "full"])).snapshot.receipts.map(receipt => receipt.state);
  return { place, call, sender, receipts };
}

test("a message addressed to an MCP client reaches it, body and all", async t => {
  const { call } = await mailed(t);

  const synced = await call("acc_sync");

  const [message] = synced.messages ?? [];
  assert.notEqual(message, undefined,
    `nothing was handed over: ${JSON.stringify(Object.keys(synced))}`);
  assert.equal(message.subject, "which way should the hull clamp?");
  assert.equal(message.body, "Blocking me.");
});

test("what has been handed over is not handed over again", async t => {
  const { call } = await mailed(t);
  await call("acc_sync");

  const second = await call("acc_sync");

  // A client that polls every few seconds would otherwise be told the same
  // thing until it acknowledged it, and most messages ask for no answer.
  assert.deepEqual(second.messages ?? [], []);
});

test("the sender stops being told its message is undelivered", async t => {
  const { call, receipts } = await mailed(t);
  assert.deepEqual(await receipts(), ["queued"]);

  await call("acc_sync");

  assert.deepEqual(await receipts(), ["injected"]);
});

test("being shown something is still not agreeing to it", async t => {
  const { call, receipts } = await mailed(t);
  const synced = await call("acc_sync");
  const [message] = synced.messages;

  await call("acc_ack", { messageId: message.messageId });

  // Delivery and acknowledgement are different facts, and the sender asked for
  // the second one.
  assert.deepEqual(await receipts(), ["acknowledged"]);
});

test("an MCP client can ask a hooked peer for work and be told it is done", async t => {
  const place = await workspace(t);
  const client = connectMcp({ ...place, participant: "graphics" });
  t.after(() => client.close());
  const call = async (name, args = {}) => {
    const out = await client.request("tools/call", { name, arguments: args, _meta: meta });
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    return JSON.parse(out.result.content[0].text);
  };
  const peer = await cli(place, ["attach", "--participant", "physics", "--harness", "cli"]);

  const asked = await call("acc_request", { toParticipantId: "physics",
    title: "Tank sinks through mud", detail: "Not mine to fix. Can you take it?" });
  await cli(place, ["task", "--session", peer.sessionId, "--generation", peer.generation,
    "--task", asked.task.taskId, "--take"]);
  await cli(place, ["task", "--session", peer.sessionId, "--generation", peer.generation,
    "--task", asked.task.taskId, "--state", "done"]);

  // The whole loop, from the tier with no hooks at all: asked, taken, finished,
  // and the answer arrives where this client can see it.
  const synced = await call("acc_sync");
  const answers = (synced.messages ?? []).map(message => message.subject);
  assert.deepEqual(answers, ["accepted: Tank sinks through mud", "done: Tank sinks through mud"]);
});
