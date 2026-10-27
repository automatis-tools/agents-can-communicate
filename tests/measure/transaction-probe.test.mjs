import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import transaction from "../../scripts/measure/probes/transaction.mjs";

// #304 for #307: history grows independently of the records read. A read
// commits nothing and sees the receipt as another process just left it; a
// write commits exactly one event with the next sequence.
const repo = path.resolve(import.meta.dirname, "..", "..");
const read = transaction.scenario({ messages: 6, events: 40, operation: "read", seed: 5 });
const write = transaction.scenario({ messages: 6, events: 40, operation: "write", seed: 5 });
const journal = transaction.scenario({ messages: 6, events: 40, operation: "read", pendingJournal: true, seed: 5 });

const call = async (value, operate = transaction.operate) => {
  const input = await transaction.prepare(value);
  return transaction.validate(value, await operate(value, input), input);
};

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
  assert.deepEqual(new Set(value.states.values()), new Set(["queued", "offered", "retrieved", "acknowledged"]));
  for (let index = 0; index < 5; index++) {
    assert.deepEqual(await call(value), [], `call ${index}`);
  }
  // Each read met a receipt that another process had stepped since the fixture was built.
  assert.notDeepEqual([...value.states], [...value.initial]);
});

test("a read of the receipt record outside a transaction is correct without an open journal", async t => {
  const value = await built(t, read);
  const recordRead = await transaction.recordRead(transaction.operate, { side: value.side, scenario: read });
  for (let index = 0; index < 4; index++) assert.deepEqual(await call(value, recordRead), [], `call ${index}`);
});

test("a write commits exactly one event, with the next sequence", async t => {
  const value = await built(t, write);
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await call(value), [], `call ${index}`);
  }
});

test("a read after a step stopped at its journal sees the decision, and commits nothing of its own", async t => {
  const value = await built(t, journal);
  for (let index = 0; index < 6; index++) assert.deepEqual(await call(value), [], `call ${index}`);
  // The same read outside a transaction misses each decision.
  const again = await built(t, journal);
  const recordRead = await transaction.recordRead(transaction.operate, { side: again.side, scenario: journal });
  assert.match((await call(again, recordRead)).join("\n"), /returned .* queued, not .* offered/);
});

test("a read that sees the decision and leaves the stopped step to recovery passes", async t => {
  // A read-only transaction may answer from the decided journal without finishing it;
  // the next store that opens finishes it, and nothing is lost.
  const value = await built(t, journal);
  const readOnly = async built => {
    const message = built.messages[built.next++];
    built.target = message.messageId;
    return { messageId: message.messageId, recipientParticipantId: "reader", state: built.states.get(message.messageId) };
  };
  for (let index = 0; index < 3; index++) assert.deepEqual(await call(value, readOnly), [], `call ${index}`);
});

test("every negative mutation for each operation fails validation", async t => {
  for (const scenario of [read, write, journal]) {
    const mutations = transaction.mutationsFor(scenario);
    assert.ok(Object.keys(mutations).length >= 3, scenario.operation);
    for (const [name, mutate] of Object.entries(mutations)) {
      const value = await built(t, scenario);
      const failures = await call(value, await mutate(transaction.operate, { side: value.side, scenario }));
      const label = `${scenario.operation}${scenario.pendingJournal ? " after a stopped write" : ""}/${name}`;
      assert.notDeepEqual(failures, [], `${label} passed validation`);
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
