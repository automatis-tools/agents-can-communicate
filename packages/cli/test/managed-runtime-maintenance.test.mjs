import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { activatePending } from "../src/managed-runtime/activation.mjs";
import { runManagedUpdate } from "../src/managed-runtime/command.mjs";
import { requestMaintenance } from "../src/managed-runtime/maintenance.mjs";
import { runMaintenance } from "../src/managed-runtime/maintenance-worker.mjs";
import { readMaintenance } from "../src/managed-runtime/maintenance-state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { managedUpdateDiagnostic } from "../src/managed-runtime/diagnostics.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-maintenance-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.4.3", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.4", root: path.join(root, "generations", "new") };
  await mkdir(active.root, { recursive: true }); await mkdir(pending.root, { recursive: true });
  const control = { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: data, targets: ["fixture"], notice: null };
  await writeControl(root, control);
  const bindings = path.join(data, "acc", "workspaces", "project", "bindings");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "native.json"), JSON.stringify({ schemaVersion: 1, clientPid: 123456 }));
  const service = { serviceId: "fixture-service", state: "ready", reasonCode: null, pid: 123456,
    processStartTime: "start", codexHome: data, cliPath: "/fixture/client", cliVersion: "2.0.0",
    serverVersion: "1.0.0", managedPath: "/fixture/client", managedVersion: "2.0.0",
    socketPath: path.join(data, "service.sock"), busyThreads: 0, queuedRequests: 0 };
  const calls = [];
  let alive = true, busy = false;
  const adapter = { id: "fixture", displayName: "Fixture Client",
    inspectMaintenance: async () => alive ? { ...service, state: busy ? "busy" : "ready", busyThreads: busy ? 2 : 0 } : null,
    stopForMaintenance: async () => { calls.push("stop"); alive = false; return { ok: true }; },
    startAfterMaintenance: async () => { calls.push("start"); return { ok: true }; } };
  const runtime = { env: {}, packageRoot: pending.root, adapters: [adapter],
    isInteractive: () => true, confirm: async () => { calls.push("confirm"); return true; },
    spawnMaintenance: async () => { calls.push("spawn"); return 987654; } };
  const activate = (root, options) => activatePending(root, { ...options,
    prepare: async () => async () => { calls.push("refresh"); return { failed: [] }; } });
  return { root, control, service, adapter, runtime, calls, activate,
    pidIsAlive: pid => pid === service.pid && alive,
    setBusy: value => { busy = value; } };
}
const approve = f => requestMaintenance({ root: f.root, control: f.control, options: {}, runtime: f.runtime });
const execute = (f, options = {}) => runMaintenance(f.root, { env: {}, adapters: [f.adapter],
  pidIsAlive: f.pidIsAlive, activate: f.activate, pause: async () => {}, ...options });

test("update asks once, records exact approval, and detaches without stopping the caller's service", async t => {
  const f = await fixture(t);
  const result = await approve(f);
  assert.equal(result.data.reason, "maintenance_pending");
  assert.deepEqual(f.calls, ["confirm", "spawn"]);
  const job = await readMaintenance(f.root);
  assert.equal(job.target.version, "0.4.4");
  assert.equal(job.services[0].snapshot.pid, f.service.pid);
  assert.equal(job.status, "waiting");
  await approve(f);
  assert.equal(f.calls.filter(c => c === "confirm").length, 1);
  await execute(f);
  assert.deepEqual(f.calls.filter(c => !["confirm", "spawn"].includes(c)), ["stop", "refresh", "start"]);
  assert.equal((await readControl(f.root)).active.version, "0.4.4");
  assert.equal((await readMaintenance(f.root)).status, "completed");
});

test("decline and noninteractive JSON never restart or persist consent; --yes is explicit consent", async t => {
  for (const mode of ["decline", "json", "noninteractive"]) {
    const f = await fixture(t);
    f.runtime.confirm = async () => { f.calls.push("confirm"); return false; };
    if (mode === "noninteractive") f.runtime.isInteractive = () => false;
    const result = await requestMaintenance({ root: f.root, control: f.control,
      options: mode === "json" ? { json: true } : {}, runtime: f.runtime });
    assert.equal(result.data.reason, mode === "decline" ? "maintenance_declined" : "confirmation_required");
    assert.equal(await readMaintenance(f.root), null);
    assert.deepEqual(f.calls, mode === "decline" ? ["confirm"] : []);
  }
  const f = await fixture(t);
  f.runtime.isInteractive = () => false;
  await requestMaintenance({ root: f.root, control: f.control, options: { yes: true, json: true }, runtime: f.runtime });
  assert.deepEqual(f.calls, ["spawn"]);
});

test("changing a pinned candidate after approval cancels maintenance before any stop", async t => {
  const f = await fixture(t); await approve(f);
  await writeControl(f.root, { ...await readControl(f.root), pin: "0.4.4" });
  await execute(f);
  assert.equal((await readMaintenance(f.root)).status, "cancelled");
  assert.ok(!f.calls.includes("stop"));
  assert.equal((await readControl(f.root)).active.version, "0.4.3");
});

