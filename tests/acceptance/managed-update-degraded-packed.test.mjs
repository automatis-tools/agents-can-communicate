import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createPackedAcc } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";

const run = promisify(execFile);
const captured = process.platform === "darwin" && process.arch === "arm64";
const ownership = f => readFile(path.join(f.dataHome, "acc", "installs.json"), "utf8").then(JSON.parse);
const updateEnv = (f, registry) => ({ ...f.env, ACC_NO_UPDATE_CHECK: "0",
  npm_config_registry: registry.url, npm_config_cache: path.join(f.root, "update-cache") });

// The refresh's native eligibility gate stranded a real opted-in Codex installation
// without a service, and policies recorded for inbox-only adapters stranded it too.
test("packed update retains delivery consent while native services and capabilities are unavailable", async t => {
  const f = await createPackedAcc(t);
  f.env.CODEX_HOME = path.join(f.clientHome, ".codex");
  f.env.SHELL = "/bin/zsh";
  await f.setClientVersions({ codex: "0.154.0", gemini: "0.59.0", grok: "1.0.25" });
  const installed = await f.acc(["install", "--adapter", "codex", "--adapter", "gemini_cli",
    "--adapter", "grok", "--delivery", "actionable"]);
  assert.deepEqual(installed.failed, []);
  await f.acc(["update", "--auto", "off"]);
  const registry = await createUpdateRegistry(t, f);
  const updated = await f.acc(["update"], updateEnv(f, registry));
  assert.equal(updated.activated, true);
  assert.equal((await f.acc(["version"])).version, registry.version);
  const doctor = await f.acc(["doctor"]);
  assert.equal(doctor.update.auto, false, "an update must keep the user's explicit opt-out");
  for (const id of ["codex", "gemini_cli", "grok"]) {
    const adapter = doctor.adapters.find(item => item.adapterId === id);
    assert.equal(adapter.bundleVersion, registry.version);
    assert.equal(adapter.nativeDelivery.policy, "actionable");
    assert.notEqual(adapter.nativeDelivery.runtime, "active");
    assert.deepEqual(adapter.nativeDelivery.modes, []);
  }
  if (captured) assert.equal(doctor.adapters.find(a => a.adapterId === "codex").outgoingDelivery.state, "configured");
  for (const record of (await ownership(f)).installs) assert.equal(record.deliveryPolicy, "actionable");
});

async function writeClaude(f, channelAvailable) {
  await writeFile(path.join(f.clientBin, "claude"), `#!${process.execPath}\n`
    + (channelAvailable ? "// notifications/claude/channel\n" : "// protocol temporarily unavailable\n")
    + 'console.log(process.argv.includes("--version") ? "2.1.267 (Claude Code)" : JSON.stringify(process.argv.slice(2)));\n',
  { mode: 0o700 });
}

// Removing only the updater's gate would silently tear down the existing shim
// and channel MCP entry. The installed shim must fail open, then recover by itself.
test("packed update preserves Claude activation through a failed probe and recovers on ordinary launch",
  { skip: !captured }, async t => {
    const f = await createPackedAcc(t);
    f.env.SHELL = "/bin/zsh";
    await writeClaude(f, true);
    assert.deepEqual((await f.acc(["install", "--adapter", "claude_code", "--delivery", "actionable"])).failed, []);
    await f.acc(["update", "--auto", "off"]);
    const shim = path.join(f.dataHome, "acc", "bin", "claude");
    const rc = await readFile(path.join(f.clientHome, ".zshrc"), "utf8");
    const shimBytes = await readFile(shim, "utf8");
    const previous = (await ownership(f)).installs.find(a => a.adapterId === "claude_code").nativeActivation;
    assert.ok(previous);
    const registry = await createUpdateRegistry(t, f);
    await writeClaude(f, false);
    const updated = await f.acc(["update"], updateEnv(f, registry));
    assert.equal(updated.activated, true);
    assert.equal(await readFile(shim, "utf8"), shimBytes);
    assert.equal(await readFile(path.join(f.clientHome, ".zshrc"), "utf8"), rc);
    const record = (await ownership(f)).installs.find(a => a.adapterId === "claude_code");
    assert.deepEqual(record.nativeActivation, previous);
    assert.equal(record.deliveryPolicy, "actionable");
    const mcp = JSON.parse(await readFile(path.join(f.clientHome, ".claude", "plugins",
      "marketplaces", "acc-local", "agents-can-communicate", ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers["acc-channel"]);
    const diagnostic = (await f.acc(["doctor"])).adapters.find(a => a.adapterId === "claude_code");
    assert.equal(diagnostic.bundleVersion, registry.version);
    assert.equal(diagnostic.nativeDelivery.policy, "actionable");
    assert.notEqual(diagnostic.nativeDelivery.eligibility, "eligible");
    assert.notEqual(diagnostic.nativeDelivery.runtime, "active");
    assert.deepEqual(diagnostic.owned.modified, []);
    const launch = () => run(shim, ["resume", "fixture-thread"], { cwd: f.project, env: f.env });
    assert.deepEqual(JSON.parse((await launch()).stdout), ["resume", "fixture-thread"]);
    await writeClaude(f, true);
    assert.deepEqual(JSON.parse((await launch()).stdout), ["--dangerously-load-development-channels",
      "plugin:agents-can-communicate@acc-local", "resume", "fixture-thread"]);
    await f.acc(["install", "--adapter", "claude_code", "--delivery", "off"]);
    await assert.rejects(readFile(shim), { code: "ENOENT" });
    assert.equal((await ownership(f)).installs[0].deliveryPolicy, "off");
  });
