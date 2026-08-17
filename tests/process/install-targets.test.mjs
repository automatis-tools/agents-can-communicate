import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ALL_ADAPTERS, clientContext } from "@agents-can-communicate/cli";
import { detectInstallation } from "@agents-can-communicate/installer";

/**
 * Where an install actually lands, and which binary decides it happens.
 *
 * Both halves of this were wrong on every real machine, and every test was
 * green throughout, because the installer suite supplies a fake probe and a
 * temporary home. Nothing compared what an adapter plans against how the client
 * really lays itself out, and nothing ran the binary.
 *
 * The result looked like success: `acc install` listed files it had created,
 * `acc doctor` reported them present, and two clients were skipped as "not
 * installed" while a third was handed a manifest pointing at a directory that
 * did not exist.
 */
const HOME = path.join(path.sep, "home", "dana");

test("no adapter writes at the top of the user's home", () => {
  const context = clientContext(HOME);

  for (const adapter of ALL_ADAPTERS()) {
    for (const artifact of adapter.planInstall(context)) {
      const relative = path.relative(HOME, artifact.path);
      assert.equal(relative.startsWith(".."), false,
        `${adapter.id} plans ${artifact.path}, which is outside the home entirely`);
      // `~/config.toml` and `~/plugins/` were real plans. A client keeps its
      // own directory; anything a level above it sits beside the client rather
      // than inside it, and is never read.
      assert.equal(path.dirname(relative) === ".", false,
        `${adapter.id} writes ${relative} directly into the home`);
      assert.equal(relative.split(path.sep)[0].startsWith("."), true,
        `${adapter.id} writes into ${relative.split(path.sep)[0]}/, `
        + "which is not a client's own directory");
    }
  }
});

test("every adapter declares the binary its client installs", () => {
  for (const adapter of ALL_ADAPTERS()) {
    assert.equal(typeof adapter.client?.command, "string",
      `${adapter.id} declares no client.command`);
    assert.notEqual(adapter.client.command.trim(), "");
  }
});

test("detection probes the declared binary, not the adapter id", async () => {
  // The exact regression: with no declaration the probe fell back to the id, so
  // `claude_code` and `gemini_cli` ran commands that exist nowhere and were
  // reported absent on every machine.
  const asked = [];
  const probe = async command => {
    asked.push(command);
    return "1.2.3";
  };

  const adapters = ALL_ADAPTERS();
  const detected = await detectInstallation({ adapters, context: clientContext(HOME), probe });

  assert.deepEqual(asked.sort(), adapters.map(a => a.client.command).sort());
  assert.deepEqual(detected.filter(entry => !entry.present), [],
    "a client that answered its version probe was still reported absent");
});

test("a client whose binary is absent is reported absent, not assumed present", async () => {
  const probe = async () => { throw new Error("command not found"); };

  const detected = await detectInstallation({ adapters: ALL_ADAPTERS(),
    context: clientContext(HOME), probe });

  assert.deepEqual(detected.map(entry => entry.present), detected.map(() => false));
});
