import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as native from "../src/native-delivery.mjs";
import { nativeFixture, THREAD } from "./native-fixture.mjs";

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
