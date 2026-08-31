import assert from "node:assert/strict";
import test from "node:test";

import { looksConsequential, noteNudge } from "../src/message-signals.mjs";

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

test("noteNudge speaks for a consequential note that carries no ack obligation", () => {
  assert.match(noteNudge({ type: "note", requiresAck: false,
    subject: "Snow", body: "It touches your file. Have you started?" }),
  /--requires-ack|acc decide/);
});

test("noteNudge stays silent when the sender already set requiresAck", () => {
  assert.equal(noteNudge({ type: "note", requiresAck: true, subject: "x",
    body: "Have you started?" }), null);
});

test("noteNudge stays silent for a plain FYI note", () => {
  assert.equal(noteNudge({ type: "note", requiresAck: false, subject: "FYI",
    body: "Logged it. Nothing to do." }), null);
});

test("noteNudge only speaks for notes, not questions or other types", () => {
  assert.equal(noteNudge({ type: "question", requiresAck: false, subject: "x",
    body: "Have you started?" }), null);
});
