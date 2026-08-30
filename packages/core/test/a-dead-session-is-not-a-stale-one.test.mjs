import assert from "node:assert/strict";
import test from "node:test";

import { EXIT } from "@agents-can-communicate/protocol";

import { classifySessionPresence } from "../src/sessions.mjs";

const NOW = "2026-08-28T12:00:00.000Z";
const CADENCE = 60_000;

const ago = ms => new Date(Date.parse(NOW) - ms).toISOString();

const session = (overrides = {}) => ({
  sessionId: "session_a", state: "open", heartbeatCadenceMs: CADENCE,
  heartbeatAt: NOW, pid: null, ...overrides });

const alive = () => true;
const dead = () => false;

test("a closed session is offline whatever its pid says", () => {
  assert.equal(classifySessionPresence(session({ state: "closed", pid: 42 }), NOW, alive),
    "offline");
});

test("a session whose process is gone is offline, not stale", () => {
  // The point of the whole change: without a pid this is `online`, because it
  // beat a moment ago. The process is what tells us otherwise.
  assert.equal(classifySessionPresence(session({ pid: 42 }), NOW, dead), "offline");
});

test("a live process idle past the unknown floor stays on the roster", () => {
  // A kimi session beats only when its user takes a turn, so an hour of silence
  // is ordinary. The unknown floor must not apply when the pid answers.
  assert.equal(classifySessionPresence(
    session({ pid: 42, heartbeatAt: ago(90 * 60_000) }), NOW, alive), "stale");
});

test("a live process past the hard floor is offline anyway", () => {
  // pids are recycled, so "alive" can be a different program wearing the same
  // number. Twenty-five hours of silence is not a session anyone is using.
  assert.equal(classifySessionPresence(
    session({ pid: 42, heartbeatAt: ago(25 * 60 * 60_000) }), NOW, alive), "offline");
});

test("an unknown pid is judged by age alone", () => {
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(10_000) }), NOW, dead),
    "online");
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(5 * 60_000) }), NOW, dead),
    "stale");
  assert.equal(classifySessionPresence(session({ heartbeatAt: ago(31 * 60_000) }), NOW, dead),
    "offline");
});

test("omitting the probe fails loudly rather than checking nothing", () => {
  // A defaulted probe would let a forgotten call site disable the check while
  // everything still looked correct.
  assert.throws(() => classifySessionPresence(session(), NOW),
    error => error.code === EXIT.USAGE);
});
