import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOwnership, recordInstall } from "@agents-can-communicate/installer";

import { CLAUDE_PLUGIN, pluginVersion } from "../../../tests/helpers/plugin-version.mjs";

import { outgoingStatus, prepareLivePermissions }
  from "../../adapter-codex/src/live-permissions.mjs";
import { prepareRefresh } from "../src/managed-runtime/refresh.mjs";
import { writeFakeClient } from "../../../tests/helpers/fake-client.mjs";

test("automatic integration refresh retains recorded delivery provenance", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-refresh-decision-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataHome = path.join(base, "data");
  const home = path.join(base, "home");
  const root = path.join(dataHome, "acc", "runtime");
  const decision = { source: "interactive-accepted", completeSetup: true };
  await recordInstall({ dataHome, adapterId: "kimi", version: "0.36.1", artifacts: [],
    deliveryPolicy: "actionable", deliveryDecision: decision });
  const control = {
    home,
    targets: ["kimi"],
    active: { version: "0.5.3", root: process.cwd() },
    pending: { version: "0.5.4", root: process.cwd() },
  };

  const refresh = await prepareRefresh({ control, root, callerProtocol: 2,
    env: { HOME: home, ACC_DATA_HOME: dataHome, PATH: "/usr/bin:/bin" } });
  const result = await refresh();

  assert.deepEqual(result.failed, []);
  const install = (await loadOwnership({ dataHome })).installs
    .find(entry => entry.adapterId === "kimi");
  assert.equal(install.accVersion, "0.5.4");
  assert.equal(install.deliveryPolicy, "actionable");
  assert.deepEqual(install.deliveryDecision, decision);
});

/**
 * The cache an automatic update leaves behind.
 *
 * Every managed install and every background refresh used to ask the adapters to
 * keep every version they found, so nine releases left nine copies of the plugin
 * in each versioned client cache. A refresh now names the version it is moving
 * off - the one any session open across the update still runs from - and the
 * adapters remove what is older than that.
 */
test("a background refresh leaves the version it wrote and the one it moved off", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-refresh-cache-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataHome = path.join(base, "data");
  const home = path.join(base, "home");
  const root = path.join(dataHome, "acc", "runtime");
  const cache = path.join(home, ".claude", "plugins", "cache", "acc-local",
    "agents-can-communicate");
  for (const old of ["0.0.1", "0.0.2"]) await mkdir(path.join(cache, old), { recursive: true });
  await recordInstall({ dataHome, adapterId: "claude_code", version: "2.1.0", artifacts: [],
    deliveryPolicy: "actionable" });
  const control = {
    home,
    targets: ["claude_code"],
    active: { version: "0.0.2", root: process.cwd() },
    pending: { version: await pluginVersion(CLAUDE_PLUGIN), root: process.cwd() },
  };

  const refresh = await prepareRefresh({ control, root, callerProtocol: 2,
    env: { HOME: home, ACC_DATA_HOME: dataHome, PATH: "/usr/bin:/bin" } });
  await refresh();

  assert.deepEqual((await readdir(cache)).sort(),
    ["0.0.2", await pluginVersion(CLAUDE_PLUGIN)].sort());
});

// Issue #213, the upgrade path. An update refreshes every installed integration
// with its recorded policy, and that is how an existing user's Codex profile -
// written before the Claude Code inbox was one of its receivers - comes to allow
// it. The ownership check has to read the old unit as ACC's, or the refresh
// would leave it alone as "customized".
test("a background refresh brings an older ACC's Codex grants up to date", async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "acc-refresh-grants-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataHome = path.join(base, "data");
  const home = path.join(base, "home");
  const bin = path.join(base, "bin");
  const codexHome = path.join(home, ".codex");
  const config = path.join(codexHome, "config.toml");
  await mkdir(bin, { recursive: true });
  await writeFakeClient(bin, "codex", { output: "codex-cli 0.157.1" });
  const permissions = { home, codexHome, stateRoot: path.join(dataHome, "acc"), file: config,
    requestedLivePolicy: "actionable", clientVersion: "0.157.1" };
  const older = prepareLivePermissions('model = "mine"\n', { ...permissions, receiverSockets: [] });
  assert.equal(older.status.state, "configured", "the older profile was complete for its receivers");
  await mkdir(codexHome, { recursive: true });
  await writeFile(config, older.source);
  await recordInstall({ dataHome, adapterId: "codex", version: "0.157.1", artifacts: [],
    deliveryPolicy: "actionable",
    deliveryDecision: { source: "interactive-accepted", completeSetup: true } });
  const control = { home, targets: ["codex"],
    active: { version: "0.8.1", root: process.cwd() }, pending: { version: "0.8.2", root: process.cwd() } };

  const refresh = await prepareRefresh({ control, root: path.join(dataHome, "acc", "runtime"),
    callerProtocol: 2, env: { HOME: home, ACC_DATA_HOME: dataHome, PATH: `${bin}:/usr/bin:/bin` } });
  const result = await refresh();

  assert.deepEqual(result.failed, []);
  const refreshed = await readFile(config, "utf8");
  const inbox = path.join(realpathSync.native("/tmp"), "cc-socks");
  assert.ok(refreshed.includes(`${JSON.stringify(inbox)} = "allow"`), refreshed);
  assert.match(refreshed, /^model = "mine"$/m);
  assert.equal(outgoingStatus(refreshed, { ...permissions, receiverSockets: ["/tmp/cc-socks"] }).state,
    "configured");
});
