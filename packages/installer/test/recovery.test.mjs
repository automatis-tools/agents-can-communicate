import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGeminiCliAdapter } from "@agents-can-communicate/adapter-gemini-cli";
import { createKimiAdapter } from "@agents-can-communicate/adapter-kimi";

import { applyPlan } from "../src/apply.mjs";
import { loadOwnership, verifyOwned } from "../src/ownership.mjs";
import { planInstallation } from "../src/plan.mjs";

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-recover-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-recover-data-")));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }),
    rm(dataHome, { recursive: true, force: true })]));
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  await writeFile(path.join(home, ".gemini", "settings.json"), '{"theme":"dark"}\n');
  await writeFile(path.join(home, "config.toml"), 'default_model = "k3"\n');
  return { home, dataHome, context: { home, dataHome } };
}

const adapters = () => [createGeminiCliAdapter(), createKimiAdapter()];

const detected = list => list.map(adapter => ({ adapterId: adapter.id,
  displayName: adapter.displayName, present: true, version: "1.0.0",
  installed: false, diagnostics: [], capabilities: adapter.capabilities, error: null }));

// An adapter that installs correctly and then dies, standing in for the process
// being killed between two adapters' writes.
const crashing = (adapter, when) => ({ ...adapter,
  install: async context => {
    const outcome = await adapter.install(context);
    if (when() === "after-write") throw new Error("killed after writing");
    return outcome;
  } });

test("a crash between two adapters leaves the first installed and the second untouched",
  async t => {
    const { context, dataHome, home } = await machine(t);
    const list = adapters();
    let phase = "ok";
    const failing = [list[0], crashing(list[1], () => phase)];
    phase = "after-write";

    const result = await applyPlan({ plan: planInstallation({ adapters: failing,
      detected: detected(list), context }), adapters: failing, context, dataHome });

    // The run does not end at the failure: someone installing several clients
    // wants the ones that worked, plus the name of the one that did not.
    assert.deepEqual(result.failed.map(entry => entry.adapterId), ["kimi"]);
    assert.deepEqual(result.operations.map(entry => entry.adapterId), ["gemini_cli"]);

    const record = await loadOwnership({ dataHome });
    // Recorded after the write, so the record never claims an install that did
    // not finish - and the kimi files that did land are not claimed by anything.
    assert.deepEqual(record.installs.map(install => install.adapterId), ["gemini_cli"]);
    assert.match(await readFile(path.join(home, "config.toml"), "utf8"), /default_model/);
  });

test("re-running after a crash completes the job without duplicating the finished part",
  async t => {
    const { context, dataHome, home } = await machine(t);
    const list = adapters();
    let phase = "after-write";
    const failing = [list[0], crashing(list[1], () => phase)];
    const plan = () => planInstallation({ adapters: list, detected: detected(list),
      context });

    await applyPlan({ plan: plan(), adapters: failing, context, dataHome });
    const afterCrash = await readFile(path.join(home, ".gemini", "settings.json"), "utf8");

    phase = "ok";
    const second = await applyPlan({ plan: plan(), adapters: list, context, dataHome });

    assert.deepEqual(second.failed, []);
    assert.deepEqual((await loadOwnership({ dataHome })).installs
      .map(install => install.adapterId).sort(), ["gemini_cli", "kimi"]);
    // Every adapter's install is idempotent, so the one that had already
    // succeeded is written again to the same result rather than twice over.
    assert.equal(await readFile(path.join(home, ".gemini", "settings.json"), "utf8"),
      afterCrash);
    const config = await readFile(path.join(home, "config.toml"), "utf8");
    assert.equal(config.split("# >>> agents-can-communicate").length - 1, 1);
  });

test("a half-written install is visible rather than assumed complete", async t => {
  const { context, dataHome, home } = await machine(t);
  const list = adapters();
  await applyPlan({ plan: planInstallation({ adapters: list, detected: detected(list),
    context }), adapters: list, context, dataHome });

  // Something outside ACC changed a file ACC wrote - a partial restore, a
  // half-finished edit, a sync conflict.
  const extension = path.join(home, ".gemini", "extensions", "agents-can-communicate");
  await writeFile(path.join(extension, "gemini-extension.json"), "{}\n");

  const verified = await verifyOwned({ dataHome, adapterId: "gemini_cli" });

  assert.deepEqual(verified.modified, [extension]);
});

test("uninstall after a crash removes only what is still ACC's", async t => {
  const { context, dataHome, home } = await machine(t);
  const list = adapters();
  await applyPlan({ plan: planInstallation({ adapters: list, detected: detected(list),
    context }), adapters: list, context, dataHome });

  const plugin = path.join(home, "plugins", "managed", "agents-can-communicate");
  await writeFile(path.join(plugin, "skills", "acc", "SKILL.md"), "my own notes\n");

  const result = await applyPlan({ plan: planInstallation({ adapters: list,
    detected: detected(list), context, action: "uninstall" }),
    adapters: list, context, dataHome });

  const kimi = result.operations.find(entry => entry.adapterId === "kimi");
  assert.deepEqual(kimi.kept, [plugin]);
  // Someone put work inside a directory ACC created. It is theirs now, and a
  // recognised path is not a reason to delete it.
  assert.equal(await readFile(path.join(plugin, "skills", "acc", "SKILL.md"), "utf8"),
    "my own notes\n");
});

