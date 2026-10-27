import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import transaction from "../../scripts/measure/probes/transaction.mjs";

// #304 for #307: history grows independently of the records read. A read
// commits nothing; a write commits exactly one event with the next sequence.
const repo = path.resolve(import.meta.dirname, "..", "..");
const read = transaction.scenario({ messages: 6, events: 40, operation: "read", seed: 5 });
const write = transaction.scenario({ messages: 6, events: 40, operation: "write", seed: 5 });

async function built(t, scenario) {
  const side = await transaction.load(repo);
  const value = await transaction.build(scenario, side);
  t.after(() => transaction.dispose(value));
  return value;
}

test("the fixture holds the messages and at least the events the scenario names", async t => {
  const value = await built(t, read);
  assert.ok(value.events >= read.events, `${value.events} events`);
  const again = await built(t, read);
  assert.equal(value.digest, again.digest);
  assert.notEqual(transaction.hash(read), transaction.hash({ ...read, events: 400 }));
});

test("a read returns the receipt's state and commits no event", async t => {
  const value = await built(t, read);
  for (let call = 0; call < 3; call++) {
    assert.deepEqual(await transaction.validate(value, await transaction.operate(value)), [], `call ${call}`);
  }
});

test("a write commits exactly one event, with the next sequence", async t => {
  const value = await built(t, write);
  for (let call = 0; call < 3; call++) {
    assert.deepEqual(await transaction.validate(value, await transaction.operate(value)), [], `call ${call}`);
  }
});

test("every negative mutation for each operation fails validation", async t => {
  for (const scenario of [read, write]) {
    const mutations = transaction.mutationsFor(scenario);
    assert.ok(Object.keys(mutations).length >= 3, scenario.operation);
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = await built(t, scenario);
      const operate = await mutate(transaction.operate, { side: value.side, scenario });
      const failures = await transaction.validate(value, await operate(value));
      assert.notDeepEqual(failures, [], `${scenario.operation}/${name} passed validation`);
    }
  }
});

test("observations report how much of the event history a valid call enumerated", async t => {
  const value = await built(t, read);
  const observed = await transaction.observe(value);
  assert.deepEqual(observed.failures, []);
  assert.ok(observed.stateReads > 0, JSON.stringify(observed));
  // An observation of today's cost, never a condition of validity: #307 may lower it.
  assert.equal(typeof (observed.enumerations["events/readdirEntries"] ?? 0), "number", JSON.stringify(observed));
});
