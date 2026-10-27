import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import attention from "../../scripts/measure/probes/attention.mjs";

// #304: a probe proves the useful work from its scenario alone, so a correct
// optimization passes and skipped work fails, whatever the traversal costs.
const repo = path.resolve(import.meta.dirname, "..", "..");
const scenario = attention.scenario({ ownRequests: 40, fanout: 3, acknowledgedShare: 0.5,
  offlineShare: 0.5, inboundObligations: 12, seed: 7 });

test("an attention scenario is deterministic and its hash names its parameters", async () => {
  const side = await attention.load(repo);
  const first = await attention.build(scenario, side), second = await attention.build(scenario, side);
  assert.equal(first.digest, second.digest);
  assert.equal(attention.hash(scenario), attention.hash(attention.scenario({ ...scenario })));
  assert.notEqual(attention.hash(scenario), attention.hash(attention.scenario({ ...scenario, seed: 8 })));
  const kinds = new Set(first.expected.map(item => item.kind));
  for (const kind of ["recipient_unavailable", "reply_required", "acknowledgement_required"]) {
    assert.ok(kinds.has(kind), `the scenario expects some ${kind}`);
  }
});

test("the current attention computation does the useful work", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  assert.deepEqual(await attention.validate(built, await attention.operate(built)), []);
});

test("fully acknowledged history is expected to stay quiet", async () => {
  const side = await attention.load(repo);
  const quiet = await attention.build(attention.scenario({ ...scenario, acknowledgedShare: 1 }), side);
  assert.deepEqual(quiet.expected, []);
  assert.deepEqual(await attention.validate(quiet, await attention.operate(quiet)), []);
});

test("a correct computation that walks the records in another order passes", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const reversed = { ...built, snapshot: { ...built.snapshot,
    messages: [...built.snapshot.messages].reverse(), receipts: [...built.snapshot.receipts].reverse() } };
  assert.deepEqual(await attention.validate(built, await attention.operate(reversed)), []);
});

test("every negative mutation fails validation", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  assert.ok(Object.keys(attention.mutations).length >= 4);
  for (const [name, mutate] of Object.entries(attention.mutations)) {
    const operate = await mutate(attention.operate, { side, scenario });
    const failures = await attention.validate(built, await operate(built));
    assert.notDeepEqual(failures, [], `${name} passed validation`);
  }
});

test("observations count record visits without deciding validity", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const observed = await attention.observe(built);
  assert.ok(observed.receiptVisits >= built.snapshot.receipts.length, JSON.stringify(observed));
  assert.ok(observed.messageVisits >= built.snapshot.messages.length, JSON.stringify(observed));
  assert.equal(observed.items, built.expected.length);
});
