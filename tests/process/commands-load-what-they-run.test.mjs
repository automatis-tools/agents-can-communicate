import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ADAPTER_IDS } from "../../packages/cli/src/adapter-catalog.mjs";
import { ADAPTER_PACKAGES, adapterPackage, loadedModules, repo } from "../helpers/loaded-modules.mjs";

// Every command used to load all six client adapters, the store and the
// installer: 234 modules for `acc version`, which does no work, and 199 for
// each indicator read a client runs every few seconds (#270). A command now
// loads the adapters of the clients it serves, and nothing it does not run.
const acc = path.join(repo, "bin", "acc.mjs");

for (const command of ["version", "help"]) {
  test(`acc ${command} loads no client adapter and no store`, async t => {
    const { from } = await loadedModules(t, [acc, command]);
    for (const pkg of [...ADAPTER_PACKAGES, "storage-filesystem", "core", "delivery-router",
      "hook-runner"]) {
      assert.deepEqual(from(pkg), [], `acc ${command} loaded ${pkg}`);
    }
  });
}

test("acc status in a workspace no client has joined loads no client adapter", async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "acc-status-loads-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { from } = await loadedModules(t, [acc, "status"], { cwd });
  assert.notDeepEqual(from("storage-filesystem"), [], "status never opened the store");
  for (const pkg of ADAPTER_PACKAGES) assert.deepEqual(from(pkg), [], `acc status loaded ${pkg}`);
});

test("an indicator read loads its own client's adapter and no other", async t => {
  assert.deepEqual(ADAPTER_PACKAGES, ADAPTER_IDS.map(adapterPackage),
    "every adapter in the catalog is checked here");
  for (const adapterId of ADAPTER_IDS) {
    const { from } = await loadedModules(t, [path.join(repo, "bin", "acc-indicator.mjs"),
      "--adapter", adapterId, "--json"]);
    assert.notDeepEqual(from(adapterPackage(adapterId)), [],
      `the ${adapterId} indicator never loaded its own adapter`);
    for (const other of ADAPTER_PACKAGES.filter(pkg => pkg !== adapterPackage(adapterId))) {
      assert.deepEqual(from(other), [], `the ${adapterId} indicator loaded ${other}`);
    }
  }
});
