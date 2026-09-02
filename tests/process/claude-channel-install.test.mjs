import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile }
  from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..", "..");
const acc = path.join(repo, "bin", "acc.mjs");

async function machine(t) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claude-home-")));
  const dataHome = await realpath(await mkdtemp(path.join(tmpdir(), "acc-claude-data-")));
  const project = path.join(home, "project");
  const bin = path.join(home, "bin");
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await mkdir(project);
  await mkdir(bin);
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({
    theme: "dark",
    mcpServers: { theirs: { command: "their-server" } },
  }, null, 2));
  const claude = path.join(bin, "claude");
  await writeFile(claude, "#!/bin/sh\necho '2.1.252 (Claude Code)'\n");
  await chmod(claude, 0o755);
  t.after(() => Promise.all([home, dataHome]
    .map(directory => rm(directory, { recursive: true, force: true }))));

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home, ACC_DATA_HOME: dataHome, ACC_NO_UPDATE_CHECK: "1",
    ACC_PROBE_TIMEOUT_MS: "30000", GIT_DIR: "", GIT_WORK_TREE: "" };
  const command = (...args) => run(process.execPath, [acc, ...args, "--cwd", project], { env });
  const pluginTrees = async () => {
    const source = path.join(home, ".claude", "plugins", "marketplaces", "acc-local",
      "agents-can-communicate");
    const versions = await readdir(path.join(home, ".claude", "plugins", "cache",
      "acc-local", "agents-can-communicate"));
    assert.equal(versions.length, 1);
    return [source, path.join(home, ".claude", "plugins", "cache", "acc-local",
      "agents-can-communicate", versions[0])];
  };
  return { command, home, pluginTrees };
}

for (const policy of ["actionable", "all"]) {
  test(`Claude ${policy} delivery stays off and installs no channel`, async t => {
    const place = await machine(t);
    const preview = JSON.parse((await place.command("install", "--adapter", "claude_code",
      "--delivery", policy, "--home", place.home, "--dry-run", "--json")).stdout).data;
    const [operation] = preview.plan.operations;

    assert.equal(operation.livePolicy, policy);
    assert.equal(operation.effectiveLivePolicy, "off");
    assert.match(operation.deliveryDiagnostic, /2\.1\.252/);
    assert.match(operation.deliveryDiagnostic, /development-channel security warning/);
    assert.match(operation.deliveryDiagnostic, /next-turn.*acc inbox/);

    const installed = await place.command("install", "--adapter", "claude_code",
      "--delivery", policy, "--home", place.home);
    assert.match(installed.stdout, /development-channel security warning/,
      "the human install report hid the native-delivery downgrade");
    for (const tree of await place.pluginTrees()) {
      await assert.rejects(readFile(path.join(tree, ".mcp.json")), { code: "ENOENT" });
      assert.equal((await readFile(path.join(tree, "hooks", "hooks.json"), "utf8"))
        .includes("UserPromptSubmit"), true);
    }
    const settings = JSON.parse(await readFile(path.join(place.home, ".claude",
      "settings.json"), "utf8"));
    assert.deepEqual(settings.mcpServers,
      { theirs: { command: "their-server" } }, "install replaced unrelated MCP config");
  });
}

test("doctor names the failed native capture and the durable fallback", async t => {
  const place = await machine(t);
  await place.command("install", "--adapter", "claude_code", "--home", place.home);

  const human = (await place.command("doctor", "--home", place.home)).stdout;
  assert.match(human, /2\.1\.252/);
  assert.match(human, /development-channel security warning/);
  assert.match(human, /next-turn.*acc inbox/);

  const body = JSON.parse((await place.command("doctor", "--home", place.home,
    "--json")).stdout).data;
  const claude = body.adapters.find(adapter => adapter.adapterId === "claude_code");
  assert.equal(claude.capabilities.delivery.livePush, false);
  assert.equal(claude.capabilities.delivery.replyRoute, false);
  assert.match(claude.deliveryDiagnostic, /development-channel security warning/);
  assert.match(claude.diagnostics.join(" "), /next-turn.*acc inbox/);
});

test("delivery off removes only legacy ACC channel opt-ins", async t => {
  const place = await machine(t);
  await place.command("install", "--adapter", "claude_code", "--delivery", "all",
    "--home", place.home);
  const globalMcp = path.join(place.home, ".claude", ".mcp.json");
  const foreign = '{"mcpServers":{"theirs":{"command":"their-server"}}}\n';
  await writeFile(globalMcp, foreign);
  const trees = await place.pluginTrees();
  for (const tree of trees) {
    await writeFile(path.join(tree, ".mcp.json"),
      '{"mcpServers":{"acc-channel":{"command":"legacy-acc-channel"}}}\n');
  }

  await place.command("install", "--adapter", "claude_code", "--delivery", "off",
    "--home", place.home);

  assert.equal(await readFile(globalMcp, "utf8"), foreign,
    "reinstall changed a user-owned MCP file");
  for (const tree of trees) {
    await assert.rejects(readFile(path.join(tree, ".mcp.json")), { code: "ENOENT" });
    assert.equal((await readFile(path.join(tree, "hooks", "hooks.json"), "utf8"))
      .includes("UserPromptSubmit"), true, "reinstall removed the next-turn hook");
  }
});
