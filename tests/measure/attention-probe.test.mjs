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

test("fully acknowledged history stays quiet beside the witnesses every scenario carries", async () => {
  const side = await attention.load(repo);
  const quiet = await attention.build(attention.scenario({ ...scenario, acknowledgedShare: 1 }), side);
  assert.deepEqual(quiet.expected.map(item => item.sourceId).filter(id => !id.includes("witness")), []);
  // Two per witness, and one for each of the four unavailable presences.
  assert.equal(quiet.expected.length, 2 * scenario.witnesses + 4);
  assert.deepEqual(await attention.validate(quiet, await attention.operate(quiet)), []);
  for (const [name, mutate] of Object.entries(attention.mutations)) {
    const failures = await attention.validate(quiet, await (await mutate(attention.operate, { side, scenario: quiet.scenario }))(quiet));
    assert.notDeepEqual(failures, [], `${name} passed on quiet history`);
  }
});

test("a session record alone is no presence: closed, silent, expired and dead-pid recipients are due", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const presence = built.expected.filter(item => item.sourceId.includes("presence")).map(item => item.detail).sort();
  assert.deepEqual(presence, ["peer_closed", "peer_dead_pid", "peer_expired", "peer_stale"]);
});

test("witnesses carry the scenario, so another size with the same seed expects other items", async () => {
  const side = await attention.load(repo);
  const one = await attention.build(scenario, side);
  const other = await attention.build(attention.scenario({ ...scenario, ownRequests: scenario.ownRequests + 1 }), side);
  const witnesses = value => value.expected.filter(item => item.sourceId.includes("witness")).map(item => item.sourceId);
  assert.equal(witnesses(one).filter(id => witnesses(other).includes(id)).length, 0);
});

test("a scenario that expects nothing is refused, since a constant answer would pass it", async () => {
  const side = await attention.load(repo);
  const empty = await attention.build(attention.scenario({ ...scenario, acknowledgedShare: 1, witnesses: 0 }), side);
  assert.match((await attention.validate(empty, [])).join(), /expects nothing/);
});

test("each call reads its own copy of the snapshot", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const first = attention.prepare(built), second = attention.prepare(built);
  assert.notEqual(first.snapshot, second.snapshot);
  assert.notEqual(first.snapshot.receipts, built.snapshot.receipts);
  assert.deepEqual(first.snapshot, built.snapshot);
});

test("a correct computation that walks the records in another order passes", async () => {
  const side = await attention.load(repo);
  const built = await attention.build(scenario, side);
  const reversed = { snapshot: { ...built.snapshot,
    messages: [...built.snapshot.messages].reverse(), receipts: [...built.snapshot.receipts].reverse() } };
  assert.deepEqual(await attention.validate(built, await attention.operate(built, reversed)), []);
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
