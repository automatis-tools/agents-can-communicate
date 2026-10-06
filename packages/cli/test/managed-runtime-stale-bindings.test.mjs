import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SCHEMA_VERSION } from "@agents-can-communicate/protocol";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { withSessionLifecycle } from "@agents-can-communicate/hook-runner/session-lifecycle";

import { activatePending, sweepStaleBindings } from "../src/managed-runtime/activation.mjs";
import { prepareRefresh } from "../src/managed-runtime/refresh.mjs";
import { writeControl } from "../src/managed-runtime/state.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";

/**
 * A binding that names no client process (#273).
 *
 * Measured on the maintainer's machine on 2026-10-06: 0.10.0 (store contract 7)
 * stayed pending behind 32 such bindings from 0.5.10 to 0.9.0. 26 named sessions
 * that retention had already removed, and 6 named sessions whose recorded
 * process had exited. Closing every client could not clear them.
 */

const NOW = "2026-10-06T12:00:00.000Z";
const WORKSPACE = "workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEAD_PID = 2 ** 22 + 17;
const alive = pid => pid === process.pid;

async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-stale-bindings-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.9.1", root: path.join(root, "generations", "old"), storeVersion: 6 };
  const pending = { version: "0.10.1", root: path.join(root, "generations", "new"), storeVersion: 7 };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null });
  const workspace = path.join(data, "acc", "workspaces", WORKSPACE);
  const store = await openFilesystemStore({ root: workspace, workspaceId: WORKSPACE,
    clock: createFakeClock(NOW), ids: createFakeIds() });
  // Presence is judged against the real clock, so a heartbeat is set relative to it.
  const session = (sessionId, pid, { state = "open", quietMs = 0 } = {}) => store.transaction(tx =>
    tx.put("session", sessionId, { schemaVersion: SCHEMA_VERSION, workspaceId: WORKSPACE, sessionId,
      participantId: `p_${sessionId}`, generation: `generation_${sessionId}`, harness: "claude_code",
      state, parentSessionId: null, checkoutRoot: null, branch: null, pid, enforcement: "advisory",
      lifecycle: "managed", heartbeatCadenceMs: 30_000, startedAt: NOW,
      heartbeatAt: new Date(Date.now() - quietMs).toISOString() }), { kinds: ["session"] });
  // The identity a 0.9.x store carries, as on the machine the defect was found.
  const identity = path.join(workspace, "protocol.json");
  await writeFile(identity, JSON.stringify({ ...JSON.parse(await readFile(identity, "utf8")), storeVersion: 6 }));
  const bindings = path.join(workspace, "bindings");
  await mkdir(bindings, { recursive: true });
  // The shape 0.8.5 wrote when it could not name the client process.
  const bind = (name, sessionId, fields = {}) => writeFile(path.join(bindings, `${name}.json`),
    JSON.stringify({ schemaVersion: 1, harnessSessionId: name, accSessionId: sessionId,
      generation: `generation_${sessionId}`, storeVersion: 6, runtimeRoot: active.root, ...fields }));
  const remaining = async () => (await readdir(bindings)).sort();
  const activate = () => activatePending(root, { pidIsAlive: alive,
    prepare: async () => async () => ({ failed: [] }) });
  return { data, root, session, bind, remaining, activate };
}

test("a binding without a client pid whose session record is gone does not block activation", async t => {
  const f = await fixture(t);
  await f.bind("pruned", "session_pruned");

  const result = await f.activate();

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a binding without a client pid whose session names an exited process does not block activation", async t => {
  const f = await fixture(t);
  await f.session("session_exited", DEAD_PID);
  await f.bind("exited", "session_exited");

  const result = await f.activate();

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a binding without a client pid whose session names no process and has gone quiet does not block", async t => {
  const f = await fixture(t);
  await f.session("session_quiet", null, { quietMs: 2 * 60 * 60_000 });
  await f.bind("quiet", "session_quiet");

  const result = await f.activate();

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a binding without a client pid whose session was closed does not block", async t => {
  const f = await fixture(t);
  await f.session("session_closed", null, { state: "closed" });
  await f.bind("closed", "session_closed");

  const result = await f.activate();

  assert.equal(result.activated, true, JSON.stringify(result));
});

