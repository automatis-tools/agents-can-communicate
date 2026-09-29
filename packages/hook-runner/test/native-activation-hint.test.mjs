import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
const REFUSED = Object.freeze({ supported: false, clientVersion: "1.0.0",
  protocolContract: "relayed-v1", modes: [], opaqueEndpointRef: null, leaseUntil: null,
  reasonCode: "native_session_unavailable" });

function relayed(nativeActivationHint, { handshake = REFUSED,
  injectOutcome = text => ({ stdout: text, stderr: "", exitCode: 0 }) } = {}) {
  return {
    id: "relayed",
    client: { command: "relayed", certificationName: "relayed", versionArgs: ["--version"] },
    capabilities: { delivery: { nextTurn: true } },
    certification: { evidence: [{ client: "relayed", version: "1.0.0", platform,
      capability: "delivery.nextTurn", result: "pass" }] },
    nativeDelivery: { minimum: "1.0.0",
      anchors: [{ version: "1.0.0", protocolContract: "relayed-v1" }], knownBad: [],
      activationKinds: ["native-config"], policySource: "installation-record" },
    bindNativeSession: async () => handshake,
    nativeActivationHint,
    normalizeHook: payload => payload,
    injectOutcome,
    renderContext: () => "",
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  };
}

// A process table in which this hook runs under a live `relayed` client, so the
// runner resolves a client pid and hands the handshake to the adapter.
const clientTable = async () => new Map([
  [process.pid, { ppid: process.ppid, comm: "node", args: "node acc-hook.mjs relayed" }],
  [process.ppid, { ppid: 1, comm: "relayed", args: "relayed" }]]);

async function turn(t, nativeActivationHint, { policy = "actionable", contextBudgetBytes,
  adapter = {}, readProcessTable = async () => new Map() } = {}) {
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
  const invoke = kind => runHook({ adapterId: "relayed",
    adapters: { relayed: relayed(nativeActivationHint, adapter) },
    payload: { kind, sessionId: "conversation-1", cwd: root, model: null, parentSessionId: null,
      tool: null, targets: [] },
    dataHome, env: { HOME: "/Users/someone" }, readProcessTable,
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

// Measured 2026-09-29 on Codex 0.159.1: a chat started with `--search` runs
// embedded while the daemon runs, and the advice has to name that option.
test("the launch option a refusal names reaches the ask and the recorded attempt", async t => {
  const asked = [];
  await turn(t, async input => { asked.push(input); return ASK; }, { readProcessTable: clientTable,
    adapter: { handshake: { ...REFUSED, reasonCode: "client_session_embedded",
      launchOption: "--search" } } });
  assert.equal(asked[0].nativeBinding.reasonCode, "client_session_embedded");
  assert.equal(asked[0].nativeBinding.launchOption, "--search");
  const dir = path.join(asked[0].runtimeDir, "native-attempts");
  const [file] = await readdir(dir);
  const record = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  assert.equal(record.attempt.launchOption, "--search");
});

test("a refusal without a launch option records none", async t => {
  const asked = [];
  await turn(t, async input => { asked.push(input); return ASK; }, { readProcessTable: clientTable,
    adapter: { handshake: { ...REFUSED, reasonCode: "client_session_embedded" } } });
  assert.equal(asked[0].nativeBinding.reasonCode, "client_session_embedded");
  assert.equal(Object.hasOwn(asked[0].nativeBinding, "launchOption"), false);
});

// Codex shows a hook's `systemMessage` to the user and never to the model,
// measured on 0.147.0, 0.155.1 and 0.159.1.
test("an ask's message for the user reaches the adapter beside the turn's context", async t => {
  const notices = [];
  const result = await turn(t, async () => ({ line: ASK, userMessage: "ACC: shown to the user." }),
    { adapter: { injectOutcome: (text, notice) => { notices.push(notice ?? null);
      return { stdout: text, stderr: "", exitCode: 0 }; } } });
  assert.equal(result.stdout.split("\n").includes(ASK), true);
  assert.deepEqual(notices.at(-1), { userMessage: "ACC: shown to the user." });
});

test("a message for the user that is not one bounded line is dropped, the ask kept", async t => {
  for (const userMessage of ["two\nlines", "x".repeat(600), 7, ""]) {
    const notices = [];
    const result = await turn(t, async () => ({ line: ASK, userMessage }),
      { adapter: { injectOutcome: (text, notice) => { notices.push(notice ?? null);
        return { stdout: text, stderr: "", exitCode: 0 }; } } });
    assert.equal(result.stdout.split("\n").includes(ASK), true, String(userMessage));
    assert.equal(notices.at(-1), null, String(userMessage));
  }
});

test("nothing is asked while the live policy is off", async t => {
  const asked = [];
  const result = await turn(t, async input => { asked.push(input); return ASK; }, { policy: "off" });
  assert.deepEqual(asked, []);
  assert.equal(result.stdout.includes(ASK), false);
});

test("a synchronous throw from the adapter leaves the turn open", async t => {
  const result = await turn(t, () => { throw new Error("unexpected"); });

  assert.equal(result.failed, undefined);
  assert.match(result.stdout, /^ACC CLI \(append\): --session /);
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

test("a synchronous release of a dropped hint leaves the turn open", async t => {
  let released = 0;
  const result = await turn(t, async () => ({
    line: ASK,
    release() { released += 1; },
  }), { contextBudgetBytes: 400 });

  assert.equal(result.failed, undefined);
  assert.match(result.stdout, /^ACC CLI \(append\): --session /);
  assert.equal(result.stdout.includes(ASK), false);
  assert.equal(released, 1);
});

test("a release that throws does not fail the turn", async t => {
  const result = await turn(t, async () => ({
    line: ASK,
    release() { throw new Error("release failed"); },
  }), { contextBudgetBytes: 400 });

  assert.equal(result.failed, undefined);
  assert.match(result.stdout, /^ACC CLI \(append\): --session /);
  assert.equal(result.stdout.includes(ASK), false);
});

test("a stdout write failure accepts a synchronous release", async () => {
  let released = 0;
  const stderr = [];
  const outcome = await completeHookOutput({
    stdout: "payload",
    releaseActivationAsk() { released += 1; },
  }, {
    stdout: { write(_output, callback) { callback(new Error("pipe rejected")); } },
    stderr: { write(output, callback) { stderr.push(output); callback?.(); } },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(released, 1);
  assert.match(stderr.join(""), /stdout write failed/);
});

test("a delivered hint releases synchronously when stdout does not finish", async t => {
  let released = 0;
  const result = await turn(t, async () => ({
    line: ASK,
    release() { released += 1; },
  }));
  assert.equal(released, 0);
  await completeHookOutput(result, {
    stdout: { write(_output, callback) { callback(new Error("pipe rejected")); } },
    stderr: { write(_output, callback) { callback?.(); } },
  });

  assert.equal(released, 1);
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
