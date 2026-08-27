import assert from "node:assert/strict";
import test from "node:test";

import { planInstallation } from "../src/plan.mjs";

/**
 * An install that would wire an older ACC than the one already wired.
 *
 * The version doing the installing is whichever `acc` came first on PATH, and
 * the shim it writes pins that copy's node and runner. So a second ACC on the
 * machine - a different Node version's global install, a stale one - silently
 * replaces the wiring of every client with its own, older code.
 *
 * Observed: extending PATH to expose one client resolved `acc` to an 0.1.1
 * sitting under another Node version. It rewired three clients to itself, and
 * the only visible symptom was a guard behaving like the version it came from:
 * a shell write walked through a claim that 0.1.7 had learned to stop.
 *
 * The record needed to catch this already existed. `recordInstall` writes
 * `accVersion` per client, with a comment saying it is there "so a later run can
 * tell that the bundle sitting in a client is older than the code now running".
 * Nothing read it in the other direction.
 */
const adapter = (id, overrides = {}) => ({
  id,
  displayName: id,
  client: { command: id, versionArgs: ["--version"] },
  capabilities: {},
  planInstall: () => [{ path: `/tmp/${id}`, kind: "file" }],
  ...overrides,
});

const detectedEntry = (id, overrides = {}) => ({
  adapterId: id, displayName: id, present: true, version: "1.0.0",
  versionOutput: "1.0.0", installed: false, diagnostics: [], capabilities: {},
  error: null, ...overrides,
});

const plan = ({ accVersion, recorded }) => planInstallation({
  adapters: [adapter("claude_code")],
  detected: [detectedEntry("claude_code")],
  context: { home: "/home/x", stateRoot: "/state" },
  action: "install",
  recorded,
  accVersion,
});

test("installing an older ACC over a newer one is refused, not done quietly", () => {
  const result = plan({ accVersion: "0.1.1",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.8", artifacts: [] }] });

  assert.deepEqual(result.operations, []);
  const [skipped] = result.skipped;
  assert.equal(skipped?.adapterId, "claude_code");
  // The message has to name both versions: the whole failure was that nobody
  // could see which ACC was doing the writing.
  assert.match(skipped.reason, /0\.1\.8/);
  assert.match(skipped.reason, /0\.1\.1/);
});

test("the same version reinstalls, because that is how a repair is done", () => {
  const result = plan({ accVersion: "0.1.8",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.8", artifacts: [] }] });

  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("a newer ACC installs over an older one without ceremony", () => {
  const result = plan({ accVersion: "0.1.9",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.8", artifacts: [] }] });

  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("versions are compared as numbers, not as strings", () => {
  // "0.1.10" < "0.1.9" alphabetically, which is exactly the release where a
  // string comparison would start refusing every legitimate install.
  const older = plan({ accVersion: "0.1.9",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.10", artifacts: [] }] });
  assert.equal(older.operations.length, 0, "0.1.9 over 0.1.10 is a downgrade");

  const newer = plan({ accVersion: "0.1.10",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.9", artifacts: [] }] });
  assert.equal(newer.operations.length, 1, "0.1.10 over 0.1.9 is an upgrade");
});

test("a first install has nothing to compare against and proceeds", () => {
  assert.equal(plan({ accVersion: "0.1.8", recorded: [] }).operations.length, 1);
  assert.equal(plan({ accVersion: "0.1.8",
    recorded: [{ adapterId: "claude_code", accVersion: null, artifacts: [] }] })
    .operations.length, 1);
});

test("a version this cannot read is not treated as a downgrade", () => {
  // Refusing on an unparseable record would make a corrupt file unrecoverable
  // by the command that exists to repair the machine.
  for (const recordedVersion of ["", "next", "0.1.x", undefined]) {
    const result = plan({ accVersion: "0.1.8",
      recorded: [{ adapterId: "claude_code", accVersion: recordedVersion, artifacts: [] }] });
    assert.equal(result.operations.length, 1, `refused on ${JSON.stringify(recordedVersion)}`);
  }
});

test("a deliberate downgrade is possible, and has to be asked for", () => {
  const result = planInstallation({
    adapters: [adapter("claude_code")],
    detected: [detectedEntry("claude_code")],
    context: { home: "/home/x", stateRoot: "/state" },
    action: "install",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.8", artifacts: [] }],
    accVersion: "0.1.1",
    allowDowngrade: true,
  });

  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("an uninstall is never refused for being older", () => {
  // The older ACC is often the only thing that knows what it wrote. Refusing
  // its uninstall would strand exactly the wiring this check exists to undo.
  const result = planInstallation({
    adapters: [adapter("claude_code")],
    detected: [detectedEntry("claude_code")],
    context: { home: "/home/x", stateRoot: "/state" },
    action: "uninstall",
    recorded: [{ adapterId: "claude_code", accVersion: "0.1.8",
      artifacts: [{ path: "/tmp/claude_code", kind: "file" }] }],
    accVersion: "0.1.1",
  });

  assert.equal(result.operations.length, 1);
});
