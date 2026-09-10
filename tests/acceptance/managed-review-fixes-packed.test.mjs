import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc, treeSnapshot } from "../helpers/packed-acc.mjs";
import { createUpdateRegistry } from "../helpers/update-registry.mjs";
const run = promisify(execFile);
const managerOf = f => path.join(f.dataHome, "acc", "runtime");
const stateOf = f => readFile(path.join(managerOf(f), "control.json"), "utf8").then(JSON.parse);

// Removing npm's explicit local install overrides must break this actual update.
test("packed update overrides hostile inherited npm install defaults", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  await f.acc(["install", "--adapter", "claude_code"]);
  const sentinel = path.join(f.root, "global-prefix");
  await mkdir(sentinel);
  await writeFile(path.join(sentinel, "sentinel"), "untouched");
  const npmrc = path.join(f.root, "hostile.npmrc");
  await writeFile(npmrc, `global=true\nprefix=${sentinel}\npackage-lock=false\npackage-lock-only=true\ndry-run=true\nworkspaces=true\nsave=false\n`);
  const source = await treeSnapshot(f.installed);
  const result = await f.acc(["update"], { ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "cache"), npm_config_userconfig: npmrc,
    npm_config_global: "true", npm_config_prefix: sentinel, npm_config_package_lock: "false",
    npm_config_package_lock_only: "true", npm_config_dry_run: "true", npm_config_workspaces: "true", npm_config_save: "false" });
  assert.equal(result.activated, true);
  assert.equal((await stateOf(f)).active.version, registry.version);
  assert.deepEqual(await readdir(sentinel), ["sentinel"]);
  assert.equal(await readFile(path.join(sentinel, "sentinel"), "utf8"), "untouched");
  assert.deepEqual(await treeSnapshot(f.installed), source);
});

// Removing install's pre-write canonical guard must permit forbidden state here.
test("packed install rejects repository data homes through canonical ancestors before writes", async t => {
  const f = await createPackedAcc(t);
  const other = path.join(f.root, "other-project");
  await mkdir(other); await writeFile(path.join(other, ".git"), "gitdir: absent-but-git-is-optional\n");
  await mkdir(path.join(f.project, ".git"));
  const alias = path.join(f.root, "project-alias");
  await mkdir(path.join(other, "nested"));
  await symlink(path.join(other, "nested"), alias, process.platform === "win32" ? "junction" : "dir");
  const before = await f.snapshotClientFiles();
  for (const project of [f.project, other, alias]) {
    const data = path.join(project, ".acc-data");
    const error = await f.accError(["install", "--adapter", "claude_code"], { ACC_DATA_HOME: data });
    assert.equal(error?.code, 4, `must reject ${data}`);
    assert.match(error.stdout, /outside.*(repository|workspace)/);
    await assert.rejects(readFile(path.join(data, "acc", "runtime", "control.json")), { code: "ENOENT" });
    assert.equal((await readdir(project)).includes(".acc-data"), false);
  }
  assert.deepEqual(await f.snapshotClientFiles(), before);
  await rm(path.join(f.project, ".git"), { recursive: true });
  await writeFile(path.join(f.project, "acc.workspace.json"), "malformed");
  assert.equal((await f.acc(["install", "--adapter", "claude_code"])).failed.length, 0);
});

// Checking only one canonical destination misses either runtime or ledger writes.
for (const direction of ["runtime into repository", "data home inside repository"]) {
  test(`packed install rejects runtime-only symlinks: ${direction}`, async t => {
    const f = await createPackedAcc(t);
    await mkdir(path.join(f.project, ".git"));
    const dataHome = direction === "runtime into repository" ? f.dataHome : path.join(f.project, "data");
    const target = path.join(direction === "runtime into repository" ? f.project : f.root, "runtime-target");
    await mkdir(target);
    await mkdir(path.join(dataHome, "acc"), { recursive: true });
    await symlink(target, path.join(dataHome, "acc", "runtime"),
      process.platform === "win32" ? "junction" : "dir");
    const dataBefore = await treeSnapshot(dataHome);
    const homeBefore = await f.snapshotClientFiles();
    const error = await f.accError(["install", "--adapter", "claude_code"], { ACC_DATA_HOME: dataHome });
    assert.equal(error?.code, 4, `must reject ${direction}`);
    assert.match(error.stdout, /outside.*(repository|workspace)/);
    assert.deepEqual(await readdir(target), [], "runtime target must remain empty");
    assert.deepEqual(await treeSnapshot(dataHome), dataBefore, "no install ledger or runtime writes");
    assert.deepEqual(await f.snapshotClientFiles(), homeBefore);
  });
}

