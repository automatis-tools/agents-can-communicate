import assert from "node:assert/strict";
import test from "node:test";

import { planInstallation } from "../src/plan.mjs";

/**
 * Asking for a client by name, when the probe cannot find it.
 *
 * Presence is decided by running the client's `--version`, which answers "can
 * ACC run this client" - not the question that matters. ACC never runs it. The
 * client runs ACC's hook, and all ACC needs is a directory to write into.
 *
 * Observed: the Gemini CLI installed under one Node version while ACC ran under
 * another. `~/.gemini` sat there with the user's own settings in it, and every
 * `acc install` answered "Gemini CLI is not installed on this machine".
 *
 * Presence cannot be inferred from that directory existing, because ACC creates
 * it itself when it installs - a first attempt at this read a client's own
 * fixture as proof the client was there. What is unambiguous is a person naming
 * the client: `acc install --adapter gemini_cli` is an answer to the question
 * the probe was guessing at, and it is honoured.
 */
const adapter = (id, overrides = {}) => ({
  id,
  displayName: id,
  client: { command: id, versionArgs: ["--version"] },
  capabilities: {},
  planInstall: () => [{ path: `/tmp/${id}`, kind: "file" }],
  ...overrides,
});

const absent = id => ({ adapterId: id, displayName: id, present: false, version: null,
  versionOutput: null, installed: false, diagnostics: [], capabilities: {}, error: null });

const plan = extra => planInstallation({
  adapters: [adapter("gemini_cli")],
  detected: [absent("gemini_cli")],
  context: { home: "/home/x", stateRoot: "/state" },
  action: "install",
  ...extra,
});

test("a client nobody asked for, that nothing can find, is still skipped", () => {
  const result = plan({});

  assert.deepEqual(result.operations, []);
  assert.match(result.skipped[0].reason, /not installed on this machine/);
});

test("a client asked for by name is installed even when the probe missed it", () => {
  const result = plan({ requested: ["gemini_cli"] });

  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("naming one client does not carry the others in with it", () => {
  const result = planInstallation({
    adapters: [adapter("gemini_cli"), adapter("kimi")],
    detected: [absent("gemini_cli"), absent("kimi")],
    context: { home: "/home/x", stateRoot: "/state" },
    action: "install",
    requested: ["gemini_cli"],
  });

  assert.deepEqual(result.operations.map(one => one.adapterId), ["gemini_cli"]);
  assert.deepEqual(result.skipped.map(one => one.adapterId), ["kimi"]);
});

test("the skip says how to answer it", () => {
  // The whole failure was a message that read as a verdict on the machine when
  // it was a verdict on PATH. It has to name the way past itself.
  const [skipped] = plan({}).skipped;

  assert.match(skipped.reason, /--adapter gemini_cli/,
    `the skip does not name the remedy: ${skipped.reason}`);
});

test("an explicit request does not override a downgrade", () => {
  // Two different questions. "Is this client here" is answered by naming it;
  // "should an older ACC replace a newer one" is not.
  const result = plan({ requested: ["gemini_cli"], accVersion: "0.1.1",
    recorded: [{ adapterId: "gemini_cli", accVersion: "0.1.8", artifacts: [] }] });

  assert.deepEqual(result.operations, []);
  assert.match(result.skipped[0].reason, /--downgrade/);
});
