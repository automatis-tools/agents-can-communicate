import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile }
  from "node:fs/promises";
import path from "node:path";
import nodeTest from "node:test";

import { detectCodex } from "../src/install.mjs";
import * as native from "../src/native-delivery.mjs";
import { nativeFixture, THREAD } from "./native-fixture.mjs";
import { posixTransportTest as test } from "../../../tests/helpers/platform-scope.mjs";

const message = { messageId: "message_1", kind: "question", subject: "Synthetic",
  body: "diagnostic peer message" };
const bindingOf = handshake => ({ opaqueEndpointRef: handshake.opaqueEndpointRef,
  clientVersion: handshake.clientVersion });

test("sender socket permission failures are distinct from a missing Codex receiver", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  for (const code of ["EPERM", "EACCES"]) {
    const result = await native.offerMessage({ ...h, binding: bindingOf(handshake), message,
      open: () => { throw Object.assign(new Error("private transport detail"), { code }); } });
    assert.equal(result.safeErrorCode, "transport_permission_denied");
    assert.equal(JSON.stringify(result).includes("private transport detail"), false);
  }
});

test("a live queue probe succeeds without rewriting the vendor invocation", async t => {
  const h = await nativeFixture(t);
  const probe = await native.probeNativeDelivery(h);
  assert.equal(probe.supported, true);
  assert.deepEqual(probe.modes, ["livePush", "idleWake", "busyQueue"]);
  assert.equal(probe.clientVersion, "0.152.1");
  h.state.loaded = [];
  assert.equal((await native.probeNativeDelivery(h)).reasonCode, "native_session_unavailable");
  const absent = await native.probeNativeDelivery({ env: { CODEX_HOME: path.join(h.root, "absent") } });
  assert.equal(absent.reasonCode, "native_endpoint_unavailable");
  assert.equal(absent.supported, false);
});

test("binding stores an opaque receiver address after checking the exact loaded thread", async t => {
  const h = await nativeFixture(t);
  h.state.loaded.unshift("other");
  h.state.threads.unshift({ id: "other", cwd: h.cwd, status: { type: "idle" } });
  const handshake = await native.bindNativeSession(h);
  assert.equal(handshake.supported, true);
  assert.notEqual(handshake.opaqueEndpointRef, THREAD);
  const files = await readdir(path.join(h.runtimeDir, "codex-native-endpoints"));
  assert.deepEqual(files, [`${handshake.opaqueEndpointRef}.json`]);
  const endpoint = JSON.parse(await readFile(path.join(h.runtimeDir, "codex-native-endpoints",
    files[0]), "utf8"));
  assert.equal(endpoint.threadId, THREAD);
  assert.equal(endpoint.cwd, h.cwd);
  assert.equal(endpoint.socketPath, h.socketPath);
  assert.ok(Date.parse(handshake.leaseUntil) > Date.now());
});

test("bind persists and returns the daemon's served version, not the caller's stale claim",
  async t => {
    const h = await nativeFixture(t);
    // The hook's claimed clientVersion and the daemon's actually-served
    // version genuinely differ here, both at or above CODEX_QUEUE_MINIMUM,
    // so a bug that quietly persisted the claim instead of what verifyReceiver
    // observed cannot hide behind them coincidentally matching.
    h.state.version = "0.154.0";
    const handshake = await native.bindNativeSession({ ...h, clientVersion: "0.152.5" });
    assert.equal(handshake.supported, true);
    assert.equal(handshake.clientVersion, "0.154.0");
    const file = path.join(h.runtimeDir, "codex-native-endpoints", `${handshake.opaqueEndpointRef}.json`);
    const endpoint = JSON.parse(await readFile(file, "utf8"));
    assert.equal(endpoint.clientVersion, "0.154.0");
  });

test("the endpoint reference alone resolves the receiver; a stored version never gates it",
  async t => {
    const h = await nativeFixture(t);
    const handshake = await native.bindNativeSession(h);
    assert.equal(handshake.supported, true);
    // A binding that names this exact endpoint but records a different
    // version. That is what a binding published by an older generation looks
    // like during an in-place update, when the hook code still running in one
    // session records the detected CLI while this adapter records what the
    // daemon serves. The endpoint id settles identity; the live check settles
    // compatibility. A stored snapshot decides neither, and refusing on it
    // was what turned every send in exactly that case into a durable
    // fallback.
    const stale = { opaqueEndpointRef: handshake.opaqueEndpointRef, clientVersion: "0.154.0" };
    const offer = await native.offerMessage({ ...h, binding: stale, message });
    assert.equal(offer.accepted, true);
    assert.equal(offer.clientVersion, "0.152.1", "the version that answered decides, and is reported");
    assert.equal(h.state.queue.length, 1);
    // Refusal still comes from the live rule: a daemon below the captured
    // minimum is refused no matter what either record remembers.
    h.state.version = "0.151.0";
    const refused = await native.offerMessage({ ...h,
      binding: { ...stale, clientVersion: "0.151.0" },
      message: { ...message, messageId: "message_2" } });
    assert.equal(refused.accepted, false);
    assert.equal(refused.safeErrorCode, "unsupported_client_version");
    assert.equal(h.state.queue.length, 1);
  });