// Removing Channel admission fallback must cause EOF instead of MCP replies.
test("packed fenced Channel answers MCP without workspace discovery or a runtime lease", async t => {
  const f = await createPackedAcc(t);
  await f.acc(["install", "--adapter", "claude_code"]);
  const state = await stateOf(f);
  await writeFile(path.join(managerOf(f), "control.json"), JSON.stringify({ ...state,
    phase: "activating", pending: state.active }));
  await writeFile(path.join(f.project, "acc.workspace.json"), "malformed");
  const workspaceFiles = async () => (await readdir(f.dataHome, { recursive: true }))
    .filter(file => !file.startsWith(path.join("acc", "runtime")));
  const before = await workspaceFiles();
  const channel = spawn(process.execPath, [path.join(managerOf(f), "bin", "acc-claude-channel.mjs")],
    { cwd: f.project, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(channel, "exit");
  t.after(() => { if (channel.exitCode === null) channel.kill("SIGKILL"); });
  let buffer = "";
  const replies = [];
  channel.stdout.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      replies.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1);
    }
  });
  const request = async (id, method, params) => {
    channel.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const deadline = Date.now() + 5_000;
    while (!replies.some(reply => reply.id === id) && channel.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const reply = replies.find(value => value.id === id);
    assert.ok(reply, `Channel did not answer ${method}; exit=${channel.exitCode}`);
    return reply;
  };
  const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  assert.equal(initialized.result.capabilities["claude/channel"], undefined);
  assert.deepEqual((await request(2, "tools/list")).result.tools, []);
  assert.deepEqual((await request(3, "ping")).result, {});
  assert.equal(channel.exitCode, null);
  const leases = await readdir(path.join(managerOf(f), "leases")).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  for (const file of leases.filter(name => name.endsWith(".json"))) {
    assert.notEqual(JSON.parse(await readFile(path.join(managerOf(f), "leases", file), "utf8")).pid, channel.pid);
  }
  assert.deepEqual(await workspaceFiles(), before);
  channel.stdin.end(); assert.equal((await exited)[0], 0);
  await f.hook("claude_code", {});
});

// Replacing refresh details with the generic retry notice must fail these diagnostics.
test("packed manual update explains a failed integration and repairs forward after correction", async t => {
  const f = await createPackedAcc(t);
  const registry = await createUpdateRegistry(t, f);
  await f.acc(["install", "--adapter", "claude_code"]);
  const before = await stateOf(f);
  const settings = path.join(f.clientHome, ".claude", "settings.json");
  const original = await readFile(settings);
  await writeFile(settings, "SECRET");
  const env = { ACC_NO_UPDATE_CHECK: "0", npm_config_registry: registry.url,
    npm_config_cache: path.join(f.root, "cache") };
  // Human output must carry the details, independently of the JSON result envelope.
  const error = await run(process.execPath, [f.accBin, "update"], { cwd: f.project,
    env: { ...f.env, ...env } }).then(() => null, value => value);
  assert.equal(error?.code, 4);
  const output = error.stdout + error.stderr;
  assert.match(output, /claude_code/);
  assert.match(output, /JSON|parse|invalid/i);
  assert.ok(output.includes(settings), output);
  assert.equal(output.includes("SECRET"), false);
  const partial = await stateOf(f);
  assert.equal(partial.phase, "activating");
  assert.deepEqual(partial.active, before.active);
  const diagnosis = await f.acc(["doctor"]);
  assert.equal(diagnosis.scope, "update");
  assert.equal(diagnosis.workspaceInspection, "unavailable_during_update");
  assert.equal(diagnosis.update.phase, "activating");
  assert.match(diagnosis.update.notice, /incomplete.*acc update/);
  assert.equal((await f.accError(["doctor", "--repair"])).code, 4);
  await writeFile(settings, original);
  const fixed = await f.acc(["update"], { ACC_NO_UPDATE_CHECK: "1" });
  assert.equal(fixed.activated, true);
  assert.equal((await stateOf(f)).active.version, registry.version);
});