test("a binding without a client pid whose open session names no process and heartbeats still blocks", async t => {
  const f = await fixture(t);
  await f.session("session_unknown", null);
  await f.bind("unknown", "session_unknown");

  const result = await f.activate();

  assert.equal(result.activated, false);
  assert.deepEqual(result.blockers.map(blocker => blocker.reason), ["unknown_client_pid"]);
});

test("a binding without a client pid whose session names a live process still blocks", async t => {
  const f = await fixture(t);
  await f.session("session_live", process.pid);
  await f.bind("live", "session_live");

  const result = await f.activate();

  assert.equal(result.activated, false);
  assert.equal(result.blockers.length, 1);
});

test("the sweep removes only the bindings that no longer name a possible client", async t => {
  const f = await fixture(t);
  await f.session("session_exited", DEAD_PID);
  await f.session("session_quiet", null, { quietMs: 2 * 60 * 60_000 });
  await f.session("session_unknown", null);
  await f.session("session_live", process.pid, { quietMs: 2 * 24 * 60 * 60_000 });
  await f.bind("pruned", "session_pruned");
  await f.bind("exited", "session_exited");
  await f.bind("quiet", "session_quiet");
  await f.bind("unknown", "session_unknown");
  await f.bind("live", "session_live");
  await f.bind("client", "session_pruned", { clientPid: process.pid });

  const removed = await sweepStaleBindings(f.root, { pidIsAlive: alive });

  assert.equal(removed, 3);
  assert.deepEqual(await f.remaining(), ["client.json", "live.json", "unknown.json"]);
});

// A hook renews a binding under its session's lifecycle lock, and the sweep
// judges and removes under the same lock, so a renewal it waited on is what it
// judges (AI review of #274). Removed at once, the binding would show the sweep
// had taken another lock.
test("the sweep waits on the hook's lifecycle lock and keeps a binding the hook renewed", async t => {
  const f = await fixture(t);
  await f.bind("renewed", "session_pruned");
  const workspaceRoot = path.join(f.data, "acc", "workspaces", WORKSPACE);
  let entered, release;
  const holding = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const hook = withSessionLifecycle({ root: workspaceRoot, sessionId: "renewed",
    clock: { now: () => new Date().toISOString() } }, async () => { entered(); await gate; });
  await holding;

  const sweep = sweepStaleBindings(f.root, { pidIsAlive: alive });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await f.remaining(), ["renewed.json"], "the sweep must wait for the hook's lock");
  await f.bind("renewed", "session_pruned", { clientPid: process.pid });
  release();
  await hook;

  assert.equal(await sweep, 0);
  assert.deepEqual(await f.remaining(), ["renewed.json"]);
  assert.equal(JSON.parse(await readFile(path.join(workspaceRoot, "bindings", "renewed.json"), "utf8"))
    .clientPid, process.pid);
});

// An older generation activates its successor with its own blocker rule, which
// counts every binding without a pid as a live client. It loads the pending
// generation's refresh before it lists blockers, so the sweep has to run there.
test("preparing the refresh removes stale bindings before an older activator lists its blockers", async t => {
  const f = await fixture(t);
  await f.bind("pruned", "session_pruned");
  const control = JSON.parse(await readFile(path.join(f.root, "control.json"), "utf8"));
  const home = path.join(f.data, "home");

  await prepareRefresh({ control, root: f.root, callerProtocol: 2,
    env: { HOME: home, ACC_DATA_HOME: f.data, PATH: "/usr/bin:/bin" } });

  assert.deepEqual(await f.remaining(), []);
});
