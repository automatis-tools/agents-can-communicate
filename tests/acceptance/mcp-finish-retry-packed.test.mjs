import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { connectMcp, PROTOCOL_META } from "../helpers/mcp-client.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { PROTOCOL_VERSION } from "../../packages/mcp-server/src/server.mjs";

test("installed MCP finish retries preserve the closed owner across process restarts", async t => {
  const packed = await createPackedAcc(t);
  const connect = () => {
    const client = connectMcp({ cwd: packed.project, dataHome: packed.dataHome,
      binary: packed.mcpBin, env: { GIT_DIR: "", GIT_WORK_TREE: "" } });
    t.after(() => client.close());
    return { close: client.close, call: (name, args = {}) => client.request("tools/call",
      { name, arguments: args, _meta: PROTOCOL_META(PROTOCOL_VERSION) }) };
  };
  const value = response => {
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true, response.result.content[0].text);
    return response.result.structuredContent;
  };
  const inspect = () => packed.acc(["sync", "--scope", "full"]);
  const args = { goal: "Completed review", status: "complete",
    clientMessageId: "client_mcp_closed_retry" };
  const first = connect();
  const finished = value(await first.call("acc_finish", args));
  const before = await inspect();
  assert.equal(before.snapshot.sessions.length, 1);
  assert.equal(before.snapshot.sessions[0].state, "closed");
  assert.deepEqual(value(await first.call("acc_finish", args)), finished);
  assert.deepEqual(await inspect(), before, "retry must not heartbeat or reopen its owner");
  await first.close();

  const restarted = connect();
  assert.deepEqual(value(await restarted.call("acc_finish", args)), finished);
  assert.deepEqual(await inspect(), before);
  const conflict = await restarted.call("acc_finish", { ...args, goal: "Different result" });
  assert.equal(conflict.result.isError, true);
  assert.deepEqual(await inspect(), before, "conflicting replay must not change durable facts");

  value(await restarted.call("acc_work", { summary: "New work", mode: "review" }));
  const reopened = await inspect();
  const successor = reopened.snapshot.sessions.find(session => session.state === "open");
  assert.ok(successor, "ordinary work must open a new owner after finish");
  assert.notEqual(successor.sessionId, finished.message.fromSessionId);
  const stale = await restarted.call("acc_finish", args);
  assert.equal(stale.result.isError, true, "a new owner cannot replay its predecessor's finish");
  assert.deepEqual((await inspect()).snapshot.messages, before.snapshot.messages);
  await restarted.close();

  // A persisted binding can be stale independently of the stdio process.
  // Point it back at the closed session with a deliberately wrong generation.
  const entries = await readdir(packed.dataHome, { recursive: true, withFileTypes: true });
  const bindingFile = entries.filter(entry => entry.isFile()
    && path.basename(entry.parentPath ?? entry.path) === "bindings")
    .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
  assert.equal(bindingFile.length, 1);
  const binding = JSON.parse(await readFile(bindingFile[0], "utf8"));
  await writeFile(bindingFile[0], JSON.stringify({ ...binding,
    accSessionId: finished.message.fromSessionId, generation: "generation_wrong" }));
  const staleBinding = connect();
  const refused = await staleBinding.call("acc_finish", args);
  assert.equal(refused.result.isError, true, "closed lookup must not lend out its generation");
  const after = await inspect();
  assert.deepEqual(after.snapshot.messages, before.snapshot.messages);
  assert.deepEqual(after.snapshot.sessions.find(session =>
    session.sessionId === finished.message.fromSessionId), before.snapshot.sessions[0]);
});

test("installed MCP finish can retry when its bound owner closes during resolution", async t => {
  const packed = await createPackedAcc(t);
  const load = (name, file = "index.mjs") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", file)).href);
  const { createCoordinationService } = await load("core");
  const { openFilesystemStore } = await load("storage-filesystem");
  const { createId } = await load("protocol");
  const { storeSessionBinding } = await load("adapter-sdk");
  const { serve } = await load("mcp-server", "server.mjs");
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: kind => createId(kind) };
  const workspaceId = "workspace_finish_race", participantId = "finisher";
  const store = await openFilesystemStore({ root: packed.dataHome, workspaceId, clock, ids });
  const service = createCoordinationService({ store, clock, ids });
  const owner = await service.openSession({ workspaceId, participantId,
    harness: "mcp", heartbeatCadenceMs: 60_000 });
  await storeSessionBinding({ runtimeDir: packed.dataHome,
    harnessSessionId: `mcp:${participantId}:${workspaceId}`,
    accSessionId: owner.sessionId, generation: owner.generation });
  const args = { goal: "Concurrent finish", clientMessageId: "client_concurrent_finish" };
  const inspect = async () => ({ snapshot: await store.snapshot(workspaceId),
    events: await store.eventsSince(workspaceId, null, 100) });
  let checkpoint, original;
  const racing = { ...service, locateSession: async (...input) => {
    const current = await service.locateSession(...input);
    // Commit the real competing finish after lookup, before the resolver could
    // heartbeat. The returned record is stale; core must still accept the retry.
    original = await service.finishSession({ ...args, sessionId: owner.sessionId,
      generation: owner.generation, workspaceId });
    checkpoint = await inspect();
    return current;
  } };
  let output = "";
  await serve({ input: Readable.from([JSON.stringify({ jsonrpc: "2.0", id: 1,
    method: "tools/call", params: { name: "acc_finish", arguments: args,
      _meta: PROTOCOL_META(PROTOCOL_VERSION) } }) + "\n"]),
    output: { write: value => { output += value; } },
    context: { service: racing, workspaceId, participantId, runtimeDir: packed.dataHome } });
  assert.ok(original, "the competing finish never ran");
  const response = JSON.parse(output);
  assert.notEqual(response.result.isError, true, response.result.content[0].text);
  assert.equal(response.result.structuredContent.message.messageId, original.message.messageId);
  assert.deepEqual(await inspect(), checkpoint, "retry must not create another owner or event");
});
