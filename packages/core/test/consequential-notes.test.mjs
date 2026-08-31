import assert from "node:assert/strict";
import test from "node:test";

import { looksConsequential } from "../src/message-signals.mjs";

test("a note that asks a question reads as consequential", () => {
  assert.equal(looksConsequential({
    subject: "Snow is coming",
    body: "It will touch your surface_seam_policy.gd. Have you started your part yet?" }), true);
});

test("a full-width question mark counts, because a question is a question in any script", () => {
  assert.equal(looksConsequential({ subject: "gear vocabulary", body: "始めましたか？" }), true);
});

test("a warning marker reads as consequential", () => {
  assert.equal(looksConsequential({
    subject: "⚠ tail numbers will collide", body: "you have 66-71, I have 66-68" }), true);
});

test("the subject alone can carry the signal", () => {
  assert.equal(looksConsequential({ subject: "Which vocabulary should gear.type use?", body: "" }), true);
});

test("a plain FYI does not read as consequential", () => {
  assert.equal(looksConsequential({
    subject: "Third vocabulary list, for the record",
    body: "Logged it as tail 65. Nothing for you to do." }), false);
});

test("missing fields are treated as empty rather than thrown", () => {
  assert.equal(looksConsequential({}), false);
  assert.equal(looksConsequential(), false);
});
