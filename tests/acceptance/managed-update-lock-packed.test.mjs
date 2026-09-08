import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
const run = promisify(execFile);

test("installed manual update proceeds after slow uncontended worker lock preparation", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  await f.setClientVersions({ codex: "0.147.0" });
  await f.acc(["install", "--adapter", "codex", "--delivery", "off"]);
  await f.acc(["update", "--auto", "off"]);
  const manager = path.join(f.dataHome, "acc", "runtime");
  const probe = path.join(f.root, "sync-probe");
  const { stdout } = await run(process.execPath, ["--import",
    path.resolve(import.meta.dirname, "../helpers/delay-worker-lock-sync.mjs"),
    f.accBin, "update", "--json"], { cwd: f.project,
    env: { ...f.env, ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url, npm_config_cache: path.join(f.root, "update-cache"),
      ACC_TEST_HANDLE_FILE: probe } });
  assert.match(await readFile(probe, "utf8"), /worker candidate sync delayed/);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data.inProgress, undefined, JSON.stringify(result));
  assert.equal(result.data.activated, true, JSON.stringify(result));
  const state = JSON.parse(await readFile(path.join(manager, "control.json"), "utf8"));
  assert.equal(state.auto, false);
  assert.equal(state.active.version, registry.version);
  assert.ok(registry.requests.some(url => url.includes(".tgz")));
  assert.equal((await readdir(path.join(manager, "worker"))).includes("manager.lock"), false);
});
