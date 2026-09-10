import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { activatePending } from "../src/managed-runtime/activation.mjs";
import { acquireRuntime } from "../src/managed-runtime/leases.mjs";
import { readControl, writeControl } from "../src/managed-runtime/state.mjs";

async function fixture(t) {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "acc-update-blockers-")));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = path.join(data, "acc", "runtime");
  const active = { version: "0.4.2", root: path.join(root, "generations", "old") };
  const pending = { version: "0.4.3", root: path.join(root, "generations", "new") };
  await mkdir(active.root, { recursive: true });
  await mkdir(pending.root, { recursive: true });
  await writeControl(root, { schemaVersion: 1, active, pending, phase: "ready", auto: true,
    pin: null, checkedAt: null, home: path.join(data, "home"), targets: [], notice: null });
  const bindings = path.join(data, "acc", "workspaces", "fixture", "bindings");
  await mkdir(bindings, { recursive: true });
  const bind = (name, fields = {}) => writeFile(path.join(bindings, `${name}.json`), JSON.stringify({
    schemaVersion: 1, harnessSessionId: name, accSessionId: `session_${name}`,
    generation: `generation_${name}`, ...fields }));
  return { root, bindings, bind, data, active };
}

// Counting each binding/lease as a process made one long-lived daemon look
// like several clients; the result must name the actual process once.
test("update reports one process for multiple native bindings and an ACC lease with the same PID", async t => {
  const f = await fixture(t);
  await f.bind("first", { clientPid: process.pid });
  await f.bind("second", { clientPid: process.pid });
  await acquireRuntime(f.root, { kind: "cli" });
  await acquireRuntime(f.root, { kind: "cli" });
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  const result = await activatePending(f.root, { prepare: async () => async () => {
    assert.fail("a live process still prevents activation");
  } });
  assert.equal(result.activated, false);
  assert.equal(result.holds, 1);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].pid, process.pid);
  assert.deepEqual(result.blockers[0].kinds, ["acc-mcp", "cli", "native"]);
  assert.equal(result.blockers[0].nativeBindings, 2);
  assert.match(result.notice, new RegExp(`\\b${process.pid}\\b`));
});

// Missing PIDs are not all the same process. They stay separate conservative
// holds, and diagnostic output must not disclose generation credentials.
test("unidentified bindings remain separate blockers without exposing owner credentials", async t => {
  const f = await fixture(t);
  await f.bind("unknown_one");
  await f.bind("unknown_two");
  const result = await activatePending(f.root, { pidIsAlive: () => false,
    prepare: async () => async () => assert.fail("unknown ownership is still a hold") });
  assert.equal(result.holds, 2);
  assert.ok(Array.isArray(result.blockers), "pending updates expose their concrete blockers");
  assert.equal(result.blockers.length, 2);
  assert.ok(result.blockers.every(b => b.pid === null && b.reason === "unknown_client_pid"));
  assert.doesNotMatch(JSON.stringify(result), /generation_unknown|session_unknown/);
  assert.equal(JSON.parse(await readFile(path.join(f.root, "control.json"), "utf8")).active.version, "0.4.2");
});

test("ignoring the updating process excludes its leases but preserves its native bindings", async t => {
  const f = await fixture(t);
  await acquireRuntime(f.root, { kind: "acc" });
  await acquireRuntime(f.root, { kind: "acc" });
  await f.bind("native", { clientPid: process.pid });
  const result = await activatePending(f.root, { ignorePid: process.pid,
    prepare: async () => async () => assert.fail("native lifetime is not the updater's lease") });
  assert.equal(result.holds, 1);
  assert.deepEqual(result.blockers?.map(({ pid, kinds, nativeBindings }) => ({ pid, kinds, nativeBindings })),
    [{ pid: process.pid, kinds: ["native"], nativeBindings: 1 }]);
});

// The real command must replace a stored count with current observations and
// exclude its own diagnostic lease; removing the fresh read makes this fail.
test("doctor reports current blockers in JSON and human output instead of a stale notice", async t => {
  const f = await fixture(t);
  await f.bind("first", { clientPid: process.pid });
  await f.bind("second", { clientPid: process.pid });
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  await acquireRuntime(f.root, { kind: "acc-mcp" });
  await writeControl(f.root, { ...await readControl(f.root), notice: "old opaque notice: 99 processes" });
  const home = path.join(f.data, "home"), project = path.join(f.data, "project");
  await mkdir(home); await mkdir(project);
  const entrypoints = path.join(f.active.root, "bin", "entrypoints");
  await mkdir(entrypoints, { recursive: true });
  await writeFile(path.join(entrypoints, "acc.mjs"),
    `export { main } from ${JSON.stringify(new URL("../../../bin/entrypoints/acc.mjs", import.meta.url).href)};\n`);
  const run = async (...args) => (await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL("../../../bin/acc.mjs", import.meta.url)), "doctor", "--cwd", project, ...args],
    { cwd: home, env: { ...process.env, HOME: home, ACC_DATA_HOME: f.data, PATH: path.join(f.data, "empty-bin"),
      ACC_NO_UPDATE_CHECK: "1", GIT_DIR: "", GIT_WORK_TREE: "" } })).stdout;
  const report = JSON.parse(await run("--json"));
  assert.equal(report.ok, true);
  assert.equal(report.data.update.holds, 1);
  assert.deepEqual(report.data.update.blockers.map(({ pid, kinds, nativeBindings }) => ({ pid, kinds, nativeBindings })),
    [{ pid: process.pid, kinds: ["acc-mcp", "native"], nativeBindings: 2 }]);
  const human = await run();
  assert.match(human, new RegExp(`PID ${process.pid}\\b`));
  assert.match(human, /acc-mcp.*native.*2 native bindings/);
  assert.doesNotMatch(human, /old opaque notice|99 processes/);
  assert.doesNotMatch(JSON.stringify(report), /generation_first|session_first/);
  await rm(path.join(f.bindings, "second.json"));
  assert.equal(JSON.parse(await run("--json")).data.update.blockers[0].nativeBindings, 1);
});
