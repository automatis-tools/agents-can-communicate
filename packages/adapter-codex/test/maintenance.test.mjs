import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAdapter } from "../src/adapter.mjs";
import { maintenanceFixture } from "./maintenance-fixture.mjs";
import path from "node:path";

const unixSocketHost = { skip: process.platform === "win32"
  ? "Codex maintenance fixtures require Unix filesystem sockets" : false };

test("Codex update maintenance is exposed separately from native message delivery", () => {
  const adapter = createCodexAdapter();
  for (const method of ["inspectMaintenance", "stopForMaintenance", "startAfterMaintenance"]) {
    assert.equal(typeof adapter[method], "function", `${method} must be available to update recovery`);
  }
});

test("inspection verifies current process and socket identity without collecting thread content", unixSocketHost, async t => {
  const h = await maintenanceFixture(t);
  const result = await h.inspectMaintenance(h.context);
  assert.equal(result?.state, "ready");
  assert.equal(result.serviceId, "codex-app-server");
  assert.equal(result.pid, 45678);
  assert.equal(result.cliVersion, "0.154.0");
  assert.equal(result.serverVersion, "0.153.4");
  assert.equal(result.busyThreads, 0);
  assert.equal(result.queuedRequests, 0);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("private-thread"), false);
  await h.stop();
  assert.equal(await h.inspectMaintenance(h.context), null);
});

test("active turns and pending vendor input postpone maintenance", unixSocketHost, async t => {
  const h = await maintenanceFixture(t);
  h.state.threads[0].status.type = "active";
  let result = await h.inspectMaintenance(h.context);
  assert.equal(result?.state, "busy"); assert.equal(result.busyThreads, 1);
  h.state.threads[0].status.type = "idle";
  h.state.queued.push({ id: "queued-1", input: [{ text: "PRIVATE" }] });
  result = await h.inspectMaintenance(h.context);
  assert.equal(result?.state, "busy"); assert.equal(result.queuedRequests, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("unproven process, socket, binary and platform combinations never become ready", unixSocketHost, async t => {
  const h = await maintenanceFixture(t);
  for (const change of [{ processUnknown: true }, { processCommand: "/wrong/codex app-server --listen unix://" },
    { socketOwned: false }, { managedVersion: "0.153.4" }, { cliVersion: "0.153.4" }, { backend: "launchd" }]) {
    const original = Object.fromEntries(Object.keys(change).map(key => [key, h.state[key]]));
    Object.assign(h.state, change);
    assert.equal((await h.inspectMaintenance(h.context))?.state, "unsupported", JSON.stringify(change));
    Object.assign(h.state, original);
  }
  assert.equal((await h.inspectMaintenance({ ...h.context, platform: "linux-x64" }))?.state, "unsupported");
  assert.deepEqual(h.commands, []);
});

test("stop rechecks exact approved identity and cannot stop a replacement process", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  h.state.pid += 1; await h.writePid();
  const result = await h.stopForMaintenance({ context: h.context, expected });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "service_identity_changed");
  assert.equal(result.stopAttempted, false);
  assert.equal(h.state.running, true);
  assert.deepEqual(h.commands, []);
});

test("a turn starting after approval is protected by the final stop check", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  h.state.threads[0].status.type = "active";
  const result = await h.stopForMaintenance({ context: h.context, expected });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, "service_busy");
  assert.equal(result.stopAttempted, false);
  assert.equal(h.state.running, true);
  assert.deepEqual(h.commands, []);
});

test("supported stop/start verifies death and restores the installed version idempotently", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  const stopped = await h.stopForMaintenance({ context: h.context, expected });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.stopAttempted, true);
  assert.equal(h.state.running, false);
  const started = await h.startAfterMaintenance({ context: h.context, expected });
  assert.equal(started.ok, true);
  assert.equal(started.snapshot.serverVersion, "0.154.0");
  assert.equal((await h.startAfterMaintenance({ context: h.context, expected })).ok, true);
  assert.deepEqual(h.commands, ["stop", "start"]);
});

test("start refuses a different old-version instance or unvalidated executable path", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  h.state.pid += 1; await h.writePid();
  assert.equal((await h.startAfterMaintenance({ context: h.context, expected })).ok, false);
  assert.equal((await h.startAfterMaintenance({ context: h.context,
    expected: { ...expected, cliPath: "/arbitrary/command" } })).ok, false);
  assert.deepEqual(h.commands, []);
});

test("current bin layout admits its captured legacy process alias only after realpath equality", unixSocketHost, async t => {
  const h = await maintenanceFixture(t, { binLayout: true });
  h.state.processCommand = `${path.join(h.codexHome, "packages/standalone/current/codex")} app-server --listen unix://`;
  const expected = await h.inspectMaintenance(h.context);
  assert.equal(expected?.state, "ready");
  assert.equal(expected.managedPath, h.managedPath);
  assert.equal((await h.stopForMaintenance({ context: h.context, expected })).ok, true);
});

test("same PID with a later process birth cannot consume an earlier approval", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  h.state.processStartTime = "Thu Sep 10 04:15:00 2026"; await h.writePid();
  assert.equal((await h.stopForMaintenance({ context: h.context, expected })).reasonCode, "service_identity_changed");
  assert.deepEqual(h.commands, []);
});

test("unknown process death retains maintenance even after the vendor stop reports success", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  h.state.unknownAfterStop = true;
  const stopped = await h.stopForMaintenance({ context: h.context, expected });
  assert.equal(stopped.reasonCode, "daemon_death_unverified");
  assert.equal(stopped.stopAttempted, true);
  assert.equal((await h.startAfterMaintenance({ context: h.context, expected })).ok, false);
  assert.deepEqual(h.commands, ["stop"]);
});

test("malformed thread or queue metadata never certifies an empty workload", unixSocketHost, async t => {
  const h = await maintenanceFixture(t);
  for (const queueResponse of [{}, { data: null }, { data: [null] }, { data: [], nextCursor: "more" }]) {
    h.state.queueResponse = queueResponse;
    assert.equal((await h.inspectMaintenance(h.context))?.state, "unsupported");
  }
  delete h.state.queueResponse;
  h.state.turns = [{ private: "content" }];
  const observed = await h.inspectMaintenance(h.context);
  assert.equal(observed?.state, "unsupported");
  assert.equal(JSON.stringify(observed).includes("content"), false);
});

test("stop command failure preserves the attempted boundary for conservative recovery", unixSocketHost, async t => {
  const h = await maintenanceFixture(t), expected = await h.inspectMaintenance(h.context);
  assert.equal((await h.stopForMaintenance({ context: h.context })).stopAttempted, false);
  for (const failure of ["stopFails", "stopThrows"]) {
    h.state[failure] = true;
    const result = await h.stopForMaintenance({ context: h.context, expected });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "daemon_stop_failed");
    assert.equal(result.stopAttempted, true);
    assert.equal(JSON.stringify(result).includes("private vendor"), false);
    h.state[failure] = false;
  }
  assert.deepEqual(h.commands, ["stop", "stop"]);
});
