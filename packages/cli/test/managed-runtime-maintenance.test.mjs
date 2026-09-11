import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NATIVE_PLATFORMS, defineAdapter } from "@agents-can-communicate/adapter-sdk";
import { activatePending } from "../src/managed-runtime/activation.mjs";
import { runManagedUpdate } from "../src/managed-runtime/command.mjs";
import { inspectMaintenanceServices, requestMaintenance } from "../src/managed-runtime/maintenance.mjs";
import { runMaintenance } from "../src/managed-runtime/maintenance-worker.mjs";
import { readMaintenance } from "../src/managed-runtime/maintenance-state.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { managedUpdateDiagnostic } from "../src/managed-runtime/diagnostics.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

async function fixture(t, { storeVersion } = {}) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-maintenance-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const contract = storeVersion === undefined ? {} : { storeVersion };
  const active = { version: "0.4.3", root: path.join(root, "generations", "old"), ...contract };
  const pending = { version: "0.4.4", root: path.join(root, "generations", "new"), ...contract };
  await mkdir(active.root, { recursive: true }); await mkdir(pending.root, { recursive: true });
  // writeControl normalizes the runtime pointers (e.g. attaching storeVersion),
  // so the fixture tracks that normalized shape rather than its raw literal.
  const control = await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: data, targets: ["fixture"], notice: null });
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

// A live ACC lease that declares the same store contract as the generation
// being activated is not a real obstacle: maintenance must restart the
// service without waiting for it, the same way activatePending itself would
// let it through.
test("a live process sharing the pending generation's declared contract does not delay maintenance", async t => {
  const f = await fixture(t, { storeVersion: 6 });
  await approve(f);
  await acquireRuntime(f.root, { pid: 234567, kind: "acc-mcp" });
  await execute(f, { pidIsAlive: pid => pid === 234567 ? true : f.pidIsAlive(pid),
    pause: async () => assert.fail("a matching declared contract must not wait for this process") });
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

// Final review, Finding 4: this branch removed the CLI-versus-service identity
// comparison from the four places that decide delivery and left the fifth -
// the one that decides whether to interrupt the user with a restart offer.
// These cover the replacement rule at `inspectMaintenanceServices`, the only
// place that reads it.
const HOST_PLATFORM = `${process.platform}-${process.arch}`;
const capturedContract = (minimum, knownBad = []) => ({
  minimumByPlatform: { [HOST_PLATFORM]: minimum },
  anchors: [{ platform: HOST_PLATFORM, version: minimum, protocolContract: "fixture/1" }],
  knownBad, activationKinds: ["native-service"], policySource: "installation-record",
});
// A complete, valid declaration that captured one real platform - and not the
// one this process runs on. That is the shape of every shipped adapter on
// every machine but darwin-arm64, and the case that reached CI. Built through
// defineAdapter, which runs the declaration through
// validateNativeDeliveryContract and rejects a partial one, so this fixture
// cannot be mistaken for a malformed contract.
const OTHER_PLATFORM = NATIVE_PLATFORMS.find(name => name !== HOST_PLATFORM);
const answers = async () => ({ ok: true, changes: [], diagnostics: [] });
const elsewhere = () => defineAdapter({
  id: "fixture", displayName: "Fixture Client", client: { command: "fixture-client" },
  capabilities: { delivery: { livePush: true } },
  certification: { evidence: [{ result: "pass", client: "fixture-client", version: "0.150.0",
    platform: OTHER_PLATFORM, capability: "delivery.livePush", observedAt: "2026-09-01",
    fixture: "fixtures/live-push.json", provenance: "fixtures/provenance.json",
    provenanceId: "fixture-capture", idleBehavior: "delivers while idle",
    busyBehavior: "queues while busy", authorityLevel: "observed", limitations: [] }] },
  nativeDelivery: { minimumByPlatform: { [OTHER_PLATFORM]: "0.150.0" },
    anchors: [{ platform: OTHER_PLATFORM, version: "0.150.0", protocolContract: "fixture-native-v1" }],
    knownBad: [], activationKinds: ["native-service"], policySource: "installation-record" },
  detect: answers, install: answers, uninstall: answers, doctor: answers,
  normalizeHook: answers, renderContext: answers, probeNativeDelivery: answers,
  planNativeActivation: answers, bindNativeSession: answers, offerMessage: answers,
});

const inspect = (f, snapshot, nativeDelivery) => inspectMaintenanceServices({ root: f.root,
  control: f.control, env: {},
  adapters: [{ id: "fixture", displayName: "Fixture Client",
    ...(nativeDelivery === undefined ? {} : { nativeDelivery }),
    inspectMaintenance: async () => snapshot }] })
  .then(services => services.map(entry => entry.snapshot.serverVersion));

// A pid no binding record names, so the native-binding half of the condition
// is false in every direction and only the version rule can select a service.
const UNBOUND_PID = 999_999;

test("a daemon serving a version the adapter's captured contract accepts is not a reason to restart it", async t => {
  const f = await fixture(t);
  const contract = capturedContract("0.150.0");
  // Every field but `serverVersion` is shared between the three calls below,
  // including the CLI version they all differ from: what changes the answer is
  // the contract verdict on the serving version, nothing else. The two
  // refused versions are the controls - if the rule had simply been deleted
  // rather than replaced, they would come back empty and this test would fail.
  const daemon = { ...f.service, pid: UNBOUND_PID, cliVersion: "0.154.0" };

  assert.deepEqual(await inspect(f, { ...daemon, serverVersion: "0.149.0" }, contract), ["0.149.0"],
    "control: a serving version below the captured minimum is still offered a restart");
  assert.deepEqual(await inspect(f, { ...daemon, serverVersion: "0.153.0" },
    capturedContract("0.150.0", [{ version: "0.153.0" }])), ["0.153.0"],
  "control: a denylisted serving version is still offered a restart");

  // The complaint the whole branch began from: a Codex CLI that updated while
  // its daemon kept running the previous build. Both above the minimum, both
  // accepted by the contract, and the user is no longer told that finishing
  // the update requires disconnecting every open client.
  assert.deepEqual(await inspect(f, { ...daemon, serverVersion: "0.153.0" }, contract), []);
});

test("a service that satisfies the contract is still offered a restart while it holds a native binding", async t => {
  const f = await fixture(t);
  // The stale-or-unbound case the version rule must never silence. This pid
  // is genuinely alive - it is this test process - so listNativeHolds cannot
  // reap the binding as confirmed dead, and the hold blocks activation because
  // the record declares no store contract.
  const bindings = path.join(path.dirname(f.root), "workspaces", "project", "bindings");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "native.json"),
    JSON.stringify({ schemaVersion: 1, clientPid: process.pid }));
  const daemon = { ...f.service, pid: process.pid, cliVersion: "0.154.0", serverVersion: "0.153.0" };

  assert.deepEqual(await inspect(f, daemon, capturedContract("0.150.0")), ["0.153.0"]);
  // And the same daemon with no binding naming it is not selected, which is
  // what proves the line above came from the binding rather than the version.
  assert.deepEqual(await inspect(f, { ...daemon, pid: UNBOUND_PID },
    capturedContract("0.150.0")), []);
});

