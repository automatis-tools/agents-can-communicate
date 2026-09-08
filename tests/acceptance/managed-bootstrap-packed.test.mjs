import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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
const argsFor = (f, data) => ["--adapter", "claude_code", "--real-executable",
  path.join(f.clientBin, "claude"), "--data-home", data];
const minimalEnv = { PATH: process.env.PATH, ACC_NO_UPDATE_CHECK: "1" };

// Moving parsing behind manager resolution turns usage into fail-open exit 1.
test("packed bootstrap validates incomplete arguments before resolving a manager without HOME", async t => {
  const f = await createPackedAcc(t);
  const result = await run(path.join(f.installed, "bin", "acc-bootstrap.mjs"), ["--adapter"], minimalEnv, f.project);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(await readdir(f.dataHome), []);
});

// Ignoring explicit --data-home skips or misplaces admission even when bootstrap exits 1.
for (const inherited of ["missing", "different"]) {
  test(`packed source bootstrap leases its explicit data home when inherited home is ${inherited}`, async t => {
    const f = await createPackedAcc(t);
    await f.setClientVersions({ claude: "0.0.0" });
    await f.acc(["install", "--adapter", "claude_code"]);
    const other = path.join(f.root, "other-data"); await mkdir(other);
    const env = { ...minimalEnv, ...(inherited === "different" ? { ACC_DATA_HOME: other } : {}) };
    const result = await run(path.join(f.installed, "bin", "acc-bootstrap.mjs"), argsFor(f, f.dataHome), env, f.project);
    assert.equal(result.code, 1, "uncertified fixture remains unsupported");
    assert.equal((await leases(f.dataHome)).some(lease => lease.pid === result.pid && lease.kind === "acc-bootstrap"), true);
    assert.deepEqual(await readdir(other), []);
    const cache = JSON.parse(await readFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json"), "utf8"));
    assert.equal(cache.supported, false);
  });
}

// The selected manager's phase must fence imports and cache writes, despite another env default.
test("packed source bootstrap honors the explicit manager activation fence", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "0.0.0" });
  await f.acc(["install", "--adapter", "claude_code"]);
  const controlFile = path.join(managerOf(f.dataHome), "control.json");
  const control = JSON.parse(await readFile(controlFile, "utf8"));
  await writeFile(controlFile, JSON.stringify({ ...control, phase: "activating", pending: control.active }));
  const other = path.join(f.root, "other-data"); await mkdir(other);
  const result = await run(path.join(f.installed, "bin", "acc-bootstrap.mjs"), argsFor(f, f.dataHome),
    { ...minimalEnv, ACC_DATA_HOME: other }, f.project);
  assert.equal(result.code, 1);
  assert.equal((await leases(f.dataHome)).some(lease => lease.pid === result.pid), false);
  await assert.rejects(readFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(other), []);
});

// Stable launchers cannot lease one manager while bootstrap writes another home's cache.
for (const alias of [false, true]) {
 test(`packed stable bootstrap rejects a different argument data home before admission (runtime alias: ${alias})`, async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "0.0.0" });
  await f.acc(["install", "--adapter", "claude_code"]);
  const other = path.join(f.root, "other-data"); await mkdir(other);
  if (alias) {
    await mkdir(path.join(other, "acc"));
    await symlink(managerOf(f.dataHome), managerOf(other), process.platform === "win32" ? "junction" : "dir");
  }
  const otherBefore = await treeSnapshot(other);
  const before = await treeSnapshot(f.dataHome);
  const result = await run(path.join(managerOf(f.dataHome), "bin", "acc-bootstrap.mjs"), argsFor(f, other), minimalEnv, f.project);
  assert.equal(result.code, 1);
  assert.equal((await leases(f.dataHome)).some(lease => lease.pid === result.pid), false);
  assert.deepEqual(await treeSnapshot(f.dataHome), before);
  assert.deepEqual(await treeSnapshot(other), otherBefore);
});
}

// An accepted install must produce a bootstrap whose runtime and cache homes agree.
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
test("packed whole-data-home alias installs and bootstraps with the same lease and cache home", async t => {
  const f = await createPackedAcc(t);
  await f.setClientVersions({ claude: "0.0.0" });
  const alias = path.join(f.root, "data-alias");
  await symlink(f.dataHome, alias, process.platform === "win32" ? "junction" : "dir");
  const installed = await f.acc(["install", "--adapter", "claude_code"], { ACC_DATA_HOME: alias });
  assert.equal(installed.failed.length, 0);
  const result = await run(path.join(managerOf(alias), "bin", "acc-bootstrap.mjs"), argsFor(f, alias), minimalEnv, f.project);
  assert.equal(result.code, 1, "uncertified fixture remains unsupported");
  assert.equal((await leases(f.dataHome)).some(lease => lease.pid === result.pid && lease.kind === "acc-bootstrap"), true);
  const cache = JSON.parse(await readFile(path.join(f.dataHome, "acc", "native-bootstrap", "claude_code.json"), "utf8"));
  assert.equal(cache.supported, false);
});
