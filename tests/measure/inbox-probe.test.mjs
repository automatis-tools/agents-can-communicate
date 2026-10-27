import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import inbox from "../../scripts/measure/probes/inbox.mjs";

// #304 for #306: an inbox probe proves which message came back, which receipt
// moved and which event it published, read back from a fresh store.
const repo = path.resolve(import.meta.dirname, "..", "..");
const exact = inbox.scenario({ messages: 12, backlog: 10, operation: "exact", seed: 3 });
const page = inbox.scenario({ messages: 12, backlog: 10, operation: "page", limit: 5, seed: 3 });

async function built(t, scenario) {
  const side = await inbox.load(repo);
  const value = await inbox.build(scenario, side);
  t.after(() => inbox.dispose(value));
  return value;
}
const call = async (value, operate = inbox.operate) => inbox.validate(value, await operate(value, await inbox.prepare(value)));

test("an inbox scenario builds the same records every time, with receipts in every state", async t => {
  const first = await built(t, exact), second = await built(t, exact);
  assert.equal(first.digest, second.digest);
  assert.notEqual(inbox.hash(exact), inbox.hash(page));
  const states = new Set([...first.receipts.values()].filter(item => item.recipient === "reader").map(item => item.state));
  for (const state of ["queued", "offered", "retrieved", "acknowledged"]) assert.ok(states.has(state), state);
  assert.equal(inbox.capacity(exact), exact.messages);
});

test("exact reads return the whole message, move only its receipt, and publish its event", async t => {
  const value = await built(t, exact);
  for (let index = 0; index < exact.messages; index++) assert.deepEqual(await call(value), [], `call ${index}`);
});

test("a page is the newest listable prefix, its cursor continues it, and nothing changes", async t => {
  for (const scenario of [page, inbox.scenario({ messages: 60, backlog: 20, operation: "page", limit: 20, seed: 4 }),
    inbox.scenario({ messages: 120, backlog: 0, operation: "page", limit: 100, seed: 5 })]) {
    const value = await built(t, scenario);
    for (let index = 0; index < 2; index++) assert.deepEqual(await call(value), [], `${scenario.limit} call ${index}`);
  }
});

test("every negative mutation for each operation fails validation", async t => {
  for (const scenario of [exact, page]) {
    const mutations = inbox.mutationsFor(scenario);
    assert.ok(Object.keys(mutations).length >= 5, scenario.operation);
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = await built(t, scenario);
      const failures = await call(value, await mutate(inbox.operate, { side: value.side, scenario }));
      assert.notDeepEqual(failures, [], `${scenario.operation}/${name} passed validation`);
    }
  }
});

test("observations report primary reads beside a valid call", async t => {
  const value = await built(t, exact);
  const observed = await inbox.observe(value);
  assert.deepEqual(observed.failures, []);
  assert.ok(observed.stateReads > 0, JSON.stringify(observed));
  assert.equal(typeof observed.readBytes, "number");
});
