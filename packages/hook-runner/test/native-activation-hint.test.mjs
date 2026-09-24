import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recordInstall } from "@agents-can-communicate/installer";

import { completeHookOutput } from "../../../bin/acc-hook.mjs";
import { runHook } from "../src/runner.mjs";

const platform = `${process.platform}-${process.arch}`;
const ASK = "ACC: live delivery is not running here; run the relay once.";

// A client whose native endpoint the agent must start itself. Its handshake
// finds nothing, so every turn's binding is degraded and the ask is due.
function relayed(nativeActivationHint) {
  return {
    id: "relayed",
    client: { command: "relayed", certificationName: "relayed", versionArgs: ["--version"] },
    capabilities: { delivery: { nextTurn: true } },
    certification: { evidence: [{ client: "relayed", version: "1.0.0", platform,
      capability: "delivery.nextTurn", result: "pass" }] },
    nativeDelivery: { minimumByPlatform: { [platform]: "1.0.0" },
      anchors: [{ platform, version: "1.0.0", protocolContract: "relayed-v1" }], knownBad: [],
      activationKinds: ["native-config"], policySource: "installation-record" },
    bindNativeSession: async () => ({ supported: false, clientVersion: "1.0.0",
      protocolContract: "relayed-v1", modes: [], opaqueEndpointRef: null, leaseUntil: null,
      reasonCode: "native_session_unavailable" }),
    nativeActivationHint,
    normalizeHook: payload => payload,
    injectOutcome: text => ({ stdout: text, stderr: "", exitCode: 0 }),
    renderContext: () => "",
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  };
}

async function turn(t, nativeActivationHint, { policy = "actionable", contextBudgetBytes } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hint-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-hint-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  if (contextBudgetBytes !== undefined) {
    await writeFile(path.join(root, "acc.workspace.json"), `${JSON.stringify({
      schemaVersion: 1, workspaceId: "workspace_hint_budget", displayName: "hint budget",
      policy: { claimMode: "advisory", contextBudgetBytes },
    })}\n`);
  }
  await recordInstall({ dataHome, adapterId: "relayed", version: "1.0.0", artifacts: [],
    deliveryPolicy: policy });
  const invoke = kind => runHook({ adapterId: "relayed", adapters: { relayed: relayed(nativeActivationHint) },
    payload: { kind, sessionId: "conversation-1", cwd: root, model: null, parentSessionId: null,
      tool: null, targets: [] },
    dataHome, env: { HOME: "/Users/someone" }, readProcessTable: async () => new Map(),
    probeClientVersion: async () => "1.0.0", platform });
  await invoke("sessionStart");
  return invoke("beforeTurn");
}

test("a degraded binding carries the adapter's ask into the turn, beside the owner line", async t => {
  const asked = [];
  const result = await turn(t, async input => { asked.push(input); return ASK; });

  assert.match(result.stdout, /^ACC CLI \(append\): --session /);
  assert.equal(result.stdout.split("\n").includes(ASK), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].event.sessionId, "conversation-1");
  assert.equal(asked[0].nativeBinding.state, "degraded");
  assert.equal(asked[0].env.HOME, "/Users/someone");
  assert.equal(typeof asked[0].runtimeDir, "string");
});

test("nothing is asked while the live policy is off", async t => {
  const asked = [];
  const result = await turn(t, async input => { asked.push(input); return ASK; }, { policy: "off" });
  assert.deepEqual(asked, []);
  assert.equal(result.stdout.includes(ASK), false);
});

test("anything but one bounded line is dropped, and a failing adapter costs the turn nothing", async t => {
  for (const hint of [async () => null, async () => "one\ntwo", async () => "x".repeat(513),
    async () => { throw new Error("adapter failed"); }, () => new Promise(() => {})]) {
    const result = await turn(t, hint);
    assert.match(result.stdout, /^ACC CLI \(append\): --session /);
    assert.equal(result.stdout.trim().split("\n").length, 1, "only the owner line");
  }
});

function reserved(line) {
  let released = 0;
  return { line, release: async () => { released += 1; },
    get released() { return released; } };
}

test("a hint that cannot fit the context budget is released and not shown", async t => {
  const hint = reserved(ASK);
  const result = await turn(t, async () => hint, { contextBudgetBytes: 400 });

  assert.equal(result.stdout.includes(ASK), false);
  assert.equal(hint.released, 1);
});

test("a hint that reaches the turn keeps its reservation", async t => {
  const hint = reserved(ASK);
  const result = await turn(t, async () => hint);

  assert.equal(result.stdout.split("\n").includes(ASK), true);
  assert.equal(hint.released, 0);
});

test("a line the runner refuses releases the reservation", async t => {
  const hint = reserved("one\ntwo");
  const result = await turn(t, async () => hint);

  assert.equal(result.stdout.includes("one"), false);
  assert.equal(hint.released, 1);
});

test("a hint that misses the runner's budget releases the reservation", async t => {
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const result = await turn(t, () => new Promise(resolve => {
    setTimeout(() => resolve({ line: ASK, release: async () => release() }), 1_000);
  }));

  assert.equal(result.stdout.includes(ASK), false);
  await Promise.race([released, new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("release was not called")), 2_000);
  })]);
});

test("a stdout write that completes keeps the ask", async t => {
  const hint = reserved(ASK);
  const result = await turn(t, async () => hint);
  await completeHookOutput(result, {
    stdout: { write(_output, callback) { callback(); } },
    stderr: { write(_output, callback) { callback?.(); } },
  });

  assert.equal(hint.released, 0);
});

test("a stdout write that fails releases the ask the turn was holding", async t => {
  const hint = reserved(ASK);
  const result = await turn(t, async () => hint);
  assert.equal(hint.released, 0);
  const stderr = [];
  await completeHookOutput(result, {
    stdout: { write(_output, callback) { callback(new Error("pipe rejected")); } },
    stderr: { write(output, callback) { stderr.push(output); callback?.(); } },
  });

  assert.equal(hint.released, 1);
  assert.match(stderr.join(""), /stdout write failed/);
});
