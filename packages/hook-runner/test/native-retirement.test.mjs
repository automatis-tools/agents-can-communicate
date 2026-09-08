import assert from "node:assert/strict";
import test from "node:test";
import { establishNativeBinding } from "../src/native-binding.mjs";

const generation = "generation_old";
const prior = { sessionId: "session_x", generation, opaqueEndpointRef: "endpoint_old", retiredAt: null };
const run = (service, retireNativeSession, timeoutMs = 80) => establishNativeBinding({
  adapter: { retireNativeSession }, hookBinding: { accSessionId: prior.sessionId, generation },
  service, livePolicy: "off", runtimeDir: "/private/runtime", timeoutMs });

function fixture({ firstReadError = false, successor = false, clearFails = false, hangs = false } = {}) {
  let stored = { ...prior };
  let reads = 0;
  const calls = [];
  return { calls, store: { ephemeral: { async get() {
    reads += 1;
    if (hangs && reads === 1) return new Promise(() => {});
    if (firstReadError && reads === 1) throw new Error("unreadable");
    return stored;
  } } }, async clearDeliveryBinding(input) {
    calls.push(["clear", input]);
    if (clearFails) throw new Error("retirement failed");
    stored = successor ? { ...prior, generation: "generation_new", opaqueEndpointRef: "endpoint_new" }
      : { ...prior, retiredAt: "2026-09-08T00:00:00.000Z" };
  } };
}

test("policy off retires in core before cleaning exactly the old adapter endpoint", async () => {
  const service = fixture();
  const outcome = await run(service, async input => service.calls.push(["cleanup", input]));
  assert.equal(outcome.state, "off");
  const [clear, cleanup] = service.calls;
  const { deadlineAt, ...clearInput } = clear[1];
  assert.equal(clear[0], "clear");
  assert.deepEqual(clearInput, { sessionId: prior.sessionId, generation,
    opaqueEndpointRef: prior.opaqueEndpointRef });
  assert.equal(Number.isFinite(deadlineAt), true);
  assert.deepEqual(cleanup, ["cleanup", { binding: prior, runtimeDir: "/private/runtime" }]);
});

test("failed retirement or successor publication cannot clean an endpoint", async () => {
  for (const options of [{ successor: true }, { clearFails: true }]) {
    const service = fixture(options);
    await run(service, async () => service.calls.push(["cleanup"]));
    assert.deepEqual(service.calls.map(call => call[0]), ["clear"]);
  }
});

test("metadata read failure cannot prevent primary retirement", async () => {
  for (const options of [{ firstReadError: true }, { hangs: true }]) {
    const service = fixture(options);
    await run(service, async () => service.calls.push(["cleanup"]));
    assert.deepEqual(service.calls.map(call => call[0]), ["clear"]);
  }
});

test("adapter cleanup failure and timeout remain bounded and fail open", async () => {
  for (const cleanup of [async () => { throw new Error("unavailable"); },
    async () => new Promise(() => {})]) {
    const result = await Promise.race([run(fixture(), cleanup, 40),
      new Promise(resolve => setTimeout(() => resolve("unbounded"), 300))]);
    assert.equal(result.state, "off");
  }
});


test("an indeterminate retirement must not start or publish a new handshake", async () => {
  let bindCalls = 0;
  let publishCalls = 0;
  const service = fixture();
  service.clearDeliveryBinding = async () => new Promise(() => {});
  service.publishDeliveryBinding = async () => { publishCalls += 1; };
  const result = await establishNativeBinding({ adapter: { nativeDelivery: {},
    retireNativeSession: async () => {}, bindNativeSession: async () => { bindCalls += 1; } },
    hookBinding: { accSessionId: prior.sessionId, generation, clientPid: 42 },
    service, livePolicy: "actionable", runtimeDir: "/private/runtime", timeoutMs: 40 });
  assert.equal(result.state, "degraded");
  assert.equal(bindCalls, 0);
  assert.equal(publishCalls, 0);
});

test("an optional cleanup branch bounds an indeterminate clear without rebinding", async () => {
  // Replacing the deadline attempt with a direct await leaves this race unresolved.
  let bindCalls = 0;
  let publishCalls = 0;
  const clearInputs = [];
  const service = { clearDeliveryBinding: async input => {
    clearInputs.push(input);
    return new Promise(() => {});
  }, publishDeliveryBinding: async () => { publishCalls += 1; } };
  const result = await Promise.race([
    establishNativeBinding({ adapter: { nativeDelivery: {}, bindNativeSession: async () => {
      bindCalls += 1;
    } }, hookBinding: { accSessionId: prior.sessionId, generation, clientPid: 42 },
    service, livePolicy: "actionable", runtimeDir: "/private/runtime", timeoutMs: 40 }),
    new Promise(resolve => setTimeout(() => resolve("unbounded"), 200)),
  ]);

  assert.notEqual(result, "unbounded");
  assert.equal(result.state, "degraded");
  assert.equal(bindCalls, 0);
  assert.equal(publishCalls, 0);
  const { deadlineAt, ...clearInput } = clearInputs[0];
  assert.deepEqual(clearInput, { sessionId: prior.sessionId, generation });
  assert.equal(Number.isFinite(deadlineAt), true);
  assert.equal(Object.hasOwn(clearInput, "opaqueEndpointRef"), false);
});
