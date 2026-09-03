import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import * as codexModule from "@agents-can-communicate/adapter-codex";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

const NATIVE_PACKAGE_SURFACE =
  /app-server-client|acc-codex-app-server|offerCodexMessage|connectExistingAppServer|codex[-_]?(?:live|app[-_]?server)|(?:live|app[-_]?server)[-_]?codex/i;

const publicManifestSurface = manifest => JSON.stringify({
  bin: manifest.bin,
  exports: manifest.exports,
  dependencies: manifest.dependencies,
  bundleDependencies: manifest.bundleDependencies,
  scripts: manifest.scripts,
  files: (manifest.files ?? []).filter(file => !file.startsWith("fixtures/")),
});

async function machine(t, version = "codex-cli 0.152.0") {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-codex-data-")));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await mkdir(project);
  await mkdir(bin);
  await writeFile(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  const codex = path.join(bin, "codex");
  await writeFile(codex, `#!/bin/sh\necho ${JSON.stringify(version)}\n`);
  await chmod(codex, 0o755);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", GIT_DIR: "", GIT_WORK_TREE: "" };
  const command = (...args) => run(process.execPath, [acc, ...args, "--cwd", project], { env });
  const pluginTrees = async () => {
    const source = path.join(home, ".agents", "acc-local", "plugins",
      "agents-can-communicate");
    const versions = await readdir(path.join(home, ".codex", "plugins", "cache",
      "acc-local", "agents-can-communicate"));
    assert.equal(versions.length, 1);
    return [source, path.join(home, ".codex", "plugins", "cache", "acc-local",
      "agents-can-communicate", versions[0])];
  };
  return { command, home, pluginTrees };
}

// Codex ships no native-delivery surface. The 0.152.1 queue capture observed a
// working transport, and the release capture then measured that the mode it
// requires - codex --remote unix:// - runs the session inside the daemon, where
// both the hook payload's cwd and the App Server's own thread record name the
// daemon's directory instead of the session's. ACC placed such a session in an
// unrelated workspace and fed it that workspace's peers. Nothing ACC can reach
// carries the real one, so the capability is withdrawn rather than defaulted.
test("the Codex native queue surface is absent, and no hook smuggles it back", async () => {
  const adapter = codexModule.createCodexAdapter();
  assert.equal(adapter.capabilities.delivery.livePush, false);
  assert.equal(adapter.capabilities.delivery.replyRoute, false);
  assert.equal(adapter.nativeDelivery, undefined);
  for (const method of ["probeNativeDelivery", "planNativeActivation", "bindNativeSession",
    "offerMessage", "routeReply"]) {
    assert.equal(Object.hasOwn(adapter, method), false, method);
  }
  // Codex keeps next-turn delivery and the durable inbox: neither depends on
  // knowing which directory the session is in.
  assert.equal(adapter.capabilities.delivery.nextTurn, true);
  // And no shipped hook may reintroduce the wiring by the back door.
  const hooks = JSON.parse(await readFile(path.join(repo, "packages", "adapter-codex",
    "plugin", "hooks.json"), "utf8"));
  const commands = Object.values(hooks.hooks)
    .flatMap(entries => entries.flatMap(entry => entry.hooks.map(hook => hook.command)));
  assert.doesNotMatch(commands.join("\n"),
    /app-server|proxy|daemon|livePush|opaqueEndpointRef/i,
    "shipped Codex hooks contain native-delivery wiring");
});

for (const policy of ["actionable", "all"]) {
  test(`Codex ${policy} delivery stays off and installs no native bridge`, async t => {
    const place = await machine(t);
    const preview = JSON.parse((await place.command("install", "--adapter", "codex",
      "--delivery", policy, "--home", place.home, "--dry-run", "--json")).stdout).data;
    const [operation] = preview.plan.operations;

    assert.equal(operation.livePolicy, policy);
    assert.equal(operation.effectiveLivePolicy, "off");
    assert.match(operation.deliveryDiagnostic, /0\.152\.0/);
    assert.match(operation.deliveryDiagnostic, /control socket.*absent/i);
    assert.match(operation.deliveryDiagnostic, /did not start.*daemon/i);
    assert.match(operation.deliveryDiagnostic, /next-turn.*acc inbox/);

    const installed = await place.command("install", "--adapter", "codex",
      "--delivery", policy, "--home", place.home);
    assert.match(installed.stdout, /control socket.*absent/i,
      "the human install report hid the native-delivery downgrade");
    await assert.rejects(stat(path.join(place.home, ".codex", "app-server-control")),
      { code: "ENOENT" });
    for (const tree of await place.pluginTrees()) {
      const hooks = await readFile(path.join(tree, "hooks.json"), "utf8");
      assert.match(hooks, /UserPromptSubmit/, "install removed the certified next-turn hook");
      assert.doesNotMatch(hooks,
        /app-server|proxy|livePush|replyRoute|opaqueEndpointRef/i,
        "the fallback-only install published native-delivery wiring");
    }
  });
}

test("doctor names the failed Codex capture and withholds uncertified delivery", async t => {
  const place = await machine(t);
  await place.command("install", "--adapter", "codex", "--home", place.home);

  const human = (await place.command("doctor", "--home", place.home)).stdout;
  assert.match(human, /0\.152\.0/);
  assert.match(human, /control socket.*absent/i);
  assert.match(human, /did not start.*daemon/i);
  assert.match(human, /next-turn.*acc inbox/);

  const body = JSON.parse((await place.command("doctor", "--home", place.home,
    "--json")).stdout).data;
  const codex = body.adapters.find(adapter => adapter.adapterId === "codex");
  assert.equal(codex.capabilities.delivery.nextTurn, false);
  assert.equal(codex.capabilities.delivery.livePush, false);
  assert.equal(codex.capabilities.delivery.replyRoute, false);
  assert.match(codex.deliveryDiagnostic, /control socket.*absent/i);
  assert.match(codex.diagnostics.join(" "), /next-turn.*acc inbox/);
});

test("an unknown Codex version retains only the durable inbox", async t => {
  const place = await machine(t, "codex-cli development build");
  const body = JSON.parse((await place.command("doctor", "--home", place.home,
    "--json")).stdout).data;
  const codex = body.adapters.find(adapter => adapter.adapterId === "codex");

  assert.equal(codex.version, null);
  assert.equal(codex.capabilities.delivery.nextTurn, false);
  assert.equal(codex.capabilities.delivery.livePush, false);
  assert.equal(codex.capabilities.delivery.replyRoute, false);
  assert.match(codex.deliveryDiagnostic, /acc inbox/);
});
