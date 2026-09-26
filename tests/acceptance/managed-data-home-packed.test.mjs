import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPackedAcc, treeSnapshot } from "../helpers/packed-acc.mjs";
const exec = promisify(execFile);
const managerOf = data => path.join(data, "acc", "runtime");
async function run(bin, args, env, cwd) {
  const pending = exec(process.execPath, [bin, ...args], { env, cwd });
  const result = await pending.then(value => ({ ...value, code: 0 }), error => error);
  return { ...result, pid: pending.child.pid };
}
async function leases(data) {
  const directory = path.join(managerOf(data), "leases");
  const files = await readdir(directory).catch(error => {
    if (error.code === "ENOENT") return []; throw error;
  });
  return Promise.all(files.filter(file => file.endsWith(".json"))
    .map(file => readFile(path.join(directory, file), "utf8").then(JSON.parse)));
}
const minimalEnv = { PATH: process.env.PATH, ACC_NO_UPDATE_CHECK: "1" };

// An accepted install must produce launchers whose runtime and lease homes agree.
test("packed install rejects an external runtime-only relocation before writes", async t => {
  const f = await createPackedAcc(t);
  const target = path.join(f.root, "external-runtime"); await mkdir(target);
  await mkdir(path.join(f.dataHome, "acc"));
  await symlink(target, managerOf(f.dataHome), process.platform === "win32" ? "junction" : "dir");
  const before = await treeSnapshot(f.dataHome);
  const clients = await f.snapshotClientFiles();
  const error = await f.accError(["install", "--adapter", "claude_code"]);
  assert.equal(error?.code, 4);
  assert.match(error.stdout, /ACC_DATA_HOME/);
  assert.match(error.stdout, /entire data home/i);
  assert.deepEqual(await readdir(target), []);
  assert.deepEqual(await treeSnapshot(f.dataHome), before);
  assert.deepEqual(await f.snapshotClientFiles(), clients);
});

// Canonicalizing the whole data home must preserve the supported alias case.
test("packed whole-data-home alias installs and leases the same runtime home", async t => {
  const f = await createPackedAcc(t);
  const alias = path.join(f.root, "data-alias");
  await symlink(f.dataHome, alias, process.platform === "win32" ? "junction" : "dir");
  const installed = await f.acc(["install", "--adapter", "claude_code"], { ACC_DATA_HOME: alias });
  assert.equal(installed.failed.length, 0);
  const result = await run(path.join(managerOf(alias), "bin", "acc.mjs"), ["version"],
    { ...minimalEnv, ACC_DATA_HOME: alias }, f.project);
  assert.equal(result.code, 0);
  assert.equal((await leases(f.dataHome)).some(lease => lease.pid === result.pid && lease.kind === "acc"), true);
});
