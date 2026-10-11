import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { offerObservationPath } from "../../adapter-sdk/src/offer-observation.mjs";
import { loadOfferObservation, storeOfferObservation } from "@agents-can-communicate/adapter-sdk";
import { captureOfferOrder } from "../../adapter-sdk/src/offer-observation-order.mjs";
import test from "node:test";
import { createIndicatorFixture } from "../../../tests/helpers/indicator-fixture.mjs";

// Exercise the actual worker in a forced completion order, independent of OS
// worker startup timing. Order is captured by the caller before dispatch.
function publish(f, state, order, at = f.clock.now()) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../adapter-sdk/src/offer-observation-writer.mjs", import.meta.url), {
      workerData: { runtimeDir: f.runtimeDir, workspaceId: f.workspaceId,
        sessionId: f.session.sessionId, generation: f.session.generation, at, order, state,
        reasonCode: state === "degraded" ? "transport_error" : null, deadlineAt: Date.now() + 3000 },
    });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error(`writer exited ${code}`)); });
  });
}

for (const [latest, earlier, label] of [
  ["active", "degraded", "ACC ●"], ["degraded", "active", "ACC ! · turn"],
]) test(`a delayed ${earlier} observation cannot replace a newer ${latest} with the same millisecond`, async t => {
  const f = await createIndicatorFixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  assert.equal(await publish(f, latest, "200"), true);
  assert.equal(await publish(f, earlier, "100"), false);
  assert.equal((await f.read()).label, label);
});

test("an already recorded order cannot change state on a duplicate publication", async t => {
  const f = await createIndicatorFixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  assert.equal(await publish(f, "active", "200"), true);
  assert.equal(await publish(f, "degraded", "200"), false);
  assert.equal((await f.read()).label, "ACC ●");
});


test("wall-clock dates still take precedence over monotonic tie-break values", async t => {
  const f = await createIndicatorFixture(t);
  await f.service.publishDeliveryBinding(f.binding);
  assert.equal(await publish(f, "active", "200"), true);
  assert.equal(await publish(f, "degraded", "999", "2026-10-08T00:00:00.000Z"), false);
  assert.equal(await publish(f, "degraded", "1", "2026-10-10T00:00:00.000Z"), true);
  assert.equal((await f.read()).label, "ACC ! · turn");
});

test("caller order is strictly increasing and comparable with another Node process", async () => {
  const orders = Array.from({ length: 100 }, captureOfferOrder).map(BigInt);
  assert.ok(orders.every((order, index) => index === 0 || order > orders[index - 1]));
  const module = new URL("../../adapter-sdk/src/offer-observation-order.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval",
    `import {captureOfferOrder} from ${JSON.stringify(module)};console.log(captureOfferOrder());`]);
  assert.ok(BigInt(stdout.trim()) > orders.at(-1));
  assert.ok(BigInt(captureOfferOrder()) > BigInt(stdout.trim()));
});

test("the public API captures its own order before dispatch and does not trust caller order", async t => {
  const f = await createIndicatorFixture(t);
  const input = { runtimeDir: f.runtimeDir, workspaceId: f.workspaceId,
    sessionId: f.session.sessionId, generation: f.session.generation, at: f.clock.now(),
    state: "active", reasonCode: null, order: "99999999999999999999" };
  const before = BigInt(captureOfferOrder());
  assert.equal(await storeOfferObservation(input), true);
  const result = await loadOfferObservation(input);
  assert.ok(BigInt(result.order) > before);
  assert.ok(BigInt(result.order) < BigInt(captureOfferOrder()));
  assert.notEqual(result.order, input.order);
});


test("legacy observations without an order remain readable and accept a new ordered observation", async t => {
  const f = await createIndicatorFixture(t);
  const input = { runtimeDir: f.runtimeDir, workspaceId: f.workspaceId,
    sessionId: f.session.sessionId, generation: f.session.generation };
  const file = offerObservationPath(f.runtimeDir, f.session.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  // Historical schema-1 serialization in this isolated compatibility fixture.
  await writeFile(file, JSON.stringify({ schemaVersion: 1, sessionId: input.sessionId,
    generation: input.generation, at: f.clock.now(), state: "degraded", reasonCode: "transport_error" }));
  assert.deepEqual(await loadOfferObservation(input), { at: f.clock.now(), state: "degraded", reasonCode: "transport_error" });
  assert.equal(await storeOfferObservation({ ...input, at: f.clock.now(), state: "active", reasonCode: null }), true);
  assert.equal((await loadOfferObservation(input)).state, "active");
});