test("sender environment cannot replace the bound receiver socket or thread", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  assert.equal(handshake.supported, true);
  h.opened.length = 0;
  const offer = await native.offerMessage({ ...h, env: { CODEX_HOME: "/wrong/sender" },
    binding: bindingOf(handshake), message });
  assert.equal(offer.accepted, true);
  assert.deepEqual(h.opened, [h.socketPath]);
  assert.equal(h.state.queue.length, 1);
  assert.equal(h.state.queue[0].threadId, THREAD);
  assert.equal(h.state.queue[0].clientUserMessageId, message.messageId);
  assert.match(h.state.queue[0].input[0].text, /untrusted peer content/);
  assert.match(h.state.queue[0].input[0].text, /diagnostic peer message/);
  await native.offerMessage({ ...h, binding: bindingOf(handshake), message });
  assert.equal(h.state.queue.length, 1);
});

test("missing event cwd, wrong identity, PID and a daemon below the minimum never bind", async t => {
  const h = await nativeFixture(t);
  for (const changed of [{ event: { sessionId: THREAD } },
    { event: { sessionId: "absent", cwd: h.cwd } }, { clientPid: null },
    { clientVersion: null }]) {
    const result = await native.bindNativeSession({ ...h, ...changed });
    assert.equal(result.supported, false);
    assert.equal(result.opaqueEndpointRef, null);
  }
  // The daemon itself, not the caller's claimed clientVersion, is what is
  // judged: a serving version below the captured minimum never binds.
  h.state.version = "0.151.0";
  const belowMinimum = await native.bindNativeSession(h);
  assert.equal(belowMinimum.supported, false);
  assert.equal(belowMinimum.opaqueEndpointRef, null);
  assert.equal(h.state.queue.length, 0);
});

test("offer rechecks workspace, loaded state, and version after binding", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  assert.equal(handshake.supported, true);
  const otherCwd = path.join(h.root, "C");
  await mkdir(otherCwd);
  h.state.threads[0].cwd = otherCwd;
  assert.equal((await native.offerMessage({ ...h, binding: bindingOf(handshake), message })).accepted, false);
  h.state.threads[0].cwd = h.cwd;
  h.state.loaded = [];
  assert.equal((await native.offerMessage({ ...h, binding: bindingOf(handshake), message })).accepted, false);
  h.state.loaded = [THREAD];
  assert.equal(h.calls.some(call => call.method === "thread/queue/add"), false);
  // A daemon restarted onto a newer build still satisfies the captured
  // contract, so an in-place upgrade keeps serving the existing binding.
  h.state.version = "0.153.4";
  const upgraded = await native.offerMessage({ ...h, binding: bindingOf(handshake), message });
  assert.equal(upgraded.accepted, true);
  // The response reflects the daemon that actually served it, not the
  // "0.152.1" recorded when this binding was first created.
  assert.equal(upgraded.clientVersion, "0.153.4");
  assert.equal(h.calls.some(call => call.method === "thread/queue/add"), true);
  // A daemon that drops below the captured minimum stops serving it.
  h.state.version = "0.151.0";
  assert.equal((await native.offerMessage({ ...h, binding: bindingOf(handshake), message })).accepted, false);
});

test("an expired observation can be refreshed only after new receiver verification", async t => {
  const h = await nativeFixture(t);
  const handshake = await native.bindNativeSession(h);
  assert.equal(handshake.supported, true);
  const file = path.join(h.runtimeDir, "codex-native-endpoints", `${handshake.opaqueEndpointRef}.json`);
  const endpoint = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...endpoint, leaseUntil: "2020-01-01T00:00:00.000Z" }));
  const renewed = await native.refreshNativeSession({ ...h, binding: bindingOf(handshake) });
  assert.equal(renewed.supported, true);
  assert.equal(renewed.opaqueEndpointRef, handshake.opaqueEndpointRef);
  assert.ok(Date.parse(renewed.leaseUntil) > Date.now());
  h.state.loaded = [];
  assert.equal((await native.refreshNativeSession({ ...h, binding: bindingOf(handshake) })).supported, false);
});

