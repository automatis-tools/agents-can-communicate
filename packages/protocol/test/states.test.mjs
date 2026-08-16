import assert from "node:assert/strict";
import test from "node:test";

import { AccError, EXIT } from "../src/errors.mjs";
import { DELIVERY_STATES, TASK_STATES, advanceDelivery, transitionTask } from "../src/states.mjs";

test("delivery advances along the documented lifecycle", () => {
  assert.equal(advanceDelivery("recorded", "queued"), "queued");
  assert.equal(advanceDelivery("queued", "injected"), "injected");
  assert.equal(advanceDelivery("queued", "seen"), "seen");
  assert.equal(advanceDelivery("injected", "seen"), "seen");
  assert.equal(advanceDelivery("seen", "acknowledged"), "acknowledged");
});

test("delivery is monotonic and never moves backwards", () => {
  assert.throws(() => advanceDelivery("acknowledged", "injected"), AccError);
  assert.throws(() => advanceDelivery("seen", "queued"), AccError);
  assert.throws(() => advanceDelivery("injected", "recorded"), AccError);
  assert.throws(() => advanceDelivery("queued", "recorded"),
    error => error.code === EXIT.CONFLICT);
});

test("re-declaring the current delivery state is accepted as idempotent", () => {
  // Adapters retry at safe points; a repeated "seen" must not be an error.
  for (const state of DELIVERY_STATES) {
    assert.equal(advanceDelivery(state, state), state);
  }
});

test("failed is reachable only before the message was exposed", () => {
  assert.equal(advanceDelivery("recorded", "failed"), "failed");
  assert.equal(advanceDelivery("queued", "failed"), "failed");
  assert.throws(() => advanceDelivery("seen", "failed"), AccError);
  assert.throws(() => advanceDelivery("acknowledged", "failed"), AccError);
});

test("failed and acknowledged are terminal", () => {
  assert.throws(() => advanceDelivery("failed", "queued"), AccError);
  assert.throws(() => advanceDelivery("acknowledged", "seen"), AccError);
});

test("unknown delivery states are rejected as data errors", () => {
  assert.throws(() => advanceDelivery("queued", "delivered"),
    error => error.code === EXIT.DATA);
  assert.throws(() => advanceDelivery("imagined", "seen"),
    error => error.code === EXIT.DATA);
});

test("tasks follow the documented state machine", () => {
  assert.equal(transitionTask("pending", "in_progress"), "in_progress");
  assert.equal(transitionTask("in_progress", "review"), "review");
  assert.equal(transitionTask("review", "done"), "done");
  assert.equal(transitionTask("review", "in_progress"), "in_progress");
  assert.equal(transitionTask("in_progress", "blocked"), "blocked");
  assert.equal(transitionTask("blocked", "in_progress"), "in_progress");
});

test("done is terminal and pending cannot skip straight to done", () => {
  assert.throws(() => transitionTask("done", "in_progress"),
    error => error.code === EXIT.CONFLICT);
  assert.throws(() => transitionTask("pending", "done"),
    error => error.code === EXIT.CONFLICT);
});

test("re-declaring the current task state is idempotent", () => {
  for (const state of TASK_STATES) {
    assert.equal(transitionTask(state, state), state);
  }
});

test("unknown task states are rejected as data errors", () => {
  assert.throws(() => transitionTask("pending", "abandoned"),
    error => error.code === EXIT.DATA);
  assert.throws(() => transitionTask("napping", "done"),
    error => error.code === EXIT.DATA);
});

test("an illegal transition names both states so the failure is diagnosable", () => {
  assert.throws(() => advanceDelivery("acknowledged", "injected"),
    error => error.message.includes("acknowledged") && error.message.includes("injected"));
  assert.throws(() => transitionTask("done", "pending"),
    error => error.message.includes("done") && error.message.includes("pending"));
});
