import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recordInstall } from "@agents-can-communicate/installer";

import { participantFor, registerDiscoveredSessions, registerNativeSession, runHook }
  from "../src/runner.mjs";

const platform = `${process.platform}-${process.arch}`;
// A live process, so presence reads the session as alive: the test's own.
const DAEMON = process.pid;

// A client whose hooks run under a long-lived service, as Codex's run under its
// app-server daemon: the process table leads from the hook to that service.
function daemonHosted(binds) {
  return {
    id: "hosted",
    client: { command: "hosted", certificationName: "hosted", versionArgs: ["--version"] },
    capabilities: { lifecycle: { sessionStart: true, sessionEnd: true }, delivery: { nextTurn: true } },
    certification: { evidence: [{ client: "hosted", version: "1.0.0", platform,
      capability: "delivery.nextTurn", result: "pass" }] },
    nativeDelivery: { minimum: "1.0.0",
      anchors: [{ version: "1.0.0", protocolContract: "hosted-v1" }], knownBad: [],
      activationKinds: ["native-service"], policySource: "installation-record" },
    bindNativeSession: async input => { binds.push(input); return { supported: false,
      clientVersion: "1.0.0", protocolContract: "hosted-v1", modes: [], opaqueEndpointRef: null,
      leaseUntil: null, reasonCode: "native_session_unavailable" }; },
    normalizeHook: payload => payload,
    injectOutcome: text => ({ stdout: text, stderr: "", exitCode: 0 }),
    renderContext: () => "",
    renderContextResult: () => ({ text: "", offeredMessageIds: [], includedAttentionIds: [] }),
  };
}

async function setup(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-register-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-register-data-")));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  await recordInstall({ dataHome, adapterId: "hosted", version: "1.0.0", artifacts: [],
    deliveryPolicy: "actionable" });
  const binds = [];
  const adapters = { hosted: daemonHosted(binds) };
  const register = (overrides = {}) => registerNativeSession({ adapterId: "hosted", adapters,
    event: { sessionId: "thread-1", cwd: root }, clientPid: DAEMON, dataHome,
    env: { HOME: "/Users/someone" }, probeClientVersion: async () => "1.0.0", platform,
    ...overrides });
  // The chat's first real hook, run by its daemon.
  const hook = kind => runHook({ adapterId: "hosted", adapters,
    payload: { kind, sessionId: "thread-1", cwd: root, model: null, parentSessionId: null,
      tool: null, targets: [] },
    dataHome, env: { HOME: "/Users/someone" },
    readProcessTable: async () => new Map([[DAEMON, { comm: "hosted", ppid: 1 }]]),
    probeClientVersion: async () => "1.0.0", platform });
  return { root, dataHome, binds, register, hook };
}

test("a chat is registered with the participant and process its own hook would record", async t => {
  const h = await setup(t);
  const registered = await h.register();
  assert.equal(registered.registered, true);
  assert.equal(registered.participantId, participantFor("hosted", "thread-1"));
  assert.equal(h.binds.length, 1, "the native binding is attempted as at SessionStart");
  assert.equal(h.binds[0].clientPid, DAEMON);
  assert.equal(h.binds[0].event.sessionId, "thread-1");
  const pins = await readdir(path.join(h.dataHome, "acc", "runtime", "pins")).catch(() => []);
  assert.deepEqual(pins, [], "no pin: the first real hook writes its own");
});

test("the chat's first real hook adopts the registered session", async t => {
  const h = await setup(t);
  const registered = await h.register();
  const started = await h.hook("sessionStart");
  assert.equal(started.failed, undefined, started.reason);
  const mine = started.sessions.filter(item => item.participantId === registered.participantId);
  assert.deepEqual(mine.map(item => item.sessionId), [registered.sessionId]);
});

test("a chat that already has a session is left alone", async t => {
  const h = await setup(t);
  await h.hook("sessionStart");
  assert.equal((await h.register()).registered, false);
  const first = await setup(t);
  const once = await first.register();
  const again = await first.register();
  assert.equal(again.registered, false);
  assert.equal(first.binds.length, 1);
  assert.ok(once.sessionId);
});

test("the caller's own participant name never names the chat", async t => {
  const h = await setup(t);
  const registered = await h.register({ env: { HOME: "/Users/someone", ACC_PARTICIPANT: "reviewer" } });
  assert.equal(registered.participantId, participantFor("hosted", "thread-1"));
});

test("a chat in another workspace is not registered", async t => {
  const h = await setup(t);
  const result = await h.register({ workspaceId: "workspace_somewhere_else" });
  assert.equal(result.registered, false);
  assert.equal(h.binds.length, 0);
});

test("discovery registers what an installed adapter found in this workspace", async t => {
  const h = await setup(t);
  // The workspace this root resolves to, learned from a registration there.
  const { workspaceId } = await h.register({ event: { sessionId: "thread-0", cwd: h.root } });
  const found = [{ sessionId: "thread-1", cwd: h.root, clientPid: DAEMON }];
  const adapter = { ...daemonHosted(h.binds), discoverNativeSessions: async () => found };
  const discover = id => registerDiscoveredSessions({ adapters: { hosted: adapter },
    workspaceId: id, dataHome: h.dataHome, env: { HOME: "/Users/someone" },
    probeClientVersion: async () => "1.0.0", platform });
  assert.deepEqual(await discover("workspace_somewhere_else"), [],
    "another workspace's chats are not this caller's to register");
  const result = await discover(workspaceId);
  assert.deepEqual(result.map(item => item.participantId), [participantFor("hosted", "thread-1")]);
  assert.deepEqual(await discover(workspaceId), [], "a registered chat is not registered twice");
});

test("discovery asks no adapter that is not installed and survives one that fails", async t => {
  const h = await setup(t);
  let asked = 0;
  const found = async () => { asked += 1; return [{ sessionId: "thread-1", cwd: h.root, clientPid: DAEMON }]; };
  const notInstalled = { ...daemonHosted(h.binds), id: "absent", discoverNativeSessions: found };
  const failing = { ...daemonHosted(h.binds), discoverNativeSessions: async () => { throw new Error("x"); } };
  assert.deepEqual(await registerDiscoveredSessions({ adapters: { absent: notInstalled },
    dataHome: h.dataHome, env: {} }), []);
  assert.equal(asked, 0);
  assert.deepEqual(await registerDiscoveredSessions({ adapters: { hosted: failing },
    dataHome: h.dataHome, env: {} }), []);
});
