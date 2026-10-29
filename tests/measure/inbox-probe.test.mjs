import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import inbox from "../../scripts/measure/probes/inbox.mjs";

// #304 for #306: an inbox probe proves which message came back, which receipt
// moved and which event it published, read back from a fresh store.
const repo = path.resolve(import.meta.dirname, "..", "..");
const exact = inbox.scenario({ messages: 12, backlog: 10, operation: "exact", seed: 3 });
// Enough listable messages that the byte budget, not the limit, ends a page.
const page = inbox.scenario({ messages: 40, backlog: 4, operation: "page", limit: 20, seed: 3 });
// Each mutation builds its own real store; these need witnesses, not a large backlog.
const mutationScenarios = [
  inbox.scenario({ messages: 8, backlog: 4, operation: "exact", seed: 3 }),
  inbox.scenario({ messages: 12, backlog: 4, operation: "page", limit: 5, seed: 3 }),
];

async function built(t, scenario) {
  const side = await inbox.load(repo);
  const value = await inbox.build(scenario, side);
  t.after(() => inbox.dispose(value));
  return value;
}
const call_ = (value, operate) => call(value, operate);
const call = async (value, operate = inbox.operate) => {
  const input = await inbox.prepare(value);
  return inbox.validate(value, await operate(value, input), input);
};

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

test("mutation fixtures accept real calls and retain conditional mutation witnesses", async t => {
  for (const scenario of mutationScenarios) {
    const value = await built(t, scenario);
    const [first, ...others] = value.reader;
    assert.equal(first.decision, "superseded", `${scenario.operation}: replaced decision`);
    assert.equal(first.state, "queued", `${scenario.operation}: receipt can advance`);
    assert.ok(others.some(item => item.state === "queued" || item.state === "offered"), "unrelated movable receipt");
    assert.ok(others.some(item => item.state === "retrieved"), "another receipt in the exact result's state");
    const input = await inbox.prepare(value), result = await inbox.operate(value, input);
    assert.deepEqual(await inbox.validate(value, result, input), [], scenario.operation);
    if (scenario.operation === "page") {
      assert.ok(result.items.length > 1, "order and short-page mutations need multiple items");
      assert.notEqual(result.nextCursor, null, "over-budget mutation needs another page item");
      assert.notEqual(result.nextCursor, first.messageId, "garbage cursor differs from the continuation");
    }
  }
});

test("every negative mutation for each operation fails validation", async t => {
  for (const scenario of mutationScenarios) {
    const mutations = inbox.mutationsFor(scenario);
    assert.ok(Object.keys(mutations).length >= 5, scenario.operation);
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = await built(t, scenario);
      const failures = await call(value, await mutate(inbox.operate, { side: value.side, scenario }));
      assert.notDeepEqual(failures, [], `${scenario.operation}/${name} passed validation`);
    }
  }
});

test("a page the byte budget ends early passes, and one item fewer than fits fails", async t => {
  const scenario = inbox.scenario({ messages: 120, backlog: 0, operation: "page", limit: 100, seed: 5 });
  const value = await built(t, scenario);
  const input = await inbox.prepare(value), result = await inbox.operate(value, input);
  assert.ok(result.items.length < scenario.limit, `${result.items.length} items: the budget never ended the page`);
  assert.deepEqual(await inbox.validate(value, result, input), []);
  const short = await inbox.mutationsFor(scenario)["short-page"](inbox.operate, { side: value.side, scenario });
  assert.match((await call(value, short)).join(), /items where .* fit the 12000-byte page/);
  const overBudget = await inbox.mutationsFor(scenario)["over-budget"](inbox.operate, { side: value.side, scenario });
  const fresh = await inbox.prepare(value), oversized = await overBudget(value, fresh);
  assert.ok(oversized.items.length <= scenario.limit, "byte overflow must stay within the item limit");
  assert.match((await inbox.validate(value, oversized, fresh)).join(), /over the 12000-byte page/);
});

test("every index path gives valid work, and its cost is its own", async t => {
  const reads = {};
  for (const index of ["warm", "cold", "rebuilt", "unavailable"]) {
    for (const operation of ["exact", "page"]) {
      const value = await built(t, inbox.scenario({ messages: 8, backlog: 12, operation, limit: 5, index, seed: 6 }));
      for (let call = 0; call < 2; call++) assert.deepEqual(await call_(value), [], `${index}/${operation} call ${call}`);
      reads[`${index}/${operation}`] = (await inbox.observe(value)).stateReads;
    }
  }
  // A page looks up its receipts by index, so a cache that has to be rebuilt reads every
  // message and receipt once; a warm one does not. An exact read of anything but a
  // decision needs no index at all.
  for (const index of ["cold", "rebuilt", "unavailable"]) {
    assert.ok(reads[`${index}/page`] > reads["warm/page"], `${index}: ${JSON.stringify(reads)}`);
    assert.ok(reads[`${index}/page`] <= reads["cold/page"], `${index} rebuilt more than once: ${JSON.stringify(reads)}`);
  }
});

test("observations report primary reads beside a valid call", async t => {
  const value = await built(t, exact);
  const observed = await inbox.observe(value);
  assert.deepEqual(observed.failures, []);
  assert.ok(observed.stateReads > 0, JSON.stringify(observed));
  assert.equal(typeof observed.readBytes, "number");
});
