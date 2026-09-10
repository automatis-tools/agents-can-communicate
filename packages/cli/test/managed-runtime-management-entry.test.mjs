import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { writeControl } from "../src/managed-runtime/state.mjs";

const entry = new URL("../src/managed-runtime/entry.mjs", import.meta.url).href;
async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-management-entry-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  async function runtime(label, version, directory, protocol = 2) {
    await mkdir(path.join(directory, "bin", "entrypoints"), { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "agents-can-communicate",
      version, accManagedUpdateProtocol: protocol }));
    await writeFile(path.join(directory, "bin", "entrypoints", "acc.mjs"),
      `export async function main(options) { process.stdout.write(JSON.stringify({ label: ${JSON.stringify(label)}, options })); }`);
    return { root: directory, version };
  }
  const active = await runtime("active", "0.4.2", path.join(root, "generations", "old"), 1);
  const pending = await runtime("pending", "0.4.4", path.join(root, "generations", "new"));
  const installed = await runtime("installed", "0.4.5", path.join(data, "installed"));
  const control = { schemaVersion: 1, active, pending, phase: "ready", auto: false,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null };
  await writeControl(root, control);
  const run = async (args, packageRoot = installed.root) => {
    const code = `process.argv = [process.execPath, "acc", ...${JSON.stringify(args)}];
      const { runEntry } = await import(${JSON.stringify(entry)});
      await runEntry(${JSON.stringify({ kind: "acc", managerRoot: root, packageRoot })});`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code],
      { env: { ...process.env, HOME: control.home, ACC_DATA_HOME: data, ACC_NO_UPDATE_CHECK: "1" } });
    return JSON.parse(stdout);
  };
  return { root, run, active, pending, installed, control };
}

test("explicit update enters the newer installed management implementation without workspace admission", async t => {
  const f = await fixture(t);
  const result = await f.run(["update"]);
  assert.equal(result.label, "installed");
  assert.equal(result.options.managementOnly, true);
  assert.equal(result.options.managerRoot, f.root);
  assert.equal((await readdir(f.root)).includes("leases"), false);
});

test("a verified protocol-two pending candidate provides update recovery even while activation is fenced", async t => {
  const f = await fixture(t);
  await writeControl(f.root, { ...f.control, phase: "activating" });
  const result = await f.run(["update"], f.active.root);
  assert.equal(result.label, "pending");
  assert.equal(result.options.managementOnly, true);
  assert.equal((await readdir(f.root)).includes("leases"), false);
});

test("candidate management dispatch requires matching package identity and the advertised protocol", async t => {
  for (const manifest of [
    { name: "foreign", version: "0.4.4", accManagedUpdateProtocol: 2 },
    { name: "agents-can-communicate", version: "9.0.0", accManagedUpdateProtocol: 2 },
    { name: "agents-can-communicate", version: "0.4.4", accManagedUpdateProtocol: 1 },
  ]) {
    const f = await fixture(t);
    await writeFile(path.join(f.pending.root, "package.json"), JSON.stringify(manifest));
    const result = await f.run(["update"], f.active.root);
    assert.equal(result.label, "active");
    assert.notEqual(result.options.managementOnly, true);
  }
});

test("update and help appearing as argument values never bypass active workspace admission", async t => {
  const f = await fixture(t);
  for (const args of [["status"], ["message", "--body", "update"], ["message", "--body", "--help"]]) {
    const result = await f.run(args);
    assert.equal(result.label, "active");
    assert.notEqual(result.options.managementOnly, true);
  }
  assert.equal((await readdir(path.join(f.root, "leases"))).some(name => name.endsWith(".json")), true);
});
