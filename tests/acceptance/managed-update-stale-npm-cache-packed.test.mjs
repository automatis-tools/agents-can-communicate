import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { runNpm } from "../helpers/npm-run.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";

// #221: discovery asks the registry directly, and npm answered the download from
// a package document it had cached two minutes before the registry listed 0.8.2.
test("packed update installs a discovered release while npm still caches a document that does not list it", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "2.1.283" });
  await f.acc(["install", "--adapter", "claude_code"]);
  await f.acc(["update", "--auto", "off"]);
  const registry = await createUpdateRegistry(t, f, null, { packumentMaxAge: 300 });
  const env = { ...f.env, ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "update-cache") };
  registry.setListed(false);
  const { stdout } = await runNpm(["view", "agents-can-communicate", "versions", "--json"], { env });
  assert.equal(JSON.parse(stdout).includes(registry.version), false, "npm cached a document without the release");
  registry.setListed(true);
  const asked = registry.requests.filter(url => url === "/agents-can-communicate").length;
  const updated = await f.acc(["update"], env);
  assert.equal(updated.activated, true);
  assert.equal((await f.acc(["version"])).version, registry.version);
  assert.ok(registry.requests.filter(url => url === "/agents-can-communicate").length > asked,
    "the download asked the registry for the package document again");
});
