import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createPackedAcc } from "../helpers/packed-acc.mjs";

// Installed runner and real filesystem locks; controlled probes expose ordering.
async function fixture(t) {
  const packed = await createPackedAcc(t);
  const load = (name, file = "index.mjs") => import(pathToFileURL(path.join(packed.installed,
    "node_modules", "@agents-can-communicate", name, "src", file)).href);
  const { runHook } = await load("hook-runner", "runner.mjs");
  const { storeSessionBinding } = await load("adapter-sdk");
  const adapter = { id: "fixture", normalizeHook: payload => payload, capabilities: {},
    client: { command: "fixture" }, injectOutcome: context => ({ stdout: context }) };
  const invoke = (kind, sessionId, extra = {}) => runHook({ adapterId: adapter.id,
    adapters: { [adapter.id]: adapter }, dataHome: packed.dataHome, env: packed.env,
    payload: { kind, sessionId, cwd: packed.project, targets: [] },
    readProcessTable: async () => new Map([[process.pid, { ppid: 1, comm: "fixture" }]]),
    probeClientVersion: async () => "1.0.0", ...extra });
  const prepare = async nativeId => {
    const start = await invoke("sessionStart", nativeId);
    assert.equal(start.failed, undefined, start.reason);
    const owner = { sessionId: start.accSessionId, generation: start.generation };
    await packed.acc(["finish", "--session", owner.sessionId, "--generation", owner.generation,
      "--status", "partial", "--goal", "approval needed"]);
    return { start, owner };
  };
  const snapshot = async () => (await packed.acc(["sync", "--scope", "full"])).snapshot;
  return { packed, adapter, invoke, prepare, snapshot, storeSessionBinding };
}

function pauseProbe() {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  return { reached, release, probeClientVersion: async () => {
    entered(); await blocked; return "1.0.0";
  } };
}

test("concurrent replacement turns retain one fresh owner and native end closes it", async t => {
  const f = await fixture(t);
  const { owner } = await f.prepare("conversation");
  const probe = pauseProbe();
  const first = f.invoke("beforeTurn", "conversation", { probeClientVersion: probe.probeClientVersion });
  await probe.reached;
  let secondProbes = 0;
  const second = f.invoke("beforeTurn", "conversation", {
    probeClientVersion: async () => { secondProbes += 1; return "1.0.0"; } });
  // An unlocked second turn would open another owner while the first is paused.
  try { await Promise.race([second, delay(100)]); } finally { probe.release(); }
  const turns = await Promise.all([first, second]);
  for (const result of turns) assert.equal(result.failed, undefined, result.reason);
  assert.equal(secondProbes, 0);
  const binding = await f.packed.findBinding("conversation");
  assert.notEqual(binding.accSessionId, owner.sessionId);
  assert.equal(binding.clientPid, process.pid);
  for (const result of turns) assert.ok(result.stdout.includes(`--session ${binding.accSessionId}`));
  const sessions = (await f.snapshot()).sessions;
  assert.equal(sessions.length, 2);
  assert.equal(sessions.filter(s => s.state === "open").length, 1);
  await f.invoke("sessionEnd", "conversation");
  assert.equal(await f.packed.findBinding("conversation"), null);
  assert.equal((await f.snapshot()).sessions.filter(s => s.state === "open").length, 0);
});

test("a native end waits for the replacement turn to publish its owner", async t => {
  const f = await fixture(t);
  await f.prepare("ending");
  const probe = pauseProbe();
  const turn = f.invoke("beforeTurn", "ending", { probeClientVersion: probe.probeClientVersion });
  await probe.reached;
  const end = f.invoke("sessionEnd", "ending");
  try { await Promise.race([end, delay(100)]); } finally { probe.release(); }
  for (const result of await Promise.all([turn, end])) {
    assert.equal(result.failed, undefined, result.reason);
  }
  assert.equal(await f.packed.findBinding("ending"), null);
  assert.equal((await f.snapshot()).sessions.filter(s => s.state === "open").length, 0);
});

