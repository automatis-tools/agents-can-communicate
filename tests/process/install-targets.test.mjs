import { fakeAgy } from "../../packages/adapter-antigravity/test/fake-agy.mjs";
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

// The project `acc install` was run in. One client registers its hooks per
// workspace rather than per home, so an artifact can legitimately sit outside
// the home - but only this directory, and only because the operator chose it.
const PROJECT = path.join(HOME, "work", "project");

test("no adapter writes at the top of the user's home", () => {
  const context = clientContext(HOME, undefined, { cwd: PROJECT });

  for (const adapter of ALL_ADAPTERS()) {
    for (const artifact of adapter.planInstall(context)) {
      // A hook registered per workspace lives in the operator's own project,
      // which is theirs to lay out and is not a client's configuration
      // directory. The rules below are about the home; the next test is about
      // the project, and between them every artifact is accounted for.
      if (!path.relative(PROJECT, artifact.path).startsWith("..")) continue;
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

test("an artifact outside the home is the project, and nothing else", () => {
  // Antigravity CLI can register hooks in `<project>/.agents/hooks.json`, which
  // is outside the home whenever the project is. That is the only reason an
  // artifact may leave the home, and it has to be the directory the command ran
  // in rather than anywhere else on the disk.
  const elsewhere = path.join(path.sep, "srv", "checkout");
  const context = clientContext(HOME, undefined, { cwd: elsewhere });

  for (const adapter of ALL_ADAPTERS()) {
    for (const artifact of adapter.planInstall(context)) {
      if (!path.relative(HOME, artifact.path).startsWith("..")) continue;
      const inProject = path.relative(elsewhere, artifact.path);
      assert.equal(inProject.startsWith(".."), false,
        `${adapter.id} plans ${artifact.path}, which is neither in the home nor in `
        + "the project this command was run in");
      assert.equal(inProject.split(path.sep)[0].startsWith("."), true,
        `${adapter.id} plans ${inProject} in the project, which is not a dotted `
        + "directory a client owns");
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
  // Every client answers here, so every adapter's detect runs - and Antigravity's
  // asks agy what it has loaded. A stand-in keeps the real binary out of it.
  const detected = await detectInstallation({ adapters,
    context: { ...clientContext(HOME), runAgy: fakeAgy().run }, probe });

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
