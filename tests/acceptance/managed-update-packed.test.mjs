import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
import { connectMcp } from "../helpers/mcp-client.mjs";
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

test("installed manual update verifies an archive, waits for live MCP, then switches with reusable continuity", async t => {
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

  const connect = () => {
    const client = connectMcp({ cwd: f.project, dataHome: f.dataHome,
      binary: f.mcpBin, env: { ...f.env, ACC_MCP_PARTICIPANT: "update_peer",
        ACC_MCP_WORKSPACE: f.project }, participant: "update_peer" });
    t.after(() => { if (client.child.exitCode === null) client.child.kill("SIGKILL"); });
    return client;
  };
  const initialize = async client => {
    const response = await client.request("initialize", { protocolVersion: "2025-11-25",
      capabilities: {}, clientInfo: { name: "update-test", version: "1" } });
    assert.equal(response.error, undefined);
    client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  const status = async client => {
    const response = await client.request("tools/call", { name: "acc_status", arguments: {} });
    assert.equal(response.error, undefined);
    assert.notEqual(response.result.isError, true, response.result.content[0].text);
    return response.result.structuredContent;
  };
  const mcp = connect();
  await until(async () => {
    const leases = await readdir(path.join(managerOf(f), "leases"));
    const records = await Promise.all(leases.filter(n => n.endsWith(".json"))
      .map(async n => {
        try {
          return JSON.parse(await readFile(path.join(managerOf(f), "leases", n), "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      }));
    return records.some(lease => lease?.pid === mcp.child.pid && lease.kind === "acc-mcp");
  }, "idle MCP registered before receiving any request");
  const { withManagerLock } = await import(pathToFileURL(path.join(before.active.root,
    "node_modules", "@agents-can-communicate", "cli", "src", "managed-runtime", "mutex.mjs")));
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  t.after(() => released.resolve());
  const holder = withManagerLock(path.join(managerOf(f), "worker"), async () => {
    entered.resolve();
    await released.promise;
  });
  await entered.promise;
  let sawContention = false;
  let pending;
  await until(async () => {
    pending = await f.acc(["update"], env);
    if (pending.inProgress === true) {
      sawContention = true;
      released.resolve();
      await holder;
      return false;
    }
    return true;
  }, "manual update retries after the actual worker releases its lock");
  assert.equal(sawContention, true, "the installed command must report the held worker");
  assert.equal(pending.reason, "processes_active");
  assert.deepEqual((await readState(f)).active, before.active);
  assert.equal((await readState(f)).pending.version, registry.version);
  assert.equal(registry.requests.some(url => url.includes(".tgz")), true);
  await initialize(mcp);
  const firstStatus = await status(mcp);
  const owner = firstStatus.participants.find(peer => peer.participantId === "update_peer");
  assert.ok(owner);
  const workspaceId = (await readdir(path.join(f.dataHome, "acc", "workspaces")))[0];
  const key = `mcp:update_peer:${workspaceId}`;
  const continuity = await f.findBinding(key);
  assert.equal(continuity.accSessionId, owner.sessionId);
  const live = await f.acc(["update", "--apply"], env);
  assert.equal(live.reason, "processes_active", "MCP still holds after creating continuity");
  assert.deepEqual((await readState(f)).active, before.active);
  assert.equal(await mcp.close(), 0, mcp.stderr());
  // Activation needs no further network when the verified candidate is present.
  const applied = await f.acc(["update"], { ...env, ACC_NO_UPDATE_CHECK: "1" });
  assert.equal(applied.activated, true);
  assert.equal(applied.version, registry.version);
  const after = await readState(f);
  assert.equal(after.phase, "ready"); assert.equal(after.pending, null);
  assert.equal(after.active.version, registry.version);
  assert.notEqual(after.active.root, before.active.root);
  assert.equal(JSON.parse(await readFile(path.join(before.active.root, "package.json"), "utf8")).version, f.manifest.version);
  assert.deepEqual(await f.findBinding(key), continuity, "activation retains MCP continuity");
  const restarted = connect();
  await initialize(restarted);
  const resumed = (await status(restarted)).participants.find(peer => peer.participantId === "update_peer");
  assert.equal(resumed.sessionId, owner.sessionId);
  assert.deepEqual(await f.findBinding(key), continuity, "restart reuses the same owner generation");
  assert.equal(await restarted.close(), 0, restarted.stderr());
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
