import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createAccChannel, endpointDir } from "@agents-can-communicate/adapter-claude-code/channel";
import { clearSessionBinding, storeSessionBinding } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { withSessionLifecycle } from "@agents-can-communicate/hook-runner/session-lifecycle";
import { recordInstall } from "@agents-can-communicate/installer";
import { openFilesystemStore } from "@agents-can-communicate/storage-filesystem";

import { activateClaudeChannel } from "../../bin/entrypoints/claude-channel-binding.mjs";
import { createFakeIds } from "../helpers/memory-store.mjs";

async function fixture(t, { installedPolicy = "actionable", policy = "actionable",
  clientVersion = "2.1.270", platform = "darwin-arm64", failAt } = {}) {
  const root = await realpath(await mkdtemp("/tmp/acc-cold-"));
  const runtimeDir = path.join(root, "workspace");
  const dataHome = path.join(root, "data");
  const clock = { now: () => new Date().toISOString() };
  const ids = createFakeIds();
  const store = await openFilesystemStore({ root: runtimeDir, clock, ids,
    workspaceId: "workspace_cold", failAt });
  const service = createCoordinationService({ store, clock, ids });
  const opened = await service.openSession({ workspaceId: "workspace_cold",
    participantId: "claude", harness: "claude_code", heartbeatCadenceMs: 30_000 });
  const session = { sessionId: opened.sessionId, generation: opened.generation,
    clientPid: process.pid, harnessSessionId: "cold-claude" };
  const binding = { runtimeDir, harnessSessionId: session.harnessSessionId,
    accSessionId: session.sessionId, generation: session.generation,
    clientPid: session.clientPid, clientVersion, platform };
  await storeSessionBinding(binding);
  await recordInstall({ dataHome, adapterId: "claude_code", version: "2.1.270",
    artifacts: [], deliveryPolicy: installedPolicy });
  const channel = createAccChannel({ endpointDir: endpointDir(runtimeDir), socketDir: root,
    clientPid: session.clientPid, write: () => {} });
  await channel.listen();
  t.after(async () => { channel.close(); await rm(root, { recursive: true, force: true }); });
  const activate = () => activateClaudeChannel({ session, service, runtimeDir, dataHome,
    env: { ACC_NATIVE_DELIVERY_POLICY: policy } });
  const bindings = () => service.listDeliveryBindings({ participantId: "claude", now: clock.now() });
  return { session, binding, service, runtimeDir, clock, activate, bindings };
}

for (const [name, options] of [
  ["bootstrap off", { policy: "off" }],
  ["invalid bootstrap policy", { policy: "yes" }],
  ["installation consent withdrawn", { installedPolicy: "off" }],
  ["unverified client version", { clientVersion: "unknown" }],
  ["uncaptured platform", { platform: "unknown-platform" }],
]) {
  test(`Channel startup does not enable delivery with ${name}`, async t => {
    const f = await fixture(t, options);
    await f.activate();
    assert.deepEqual(await f.bindings(), []);
  });
}

test("a delayed Channel does not adopt a replacement owner or another process", async t => {
  const f = await fixture(t);
  const replacement = await f.service.openSession({ workspaceId: "workspace_cold",
    participantId: "successor", harness: "claude_code", heartbeatCadenceMs: 30_000 });
  await storeSessionBinding({ ...f.binding, accSessionId: replacement.sessionId,
    generation: replacement.generation });
  await f.activate();
  assert.deepEqual(await f.service.listDeliveryBindings({ participantId: "successor", now: f.clock.now() }), []);
  await storeSessionBinding({ ...f.binding, clientPid: process.pid + 1 });
  await f.activate();
  assert.deepEqual(await f.bindings(), []);
});

test("Channel startup waits for the lifecycle hook and respects its SessionEnd", async t => {
  const f = await fixture(t);
  let entered, release;
  const acquired = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const hook = withSessionLifecycle({ root: f.runtimeDir,
    sessionId: f.session.harnessSessionId, clock: f.clock }, async () => {
    entered();
    await blocked;
    await f.service.closeSession(f.session);
    await clearSessionBinding(f.binding);
  });
  await acquired;
  const activation = f.activate();
  try {
    const completed = await Promise.race([activation.then(() => true), delay(1_000).then(() => false)]);
    assert.equal(completed, false, "Channel completed registration without acquiring the lifecycle lock");
    assert.deepEqual(await f.bindings(), [], "Channel published while the lifecycle hook held ownership");
  } finally { release(); await hook; await activation; }
  assert.deepEqual(await f.bindings(), []);
});

test("Channel startup recovers an interrupted SessionEnd before interpreting ownership", async t => {
  let interruptClose = false;
  const f = await fixture(t, { failAt: async point => {
    if (interruptClose && point === "after-journal") throw new Error("interrupted SessionEnd");
  } });
  await f.service.openSession({ workspaceId: "workspace_cold", participantId: "peer",
    harness: "fixture", heartbeatCadenceMs: 30_000 });
  assert.equal((await f.activate()).state, "active");
  interruptClose = true;
  await assert.rejects(withSessionLifecycle({ root: f.runtimeDir,
    sessionId: f.session.harnessSessionId, clock: f.clock }, async () => {
    await f.service.clearDeliveryBinding(f.session);
    await f.service.closeSession(f.session);
  }), /interrupted SessionEnd/);
  assert.equal((await f.service.locateSession(f.session.sessionId)).record.state, "open");
  await f.activate();
  assert.deepEqual(await f.bindings(), [], "Channel revived a session with a committed close journal");
  assert.equal((await f.service.locateSession(f.session.sessionId)).record.state, "closed");
});
