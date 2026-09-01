import assert from "node:assert/strict";
import test from "node:test";

import { AccError, EXIT } from "../src/errors.mjs";
import { RECEIPT_STATES, advanceReceipt } from "../src/states.mjs";

test("receipt advances along the truthful delivery lifecycle", () => {
  assert.equal(advanceReceipt("queued", "offered"), "offered");
  assert.equal(advanceReceipt("offered", "retrieved"), "retrieved");
  assert.equal(advanceReceipt("retrieved", "acknowledged"), "acknowledged");
});

test("stronger evidence may skip weaker receipt states", () => {
  assert.equal(advanceReceipt("queued", "retrieved"), "retrieved");
  assert.equal(advanceReceipt("queued", "acknowledged"), "acknowledged");
  assert.equal(advanceReceipt("offered", "acknowledged"), "acknowledged");
});

test("receipt transitions are monotonic and never move backwards", () => {
  assert.throws(() => advanceReceipt("acknowledged", "retrieved"), AccError);
  assert.throws(() => advanceReceipt("retrieved", "offered"), AccError);
  assert.throws(() => advanceReceipt("offered", "queued"),
    error => error.code === EXIT.CONFLICT
      && error.message.includes("offered") && error.message.includes("queued"));
});

test("re-declaring a receipt state is idempotent", () => {
  assert.deepEqual(RECEIPT_STATES, ["queued", "offered", "retrieved", "acknowledged"]);
  for (const state of RECEIPT_STATES) assert.equal(advanceReceipt(state, state), state);
});

test("removed and unknown receipt states are data errors", () => {
  for (const [current, next] of [["recorded", "queued"], ["queued", "injected"],
    ["seen", "acknowledged"], ["queued", "failed"], ["imagined", "retrieved"]]) {
    assert.throws(() => advanceReceipt(current, next), error => error.code === EXIT.DATA,
      `accepted ${current} -> ${next}`);
  }
});
