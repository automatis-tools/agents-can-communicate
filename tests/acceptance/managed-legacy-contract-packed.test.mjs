import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
import { connectMcp } from "../helpers/mcp-client.mjs";

test("packed launchers recover legacy admission and update with two live Channels", { timeout: 90_000 }, async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  await f.setClientVersions({ claude: "2.1.266", codex: "0.135.0" });
  await f.acc(["install", "--adapter", "claude_code", "--delivery", "off"]);
  const manager = path.join(f.dataHome, "acc", "runtime");
  const controlFile = path.join(manager, "control.json");
  const state = () => readFile(controlFile, "utf8").then(JSON.parse);
  const before = await state();
  // A pre-contract updater can publish a newer runtime without this field.
  // Only the private control fixture is seeded; both Channel processes must
  // publish their own leases through the installed immutable launchers.
  delete before.active.storeVersion;
  await writeFile(controlFile, JSON.stringify(before));
  const channels = [];
  t.after(async () => {
    for (const client of channels) {
      if (client.child.exitCode === null) client.child.kill("SIGKILL");
      await client.closed;
    }
  });
  for (let index = 0; index < 2; index++) {
    const client = connectMcp({ cwd: f.project, dataHome: f.dataHome, env: f.env,
      binary: path.join(manager, "bin", "acc-claude-channel.mjs") });
    channels.push(client);
    const reply = await client.request("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(reply.error, undefined, client.stderr());
  }
  const leases = await Promise.all((await readdir(path.join(manager, "leases")))
    .filter(name => name.endsWith(".json"))
    .map(name => readFile(path.join(manager, "leases", name), "utf8").then(JSON.parse)));
  for (const client of channels) {
    const lease = leases.find(item => item.pid === client.child.pid && item.kind === "acc-claude-channel");
    assert.ok(lease, "the real Channel must publish its actual PID");
    assert.equal(lease.runtime.storeVersion, 6, "legacy pointers must not poison newly admitted Channels");
  }
  const result = await f.acc(["update"], { ACC_NO_UPDATE_CHECK: "0",
    npm_config_registry: registry.url, npm_config_cache: path.join(f.root, "update-cache") });
  assert.equal(result.activated, true, JSON.stringify(result));
  const after = await state();
  assert.equal(after.active.version, registry.version);
  assert.equal(after.active.storeVersion, 6);
  assert.equal(after.pending, null);
  assert.equal(JSON.parse(await readFile(path.join(before.active.root, "package.json"))).version,
    f.manifest.version, "the live Channels retain their original generation");
  for (const client of channels) {
    assert.equal(client.child.exitCode, null);
    assert.deepEqual((await client.request("ping", {})).result, {});
    assert.equal(await client.close(), 0, client.stderr());
  }
});
