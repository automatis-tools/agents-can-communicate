import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOfferObservation } from "@agents-can-communicate/adapter-sdk";
import { createCoordinationService } from "@agents-can-communicate/core";
import { openFilesystemStore, withWriterMutex } from "@agents-can-communicate/storage-filesystem";
import { createDeliveryRouter } from "../src/router.mjs";
import { createFakeClock, createFakeIds } from "../../../tests/helpers/memory-store.mjs";
import { cleanupStack, removeFixture } from "../../../tests/helpers/fixture-cleanup.mjs";

const WORKSPACE = "workspace_offer_observation";
const NOW = "2026-10-09T04:00:00.000Z";
const owner = session => ({ sessionId: session.sessionId, generation: session.generation });

async function fixture(t, mode) {
  const cleanup = cleanupStack(t);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "acc-router-observation-")));
  cleanup(() => removeFixture(root));
  const clock = createFakeClock(NOW), ids = createFakeIds();
  const store = await openFilesystemStore({ root, workspaceId: WORKSPACE, clock, ids });
  const service = createCoordinationService({ store, clock, ids, pidIsAlive: () => true });
  const sessions = {};
  for (const participantId of ["sender", "first", "second"]) {
    sessions[participantId] = await service.openSession({ workspaceId: WORKSPACE,
      participantId, harness: "fixture", heartbeatCadenceMs: 30_000 });
  }
  for (const participantId of ["first", "second"]) {
    await service.publishDeliveryBinding({ ...owner(sessions[participantId]),
      adapterId: "fixture", clientVersion: "1.0.0", availableModes: ["livePush"],
      livePolicy: "actionable", opaqueEndpointRef: `endpoint-${participantId}`,
      leaseUntil: mode === "refresh" && participantId === "first"
        ? NOW : "2026-10-09T04:02:00.000Z" });
  }
  const adapter = { id: "fixture", capabilities: { delivery: { livePush: true } },
    nativeDelivery: { minimum: "1.0.0", anchors: [{ version: "1.0.0", protocolContract: "fixture-v1" }],
      activationKinds: ["native-service"], knownBad: [], ...(mode === "wake" ? { offerKind: "wake" } : {}) },
    refreshNativeSession: async () => { throw new Error("endpoint unavailable"); },
    offerMessage: async ({ binding }) => ({ accepted: mode !== "rejected"
      || binding.sessionId !== sessions.first.sessionId, transport: "codex-app-server",
    clientVersion: "1.0.0", safeErrorCode: "recipient_busy" }),
  };
  const router = createDeliveryRouter({ service, clock, adapters: [adapter],
    readLivePolicy: async () => "actionable" });
  const message = await service.sendMessage({ ...owner(sessions.sender),
    clientMessageId: "client_observation", toParticipantIds: ["first", "second"], kind: "question",
    obligation: "reply", subject: "Observe delivery", body: "Please answer." });

  // Observe the actual diagnostic workers without replacing their dispatch,
  // writes, or mutex. Their completion is a barrier, not an elapsed-time guess.
  const workers = [], started = Promise.withResolvers();
  const onWorker = worker => {
    const done = Promise.withResolvers(), exited = Promise.withResolvers();
    const observation = { completed: false, done: done.promise, exited: exited.promise };
    workers.push(observation);
    worker.once("message", value => { observation.completed = true; done.resolve(value); });
    worker.once("error", () => { observation.completed = true; done.resolve(false); });
    worker.once("exit", () => { observation.completed = true; done.resolve(false); exited.resolve(); });
    started.resolve(observation);
  };
  process.on("worker", onWorker);
  cleanup(async () => {
    process.off("worker", onWorker);
    await Promise.all(workers.map(worker => worker.exited));
  });
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const held = withWriterMutex({ locks: path.join(root, "offer-observation-locks", sessions.first.sessionId) },
    { root, clock: { now: () => new Date().toISOString() } }, async () => {
      entered.resolve();
      await released.promise;
    });
  cleanup(async () => { released.resolve(); await held; });
  await entered.promise;
  return { root, router, service, store, sessions, message, cleanup, worker: started.promise,
    release: async () => { released.resolve(); await held; } };
}