test("turns with missing or stale bindings and heartbeats cannot allocate owners", async t => {
  const f = await fixture(t);
  const { start, owner } = await f.prepare("closed");
  const runtimeDir = start.service.store.root;
  for (const state of ["heartbeat", "absent", "missing", "closed-mismatch", "open-mismatch"]) {
    if (state !== "absent") await f.storeSessionBinding({ runtimeDir, harnessSessionId: state,
      accSessionId: state === "missing" ? "session_not_created" : owner.sessionId,
      generation: state === "heartbeat" ? owner.generation : "generation_stale" });
    // A separate caller gets a fresh operation budget, not the old hook's deadline.
    if (state === "open-mismatch") await f.packed.acc(["attach", "--session", owner.sessionId,
      "--participant", "replacement", "--harness", "fixture", "--cadence", "60000"]);
    const before = await f.snapshot();
    let probes = 0;
    const result = await f.invoke(state === "heartbeat" ? "heartbeat" : "beforeTurn", state,
      { probeClientVersion: async () => { probes += 1; return "1.0.0"; } });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(probes, 0);
    assert.deepEqual((await f.snapshot()).sessions, before.sessions);
  }
});

test("a replacement turn retains its client PID and performs one native handshake", async t => {
  const f = await fixture(t);
  const platform = `${process.platform}-${process.arch}`;
  const calls = [];
  Object.assign(f.adapter, {
    capabilities: { delivery: { livePush: true } },
    certification: { evidence: [{ client: "fixture", version: "1.0.0", platform,
      capability: "delivery.livePush", result: "pass" }] },
    nativeDelivery: { minimumByPlatform: { [platform]: "1.0.0" },
      anchors: [{ platform, version: "1.0.0", protocolContract: "fixture-v1" }],
      knownBad: [], activationKinds: ["shell-bootstrap"] },
    bindNativeSession: async input => {
      calls.push(input);
      return { supported: true, clientVersion: "1.0.0", protocolContract: "fixture-v1",
        modes: ["livePush"], opaqueEndpointRef: "fixture-endpoint",
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), reasonCode: null };
    },
  });
  await f.prepare("native-delivery");
  const result = await f.invoke("beforeTurn", "native-delivery", {
    env: { ...f.packed.env, ACC_NATIVE_DELIVERY_POLICY: "actionable" }, platform });
  assert.equal(result.failed, undefined, result.reason);
  assert.equal(result.nativeBinding.state, "active");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientPid, process.pid);
  const binding = await f.packed.findBinding("native-delivery");
  assert.equal(binding.clientPid, process.pid);
  const { record } = await result.service.locateSession(binding.accSessionId);
  const deliveries = await result.service.listDeliveryBindings({
    participantId: record.participantId, now: new Date().toISOString() });
  assert.equal(deliveries.some(b => b.sessionId === binding.accSessionId && b.retiredAt === null), true);
});

test("a CLI replacement during a paused turn probe is not adopted or reopened", async t => {
  const f = await fixture(t);
  const { owner } = await f.prepare("replaced");
  const probe = pauseProbe();
  const turn = f.invoke("beforeTurn", "replaced", { probeClientVersion: probe.probeClientVersion });
  await probe.reached;
  try {
    await f.packed.acc(["attach", "--session", owner.sessionId,
      "--participant", "external", "--harness", "fixture", "--cadence", "60000"]);
  } finally { probe.release(); }
  const result = await turn;
  assert.equal(result.exitCode, 0);
  assert.equal(result.failed, true);
  assert.equal(result.stdout, "");
  assert.equal((await f.snapshot()).sessions.length, 1);
  assert.equal((await f.packed.findBinding("replaced")).generation, owner.generation);
});

test("a turn whose lifecycle wait expires cannot register later", async t => {
  const f = await fixture(t);
  await f.prepare("deadline");
  const probe = pauseProbe();
  const first = f.invoke("beforeTurn", "deadline", { probeClientVersion: probe.probeClientVersion });
  await probe.reached;
  let probes = 0, expired;
  try {
    expired = await f.invoke("beforeTurn", "deadline", { budgetMs: 30,
      probeClientVersion: async () => { probes += 1; return "1.0.0"; } });
  } finally { probe.release(); }
  assert.equal(expired.exitCode, 0);
  assert.equal(expired.failed === true || expired.timedOut === true, true);
  assert.equal((await first).failed, undefined);
  await f.invoke("beforeTurn", "deadline");
  assert.equal(probes, 0);
  assert.equal((await f.snapshot()).sessions.length, 2);
});