// A contract with nothing to say about this platform is not a contract that
// refuses. Read as one, it made every ready daemon a restart candidate on
// every machine that is not darwin-arm64 - including one already serving the
// version its CLI is running, which is the interruption this branch exists to
// remove. With no opinion, the decision falls back to the rule that governed
// before the branch: the served version against the CLI's.
test("a contract with nothing to say falls back to comparing the served version with the CLI's",
  async t => {
    const f = await fixture(t);
    const daemon = { ...f.service, pid: UNBOUND_PID, cliVersion: "0.154.0", serverVersion: "0.153.0" };
    const matched = { ...daemon, serverVersion: daemon.cliVersion };

    // No native-delivery declaration at all.
    assert.deepEqual(await inspect(f, daemon, undefined), ["0.153.0"]);
    assert.deepEqual(await inspect(f, matched, undefined), [],
      "a daemon already serving the CLI's version was offered a restart");

    // A complete, valid declaration that captured one real platform - and not
    // the one this process is running on. Built through defineAdapter, so
    // "valid" is proved here rather than asserted.
    assert.deepEqual(await inspect(f, daemon, elsewhere().nativeDelivery), ["0.153.0"]);
    assert.deepEqual(await inspect(f, matched, elsewhere().nativeDelivery), [],
      "an uncaptured platform made a matching daemon a restart candidate");

    // A daemon that reports no version at all is judged, not excused: the
    // captured contract answers version_unavailable and still offers.
    assert.deepEqual(await inspect(f, { ...daemon, serverVersion: null },
      capturedContract("0.150.0")), [null]);
  });

// The two groups guarded from both directions. Every serving version below is
// the one the CLI is running, so the fallback comparison alone would clear all
// of them; only a capture reading the version refuses. Merging the groups
// either way flips one half of this test.
test("a captured contract refuses the version it judges even when the CLI is running it",
  async t => {
    const f = await fixture(t);
    const daemon = { ...f.service, pid: UNBOUND_PID, cliVersion: "0.149.0", serverVersion: "0.149.0" };

    // Refused by the capture: below its minimum, and on its denylist.
    assert.deepEqual(await inspect(f, daemon, capturedContract("0.150.0")), ["0.149.0"]);
    assert.deepEqual(await inspect(f, daemon,
      capturedContract("0.148.0", [{ version: "0.149.0" }])), ["0.149.0"]);
    // Not a stable version, so the capture cannot accept it either.
    assert.deepEqual(await inspect(f, { ...daemon, cliVersion: "0.151.0-rc.1",
      serverVersion: "0.151.0-rc.1" }, capturedContract("0.150.0")), ["0.151.0-rc.1"]);

    // The control: the same capture, accepting the same matching version.
    assert.deepEqual(await inspect(f, daemon, capturedContract("0.148.0")), []);
  });