test("missing registrations and failed queue checks cannot leak raw errors or offer", async t => {
  const h = await nativeFixture(t);
  assert.equal((await native.offerMessage({ ...h, binding: { opaqueEndpointRef: "../other" },
    message })).accepted, false);
  const handshake = await native.bindNativeSession(h);
  assert.equal(handshake.supported, true);
  h.state.error = Object.assign(new Error("private path /some/secret"), { code: "ETIMEDOUT" });
  const result = await native.offerMessage({ ...h, binding: bindingOf(handshake), message });
  assert.equal(result.accepted, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(h.state.queue.length, 0);
});


test("replacing the receiver socket with a regular file blocks bind, refresh and offer", async t => {
  const h = await nativeFixture(t);
  const binding = await native.bindNativeSession(h);
  assert.equal(binding.supported, true);
  await rename(h.socketPath, `${h.socketPath}.previous`);
  await writeFile(h.socketPath, "not a socket");
  h.calls.length = 0;
  assert.equal((await native.bindNativeSession(h)).supported, false);
  assert.equal((await native.refreshNativeSession({ ...h, binding })).supported, false);
  assert.equal((await native.offerMessage({ ...h, binding, message: { messageId: "socket-replaced", kind: "note" } })).accepted, false);
  assert.equal(h.calls.length, 0, "wrong socket type must be rejected before RPC");
});

// Codex leaves its control socket behind when the service dies without
// cleaning up: the file is still a socket, but nothing accepts on it.
async function staleControlSocket(t) {
  const root = await realpath(await mkdtemp("/tmp/acc-cx-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = path.join(root, "app-server-control", "app-server-control.sock");
  await mkdir(path.dirname(socketPath), { recursive: true });
  // A graceful close unlinks the file, so only a killed listener leaves it.
  const listener = spawn(process.execPath, ["-e", "require('node:net').createServer()"
    + `.listen(${JSON.stringify(socketPath)}, () => process.stdout.write('up'))`]);
  await once(listener.stdout, "data");
  listener.kill("SIGKILL");
  await once(listener, "exit");
  assert.equal((await lstat(socketPath)).isSocket(), true);
  return { env: { CODEX_HOME: root } };
}

test("a control socket nothing listens on is an unavailable service, not a failed probe",
  { skip: process.platform === "win32" && "Unix domain socket files" }, async t => {
    const probe = await native.probeNativeDelivery(await staleControlSocket(t));
    assert.equal(probe.supported, false);
    assert.equal(probe.reasonCode, "native_endpoint_unavailable");
  });

test("the probe follows the symlink Codex 0.157.1 puts at the control socket path",
  { skip: process.platform === "win32" && "Unix domain socket files" }, async t => {
    const h = await nativeFixture(t);
    const real = path.join(h.root, "codex-daemon-501", "220dda598ee8");
    await mkdir(path.dirname(real), { recursive: true, mode: 0o700 });
    await rename(h.socketPath, real);
    await symlink(real, h.socketPath);
    const probe = await native.probeNativeDelivery(h);
    assert.equal(probe.supported, true, probe.reasonCode);
    assert.equal(h.opened.at(-1), real, "the peer is opened on the socket itself");
  });

test("a probe that times out or fails otherwise keeps its own reason", async t => {
  const h = await nativeFixture(t);
  const silent = { notify() {}, async close() {}, request: () => new Promise(() => {}) };
  assert.equal((await native.probeNativeDelivery({ ...h, timeoutMs: 20, open: () => silent }))
    .reasonCode, "probe_timeout");
  const broken = { notify() {}, async close() {},
    async request() { throw Object.assign(new Error("vendor detail"), { code: "EVENDOR" }); } };
  assert.equal((await native.probeNativeDelivery({ ...h, open: () => broken })).reasonCode,
    "feature_probe_failed");
});

test("a dead service's leftover socket still leads detection to the daemon start advice",
  { skip: process.platform === "win32" && "Unix domain socket files" }, async t => {
    const { env } = await staleControlSocket(t);
    const detected = await detectCodex({ home: env.CODEX_HOME, codexHome: env.CODEX_HOME,
      stateRoot: path.join(env.CODEX_HOME, "state"), clientVersion: "0.155.1",
      platform: "darwin-arm64", nativeDelivery: await native.probeNativeDelivery({ env }) });
    assert.match(detected.nativeSetup ?? "", /codex app-server daemon start/);
  });

// Measured 2026-09-29: a hook for a daemon-hosted thread runs under
// `codex app-server --listen unix:// --managed-daemon`; a TUI that found no
// daemon hosts its own app server and runs the hook itself.
const DAEMON_HOST = ["/opt/codex/bin/codex", "app-server", "--listen", "unix://", "--managed-daemon"];

test("a failed handshake from an interactive TUI names the chat as embedded", async t => {
  const h = await nativeFixture(t);
  h.state.loaded = [];
  for (const argv of [["codex"], ["/opt/codex/bin/codex", "resume", "--last"],
    ["codex", "-c", "model=\"o3\"", "fork"], ["codex", "-m", "gpt", "fix", "the", "bug"],
    ["node", "/opt/codex/bin/codex.js"]]) {
    const result = await native.bindNativeSession({ ...h, argvOf: async () => argv });
    assert.equal(result.supported, false);
    assert.equal(result.reasonCode, "client_session_embedded", argv.join(" "));
  }
  const absent = await native.bindNativeSession({ ...h,
    env: { CODEX_HOME: path.join(h.root, "absent") }, argvOf: async () => ["codex"] });
  assert.equal(absent.reasonCode, "client_session_embedded", "no daemon at all");
});

// Measured on 0.159.1: `codex --search` and `codex -c ...` run embedded while
// the daemon runs. The refusal names the option, so the advice can.
test("an embedded chat's refusal names the launch option that kept it embedded", async t => {
  const h = await nativeFixture(t);
  h.state.loaded = [];
  for (const [argv, option] of [[["codex", "--search"], "--search"],
    [["codex", "-c", "model_reasoning_effort=low"], "-c"],
    [["/opt/codex/bin/codex", "--profile", "work", "resume", "--last"], "--profile"],
    [["codex", "--no-daemon"], "--no-daemon"]]) {
    const result = await native.bindNativeSession({ ...h, argvOf: async () => argv });
    assert.equal(result.reasonCode, "client_session_embedded", argv.join(" "));
    assert.equal(result.launchOption, option, argv.join(" "));
  }
  const plain = await native.bindNativeSession({ ...h, argvOf: async () => ["codex"] });
  assert.equal(plain.reasonCode, "client_session_embedded");
  assert.equal(Object.hasOwn(plain, "launchOption"), false, "no option, no field");
});

test("a failed handshake keeps its reason for a daemon, a non-interactive run or an unreadable host",
  async t => {
    const h = await nativeFixture(t);
    h.state.loaded = [];
    const baseline = (await native.bindNativeSession({ ...h,
      argvOf: async () => DAEMON_HOST })).reasonCode;
    assert.notEqual(baseline, null);
    assert.notEqual(baseline, "client_session_embedded");
    for (const argvOf of [async () => ["codex", "exec", "task"],
      async () => ["node", "/opt/codex/bin/codex.js", "exec", "task"],
      // Only Codex itself is a Codex chat: a test runner or any other process is not.
      async () => ["/usr/local/bin/node", "--test", "--test-concurrency=4", "/repo/a.test.mjs"],
      async () => ["/usr/bin/python3", "codex"], async () => ["codex-helper"], async () => [],
      async () => ["codex", "e", "task"], async () => ["codex", "review"],
      async () => { throw new Error("ps unavailable"); }]) {
      const result = await native.bindNativeSession({ ...h, argvOf });
      assert.equal(result.reasonCode, baseline);
    }
  });

test("a successful handshake never reads the host process", async t => {
  const h = await nativeFixture(t);
  let read = 0;
  const handshake = await native.bindNativeSession({ ...h,
    argvOf: async () => { read += 1; return ["codex"]; } });
  assert.equal(handshake.supported, true);
  assert.equal(read, 0);
});

// Codex's Windows daemon listens on AF_UNIX, which Node cannot reach there; live
// delivery on Windows arrives with the app-server proxy in 0.9.x. Until then a
// Windows install and session say so, and keep next-turn delivery.
nodeTest("windows: live delivery is reported unsupported, never attempted", async () => {
  const { probeNativeDelivery, bindNativeSession } = await import("../src/native-delivery.mjs");
  let opened = false;
  const open = async () => { opened = true; throw new Error("must not connect"); };
  assert.equal((await probeNativeDelivery({ platform: "win32", open })).reasonCode,
    "native_delivery_unsupported");
  const bound = await bindNativeSession({ platform: "win32", open, clientPid: 42,
    clientVersion: "0.159.2", event: { sessionId: "s", cwd: "C:\\work" },
    argvOf: async () => { throw new Error("must not read argv"); } });
  assert.equal(bound.supported, false);
  assert.equal(bound.reasonCode, "native_delivery_unsupported");
  assert.equal(opened, false);
});
