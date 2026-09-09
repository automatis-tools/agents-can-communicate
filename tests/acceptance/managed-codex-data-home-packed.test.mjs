import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { platformDataHome } from "../../packages/cli/src/index.mjs";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
const run = promisify(execFile);
const workspaces = home => readdir(path.join(home, "acc", "workspaces"))
  .catch(error => { if (error.code === "ENOENT") return []; throw error; });

test("managed refresh keeps generated Codex hooks and skills in the enrolled data home", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  await f.setClientVersions({ codex: "0.147.0" });
  await f.acc(["install", "--adapter", "codex", "--delivery", "off"]);
  await f.acc(["update", "--auto", "off"]);
  await f.acc(["status"]);
  const before = await workspaces(f.dataHome);
  assert.equal(before.length, 1);
  const ownershipFile = path.join(f.dataHome, "acc", "installs.json");
  const policy = async () => JSON.parse(await readFile(ownershipFile, "utf8"))
    .installs.find(record => record.adapterId === "codex").deliveryPolicy;
  const consent = await policy();
  assert.equal(consent, "off");
  const result = await f.acc(["update"], { ACC_NO_UPDATE_CHECK: "0",
    npm_config_registry: registry.url, npm_config_cache: path.join(f.root, "update-cache") });
  assert.equal(result.activated, true, JSON.stringify(result));
  assert.equal(await policy(), consent);
  const plugin = path.join(f.clientHome, ".agents", "acc-local", "plugins", "agents-can-communicate");
  const shim = path.join(plugin, "acc-hook.sh");
  const skill = await readFile(path.join(plugin, "skills", "acc", "SKILL.md"), "utf8");
  const statusCommand = skill.match(/`([^`\n]+ status --json)`/)[1];
  for (const inherited of [undefined, path.join(f.root, "wrong-data")]) {
    // Shell and Node use absolute paths; keep unrelated host Git out of this
    // non-Git data-home fixture and its finite hook budget.
    const env = { ...f.env };
    delete env.ACC_DATA_HOME;
    delete env.XDG_DATA_HOME;
    if (inherited !== undefined) env.ACC_DATA_HOME = inherited;
    const wrongHome = inherited ?? platformDataHome({ platform: process.platform, env });
    const nativeId = `refresh-home-${inherited === undefined ? "absent" : "wrong"}`;
    const startedAt = Date.now();
    const pending = run("/bin/sh", [shim, "session-start"], { cwd: f.project, env });
    pending.child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: nativeId,
      cwd: f.project, source: "startup" }));
    const output = await pending;
    const binding = await f.findBinding(nativeId);
    assert.ok(binding, "regenerated hook must persist its binding in the enrolled data home: "
      + JSON.stringify({ nativeId, elapsedMs: Date.now() - startedAt, ...output }));
    const status = JSON.parse((await run("/bin/sh", ["-c", statusCommand], { cwd: f.project, env })).stdout);
    assert.ok(status.data.participants.some(peer => peer.sessionId === binding.accSessionId),
      "regenerated skill must read the same hook workspace");
    assert.deepEqual(await workspaces(f.dataHome), before, "refresh must preserve the existing workspace");
    assert.deepEqual(await workspaces(wrongHome), [], "generated commands must not create an ambient workspace");
  }
});
