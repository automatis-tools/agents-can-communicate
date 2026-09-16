import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOwnership, recordInstall } from "@agents-can-communicate/installer";

import { CLAUDE_PLUGIN, pluginVersion } from "../../../tests/helpers/plugin-version.mjs";

import { prepareRefresh } from "../src/managed-runtime/refresh.mjs";

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
