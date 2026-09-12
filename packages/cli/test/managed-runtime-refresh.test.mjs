import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOwnership, recordInstall } from "@agents-can-communicate/installer";

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