/**
 * The machine changing under a recorded install.
 *
 * A client can be uninstalled after ACC has written into it, and its
 * configuration directory outlives it. Planning an uninstall from detection
 * alone meant ACC skipped exactly the client it had written to, reported
 * success, and said the same thing on every run afterwards - so the tree it
 * created and the entries it added to the user's own settings could never be
 * removed by the tool that put them there.
 */
const absent = adapter => [{ adapterId: adapter.id, displayName: adapter.displayName,
  present: false, version: null, versionOutput: null, installed: false,
  diagnostics: [], capabilities: adapter.capabilities, error: null }];

test("an install can still be removed after the client leaves the machine", async t => {
  const place = await machine(t);
  const [gemini] = adapters();
  const extension = path.join(place.home, ".gemini", "extensions",
    "agents-can-communicate", "gemini-extension.json");
  const settings = path.join(place.home, ".gemini", "settings.json");

  const install = planInstallation({ adapters: [gemini], detected: detected([gemini]),
    context: place.context, action: "install" });
  await applyPlan({ plan: install, adapters: [gemini], context: place.context,
    dataHome: place.dataHome });
  assert.equal((await readFile(settings, "utf8")).includes("agents-can-communicate"), true,
    "the install wrote nothing to unpick, so the test proves nothing");

  // The client is removed from the machine. Everything ACC wrote stays where it is.
  const recorded = (await loadOwnership({ dataHome: place.dataHome })).installs;
  const plan = planInstallation({ adapters: [gemini], detected: absent(gemini),
    context: place.context, action: "uninstall", recorded });

  assert.deepEqual(plan.skipped, [], "the one client ACC wrote to was skipped");
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].clientPresent, false, "the plan does not say the client is gone");

  await applyPlan({ plan, adapters: [gemini], context: place.context,
    dataHome: place.dataHome });

  await assert.rejects(readFile(extension), "ACC's own tree outlived the uninstall");
  assert.equal((await readFile(settings, "utf8")).includes("agents-can-communicate"), false,
    "ACC's entries were left in a file the user owns");
  assert.deepEqual((await loadOwnership({ dataHome: place.dataHome })).installs, [],
    "the record still claims an install that nothing can act on");
});

test("removing for a client that is gone keeps what the user wrote", async t => {
  const place = await machine(t);
  const [gemini] = adapters();
  const settings = path.join(place.home, ".gemini", "settings.json");

  const install = planInstallation({ adapters: [gemini], detected: detected([gemini]),
    context: place.context, action: "install" });
  await applyPlan({ plan: install, adapters: [gemini], context: place.context,
    dataHome: place.dataHome });

  const recorded = (await loadOwnership({ dataHome: place.dataHome })).installs;
  await applyPlan({
    plan: planInstallation({ adapters: [gemini], detected: absent(gemini),
      context: place.context, action: "uninstall", recorded }),
    adapters: [gemini], context: place.context, dataHome: place.dataHome });

  // The file was the user's before ACC edited it, so it is still theirs after.
  assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { theme: "dark" });
});

test("a client that is not here is still never installed into", async t => {
  const place = await machine(t);
  const [gemini] = adapters();

  // The record is what makes an uninstall visit an absent client. An install
  // must not read it the same way and write to a machine that has no client.
  const plan = planInstallation({ adapters: [gemini], detected: absent(gemini),
    context: place.context, action: "install",
    recorded: [{ adapterId: gemini.id, version: "1.0.0", artifacts: [] }] });

  assert.deepEqual(plan.operations, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /not installed on this machine/);
});

test("an absent client ACC never wrote to is still skipped, and said so", async t => {
  const place = await machine(t);
  const [gemini] = adapters();

  const plan = planInstallation({ adapters: [gemini], detected: absent(gemini),
    context: place.context, action: "uninstall", recorded: [] });

  assert.deepEqual(plan.operations, []);
  assert.match(plan.skipped[0].reason, /not installed on this machine/);
});

test("what is removed is what was written, not what would be written today", async t => {
  const place = await machine(t);
  const old = path.join(place.home, ".gemini", "where-it-went");
  // An adapter whose layout has moved since the install. Planning the removal
  // from the adapter would name today's path and leave the install where it
  // actually is - the record is the only account of that.
  const moved = { ...createGeminiCliAdapter(),
    planInstall: () => [{ path: path.join(place.home, ".gemini", "where-it-goes-now"),
      kind: "tree" }] };

  const plan = planInstallation({ adapters: [moved], detected: absent(moved),
    context: place.context, action: "uninstall",
    recorded: [{ adapterId: moved.id, version: "0.55.1",
      artifacts: [{ path: old, kind: "tree" }] }] });

  assert.deepEqual(plan.operations[0].artifacts.map(artifact => artifact.path), [old]);
});
