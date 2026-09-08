import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
const run = promisify(execFile);

async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`timed out: ${label}`);
}
const managerOf = f => path.join(f.dataHome, "acc", "runtime");
const readState = f => readFile(path.join(managerOf(f), "control.json"), "utf8").then(JSON.parse);

async function stopBackground(f) {
  const file = path.join(managerOf(f), "worker", "manager.lock", "owner.json");
  const owner = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
  if (owner?.pid) { try { process.kill(owner.pid, "SIGTERM"); } catch { /* Already finished. */ } }
}

test("installed manual update verifies an archive, waits for idle MCP, then refreshes and switches", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  const env = { ...f.env, ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "update-cache") };
  await f.setClientVersions({ claude: "2.1.259", codex: "0.135.0" });
  await f.acc(["install", "--adapter", "claude_code", "--adapter", "codex"]);
  await f.acc(["update", "--auto", "off"], env);
  await f.acc(["update", "--pin", registry.version], env);
  const before = await readState(f);
  assert.equal(before.auto, false);
  const diagnosed = await f.acc(["doctor"]);
  assert.equal(diagnosed.update.auto, false);
  assert.equal(diagnosed.update.pin, registry.version);
  const checked = await f.acc(["update", "--check"], env);
  assert.equal(checked.newer, true);
  assert.deepEqual(await readState(f), before);
  assert.equal(registry.requests.some(url => url.includes(".tgz")), false);
  registry.setAvailable(false);
  const failed = await f.accError(["update"], env);
  assert.equal(failed.code, 4);
  assert.deepEqual((await readState(f)).active, before.active);
  assert.equal((await readState(f)).pending, null);
  registry.setAvailable(true);
  registry.setDiscoveryIntegrity(`sha512-${Buffer.alloc(64).toString("base64")}`);
  const changed = await f.accError(["update"], env);
  assert.equal(changed.code, 4);
  assert.match(changed.stdout, /integrity differs/);
  assert.deepEqual((await readState(f)).active, before.active);
  assert.equal((await readState(f)).pending, null);
  registry.setDiscoveryIntegrity(null);

  const mcp = spawn(process.execPath, [f.mcpBin], { cwd: f.project, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(mcp, "exit");
  t.after(() => { if (mcp.exitCode === null) mcp.kill("SIGKILL"); });
  await until(async () => {
    const leases = await readdir(path.join(managerOf(f), "leases"));
    const records = await Promise.all(leases.filter(n => n.endsWith(".json"))
      .map(n => readFile(path.join(managerOf(f), "leases", n), "utf8").then(JSON.parse)));
    return records.some(lease => lease.pid === mcp.pid && lease.kind === "acc-mcp");
  }, "idle MCP registered before receiving any request");
  const pending = await f.acc(["update"], env);
  assert.equal(pending.reason, "processes_active");
  assert.deepEqual((await readState(f)).active, before.active);
  assert.equal((await readState(f)).pending.version, registry.version);
  assert.equal(registry.requests.some(url => url.includes(".tgz")), true);
  mcp.kill("SIGTERM"); await exited;
  // Activation needs no further network when the verified candidate is present.
  const applied = await f.acc(["update"], { ...env, ACC_NO_UPDATE_CHECK: "1" });
  assert.equal(applied.activated, true);
  assert.equal(applied.version, registry.version);
  const after = await readState(f);
  assert.equal(after.phase, "ready"); assert.equal(after.pending, null);
  assert.equal(after.active.version, registry.version);
  assert.notEqual(after.active.root, before.active.root);
  assert.equal(JSON.parse(await readFile(path.join(before.active.root, "package.json"), "utf8")).version, f.manifest.version);
  await rm(f.installed, { recursive: true });
  const version = await run(process.execPath, [path.join(managerOf(f), "bin", "acc.mjs"), "version", "--json"],
    { cwd: f.project, env: f.env });
  assert.equal(JSON.parse(version.stdout).data.version, registry.version);
});

test("normal installation enables a detached update that downloads and activates without another command", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  const env = { ...f.env, ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "update-cache") };
  t.after(() => stopBackground(f));
  await f.setClientVersions({ claude: "2.1.259", codex: "0.135.0" });
  await f.acc(["install", "--adapter", "claude_code"], env);
  await until(async () => (await readState(f)).active.version === registry.version,
    "background candidate activation");
  assert.equal((await readState(f)).auto, true);
  assert.equal(registry.requests.some(url => url.endsWith("/latest")), true);
  assert.equal(registry.requests.some(url => url.includes(".tgz")), true);
  await f.acc(["uninstall", "--adapter", "claude_code"]);
  const removed = await readState(f);
  assert.equal(removed.auto, false);
  assert.deepEqual(removed.targets, []);
});