for (const [mode, firstOutcome, firstState, reasonCode, eventType] of [
  ["success", "offered", "offered", null, "message.offer_succeeded"],
  ["wake", "woken", "queued", null, null],
  ["rejected", "queued", "queued", "recipient_busy", "message.offer_failed"],
  ["refresh", "queued", "queued", "recipient_unavailable", null],
]) test(`${mode}: a held diagnostic mutex cannot block the next recipient or offer result`,
  { timeout: 10_000 }, async t => {
    const f = await fixture(t, mode);
    const offered = f.router.offer(f.message);
    const worker = await f.worker;
    const outcomes = await offered;
    assert.equal(worker.completed, false, "delivery waited for the diagnostic worker to finish");
    assert.equal(outcomes[0].outcome, firstOutcome);
    assert.equal(outcomes[1].outcome, mode === "wake" ? "woken" : "offered");
    assert.equal((await f.service.readReceipt({ messageId: f.message.messageId,
      recipientParticipantId: "first" })).state, firstState);
    assert.equal((await f.service.readReceipt({ messageId: f.message.messageId,
      recipientParticipantId: "second" })).state, mode === "wake" ? "queued" : "offered");
    const eventsBefore = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
    const deliveryEvents = eventsBefore.filter(event => event.payload.recipientParticipantId === "first"
      && ["message.offer_succeeded", "message.offer_failed"].includes(event.type));
    assert.deepEqual(deliveryEvents.map(event => event.type), eventType === null ? [] : [eventType]);
    assert.equal(await loadOfferObservation({ runtimeDir: f.root, ...owner(f.sessions.first) }), null);

    await f.release();
    assert.equal(await worker.done, true, "the optional diagnostic must still publish after delivery returns");
    const observation = await loadOfferObservation({ runtimeDir: f.root, ...owner(f.sessions.first) });
    assert.equal(observation.state, reasonCode === null ? "active" : "degraded");
    assert.equal(observation.reasonCode, reasonCode);
    assert.deepEqual((await f.store.eventsSince(WORKSPACE, null, 100)).events, eventsBefore,
      "publishing a UI diagnostic must not create delivery history");
  });

test("a diagnostic writer failure cannot reject or rewrite a completed delivery", async t => {
  const f = await fixture(t, "success");
  await writeFile(path.join(f.root, "offer-observations"), "not a directory");
  const offered = f.router.offer(f.message);
  const worker = await f.worker;
  assert.deepEqual((await offered).map(item => item.outcome), ["offered", "offered"]);
  await f.release();
  assert.equal(await worker.done, false);
  assert.equal((await f.service.readReceipt({ messageId: f.message.messageId,
    recipientParticipantId: "first" })).state, "offered");
  const events = (await f.store.eventsSince(WORKSPACE, null, 100)).events;
  assert.equal(events.filter(event => event.type === "message.offer_failed").length, 0);
});

test("an unawaited observation survives a short-lived caller after it reports dispatch", async t => {
  const f = await fixture(t, "success");
  const input = { runtimeDir: f.root, workspaceId: WORKSPACE, ...owner(f.sessions.first),
    at: NOW, state: "active", reasonCode: null };
  const module = new URL("../../adapter-sdk/src/offer-observation.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--eval", `
    import(${JSON.stringify(module)}).then(({ storeOfferObservation }) => {
      void storeOfferObservation(${JSON.stringify(input)}).catch(() => {});
      process.stdout.write("dispatched\\n");
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  f.cleanup(async () => { if (child.exitCode === null) child.kill(); await exited; });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [output] = await once(child.stdout, "data");
  assert.equal(output.toString(), "dispatched\n");
  assert.equal(await loadOfferObservation(input), null, "the writer mutex is still held");
  await f.release();
  assert.deepEqual(await exited, [0, null], stderr);
  assert.equal((await loadOfferObservation(input))?.state, "active",
    "the bounded SDK lifetime must preserve a diagnostic after the caller returns");
});
