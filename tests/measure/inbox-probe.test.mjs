import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import inbox from "../../scripts/measure/probes/inbox.mjs";

// #304 for #306: an inbox probe proves which message came back and which
// receipt moved, read from the store, whatever the implementation loads.
const repo = path.resolve(import.meta.dirname, "..", "..");
const exact = inbox.scenario({ messages: 12, backlog: 10, operation: "exact", seed: 3 });
const page = inbox.scenario({ messages: 12, backlog: 10, operation: "page", limit: 5, seed: 3 });

async function built(t, scenario) {
  const side = await inbox.load(repo);
  const value = await inbox.build(scenario, side);
  t.after(() => inbox.dispose(value));
  return value;
}

test("an inbox scenario builds the same primary records every time", async t => {
  const first = await built(t, exact), second = await built(t, exact);
  assert.equal(first.digest, second.digest);
  assert.notEqual(inbox.hash(exact), inbox.hash(page));
});

test("exact reads return the named message and move only its receipt, one per call", async t => {
  const value = await built(t, exact);
  for (let call = 0; call < 3; call++) {
    assert.deepEqual(await inbox.validate(value, await inbox.operate(value)), [], `call ${call}`);
  }
});

test("a page returns the newest listable messages and changes no receipt", async t => {
  const value = await built(t, page);
  for (let call = 0; call < 2; call++) {
    assert.deepEqual(await inbox.validate(value, await inbox.operate(value)), [], `call ${call}`);
  }
});

test("every negative mutation for each operation fails validation", async t => {
  for (const scenario of [exact, page]) {
    const mutations = inbox.mutationsFor(scenario);
    assert.ok(Object.keys(mutations).length >= 3, scenario.operation);
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = await built(t, scenario);
      const operate = await mutate(inbox.operate, { side: value.side, scenario });
      const failures = await inbox.validate(value, await operate(value));
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