test("busy service is waited for without stopping it", async t => {
  const f = await fixture(t); f.setBusy(true); await approve(f);
  let waited = 0;
  await execute(f, { pause: async () => {
    assert.ok(!f.calls.includes("stop"));
    const diagnostic = await managedUpdateDiagnostic(f.root, await readControl(f.root), "0.4.3");
    assert.equal(diagnostic.maintenance.waiting.busyThreads, 2);
    assert.match(diagnostic.notice, /2 active turns, 0 queued requests/);
    waited++; f.setBusy(false);
  } });
  assert.equal(waited, 1);
  assert.equal((await readMaintenance(f.root)).status, "completed");
});

test("unrelated live ACC processes keep the fence even after daemon consent", async t => {
  const f = await fixture(t); await approve(f);
  await acquireRuntime(f.root, { pid: 234567, kind: "acc-mcp" });
  let unrelatedAlive = true, waited = 0;
  await execute(f, { pidIsAlive: pid => pid === 234567 ? unrelatedAlive : f.pidIsAlive(pid),
    pause: async () => { assert.ok(!f.calls.includes("stop")); unrelatedAlive = false; waited++; } });
  assert.equal(waited, 1);
  assert.equal((await readMaintenance(f.root)).status, "completed");
});

test("a turn racing the final stop check waits again under the same confirmation", async t => {
  const f = await fixture(t); await approve(f);
  const stop = f.adapter.stopForMaintenance;
  let checks = 0;
  f.adapter.stopForMaintenance = async () => ++checks === 1
    ? { ok: false, reasonCode: "service_busy", stopAttempted: false } : stop();
  await execute(f, { pause: async () => {
    assert.equal((await readMaintenance(f.root)).status, "waiting");
    assert.ok(!f.calls.includes("start"));
  } });
  assert.equal(checks, 2);
  assert.equal(f.calls.filter(c => c === "confirm").length, 1);
  assert.equal((await readMaintenance(f.root)).status, "completed");
});

test("expired approval and a failed stop cannot refresh integrations", async t => {
  const f = await fixture(t); await approve(f);
  await execute(f, { now: () => Date.now() + 16 * 60_000 });
  assert.equal((await readMaintenance(f.root)).reasonCode, "idle_wait_expired");
  assert.ok(!f.calls.includes("stop"));
  const g = await fixture(t); await approve(g);
  g.adapter.stopForMaintenance = async () => ({ ok: false, reasonCode: "service_identity_changed" });
  await execute(g);
  assert.ok(!g.calls.includes("refresh"));
  assert.ok(g.calls.includes("start"), "restore is attempted even if the stop result is ambiguous");
  assert.equal((await readControl(g.root)).active.version, "0.4.3");
  assert.equal((await readMaintenance(g.root)).reasonCode, "service_identity_changed");
});

test("integration failure restores the service and keeps the runtime fenced for recovery", async t => {
  const f = await fixture(t); await approve(f);
  await execute(f, { activate: (root, options) => activatePending(root, { ...options,
    prepare: async () => async () => { f.calls.push("refresh"); return { failed: [{ adapterId: "fixture", error: "denied" }] }; } }) });
  assert.deepEqual(f.calls.slice(-3), ["stop", "refresh", "start"]);
  assert.equal((await readControl(f.root)).phase, "activating");
  const job = await readMaintenance(f.root);
  assert.equal(job.status, "failed");
  assert.equal(job.reasonCode, "refresh_failed");
});

test("restart failure is reported instead of claiming complete maintenance", async t => {
  const f = await fixture(t); await approve(f);
  f.adapter.startAfterMaintenance = async () => ({ ok: false, reasonCode: "service_start_failed" });
  await execute(f);
  const job = await readMaintenance(f.root);
  assert.equal(job.status, "recovery");
  assert.equal(job.reasonCode, "service_start_failed");
  f.adapter.startAfterMaintenance = async () => { f.calls.push("start"); return { ok: true }; };
  await execute(f);
  assert.equal(f.calls.filter(c => c === "stop").length, 1, "recovery never repeats an approved stop");
  assert.equal((await readMaintenance(f.root)).status, "completed");
});

test("successful ACC activation still offers maintenance for a stale unbound daemon", async t => {
  const f = await fixture(t);
  const directory = path.join(f.control.pending.root, "node_modules/@agents-can-communicate/cli/src/managed-runtime");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "refresh.mjs"),
    "export async function prepareRefresh() { return async () => ({ failed: [] }); }\n");
  const result = await runManagedUpdate({ options: {}, runtime: { ...f.runtime, managerRoot: f.root,
    env: { ACC_NO_UPDATE_CHECK: "1" } } });
  assert.equal((await readControl(f.root)).active.version, "0.4.4");
  assert.equal(result.data.reason, "maintenance_pending");
  assert.deepEqual(f.calls, ["confirm", "spawn"]);
});
